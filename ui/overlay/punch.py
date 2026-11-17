#!/usr/bin/env python3
"""
punch.py — turn an AI-generated cockpit PNG into an aligned transparent overlay.

Image models will not give you a usable alpha channel and will not hit exact
cutout geometry. So we let them paint flat black apertures, then cut the holes
here, where the coordinates are ours.

    python3 punch.py --in raw.png --out overlay.png              # fixed geometry
    python3 punch.py --in raw.png --out overlay.png --detect     # snap to the black it drew
    python3 punch.py --in raw.png --out overlay.png --preview    # check alignment

--detect finds the dark apertures the generator actually painted and uses those,
which beats fixed coordinates when the composition came out slightly different.
It prints what it found so you can sanity-check before trusting it.
"""

from __future__ import annotations
import argparse, json, sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 2560, 1440

# Fixed fallback geometry (x, y, w, h) — matches the deck at DPR 2.
FIXED = {
    "window":   (640, 96, 1280, 768),
    "termA":    (224, 1000, 576, 360),
    "termB":    (992, 1000, 576, 360),
    "termC":    (1760, 1000, 576, 360),
}


def fit_cover(im: Image.Image, w: int, h: int) -> Image.Image:
    """Scale to cover w×h then centre-crop. Generators rarely return exact 16:9."""
    im = im.convert("RGB")
    s = max(w / im.width, h / im.height)
    nw, nh = round(im.width * s), round(im.height * s)
    im = im.resize((nw, nh), Image.LANCZOS)
    return im.crop(((nw - w) // 2, (nh - h) // 2, (nw - w) // 2 + w, (nh - h) // 2 + h))


def find_apertures(im: Image.Image, thresh: int = 30, min_area: int = 40_000,
                   max_aspect: float = 3.6):
    """Flood-fill the near-black regions and return plausible aperture boxes.

    Renders carry a lot of dark vignette around the panel, which merges into one
    huge blob as the threshold rises. The discriminator: that blob touches the
    frame edge and real apertures never do. Aspect and area sanity remove the
    rest of the noise."""
    a = np.asarray(im.convert("L"))
    dark = a < thresh
    seen = np.zeros_like(dark, dtype=bool)
    boxes = []
    ys, xs = np.nonzero(dark)
    for sy, sx in zip(ys, xs):
        if seen[sy, sx]:
            continue
        q = deque([(sy, sx)])
        seen[sy, sx] = True
        x0 = x1 = sx
        y0 = y1 = sy
        n = 0
        while q:
            cy, cx = q.popleft()
            n += 1
            x0, x1 = min(x0, cx), max(x1, cx)
            y0, y1 = min(y0, cy), max(y1, cy)
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < dark.shape[0] and 0 <= nx < dark.shape[1] \
                        and dark[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if n < min_area:
            continue
        bw, bh = int(x1 - x0 + 1), int(y1 - y0 + 1)
        H_, W_ = dark.shape
        touches_edge = (x0 <= 1 or y0 <= 1 or x1 >= W_ - 2 or y1 >= H_ - 2)
        aspect = bw / max(1, bh)
        fills = n / float(bw * bh)          # a real aperture is a solid blob
        if touches_edge:                    # vignette / background
            continue
        if not (0.28 < aspect < max_aspect):  # implausibly thin
            continue
        if bw * bh > 0.42 * W_ * H_:        # bigger than any real aperture
            continue
        if fills < 0.55:                    # ragged or hollow -> not a screen
            continue
        boxes.append((int(x0), int(y0), bw, bh, int(n)))
    boxes.sort(key=lambda b: -b[4])
    return [(int(b[0]), int(b[1]), int(b[2]), int(b[3])) for b in boxes]


def assign(boxes, footer=False, mobile=False, generic: bool = False):
    """Largest box is the viewport; the next three, left to right, are terminals.
    A footer strip has just two: the logbook and the ticker. A mobile chest
    unit has a porthole plus two readouts STACKED vertically, so those two are
    ordered by y (top to bottom), not x -- the desktop layouts never needed
    that distinction because their secondary apertures sit in a row."""
    if not boxes:
        return None
    if footer:
        if len(boxes) < 2:
            return None
        two = sorted(boxes[:2], key=lambda b: b[0])
        return {"logbook": two[0], "ticker": two[1]}
    if mobile:
        if len(boxes) < 3:
            return None
        porthole = boxes[0]
        a, b = boxes[1], boxes[2]
        # Don't assume the layout: sort on whichever axis the two readouts
        # actually differ along more. A generated photo may put them side by
        # side (differ in x) or stacked (differ in y), and guessing wrong
        # only matters cosmetically here but is trivial to get right instead.
        axis = 0 if abs(a[0] - b[0]) > abs(a[1] - b[1]) else 1
        pair = sorted([a, b], key=lambda box: box[axis])
        return {"porthole": porthole, "readoutA": pair[0], "readoutB": pair[1]}
    if generic:
        # No fixed schema: hand back everything that passed, named by position
        # left to right. The cockpit path below force-fits exactly four regions
        # into window + three terminals, which is right for the cockpit and
        # wrong for every panel added since -- a tape unit has two reel hubs and
        # two bezels, and pretending the hubs are "terminals" loses which is
        # which. Callers name them properly in the component's own JSON.
        return {f"a{i+1}": b for i, b in enumerate(sorted(boxes, key=lambda b: b[0]))}
    win = boxes[0]
    rest = sorted(boxes[1:4], key=lambda b: b[0])
    if len(rest) < 3:
        return None
    return {"window": win, "termA": rest[0], "termB": rest[1], "termC": rest[2]}


def hexagon(d: ImageDraw.ImageDraw, box, inset: float = 0.14):
    x, y, w, h = box
    c = w * inset
    d.polygon([(x + c, y), (x + w - c, y), (x + w, y + h / 2),
               (x + w - c, y + h), (x + c, y + h), (x, y + h / 2)], fill=0)


def _finish(a, out, geo):
    if a.preview:
        bg = Image.new("RGB", (W, H), (4, 7, 13))
        rng = np.random.default_rng(7)
        px = np.asarray(bg).copy()
        for _ in range(2600):
            sx, sy = rng.integers(0, W), rng.integers(0, H)
            v = int(rng.integers(90, 255))
            px[sy, sx] = (v, v, min(255, v + 18))
        bg = Image.fromarray(px); bg.paste(out, (0, 0), out)
        pv = Path(a.dst).with_name(Path(a.dst).stem + "_preview.png")
        bg.save(pv); print(f"  wrote {pv}  — check the apertures line up")
    ap = {k: [int(x) for x in v] for k, v in geo.items()}
    Path(a.dst).with_suffix(".json").write_text(
        json.dumps({"frame": [W, H], "apertures": ap}, indent=1))
    print(f"  wrote {Path(a.dst).with_suffix('.json')} — feed this to the deck")
    print(f"  const APERTURE = {json.dumps(ap)};")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--in", dest="src", required=True)
    p.add_argument("--out", dest="dst", default="cockpit_overlay.png")
    p.add_argument("--detect", action="store_true",
                   help="snap holes to the dark apertures the generator painted")
    p.add_argument("--shape", choices=["trace", "hex", "rect", "round"], default="trace",
                   help="trace = cut the exact dark pixels the render already contains "
                        "(best; needs --detect). hex/rect/round draw a synthetic shape.")
    p.add_argument("--radius", type=int, default=26, help="corner radius for terminals")
    p.add_argument("--feather", type=float, default=1.6,
                   help="edge softening in px; 0 for a hard cut")
    p.add_argument("--threshold", type=int, default=30, help="--detect darkness cutoff")
    p.add_argument("--preview", action="store_true",
                   help="also write *_preview.png composited over a test starfield")
    p.add_argument("--css", action="store_true", default=True)
    p.add_argument("--footer", action="store_true",
                   help="cut a 2560x420 footer strip with two apertures "
                        "(logbook left, ticker right) instead of the cockpit")
    p.add_argument("--mobile", action="store_true",
                   help="cut a mobile chest-unit bezel: one porthole plus two "
                        "readouts stacked vertically beneath it")
    p.add_argument("--frame", help="override the target frame size as WxH, "
                                   "e.g. 1792x2200; defaults to the source's own "
                                   "aspect when used with --mobile")
    # The two hardcoded modes below assume a component roughly the size of the
    # console or the footer strip. A tape unit's reel hubs are ~65-90 px across
    # (area 3-6k), an order of magnitude under even the footer's 15k floor, so
    # --detect silently skipped them; and its index bezel is aspect ~7.9,
    # comfortably over the 3.6 ceiling that applies outside footer mode. Rather
    # than bolt on a third mode for every new panel, expose the two numbers.
    p.add_argument("--min-area", type=int, default=None,
                   help="smallest region --detect will accept, in pixels "
                        "(default 40000, or 15000 with --footer/--mobile). "
                        "Lower it for small apertures like reel hubs.")
    p.add_argument("--max-aspect", type=float, default=None,
                   help="widest w/h ratio --detect will accept "
                        "(default 3.6, or 14.0 with --footer). Raise it for "
                        "long readout strips.")
    p.add_argument("--generic", action="store_true",
                   help="report every detected region as a1..aN left to right "
                        "instead of forcing them into the cockpit's "
                        "window/termA/termB/termC schema. Use for new panels.")
    p.add_argument("--dump", action="store_true",
                   help="write *_detect.png outlining every region considered")
    p.add_argument("--window", help="force window box as x,y,w,h (in 2560x1440 space)")
    p.add_argument("--terms", help="force the three terminals as x,y,w,h;x,y,w,h;x,y,w,h")
    a = p.parse_args()
    MIN_AREA = a.min_area if a.min_area is not None else (15000 if (a.footer or a.mobile) else 40000)
    MAX_ASPECT = a.max_aspect if a.max_aspect is not None else (14.0 if a.footer else 3.6)

    src = Path(a.src)
    if not src.exists():
        sys.exit(f"no such file: {src}")

    global W, H, FIXED
    if a.footer:
        W, H = 2560, 420
        FIXED = {"logbook": (150, 58, 1000, 304), "ticker": (1258, 172, 1162, 116)}
        if a.dst == "cockpit_overlay.png":
            a.dst = "footer_overlay.png"
    elif a.mobile:
        if a.frame:
            W, H = (int(x) for x in a.frame.lower().split("x"))
        else:
            src_im = Image.open(src)
            W, H = src_im.width * 2, src_im.height * 2
        FIXED = {}
        if a.dst == "cockpit_overlay.png":
            a.dst = "mobile_overlay.png"
        if not a.detect:
            sys.exit("--mobile has no fixed fallback geometry -- pass --detect "
                     "(every generated bezel photo differs, so detection is the "
                     "only path that makes sense here)")
    elif a.frame:
        W, H = (int(x) for x in a.frame.lower().split("x"))

    im = fit_cover(Image.open(src), W, H)

    geo = dict(FIXED)
    if a.detect:
        # Generators rarely paint a true 0,0,0 -- unlit CRTs come out dark grey
        # with a sheen. Escalate the cutoff until four regions appear rather
        # than making the user guess a number.
        found = None
        for t in (a.threshold, 45, 60, 78, 96, 118):
            found = assign(find_apertures(im, t,
                            min_area=MIN_AREA,
                            max_aspect=MAX_ASPECT),
                          footer=a.footer, mobile=a.mobile, generic=a.generic)
            if found:
                if t != a.threshold:
                    print(f"  (threshold {a.threshold} found too few regions; used {t})")
                a.threshold = t
                break
        if a.dump:
            dbg = im.convert("RGB").copy()
            dd = ImageDraw.Draw(dbg)
            for (bx, by, bw2, bh2) in find_apertures(im, a.threshold,
                    min_area=MIN_AREA,
                    max_aspect=MAX_ASPECT):
                dd.rectangle([bx, by, bx + bw2, by + bh2], outline=(255, 40, 200), width=6)
            dp = Path(a.dst).with_name(Path(a.dst).stem + "_detect.png")
            dbg.save(dp)
            print(f"  wrote {dp} — every region the detector accepted")
        if found:
            geo = found
            print("  detected apertures:")
            for k, v in geo.items():
                print(f"    {k:<8} x={v[0]:<5} y={v[1]:<5} w={v[2]:<5} h={v[3]}")
        else:
            print("  detection found too few dark regions — using fixed geometry.")
            print("  (check the render actually has 4 flat-black apertures)")

    if a.window:
        geo["window"] = tuple(int(v) for v in a.window.split(","))
    if a.terms:
        for k, part in zip(("termA", "termB", "termC"), a.terms.split(";")):
            geo[k] = tuple(int(v) for v in part.split(","))
    if a.window or a.terms:
        print("  using manual geometry override")

    # Build the alpha mask: opaque everywhere, transparent in the apertures.
    if a.shape == "trace":
        # The render already contains the exact aperture outline -- hexagon,
        # rounded rect, whatever the generator drew. Assuming a shape only
        # introduces mismatch at the corners, so cut the real pixels instead.
        lum = np.asarray(im.convert("L"))
        m = np.where(lum < a.threshold, 0, 255).astype(np.uint8)
        mask = Image.fromarray(m, "L")
        # drop stray dark speckle that isn't one of the apertures
        keep = Image.new("L", (W, H), 0)
        kd = ImageDraw.Draw(keep)
        for k in geo:
            x, y, w_, h_ = geo[k]
            kd.rectangle([x - 6, y - 6, x + w_ + 6, y + h_ + 6], fill=255)
        mask = Image.fromarray(np.where(np.asarray(keep) > 0,
                                        np.asarray(mask), 255).astype(np.uint8), "L")
        if a.feather > 0:
            mask = mask.filter(ImageFilter.GaussianBlur(a.feather))
        out = im.convert("RGBA"); out.putalpha(mask); out.save(a.dst)
        clear = int((np.asarray(mask) < 128).sum())
        print(f"\n  wrote {a.dst}  (traced, {clear/(W*H)*100:.1f}% transparent)")
        _finish(a, out, geo)
        return

    mask = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(mask)
    if a.generic:
        # Every region gets the same treatment; a reel hub is a circle and a
        # bezel is a rounded rectangle, so pick per region by how square it is.
        for k, (x, y, w, h) in geo.items():
            if abs(w - h) <= max(w, h) * 0.2:
                d.ellipse([x, y, x + w, y + h], fill=0)
            else:
                d.rounded_rectangle([x, y, x + w, y + h], radius=a.radius, fill=0)
        _cut_and_save(a, im, mask, W, H, geo)
        return

    win = geo["window"]
    if a.shape == "hex":
        hexagon(d, win)
    elif a.shape == "round":
        d.rounded_rectangle([win[0], win[1], win[0] + win[2], win[1] + win[3]],
                            radius=a.radius * 2, fill=0)
    else:
        d.rectangle([win[0], win[1], win[0] + win[2], win[1] + win[3]], fill=0)
    for k in [k for k in ("termA", "termB", "termC") if k in geo]:
        x, y, w, h = geo[k]
        d.rounded_rectangle([x, y, x + w, y + h], radius=a.radius, fill=0)

    _cut_and_save(a, im, mask, W, H, geo)


def _cut_and_save(a, im, mask, W, H, geo):
    if a.feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(a.feather))

    out = im.convert("RGBA")
    out.putalpha(mask)
    out.save(a.dst)
    clear = int((np.asarray(mask) < 128).sum())
    print(f"\n  wrote {a.dst}  ({W}x{H}, {clear/ (W*H) * 100:.1f}% transparent)")

    if a.preview:
        bg = Image.new("RGB", (W, H), (4, 7, 13))
        rng = np.random.default_rng(7)
        px = np.asarray(bg).copy()
        for _ in range(2600):                      # stand-in starfield
            sx, sy = rng.integers(0, W), rng.integers(0, H)
            v = int(rng.integers(90, 255))
            px[sy, sx] = (v, v, min(255, v + 18))
        bg = Image.fromarray(px)
        bg.paste(out, (0, 0), out)
        pv = Path(a.dst).with_name(Path(a.dst).stem + "_preview.png")
        bg.save(pv)
        print(f"  wrote {pv}  — check the apertures line up before wiring it in")

    if a.css:
        w = max(geo.values(), key=lambda box: box[2] * box[3])  # largest = the main viewport
        print("\n  --- drop into deck.html ---")
        print("""  <img id="bezel" src="cockpit_overlay.png" alt="">
  <style>
  #bezel{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;
         z-index:6;pointer-events:none}
  /* keep the sky centred inside the viewport aperture */
  #sky{z-index:0}
  </style>""")
        print(f"  // aperture centre, as a fraction of the frame — feed to drawSky()")
        ap = {k: [int(x) for x in v] for k, v in geo.items()}
        Path(a.dst).with_suffix(".json").write_text(json.dumps({"frame":[W,H],"apertures":ap}, indent=1))
        print(f"  const APERTURE = {json.dumps(ap)};")
        print(f"  wrote {Path(a.dst).with_suffix('.json')} — feed this to the deck")
        print(f"  // viewport centre: {(w[0]+w[2]/2)/W:.4f}, {(w[1]+w[3]/2)/H:.4f}")


if __name__ == "__main__":
    main()
