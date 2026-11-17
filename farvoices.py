#!/usr/bin/env python3
"""
Far Voices: the Deep Space Network sung as an Orthodox choir.

Reads the live NASA DSN Now feed, assigns each active radio link to a choral
voice part, and drives a two-tier generative model (phrase state machine on the
outside, chord model on the inside) out to Logic Pro over MIDI.

    python3 farvoices.py --list-ports
    python3 farvoices.py --port "IAC Driver Bus 1"
    python3 farvoices.py --replay "samples/*.xml" --seed 7 --dry-run
    python3 farvoices.py --smf vigil.mid --minutes 6

Tier 2: MarkovModel is what ships. It walks an order-2 chain (Katz backoff to
order-1, unigram floor) over chords transcribed from two real collections --
Lyadov's Ten Settings from the Obikhod, Op. 61 (1910) and Arkhangelsky's
Singing of Church Services, vol. 1 (1892) -- passed in with --corpus. Telemetry
reweights that distribution but is masked to its support, so the sky may only
reorder transitions the composer actually wrote.

FormulaModel is the fallback when --corpus is omitted: it walks the
hand-authored tables verbatim, which carry too few chords to learn a
distribution from, so there every bit of variation comes from the DSN.
"""

from __future__ import annotations

import argparse
import atexit
import glob
import heapq
import json
import math
import os
import random
import signal
import sys
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

class Clock:
    """Real time when playing, virtual time when rendering. Lets --render write
    a full-length piece instantly instead of sleeping through it."""

    def __init__(self, virtual: bool = False):
        self.virtual = virtual
        self.t = 0.0
        self.start = time.monotonic()

    def now(self) -> float:
        return self.t if self.virtual else time.monotonic() - self.start

    def wait(self, seconds: float) -> None:
        if self.virtual:
            self.t += max(0.0, seconds)
        else:
            time.sleep(max(0.0, seconds))


CLOCK = Clock()

HERE = Path(__file__).resolve().parent
DSN_URL = "https://eyes.nasa.gov/dsn/data/dsn.xml"
CFG_URL = "https://eyes.nasa.gov/dsn/config.xml"
UA = "ison/0.1 (+local research toy)"

# ---------------------------------------------------------------- voice parts

SOPRANO, ALTO, TENOR, BASS, OKTAVIST, ISON_ = "S", "A", "T", "B", "O", "I"
PARTS = [SOPRANO, ALTO, TENOR, BASS, OKTAVIST, ISON_]

# MIDI channel per part (0-indexed). Separate channels so Logic gives each part
# its own track: mute the oktavist, swap patches, read voice-leading per staff.
CHANNEL = {SOPRANO: 0, ALTO: 1, TENOR: 2, BASS: 3, OKTAVIST: 4, ISON_: 5}
PART_NAME = {0: "Soprano", 1: "Alto", 2: "Tenor", 3: "Bass",
             4: "Oktavist", 5: "Ison"}

# Comfortable ranges, MIDI note numbers.
RANGE = {
    SOPRANO:  (60, 79),
    ALTO:     (55, 74),
    TENOR:    (48, 67),
    BASS:     (40, 60),
    OKTAVIST: (28, 45),
    ISON_:    (45, 57),
}

# Must cover every quality the corpus emits. An unknown quality silently
# voiced as a minor triad would mis-colour the harmony without erroring.
CHORD_TONES = {
    "min":  (0, 3, 7),
    "maj":  (0, 4, 7),
    "dim":  (0, 3, 6),
    "aug":  (0, 4, 8),
    "open": (0, 7, 12),
    "min7": (0, 3, 7, 10),
    # A major seventh (11), not a minor one. build_corpus.py classifies the
    # scores with (0,4,7,11) -> "maj7" and (0,4,7,10) -> "dom7", so the 10 that
    # sat here made this label a second, duplicate spelling of dom7 and put the
    # engine at odds with the very file that produced its data. Silent for as
    # long as the voicer ignored the fourth tone; a wrong note the moment it
    # stopped.
    "maj7": (0, 4, 7, 11),
    # Bare dyads, common in this repertoire. Padded to a fifth so SATB has a
    # tone for every part; without padding the S/A/T unpacking raises.
    "min3": (0, 3, 7),
    "maj3": (0, 4, 7),
    # Arkhangelsky reaches past Lyadov's vocabulary: dominant and
    # half-diminished sevenths appear there and nowhere in Op.61.
    "dom7": (0, 4, 7, 10),
    "halfdim": (0, 3, 6, 10),
}

# Must cover every key in CHORD_TONES: publish.py falls back to the raw quality
# string, so a missing entry shows up in the deck's chord readout as "+3dom7"
# among "+3M" and "+3m". Only ever visible on Arkhangelsky, which is the corpus
# that has dom7 and halfdim at all -- and which is switchable in the UI.
CHORD_LABEL = {"min": "m", "maj": "M", "dim": "o", "aug": "+", "open": "(5)",
               "min7": "m7", "maj7": "M7", "min3": "m3", "maj3": "M3",
               "dom7": "7", "halfdim": "ø"}

# Which qualities a strong sky leans toward and which a faint one admits. These
# were two hand-written tuples inside the weighting function -- ("maj","open")
# and ("min","dim","min7") -- and when Arkhangelsky brought dom7 and halfdim
# into the vocabulary neither list was revisited, so a major-coloured dom7 got
# the penalty branch in a bright sky and a dark halfdim got it in a faint one.
# Naming the two families here and asserting they partition CHORD_TONES (see
# tests) is what stops the next added quality from drifting the same way.
BRIGHT = {"maj", "maj3", "maj7", "dom7", "open"}
DARK = {"min", "min3", "min7", "dim", "halfdim", "aug"}

# Received power below this is not a measurement. The feed emits sentinels for
# "no reading" the same way it emits rtlt="-1" -- observed values run to -270,
# -410, -480 and one -490 dBm, against a real DSN floor around -170 to -180.
# Measured over 127,617 recorded downlink samples the sentinels are 0.04% of
# readings, but total_power/choir_power are MEANS: a single -480 in a four-link
# frame drags the mean from -117 to -207 dBm, and across the archive that flips
# the bright/dark harmony verdict on 10 frames. Clamped rather than dropped --
# the link itself is real and its data rate is fine, it is only the power
# reading that is missing, so it reads as very faint instead of impossible.
POWER_FLOOR = -200.0
POWER_UNKNOWN = -160.0

