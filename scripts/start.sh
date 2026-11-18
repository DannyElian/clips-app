#!/bin/sh
set -eu
mkdir -p /app/data
if [ -d /etc/secrets ]; then
  for f in /etc/secrets/*; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in
      *cookie*) cp "$f" /app/data/youtube-cookies.txt ;;
    esac
  done
fi
if [ -f /etc/secrets/youtube-cookies.txt ]; then
  cp /etc/secrets/youtube-cookies.txt /app/data/youtube-cookies.txt
fi
if [ -f /app/data/youtube-cookies.txt ]; then
  echo "youtube cookies: mounted"
else
  echo "youtube cookies: MISSING"
fi
exec npm start
