#!/usr/bin/env bash
# Grab several candidate frames from a VOD and tile them into one montage for review,
# so you can eyeball which timestamp makes the best thumbnail before setting it.
#   tools/grab-candidates.sh <videoId> <outMontage.jpg> [pct1 pct2 ...]   (default pcts: 35 58 78)
set -euo pipefail
id="${1:?usage: grab-candidates.sh <videoId> <outMontage.jpg> [pcts...]}"
out="${2:?missing outMontage}"
shift 2
pcts=("$@"); [ "${#pcts[@]}" -eq 0 ] && pcts=(35 58 78)
url="https://youtube.com/watch?v=$id"

dur=$(yt-dlp -q --no-warnings --print duration "$url" | head -1)
vurl=$(yt-dlp -q --no-warnings -f "18/best[height<=360][protocol^=http]/worst" -g "$url" | head -1)
tmp=$(mktemp -d); frames=()
for pct in "${pcts[@]}"; do
  sec=$(awk -v d="$dur" -v p="$pct" 'BEGIN{printf "%d", d*p/100}')
  f="$tmp/f_${pct}.jpg"
  if ffmpeg -y -loglevel error -ss "$sec" -i "$vurl" -frames:v 1 "$f" 2>/dev/null; then frames+=("$f"); fi
done
inputs=(); for f in "${frames[@]}"; do inputs+=(-i "$f"); done
ffmpeg -y -loglevel error "${inputs[@]}" -filter_complex "hstack=${#frames[@]}" "$out"
echo "OK montage (${#frames[@]} frames: ${pcts[*]}) -> $out"
rm -rf "$tmp"
