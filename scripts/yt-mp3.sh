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

# Playlists land in a subfolder named after the playlist, numbered by position;
# single videos go straight into OUT_DIR. yt-dlp picks the right template itself.
exec yt-dlp \
  --extract-audio \
  --audio-format mp3 \
  --audio-quality "$QUALITY" \
  --embed-thumbnail \
  --embed-metadata \
  --ignore-errors \
  --no-overwrites \
  --restrict-filenames \
  --newline \
  --output "$OUT_DIR/%(title)s.%(ext)s" \
  --output "playlist:$OUT_DIR/%(playlist_title)s/%(playlist_index)02d - %(title)s.%(ext)s" \
  "$@"
