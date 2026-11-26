#!/usr/bin/env python3
"""Short verbatim lines for clip copy. One model load, no titles, no rewriting."""
from __future__ import annotations

import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main() -> None:
    if len(sys.argv) < 3:
        emit({"ok": False, "error": "uso: transcribe_lines.py out.json wav [wav ...]"})
        sys.exit(1)
    out_path = sys.argv[1]
    wavs = sys.argv[2:]
    timed = bool(wavs) and wavs[0] == "--timed"
    if timed:
        wavs = wavs[1:]
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        emit({"ok": False, "error": "faster-whisper no instalado"})
        sys.exit(1)

    model_name = os.environ.get("WHISPER_MODEL_VERBATIM") or "small"
    threads = max(1, min(4, os.cpu_count() or 2))
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=threads)
    items: list[dict] = []
    total = len(wavs)
    for i, wav in enumerate(wavs):
        try:
            segments, _info = model.transcribe(
                wav,
                beam_size=5,
                temperature=0.0,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 350},
                word_timestamps=timed,
                condition_on_previous_text=False,
                without_timestamps=not timed,
            )
            parts = []
            cues = []
            for seg in segments:
                piece = seg.text.strip() if isinstance(seg.text, str) else ""
                if not piece:
                    continue
                parts.append(piece)
                if not timed:
                    continue
                start = float(seg.start or 0)
                end = float(seg.end or start)
                words = []
                for w in getattr(seg, "words", None) or []:
                    token = (getattr(w, "word", "") or "").strip()
                    if not token:
                        continue
                    w_start = float(w.start or start)
                    w_end = float(w.end or w_start)
                    if w_end < w_start:
                        w_end = w_start + 0.08
                    words.append({"start": round(w_start, 3), "end": round(w_end, 3), "word": token})
                if words:
                    start = float(words[0]["start"])
                    end = float(words[-1]["end"])
                if end > start:
                    cue = {"start": round(start, 3), "end": round(end, 3), "text": piece}
                    if words:
                        cue["words"] = words
                    cues.append(cue)
            items.append({"ok": True, "text": " ".join(parts), "segments": cues})
        except Exception as exc:  # noqa: BLE001
            items.append({"ok": False, "error": str(exc), "text": ""})
        emit({"progress": round((i + 1) / total, 4), "index": i})
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"ok": True, "items": items}, f, ensure_ascii=False)
    emit({"ok": True, "items": len(items)})


if __name__ == "__main__":
    main()
