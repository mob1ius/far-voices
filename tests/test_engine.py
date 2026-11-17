#!/usr/bin/env python3
"""
Stage 1 and 2 checks: engine correctness and data accuracy.

    ./.venv/bin/python tests/test_engine.py

Deliberately dependency free. Every assertion below corresponds to a bug that
was real at some point, so a regression here means something that was already
broken once has broken again.
"""
import json, math, random, sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import farvoices as fv                                          # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))


# ---------------------------------------------------------------- parsing
def test_parsing():
    print("\nfeed parsing")
    x = """<dsn>
      <station name="gdscc" friendlyName="Goldstone"/>
      <dish name="DSS14" azimuthAngle="207" elevationAngle="28" windSpeed="">
        <downSignal active="true" signalType="data" dataRate="160" power="-150" band="X" spacecraft="VGR1"/>
        <downSignal active="true" signalType="data" dataRate="160" power="-150" band="X" spacecraft="VGR1"/>
        <downSignal active="true" signalType="data" dataRate="0" power="-160" band="S" spacecraft="PSYC"/>
        <upSignal active="false" dataRate="1000" power="20" band="X" spacecraft="PSYC"/>
        <target name="VGR1" id="31" rtlt="-1"/>
      </dish>
      <dish name="DSS99" azimuthAngle="0" elevationAngle="90" windSpeed="4">
        <target name="DSN" id="99" rtlt="-1"/>
      </dish>
    </dsn>"""
    links = fv.parse_dsn(x)
    check("empty windSpeed does not raise", True)
    check("duplicate rows deduplicated", len(links) == 1, f"got {len(links)}")
    check("zero data rate dropped (guards log 0)", all(l.data_rate > 0 for l in links))
    check("inactive signal dropped", all(l.direction == "down" for l in links))
    check("dish parked on DSN pseudo-target skipped",
          all(l.dish != "DSS99" for l in links))
    check("70 m dish detected", links[0].big_dish)

    # The feed emits sentinel power values for "no reading" -- -270, -410, -480
    # and one -490 across the archive, against a real floor near -170. They are
    # 0.04% of samples, but total_power/choir_power are means: one -480 in a
    # four-link frame moved the mean 90 dBm and flipped the bright/dark harmony
    # verdict on 10 recorded frames.
    sent = fv.parse_dsn("""<dsn><station name="gdscc"/>
      <dish name="DSS25" azimuthAngle="1" windSpeed="2">
        <downSignal active="true" dataRate="1000" power="-480" band="X" spacecraft="EURC"/>
        <downSignal active="true" dataRate="2000" power="-118" band="X" spacecraft="MRO"/>
        <downSignal active="true" dataRate="3000" power="-171" band="X" spacecraft="VGR2"/>
        <target name="EURC"/></dish></dsn>""")
    powers = sorted(l.power for l in sent)
    check("sentinel power reading is clamped, not believed",
          min(powers) >= fv.POWER_FLOOR, f"{powers}")
    check("a genuinely faint but plausible reading is kept",
          -171.0 in powers, f"{powers}")
    check("the link itself survives a bad power reading", len(sent) == 3, f"{len(sent)}")

    # --replay that matches nothing must be fatal. The guard for it sat nested
    # inside `if self.replay:`, so an empty match took the else branch and
    # quietly fetched the LIVE feed instead -- "maybe replay", which defeats
    # the one thing replay is for. It was caught here by two A/B renders that
    # differed only because the real sky moved between them.
    try:
        fv.Feed("data/snapshots/definitely-no-such-file-*.xml")
        check("empty --replay glob is fatal", False, "constructed anyway")
    except SystemExit:
        check("empty --replay glob is fatal", True)
    check("no --replay still means live", fv.Feed(None).replay is None)


