#!/usr/bin/env python3
"""
Far Voices recorder — the piece the DSN feed is missing.

eyes.nasa.gov publishes only "now". There is no history endpoint, so a browser
toy can never hear anything but the present moment, and a lock event is
something you sit and wait for rather than something you can go and find.

This polls the feed and keeps two things:

  events.jsonl   one line per MEANINGFUL change — a craft acquired or lost, a
                 data rate step, a dish reassigned. This is the searchable
                 history of the sky, and it is small.
  snapshots/     a full dsn.xml every --snapshot-every seconds, for --replay.

Storage: the raw feed is ~6.7KB and rewrites every 5s, so logging every poll
would cost ~115MB/day for almost no new information — the timestamps move but
the sky does not. Deduplicating on a signature of the actual radio state cuts
that to a few hundred KB/day.

    nohup ./.venv/bin/python -u record.py > record.log 2>&1 &

Runs detached, survives the terminal, but not a crash and not a process that
stays alive while silently failing to write, the failure mode described
below. Run it under a process supervisor if it needs to stay up unattended.

data/.heartbeat is touched on every successful poll, independent of whether
the sky changed, specifically so a supervisor can tell "alive" from "actually
working." A write failure here (as opposed to a feed fetch failure, which is
routine and retried) is treated as fatal: this process's working directory
was renamed out from under it once already, causing every write to fail
silently for 15+ hours while `ps` still showed it running. Dying loudly on
that class of error is the fix; the heartbeat is the backstop for whatever
this doesn't anticipate.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from farvoices import DSN_URL, fetch, parse_dsn  # noqa: E402

HERE = Path(__file__).resolve().parent
running = True


def signature(links):
    """The radio state, ignoring anything that changes every tick anyway."""
    return frozenset((l.dish, l.spacecraft, l.direction, l.band,
                      round(l.data_rate), round(l.power)) for l in links)


def fleet(links):
    return frozenset(l.spacecraft for l in links)


def dual_carrier(links):
    """Spacecraft running two or more simultaneous downlinks -- a real,
    rare condition (a parallel science and housekeeping carrier, or two
    distinct bands at once), not a parsing artifact. See parse_dsn's MSPA
    dedup for the artifact this is not."""
    counts: dict[str, int] = {}
    for l in links:
        if l.direction == "down":
            counts[l.spacecraft] = counts.get(l.spacecraft, 0) + 1
    return frozenset(sc for sc, n in counts.items() if n >= 2)


def resume(events: Path):
    """The state the previous run ended on, from the last row it wrote.

    Without this every restart began from None: the first row then claimed
    nothing was acquired or lost even when the sky had changed meanwhile, and
    a restart loop rewrote the same sky over and over. Returns the craft set
    and dual-carrier set; the radio signature is left None so the first poll
    is always written (flagged "restart") and a reader can see the seam."""
    try:
        with events.open("rb") as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - 65536))
            last = fh.read().splitlines()[-1]
        rec = json.loads(last)
        dual: dict[str, int] = {}
        for l in rec.get("links", []):
            if l.get("dir") == "down":
                dual[l["sc"]] = dual.get(l["sc"], 0) + 1
        return frozenset(rec["craft"]), frozenset(k for k, v in dual.items() if v >= 2)
    except (OSError, IndexError, ValueError, KeyError):
        return None, None


def stop(*_):
    global running
    running = False


def main():
    ap = argparse.ArgumentParser(description="Record the DSN feed to a searchable history")
    ap.add_argument("--out", default=str(HERE / "data"))
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("--snapshot-every", type=float, default=300.0,
                    help="seconds between full XML snapshots kept for --replay")
    args = ap.parse_args()

    out = Path(args.out)
    (out / "snapshots").mkdir(parents=True, exist_ok=True)
    events = out / "events.jsonl"
    heartbeat = out / ".heartbeat"

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, stop)

    prev_sig = None
    prev_fleet, prev_dual = resume(events)
    restarted = prev_fleet is not None
    bad_polls = 0
    last_snapshot = 0.0
    polls = written = errors = 0
    print(f"  recording -> {out}\n  events: {events}\n", flush=True)

    while running:
        cycle = time.monotonic()

        # Fetching the feed is inherently flaky (network blips, upstream
        # hiccups) and self-corrects on the next poll, so these are logged
        # and retried rather than fatal.
        try:
            raw = fetch(DSN_URL)
            links = parse_dsn(raw)
        except Exception as exc:
            errors += 1
            if errors in (1, 10, 100):
                print(f"  [error] {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            time.sleep(max(0.0, args.interval - (time.monotonic() - cycle)))
            continue

        now = datetime.now(timezone.utc)
        errors = 0

        # Anything else the feed can do to the processing below (a value
        # parse_dsn did not anticipate, as NaN once was) is a bad poll, not
        # a reason to die: dying here meant 11,118 launchd restarts, each
        # one losing the diff state, while the heartbeat -- written before
        # the crash -- told the watchdog all was well. Skip the poll, say so,
        # and leave the heartbeat alone so a persistent fault goes stale and
        # the watchdog sees it.
        try:
            sig, flt, dual = signature(links), fleet(links), dual_carrier(links)
        except Exception as exc:
            bad_polls += 1
            if bad_polls in (1, 10, 100) or bad_polls % 1000 == 0:
                print(f"  {now.isoformat(timespec='seconds')}  [bad poll x{bad_polls}] "
                      f"{type(exc).__name__}: {exc}",
                      file=sys.stderr, flush=True)
            time.sleep(max(0.0, args.interval - (time.monotonic() - cycle)))
            continue
        polls += 1

        # Writing to disk should never fail while the feed itself is fine --
        # if it does, the ground this process is standing on has changed
        # (e.g. its working directory got renamed out from under it, which
        # is exactly what happened on 2026-08-xx: every write silently threw
        # FileNotFoundError for 15+ hours while the process stayed alive per
        # `ps`, because nothing here ever stopped to notice). That is not
        # transient, retrying will not fix it, and the honest response is to
        # die loudly so the process supervisor restarts with paths resolved
        # fresh, rather than limp on producing nothing.
        try:
            if sig != prev_sig:
                acquired = sorted(flt - prev_fleet) if prev_fleet is not None else []
                lost = sorted(prev_fleet - flt) if prev_fleet is not None else []
                dual_on = sorted(dual - prev_dual) if prev_dual is not None else []
                dual_off = sorted(prev_dual - dual) if prev_dual is not None else []
                rec = {
                    "t": now.isoformat(timespec="seconds"),
                    "downlinks": sum(1 for l in links if l.direction == "down"),
                    "craft": sorted(flt),
                    "acquired": acquired,
                    "lost": lost,
                    "dual_on": dual_on,
                    "dual_off": dual_off,
                    "lock_event": bool(acquired or lost or dual_on or dual_off),
                    **({"restart": True} if restarted else {}),
                    "links": [
                        {"station": l.station, "dish": l.dish, "sc": l.spacecraft,
                         "dir": l.direction, "band": l.band,
                         "rate": l.data_rate, "power": l.power}
                        for l in links
                    ],
                }
                with events.open("a") as fh:
                    fh.write(json.dumps(rec) + "\n")
                written += 1
                restarted = False
                if rec["lock_event"]:
                    dual_bit = f"  dual:+{dual_on or '-'}/-{dual_off or '-'}" if (dual_on or dual_off) else ""
                    print(f"  {rec['t']}  LOCK  +{acquired or '-'}  -{lost or '-'}{dual_bit}  "
                          f"({rec['downlinks']} downlinks)", flush=True)
                prev_sig, prev_fleet, prev_dual = sig, flt, dual

            if time.monotonic() - last_snapshot >= args.snapshot_every:
                name = now.strftime("%Y%m%dT%H%M%SZ.xml")
                (out / "snapshots" / name).write_text(raw)
                last_snapshot = time.monotonic()

            # Last, so a fresh heartbeat means a poll went all the way through.
            heartbeat.write_text(now.isoformat(timespec="seconds"))

            if polls % 720 == 0:  # roughly hourly
                print(f"  {now.isoformat(timespec='seconds')}  "
                      f"{polls} polls, {written} events, {errors} errors", flush=True)
        except OSError as exc:
            print(f"  [FATAL] {type(exc).__name__}: {exc} -- filesystem under "
                  f"this process is not what it expects; exiting for the "
                  f"supervisor to restart cleanly", file=sys.stderr, flush=True)
            sys.exit(1)

        time.sleep(max(0.0, args.interval - (time.monotonic() - cycle)))

    print(f"\n  stopped. {polls} polls, {written} events written.", flush=True)


if __name__ == "__main__":
    main()
