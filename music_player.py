import json
import logging
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from yt_dlp import YoutubeDL


logging.basicConfig(level=logging.INFO)


class MPVPlayer:
    def __init__(self):
        root = Path(__file__).resolve().parent

        self.process = None
        self.log_handle = None
        self.playlist = []
        self.current_index = 0
        self.is_muted = False
        self.is_paused = False
        self.last_error = ""
        self.last_started_url = ""
        self.last_exit_code = None
        self.lock = threading.RLock()

        self.mpv_path = os.environ.get("SANNY_MPV_PATH") or shutil.which("mpv") or "/usr/bin/mpv"
        self.ytdlp_path = os.environ.get("SANNY_YTDLP_PATH") or shutil.which("yt-dlp") or "/usr/local/bin/yt-dlp"
        self.cookies_path = os.environ.get("SANNY_YTDLP_COOKIES", str(root / "ytdlp_cookies.txt"))
        self.ipc_socket_path = os.environ.get("SANNY_MPV_SOCKET", "/tmp/sanny_mpv.sock")
        self.log_path = os.environ.get("SANNY_MPV_LOG", "/tmp/sanny_mpv.log")
        self.cache_dir = Path(
            os.environ.get(
                "SANNY_AUDIO_CACHE_DIR",
                os.path.join(tempfile.gettempdir(), "sanny_audio_cache"),
            )
        )
        self.cache_max_age_seconds = 7 * 24 * 60 * 60
        self.cache_max_files = 20
        self.volume_level = self._clamp_volume(os.environ.get("SANNY_MPV_VOLUME", "80"))
        self.audio_output = os.environ.get("SANNY_MPV_AUDIO_OUTPUT", "pulse").strip()

    def _track_key_for_url(self, track_url, fallback=""):
        candidate = str(track_url or "").strip()
        if not candidate:
            return str(fallback or "").strip()

        try:
            parsed = urlparse(candidate)
        except Exception:
            return candidate or str(fallback or "").strip()

        host = (parsed.netloc or "").lower()
        if "youtu.be" in host:
            key = parsed.path.strip("/")
            return key or candidate or str(fallback or "").strip()

        if "youtube.com" in host or "music.youtube.com" in host:
            video_id = parse_qs(parsed.query).get("v", [""])[0].strip()
            if video_id:
                return video_id
            key = parsed.path.strip("/").split("/")[-1]
            return key or candidate or str(fallback or "").strip()

        return candidate or str(fallback or "").strip()

    def _normalize_playlist_items(self, playlist_items):
        playlist = []

        for index, item in enumerate(playlist_items or []):
            if not isinstance(item, dict):
                continue

            track_url = str(item.get("url") or "").strip()
            if not track_url:
                continue

            title = str(item.get("title") or f"Track {index + 1}").strip() or f"Track {index + 1}"
            track_key = str(item.get("key") or "").strip() or self._track_key_for_url(track_url, fallback=f"track-{index + 1}")
            playlist.append(
                {
                    "title": title,
                    "url": track_url,
                    "key": track_key,
                }
            )

        return playlist

    def _clamp_volume(self, value):
        try:
            numeric = int(round(float(value)))
        except (TypeError, ValueError):
            numeric = 80
        return max(0, min(100, numeric))

    def _is_running(self):
        return self.process is not None and self.process.poll() is None

    def _remove_stale_socket(self):
        try:
            if os.path.exists(self.ipc_socket_path):
                os.remove(self.ipc_socket_path)
        except OSError:
            logging.warning("Could not remove stale mpv socket: %s", self.ipc_socket_path)

    def _close_log_handle(self):
        if self.log_handle:
            try:
                self.log_handle.close()
            except Exception:
                pass
            self.log_handle = None

    def _wait_for_ipc(self, attempts=60, sleep_for=0.05):
        for _ in range(attempts):
            if os.path.exists(self.ipc_socket_path):
                return True
            if self.process and self.process.poll() is not None:
                return False
            time.sleep(sleep_for)
        return False

    def _read_log_tail(self, max_chars=1200):
        if not os.path.exists(self.log_path):
            return ""

        try:
            with open(self.log_path, "r", encoding="utf-8", errors="replace") as handle:
                data = handle.read()
        except Exception:
            return ""

        if len(data) <= max_chars:
            return data.strip()
        return data[-max_chars:].strip()

    def _build_mpv_command(self, url, headers=None):
        cmd = [
            self.mpv_path,
            "--no-video",
            "--force-window=no",
            "--cache=yes",
            "--ytdl=no",
            f"--volume={self.volume_level}",
            f"--input-ipc-server={self.ipc_socket_path}",
        ]

        if self.audio_output:
            cmd.append(f"--ao={self.audio_output}")

        if headers:
            user_agent = headers.get("User-Agent")
            if user_agent:
                cmd.append(f"--user-agent={user_agent}")

            referer = headers.get("Referer")
            if referer:
                cmd.append(f"--referrer={referer}")

            header_fields = []
            for key, value in headers.items():
                if not value or key in {"User-Agent", "Referer"}:
                    continue
                header_fields.append(f"{key}: {value}")

            if header_fields:
                cmd.append(f"--http-header-fields={','.join(header_fields)}")

        cmd.append(url)
        return cmd

    def _start_mpv(self, url, headers=None):
        self.stop()
        self._remove_stale_socket()
        self.last_error = ""
        self.last_started_url = url
        self.last_exit_code = None

        cmd = self._build_mpv_command(url, headers=headers)
        logging.info("Starting mpv for %s", url)

        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
        self.log_handle = open(self.log_path, "wb")

        self.process = subprocess.Popen(
            cmd,
            stdout=self.log_handle,
            stderr=self.log_handle,
            preexec_fn=os.setsid,
        )

        if not self._wait_for_ipc():
            exit_code = self.process.poll() if self.process else None
            log_tail = self._read_log_tail()
            self.last_error = f"mpv did not become ready (exit={exit_code}). {log_tail}".strip()
            logging.warning(self.last_error)

        # Re-apply desired state to the new process.
        self._safe_set_property("mute", self.is_muted)
        self._safe_set_property("volume", self.volume_level)
        self._safe_set_property("pause", self.is_paused)

    def _mpv_ipc_request(self, payload):
        if not os.path.exists(self.ipc_socket_path):
            raise RuntimeError(f"mpv IPC socket not found: {self.ipc_socket_path}")

        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(2.0)

        try:
            client.connect(self.ipc_socket_path)
            client.sendall((json.dumps(payload) + "\n").encode("utf-8"))

            buffer = b""
            while b"\n" not in buffer:
                chunk = client.recv(4096)
                if not chunk:
                    break
                buffer += chunk

            if not buffer:
                return None

            return json.loads(buffer.split(b"\n", 1)[0].decode("utf-8", errors="replace"))
        finally:
            client.close()

    def _mpv_command(self, *args):
        return self._mpv_ipc_request({"command": list(args)})

    def _get_property(self, name):
        response = self._mpv_command("get_property", name)
        if not response:
            return None
        return response.get("data")

    def _set_property(self, name, value):
        response = self._mpv_command("set_property", name, value)
        if response and response.get("error") not in (None, "success"):
            raise RuntimeError(response["error"])
        return response

    def _safe_set_property(self, name, value):
        if not self._is_running():
            return None
        try:
            return self._set_property(name, value)
        except Exception as exc:
            self.last_error = f"Failed to set mpv property {name}: {exc}"
            logging.warning(self.last_error)
            return None

    def _build_ydl_opts(self, include_cookies=False, **extra):
        opts = {
            "quiet": True,
            "no_warnings": True,
            "extractor_args": {
                "youtube": {
                    "player_client": ["android"],
                }
            },
        }
        opts.update(extra)
        if include_cookies and self.cookies_path and os.path.exists(self.cookies_path):
            opts["cookiefile"] = self.cookies_path
        return opts

    def _build_playlist_ydl_opts(self, include_cookies=False):
        opts = self._build_ydl_opts(
            include_cookies=include_cookies,
            extract_flat=True,
            skip_download=True,
        )
        return opts

    def _cleanup_cache(self, keep_path=None):
        if not self.cache_dir.exists():
            return

        now_ts = time.time()
        files = []

        for path in self.cache_dir.iterdir():
            if not path.is_file():
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            files.append((path, stat.st_mtime))

        keep_path = Path(keep_path).resolve() if keep_path else None
        stale_cutoff = now_ts - self.cache_max_age_seconds

        for path, modified_at in files:
            if keep_path and path.resolve() == keep_path:
                continue
            if modified_at < stale_cutoff:
                path.unlink(missing_ok=True)

        fresh_files = []
        for path in self.cache_dir.iterdir():
            if not path.is_file():
                continue
            try:
                fresh_files.append((path, path.stat().st_mtime))
            except OSError:
                continue

        fresh_files.sort(key=lambda item: item[1], reverse=True)
        kept = 0
        for path, _ in fresh_files:
            if keep_path and path.resolve() == keep_path:
                kept += 1
                continue
            kept += 1
            if kept > self.cache_max_files:
                path.unlink(missing_ok=True)

    def _download_track_file(self, track_url):
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        attempts = [False]
        if self.cookies_path and os.path.exists(self.cookies_path):
            attempts.append(True)

        last_exc = None
        for include_cookies in attempts:
            try:
                opts = self._build_ydl_opts(
                    include_cookies=include_cookies,
                    format="bestaudio/best",
                    noplaylist=True,
                    outtmpl=str(self.cache_dir / "%(id)s.%(ext)s"),
                )
                with YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(track_url, download=True)

                requested = info.get("requested_downloads") or []
                candidate_paths = [
                    requested[0].get("filepath") if requested else None,
                    info.get("_filename"),
                    info.get("filepath"),
                ]

                for candidate in candidate_paths:
                    if candidate and os.path.exists(candidate):
                        os.utime(candidate, None)
                        self._cleanup_cache(candidate)
                        return candidate

                raise RuntimeError("yt-dlp finished without a playable local file")
            except Exception as exc:
                last_exc = exc

        if last_exc:
            raise RuntimeError(f"yt-dlp could not download a playable audio file: {last_exc}") from last_exc
        raise RuntimeError("yt-dlp could not download a playable audio file")

    def load_playlist(self, playlist_url):
        logging.info("Loading playlist: %s", playlist_url)

        info = None
        attempts = [False]
        if self.cookies_path and os.path.exists(self.cookies_path):
            attempts.append(True)

        last_exc = None
        for include_cookies in attempts:
            try:
                with YoutubeDL(self._build_playlist_ydl_opts(include_cookies=include_cookies)) as ydl:
                    info = ydl.extract_info(playlist_url, download=False)
                break
            except Exception as exc:
                last_exc = exc

        if info is None:
            raise RuntimeError(f"Could not load playlist: {last_exc}") from last_exc

        entries = info.get("entries") or [info]
        playlist = []

        for entry in entries:
            if not entry:
                continue

            video_ref = entry.get("id") or entry.get("url")
            if not video_ref:
                continue

            if isinstance(video_ref, str) and video_ref.startswith("http"):
                track_url = video_ref
            else:
                track_url = f"https://www.youtube.com/watch?v={video_ref}"

            playlist.append(
                {
                    "title": entry.get("title") or f"Track {len(playlist) + 1}",
                    "url": track_url,
                    "key": entry.get("id") or self._track_key_for_url(track_url, fallback=f"track-{len(playlist) + 1}"),
                }
            )

        self.playlist = self._normalize_playlist_items(playlist)
        self.current_index = 0
        return self.playlist

    def set_playlist_items(self, playlist_items):
        playlist = self._normalize_playlist_items(playlist_items)
        if not playlist:
            raise RuntimeError("Playlist is empty")

        self.playlist = playlist
        self.current_index = 0
        return self.playlist

    def play_index(self, index, paused=False):
        with self.lock:
            if not self.playlist:
                raise RuntimeError("Playlist is empty")

            self.current_index = index % len(self.playlist)
            self.is_paused = bool(paused)
            track = self.playlist[self.current_index]
            playback_url = self._download_track_file(track["url"])

            self._start_mpv(playback_url)

            if self.last_error and not self._is_running():
                raise RuntimeError(self.last_error)

            return {
                "index": self.current_index,
                "title": track["title"],
                "url": track["url"],
                "key": track.get("key", ""),
                "paused": self.is_paused,
                "muted": self.is_muted,
            }

    def next_track(self):
        return self.play_index(self.current_index + 1, paused=False)

    def prev_track(self):
        return self.play_index(self.current_index - 1, paused=False)

    def set_pause(self, paused=True):
        with self.lock:
            self.is_paused = bool(paused)
            if self._is_running():
                self._set_property("pause", self.is_paused)
            return {"paused": self.is_paused}

    def toggle_pause(self):
        current = self.status()
        return self.set_pause(not current.get("paused", False))

    def mute(self, mute=True):
        with self.lock:
            self.is_muted = bool(mute)

            if self._is_running():
                self._set_property("mute", self.is_muted)

            return {"muted": self.is_muted}

    def set_volume(self, volume=80):
        with self.lock:
            self.volume_level = self._clamp_volume(volume)

            if self._is_running():
                self._set_property("volume", self.volume_level)

            return {"volume": self.volume_level}

    def seek(self, position_seconds):
        with self.lock:
            if not self._is_running():
                raise RuntimeError("No active track is playing.")

            target = max(0.0, float(position_seconds))
            self._mpv_command("seek", target, "absolute+exact")
            return {"positionSeconds": target}

    def stop(self):
        with self.lock:
            if self._is_running():
                try:
                    self._mpv_command("quit")
                except Exception:
                    try:
                        os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
                    except Exception:
                        pass

                try:
                    self.process.wait(timeout=2)
                except Exception:
                    pass

            self.process = None
            self.is_paused = False
            self.last_exit_code = None
            self._remove_stale_socket()
            self._close_log_handle()

            return {
                "running": False,
                "paused": self.is_paused,
                "muted": self.is_muted,
                "volume": self.volume_level,
            }

    def status(self):
        running = self._is_running()
        ended = False
        position_seconds = None
        duration_seconds = None

        if running:
            try:
                paused = self._get_property("pause")
                muted = self._get_property("mute")
                position = self._get_property("time-pos")
                duration = self._get_property("duration")
                volume = self._get_property("volume")
                if isinstance(paused, bool):
                    self.is_paused = paused
                if isinstance(muted, bool):
                    self.is_muted = muted
                if isinstance(position, (int, float)):
                    position_seconds = float(position)
                if isinstance(duration, (int, float)):
                    duration_seconds = float(duration)
                if isinstance(volume, (int, float)):
                    self.volume_level = self._clamp_volume(volume)
            except Exception as exc:
                self.last_error = f"Could not query mpv status via IPC: {exc}"
                logging.warning(self.last_error)
        elif self.process is not None and self.process.poll() is not None:
            exit_code = self.process.poll()
            self.last_exit_code = exit_code
            ended = exit_code == 0 and bool(self.playlist)
            if exit_code != 0 and not self.last_error:
                log_tail = self._read_log_tail()
                self.last_error = f"mpv exited with code {exit_code}. {log_tail}".strip()

        track = None
        if self.playlist:
            track = self.playlist[self.current_index]

        return {
            "ok": True,
            "running": running,
            "paused": self.is_paused,
            "muted": self.is_muted,
            "volume": self.volume_level,
            "index": self.current_index if track else -1,
            "track": track,
            "ended": ended,
            "positionSeconds": position_seconds,
            "durationSeconds": duration_seconds,
            "lastError": self.last_error,
            "logPath": self.log_path,
            "startedUrl": self.last_started_url,
        }