# ---------------------------------------------------------------- voicing
def test_voicing():
    print("\nvoicing")
    for q in ("maj", "min", "dim", "open", "min7", "maj7", "min3", "maj3",
              "aug", "dom7", "halfdim"):
        check(f"quality {q!r} voiceable", q in fv.CHORD_TONES)

    # Every quality has to be handled everywhere that enumerates them by hand,
    # or it drifts silently: dom7 and halfdim arrived with the second corpus
    # and were missing from both the sky-weighting families (so a bright dom7
    # took the dark penalty) and the label map (so they rendered as raw
    # strings in the chord readout).
    check("BRIGHT and DARK partition the chord vocabulary",
          fv.BRIGHT | fv.DARK == set(fv.CHORD_TONES) and not (fv.BRIGHT & fv.DARK),
          f"uncovered={set(fv.CHORD_TONES) - (fv.BRIGHT | fv.DARK)}")
    check("every quality has a display label",
          set(fv.CHORD_LABEL) == set(fv.CHORD_TONES),
          f"missing={set(fv.CHORD_TONES) - set(fv.CHORD_LABEL)}")

    # Every quality the corpus can emit must reach the ear as its own chord.
    # Asserting only that the key exists in CHORD_TONES is what let the voicer
    # read tones[1:3] and silently drop every seventh: min7 came out identical
    # to min, maj7/dom7 identical to maj, halfdim identical to dim, and this
    # suite stayed green through all of it.
    for a, b in (("min", "min7"), ("maj", "maj7"), ("maj", "dom7"),
                 ("dim", "halfdim"), ("maj7", "dom7")):
        va, vb = fv.Voicer(9), fv.Voicer(9)
        check(f"{b!r} does not collapse onto {a!r}",
              va.voice((0, a), {"S", "A", "T", "B"}) != vb.voice((0, b), {"S", "A", "T", "B"}))

    # farvoices.py and build_corpus.py have to agree on what a label means. They
    # did not: the builder classifies (0,4,7,11) as maj7, the engine held
    # (0,4,7,10), which is its own dom7 -- harmless only while the seventh went
    # unvoiced, a wrong note the moment it did not.
    check("maj7 is a major seventh, not a duplicate dom7",
          fv.CHORD_TONES["maj7"] == (0, 4, 7, 11)
          and fv.CHORD_TONES["maj7"] != fv.CHORD_TONES["dom7"])

    # the bug that mattered: a fixed drone clashing with the chord.
    # Measured on realised intervals, not pitch classes: a maj7 voiced
    # correctly puts its seventh 11 semitones from the root, which a
    # pitch-class comparison cannot tell apart from a minor 2nd. The rub this
    # is guarding against is the realised minor 2nd and minor 9th.
    v = fv.Voicer(9)
    clash = total = 0
    for interval in range(12):
        for qual in fv.CHORD_TONES:
            out = v.voice((interval, qual), {"S", "A", "T", "B", "I", "O"})
            notes = sorted(out.values())
            total += 1
            if any(b - a in (1, 13)
                   for i, a in enumerate(notes) for b in notes[i + 1:]):
                clash += 1
    check("no minor 2nd or minor 9th across every chord in the vocabulary",
          clash == 0, f"{clash}/{total}")

    # The sweep above voices every chord from a cold start. Real playback keeps
    # voice-leading memory, so _nearest picks octaves relative to the previous
    # note and can reach placements a cold sweep never produces -- that is
    # exactly where the seventh first landed a semitone under the bass, six
    # times in four thousand frames, with the cold sweep showing zero.
    for corpus_name in ("obikhod_corpus.json", "arkhangelsky_corpus.json"):
        corpus = ROOT / corpus_name
        if not corpus.exists():
            continue
        rng = random.Random(11)
        model = fv.MarkovModel(corpus, rng)
        voicer = fv.Voicer(9)
        sky = fv.Sky(links=[
            fv.Link("gdscc", "DSS14", "X1", "down", "X", 50_000, -118.0, 0, 0),
            fv.Link("mdscc", "DSS63", "X2", "down", "S", 800, -140.0, 0, 0)])
        tones = json.loads((ROOT / "obikhod_tones_derived.json").read_text())["tones"]
        machine = fv.PhraseMachine(model, rng, 0.35)
        seq_clash = sevenths = 0
        for i in range(3000):
            chord, state, _ = machine.advance(tones[0], sky)
            out = voicer.voice(chord, {"S", "A", "T", "B", "I", "O"},
                               ornament=(state == "recitation" and i % 2 == 0))
            if chord[1] in ("min7", "maj7", "dom7", "halfdim"):
                sevenths += 1
            notes = sorted(out.values())
            if any(b - a in (1, 13)
                   for j, a in enumerate(notes) for b in notes[j + 1:]):
                seq_clash += 1
        check(f"no clash over a sustained run ({corpus_name.split('_')[0]})",
              seq_clash == 0, f"{seq_clash} in 3000 frames, {sevenths} sevenths")

    for part, (lo, hi) in fv.RANGE.items():
        out = v.voice((0, "min"), {part})
        if part in out:
            check(f"{part} stays in range", lo <= out[part] <= hi, f"{out[part]}")


