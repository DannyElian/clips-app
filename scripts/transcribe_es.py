#!/usr/bin/env python3
"""Transcribe WAVs to Spanish SRT + hook titles. Loads Whisper once."""
from __future__ import annotations

import json
import os
import re
import sys
import warnings

warnings.filterwarnings("ignore")

HOOKS = [
    "Mira hasta el final",
    "No vas a creer esto",
    "El final lo cambia TODO",
    "Quédate, se pone bueno",
    "Esto se salió de control",
    "Espera lo que pasa después",
    "Qué locura acaba de pasar",
    "No pares de ver esto",
]


def srt_stamp(sec: float) -> str:
    ms = max(0, int(round(sec * 1000)))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{milli:03d}"


def wrap_title(text: str, limit: int = 28) -> str:
    words = re.sub(r"\s+", " ", text).strip(" .").split()
    if not words:
        return ""
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = (cur + " " + w).strip()
        if len(trial) <= limit:
            cur = trial
            continue
        if cur:
            lines.append(cur)
        cur = w
        if len(lines) >= 2:
            break
    if cur and len(lines) < 2:
        lines.append(cur)
    return "\n".join(lines[:2])


def hook_title(text: str, index: int) -> str:
    raw = re.sub(r"\s+", " ", text or "").strip()
    if not raw:
        return HOOKS[index % len(HOOKS)]
    chunks = [c.strip(" ,;:-") for c in re.split(r"[.!?¿¡\n]", raw) if c.strip()]
    for c in chunks:
        low = c.lower()
        if 10 <= len(c) <= 52 and (
            c.endswith("?")
            or any(k in low for k in ("mira", "espera", "no ", "loco", "dios", "madre", "vamos"))
        ):
            return wrap_title(c)
    words = raw.split()
    if 4 <= len(words) <= 12:
        return wrap_title(raw)
    if len(words) > 12:
        return wrap_title(" ".join(words[:8]) + "…")
    return HOOKS[index % len(HOOKS)]


def merge_cues(cues: list[dict], max_cues: int = 5) -> list[dict]:
    if not cues:
        return []
    merged: list[dict] = []
    cur = dict(cues[0])
    for nxt in cues[1:]:
        gap = nxt["start"] - cur["end"]
        words = (cur["text"] + " " + nxt["text"]).split()
        dur = nxt["end"] - cur["start"]
        if gap < 0.45 and len(words) <= 10 and dur <= 4.2:
            cur["end"] = nxt["end"]
            cur["text"] = " ".join(words)
            continue
        merged.append(cur)
        cur = dict(nxt)
    merged.append(cur)
    if len(merged) <= max_cues:
        return merged
    # Keep evenly spaced if too many.
    step = len(merged) / max_cues
    picked = []
    for i in range(max_cues):
        picked.append(merged[min(len(merged) - 1, int(i * step))])
    return picked


def transcribe_one(model, wav: str, srt_path: str, index: int) -> dict:
    segments, info = model.transcribe(
        wav,
        language="es",
        vad_filter=True,
        beam_size=1,
        best_of=1,
        condition_on_previous_text=False,
    )
    cues = []
    full = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        start = float(seg.start or 0)
        end = max(start + 0.35, float(seg.end or start + 0.7))
        cues.append({"start": start, "end": end, "text": text})
        full.append(text)
    cues = merge_cues(cues, 5)
    lines = []
    for i, cue in enumerate(cues, 1):
        lines.append(str(i))
        lines.append(f"{srt_stamp(cue['start'])} --> {srt_stamp(cue['end'])}")
        lines.append(cue["text"])
        lines.append("")
    with open(srt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines).strip() + ("\n" if lines else ""))
    joined = " ".join(full).strip()
    return {
        "ok": True,
        "language": getattr(info, "language", "es"),
        "text": joined,
        "title": hook_title(joined, index),
        "cues": len(cues),
        "srt": srt_path,
    }


def main() -> None:
    args = sys.argv[1:]
    if len(args) < 2 or len(args) % 2 != 0:
        print(json.dumps({"ok": False, "error": "uso: transcribe_es.py wav srt [wav srt ...]"}))
        sys.exit(1)
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"ok": False, "error": "faster-whisper no instalado"}))
        sys.exit(0)

    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("CT2_USE_EXPERIMENTAL_PACKED_GEMM", "0")
    model_name = os.environ.get("WHISPER_MODEL", "tiny")
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=1)
    pairs = list(zip(args[0::2], args[1::2]))
    results = []
    for i, (wav, srt) in enumerate(pairs):
        try:
            results.append(transcribe_one(model, wav, srt, i))
        except Exception as exc:  # noqa: BLE001
            results.append({"ok": False, "error": str(exc), "srt": srt})
    print(json.dumps({"ok": True, "items": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
