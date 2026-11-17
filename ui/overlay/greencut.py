#!/usr/bin/env python3
"""greencut.py -- cut a chroma-green generator image to a transparent WebP.

punch.py handles full console strips, where the live areas are painted flat
black and keyed on darkness. Small parts -- switch panels, gauges, sprites,
overlays -- come back from the generator on a flat green field instead, because
a small object has no console around it to punch out of.

    python3 ui/overlay/greencut.py --in raw_cw_panel.png --out cw_panel.webp
    python3 ui/overlay/greencut.py --in raw_frost.png --out frost.webp --soft

What it does, in order:

  1. keys every pixel close to the green in hue and saturation, with a soft
     edge band so the cut does not alias;
  2. despills -- green light bounces off bright metal and leaves a lime fringe
     that is obvious the moment the part sits on a warm console, so any pixel
     whose green exceeds both its red and blue is pulled back toward the mean
     of those two;
  3. trims the fully transparent border and reports the crop, since the box it
     prints is what the deck's layout code needs;
  4. optionally punches any flat-black region to transparent as well (--black),
     for parts that carry a live readout inside the green.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

# The generator is asked for #00B140. Real output drifts, so the key is a
# distance in RGB space rather than an exact match.
KEY = (0x00, 0xB1, 0x40)


def cut(im: Image.Image, lo: int, hi: int, black: int | None):
    """Key, feather and despill in one vectorised pass.

    The key is GREEN EXCESS -- how much the green channel beats the brighter of
    red and blue -- not distance to the key colour. Distance is the obvious
    choice and it is wrong: the key is a mid-dark green, so every dark pixel in
    the picture sits close to it, and a black whale or an unlit lamp bezel comes
    out half transparent. Green excess is near zero for anything neutral at any
    brightness, and large only for something actually green.
    """
    a = np.asarray(im, dtype=np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    alpha = a[..., 3].astype(np.float32)

    ex = g - np.maximum(r, b)                       # green excess
    alpha[ex >= hi] = 0.0
    edge = (ex > lo) & (ex < hi)
    alpha[edge] *= (hi - ex[edge]) / float(hi - lo)

    if black is not None:
        alpha[np.maximum(np.maximum(r, g), b) <= black] = 0.0

    # Despill: green light bounces off bright metal and leaves a lime fringe,
    # obvious the moment the part sits on a warm console.
    spill = ex > 0
    mean = ((r + b) // 2).astype(np.int16)
    g_new = g.copy()
    g_new[spill] = mean[spill] + (g[spill] - mean[spill]) // 4

    out = np.dstack([r, g_new, b, np.clip(alpha, 0, 255)]).astype(np.uint8)
    return Image.fromarray(out, "RGBA"), int((ex >= hi).sum()), int(spill.sum())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="dst", required=True)
    ap.add_argument("--lo", type=int, default=12, help="green excess below this is fully kept")
    ap.add_argument("--hi", type=int, default=70, help="green excess above this is fully cut")
    # Measured: the generator's green field lands at a green excess of 80-100,
    # and real console metal never exceeds about 10, so 70 is a wide, safe gate.
    ap.add_argument("--soft", action="store_true", help="wider feather, for frost and other haze")
    ap.add_argument("--black", type=int, default=None,
                    help="also cut pixels darker than this (a live readout inside the part)")
    ap.add_argument("--no-trim", action="store_true")
    ap.add_argument("--quality", type=int, default=92)
    a = ap.parse_args()

    im = Image.open(a.src).convert("RGBA")
    w, h = im.size
    lo, hi = (4, a.hi) if a.soft else (a.lo, a.hi)
    im, keyed, spill = cut(im, lo, hi, a.black)

    box = None
    if not a.no_trim:
        box = im.getbbox()
        if box:
            im = im.crop(box)

    out = Path(a.dst)
    im.save(out, "WEBP", quality=a.quality, method=6)
    print(f"{out.name:22} {im.size[0]:5}x{im.size[1]:<5} keyed {keyed/1000:7.0f}k  despilled {spill/1000:6.0f}k"
          + (f"  crop {box}" if box and box != (0, 0, w, h) else ""))


if __name__ == "__main__":
    main()
