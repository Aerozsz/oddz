#!/usr/bin/env python3
"""yt-mp3-gui.py — paste YouTube video/playlist links, get MP3s.

A minimal GUI over yt-dlp. Paste one or more links (one per line),
pick an output folder, press Download.

Requires: Python 3.8+, yt-dlp and ffmpeg on your PATH.
  yt-dlp:  pip install yt-dlp   (or brew/choco/winget install yt-dlp)
  ffmpeg:  apt install ffmpeg / brew install ffmpeg / winget install ffmpeg

Run:  python3 yt-mp3-gui.py

Only download content you have the right to download.
"""

import glob
import os
import queue
import shutil
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

QUALITIES = ["0 (best)", "2 (high)", "5 (medium)", "9 (small)"]


def find_yt_dlp():
    """Return the command prefix to invoke yt-dlp, or None if unavailable.

    pip installs the yt-dlp exe into a Scripts dir that often isn't on PATH
    (especially on Windows), so fall back to running it as a module.
    """
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    try:
        import yt_dlp  # noqa: F401
        return [sys.executable, "-m", "yt_dlp"]
    except ImportError:
        return None


def find_ffmpeg():
    """Return the path to ffmpeg, checking PATH plus common Windows locations."""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    if os.name == "nt":
        candidates = []
        local = os.environ.get("LOCALAPPDATA")
        if local:
            candidates += glob.glob(
                os.path.join(local, "Microsoft", "WinGet", "Packages",
                             "*FFmpeg*", "**", "bin", "ffmpeg.exe"),
                recursive=True,
            )
        candidates += [
            r"C:\ffmpeg\bin\ffmpeg.exe",
            os.path.expandvars(r"%ProgramFiles%\ffmpeg\bin\ffmpeg.exe"),
        ]
        for c in candidates:
            if Path(c).is_file():
                return c
    return None


def find_js_runtime():
    """Return yt-dlp args enabling a JavaScript runtime, or None if none found.

    yt-dlp needs a JS runtime (deno preferred) to extract YouTube formats;
    without one most downloads fail with HTTP 403.
    """
    if shutil.which("deno"):
        return []  # deno is enabled by default when on PATH
    home_deno = Path.home() / ".deno" / "bin" / ("deno.exe" if os.name == "nt" else "deno")
    if home_deno.is_file():
        return ["--js-runtimes", f"deno:{home_deno}"]
    for rt in ("node", "bun", "quickjs"):
        if shutil.which(rt):
            return ["--js-runtimes", rt]
    return None


def build_command(yt_dlp_cmd, ffmpeg, js_args, out_dir, quality, urls):
    """Assemble the yt-dlp invocation. Kept as a plain function so it can be
    tested without a display.

    A single output template handles both cases: playlist items get a
    subfolder named after the playlist with zero-padded track numbers,
    single videos land directly in out_dir (yt-dlp drops the empty
    playlist_title path component).
    """
    template = (str(out_dir)
                + "/%(playlist_title|)s/%(playlist_index&{:02d} - |)s%(title)s.%(ext)s")
    return [
        *yt_dlp_cmd,
        "--ffmpeg-location", str(ffmpeg),
        *js_args,
        "--extract-audio", "--audio-format", "mp3", "--audio-quality", quality,
        "--embed-thumbnail", "--embed-metadata",
        "--ignore-errors", "--no-overwrites", "--windows-filenames", "--newline",
        "--output", template,
        *urls,
    ]


