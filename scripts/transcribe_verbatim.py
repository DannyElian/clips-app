#!/usr/bin/env python3
"""Verbatim transcript. Does not rewrite, summarize, or drop filler words."""
from __future__ import annotations

import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main() -> None:
    if len(sys.argv) not in (3, 4):
        emit({"ok": False, "error": "uso: transcribe_verbatim.py wav out.json [words]"})
        sys.exit(1)
    wav, out_path = sys.argv[1], sys.argv[2]
    want_words = len(sys.argv) == 4 and sys.argv[3] == "words"
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        emit({"ok": False, "error": "faster-whisper no instalado"})
        sys.exit(1)

    model_name = os.environ.get("WHISPER_MODEL_VERBATIM") or os.environ.get("WHISPER_MODEL") or "small"
    threads = max(1, min(4, os.cpu_count() or 2))
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=threads)
    segments, info = model.transcribe(
        wav,
        beam_size=5,
        best_of=5,
        temperature=0.0,
        vad_filter=want_words,
        vad_parameters={"min_silence_duration_ms": 350} if want_words else None,
        word_timestamps=want_words,
        condition_on_previous_text=not want_words,
        without_timestamps=False,
    )
    duration = float(getattr(info, "duration", 0) or 0)
    cues: list[dict] = []
    parts: list[str] = []
    for seg in segments:
        piece = seg.text if isinstance(seg.text, str) else ""
        piece = piece.strip()
        if not piece:
            continue
        start = float(seg.start or 0)
        end = float(seg.end or start)
        words = []
        if want_words:
            for w in getattr(seg, "words", None) or []:
                token = (getattr(w, "word", "") or "").strip()
                if not token:
                    continue
                words.append({
                    "start": round(float(w.start or start), 3),
                    "end": round(float(w.end or end), 3),
                    "word": token,
                })
        if words:
            start = float(words[0]["start"])
            end = float(words[-1]["end"])
        cue = {"start": round(start, 3), "end": round(max(end, start + 0.08), 3), "text": piece}
        if words:
            cue["words"] = words
        cues.append(cue)
        parts.append(piece)
        if duration > 0:
            emit({"progress": round(min(0.99, end / duration), 4)})

    result = {
        "ok": True,
        "language": getattr(info, "language", "") or "",
        "text": " ".join(parts),
        "segments": cues,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    emit({"ok": True, "language": result["language"], "segments": len(cues)})


if __name__ == "__main__":
    main()
