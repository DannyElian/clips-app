#!/usr/bin/env python3
"""Transparent PNG with outlined text. This ffmpeg has no drawtext."""
from __future__ import annotations

import os
import sys
from PIL import Image, ImageDraw, ImageFont


def pad_directory(folder: str, align: str) -> None:
    names = sorted((name for name in os.listdir(folder) if name.endswith(".png") and name[:-4].isdigit()), key=lambda name: int(name[:-4]))
    images = [Image.open(os.path.join(folder, name)).convert("RGBA") for name in names]
    if not images:
        return
    width = images[0].width
    height = max(image.height for image in images)
    for name, image in zip(names, images):
        canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        if align == "top":
            top = 0
        elif align == "middle":
            top = max(0, (height - image.height) // 2)
        else:
            top = max(0, height - image.height)
        canvas.paste(image, (0, top), image)
        canvas.save(os.path.join(folder, name))
    Image.new("RGBA", (width, height), (0, 0, 0, 0)).save(os.path.join(folder, "blank.png"))


def text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, stroke: int) -> int:
    box = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
    return box[2] - box[0]


def wrap_lines(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.ImageFont,
    stroke: int,
    max_w: int,
    max_lines: int,
) -> list[str]:
    words = text.replace("\n", " ").split()
    if not words:
        return []
    lines: list[str] = []
    cur = ""
    for word in words:
        trial = f"{cur} {word}".strip()
        if not cur or text_width(draw, trial, font, stroke) <= max_w:
            cur = trial
            continue
        lines.append(cur)
        cur = word
        if len(lines) >= max_lines:
            break
    if cur and len(lines) < max_lines:
        lines.append(cur)
    elif cur and lines:
        lines[-1] = f"{lines[-1]} {cur}".strip()
    return lines[:max_lines]


def parse_color(raw: str) -> tuple[int, int, int, int]:
    raw = raw.strip().lstrip("#")
    if len(raw) != 6:
        return (255, 255, 255, 255)
    return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16), 255)


def main() -> None:
    out_path, font_path, width_s, text_path = sys.argv[1:5]
    role = sys.argv[5] if len(sys.argv) > 5 else "overlay"
    look = sys.argv[6] if len(sys.argv) > 6 else "frase"
    color = parse_color(sys.argv[7] if len(sys.argv) > 7 else "#ffffff")
    try:
        scale = float(sys.argv[8]) if len(sys.argv) > 8 else 1.0
    except ValueError:
        scale = 1.0
    scale = min(1.6, max(0.7, scale))
    width = int(width_s)
    text = open(text_path, encoding="utf-8").read().strip()
    if not text:
        raise SystemExit("empty overlay")

    margin = int(width * (0.12 if role == "sub" else 0.14))
    max_w = max(40, width - margin * 2)
    max_lines = 2
    start = max(18, int(width * (0.031 if role == "sub" else 0.044) * scale))
    if look == "palabra":
        start = int(start * 1.12)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    size = start
    font = ImageFont.truetype(font_path, size)
    stroke = 1 if look == "barra" else max(2, size // 14)
    preset = [ln.strip() for ln in text.splitlines() if ln.strip()]
    lines = preset[:max_lines] if len(preset) > 1 else wrap_lines(probe, text, font, stroke, max_w, max_lines)
    while size > 16 and any(text_width(probe, ln, font, stroke) > max_w for ln in lines):
        size -= 2
        font = ImageFont.truetype(font_path, size)
        stroke = 1 if look == "barra" else max(2, size // 14)
        if len(preset) <= 1:
            lines = wrap_lines(probe, text, font, stroke, max_w, max_lines)
    if not lines:
        raise SystemExit("empty overlay")

    boxes = [probe.textbbox((0, 0), ln, font=font, stroke_width=stroke) for ln in lines]
    heights = [b[3] - b[1] for b in boxes]
    spacing = int(size * 0.16)
    line_h = max(heights) + spacing
    hi = -1
    if len(sys.argv) > 9 and sys.argv[9] not in ("", "-1"):
        try:
            hi = int(sys.argv[9])
        except ValueError:
            hi = -1
    y = int(size * 0.45)
    img_h = int(y + line_h * max(1, len(lines)) + size * 0.55)
    img = Image.new("RGBA", (width, max(8, img_h)), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if look == "palabra":
        tokens = text.replace("\n", " ").split()
        if not tokens:
            raise SystemExit("empty overlay")
        gap = int(size * 0.32)
        token_boxes = [probe.textbbox((0, 0), token, font=font, stroke_width=stroke) for token in tokens]
        token_w = [box[2] - box[0] for box in token_boxes]
        total = sum(token_w) + gap * max(0, len(tokens) - 1)
        while total > max_w and size > 16:
            size -= 2
            font = ImageFont.truetype(font_path, size)
            stroke = max(2, size // 14)
            gap = int(size * 0.32)
            token_boxes = [probe.textbbox((0, 0), token, font=font, stroke_width=stroke) for token in tokens]
            token_w = [box[2] - box[0] for box in token_boxes]
            total = sum(token_w) + gap * max(0, len(tokens) - 1)
        x = (width - total) / 2
        base_y = int(size * 0.55)
        for i, token in enumerate(tokens):
            box = token_boxes[i]
            tw = token_w[i]
            th = box[3] - box[1]
            if i == hi:
                pad_x = int(size * 0.22)
                pad_y = int(size * 0.08)
                draw.rounded_rectangle(
                    (x - pad_x, base_y - pad_y, x + tw + pad_x, base_y + th + pad_y),
                    radius=int(size * 0.28),
                    fill=color,
                )
                draw.text((x - box[0], base_y - box[1]), token, font=font, fill=(20, 20, 20, 255))
            else:
                draw.text(
                    (x - box[0], base_y - box[1]),
                    token,
                    font=font,
                    fill=(255, 255, 255, 255),
                    stroke_width=stroke,
                    stroke_fill=(0, 0, 0, 230),
                )
            x += tw + gap
        img.save(out_path)
        return
    if look == "barra":
        block_w = max(box[2] - box[0] for box in boxes)
        pad_x = int(size * 0.7)
        pad_y = int(size * 0.28)
        left = (width - block_w) / 2 - pad_x
        top = y - pad_y
        draw.rounded_rectangle(
            (left, top, left + block_w + pad_x * 2, y + line_h * len(lines) + pad_y * 0.2),
            radius=int(size * 0.42),
            fill=color,
        )
        ink = (20, 20, 20, 255)
        stroke = 0
    else:
        ink = color
    for ln, box in zip(lines, boxes):
        tw = box[2] - box[0]
        x = (width - tw) / 2 - box[0]
        draw.text(
            (x, y - box[1]),
            ln,
            font=font,
            fill=ink,
            stroke_width=stroke,
            stroke_fill=(0, 0, 0, 230),
        )
        y += line_h
    img.save(out_path)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--pad":
        pad_directory(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "bottom")
    else:
        main()
