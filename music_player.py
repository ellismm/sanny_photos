import subprocess
import threading
import logging
import os
import signal
from yt_dlp import YoutubeDL

logging.basicConfig(level=logging.INFO)

class MPVPlayer:
    def __init__(self):
        self.process = None
        self.playlist = []
        self.current_index = 0
        self.is_muted = False
        self.is_paused = False
        self.lock = threading.Lock()

        self.mpv_path = "/usr/bin/mpv"
        self.ytdlp_path = "/usr/bin/yt-dlp"

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _start_mpv(self, url):
        self.stop()

        cmd = [
            self.mpv_path,
            "--no-video",
            "--ytdl",
            "--ytdl-format=bestaudio",
            "--force-window=no",
            "--ao=pulse",
            "--cache=yes",
            "--volume=80",
            url
        ]

        logging.info("Starting mpv: %s", " ".join(cmd))

        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            preexec_fn=os.setsid
        )

        self.is_paused = False

    def stop(self):
        if self.process and self.process.poll() is None:
            try:
                os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
            except Exception:
                pass
        self.process = None

    # ------------------------------------------------------------------
    # Playlist handling
    # ------------------------------------------------------------------

    def load_playlist(self, playlist_url):
        logging.info("Loading playlist: %s", playlist_url)

        ydl_opts = {
            "quiet": True,
            "extract_flat": True,
            "skip_download": True,
            "forcejson": True,
        }

        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(playlist_url, download=False)

        entries = info.get("entries", [])
        self.playlist = []

        for e in entries:
            if not e:
                continue
            self.playlist.append({
                "title": e.get("title"),
                "url": f"https://www.youtube.com/watch?v={e.get('id')}"
            })

        self.current_index = 0
        return self.playlist

    # ------------------------------------------------------------------
    # Playback controls
    # ------------------------------------------------------------------

    def play_index(self, index):
        with self.lock:
            if not self.playlist:
                raise RuntimeError("Playlist is empty")

            self.current_index = index % len(self.playlist)
            track = self.playlist[self.current_index]

            self._start_mpv(track["url"])

            return {
                "index": self.current_index,
                "title": track["title"],
                "url": track["url"]
            }

    def next_track(self):
        return self.play_index(self.current_index + 1)

    def prev_track(self):
        return self.play_index(self.current_index - 1)

    def toggle_pause(self):
        if not self.process or self.process.poll() is not None:
            return {"paused": False}

        try:
            if self.is_paused:
                os.kill(self.process.pid, signal.SIGCONT)
                self.is_paused = False
            else:
                os.kill(self.process.pid, signal.SIGSTOP)
                self.is_paused = True
        except Exception:
            pass

        return {"paused": self.is_paused}

    def mute(self, mute=True):
        self.is_muted = mute

        if self.process and self.process.poll() is None:
            vol = "0" if mute else "80"
            subprocess.Popen([
                self.mpv_path,
                "--input-ipc-server=/tmp/mpv-socket",
                f"--volume={vol}"
            ])

        return {"muted": self.is_muted}

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def status(self):
        return {
            "ok": True,
            "running": self.process is not None and self.process.poll() is None,
            "paused": self.is_paused,
            "muted": self.is_muted,
            "index": self.current_index,
            "track": self.playlist[self.current_index] if self.playlist else None
        }
    