# The three 70m dishes. Biggest ears get the octave-below bass.
BIG_DISHES = {"DSS14", "DSS43", "DSS63"}

# Craft shown on the map but kept out of the choir. Voyager 1 is over a light
# day out and downlinks at a few tens of bits per second; letting that drive a
# voice says more about the link budget than about the sky.
NOT_SUNG = {"VGR1", "VGR2"}

STATION_PAN = {"gdscc": 32, "mdscc": 64, "cdscc": 96}   # Goldstone / Madrid / Canberra
BAND_VOWEL  = {"S": 0, "X": 64, "K": 110, "Ka": 110}     # -> CC1, vowel morph

CC_MOD, CC_BREATH, CC_EXPR, CC_PAN, CC_ALL_NOTES_OFF = 1, 2, 11, 10, 123


# ------------------------------------------------------------------ DSN input

@dataclass(frozen=True)
class Link:
    station: str
    dish: str
    spacecraft: str
    direction: str          # "up" | "down"
    band: str
    data_rate: float
    power: float
    azimuth: float
    wind: float

    @property
    def big_dish(self) -> bool:
        return self.dish.upper() in BIG_DISHES


def _f(value, default=0.0) -> float:
    """DSN ships empty-string attributes (windSpeed="" is real). Never trust.

    It also ships power="NaN" (seen on M01O uplinks since 2026-09-14). float()
    accepts that, and a NaN slips past every comparison downstream -- it
    crash-looped record.py 11,118 times in round(). Non-finite is unknown."""
    try:
        if value is None or value == "":
            return default
        x = float(value)
    except (TypeError, ValueError):
        return default
    return x if math.isfinite(x) else default


def parse_dsn(xml_text: str) -> list[Link]:
    root = ET.fromstring(xml_text)
    links: list[Link] = []
    seen: set[tuple] = set()
    station = "gdscc"

    for node in root:
        if node.tag == "station":
            station = node.get("name", station)
            continue
        if node.tag != "dish":
            continue

        dish = node.get("name", "?")
        az   = _f(node.get("azimuthAngle"))
        wind = _f(node.get("windSpeed"))

        target_names = {t.get("name", "") for t in node.findall("target")}
        # A dish parked on the "DSN" pseudo-target has no real spacecraft.
        if target_names and target_names <= {"DSN", ""}:
            continue

        for tag, direction in (("upSignal", "up"), ("downSignal", "down")):
            for sig in node.findall(tag):
                if sig.get("active", "false").lower() != "true":
                    continue
                rate = _f(sig.get("dataRate"))
                if rate <= 0:                      # carrier only; guards log(0)
                    continue
                sc   = sig.get("spacecraft", "?")
                band = sig.get("band", "X")
                # The feed repeats identical downSignal rows on MSPA dishes.
                key = (dish, sc, direction, band, rate)
                if key in seen:
                    continue
                seen.add(key)
                power = _f(sig.get("power"), POWER_UNKNOWN)
                if power < POWER_FLOOR:
                    power = POWER_UNKNOWN
                links.append(Link(station, dish, sc, direction, band, rate,
                                  power, az, wind))
    return links