# ---------------------------------------------------------------- corpora
def test_corpora():
    print("\ncorpora")
    for f in ("obikhod_corpus.json", "arkhangelsky_corpus.json"):
        p = ROOT / f
        if not p.exists():
            check(f"{f} present", False)
            continue
        d = json.loads(p.read_text())
        n = sum(len(x["chords"]) for x in d["pieces"])
        check(f"{f} chord count self consistent", n == d["n_chords"], f"{n} vs {d['n_chords']}")
        check(f"{f} every quality is voiceable",
              set(d["quality_counts"]) <= set(fv.CHORD_TONES),
              str(sorted(set(d["quality_counts"]) - set(fv.CHORD_TONES))))
        check(f"{f} roots are pitch classes",
              all(0 <= c["root"] <= 11 for x in d["pieces"] for c in x["chords"]))


def test_cadence_encoding():
    """build_corpus.py keys transitions by delta root but cadences by ABSOLUTE
    root, and documents only the first. Reading the absolute as a delta played
    a different interval than the score for 92.4% of Lyadov's cadences, turning
    its commonest gesture (the descending semitone, the Phrygian cadence) into
    ascending fifths and fourths -- the functional motion this repertoire is
    explicitly not analysed in."""
    print("\ncadence encoding")
    steps = fv.MarkovModel._cadence_steps("8:maj -> 7:maj")
    check("cadence shape parses to (delta, quality) steps",
          steps == [(0, "maj"), (11, "maj")], f"{steps}")
    check("first step does not move the root", steps and steps[0][0] == 0)

    corpus = ROOT / "obikhod_corpus.json"
    if not corpus.exists():
        return
    raw = json.loads(corpus.read_text()).get("cadences", {})
    intended, produced = Counter(), Counter()
    for shape, count in raw.items():
        a, b = [s.split(":") for s in shape.split(" -> ")]
        intended[(int(b[0]) - int(a[0])) % 12] += count
        produced[fv.MarkovModel._cadence_steps(shape)[1][0]] += count
    check("every cadence reproduces the interval the score recorded",
          intended == produced,
          f"{sum(produced.values())} occurrences over {len(raw)} shapes")


def test_not_sung_scope():
    """NOT_SUNG craft were excluded from voice assignment but still counted in
    the mean power that decides whether the sky reads bright or dark -- so the
    one craft deliberately kept out of the choir was colouring the choir's
    harmony, on 33% of recorded frames. Phrase length and the oktavist keep
    counting them, because that is the documented mapping."""
    print("\nNOT_SUNG scope")
    faint = fv.Link("gdscc", "DSS14", "VGR1", "down", "X", 160, -155.0, 0, 0)
    bright = fv.Link("mdscc", "DSS63", "MRO", "down", "X", 1_500_000, -105.0, 0, 0)
    sky = fv.Sky(links=[faint, bright])

    check("total_power still reports every downlink",
          abs(sky.total_power - (-130.0)) < 0.01, f"{sky.total_power:.1f}")
    check("choir_power ignores craft the choir does not sing",
          abs(sky.choir_power - (-105.0)) < 0.01, f"{sky.choir_power:.1f}")
    check("a NOT_SUNG craft no longer darkens the harmony",
          sky.choir_power > sky.total_power)

    # Documented mappings that must NOT change: "number of active downlinks"
    # and "a seventy metre dish is tracking" both count every link.
    check("phrase length still counts every downlink", len(sky.downlinks) == 2)
    check("a 70 m dish tracking a NOT_SUNG craft still calls the oktavist",
          fv.Sky(links=[faint]).has_big_dish)

    # An all-Voyager sky has no sung links at all; falling back to the honest
    # mean beats dividing by zero or inventing a floor.
    check("all-NOT_SUNG sky falls back to the true mean",
          abs(fv.Sky(links=[faint]).choir_power - (-155.0)) < 0.01)


