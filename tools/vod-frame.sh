#!/usr/bin/env bash
# Grab one JPEG frame from a video's VOD at a timestamp.
#   tools/vod-frame.sh <videoId> <55%|seconds|HH:MM:SS> <outPath>
# Uses the 360p progressive stream - the only format that seeks quickly here; the 720p/1080p
# DASH variants are not range-seekable with ffmpeg, so deep seeks into long VODs hang.
set -euo pipefail
id="${1:?usage: vod-frame.sh <videoId> <55%|seconds|HH:MM:SS> <outPath>}"
at="${2:?missing timestamp}"
out="${3:?missing outPath}"
url="https://youtube.com/watch?v=$id"

if [[ "$at" == *% ]]; then
  dur=$(yt-dlp -q --no-warnings --print duration "$url" | head -1)
  sec=$(awk -v d="$dur" -v p="${at%\%}" 'BEGIN{printf "%d", d*p/100}')
elif [[ "$at" == *:* ]]; then
  sec=$(awk -F: '{s=0; for(i=1;i<=NF;i++) s=s*60+$i; print s}' <<< "$at")
else
  sec="$at"
fi

vurl=$(yt-dlp -q --no-warnings -f "18/best[height<=360][protocol^=http]/worst" -g "$url" | head -1)
ffmpeg -y -loglevel error -ss "$sec" -i "$vurl" -frames:v 1 "$out"
echo "OK frame at ${sec}s -> $out"
