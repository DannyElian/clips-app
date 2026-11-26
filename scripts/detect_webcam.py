#!/usr/bin/env python3
"""Detect the streamer webcam overlay from sampled frames (YuNet face + corner bias)."""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "face_detection_yunet_2023mar.onnx")


def make_detector(width: int, height: int):
    if not os.path.isfile(MODEL):
        raise SystemExit(f"Falta el modelo YuNet: {MODEL}")
    detector = cv2.FaceDetectorYN_create(MODEL, "", (width, height), 0.65, 0.3, 5000)
    detector.setInputSize((width, height))
    return detector


def detect_faces(img, detector) -> list[tuple[float, float, float, float, float]]:
    _retval, faces = detector.detect(img)
    if faces is None or len(faces) == 0:
        return []
    h, w = img.shape[:2]
    boxes = []
    for row in faces:
        x, y, fw, fh = [float(v) for v in row[:4]]
        conf = float(row[4]) if len(row) > 4 else 1.0
        boxes.append((x / w, y / h, fw / w, fh / h, conf))
    return boxes


def overlay_score(nx: float, ny: float, nw: float, nh: float) -> float:
    """Prefer a stable PIP cam on any edge/corner over a gameplay face in the center."""
    cx = nx + nw / 2
    cy = ny + nh / 2
    dist_edge = min(cx, 1 - cx, cy, 1 - cy)
    edge_bonus = max(0.0, 0.32 - dist_edge) * 8
    near_h = min(cx, 1 - cx) < 0.3
    near_v = min(cy, 1 - cy) < 0.34
    corner_bonus = 1.6 if near_h and near_v else 0.0
    size_ok = 1.0 if 0.025 <= nw <= 0.5 and 0.03 <= nh <= 0.55 else 0.15
    center_pen = 2.8 if 0.28 < cx < 0.72 and 0.28 < cy < 0.72 else 0.0
    return edge_bonus + corner_bonus + size_ok - center_pen


def position_label(rect: dict) -> str:
    cx = rect["x"] + rect["w"] / 2
    cy = rect["y"] + rect["h"] / 2
    vert = "arriba" if cy < 0.33 else ("abajo" if cy > 0.67 else "")
    horz = "izquierda" if cx < 0.38 else ("derecha" if cx > 0.62 else "")
    if vert and horz:
        return f"{vert}-{horz}"
    return vert or horz or "centro"


def cluster_faces(faces: list[dict]) -> list[dict]:
    buckets: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for face in faces:
        gx = int((face["x"] + face["w"] / 2) * 8)
        gy = int((face["y"] + face["h"] / 2) * 8)
        buckets[(gx, gy)].append(face)
    clusters = []
    for items in buckets.values():
        n = len(items)
        avg = {
            "x": sum(i["x"] for i in items) / n,
            "y": sum(i["y"] for i in items) / n,
            "w": sum(i["w"] for i in items) / n,
            "h": sum(i["h"] for i in items) / n,
            "n": n,
            "conf": sum(i.get("conf", 1) for i in items) / n,
        }
        avg["score"] = (
            avg["n"] * 2.2
            + avg["conf"] * 0.002
            + overlay_score(avg["x"], avg["y"], avg["w"], avg["h"])
        )
        clusters.append(avg)
    clusters.sort(key=lambda c: c["score"], reverse=True)
    return clusters


def face_to_webcam(face: dict) -> dict:
    fx, fy, fw, fh = face["x"], face["y"], face["w"], face["h"]
    cx = fx + fw / 2
    cy = fy + fh / 2
    # Use the full PIP (more pixels). Shift to stay on-frame; do not shrink (that upscales mush).
    aspect = 1080 / 768
    height = float(np.clip(fh * 2.85, 0.24, 0.36))
    width = height * aspect
    if width > 0.34:
        width = 0.34
        height = width / aspect
    x = float(np.clip(cx - width / 2, 0.0, 1.0 - width))
    y = float(np.clip(cy - height * 0.42, 0.0, 1.0 - height))
    focus_x = float(np.clip((cx - x) / max(width, 1e-6), 0.08, 0.92))
    focus_y = float(np.clip((cy - y) / max(height, 1e-6), 0.08, 0.92))
    return {
        "x": round(x, 4),
        "y": round(y, 4),
        "w": round(width, 4),
        "h": round(height, 4),
        "focus": {"x": round(focus_x, 4), "y": round(focus_y, 4)},
    }


def main() -> None:
    paths = [p for p in sys.argv[1:] if os.path.isfile(p)]
    if not paths:
        print(json.dumps({"ok": False, "error": "sin fotogramas"}))
        return

    faces: list[dict] = []
    detector = None
    last_size = None
    for p in paths:
        img = cv2.imread(p)
        if img is None:
            continue
        h, w = img.shape[:2]
        if detector is None or last_size != (w, h):
            detector = make_detector(w, h)
            last_size = (w, h)
        for x, y, fw, fh, conf in detect_faces(img, detector):
            faces.append({"x": x, "y": y, "w": fw, "h": fh, "conf": conf})

    clusters = cluster_faces(faces)
    if not clusters:
        print(json.dumps({"ok": False, "error": "no-face", "faces": 0}))
        return

    best = clusters[0]
    webcam = face_to_webcam(best)
    print(
        json.dumps(
            {
                "ok": True,
                "webcam": webcam,
                "position": position_label(webcam),
                "face": {
                    "x": round(best["x"], 4),
                    "y": round(best["y"], 4),
                    "w": round(best["w"], 4),
                    "h": round(best["h"], 4),
                    "hits": best["n"],
                },
            }
        )
    )


if __name__ == "__main__":
    main()
