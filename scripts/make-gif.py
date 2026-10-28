"""Turn frames from record-demo.mjs into the README GIF.

    python3 scripts/make-gif.py /tmp/showme-frames docs/demo.gif [--width 960] [--max-hold 0.7]

Keeps real timing for what happens on the ERPNext page (cursor, typing, forms), plays changes that are only
inside a strip on the right (e.g. a chat panel; off by default) faster, and caps how long an unchanged screen is held.
Needs Pillow.
"""

import argparse
import json
import pathlib

from PIL import Image, ImageChops

ap = argparse.ArgumentParser()
ap.add_argument("frames")
ap.add_argument("out")
ap.add_argument("--width", type=int, default=960)
ap.add_argument("--max-hold", type=float, default=0.7, help="seconds an unchanged screen is shown at most")
ap.add_argument("--fps", type=float, default=10, help="upper bound on frames per second")
ap.add_argument("--sidebar-speed", type=float, default=3, help="speed-up for changes only inside that strip")
ap.add_argument("--sidebar-px", type=int, default=0, help="width of that strip in the recording's pixels (0 = off)")
args = ap.parse_args()

meta = json.loads((pathlib.Path(args.frames) / "frames.json").read_text())
meta_width = Image.open(meta[0]["file"]).width
frames, durations = [], []
prev_small, last_t, speed = None, None, 1.0
for i, f in enumerate(meta):
    img = Image.open(f["file"]).convert("RGB")
    img = img.resize((args.width, round(img.height * args.width / img.width)), Image.LANCZOS)
    small = img.resize((160, round(img.height * 160 / img.width)))
    t = f["t"] / 1000
    nxt = meta[i + 1]["t"] / 1000 if i + 1 < len(meta) else t + 1.5
    dur = nxt - t  # real gap to the next captured frame; the fps cap applies to kept frames below
    if prev_small is not None and not ImageChops.difference(small, prev_small).getbbox():
        durations[-1] = min(durations[-1] + dur, args.max_hold)  # identical: extend previous, capped
        continue
    if frames and t - last_t < 1 / args.fps:
        durations[-1] += dur * speed  # too close to the previous kept frame
        continue
    # Where did it change? Only inside the sidebar = waiting/streaming: play it faster.
    if prev_small is not None:
        box = ImageChops.difference(small, prev_small).getbbox()
        sidebar_x = small.width * (1 - args.sidebar_px / meta_width)
        speed = 1 / args.sidebar_speed if box and box[0] >= sidebar_x else 1.0
        dur *= speed
    else:
        speed = 1.0
    frames.append(img)
    durations.append(dur)
    prev_small, last_t = small, t
durations[-1] = 2.5  # hold the result

# One shared palette keeps colours stable across frames and the file small.
palette_src = frames[len(frames) // 2].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
pal = [im.quantize(palette=palette_src, dither=Image.Dither.NONE) for im in frames]
pal[0].save(args.out, save_all=True, append_images=pal[1:], duration=[round(d * 1000) for d in durations], loop=0, optimize=True, disposal=1)
size = pathlib.Path(args.out).stat().st_size
print(f"{len(pal)} frames, {sum(durations):.1f}s, {size / 1e6:.1f} MB -> {args.out}")
