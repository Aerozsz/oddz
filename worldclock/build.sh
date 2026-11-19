#!/bin/sh
# Cross-compile from Linux (needs gcc-mingw-w64-x86-64). On Windows with MSYS2/mingw the same commands work.
set -e
cd "$(dirname "$0")"
x86_64-w64-mingw32-windres worldclock.rc -O coff -o worldclock.res
x86_64-w64-mingw32-gcc -Os -s -Wall -Wextra -municode -mwindows -o WorldClock.exe worldclock.c worldclock.res \
  -luser32 -lgdi32 -lshell32 -ladvapi32 -static-libgcc
rm -f worldclock.res
ls -l WorldClock.exe