def test_recite_motion():
    """Recitation is the longest state and returned the setting's table chord
    verbatim, so the corpus was never consulted during the state that dominates
    the output -- and with 9 of 10 settings reciting on a major chord, that is
    where the >75% major skew came from. --recite-motion holds the reciting
    pitch in the melody while the harmony moves under it, which is the form
    rather than a free walk: a reciting tone that wanders is not one."""
    print("\nrecite motion")
    corpus = ROOT / "obikhod_corpus.json"
    if not corpus.exists():
        return
    tones = json.loads((ROOT / "obikhod_tones_derived.json").read_text())["tones"]
    tone = tones[0]
    rec_pc = tuple(tone["recitation"])[0] % 12
    sky = fv.Sky(links=[fv.Link("gdscc", "DSS14", "A", "down", "X",
                                50_000, -118.0, 0, 0)])

    def recitation_chords(motion):
        rng = random.Random(3)
        model = fv.MarkovModel(corpus, rng, recite_motion=motion)
        machine = fv.PhraseMachine(model, rng, 0.35)
        seen = []
        for _ in range(6000):
            chord, state, _ = machine.advance(tone, sky)
            if state == "recitation":
                seen.append(chord)
        return seen

    off = recitation_chords(False)
    check("default leaves recitation exactly as it was",
          set(off) == {tuple(tone["recitation"])}, f"{set(off)}")

    on = recitation_chords(True)
    check("recite-motion actually moves the harmony",
          len(set(on)) > 1, f"{len(set(on))} distinct chords")

    # The invariant that makes it a reciting tone rather than a free walk.
    held = all(any((root + t) % 12 == rec_pc
                   for t in fv.CHORD_TONES.get(quality, ()))
               for root, quality in on)
    check("every recitation chord still contains the reciting pitch", held)

    # And the melody actually sings it: hold_pc pins the soprano.
    model = fv.MarkovModel(corpus, random.Random(3), recite_motion=True)
    check("hold_pc pins the soprano to the reciting pitch",
          model.hold_pc("recitation", tone) == rec_pc
          and model.hold_pc("cadence", tone) is None)
    v = fv.Voicer(9)
    out = v.voice((0, "maj"), {"S", "A", "T", "B"}, hold_pc=rec_pc)
    check("soprano holds the reciting pitch when asked",
          out["S"] % 12 == rec_pc, f"{out['S'] % 12} vs {rec_pc}")


def test_markov_fidelity():
    """At zero telemetry weight the generator must reproduce the source
    distribution. This is the regression test for the whole corpus pipeline:
    the order 2 table was once keyed so that it could only ever return the
    quality it already held, and the chain locked on its first chord."""
    print("\nmarkov fidelity")
    corpus = ROOT / "obikhod_corpus.json"
    if not corpus.exists():
        check("corpus present", False)
        return
    d = json.loads(corpus.read_text())
    want = {k: v / sum(d["quality_counts"].values())
            for k, v in d["quality_counts"].items()}

    rng = random.Random(5)
    m = fv.MarkovModel(str(corpus), rng)
    sky = fv.Sky([fv.Link("gdscc", "DSS25", "X", "down", "X", 3e5, -114.0, 0, 0)] * 5)
    got = Counter()
    for _ in range(6000):
        got[m.next_chord("intonation", {"recitation": [3, "maj"]}, sky, rng, 0.0)[1]] += 1
    tot = sum(got.values())

    # Every quality, not just maj/min. Asserting only on the two commonest
    # covered 71% of the corpus mass and would have passed a regression that
    # moved min7, open or dim. Mutation testing put the worst deviation across
    # all nine at 0.94 points, so the wider assertion costs nothing today.
    worst = 0.0
    for q in sorted(set(want) | set(got)):
        delta = abs(got[q] / tot - want.get(q, 0))
        worst = max(worst, delta)
        check(f"{q} within 4 points of source at lam=0",
              delta < 0.04, f"{100*got[q]/tot:.1f}% vs {100*want.get(q,0):.1f}%")

    # telemetry must move the distribution but never invent a transition
    got2 = Counter()
    faint = fv.Sky([fv.Link("g", "D", "X", "down", "X", 3e5, -150.0, 0, 0)] * 5)
    for _ in range(6000):
        got2[m.next_chord("intonation", {"recitation": [3, "maj"]}, faint, rng, 0.35)[1]] += 1
    check("a faint sky is darker than a strong one",
          got2["min"] / sum(got2.values()) > got["min"] / tot,
          f"{100*got2['min']/sum(got2.values()):.1f}% vs {100*got['min']/tot:.1f}%")

    # The sky has to reach the cadence itself, not only its timing. Cadence
    # shape was chosen on corpus frequency alone under --corpus, so the mapping
    # FormulaModel documents ("a strong sky resolves fully; a faint one takes
    # the medial cadence") did not exist in the model that actually ships.
    tones = json.loads((ROOT / "obikhod_tones_derived.json").read_text())["tones"]

    def cadence_colour(power):
        rng = random.Random(5)
        machine = fv.PhraseMachine(fv.MarkovModel(corpus, rng), rng, 0.35)
        sky = fv.Sky(links=[fv.Link("gdscc", "DSS14", "X", "down", "X",
                                    50_000, power, 0, 0)])
        landed = Counter()
        for _ in range(6000):
            chord, state, _ = machine.advance(tones[0], sky)
            if state == "cadence":
                landed[chord[1]] += 1
        n = sum(landed.values())
        return landed["maj"] / n if n else 0.0

    bright, faint = cadence_colour(-105.0), cadence_colour(-140.0)
    check("a strong sky cadences brighter than a faint one",
          bright > faint, f"{100*bright:.1f}% vs {100*faint:.1f}% major at the cadence")


