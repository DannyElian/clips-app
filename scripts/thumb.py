#!/usr/bin/env python3
"""Frame + title on a canvas that is never larger than the source frame."""
from __future__ import annotations

import sys
from PIL import Image, ImageDraw, ImageFont

src, out, font_path, tw, th, title, kind = sys.argv[1:8]
target_w, target_h = int(tw), int(th)
frame = Image.open(src).convert("RGB")
scale = min(target_w / frame.width, target_h / frame.height, 1)
nw, nh = max(2, int(frame.width * scale)), max(2, int(frame.height * scale))
frame = frame.resize((nw, nh), Image.Resampling.LANCZOS)
canvas = Image.new("RGB", (nw if kind == "fit" else max(nw, min(target_w, frame.width)), nh if kind == "fit" else max(nh, min(target_h, frame.height))), (12, 10, 18))
# Keep the canvas at the fitted frame size so we never upscale.
canvas = Image.new("RGB", (nw, nh), (12, 10, 18))
canvas.paste(frame, (0, 0))
if title.strip():
    draw = ImageDraw.Draw(canvas)
    size = max(28, int(nh * 0.08))
    font = ImageFont.truetype(font_path, size)
    words = title.strip().split()
    lines: list[str] = []
    cur = ""
    for word in words:
        trial = (cur + " " + word).strip()
        if draw.textlength(trial, font=font) < nw * 0.86:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = word
        if len(lines) == 2:
            break
    if cur and len(lines) < 3:
        lines.append(cur)
    y = int(nh * 0.72)
    for line in lines[:3]:
        box = draw.textbbox((0, 0), line, font=font, stroke_width=4)
        x = (nw - (box[2] - box[0])) / 2
        draw.text((x, y), line, font=font, fill=(255, 255, 255), stroke_width=4, stroke_fill=(0, 0, 0))
        y += size + 8
if out.lower().endswith(".jpg") or out.lower().endswith(".jpeg"):
    canvas.save(out, quality=95)
else:
    canvas.save(out)
