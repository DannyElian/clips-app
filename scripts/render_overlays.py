#!/usr/bin/env python3
"""Compact TikTok-style title + caption PNGs (small files, cheap ffmpeg overlay)."""
from __future__ import annotations

import json
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

FONTS_TITLE = [
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/Library/Fonts/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]
FONTS_CAP = [
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/Library/Fonts/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]


def load_font(paths: list[str], size: int) -> ImageFont.FreeTypeFont:
    for p in paths:
        if os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def wrap(text: str, font, draw: ImageDraw.ImageDraw, max_w: int, max_lines: int) -> list[str]:
    words = text.replace("\n", " ").split()
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = (cur + " " + w).strip()
        bbox = draw.textbbox((0, 0), trial, font=font)
        if bbox[2] - bbox[0] <= max_w:
            cur = trial
            continue
        if cur:
            lines.append(cur)
        cur = w
        if len(lines) >= max_lines:
            break
    if cur and len(lines) < max_lines:
        lines.append(cur)
    return lines[:max_lines]


def draw_outlined(draw, xy, text, font, fill, outline, width=6):
    x, y = xy
    for dx in range(-width, width + 1):
        for dy in range(-width, width + 1):
            if dx * dx + dy * dy > width * width:
                continue
            if dx == 0 and dy == 0:
                continue
            draw.text((x + dx, y + dy), text, font=font, fill=outline)
    draw.text((x, y), text, font=font, fill=fill)


def parse_srt(path: str) -> list[dict]:
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        return []
    raw = open(path, encoding="utf-8").read().strip()
    blocks = re.split(r"\n\s*\n", raw)
    stamp = re.compile(
        r"(\d+):(\d+):(\d+)[,.](\d+)\s+-->\s+(\d+):(\d+):(\d+)[,.](\d+)"
    )

    def to_sec(h, m, s, ms):
        return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")[:3]) / 1000

    cues = []
    for block in blocks:
        m = stamp.search(block)
        if not m:
            continue
        start = to_sec(*m.group(1, 2, 3, 4))
        end = to_sec(*m.group(5, 6, 7, 8))
        lines = [ln for ln in block.splitlines() if ln and not ln.strip().isdigit() and "-->" not in ln]
        text = " ".join(lines).strip()
        if text:
            cues.append({"start": start, "end": end, "text": text})
    return cues


def text_block(lines, font, fill, stroke, pad_x, pad_y, gap, pill=False, pill_fill=(0, 0, 0, 175)):
    dummy = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    d0 = ImageDraw.Draw(dummy)
    widths, heights = [], []
    for line in lines:
        b = d0.textbbox((0, 0), line, font=font)
        widths.append(b[2] - b[0])
        heights.append(b[3] - b[1])
    w = max(widths) + pad_x * 2
    h = sum(heights) + gap * (len(lines) - 1) + pad_y * 2
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if pill:
        draw.rounded_rectangle((0, 0, w - 1, h - 1), radius=min(28, h // 2), fill=pill_fill)
    y = pad_y
    for line, tw, th in zip(lines, widths, heights):
        x = (w - tw) // 2
        draw_outlined(draw, (x, y), line, font, fill, (0, 0, 0, 255), stroke)
        y += th + gap
    return img


def main() -> None:
    if len(sys.argv) < 6:
        print(json.dumps({"ok": False, "error": "args"}))
        sys.exit(1)
    out_dir, w_s, h_s, title, srt = sys.argv[1:6]
    w, h = int(w_s), int(h_s)
    os.makedirs(out_dir, exist_ok=True)

    dummy = Image.new("RGBA", (4, 4), (0, 0, 0, 0))
    d0 = ImageDraw.Draw(dummy)
    title_font = load_font(FONTS_TITLE, max(42, w // 11))
    cap_font = load_font(FONTS_CAP, max(30, w // 16))
    overlays = []

    raw_title = title.replace("\\n", "\n").strip()
    if raw_title:
        tlines = [ln.strip() for ln in raw_title.split("\n") if ln.strip()][:2]
        if not tlines:
            tlines = wrap(raw_title, title_font, d0, int(w * 0.9), 2)
        timg = text_block(
            tlines,
            title_font,
            (255, 255, 255, 255),
            6,
            pad_x=18,
            pad_y=10,
            gap=int(title_font.size * 0.12),
            pill=False,
        )
        tpath = os.path.join(out_dir, "titulo.png")
        timg.save(tpath, optimize=True)
        overlays.append(
            {
                "file": tpath,
                "x": max(0, (w - timg.width) // 2),
                "y": int(h * 0.04),
                "start": 0,
                "end": 1e9,
                "kind": "title",
            }
        )

    yellow = (255, 230, 0, 255)
    for i, cue in enumerate((parse_srt(srt) if srt not in ("", "-") else [])[:5]):
        cap = cue["text"].upper()
        lines = wrap(cap, cap_font, d0, int(w * 0.86), 2)
        if not lines:
            continue
        cimg = text_block(
            lines,
            cap_font,
            yellow,
            5,
            pad_x=26,
            pad_y=14,
            gap=int(cap_font.size * 0.1),
            pill=True,
            pill_fill=(0, 0, 0, 200),
        )
        cpath = os.path.join(out_dir, f"sub-{i:03d}.png")
        cimg.save(cpath, optimize=True)
        overlays.append(
            {
                "file": cpath,
                "x": max(0, (w - cimg.width) // 2),
                "y": h - cimg.height - int(h * 0.07),
                "start": float(cue["start"]),
                "end": float(cue["end"]),
                "kind": "sub",
            }
        )

    print(json.dumps({"ok": True, "overlays": overlays}, ensure_ascii=False))


if __name__ == "__main__":
    main()
