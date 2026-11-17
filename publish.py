#!/usr/bin/env python3
"""
publish.py -- bridge the tested engine in farvoices.py to the live site.

This does not touch farvoices.py. That module has a full test suite behind it
(the Markov fidelity check, the ison consonance check) and the goal here is to
reuse it exactly as tested, not to fork its logic into a second code path.

The connection is outbound only: this process POSTs a frame to the Worker
every time one is generated and accepts nothing inbound.

    export PUBLISH_TOKEN="the same value set with: wrangler secret put PUBLISH_TOKEN"
    ./.venv/bin/python publish.py --url https://farvoices.com/publish --corpus obikhod_corpus.json

Run this under the same process supervisor you'd use for record.py -- both are
meant to run continuously.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import farvoices as fv  # noqa: E402

MAX_BACKOFF = 60.0


def build_frame(chord, state, lock, sky, target, expr, acquired, lost,
                 dual_on=(), dual_off=()) -> dict:
    """Same shape hub.js's sanitizeFrame expects. Kept deliberately small --
    every field here is something the deck actually renders, nothing more.

    acquired/lost/dual_on/dual_off come from the caller, not from Sky -- Sky
    is a stateless snapshot of one poll and was never going to carry a diff
    against the previous one. PhraseMachine.advance() only returns a bare
    boolean for lock, which is enough to drive the music but not enough to
    name which craft came, went, or opened a second carrier for the
    logbook, so those diffs are tracked here the same way record.py already
    tracks acquired/lost for the recorded history."""
    links = []
    for l in sky.downlinks + [x for x in sky.links if x.direction == "up"]:
        links.append({
            "st": l.station, "d": l.dish, "sc": l.spacecraft, "dir": l.direction,
            "b": l.band, "r": l.data_rate, "p": l.power,
            "part": fv.part_for_rate(l.data_rate) if l.direction == "down" else None,
        })
    return {
        "t": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
        "state": state,
        "lock": bool(lock),
        "acq": sorted(acquired),
        "lost": sorted(lost),
        "dualOn": sorted(dual_on),
        "dualOff": sorted(dual_off),
        "chord": [chord[0], fv.CHORD_LABEL.get(chord[1], chord[1])],
        "notes": {p: target.get(p) for p in fv.PARTS},
        "expr": {p: expr.get(p, 0) for p in target},
        "links": links,
        "dbm": round(sky.total_power, 1),
        "n": len(sky.downlinks),
    }


def post_frame(url: str, token: str, frame: dict, timeout: float = 6.0) -> bool:
    body = json.dumps(frame).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        # Identify as this project, as record.py does towards the DSN feed.
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "User-Agent": fv.UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit("  [publish] 401 unauthorized -- PUBLISH_TOKEN does not match the "
                     "value set with `wrangler secret put PUBLISH_TOKEN`. Stopping rather "
                     "than retrying a token that will never work.")
        print(f"  [publish] HTTP {e.code}", file=sys.stderr)
        return False
    except urllib.error.URLError as e:
        print(f"  [publish] network error: {e.reason}", file=sys.stderr)
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True, help="the Worker's /publish endpoint")
    ap.add_argument("--tables", default="obikhod_tones_derived.json")
    ap.add_argument("--corpus", help="corpus JSON; omit for the deterministic formula model")
    ap.add_argument("--tone", type=int, choices=range(1, 11))
    ap.add_argument("--key", type=int, default=45)
    ap.add_argument("--chord-seconds", type=float, default=9.0)
    ap.add_argument("--recite-seconds", type=float, default=2.5)
    ap.add_argument("--dsn-weight", type=float, default=0.35)
    ap.add_argument("--recite-motion", action="store_true",
                    help="hold the reciting tone while the harmony moves under it")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    token = os.environ.get("PUBLISH_TOKEN")
    if not token:
        sys.exit("  set PUBLISH_TOKEN in the environment first "
                 "(the same value passed to `wrangler secret put PUBLISH_TOKEN`)")

    data = json.loads((HERE / args.tables).read_text())
    tone = fv.tone_for_today(data["tones"], args.tone)
    rng = random.Random(args.seed)

    feed = fv.Feed(None)
    feed.prime()
    import threading
    threading.Thread(target=feed.run, daemon=True).start()

    model = (fv.MarkovModel(HERE / args.corpus, rng,
                            recite_motion=args.recite_motion)
             if args.corpus else fv.FormulaModel())
    machine = fv.PhraseMachine(model, rng, args.dsn_weight)
    voicer = fv.Voicer(args.key % 12)

    print(f"  publishing to {args.url}\n  {tone['name']}\n")

    held: dict[str, int] = {}
    backoff = 1.0
    bar = 0
    prev_fleet: set[str] | None = None
    prev_dual: set[str] | None = None

    while True:
        sky = feed.latest()
        now_fleet = {l.spacecraft for l in sky.links}
        acquired = sorted(now_fleet - prev_fleet) if prev_fleet is not None else []
        lost = sorted(prev_fleet - now_fleet) if prev_fleet is not None else []
        prev_fleet = now_fleet

        now_dual = sky.dual_carrier
        dual_on = sorted(now_dual - prev_dual) if prev_dual is not None else []
        dual_off = sorted(prev_dual - now_dual) if prev_dual is not None else []
        prev_dual = now_dual

        chord, state, lock = machine.advance(tone, sky)
        by_part = sky.parts()

        active = {p for p in (fv.SOPRANO, fv.ALTO, fv.TENOR, fv.BASS) if by_part.get(p)}
        if active:
            active.add(fv.ISON_)
            if sky.has_big_dish:
                active.add(fv.OKTAVIST)

        ornament = state == "recitation" and machine.syl_index % 2 == 0
        target = voicer.voice(chord, active, ornament,
                              hold_pc=model.hold_pc(state, tone)) if active else {}
        dur = args.recite_seconds if state == "recitation" else args.chord_seconds

        expr = {p: fv.expression_for_power(
                    max((l.power for l in (by_part.get(p) or sky.downlinks)), default=-140.0))
                for p in target}

        frame = build_frame(chord, state, lock, sky, target, expr, acquired, lost,
                            dual_on, dual_off)
        ok = post_frame(args.url, token, frame)
        backoff = 1.0 if ok else min(MAX_BACKOFF, backoff * 2)

        bar += 1
        mark = "PUBLISHED" if ok else f"retry in {backoff:.0f}s"
        print(f"  {bar:>5}  {state:<10} {frame['chord'][0]:+d}{frame['chord'][1]:<3} "
              f"{sky.summary():<60} {mark}")

        held.update(target)
        time.sleep(dur if ok else backoff)


if __name__ == "__main__":
    main()
