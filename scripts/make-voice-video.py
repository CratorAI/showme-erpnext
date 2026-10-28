"""Assemble a voice demo recorded with scripts/record-voice-demo.mjs into an MP4.

    python3 scripts/make-voice-video.py /tmp/showme-voice docs/voice-demo.mp4 [--avatar line1.webm --avatar line2.webm]

Frames are laid out at their real timestamps (constant 30 fps output), the recorded audio (the spoken lines plus
ShowMe's voice) starts at its real offset, and each optional --avatar video (e.g. a transparent .webm of the person
saying that line) is overlaid bottom-right while its line plays. Needs ffmpeg with libvpx-vp9 for alpha .webm.
"""
import argparse
import json
import os
import subprocess
import tempfile

ap = argparse.ArgumentParser()
ap.add_argument("rec")
ap.add_argument("out")
ap.add_argument("--avatar", action="append", default=[], help="one per line, in order")
ap.add_argument("--avatar-height", type=int, default=330)
ap.add_argument("--avatar-crop", default="1100:1080:410:0", help="ffmpeg crop w:h:x:y applied to each avatar first ('' = none)")
ap.add_argument("--width", type=int, default=1440)
args = ap.parse_args()

frames = json.load(open(os.path.join(args.rec, "frames.json")))
timeline = json.load(open(os.path.join(args.rec, "timeline.json")))

# Concat list: each frame held until the next one's timestamp.
fd, lst = tempfile.mkstemp(suffix=".txt")
with os.fdopen(fd, "w") as f:
    for a, b in zip(frames, frames[1:] + [None]):
        f.write(f"file '{os.path.join(args.rec, 'frames', a['file'])}'\n")
        f.write(f"duration {((b['t'] if b else a['t'] + 500) - a['t']) / 1000:.3f}\n")
    f.write(f"file '{os.path.join(args.rec, 'frames', frames[-1]['file'])}'\n")

cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
       "-f", "concat", "-safe", "0", "-i", lst,
       "-itsoffset", f"{timeline['audioAt'] / 1000:.3f}", "-i", os.path.join(args.rec, "audio.webm")]
for av in args.avatar:
    cmd += ["-c:v", "libvpx-vp9", "-i", av]  # libvpx keeps the alpha channel

graph = [f"[0:v]fps=30,scale={args.width}:-2:flags=lanczos,format=yuv420p[base]"]
last = "base"
for i, (av, line) in enumerate(zip(args.avatar, timeline["lines"])):
    at = line["at"] / 1000
    dur = line["ms"] / 1000
    crop = f"crop={args.avatar_crop}," if args.avatar_crop else ""
    graph.append(
        f"[{i + 2}:v]{crop}scale=-2:{args.avatar_height},format=yuva420p,"
        f"fade=in:st=0:d=0.25:alpha=1,fade=out:st={max(dur - 0.3, 0.3):.2f}:d=0.3:alpha=1,"
        f"setpts=PTS-STARTPTS+{at:.3f}/TB[a{i}]")
    graph.append(f"[{last}][a{i}]overlay=x=W-w-28:y=H-h:eof_action=pass:format=auto[v{i}]")
    last = f"v{i}"

cmd += ["-filter_complex", ";".join(graph), "-map", f"[{last}]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "128k", "-shortest", args.out]
subprocess.run(cmd, check=True)
os.remove(lst)
print("->", args.out, f"{os.path.getsize(args.out) / 1e6:.1f} MB")
