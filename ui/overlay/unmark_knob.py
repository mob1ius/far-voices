#!/usr/bin/env python3
"""
unmark_knob.py -- erase the two painted index marks from the ROTARY knob.

Run AFTER punch.py, on its output:

    ./.venv/bin/python ui/overlay/unmark_knob.py ui/overlay/tape_overlay.png

The tape unit's far-right control is a dual-concentric knob: an inner knob
with its own mark and an outer ring with a separate one. That is a real
control shape, so the deck drives it as one -- inner and outer each set a
rotor of the rotary effect. For the marks to *indicate* anything they have to
move, and a mark baked into the bitmap cannot.

Rotating a cut-out sprite of the knob was the other option and was rejected:
at the size this renders (the strip is ~1040px wide for a 2560px frame, so
the knob lands near 29px across) the mark is barely two pixels wide, and
resampling it every frame turns it to mush -- while rotating the whole disc
also spins its specular highlight, which reads as the light source turning
rather than the knob. So the artwork keeps its static shading and its
surrounding tick ring as the printed scale, and the deck draws both marks
itself as crisp vector strokes on top.

The erase samples replacement colour from the same radius, rotated to either
side, and averages the two. Sampling at the same radius preserves the knob's
radial shading (dark face, lit knurled ring, shadowed edge); taking both
sides and averaging keeps the left-lit/right-shadowed gradient roughly
continuous across the patch instead of stamping one side's tone across the
seam.

The two marks are described differently on purpose, because they are drawn
differently. The outer ring's mark really is a radial wedge. The inner knob's
is a straight vertical stroke sitting about two pixels right of centre -- so
its angle sweeps from ~5 degrees at the tip to over 100 near the hub, and a
wedge fitted to it either misses the ends or eats half the knob face. It is
specified as the rectangle it actually is, found by thresholding rather than
read off a zoom.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageFilter

# Measured off the artwork, not eyeballed: the knob's dark body thresholds to
# a clean 89x89 bounding box, giving both centre and radius directly.
CX, CY = 2441.5, 197.5
# Outer ring's mark: (angle from 12 o'clock, inner radius, outer radius, half-width).
RING_MARK = (32.5, 23.0, 40.0, 7.0)
# Inner knob's mark, as an image-space box (x0, y0, x1, y1), inclusive.
INNER_MARK = (2440, 176, 2448, 202)
SAMPLE_OFFSET = 28.0
SAMPLE_ARC = 8.0            # keep the sample at least this many px off the mark


def polar(cx: float, cy: float, r: float, deg: float) -> tuple[int, int]:
    """Screen-polar: 0 degrees is 12 o'clock, angles increase clockwise."""
    th = math.radians(deg)
    return int(round(cx + r * math.sin(th))), int(round(cy - r * math.cos(th)))


def sample(px, x: int, y: int) -> tuple[int, int, int, int]:
    """Replacement colour for one mark pixel: same radius, rotated both ways.

    Near the hub a fixed angular offset barely moves the sample point, so it
    would land back on the mark and copy it. Widen the offset as the radius
    shrinks to keep a real gap, capped at a quarter turn.
    """
    dx, dy = x - CX, y - CY
    r = math.hypot(dx, dy)
    a = math.degrees(math.atan2(dx, -dy))
    off = SAMPLE_OFFSET if r <= 0 else min(90.0, max(SAMPLE_OFFSET,
                                                     math.degrees(SAMPLE_ARC / r)))
    acc = [0, 0, 0]
    for side in (-off, off):
        s = px[polar(CX, CY, r, a + side)]
        for c in range(3):
            acc[c] += s[c]
    return (acc[0] // 2, acc[1] // 2, acc[2] // 2, px[x, y][3])


def erase(im: Image.Image) -> int:
    px = im.load()
    w, h = im.size
    targets = set()

    ang, r0, r1, half = RING_MARK
    steps = int((r1 - r0) * 2) + 1
    for i in range(steps):
        r = r0 + i * 0.5
        span = max(1, int(2 * half * max(1.0, r) / 3))
        for j in range(span + 1):
            d = ang - half + (2 * half) * (j / span if span else 0.5)
            targets.add(polar(CX, CY, r, d))

    x0, y0, x1, y1 = INNER_MARK
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            targets.add((x, y))

    targets = {(x, y) for (x, y) in targets if 0 <= x < w and 0 <= y < h}
    patch = {p: sample(px, *p) for p in targets}
    for (x, y), v in patch.items():
        px[x, y] = v

    # The averaged patch is flat where the original had film grain. Blur a
    # generous box around the knob and blend only the patched pixels back,
    # which softens the seam without touching a pixel outside the erase.
    box = (int(CX - 48), int(CY - 48), int(CX + 48), int(CY + 48))
    region = im.crop(box)
    blurred = region.filter(ImageFilter.GaussianBlur(1.1))
    bp = blurred.load()
    for (x, y) in patch:
        if box[0] <= x < box[2] and box[1] <= y < box[3]:
            px[x, y] = bp[x - box[0], y - box[1]]
    return len(patch)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path = Path(sys.argv[1])
    im = Image.open(path).convert("RGBA")
    n = erase(im)
    im.save(path)
    print(f"  erased {n} px of painted index mark -> {path}")


if __name__ == "__main__":
    main()