def install_help():
    if os.name == "nt":
        return (
            "In Command Prompt run:\n\n"
            "    pip install yt-dlp\n"
            "    winget install Gyan.FFmpeg\n\n"
            "(two separate commands), then close and reopen this app."
        )
    return (
        "Install with:\n\n"
        "    pip install yt-dlp\n"
        "    sudo apt install ffmpeg   (macOS: brew install ffmpeg)\n\n"
        "then reopen this app."
    )


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("YouTube → MP3")
        root.geometry("640x520")
        root.minsize(520, 420)

        self.proc = None
        self.log_queue = queue.Queue()

        frame = ttk.Frame(root, padding=10)
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text="Video or playlist links (one per line):").pack(anchor="w")
        self.links = tk.Text(frame, height=6, wrap="none", undo=True)
        self.links.pack(fill="x", pady=(2, 8))

        row = ttk.Frame(frame)
        row.pack(fill="x", pady=(0, 8))
        ttk.Label(row, text="Save to:").pack(side="left")
        self.out_dir = tk.StringVar(value=str(Path.home() / "Downloads" / "yt-mp3"))
        ttk.Entry(row, textvariable=self.out_dir).pack(side="left", fill="x", expand=True, padx=6)
        ttk.Button(row, text="Browse…", command=self.pick_dir).pack(side="left")

        row2 = ttk.Frame(frame)
        row2.pack(fill="x", pady=(0, 8))
        ttk.Label(row2, text="Quality:").pack(side="left")
        self.quality = tk.StringVar(value=QUALITIES[0])
        ttk.Combobox(row2, textvariable=self.quality, values=QUALITIES,
                     state="readonly", width=12).pack(side="left", padx=6)
        self.btn = ttk.Button(row2, text="Download", command=self.start)
        self.btn.pack(side="right")
        self.cancel_btn = ttk.Button(row2, text="Cancel", command=self.cancel, state="disabled")
        self.cancel_btn.pack(side="right", padx=6)

        ttk.Label(frame, text="Log:").pack(anchor="w")
        self.log = tk.Text(frame, height=14, state="disabled", wrap="word",
                           background="#111", foreground="#ddd")
        self.log.pack(fill="both", expand=True, pady=(2, 0))

        root.after(100, self.drain_log)

    def pick_dir(self):
        chosen = filedialog.askdirectory(initialdir=self.out_dir.get() or str(Path.home()))
        if chosen:
            self.out_dir.set(chosen)

    def append_log(self, text: str):
        self.log.configure(state="normal")
        self.log.insert("end", text)
        self.log.see("end")
        self.log.configure(state="disabled")

    def drain_log(self):
        try:
            while True:
                self.append_log(self.log_queue.get_nowait())
        except queue.Empty:
            pass
        self.root.after(100, self.drain_log)

    def start(self):
        urls = [u.strip() for u in self.links.get("1.0", "end").splitlines() if u.strip()]
        if not urls:
            messagebox.showwarning("No links", "Paste at least one video or playlist link.")
            return

        yt_dlp_cmd = find_yt_dlp()
        ffmpeg = find_ffmpeg()
        missing = [name for name, found in
                   (("yt-dlp", yt_dlp_cmd), ("ffmpeg", ffmpeg)) if not found]
        if missing:
            messagebox.showerror(
                "Missing dependency",
                f"Could not find: {', '.join(missing)}.\n\n{install_help()}",
            )
            return

        js_args = find_js_runtime()
        if js_args is None:
            hint = ("    winget install DenoLand.Deno" if os.name == "nt"
                    else "    brew install deno   (or: curl -fsSL https://deno.land/install.sh | sh)")
            if not messagebox.askyesno(
                "No JavaScript runtime",
                "No JavaScript runtime (deno/node) was found.\n"
                "YouTube needs one — without it most downloads fail with HTTP 403.\n\n"
                f"To fix, run:\n{hint}\n"
                "then close and reopen this app.\n\n"
                "Try downloading anyway?",
            ):
                return
            js_args = []

        out = Path(self.out_dir.get()).expanduser()
        out.mkdir(parents=True, exist_ok=True)
        quality = self.quality.get().split()[0]
        cmd = build_command(yt_dlp_cmd, ffmpeg, js_args, out, quality, urls)

        self.btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal")
        self.append_log(f"\n=== Downloading {len(urls)} link(s) to {out} ===\n")
        threading.Thread(target=self.run, args=(cmd,), daemon=True).start()

    def run(self, cmd):
        try:
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            self.proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, creationflags=flags,
            )
            for line in self.proc.stdout:
                self.log_queue.put(line)
            code = self.proc.wait()
            self.log_queue.put(
                "\n=== Done ===\n" if code == 0
                else f"\n=== Finished with errors (exit {code}) — see log above ===\n"
            )
        except Exception as exc:  # surface anything unexpected in the log
            self.log_queue.put(f"\nerror: {exc}\n")
        finally:
            self.proc = None
            self.root.after(0, lambda: (
                self.btn.configure(state="normal"),
                self.cancel_btn.configure(state="disabled"),
            ))

    def cancel(self):
        if self.proc:
            self.proc.terminate()
            self.log_queue.put("\n=== Cancelled ===\n")


def main():
    root = tk.Tk()
    try:
        ttk.Style().theme_use("clam")
    except tk.TclError:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
