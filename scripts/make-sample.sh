#!/usr/bin/env bash
# Generate a synthetic Twitch-like VOD for local demo (no copyrighted content).
# Layout: full-frame "gameplay" + bottom-left webcam picture-in-picture.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/data/sample-vod.mp4}"
WORKDIR="$(mktemp -d)"
FONT="${CLIPS_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf}"
trap 'rm -rf "$WORKDIR"' EXIT
mkdir -p "$(dirname "$OUT")"

echo "Generating synthetic sample VOD → $OUT"

# 1) Gameplay bed with flash "scene changes"
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x1a3d2e:s=1280x720:d=75:r=30" \
  -vf "drawbox=x=40:y=40:w=220:h=80:color=white@0.18:t=fill,
       drawtext=fontfile=${FONT}:fontsize=36:fontcolor=white:x=60:y=55:text='GAMEPLAY',
       drawbox=enable='between(t\,12\,13)':x=0:y=0:w=iw:h=ih:color=yellow@0.55:t=fill,
       drawbox=enable='between(t\,28\,29)':x=0:y=0:w=iw:h=ih:color=red@0.45:t=fill,
       drawbox=enable='between(t\,45\,46)':x=0:y=0:w=iw:h=ih:color=cyan@0.5:t=fill,
       drawbox=enable='between(t\,62\,63)':x=0:y=0:w=iw:h=ih:color=magenta@0.5:t=fill" \
  -c:v libx264 -pix_fmt yuv420p -t 75 "$WORKDIR/game.mp4"

# 2) Fake webcam panel
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x3d2a1a:s=280x220:d=75:r=30" \
  -vf "drawtext=fontfile=${FONT}:fontsize=28:fontcolor=white:x=(w-text_w)/2:y=28:text='CAM',
       drawbox=x='90+40*sin(2*PI*t/3)':y='80+20*cos(2*PI*t/2)':w=70:h=70:color=0xffcc88:t=fill" \
  -c:v libx264 -pix_fmt yuv420p -t 75 "$WORKDIR/cam.mp4"

# 3) Overlay cam bottom-left
ffmpeg -y -hide_banner -loglevel error \
  -i "$WORKDIR/game.mp4" -i "$WORKDIR/cam.mp4" \
  -filter_complex "[0:v][1:v]overlay=20:480[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p -t 75 "$WORKDIR/video.mp4"

# 4) Quiet bed + loud beeps at highlight seconds
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "sine=frequency=220:sample_rate=44100:duration=75" \
  -af "volume=0.04" -t 75 "$WORKDIR/bed.wav"

for pair in "12:880" "28:988" "45:784" "62:1046"; do
  t="${pair%%:*}"
  f="${pair##*:}"
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "sine=frequency=${f}:sample_rate=44100:duration=1.4" \
    -af "volume=1.0,adelay=${t}000|${t}000" -t 75 "$WORKDIR/beep${t}.wav"
done

ffmpeg -y -hide_banner -loglevel error \
  -i "$WORKDIR/bed.wav" \
  -i "$WORKDIR/beep12.wav" \
  -i "$WORKDIR/beep28.wav" \
  -i "$WORKDIR/beep45.wav" \
  -i "$WORKDIR/beep62.wav" \
  -filter_complex "amix=inputs=5:duration=first:dropout_transition=0,volume=1.2" \
  -t 75 "$WORKDIR/audio.wav"

# 5) Mux
ffmpeg -y -hide_banner -loglevel error \
  -i "$WORKDIR/video.mp4" -i "$WORKDIR/audio.wav" \
  -c:v copy -c:a aac -b:a 128k -shortest \
  "$OUT"

echo "Done. Upload $OUT in the UI, or:"
echo "  curl -F video=@$OUT -F webcamPreset=bottom-left http://localhost:8787/api/jobs"