def fetch(url: str, timeout: float = 12.0) -> str:
    # Cache-buster: the feed is served with max-age=3600 but rewritten every ~5s.
    sep = "&" if "?" in url else "?"
    req = urllib.request.Request(f"{url}{sep}r={random.randrange(1 << 30)}",
                                 headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


# --------------------------------------------------------------- sky features

def part_for_rate(rate: float) -> str:
    """log10(dataRate) -> voice part. Thresholds are the actual 25/50/75th
    percentiles of downlink rate across 27,435 recorded real links (data/events.jsonl,
    2026-09-01 to 2026-09-03), not round log10 numbers: the earlier 3.5/5.0/6.5
    split put alto's band (5.0-6.5) over the densest part of the real
    distribution, so alto sang 57.6% of every link while soprano got 9.3% --
    nearly the same four-way split real DSN traffic never gives. These
    thresholds split the same recorded data 24/26/26/24 across the four voices.
    Lunar Reconnaissance Orbiter at 29 Mbps sings soprano; New Horizons at
    50 bps sings bass."""
    lg = math.log10(max(rate, 1.0))
    if lg < 4.6:
        return BASS
    if lg < 5.4:
        return TENOR
    if lg < 5.9:
        return ALTO
    return SOPRANO


def expression_for_power(dbm: float) -> int:
    """Downlink power -> CC11 target. Observed range roughly -170..-80 dBm.

    Deliberately NOT velocity: sampled choirs switch velocity layers, so
    dBm->velocity gives timbre jumps where you wanted a swell."""
    lo, hi = -160.0, -85.0
    t = (max(lo, min(hi, dbm)) - lo) / (hi - lo)
    return int(round(22 + t * 88))


@dataclass
class Sky:
    links: list[Link] = field(default_factory=list)
    ts: float = 0.0

    @property
    def downlinks(self) -> list[Link]:
        return [l for l in self.links if l.direction == "down"]

    def parts(self) -> dict[str, list[Link]]:
        """Voice assignment. NOT_SUNG craft still appear as links on the map --
        they are just never given a part."""
        out: dict[str, list[Link]] = {}
        for l in self.downlinks:
            if l.spacecraft in NOT_SUNG:
                continue
            out.setdefault(part_for_rate(l.data_rate), []).append(l)
        return out

    @property
    def spacecraft(self) -> set[str]:
        return {l.spacecraft for l in self.links}

    @property
    def dual_carrier(self) -> set[str]:
        """Spacecraft running two or more simultaneous downlinks this poll --
        a real, rare condition (a parallel science and housekeeping carrier,
        or two distinct bands at once), confirmed against the live feed, not
        a parsing artifact. Contrast parse_dsn's MSPA dedup, which removes
        the artifact this is not: identical rows the feed repeats verbatim."""
        counts: dict[str, int] = {}
        for l in self.downlinks:
            counts[l.spacecraft] = counts.get(l.spacecraft, 0) + 1
        return {sc for sc, n in counts.items() if n >= 2}

    @property
    def has_big_dish(self) -> bool:
        return any(l.big_dish for l in self.downlinks)

    @property
    def total_power(self) -> float:
        """Mean downlink dBm — closer to 0 means a strong sky.

        Every downlink, NOT_SUNG included: this is the honest readout of what
        is on the air, and it is what the deck displays as Mean signal. For the
        figure that colours the harmony, see choir_power.
        """
        d = self.downlinks
        return sum(l.power for l in d) / len(d) if d else -160.0

    @property
    def sung_downlinks(self) -> list[Link]:
        return [l for l in self.downlinks if l.spacecraft not in NOT_SUNG]

    @property
    def choir_power(self) -> float:
        """Mean dBm across only the craft the choir actually sings.

        Voyager is kept out of the choir because at a light-day out and a few
        tens of bits per second it "says more about the link budget than about
        the sky" -- but it was still in the mean that decides whether the sky
        reads bright or dark, and it is present in 33% of recorded frames.
        Measured over data/events.jsonl, dropping it lifts the mean by 6.99 dBm
        (median 5.95, max 33.5) on those frames, which straddles the -120
        threshold the weighting splits on. So the one craft deliberately
        excluded from singing was darkening the harmony of a third of the
        piece.

        Only the musical decisions use this. Phrase length and the oktavist
        keep counting every downlink, Voyager included, because those are the
        documented mapping ("number of active downlinks", "a seventy metre dish
        is tracking") and a 70 m dish tracking Voyager genuinely is tracking.
        """
        d = self.sung_downlinks
        return sum(l.power for l in d) / len(d) if d else self.total_power

    @property
    def wind(self) -> float:
        w = [l.wind for l in self.links if l.wind > 0]
        return sum(w) / len(w) if w else 0.0

    def pan(self, links: list[Link]) -> int:
        if not links:
            return 64
        return int(round(sum(STATION_PAN.get(l.station, 64) for l in links) / len(links)))

    def vowel(self, links: list[Link]) -> int:
        if not links:
            return 64
        return int(round(sum(BAND_VOWEL.get(l.band, 64) for l in links) / len(links)))

    def summary(self) -> str:
        p = self.parts()
        bits = [f"{k}:{len(v)}" for k in PARTS if (v := p.get(k))]
        return (f"{len(self.downlinks)} downlinks  [{' '.join(bits) or 'silent'}]  "
                f"{self.total_power:+.0f}dBm  70m={'yes' if self.has_big_dish else 'no'}  "
                f"wind={self.wind:.0f}")


# ------------------------------------------------------------- chord + voicing

class ChordModel:
    """Tier 2. Chooses chords *inside* a phrase state."""
    def next_chord(self, state: str, tone: dict, sky: Sky, rng: random.Random):
        raise NotImplementedError

    def hold_pc(self, state: str, tone: dict):
        """Pitch class the melody should hold this step, or None to let the
        chord decide. Only MarkovModel under --recite-motion returns one."""
        return None


class FormulaModel(ChordModel):
    """v1: walks the tone's formulas verbatim. Deterministic by design — with
    ~150 chords in the tables there is no distribution to learn, and pretending
    otherwise would just produce audible verbatim repetition dressed up as a
    model. Every bit of variation comes from the DSN via PhraseMachine."""

    def __init__(self):
        self.idx = 0

    def reset(self):
        self.idx = 0

    def next_chord(self, state, tone, sky, rng):
        if state == "recitation":
            return tuple(tone["recitation"])
        seq = tone["intonation"] if state == "intonation" else self._cadence(tone, sky)
        chord = seq[min(self.idx, len(seq) - 1)]
        self.idx += 1
        return tuple(chord)

    def steps(self, state, tone, sky):
        if state == "intonation":
            return len(tone["intonation"])
        return len(self._cadence(tone, sky))

    @staticmethod
    def _cadence(tone, sky):
        """DSN reweighting, MASKED TO SUPPORT: telemetry may only reorder
        cadences the tables actually contain, never invent one. A strong sky
        resolves fully; a faint one takes the medial cadence and carries on."""
        cadences = tone["cadences"]
        want = "final" if sky.choir_power > -125.0 else "medial"
        return cadences.get(want) or next(iter(cadences.values()))


class MarkovModel(ChordModel):
    """Tier 2, corpus-driven. Order-2 over (delta_root, quality) with Katz
    backoff to order-1 and a unigram floor -- the honest ceiling for a corpus
    this size, where a 48-token alphabet against a few hundred transitions
    leaves most order-2 contexts unseen.

    DSN telemetry reweights the distribution but is MASKED TO THE MODEL'S
    SUPPORT: it may only reorder transitions the corpus actually contains,
    never introduce one with zero observed probability. That mask is what lets
    the weighting run hot without walking off the style -- every chord change
    stays one Lyadov actually wrote."""

    def __init__(self, corpus_path, rng: random.Random, recite_motion: bool = False):
        data = json.loads(Path(corpus_path).read_text())
        self.rng = rng
        self.recite_motion = recite_motion
        self.order2: dict[tuple, Counter] = {}
        self.order1: dict[str, Counter] = {}
        self.unigram: Counter = Counter()

        # Build from the RAW per-piece sequences, not the pre-aggregated
        # "transitions" table. That table is keyed (q_from, q_to) with values
        # whose target quality IS q_to, so an order-2 lookup on it can only
        # ever return the quality already held -- the chain locks solid. Real
        # order-2 needs trigrams, which only the sequences carry.
        for piece in data.get("pieces", []):
            seq = [(c["root"], c["quality"]) for c in piece["chords"]]
            for i in range(len(seq) - 1):
                delta = (seq[i + 1][0] - seq[i][0]) % 12
                move = (delta, seq[i + 1][1])
                self.unigram[move] += 1
                self.order1.setdefault(seq[i][1], Counter())[move] += 1
                if i >= 1:
                    ctx = (seq[i - 1][1], seq[i][1])
                    self.order2.setdefault(ctx, Counter())[move] += 1

        self.cadences = [
            (steps, count)
            for shape, count in data.get("cadences", {}).items()
            if (steps := self._cadence_steps(shape))
        ]
        self.n_chords = data.get("n_chords", 0)
        self.current = (0, "min")
        self.prev_quality = None
        self._cadence = None
        self._cadence_step = 0

    @staticmethod
    def _cadence_steps(shape: str) -> list[tuple[int, str]]:
        """Cadence shapes into (delta, quality) steps the player can walk.

        build_corpus.py writes two different encodings into the same file and
        documents only one of them: transitions are keyed by DELTA root
        (`(root[i+1] - root[i]) % 12`), but cadences are keyed by ABSOLUTE
        root pitch class (`root % 12`). This read the absolute value and added
        it to the current root as though it were a delta, which replaced the
        interval the score actually cadences by in 92.4% of Lyadov's 484
        recorded cadences -- everything except the 7.6% whose first chord
        happened to sit on pitch class 0. The corpus peaks on the descending
        semitone, the Phrygian cadence of this repertoire; what came out was
        dominated by ascending fifths and fourths, which is the functional
        V-I/IV-I motion this project explicitly refuses to impose here.

        Converting to intervals rather than reading the absolutes straight is
        deliberate: the table pools pitch classes across pieces in different
        keys, so an absolute pc is not comparable between them, while the
        interval between the two chords is key-invariant -- which is exactly
        why the transitions table is stored as deltas in the first place. The
        first step carries delta 0: the cadence begins wherever the phrase
        already is and takes its quality, then moves by the recorded interval.
        """
        steps, prev = [], None
        for step in shape.split(" -> "):
            part = step.split(":")
            if len(part) != 2:
                return []
            try:
                pc = int(part[0]) % 12
            except ValueError:
                return []
            steps.append((0 if prev is None else (pc - prev) % 12, part[1]))
            prev = pc
        return steps

    def reset(self):
        self._cadence = None
        self._cadence_step = 0

    def _distribution(self, quality) -> Counter:
        """Katz backoff: order-2 context, else order-1, else the unigram floor."""
        if self.prev_quality is not None:
            d = self.order2.get((self.prev_quality, quality))
            if d and sum(d.values()) >= 3:
                return d
        return self.order1.get(quality) or self.unigram

    @staticmethod
    def _weight(move, sky: Sky, lam: float) -> float:
        """DSN likelihood over an already-legal move. A strong sky leans
        consonant and stepwise; a faint one admits darker colour."""
        delta, quality = move
        w = 1.0
        # -120 dBm splits the recorded material 63/37 strong-to-faint (median
        # mean-downlink power over 16,441 frames is -118.0). Left where it is
        # deliberately: unlike part_for_rate, which had a stated target (four
        # voices used evenly) and a measured failure against it, there is no
        # target here that says a bright sky should be half the time rather
        # than two thirds. Recorded so the next reader knows the split rather
        # than guessing at it.
        if sky.choir_power > -120.0:
            w *= 2.2 if quality in BRIGHT else 0.7
        else:
            w *= 2.0 if quality in DARK else 0.8
        # Busy sky -> more motion; quiet sky -> prefer standing still.
        w *= (1.5 if delta else 0.5) if len(sky.downlinks) > 5 else (0.6 if delta else 1.8)
        # Temperature. Masking to the corpus support stops ILLEGAL chords, but
        # it does nothing to stop a strong weight from collapsing the chain
        # onto one quality -- at lam=1.0 this generator emits 100% major
        # against a 41% major corpus. lam < 1 makes the DSN nudge the
        # distribution instead of dominating it.
        return w ** lam

    def hold_pc(self, state, tone):
        if state == "recitation" and self.recite_motion:
            return tuple(tone["recitation"])[0] % 12
        return None

    def _recite(self, rec, sky, rng, lam):
        """Hold the reciting tone; move the harmony under it.

        Recitation is the longest state (2-9 syllables against roughly 2 steps
        each for intonation and cadence), and returning the table's chord
        verbatim meant the corpus was never consulted during the state that
        dominates the output. With 9 of the 10 derived settings reciting on a
        major chord, that alone accounts for the >75% major output the README
        measures against corpora that are 41% and 52% major.

        The fix is not to walk the chain freely here -- a reciting tone that
        wanders is not a reciting tone, and the repeated pitch is the whole
        form. Instead the melody holds the reciting pitch (see hold_pc, which
        pins the soprano to it) while the chord underneath moves among corpus
        transitions that still contain that pitch: about a quarter of the
        vocabulary at any moment, so there is real motion available. This is
        what the sources do -- Lyadov's own long sonorities sit under a moving
        texture rather than stopping it.
        """
        rec_pc = tuple(rec)[0] % 12

        def contains(root, quality):
            return any((root + t) % 12 == rec_pc
                       for t in CHORD_TONES.get(quality, ()))

        # Entering recitation from wherever intonation ended: establish the
        # reciting chord first. Every chord chosen after this one contains the
        # reciting pitch by construction, so this only fires on entry.
        if not contains(self.current[0], self.current[1]):
            self.prev_quality = self.current[1]
            self.current = (rec_pc, tuple(rec)[1])
            return self.current

        dist = self._distribution(self.current[1])
        moves, weights = [], []
        for move, count in dist.items():
            delta, quality = move
            if contains((self.current[0] + delta) % 12, quality):
                moves.append(move)
                weights.append(count * self._weight(move, sky, lam))
        if not moves or sum(weights) <= 0:
            return self.current
        delta, quality = rng.choices(moves, weights=weights, k=1)[0]
        self.prev_quality = self.current[1]
        self.current = ((self.current[0] + delta) % 12, quality)
        return self.current

    def next_chord(self, state, tone, sky, rng, lam: float = 0.35):
        if state == "recitation":
            if self.recite_motion:
                return self._recite(tone["recitation"], sky, rng, lam)
            return tuple(tone["recitation"])

        if state == "cadence":
            if self._cadence is None and self.cadences:
                # The sky picks the cadence, not just its timing. FormulaModel
                # has always done this ("a strong sky resolves fully; a faint
                # one takes the medial cadence and carries on") but that model
                # only runs without --corpus, so in production -- which always
                # passes one -- cadence choice was corpus frequency alone and
                # the telemetry reached the cadence only through PhraseMachine
                # deciding WHEN to fire it.
                #
                # Weighted on the chord the cadence lands on, through the same
                # masked _weight the chord walk uses, so a bright sky leans
                # toward cadences ending bright without inventing a theory of
                # which Obikhod cadences count as conclusive. Masked to support
                # as everywhere else: this only reorders shapes the corpus
                # actually contains, and at lam=0 it reduces exactly to the raw
                # counts.
                shapes = [c for c, _ in self.cadences]
                weights = [n * self._weight((steps[-1][0], steps[-1][1]), sky, lam)
                           for steps, n in self.cadences]
                if sum(weights) <= 0:
                    weights = [n for _, n in self.cadences]
                self._cadence = rng.choices(shapes, weights=weights, k=1)[0]
            if self._cadence and self._cadence_step < len(self._cadence):
                delta, quality = self._cadence[self._cadence_step]
                self._cadence_step += 1
                self.prev_quality = self.current[1]
                self.current = ((self.current[0] + int(delta)) % 12, quality)
                return self.current

        dist = self._distribution(self.current[1])
        moves = list(dist.items())
        weights = [c * self._weight(m, sky, lam) for m, c in moves]
        total = sum(weights)
        if total <= 0:
            return self.current
        r, acc = rng.random() * total, 0.0
        for (delta, quality), w in zip((m for m, _ in moves), weights):
            acc += w
            if acc >= r:
                self.prev_quality = self.current[1]
                self.current = ((self.current[0] + delta) % 12, quality)
                return self.current
        return self.current

    def steps(self, state, tone, sky):
        if state == "cadence":
            return len(self._cadence) if self._cadence else 2
        return 2


class Voicer:
    """Realizes an abstract chord as SATB + oktavist + ison, choosing the
    octave placement nearest each part's previous note. That is the stepwise
    voice-leading rule; it is what keeps the parts from leaping."""

    def __init__(self, final_pc: int):
        self.final_pc = final_pc
        self.last: dict[str, int] = {}

    def _place(self, part: str, pitch_class: int, placed, floor: int | None = None):
        """Nearest octave that does not rub against anything already sounding.

        Returns None when the part cannot take this pitch class cleanly at all,
        so the caller can choose a different tone rather than emit a clash. A
        plain floor was not enough on its own: when the floor left no candidate
        in range the only options were to ignore it (which is how a maj7's
        seventh ended up a semitone under the bass) or to force a note that
        rubs, and neither is worth a seventh.
        """
        lo, hi = RANGE[part]
        cands = [n for n in range(lo, hi + 1) if n % 12 == pitch_class % 12
                 and all(abs(n - m) not in (1, 13) for m in placed)]
        if not cands:
            return None
        prev = self.last.get(part)
        mid = (lo + hi) // 2
        return min(cands, key=lambda n: (0 if floor is None or n >= floor else 1,
                                         abs(n - (prev if prev is not None else mid)), n))

    def _nearest(self, part: str, pitch_class: int) -> int:
        lo, hi = RANGE[part]
        candidates = [n for n in range(lo, hi + 1) if n % 12 == pitch_class % 12]
        if not candidates:
            return lo
        prev = self.last.get(part)
        if prev is None:
            mid = (lo + hi) // 2
            return min(candidates, key=lambda n: abs(n - mid))
        return min(candidates, key=lambda n: (abs(n - prev), n))

    def voice(self, chord, active_parts: set[str], ornament: bool = False,
              hold_pc: int | None = None) -> dict[str, int]:
        interval, quality = chord
        root = (self.final_pc + interval) % 12
        tones = CHORD_TONES.get(quality)
        if tones is None:
            raise KeyError(f"chord quality {quality!r} missing from CHORD_TONES")
        pcs = [(root + i) % 12 for i in tones]
        third, fifth = pcs[1], pcs[2]
        # The fourth tone, when the corpus recorded one. Reading only tones[1:3]
        # meant min7 came out identical to min, and maj7/dom7 identical to maj --
        # 12% of Lyadov's chords and 6.5% of Arkhangelsky's, including the dom7
        # and halfdim that were the whole reason for adding the second corpus.
        # The fifth is the expendable tone in four-part writing of a seventh
        # chord, so the tenor trades it for the seventh rather than anyone
        # dropping the root or third.
        seventh = pcs[3] if len(pcs) > 3 else None

        # The reciting tone is one repeated chord, so without this the phrase
        # is a dead drone. Real recitation carries text: the upper voice takes
        # a neighbour on alternate syllables while the harmony stands still.
        if seventh is None:
            assign = {SOPRANO: third if ornament else root,
                      ALTO: third, TENOR: fifth, BASS: root}
        else:
            # Four voices, four tones: give each one exactly once instead of
            # doubling the root. Doubling it here put the soprano's root a
            # minor 9th above the tenor's seventh on every single maj7 -- the
            # same rub the ison rule already exists to prevent, arriving from
            # the other direction. Every tone sounding once is also just how
            # a seventh chord is voiced in four parts.
            assign = {SOPRANO: third if ornament else fifth,
                      ALTO: third, TENOR: seventh, BASS: root}

        # A reciting tone is a held pitch, so under --recite-motion the soprano
        # keeps it while the harmony moves beneath. The ornament still gets its
        # alternate-syllable neighbour: that is the text articulation, and a
        # recitation with no articulation at all is the dead drone the ornament
        # was added to break.
        if hold_pc is not None and not ornament:
            assign[SOPRANO] = hold_pc % 12
        out: dict[str, int] = {}
        # Bass first, so the seventh can be kept above it. A maj7's seventh is
        # a semitone under the root's own octave, and placed by nearest-octave
        # alone the tenor kept landing just below the bass -- a crossed pair a
        # semitone apart, which then dragged the oktavist (it doubles the
        # LOWEST voice) to a minor 9th under the bass as well. Only sevenths
        # get the floor; triads keep exactly the placement they had.
        for part in (BASS, TENOR, ALTO, SOPRANO):
            if part not in assign or part not in active_parts:
                continue
            if part == TENOR and seventh is not None:
                # Keep the seventh above the bass where it fits, and never at a
                # semitone from it. If neither is possible in the tenor's range
                # the chord gives the seventh up and takes the fifth back --
                # losing a colour tone beats sounding a rub.
                placed = [out[BASS]] if BASS in out else []
                note = self._place(TENOR, seventh, placed,
                                   floor=(out[BASS] + 1) if BASS in out else None)
                out[TENOR] = note if note is not None else self._nearest(TENOR, fifth)
                continue
            out[part] = self._nearest(part, assign[part])

        # Oktavist doubles the LOWEST sounding voice an octave down, only when
        # a 70m dish is up. Keying it to the bass specifically left the biggest
        # dishes mute whenever no link was slow enough to make a bass part.
        if OKTAVIST in active_parts:
            lowest = min((n for p, n in out.items() if p != ISON_), default=None)
            if lowest is not None:
                out[OKTAVIST] = max(RANGE[OKTAVIST][0], lowest - 12)

        # The ison. Holds the final for as long as anyone is on the air --
        # but the chord model walks Lyadov's transitions freely, so a fixed
        # drone lands a semitone from a sounding voice about a quarter of the
        # time. A minor 9th rub is not an Obikhod sound, it is a mistake.
        # Keep the drone on the final wherever it is consonant, and shift it
        # to the chord root only to avoid a semitone. Orthodox practice does
        # move the ison between the mode's structural degrees, so this stays
        # faithful while removing the clash.
        if ISON_ in active_parts:
            # Every tone that can actually sound, seventh included -- an ison
            # checked only against root/third/fifth would happily sit a
            # semitone under a seventh it did not know was there.
            chord_pcs = {root, third, fifth} | ({seventh} if seventh is not None else set())
            pc = self.final_pc
            if pc not in chord_pcs and any(
                    min((pc - t) % 12, (t - pc) % 12) == 1 for t in chord_pcs):
                pc = root
            note = self._nearest(ISON_, pc)

            # The rule above reasons in pitch classes, which is enough for a
            # triad: no two of its tones are closer than a minor third, so a
            # final that is a chord tone can never rub against one. A seventh
            # chord breaks that -- a maj7's seventh IS a semitone from its own
            # root, so the drone can sit squarely on a chord tone and still
            # land a semitone from the bass. This checks what is actually
            # sounding, and only ever fires for sevenths, so triads keep the
            # exact placement they had. Final first, then root, then the fifth
            # -- all degrees the ison legitimately moves between.
            sounding = list(out.values())
            if any(abs(note - m) in (1, 13) for m in sounding):
                lo, hi = RANGE[ISON_]
                prev = self.last.get(ISON_)
                for cand_pc in (self.final_pc, root, fifth):
                    alts = [n for n in range(lo, hi + 1) if n % 12 == cand_pc % 12
                            and all(abs(n - m) not in (1, 13) for m in sounding)]
                    if alts:
                        note = (min(alts, key=lambda n: abs(n - prev)) if prev is not None
                                else min(alts, key=lambda n: abs(n - (lo + hi) // 2)))
                        break
            out[ISON_] = note

        self.last.update(out)
        return out


# -------------------------------------------------------------- phrase machine

class PhraseMachine:
    """Tier 1 — where 'structure and flow' actually live.

        intonation -> recitation (N syllables) -> cadence -> intonation ...

    DSN mapping, and it falls out of the form rather than being bolted on:
      * active downlink count  -> number of syllables -> recitation length
      * a spacecraft acquiring lock -> fire the cadence early
      * recitation exhausted        -> fire the cadence anyway

    That second trigger is load-bearing. Lock changes happen on hour
    timescales; a lock-only trigger would mean the piece never resolves."""

    def __init__(self, model: ChordModel, rng: random.Random, lam: float = 0.35):
        self.model, self.rng, self.lam = model, rng, lam
        self.state = "intonation"
        self.step = 0
        self.syllables = 0
        self.syl_index = 0
        self.seen: set[str] | None = None   # last poll's fleet, not a cumulative set
        self.dual_seen: set[str] | None = None  # last poll's dual-carrier craft

    def _chord(self, state, tone, sky):
        try:
            return self.model.next_chord(state, tone, sky, self.rng, self.lam)
        except TypeError:
            return self.model.next_chord(state, tone, sky, self.rng)

    def advance(self, tone: dict, sky: Sky, carried_lock=None) -> tuple[tuple, str, bool]:
        # Diff against the PREVIOUS poll, not a cumulative set. A cumulative
        # set only ever fires on a craft's first-ever appearance, so after ten
        # minutes of a rotating DSN schedule it holds the whole fleet and
        # nothing registers again. A pass ENDING counts too -- musically that
        # is just as much an event as one beginning.
        if carried_lock is not None:
            new_lock = carried_lock
        else:
            now = sky.spacecraft
            fleet_changed = self.seen is not None and bool(now ^ self.seen)
            self.seen = now

            # A spacecraft opening or closing a second simultaneous carrier
            # is the same kind of event as an acquisition or loss -- rare,
            # real, and worth cutting the phrase short for, not folding
            # silently into whichever two voice parts its rates happen to
            # land in. Same diff-against-previous-poll shape as fleet_changed
            # for the same reason: a cumulative set only ever fires once.
            dual_now = sky.dual_carrier
            dual_changed = self.dual_seen is not None and bool(dual_now ^ self.dual_seen)
            self.dual_seen = dual_now

            new_lock = fleet_changed or dual_changed

        if self.state == "intonation":
            chord = self._chord("intonation", tone, sky)
            self.step += 1
            if self.step >= self.model.steps("intonation", tone, sky):
                self.state, self.step = "recitation", 0
                self.syl_index = 0
                self.syllables = max(2, min(9, len(sky.downlinks)))
            return chord, "intonation", new_lock

        if self.state == "recitation":
            if new_lock or self.syllables <= 0:
                self.state, self.step = "cadence", 0
                self.model.reset()
                # Carry the flag: re-entering would diff against an already
                # updated set and silently report False for the very event
                # that caused the cut.
                return self.advance(tone, sky, carried_lock=new_lock)
            self.syllables -= 1
            self.syl_index += 1
            return self._chord("recitation", tone, sky), "recitation", new_lock

        chord = self._chord("cadence", tone, sky)
        self.step += 1
        if self.step >= self.model.steps("cadence", tone, sky):
            self.state, self.step = "intonation", 0
            self.model.reset()
        return chord, "cadence", new_lock


# --------------------------------------------------------------------- output

class Out:
    """Live MIDI and/or a Standard MIDI File, with note-off hygiene that
    survives Ctrl-C. Long swells plus a killed process equals a choir droning
    in Logic until you quit it."""

    def __init__(self, port_name=None, smf_path=None, dry=False):
        self.dry, self.smf_path = dry, smf_path
        self.port = None
        self._finished = False
        self.sounding: dict[int, set[int]] = {}
        self.touched: set[int] = set()
        self.track: list[tuple[float, object]] = []

        if port_name and not dry:
            import mido
            mido.set_backend("mido.backends.rtmidi")
            names = mido.get_output_names()
            if port_name in names:
                self.port = mido.open_output(port_name)
            else:
                self.port = mido.open_output(port_name, virtual=True)
            print(f"  MIDI out: {self.port.name}"
                  f"{'' if port_name in names else '  (virtual — select it in Logic)'}")

        atexit.register(self.panic)
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, self._on_signal)

    def _on_signal(self, *_):
        self.panic()
        self.finish()
        sys.exit(0)

    def _send(self, msg):
        if self.smf_path is not None:
            self.track.append((CLOCK.now(), msg))
        if self.port is not None:
            self.port.send(msg)

    def _msg(self, kind, **kw):
        import mido
        return mido.Message(kind, **kw)

    def note_on(self, ch, note, vel=64):
        self.touched.add(ch)
        self.sounding.setdefault(ch, set()).add(note)
        if not self.dry:
            self._send(self._msg("note_on", channel=ch, note=note, velocity=vel))

    def note_off(self, ch, note):
        self.sounding.get(ch, set()).discard(note)
        if not self.dry:
            self._send(self._msg("note_off", channel=ch, note=note, velocity=0))

    def cc(self, ch, control, value):
        self.touched.add(ch)
        if not self.dry:
            self._send(self._msg("control_change", channel=ch,
                                 control=control, value=max(0, min(127, int(value)))))

    def panic(self):
        """Explicit note-offs for everything sounding, then all-notes-off on
        every channel we ever touched. Belt and braces, on purpose."""
        if self.dry:
            return
        try:
            for ch, notes in list(self.sounding.items()):
                for note in list(notes):
                    self.note_off(ch, note)
            for ch in sorted(self.touched):
                self._send(self._msg("control_change", channel=ch,
                                     control=CC_ALL_NOTES_OFF, value=0))
        except Exception:
            pass

    def finish(self):
        if self._finished:
            return
        self._finished = True
        if self.port is not None:
            try:
                self.port.close()
            except Exception:
                pass
        if self.smf_path and self.track:
            import mido
            tpb, tempo = 480, mido.bpm2tempo(50)
            # Type 1, ONE TRACK PER VOICE PART. Logic splits an imported MIDI
            # file on tracks, not on channels — a single track holding six
            # channels lands as one stacked region.
            mf = mido.MidiFile(type=1, ticks_per_beat=tpb)

            conductor = mido.MidiTrack()
            mf.tracks.append(conductor)
            conductor.append(mido.MetaMessage("track_name", name="ISON", time=0))
            conductor.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))

            by_channel: dict[int, list] = {}
            for t, msg in self.track:
                by_channel.setdefault(msg.channel, []).append((t, msg))

            for ch in sorted(by_channel):
                tr = mido.MidiTrack()
                mf.tracks.append(tr)
                tr.append(mido.MetaMessage(
                    "track_name", name=PART_NAME.get(ch, f"Channel {ch + 1}"), time=0))
                prev = 0.0
                for t, msg in by_channel[ch]:
                    delta = mido.second2tick(max(0.0, t - prev), tpb, tempo)
                    tr.append(msg.copy(time=int(round(delta))))
                    prev = t

            mf.save(self.smf_path)
            print(f"  wrote {self.smf_path}  ({len(self.track)} events, "
                  f"{len(mf.tracks) - 1} parts)")


# ----------------------------------------------------------------- the fetcher

class Feed:
    """Background poller. Decoupled from the musical clock on purpose: the
    feed rewrites every ~5s, but re-voicing the chord that often gives you a
    chattering, nervous choir. Deltas are queued here and only read at a
    harmonic boundary."""

    def __init__(self, replay_glob=None):
        self.sky = Sky()
        self.lock = threading.Lock()
        self.stop = threading.Event()
        # A glob that matches nothing has to be fatal, not a silent fall back to
        # the live feed. The guard for it used to live in prime() nested inside
        # `if self.replay:`, so it could never fire -- an empty list is falsy,
        # took the else branch, and quietly fetched live instead. That turns
        # --replay into "maybe replay", which is worse than useless for the one
        # job it has: two A/B renders compared here differed only because the
        # sky moved between them, and read as a code change that was not one.
        if replay_glob is not None:
            self.replay = sorted(glob.glob(replay_glob))
            if not self.replay:
                raise SystemExit(f"no files matched --replay {replay_glob!r}")
        else:
            self.replay = None
        self.i = 0
        self.errors = 0

    @staticmethod
    def _read(path):
        # Snapshots older than a couple of days may be gzipped.
        p = Path(path)
        if p.suffix == ".gz":
            import gzip
            return gzip.decompress(p.read_bytes()).decode("utf-8")
        return p.read_text()

    def _store(self, text):
        with self.lock:
            self.sky = Sky(parse_dsn(text), time.time())

    def prime(self):
        if self.replay:
            self._store(self._read(self.replay[0]))
        else:
            self._store(fetch(DSN_URL))

    def run(self):
        while not self.stop.wait(5.0):
            try:
                if self.replay:
                    self.i = (self.i + 1) % len(self.replay)
                    self._store(self._read(self.replay[self.i]))
                else:
                    self._store(fetch(DSN_URL))
                self.errors = 0
            except Exception as exc:
                self.errors += 1
                if self.errors in (1, 5, 20):
                    print(f"  [feed] {type(exc).__name__}: {exc}", file=sys.stderr)

    def step(self):
        """One feed advance, for --render where no wall time passes."""
        try:
            if self.replay:
                self.i = (self.i + 1) % len(self.replay)
                self._store(self._read(self.replay[self.i]))
        except Exception:
            pass

    def latest(self) -> Sky:
        with self.lock:
            return self.sky


# ------------------------------------------------------------------- the piece

def tone_for_today(tones, override=None):
    """Weekly rotation through Lyadov's ten settings.

    This used to rotate through eight Octoechos tones. Op.61 contains no tone
    cycle at all -- it is ten festal settings -- so eight tones would have been
    my invention dressed as tradition. Rotating the ten real settings keeps the
    weekly-change idea while every mode, reciting tone and cadence below is
    measured from the score. ISO week stands in for the liturgical calendar."""
    if override:
        return tones[(override - 1) % len(tones)]
    return tones[(date.today().isocalendar().week - 1) % len(tones)]


def run(args):
    data = json.loads((HERE / args.tables).read_text())
    tone = tone_for_today(data["tones"], args.tone)
    rng = random.Random(args.seed)

    print(f"\n  Far Voices: the Deep Space Network sung as an Orthodox choir")
    print(f"  {tone['name']}")
    print(f"  {tone.get('occasion','')}  |  mode={tone['mode']}"
          f" ({tone.get('mode_confidence','?')} confidence)"
          f"  |  {tone.get('voices','?')} voices  |  {tone['source']}")
    print(f"  final={args.key}   chord={args.chord_seconds:g}s   recite={args.recite_seconds:g}s   seed={args.seed}\n")

    feed = Feed(args.replay)
    feed.prime()
    if not CLOCK.virtual:
        threading.Thread(target=feed.run, daemon=True).start()

    out = Out(args.port, args.smf, args.dry_run)
    if args.corpus:
        model = MarkovModel(HERE / args.corpus, rng,
                            recite_motion=args.recite_motion)
        print(f"  corpus: {args.corpus}  {model.n_chords} chords, "
              f"{len(model.unigram)} distinct moves\n")
    else:
        model = FormulaModel()
    machine = PhraseMachine(model, rng, args.dsn_weight)
    voicer = Voicer(args.key % 12)

    deadline = CLOCK.now() + args.minutes * 60
    held: dict[str, int] = {}
    last_expr: dict[str, int] = {}
    bar = 0

    try:
        while CLOCK.now() < deadline:
            if CLOCK.virtual:
                feed.step()          # virtual time: advance the feed by hand
            sky = feed.latest()
            chord, state, lock_event = machine.advance(tone, sky)
            by_part = sky.parts()

            active = {p for p in (SOPRANO, ALTO, TENOR, BASS) if by_part.get(p)}
            if active:
                active.add(ISON_)
                if sky.has_big_dish:
                    active.add(OKTAVIST)

            ornament = state == "recitation" and machine.syl_index % 2 == 0
            target = voicer.voice(chord, active, ornament,
                                  hold_pc=model.hold_pc(state, tone)) if active else {}
            # Recitation is quick, intonation and cadence are broad. One global
            # chord length would give 80 seconds of a single reciting chord.
            dur = args.recite_seconds if state == "recitation" else args.chord_seconds

            # Release parts that are leaving or moving.
            for part, note in list(held.items()):
                if target.get(part) != note:
                    out.note_off(CHANNEL[part], note)
                    del held[part]
                    last_expr.pop(part, None)

            # Per-part expression, pan and vowel from that part's own links.
            for part, note in target.items():
                links = by_part.get(part) or by_part.get(BASS) or sky.downlinks
                if part not in held:
                    out.cc(CHANNEL[part], args.expr_cc, 20)
                    last_expr[part] = 20
                    out.note_on(CHANNEL[part], note, vel=72)
                    held[part] = note
                if not args.no_pan:
                    out.cc(CHANNEL[part], CC_PAN, sky.pan(links))
                if not args.no_vowel:
                    out.cc(CHANNEL[part], CC_MOD, sky.vowel(links))
                if not args.no_breath:
                    out.cc(CHANNEL[part], CC_BREATH, min(127, sky.wind * 4))

            bar += 1
            name = CHORD_LABEL.get(chord[1], chord[1])
            print(f"  {bar:>3}  {state:<10} {'+' + str(chord[0]) + name:>7}  "
                  f"{''.join(p for p in PARTS if p in target):<6} "
                  f"{'<lock>' if lock_event else '      '}  {sky.summary()}")

            # Swell: CC11 ramp per part, then hold. This — not velocity — is
            # what makes it read as a choir rather than an organ.
            peak = {p: expression_for_power(
                        max((l.power for l in (by_part.get(p) or sky.downlinks)),
                            default=-140.0))
                    for p in target}
            attack, steps = min(args.attack, dur * 0.5), 24
            for s in range(1, steps + 1):
                for part in target:
                    lo, hi = last_expr.get(part, 20), peak.get(part, 90)
                    out.cc(CHANNEL[part], args.expr_cc, lo + (hi - lo) * (s / steps))
                CLOCK.wait(attack / steps)
            last_expr.update({p: peak.get(p, 90) for p in target})
            CLOCK.wait(dur - attack)
    finally:
        out.panic()
        out.finish()
        feed.stop.set()
        print("\n  silence.\n")


def main():
    p = argparse.ArgumentParser(description="ISON — DSN sonification as Orthodox choir")
    p.add_argument("--port", help='MIDI out, e.g. "IAC Driver Bus 1". '
                                  "Unknown names are created as a virtual port.")
    p.add_argument("--list-ports", action="store_true")
    p.add_argument("--smf", help="also write a Standard MIDI File here")
    p.add_argument("--dry-run", action="store_true", help="print only, no MIDI")
    p.add_argument("--replay", help='glob of saved dsn.xml files, e.g. "samples/*.xml"')
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--tone", type=int, choices=range(1, 11),
                   help="override the weekly setting (1-10, Lyadov Op.61)")
    p.add_argument("--key", type=int, default=45, help="final, MIDI note (45=A2)")
    p.add_argument("--chord-seconds", type=float, default=9.0,
                   help="intonation/cadence chord length; 8-20s suits a choir")
    p.add_argument("--recite-seconds", type=float, default=2.5,
                   help="length of one recitation syllable")
    p.add_argument("--attack", type=float, default=3.0, help="CC11 swell length")
    p.add_argument("--minutes", type=float, default=30.0)
    p.add_argument("--expr-cc", type=int, default=CC_EXPR,
                   help="CC for swells (default 11 expression; try 7 if a patch ignores it)")
    p.add_argument("--no-vowel", action="store_true",
                   help="suppress CC1 — Alchemy patches map it to morph/filter")
    p.add_argument("--no-breath", action="store_true", help="suppress CC2")
    p.add_argument("--no-pan", action="store_true", help="suppress CC10")
    p.add_argument("--render", action="store_true",
                   help="write --smf in virtual time (instant, no playback)")
    p.add_argument("--tables", default="obikhod_tones_derived.json",
                   help="tone tables; obikhod_tones.json is the old hand-authored set")
    p.add_argument("--dsn-weight", type=float, default=0.35,
                   help="how hard telemetry bends the corpus distribution. "
                        "0 = pure Lyadov statistics, 1 = DSN dominates and the "
                        "chain collapses onto one chord quality")
    p.add_argument("--corpus", help="corpus JSON from scores/corpus.py; "
                                    "switches tier 2 from formulas to Markov")
    p.add_argument("--recite-motion", action="store_true",
                   help="hold the reciting tone in the melody but let the "
                        "harmony move under it, instead of repeating the "
                        "setting's reciting chord verbatim for the whole "
                        "recitation. Off by default: it changes the character "
                        "of the longest state in the piece.")
    args = p.parse_args()

    if args.list_ports:
        import mido
        mido.set_backend("mido.backends.rtmidi")
        print("\n  MIDI outputs:")
        for n in mido.get_output_names():
            print(f"    {n}")
        print("\n  (any other name becomes a virtual port Logic can see)\n")
        return

    if args.render:
        if not args.smf:
            p.error("--render needs --smf")
        globals()["CLOCK"] = Clock(virtual=True)

    if not (args.port or args.smf or args.dry_run):
        p.error("give --port, --smf or --dry-run (or --list-ports)")
    run(args)


if __name__ == "__main__":
    main()
