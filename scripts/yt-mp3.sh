#!/usr/bin/env bash
#
# yt-mp3.sh — download YouTube videos or playlists as MP3.
#
# Usage:
#   ./yt-mp3.sh <video-or-playlist-url> [more-urls...]
#   ./yt-mp3.sh -o ~/Music/rips https://www.youtube.com/playlist?list=PL...
#
# Options:
#   -o DIR    output directory (default: ./downloads)
#   -q N      MP3 quality, 0=best VBR ... 9=worst (default: 0)
#   -h        show this help
#
# Requires: yt-dlp and ffmpeg.
#   yt-dlp:  https://github.com/yt-dlp/yt-dlp  (pip install yt-dlp, brew install yt-dlp, ...)
#   ffmpeg:  apt install ffmpeg / brew install ffmpeg / winget install ffmpeg
#
# Only download content you have the right to download.

set -euo pipefail

OUT_DIR="./downloads"
QUALITY="0"

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while getopts ":o:q:h" opt; do
  case "$opt" in
    o) OUT_DIR="$OPTARG" ;;
    q) QUALITY="$OPTARG" ;;
    h) usage 0 ;;
    \?) echo "Unknown option: -$OPTARG" >&2; usage 1 ;;
    :) echo "Option -$OPTARG needs a value" >&2; usage 1 ;;
  esac
done
shift $((OPTIND - 1))

[ "$#" -ge 1 ] || usage 1

for cmd in yt-dlp ffmpeg; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' is not installed — see the header of this script for install hints." >&2
    exit 1
  fi
done

mkdir -p "$OUT_DIR"

# yt-dlp needs a JavaScript runtime (deno preferred) for YouTube; without one
# most downloads fail with HTTP 403. Enable an alternative if deno is absent.
JS_ARGS=()
if ! command -v deno >/dev/null 2>&1; then
  for rt in node bun quickjs; do
    if command -v "$rt" >/dev/null 2>&1; then
      JS_ARGS=(--js-runtimes "$rt")
      break
    fi
  done
  if [ ${#JS_ARGS[@]} -eq 0 ]; then
    echo "warning: no JavaScript runtime found (deno/node) — YouTube downloads" >&2
    echo "         will likely fail with HTTP 403. Install deno: https://deno.land" >&2
  fi
fi

# One template covers both cases: playlist items get a subfolder named after
# the playlist with zero-padded track numbers; single videos land directly in
# OUT_DIR (yt-dlp drops the empty playlist_title path component).
exec yt-dlp \
  --extract-audio \
  --audio-format mp3 \
  --audio-quality "$QUALITY" \
  --embed-thumbnail \
  --embed-metadata \
  --ignore-errors \
  --no-overwrites \
  --windows-filenames \
  --newline \
  ${JS_ARGS[@]+"${JS_ARGS[@]}"} \
  --output "$OUT_DIR/%(playlist_title|)s/%(playlist_index&{:02d} - |)s%(title)s.%(ext)s" \
  "$@"
