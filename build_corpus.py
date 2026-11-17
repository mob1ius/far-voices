#!/usr/bin/env python3
"""
build_corpus.py — turn Audiveris MusicXML output into a Far Voices chord corpus.

    ./.venv/bin/python build_corpus.py --in scores/arkhangelsky/omr \
        --out arkhangelsky_corpus.json \
        --source "Arkhangelsky, Church Services vol.1 (1892). Public domain."

Chords are encoded as (root pitch class, quality). Transitions are keyed
delta_root|target_quality|source_quality -- interval and quality, never roman
numerals, because functional analysis mangles modal harmony.

This is OMR output. Individual chords will be wrong; the aggregate statistics
are what the generator uses, and they survive a scattering of errors.
"""
from __future__ import annotations
import argparse, json, sys
from collections import Counter
from pathlib import Path

from music21 import converter, chord as m21chord


QUALITY = {
    (0, 4, 7): "maj", (0, 3, 7): "min", (0, 3, 6): "dim", (0, 4, 8): "aug",
    (0, 7): "open", (0, 3, 7, 10): "min7", (0, 4, 7, 10): "dom7",
    (0, 4, 7, 11): "maj7", (0, 3, 6, 10): "halfdim",
    (0, 3): "min3", (0, 4): "maj3",
}


def classify(ch: m21chord.Chord):
    """Root pitch class and a quality label from the interval set."""
    pcs = sorted({p.pitchClass for p in ch.pitches})
    if len(pcs) < 2:
        return None
    best = None
    for root in pcs:
        iv = tuple(sorted((p - root) % 12 for p in pcs))
        q = QUALITY.get(iv)
        if q:
            # prefer a labelled reading rooted on the actual bass where possible
            score = (0 if root == ch.bass().pitchClass else 1, len(iv))
            if best is None or score < best[0]:
                best = (score, root, q)
    if best:
        return best[1], best[2]
    try:
        return ch.root().pitchClass, ("min" if ch.quality == "minor" else "maj")
    except Exception:
        return None


def extract(path: Path):
    sc = converter.parse(str(path))
    flat = sc.chordify().flatten().notes
    out = []
    for el in flat:
        if not isinstance(el, m21chord.Chord):
            continue
        r = classify(el)
        if not r:
            continue
        out.append({"root": int(r[0]), "quality": r[1],
                    "offset": float(el.offset),
                    "dur": float(el.duration.quarterLength)})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True, help="dir of .mxl/.xml")
    ap.add_argument("--out", required=True)
    ap.add_argument("--source", required=True, help="citation for _meta")
    ap.add_argument("--cadence-len", type=int, default=2)
    a = ap.parse_args()

    files = sorted([p for p in Path(a.src).rglob("*")
                    if p.suffix.lower() in (".mxl", ".xml", ".musicxml")])
    if not files:
        sys.exit(f"no MusicXML under {a.src}")
    print(f"  {len(files)} file(s)")

    pieces, qc = [], Counter()
    transitions, cadences = Counter(), Counter()
    for f in files:
        try:
            ch = extract(f)
        except Exception as exc:
            print(f"    skip {f.name}: {type(exc).__name__}")
            continue
        if len(ch) < 4:
            continue
        pieces.append({"file": f.name, "chords": ch})
        for c in ch:
            qc[c["quality"]] += 1
        for i in range(len(ch) - 1):
            d = (ch[i + 1]["root"] - ch[i]["root"]) % 12
            transitions[f'{d}|{ch[i+1]["quality"]}|{ch[i]["quality"]}'] += 1
        # phrase endings: the move landing on an above-90th-percentile duration
        durs = sorted(c["dur"] for c in ch)
        thr = durs[int(len(durs) * 0.9)] if durs else 0
        for i in range(1, len(ch)):
            if ch[i]["dur"] >= thr:
                a_ = f'{(ch[i-1]["root"]) % 12}:{ch[i-1]["quality"]}'
                b_ = f'{(ch[i]["root"]) % 12}:{ch[i]["quality"]}'
                cadences[f"{a_} -> {b_}"] += 1
        print(f"    {f.name[:44]:<45} {len(ch):>5} chords")

    n = sum(len(p["chords"]) for p in pieces)
    json.dump({
        "_meta": {
            "source": a.source,
            "pipeline": "scan -> Audiveris OMR -> music21 chordify -> build_corpus.py",
            "encoding": "transition key = 'delta_root_semitones|target_quality|source_quality'",
            "caveat": "OMR output. Individual chords will contain errors; the "
                      "aggregate statistics are what the generator uses.",
        },
        "n_pieces": len(pieces), "n_chords": n,
        "quality_counts": dict(qc.most_common()),
        "transitions": dict(transitions.most_common()),
        "cadences": dict(cadences.most_common()),
        "pieces": pieces,
    }, open(a.out, "w"), separators=(",", ":"))
    print(f"\n  {len(pieces)} pieces, {n} chords -> {a.out}")
    print("  quality mix:", ", ".join(f"{k} {100*v/max(1,n):.0f}%"
                                      for k, v in qc.most_common(5)))


if __name__ == "__main__":
    main()
