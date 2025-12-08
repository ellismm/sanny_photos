import subprocess
import threading
import shutil
import signal
import logging
import os; 

os.environ.update({k:v for k,v in {
    "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
    "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{os.getuid()}/bus",
    "PULSE_SERVER": f"unix:/run/user/{os.getuid()}/pulse/native",
    "DISPLAY": ":1"   # 👈 match your actual session
}.items() if v and os.path.exists(v.split('=')[-1].split(':')[-1].split('/')[1] if '/' in v else "/run/user")})

# import sys
# logging.info(f"PATH in this process: {os.environ.get('PATH')}")
# logging.info(f"Python executable: {sys.executable}")


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

class MpvPlayer:
    def __init__(self, default_volume=80):
        self.proc = None
        self.muted = False
        # --- inside class MpvPlayer.__init__ ---
        self.paused = False

        self.default_volume = default_volume
        self.lock = threading.Lock()
        self.mpv_path = "/usr/bin/mpv"

        if not shutil.which(self.mpv_path):
            raise RuntimeError(f"mpv not found at {self.mpv_path}")

    def _spawn(self, media_url: str):
        logging.info(f"Starting mpv for: {media_url}")
        args = [
            self.mpv_path,
            "--no-video",
            "--ytdl",
            "--ytdl-format=bestaudio",
            "--force-window=no",
            "--ao=pulse",
            "--cache=yes",
            "--player-operation-mode=pseudo-gui",
            f"--volume=80",
            "--loop-file=no",
            "--ytdl-raw-options=ignoreerrors=true",
            f"--ytdl-raw-options=cookies={os.path.expanduser('~/coding/own/sanny_photos/ytdlp_cookies.txt')}",
            media_url,
        ]


        env = os.environ.copy()
        env.update({
            "PATH": "/usr/bin:/bin:/usr/local/bin",
            "HOME": os.path.expanduser("~"),             # <--- critical for yt-dlp
            "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
            "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{os.getuid()}/bus",
            "DISPLAY": os.environ.get("DISPLAY", ":1"),  # <--- helps PipeWire connect
            "PULSE_SERVER": "unix:/run/user/1000/pulse/native"
        })

        log_path = "/tmp/mpv_debug.log"
        logging.info(f"Writing mpv debug output to {log_path}")

        try:
            with open(log_path, "w", buffering=1) as logfile:
                logfile.write(f"Launching mpv with args: {' '.join(args)}\n")

                self.proc = subprocess.Popen(
                    args,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                    close_fds=True,
                    env=env,
                )

            logging.info(f"mpv started (PID {self.proc.pid})")

        except Exception as e:
            logging.error(f"Failed to start mpv: {e}", exc_info=True)
            self.proc = None


    def play(self, media_url: str):
        logging.info("play() called")
        self.stop()

        # Launch mpv in a detached background thread
        def runner():
            try:
                logging.info(f"Starting detached mpv thread for {media_url}")
                self._spawn(media_url)
            except Exception as e:
                logging.error(f"Error launching mpv thread: {e}", exc_info=True)

        t = threading.Thread(target=runner, daemon=True)
        t.start()


    def pause(self):
        with self.lock:
            if self.proc and self.proc.poll() is None and not self.paused:
                logging.info("Pausing playback")
                self.proc.send_signal(signal.SIGSTOP)
                self.paused = True

    def resume(self):
        with self.lock:
            if self.proc and self.proc.poll() is None and self.paused:
                logging.info("Resuming playback")
                self.proc.send_signal(signal.SIGCONT)
                self.paused = False

    def toggle_pause(self):
        with self.lock:
            if self.proc and self.proc.poll() is None:
                if self.paused:
                    self.proc.send_signal(signal.SIGCONT)
                    self.paused = False
                    logging.info("Resuming playback (toggle)")
                else:
                    self.proc.send_signal(signal.SIGSTOP)
                    self.paused = True
                    logging.info("Pausing playback (toggle)")



    def stop(self):
        with self.lock:
            if self.proc and self.proc.poll() is None:
                logging.info("Stopping current mpv process")
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    logging.warning("mpv did not exit cleanly; killing")
                    self.proc.kill()
            self.proc = None

    def set_mute(self, mute: bool):
        with self.lock:
            if mute == self.muted:
                return
            self.muted = mute
            if self.proc and self.proc.poll() is None:
                if mute:
                    logging.info("Muting (pause via SIGSTOP)")
                    self.proc.send_signal(signal.SIGSTOP)
                else:
                    logging.info("Unmuting (resume via SIGCONT)")
                    self.proc.send_signal(signal.SIGCONT)

    def is_running(self):
        return self.proc and self.proc.poll() is None

player = MpvPlayer(default_volume=80)
