# Clips — vertical dual-layout clipper (MVP)

Upload a gameplay VOD → auto-detect highlight windows (audio energy + scene changes) → export **9:16** TikTok-style clips with **streamer cam on top (~40%)** and **gameplay on bottom (~60%)**.

Built for Danny Medina / Clips Project. Uploaded files only (no live ingest yet). No Whisper/LLM in the MVP path.

## Requirements

- Node.js 18+
- `ffmpeg` and `ffprobe` on `PATH`

## Quick start

```bash
cd clips-app
npm install
npm run sample          # optional synthetic Twitch-like VOD → data/sample-vod.mp4
npm start               # http://localhost:8787
```

Dev (auto-reload):

```bash
npm run dev
```

Open the UI, drop a VOD (or the sample), pick a webcam preset, hit export. Clips appear in the Status panel when the job finishes.

### API smoke test

```bash
curl -F video=@data/sample-vod.mp4 \
  -F webcamPreset=bottom-left \
  -F output=720x1280 \
  -F maxClips=5 \
  http://localhost:8787/api/jobs
# → { "id": "...", "status": "queued", ... }

curl http://localhost:8787/api/jobs/<id>
# poll until status=done, then download /api/jobs/<id>/clips/<filename>
```

## Crop assumptions (documented in UI)

| Piece | Default |
| --- | --- |
| Source | Single fullscreen capture (typical Twitch VOD) with a webcam overlay |
| Webcam presets | `bottom-left` (default), `top-left`, `bottom-right`, or custom normalized rect |
| Default cam rect | `x=0.01 y=0.68 w=0.24 h=0.30` of source |
| Gameplay crop | Full frame `0,0,1,1` (override if you want a tighter game window) |
| Output layout | Always vertical stack: **top 40% cam**, **bottom 60% gameplay** |
| Output size | `720x1280` (default, faster) or `1080x1920` |

Rects are fractions of source width/height (`0–1`).

## How highlights are chosen

1. Decode mono audio → per-window RMS → keep peaks above a configurable percentile.
2. Downscaled `fps=2` scene-change pass (`select=gt(scene,N)`).
3. Merge nearby peaks, pad before/after into **15–45s** windows, return up to **N** clips (default 8).
4. Silent/static fallback: evenly spaced windows.

Whisper transcription / LLM ranking is intentionally **not** required for MVP.

## Open knobs

| Knob | Form / API field | Default |
| --- | --- | --- |
| Webcam preset / custom rect | `webcamPreset`, `webcamX/Y/W/H` | `bottom-left` |
| Gameplay rect | `gameplayX/Y/W/H` | full frame |
| Output resolution | `output` | `720x1280` |
| Target clip length | `clipDurationSec` | `30` |
| Min / max clip | `minClipSec` / `maxClipSec` | `15` / `45` |
| Pad before / after peak | `padBeforeSec` / `padAfterSec` | `8` / `22` |
| Max clips | `maxClips` | `8` |
| Audio peak percentile | `audioPeakPercentile` | `88` |
| Scene threshold | `sceneThreshold` | `0.35` |

## Project layout

```
clips-app/
  public/           # minimal UI
  src/
    server.ts       # Express API + static host
    types.ts
    services/
      ffmpeg.ts     # probe / spawn helpers
      highlight.ts  # audio + scene heuristics
      compose.ts    # dual-layout vertical export
      jobs.ts       # in-memory job runner
  scripts/make-sample.sh
  data/             # uploads, jobs, sample (gitignored contents)
```

## Notes / limits

- Jobs are in-memory; restarting the server clears job status (clip files on disk remain under `data/jobs/`).
- Long VODs: analysis downscales video for scene detection; export uses `libx264 veryfast`.
- Live stream ingest is out of scope (queued as a follow-up).