# ---------------------------------------------------------------- astronomy
def test_astronomy():
    print("\nastronomy")
    stars = ROOT / "stars.json"
    if stars.exists():
        s = json.loads(stars.read_text())
        known = {"Sirius": -1.46, "Canopus": -0.72, "Arcturus": -0.05,
                 "Vega": 0.03, "Rigel": 0.13}
        by = {x["n"]: x for x in s if "n" in x}
        for n, mag in known.items():
            if n in by:
                check(f"{n} magnitude", abs(by[n]["v"] - mag) < 0.10,
                      f"{by[n]['v']} vs {mag}")
        check("all RA in range", all(0 <= x["r"] < 360 for x in s))
        check("all Dec in range", all(-90 <= x["d"] <= 90 for x in s))

    # Kepler: Earth's heliocentric longitude must sit opposite the Sun's
    # geocentric longitude, always, by definition.
    el = {"a": 1.00000261, "e": 0.01671123, "L": 100.46457166,
          "w": 102.93768193, "dL": 35999.37244981}
    def solve(el, jd):
        T = (jd - 2451545.0) / 36525.0
        L = el["L"] + el["dL"] * T
        M = math.radians(((L - el["w"]) % 360 + 360) % 360)
        E = M
        for _ in range(8):
            E -= (E - el["e"] * math.sin(E) - M) / (1 - el["e"] * math.cos(E))
        nu = 2 * math.atan2(math.sqrt(1 + el["e"]) * math.sin(E / 2),
                            math.sqrt(1 - el["e"]) * math.cos(E / 2))
        r = el["a"] * (1 - el["e"] * math.cos(E))
        return r, math.degrees(nu + math.radians(el["w"])) % 360
    # 2026-09-02: Sun's geocentric longitude is near 160 deg, so Earth near 340
    r, lam = solve(el, 2461285.5)
    check("Earth heliocentric longitude opposite the Sun",
          abs(((lam - 339.8 + 180) % 360) - 180) < 2.0, f"{lam:.1f} deg")
    check("Earth distance near 1 AU", 0.98 < r < 1.02, f"{r:.4f} AU")


# ---------------------------------------------------------------- privacy
def test_privacy():
    """The recorder must never write anything that identifies a person or a
    machine. It records a public feed; there is no reason for it to hold
    anything else."""
    print("\nprivacy")
    rec = (ROOT / "record.py").read_text()
    for bad in ("socket.gethostname", "getpass", "os.environ", "platform.node",
                "uuid.getnode", "REMOTE_ADDR", "ip_address"):
        check(f"recorder does not touch {bad}", bad not in rec)

    ev = ROOT / "data" / "events.jsonl"
    if ev.exists():
        keys = set()
        with ev.open() as fh:
            for n, line in enumerate(fh):
                if n > 400:
                    break
                keys |= set(json.loads(line))
        allowed = {"t", "downlinks", "craft", "acquired", "lost",
                   "dual_on", "dual_off", "lock_event", "links", "restart"}
        check("event log contains only expected fields",
              keys <= allowed, str(sorted(keys - allowed)))
        check("no IP-like field", not any("ip" in k.lower() for k in keys))
    else:
        print("       (no recorded data yet, field check skipped)")


def test_nonfinite():
    """power="NaN" crash-looped record.py 11,118 times (Sep-Oct 2026)."""
    print("\n  non-finite feed values")
    import record
    xml = ('<dsn><station name="mdscc"/><dish name="DSS54" azimuthAngle="1" windSpeed="">'
           '<target name="MRO"/>'
           '<downSignal active="true" dataRate="NaN" band="X" power="-120" spacecraft="MRO"/>'
           '<downSignal active="true" dataRate="5000" band="S" power="NaN" spacecraft="M01O"/>'
           '</dish></dsn>')
    links = fv.parse_dsn(xml)
    check("NaN rate dropped as carrier-only", [l.spacecraft for l in links] == ["M01O"])
    check("NaN power reads as unknown", links and links[0].power == fv.POWER_UNKNOWN)
    try:
        record.signature(links); ok = True
    except ValueError:
        ok = False
    check("recorder signature survives NaN", ok)


if __name__ == "__main__":
    test_parsing(); test_nonfinite(); test_voicing(); test_corpora()
    test_cadence_encoding(); test_not_sung_scope(); test_recite_motion()
    test_markov_fidelity(); test_astronomy(); test_privacy()
    print(f"\n  {len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        print("  failed: " + ", ".join(FAIL))
    sys.exit(1 if FAIL else 0)
