#!/usr/bin/env bash
# ===== Guideo one-click launcher (macOS / Linux) =====
# macOS: double-click. Linux: run ./start-guideo.command (or bash start-guideo.command)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is required but was not found."
  echo "  Install it from https://nodejs.org (LTS is fine), then run this again."
  echo
  read -r -p "Press Enter to close…" _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo
  echo "  First run: installing Guideo (this happens once, give it a minute)…"
  echo
  npm install || { echo "Install failed."; read -r -p "Press Enter to close…" _; exit 1; }
fi

echo
echo "  Starting Guideo… your browser will open at http://127.0.0.1:4600"
echo "  Keep this window open while you use Guideo. Press Ctrl-C to stop."
echo
npm run gui
