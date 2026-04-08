#!/usr/bin/env python3
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import threading

from flask import Flask, jsonify, request, send_from_directory

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)


ROOT = Path(__file__).resolve().parent


def load_env_file():
    env_path = Path(os.environ.get("SANNY_ENV_FILE", ROOT / "device.env")).resolve()
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue

        if value and len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]

        os.environ[key] = value


load_env_file()

from drive_sync_photos import compute_album_fingerprint, sync_drive_photos
from music_player import MPVPlayer
from network_setup import NetworkSetupManager


def _env_flag(name, default=False):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}

STATIC_DIR = ROOT / "static"
IMAGES_DIR = Path(os.environ.get("SANNY_IMAGES_DIR", STATIC_DIR / "images")).resolve()
LEGACY_IMAGES_DIR = ROOT / "images"
ALBUM_PATH = Path(os.environ.get("SANNY_ALBUM_PATH", ROOT / "album.json")).resolve()
LEGACY_ALBUM_PATH = STATIC_DIR / "album.json"
APP_PORT = int(os.environ.get("PORT", "5002"))
APP_DEBUG = os.environ.get("SANNY_DEBUG", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
DEFAULT_SLIDE_DURATION_MS = max(
    3000,
    int(os.environ.get("SANNY_DEFAULT_SLIDE_DURATION_MS", "10000")),
)
DEFAULT_PLAYLIST_URL = os.environ.get(
    "SANNY_DEFAULT_PLAYLIST_URL",
    "https://www.youtube.com/playlist?list=PLcFTWWe4qhjxOcfXhNAMwV5SiusiZAKQI",
).strip()
ALARMS_ENABLED = True
ALARM_MAX_DURATION_SECONDS = 300
ALARM_MIN_VOLUME = 45
DRAWING_ENABLED = True
DRAWING_LONG_PRESS_MS = 650
DRAWING_POINT_BATCH_MS = 80
DRAWING_PALETTE = [
    {"id": "cream", "label": "Cream", "color": "#f6e7c3"},
    {"id": "blush", "label": "Blush", "color": "#e7a9b8"},
    {"id": "gold", "label": "Gold", "color": "#d1b174"},
]
ROOM_ID = os.environ.get("SANNY_ROOM_ID", "sanny-photos")
APP_TITLE = os.environ.get("SANNY_APP_TITLE", "Sanny Photos")
SYNC_MUSIC_ENABLED = _env_flag("SANNY_SYNC_MUSIC", True)
TOUCH_DEBUG_ENABLED = _env_flag("SANNY_TOUCH_DEBUG", False)
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}


app = Flask(__name__, static_folder="static", static_url_path="/static")
player = MPVPlayer()
network_setup = NetworkSetupManager(APP_PORT)
sync_state_lock = threading.Lock()
sync_state = {
    "running": False,
    "count": 0,
    "changed": False,
    "lastSuccessAt": None,
    "lastError": "",
    "lastWarning": "",
    "libraryFingerprint": "",
    "roomLibraryFingerprint": "",
    "inSyncWithRoom": True,
}
touch_debug_lock = threading.Lock()
touch_debug_events = []


def _read_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _normalize_album_entry(entry, index):
    if isinstance(entry, str):
        url = entry.strip()
        caption = ""
        drive_file_id = ""
    elif isinstance(entry, dict):
        url = (entry.get("url") or "").strip()
        caption = (entry.get("caption") or "").strip()
        drive_file_id = (entry.get("driveFileId") or "").strip()
    else:
        return None

    if not url:
        return None

    return {
        "id": f"img-{index:04d}",
        "url": url,
        "caption": caption,
        "driveFileId": drive_file_id,
    }


def _scan_images_directory():
    if not IMAGES_DIR.exists():
        return []

    images = []
    for index, path in enumerate(sorted(IMAGES_DIR.iterdir()), start=1):
        if not path.is_file() or path.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        images.append(
            {
                "id": f"img-{index:04d}",
                "url": f"images/{path.name}",
                "caption": "",
                "driveFileId": "",
            }
        )
    return images


def load_album_manifest():
    candidates = [ALBUM_PATH, LEGACY_ALBUM_PATH]
    album_data = None

    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            album_data = _read_json(candidate)
            break
        except Exception:
            logging.exception("Failed to read album manifest: %s", candidate)

    images = []
    if isinstance(album_data, dict):
        raw_images = album_data.get("images") or []
    elif isinstance(album_data, list):
        raw_images = album_data
    else:
        raw_images = []

    for index, entry in enumerate(raw_images, start=1):
        normalized = _normalize_album_entry(entry, index)
        if normalized:
            images.append(normalized)

    if not images:
        images = _scan_images_directory()

    manifest = {
        "version": 2,
        "title": APP_TITLE,
        "images": images,
    }
    manifest["fingerprint"] = compute_album_fingerprint({"images": images})
    return manifest


def build_firebase_config():
    firebase_config = {
        "apiKey": os.environ.get("SANNY_FIREBASE_API_KEY", "").strip(),
        "authDomain": os.environ.get("SANNY_FIREBASE_AUTH_DOMAIN", "").strip(),
        "databaseURL": os.environ.get("SANNY_FIREBASE_DATABASE_URL", "").strip(),
        "projectId": os.environ.get("SANNY_FIREBASE_PROJECT_ID", "").strip(),
        "storageBucket": os.environ.get("SANNY_FIREBASE_STORAGE_BUCKET", "").strip(),
        "messagingSenderId": os.environ.get(
            "SANNY_FIREBASE_MESSAGING_SENDER_ID", ""
        ).strip(),
        "appId": os.environ.get("SANNY_FIREBASE_APP_ID", "").strip(),
    }
    if all(firebase_config.values()):
        return firebase_config
    return None


def build_client_config():
    firebase_config = build_firebase_config()
    return {
        "appTitle": APP_TITLE,
        "defaultSlideDurationMs": DEFAULT_SLIDE_DURATION_MS,
        "defaultPlaylistUrl": DEFAULT_PLAYLIST_URL,
        "roomId": ROOM_ID,
        "port": APP_PORT,
        "syncSlides": True,
        "syncMusic": SYNC_MUSIC_ENABLED,
        "alarmsEnabled": ALARMS_ENABLED,
        "alarmMaxDurationSeconds": ALARM_MAX_DURATION_SECONDS,
        "alarmMinVolume": ALARM_MIN_VOLUME,
        "drawingEnabled": DRAWING_ENABLED,
        "drawingLongPressMs": DRAWING_LONG_PRESS_MS,
        "drawingPointBatchMs": DRAWING_POINT_BATCH_MS,
        "drawingPalette": DRAWING_PALETTE,
        "setupEnabled": network_setup.enabled,
        "touchDebugEnabled": TOUCH_DEBUG_ENABLED,
        "setupUrl": f"http://{network_setup.setup_host}:{APP_PORT}",
        "setupHotspotSsid": network_setup.setup_ssid,
        "firebase": {
            "enabled": bool(firebase_config),
            "config": firebase_config,
        },
    }


def build_firebase_sdk_html(enabled):
    if not enabled:
        return ""

    return """
  <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
  <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>
  <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-database.js"></script>
"""


def iso_now():
    return datetime.now(timezone.utc).isoformat()


def asset_url(relative_path: str) -> str:
    asset_path = ROOT / relative_path.lstrip("/")
    try:
        version = int(asset_path.stat().st_mtime)
    except OSError:
        version = int(datetime.now(timezone.utc).timestamp())
    return f"{relative_path}?v={version}"


def append_touch_debug_event(payload):
    if not TOUCH_DEBUG_ENABLED:
        return

    event = dict(payload or {})
    event["serverAt"] = iso_now()
    with touch_debug_lock:
        touch_debug_events.append(event)
        if len(touch_debug_events) > 120:
            del touch_debug_events[:-120]


def get_touch_debug_events():
    with touch_debug_lock:
        return list(touch_debug_events)


def refresh_local_sync_snapshot():
    manifest = load_album_manifest()
    local_fingerprint = manifest["fingerprint"]

    with sync_state_lock:
        sync_state["count"] = len(manifest["images"])
        sync_state["libraryFingerprint"] = local_fingerprint
        room_fingerprint = sync_state["roomLibraryFingerprint"] or local_fingerprint
        sync_state["roomLibraryFingerprint"] = room_fingerprint
        sync_state["inSyncWithRoom"] = room_fingerprint == local_fingerprint
        status = dict(sync_state)

    return manifest, status


def get_sync_status(ok=None):
    _, status = refresh_local_sync_snapshot()
    if ok is None:
        ok = not status["running"] and not status["lastError"]
    status["ok"] = bool(ok)
    return status


def render_index():
    client_config = build_client_config()
    config_json = json.dumps(client_config).replace("</", "<\\/")
    html = HTML.replace("__APP_TITLE__", APP_TITLE)
    html = html.replace("__SANNY_CONFIG__", config_json)
    html = html.replace(
        "__FIREBASE_SDK__",
        build_firebase_sdk_html(client_config["firebase"]["enabled"]),
    )
    html = html.replace("/static/js/firebase.js", asset_url("/static/js/firebase.js"))
    html = html.replace("/static/js/setup.js", asset_url("/static/js/setup.js"))
    html = html.replace("/static/js/presence.js", asset_url("/static/js/presence.js"))
    html = html.replace("/static/js/album.js", asset_url("/static/js/album.js"))
    html = html.replace("/static/js/music.js", asset_url("/static/js/music.js"))
    return html


HTML = """
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>__APP_TITLE__</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --panel: rgba(12, 12, 12, 0.88);
      --panel-strong: rgba(18, 18, 18, 0.95);
      --line: rgba(255, 255, 255, 0.12);
      --text: #f7f7f2;
      --muted: rgba(247, 247, 242, 0.72);
      --accent: #d1b174;
      --danger: #9c4c4c;
      --warn-bg: rgba(209, 177, 116, 0.18);
      --surface: rgba(7, 7, 7, 0.86);
    }
    html, body {
      height: 100%;
      margin: 0;
      background: #040404;
      color: var(--text);
    }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: hidden;
    }
    .stage {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: radial-gradient(circle at top, rgba(209, 177, 116, 0.12), transparent 30%), #040404;
    }
    .slide {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      perspective: 1800px;
      transform-style: preserve-3d;
    }
    .slide img {
      position: absolute;
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      image-orientation: from-image;
      will-change: opacity, transform, filter;
      backface-visibility: hidden;
      transform-style: preserve-3d;
      transform: translate3d(0, 0, 0) rotateX(0deg) rotateY(0deg) rotate(0deg) skewX(0deg) skewY(0deg) scale(1, 1);
      filter: blur(0px);
      opacity: 0;
    }
    .drawing-layer {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      z-index: 6;
      pointer-events: none;
      touch-action: none;
    }
    .drawing-layer.active {
      pointer-events: auto;
    }
    .drawing-toolbar {
      position: absolute;
      left: 18px;
      top: 18px;
      z-index: 10;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      max-width: min(92vw, 760px);
      padding: 12px 14px;
      border-radius: 20px;
      border: 1px solid rgba(209, 177, 116, 0.24);
      background: rgba(7, 7, 7, 0.84);
      backdrop-filter: blur(16px);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.34);
      opacity: 0;
      pointer-events: none;
      transform: translateY(-8px);
      transition: opacity 0.18s ease, transform 0.18s ease;
    }
    .drawing-toolbar.open {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }
    .drawing-toolbar-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
    }
    .drawing-toolbar-copy {
      font-size: 13px;
      color: var(--muted);
      white-space: nowrap;
    }
    .drawing-palette {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .draw-color-button {
      width: 38px;
      min-width: 38px;
      height: 38px;
      padding: 0;
      border-radius: 999px;
      background: var(--swatch-color, rgba(255, 255, 255, 0.15));
      border: 2px solid rgba(255, 255, 255, 0.14);
      box-shadow: inset 0 0 0 1px rgba(4, 4, 4, 0.32);
    }
    .draw-color-button.is-active,
    .draw-color-button[aria-pressed="true"] {
      border-color: rgba(255, 255, 255, 0.92);
      box-shadow: 0 0 0 3px rgba(209, 177, 116, 0.28);
    }
    #imgA {
      opacity: 1;
    }
    @keyframes sanny-photo-enter {
      from {
        opacity: 0;
        transform:
          translate3d(var(--photo-enter-from-x, 0%), var(--photo-enter-from-y, 0%), 0)
          rotateX(var(--photo-enter-from-rotate-x, 0deg))
          rotateY(var(--photo-enter-from-rotate-y, 0deg))
          rotate(var(--photo-enter-from-rotate, 0deg))
          skewX(var(--photo-enter-from-skew-x, 0deg))
          skewY(var(--photo-enter-from-skew-y, 0deg))
          scale(
            var(--photo-enter-from-scale-x, var(--photo-enter-from-scale, 1.02)),
            var(--photo-enter-from-scale-y, var(--photo-enter-from-scale, 1.02))
          );
        filter: blur(var(--photo-enter-from-blur, 0px));
      }
      to {
        opacity: 1;
        transform: translate3d(0, 0, 0) rotateX(0deg) rotateY(0deg) rotate(0deg) skewX(0deg) skewY(0deg) scale(1, 1);
        filter: blur(0px);
      }
    }
    @keyframes sanny-photo-exit {
      from {
        opacity: 1;
        transform: translate3d(0, 0, 0) rotateX(0deg) rotateY(0deg) rotate(0deg) skewX(0deg) skewY(0deg) scale(1, 1);
        filter: blur(0px);
      }
      to {
        opacity: 0;
        transform:
          translate3d(var(--photo-exit-to-x, 0%), var(--photo-exit-to-y, 0%), 0)
          rotateX(var(--photo-exit-to-rotate-x, 0deg))
          rotateY(var(--photo-exit-to-rotate-y, 0deg))
          rotate(var(--photo-exit-to-rotate, 0deg))
          skewX(var(--photo-exit-to-skew-x, 0deg))
          skewY(var(--photo-exit-to-skew-y, 0deg))
          scale(
            var(--photo-exit-to-scale-x, var(--photo-exit-to-scale, 0.985)),
            var(--photo-exit-to-scale-y, var(--photo-exit-to-scale, 0.985))
          );
        filter: blur(var(--photo-exit-to-blur, 0px));
      }
    }
    .setup-shell {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(0, 0, 0, 0.72);
      backdrop-filter: blur(14px);
      z-index: 30;
    }
    .setup-shell.visible {
      display: flex;
    }
    .setup-card {
      width: min(960px, 100%);
      max-height: calc(100vh - 48px);
      overflow-y: auto;
      padding: 24px;
      border-radius: 28px;
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(18, 18, 18, 0.96), rgba(7, 7, 7, 0.98));
      box-shadow: 0 28px 80px rgba(0, 0, 0, 0.48);
    }
    .setup-kicker {
      color: var(--accent);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .setup-title {
      margin: 10px 0 8px;
      font-size: clamp(26px, 4vw, 42px);
      line-height: 1.05;
    }
    .setup-summary,
    .setup-meta,
    .meta {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.5;
    }
    .setup-banner {
      margin-top: 16px;
      padding: 14px 16px;
      border-radius: 18px;
      border: 1px solid rgba(209, 177, 116, 0.28);
      background: var(--warn-bg);
      font-size: 15px;
    }
    .setup-grid {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 18px;
      margin-top: 20px;
    }
    .setup-panel {
      padding: 18px;
      border-radius: 20px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.03);
    }
    .setup-list {
      margin: 0;
      padding-left: 20px;
      color: var(--muted);
      line-height: 1.6;
    }
    .setup-list li + li {
      margin-top: 6px;
    }
    .setup-network-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
      margin-bottom: 12px;
      max-height: 180px;
      overflow-y: auto;
    }
    .network-option {
      width: 100%;
      min-width: 0;
      height: auto;
      padding: 12px 14px;
      border-radius: 14px;
      text-align: left;
      font-size: 14px;
      line-height: 1.4;
      background: rgba(255, 255, 255, 0.05);
    }
    .network-option strong {
      display: block;
      font-size: 14px;
    }
    .network-option span {
      color: var(--muted);
      font-size: 12px;
    }
    .setup-keyboard {
      margin-top: 14px;
      padding: 14px;
      border-radius: 18px;
      border: 1px solid rgba(209, 177, 116, 0.18);
      background: rgba(255, 255, 255, 0.04);
    }
    .setup-keyboard[hidden] {
      display: none;
    }
    .setup-keyboard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    .setup-keyboard-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--muted);
    }
    .setup-keyboard-keys {
      display: grid;
      gap: 8px;
    }
    .setup-keyboard-row {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(var(--setup-key-count, 10), minmax(0, 1fr));
    }
    .setup-key {
      width: 100%;
      min-width: 0;
      height: 46px;
      padding: 0 8px;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 600;
    }
    .setup-key.wide {
      grid-column: span 2;
    }
    .setup-key.extra-wide {
      grid-column: span 3;
    }
    .setup-key.space {
      grid-column: span 4;
    }
    .setup-key.is-active {
      background: rgba(209, 177, 116, 0.22);
      border-color: rgba(209, 177, 116, 0.52);
      color: #f6e7c3;
    }
    .caption-shell {
      position: absolute;
      display: flex;
      justify-content: center;
      left: 0;
      right: 0;
      bottom: 18px;
      padding: 0 16px;
      pointer-events: none;
    }
    .caption {
      max-width: min(80vw, 960px);
      padding: 12px 18px;
      border: 1px solid var(--line);
      background: var(--panel);
      backdrop-filter: blur(10px);
      border-radius: 999px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
      font-size: 20px;
      line-height: 1.4;
      letter-spacing: 0.01em;
    }
    .caption.empty {
      display: none;
    }
    .tray-activator {
      position: absolute;
      top: 0;
      right: 0;
      width: 112px;
      height: 112px;
      z-index: 8;
      touch-action: none;
    }
    .operator-tray {
      position: absolute;
      top: 18px;
      right: 18px;
      width: min(920px, calc(100vw - 32px));
      max-height: calc(100vh - 36px);
      overflow-y: auto;
      padding: 16px;
      border-radius: 22px;
      border: 1px solid var(--line);
      background: var(--panel);
      backdrop-filter: blur(16px);
      box-shadow: 0 22px 60px rgba(0, 0, 0, 0.42);
      opacity: 0;
      pointer-events: none;
      transform: translateY(-6px) translateX(18px);
      transition: opacity 0.2s ease, transform 0.2s ease;
      z-index: 12;
    }
    .operator-tray.open {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0) translateX(0);
    }
    .touch-debug-overlay {
      position: absolute;
      left: 16px;
      bottom: 16px;
      width: min(520px, calc(100vw - 32px));
      max-height: 36vh;
      overflow: auto;
      padding: 12px 14px;
      border-radius: 16px;
      border: 1px solid rgba(209, 177, 116, 0.35);
      background: rgba(7, 7, 7, 0.88);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.38);
      font-size: 12px;
      line-height: 1.45;
      color: #f2e4c4;
      z-index: 40;
      white-space: pre-wrap;
      word-break: break-word;
      pointer-events: none;
    }
    .touch-debug-overlay[hidden] {
      display: none;
    }
    .tray-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .tray-title {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .tray-meta {
      font-size: 13px;
      color: var(--muted);
    }
    .tray-layout {
      display: grid;
      grid-template-columns: 168px minmax(0, 1fr);
      gap: 16px;
      margin-top: 14px;
      min-width: 0;
    }
    .tray-sidebar {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding-right: 2px;
    }
    .tray-nav-button {
      width: 100%;
      min-width: 0;
      justify-content: flex-start;
      border-radius: 16px;
      padding: 0 16px;
      text-align: left;
      font-size: 14px;
    }
    .tray-nav-button.is-active {
      background: rgba(209, 177, 116, 0.22);
      border-color: rgba(209, 177, 116, 0.52);
      color: #f6e7c3;
      box-shadow: inset 0 0 0 1px rgba(209, 177, 116, 0.18);
    }
    .tray-panels {
      min-width: 0;
    }
    .tray-panel {
      display: none;
      min-width: 0;
    }
    .tray-panel.active {
      display: block;
    }
    .tray-panel-header {
      margin-bottom: 12px;
    }
    .tray-panel-title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .tray-panel-copy {
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .tray-section {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--line);
    }
    .tray-panel .tray-section:first-of-type {
      margin-top: 0;
      padding-top: 0;
      border-top: none;
    }
    .section-label {
      margin-bottom: 8px;
      font-size: 14px;
      font-weight: 600;
      color: var(--muted);
    }
    .control-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }
    .control-row + .control-row {
      margin-top: 10px;
    }
    .control-row input[type="text"],
    .control-row input[type="number"],
    .control-row input[type="password"],
    .control-row input[type="time"],
    .control-row select {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
      background: var(--panel-strong);
      color: var(--text);
      outline: none;
      font-size: 14px;
      touch-action: manipulation;
    }
    .control-row input[type="text"],
    .control-row input[type="password"] {
      flex: 1 1 180px;
      min-width: 0;
    }
    .control-row input[type="time"] {
      width: 132px;
      min-width: 132px;
    }
    .control-row select {
      min-width: 180px;
      appearance: none;
    }
    .control-row input[type="number"] {
      width: 88px;
      min-width: 88px;
    }
    .control-row input[type="range"] {
      flex: 1 1 180px;
      min-width: 120px;
      margin: 0;
      accent-color: var(--accent);
      touch-action: manipulation;
    }
    .inline-label {
      min-width: 58px;
      font-size: 13px;
      font-weight: 600;
      color: var(--muted);
    }
    .volume-value {
      min-width: 52px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    button {
      width: auto;
      min-width: 42px;
      height: 42px;
      padding: 0 14px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    button:hover {
      transform: translateY(-1px);
      background: rgba(255, 255, 255, 0.16);
      border-color: rgba(255, 255, 255, 0.22);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.45;
      transform: none;
    }
    .control-button {
      min-width: 68px;
    }
    .control-button.is-active,
    .text-button.is-active,
    button[aria-pressed="true"] {
      background: rgba(209, 177, 116, 0.22);
      border-color: rgba(209, 177, 116, 0.52);
      color: #f6e7c3;
      box-shadow: inset 0 0 0 1px rgba(209, 177, 116, 0.18);
    }
    .control-button.is-active:hover,
    .text-button.is-active:hover,
    button[aria-pressed="true"]:hover {
      background: rgba(209, 177, 116, 0.3);
      border-color: rgba(209, 177, 116, 0.62);
    }
    .close-button {
      min-width: 72px;
      height: 36px;
      font-size: 13px;
    }
    .text-button {
      width: auto;
      min-width: 112px;
      padding: 0 14px;
      border-radius: 12px;
      font-size: 14px;
    }
    .status-danger {
      color: #ffb2b2;
    }
    .status-ok {
      color: #bedbb9;
    }
    .status-warn {
      color: #f1dbad;
    }
    .tray-status {
      margin-top: 8px;
      min-height: 18px;
    }
    .music-playlist {
      margin-top: 12px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.03);
    }
    .music-playlist.empty {
      padding: 12px;
    }
    .music-playlist-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 420px;
      overflow-y: auto;
      padding-right: 4px;
      -webkit-overflow-scrolling: touch;
      touch-action: none;
    }
    .playlist-track-button {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      column-gap: 14px;
      width: 100%;
      min-width: 0;
      min-height: 60px;
      padding: 0 16px;
      border-radius: 16px;
      text-align: left;
      background: rgba(255, 255, 255, 0.05);
      box-sizing: border-box;
      -webkit-appearance: none;
      appearance: none;
      overflow: hidden;
      touch-action: none;
    }
    .playlist-track-button.active {
      background: rgba(209, 177, 116, 0.18);
      border-color: rgba(209, 177, 116, 0.42);
      box-shadow: inset 0 0 0 1px rgba(209, 177, 116, 0.12);
    }
    .playlist-track-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 40px;
      padding: 6px 8px;
      border-radius: 10px;
      background: rgba(209, 177, 116, 0.12);
      border: 1px solid rgba(209, 177, 116, 0.18);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .playlist-track-button.active .playlist-track-badge {
      background: rgba(209, 177, 116, 0.2);
      border-color: rgba(209, 177, 116, 0.3);
      color: #f6e7c3;
    }
    .playlist-track-title {
      display: block;
      margin: 0;
      font-size: 15px;
      line-height: 1.35;
      font-weight: 600;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .playlist-track-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 58px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.06);
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .playlist-track-chip.current {
      background: rgba(209, 177, 116, 0.22);
      border-color: rgba(209, 177, 116, 0.46);
      color: #f6e7c3;
    }
    .alarm-summary {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .alarm-form {
      margin-top: 12px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.03);
    }
    .alarm-days {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .alarm-day-button {
      min-width: 46px;
      height: 38px;
      padding: 0 12px;
      border-radius: 12px;
      font-size: 13px;
      touch-action: manipulation;
    }
    .alarm-note {
      margin-top: 10px;
      font-size: 12px;
      line-height: 1.45;
      color: var(--muted);
    }
    .alarm-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 12px;
      max-height: 320px;
      overflow-y: auto;
      padding-right: 4px;
    }
    .alarm-list.empty {
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.03);
    }
    .alarm-item {
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.03);
    }
    .alarm-item-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .alarm-item-title {
      font-size: 15px;
      font-weight: 700;
      line-height: 1.35;
    }
    .alarm-item-meta {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .alarm-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }
    .alarm-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 60px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.05);
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .alarm-badge.active {
      background: rgba(209, 177, 116, 0.22);
      border-color: rgba(209, 177, 116, 0.46);
      color: #f6e7c3;
    }
    .alarm-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .alarm-actions button {
      min-width: 0;
      height: 36px;
      padding: 0 12px;
      border-radius: 12px;
      font-size: 13px;
    }
    .config-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .config-card {
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.03);
    }
    .config-card-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text);
    }
    .config-card-copy {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .clock-display {
      margin-top: 10px;
      color: var(--text);
      font-size: 21px;
      font-weight: 700;
      line-height: 1.3;
      font-variant-numeric: tabular-nums;
    }
    .config-note {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    @media (max-width: 900px) {
      .caption-shell {
        bottom: 12px;
        padding: 0 12px;
      }
      .caption {
        max-width: 100%;
        font-size: 18px;
      }
      .setup-shell {
        padding: 12px;
      }
      .setup-card {
        padding: 18px;
        border-radius: 22px;
      }
      .setup-grid {
        grid-template-columns: 1fr;
      }
      .setup-keyboard-row {
        grid-template-columns: repeat(var(--setup-key-count-mobile, 5), minmax(0, 1fr));
      }
      .setup-key {
        height: 42px;
        font-size: 14px;
      }
      .setup-key.space {
        grid-column: span 5;
      }
      .operator-tray {
        top: auto;
        right: 12px;
        left: 12px;
        bottom: 12px;
        width: auto;
        max-height: min(70vh, 540px);
      }
      .tray-layout {
        grid-template-columns: 1fr;
      }
      .tray-sidebar {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .config-grid {
        grid-template-columns: 1fr;
      }
      .tray-activator {
        width: 96px;
        height: 96px;
      }
    }
  </style>
  <script>
    window.SANNY_CONFIG = __SANNY_CONFIG__;
    window.addEventListener("error", function (event) {
      var message = event && event.message ? String(event.message) : "script-error";
      document.documentElement.dataset.sannyJsError = message.slice(0, 120);
    });
    window.addEventListener("unhandledrejection", function (event) {
      var reason = event && event.reason ? event.reason : "promise-rejection";
      var message =
        reason && typeof reason === "object" && reason.message
          ? reason.message
          : String(reason || "promise-rejection");
      document.documentElement.dataset.sannyJsRejection = message.slice(0, 120);
    });
  </script>
  __FIREBASE_SDK__
  <script src="/static/js/firebase.js"></script>
</head>
<body>
  <div class="stage" id="stage">
    <div class="slide">
      <img id="imgA" alt="" />
      <img id="imgB" alt="" />
      <canvas id="drawing-layer" class="drawing-layer" aria-hidden="true"></canvas>
      <div id="drawing-toolbar" class="drawing-toolbar" aria-hidden="true">
        <div class="drawing-toolbar-title">Draw Mode</div>
        <div class="drawing-toolbar-copy">Long press anywhere to leave a note.</div>
        <div id="drawing-palette" class="drawing-palette" aria-label="Drawing colors"></div>
        <button id="drawing-undo" type="button" class="text-button" title="Undo your last stroke">Undo</button>
        <button id="drawing-clear" type="button" class="text-button" title="Clear the shared drawing">Clear</button>
        <button id="drawing-done" type="button" class="text-button" title="Leave draw mode">Done</button>
      </div>
    </div>
    <div id="setup-shell" class="setup-shell" aria-hidden="true">
      <div class="setup-card">
        <div class="setup-kicker">Wi-Fi Setup</div>
        <h1 id="setup-title" class="setup-title">Connect this frame to Wi-Fi</h1>
        <div id="setup-summary" class="setup-summary">
          Join the setup Wi-Fi from your phone, then open the local setup page to finish connecting this frame.
        </div>
        <div id="setup-banner" class="setup-banner">
          Waiting for the setup hotspot to come online...
        </div>
        <div class="setup-grid">
          <section class="setup-panel">
            <div class="section-label">How It Works</div>
            <ol class="setup-list">
              <li>On your phone, join <strong id="setup-ssid">Sanny Setup</strong>.</li>
              <li>Open <strong id="setup-url">http://192.168.4.1</strong>.</li>
              <li>Pick your home Wi-Fi, enter the password, and wait for this frame to reconnect.</li>
            </ol>
            <div id="setup-meta" class="setup-meta" style="margin-top:14px;">
              Checking the local network state...
            </div>
          </section>
          <section class="setup-panel">
            <div class="section-label">Available Networks</div>
            <div id="setup-network-list" class="setup-network-list">
              <div class="meta">No scan results yet.</div>
            </div>
            <div class="control-row">
              <input id="setup-ssid-input" type="text" placeholder="Wi-Fi name (SSID)" />
            </div>
            <div class="control-row">
              <input id="setup-password" type="password" placeholder="Wi-Fi password" />
            </div>
            <div class="control-row">
              <button id="setup-refresh" class="text-button">Scan</button>
              <button id="setup-connect" class="text-button">Connect</button>
              <button id="setup-hotspot-toggle" class="text-button">Open Setup Wi-Fi</button>
              <button id="setup-close" class="text-button">Hide Setup</button>
            </div>
            <div id="setup-keyboard" class="setup-keyboard" hidden>
              <div class="setup-keyboard-header">
                <div id="setup-keyboard-title" class="setup-keyboard-title">Touch keyboard</div>
                <button id="setup-keyboard-hide" class="text-button">Hide Keyboard</button>
              </div>
              <div id="setup-keyboard-keys" class="setup-keyboard-keys"></div>
            </div>
          </section>
        </div>
      </div>
    </div>
    <div id="tray-activator" class="tray-activator" aria-hidden="true"></div>
    <div class="caption-shell">
      <div id="caption" class="caption empty"></div>
    </div>
    <pre id="touch-debug-overlay" class="touch-debug-overlay" hidden>Touch debug inactive.</pre>
    <aside id="operator-tray" class="operator-tray" aria-hidden="true">
      <div class="tray-header">
        <div>
          <div class="tray-title">Operator</div>
          <div id="tray-context" class="tray-meta">Local appliance mode</div>
        </div>
        <button id="tray-close" type="button" class="close-button" title="Close controls">Close</button>
      </div>
      <div class="tray-layout">
        <nav class="tray-sidebar" aria-label="Control sections">
          <button class="tray-nav-button is-active" data-tray-panel-target="slideshow" aria-pressed="true">Slideshow</button>
          <button class="tray-nav-button" data-tray-panel-target="music" aria-pressed="false">Music</button>
          <button class="tray-nav-button" data-tray-panel-target="alarm" aria-pressed="false">Alarm</button>
          <button class="tray-nav-button" data-tray-panel-target="configuration" aria-pressed="false">Configuration</button>
        </nav>
        <div class="tray-panels">
          <section class="tray-panel active" data-tray-panel="slideshow">
            <div class="tray-panel-header">
              <div class="tray-panel-title">Slideshow</div>
              <div class="tray-panel-copy">Control slide timing, shuffle behavior, and navigation for the current album.</div>
            </div>
            <div class="tray-section">
              <div class="control-row">
                <button id="prev" class="control-button" title="Previous slide">Prev</button>
                <button id="pause" class="control-button" title="Pause slideshow">Pause</button>
                <button id="play" class="control-button" title="Play slideshow">Play</button>
                <button id="next" class="control-button" title="Next slide">Next</button>
                <button id="shuffle" class="control-button" title="Shuffle slides">Shuffle</button>
                <div id="slide-position" class="meta">0 / 0</div>
              </div>
              <div class="control-row">
                <div class="section-label" style="margin:0;">Seconds</div>
                <input id="slide-duration" type="number" min="3" max="120" step="1" value="10" />
              </div>
            </div>
          </section>
          <section class="tray-panel" data-tray-panel="music">
            <div class="tray-panel-header">
              <div class="tray-panel-title">Music</div>
              <div class="tray-panel-copy">Manage the shared playlist, transport controls, volume, and track selection.</div>
            </div>
            <div class="tray-section">
              <div id="music-title" class="meta">No music loaded.</div>
              <div id="music-queue" class="meta">Queue 0 / 0</div>
              <div class="control-row">
                <button id="btn-mute" class="control-button" title="Mute music">Mute</button>
                <button id="btn-prev" class="control-button" title="Previous track">Prev</button>
                <button id="btn-toggle" class="control-button" title="Play or pause music">Pause</button>
                <button id="btn-next" class="control-button" title="Next track">Next</button>
                <button id="btn-shuffle" class="control-button" title="Toggle shared music shuffle">Shuffle</button>
              </div>
              <div class="control-row">
                <div class="inline-label">Volume</div>
                <input id="music-volume" type="range" min="0" max="100" step="1" value="80" />
                <div id="music-volume-value" class="meta volume-value">80%</div>
              </div>
              <div class="control-row">
                <input id="playlist-url" type="text" placeholder="Playlist or video URL" />
                <button id="load-playlist" class="text-button">Load Music</button>
              </div>
              <div class="section-label" style="margin-top: 12px;">Tracks</div>
              <div id="music-playlist" class="music-playlist empty">
                <div class="meta">Load a playlist to choose a song.</div>
              </div>
            </div>
          </section>
          <section class="tray-panel" data-tray-panel="alarm">
            <div class="tray-panel-header">
              <div class="tray-panel-title">Alarm</div>
              <div class="tray-panel-copy">Create recurring alarms that wake the frame with the current music source.</div>
            </div>
            <div class="tray-section">
              <div class="alarm-summary">
                <div id="next-alarm-summary" class="meta">No alarms set.</div>
                <button id="dismiss-alarm" class="text-button" title="Dismiss active alarms" disabled>Dismiss Alarm</button>
              </div>
              <div id="alarm-status" class="meta tray-status">Local alarms stay on this device.</div>
              <div class="alarm-form">
                <div class="control-row">
                  <input id="alarm-time" type="time" value="07:00" />
                  <button id="alarm-shared" class="text-button" aria-pressed="false" title="Toggle shared alarm">Local Only</button>
                  <button id="alarm-enabled" class="text-button is-active" aria-pressed="true" title="Toggle enabled">Enabled</button>
                  <button id="alarm-one-time" class="text-button" aria-pressed="false" title="Toggle one-time alarm">Recurring</button>
                  <button id="alarm-save" class="text-button">Save Alarm</button>
                  <button id="alarm-cancel" class="text-button" title="Cancel editing" hidden>Cancel</button>
                </div>
                <div id="alarm-days" class="alarm-days" aria-label="Alarm days"></div>
                <div id="alarm-shared-note" class="alarm-note">Shared alarms need connected room sync.</div>
              </div>
              <div class="section-label" style="margin-top: 12px;">Alarm List</div>
              <div id="alarm-list" class="alarm-list empty">
                <div class="meta">No alarms set yet.</div>
              </div>
            </div>
          </section>
          <section class="tray-panel" data-tray-panel="configuration">
            <div class="tray-panel-header">
              <div class="tray-panel-title">Configuration</div>
              <div class="tray-panel-copy">Connection, sync, Wi-Fi, and browser-level controls for the frame.</div>
            </div>
            <div class="tray-section">
              <div class="config-grid">
                <div class="config-card">
                  <div class="config-card-title">Frame Status</div>
                  <div id="sync-status" class="config-card-copy">No sync activity yet.</div>
                </div>
                <div class="config-card">
                  <div class="config-card-title">Current Mode</div>
                  <div class="config-card-copy">Use this panel for Google Drive sync, Wi-Fi setup, and a quick browser refresh.</div>
                </div>
                <div class="config-card">
                  <div class="config-card-title">Clock &amp; Time Zone</div>
                  <div class="config-card-copy">Current frame time</div>
                  <div id="frame-time-display" class="clock-display">Frame time will appear here.</div>
                  <div class="control-row" style="margin-top: 10px;">
                    <div class="inline-label">Zone</div>
                    <select id="frame-timezone" aria-label="Frame time zone">
                      <option value="America/Los_Angeles">PT</option>
                      <option value="America/Denver">MT</option>
                      <option value="America/Chicago">CT</option>
                      <option value="America/New_York">ET</option>
                    </select>
                  </div>
                  <div id="frame-timezone-note" class="config-note">Alarm times on this frame follow this setting.</div>
                </div>
              </div>
              <div class="control-row" style="margin-top: 14px;">
                <button id="sync-drive" class="text-button" title="Sync photos from Google Drive">Sync Now</button>
                <button id="wifi-setup" class="text-button" title="Open Wi-Fi setup">Wi-Fi Setup</button>
                <button id="reload-browser" class="text-button" title="Reload the browser">Reload</button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </aside>
  </div>
  <script src="/static/js/setup.js"></script>
  <script src="/static/js/presence.js"></script>
  <script src="/static/js/album.js"></script>
  <script src="/static/js/music.js"></script>
  <script>
    if (window.SannyMusicBootstrap) {
      window.SannyMusicBootstrap();
    }
  </script>
</body>
</html>
"""


@app.route("/")
def index():
    return render_index()


@app.route("/album.json", methods=["GET"])
def album_json():
    return jsonify(load_album_manifest())


@app.route("/images/<path:filename>", methods=["GET"])
def image_file(filename):
    if (IMAGES_DIR / filename).exists():
        return send_from_directory(IMAGES_DIR, filename)
    if (LEGACY_IMAGES_DIR / filename).exists():
        return send_from_directory(LEGACY_IMAGES_DIR, filename)
    return send_from_directory(IMAGES_DIR, filename)


@app.route("/setup/status", methods=["GET"])
def setup_status():
    return jsonify(network_setup.status())


@app.route("/setup/networks", methods=["GET"])
def setup_networks():
    try:
        networks = network_setup.list_networks(rescan=request.args.get("rescan", "1") != "0")
        return jsonify(ok=True, networks=networks, error="")
    except Exception as exc:
        logging.exception("Could not list setup networks")
        return jsonify(ok=False, networks=[], error=str(exc)), 500


@app.route("/setup/connect", methods=["POST"])
def setup_connect():
    data = request.get_json(force=True, silent=True) or {}
    ssid = (data.get("ssid") or "").strip()
    password = data.get("password") or ""

    if not ssid:
        return jsonify(ok=False, connected=False, currentSsid="", error="ssid is required"), 400

    try:
        status = network_setup.connect(ssid, password=password)
        return jsonify(
            ok=bool(status.get("connected")),
            connected=bool(status.get("connected")),
            currentSsid=status.get("currentSsid", ""),
            error="" if status.get("connected") else status.get("lastError", ""),
        )
    except Exception as exc:
        logging.exception("Could not connect setup Wi-Fi")
        return jsonify(ok=False, connected=False, currentSsid="", error=str(exc)), 500


@app.route("/setup/hotspot", methods=["POST"])
def setup_hotspot():
    data = request.get_json(force=True, silent=True) or {}
    enabled = bool(data.get("enabled", True))

    try:
        status = network_setup.enable_hotspot() if enabled else network_setup.disable_hotspot()
        return jsonify(
            ok=True,
            hotspotActive=bool(status.get("hotspotActive")),
            setupSsid=status.get("setupSsid", ""),
            error="",
        )
    except Exception as exc:
        logging.exception("Could not toggle setup hotspot")
        return jsonify(ok=False, hotspotActive=False, setupSsid=network_setup.setup_ssid, error=str(exc)), 500


@app.route("/debug/touch", methods=["GET", "POST"])
def debug_touch():
    if not TOUCH_DEBUG_ENABLED:
        return jsonify(ok=False, enabled=False, events=[]), 404

    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        append_touch_debug_event(data)
        return jsonify(ok=True, enabled=True, count=len(get_touch_debug_events()))

    clear_requested = request.args.get("clear", "0") == "1"
    if clear_requested:
        with touch_debug_lock:
            touch_debug_events.clear()
    return jsonify(ok=True, enabled=True, events=get_touch_debug_events())


@app.route("/sync/status", methods=["GET"])
def sync_status():
    return jsonify(get_sync_status())


@app.route("/sync/room-meta", methods=["POST"])
def sync_room_meta():
    data = request.get_json(force=True, silent=True) or {}
    room_fingerprint = (data.get("roomLibraryFingerprint") or "").strip()
    in_sync_with_room = data.get("inSyncWithRoom")

    with sync_state_lock:
        if room_fingerprint:
            sync_state["roomLibraryFingerprint"] = room_fingerprint
        if isinstance(in_sync_with_room, bool):
            sync_state["inSyncWithRoom"] = in_sync_with_room

    return jsonify(get_sync_status())


@app.route("/sync/drive", methods=["POST"])
def sync_drive():
    with sync_state_lock:
        if sync_state["running"]:
            return jsonify(get_sync_status(ok=False)), 409
        sync_state["running"] = True
        sync_state["changed"] = False
        sync_state["lastError"] = ""
        sync_state["lastWarning"] = ""

    try:
        result = sync_drive_photos()
    except Exception as exc:
        logging.exception("Drive sync failed")
        with sync_state_lock:
            sync_state["running"] = False
            sync_state["changed"] = False
            sync_state["lastError"] = str(exc)
            sync_state["lastWarning"] = ""
        return jsonify(get_sync_status(ok=False)), 500

    with sync_state_lock:
        sync_state["running"] = False
        sync_state["count"] = result["count"]
        sync_state["changed"] = result["changed"]
        sync_state["lastSuccessAt"] = iso_now()
        sync_state["lastError"] = ""
        sync_state["lastWarning"] = (result.get("warning") or "").strip()
        sync_state["libraryFingerprint"] = result["fingerprint"]
        room_fingerprint = sync_state["roomLibraryFingerprint"] or result["fingerprint"]
        sync_state["roomLibraryFingerprint"] = room_fingerprint
        sync_state["inSyncWithRoom"] = room_fingerprint == result["fingerprint"]

    return jsonify(get_sync_status(ok=True))


@app.route("/healthz", methods=["GET"])
def healthz():
    album_manifest = load_album_manifest()
    album_count = len(album_manifest["images"])
    music_state = player.status()
    sync_status_data = get_sync_status()
    music_failed = bool(music_state.get("lastError") and music_state.get("track"))
    ok = album_count > 0 and not sync_status_data["lastError"] and not music_failed

    return jsonify(
        ok=ok,
        albumCount=album_count,
        musicRunning=bool(music_state.get("running")),
        lastSyncAt=sync_status_data["lastSuccessAt"],
    )


@app.route("/music/playlist", methods=["POST"])
def music_playlist():
    data = request.get_json(force=True, silent=True) or {}
    playlist_url = (data.get("playlist_url") or "").strip()
    playlist_items = data.get("playlist_items")
    start_index = int(data.get("start_index", 0))
    paused = bool(data.get("paused", False))

    if not playlist_url and not isinstance(playlist_items, list):
        return jsonify(ok=False, error="playlist_url or playlist_items is required"), 400

    if playlist_url:
        logging.info("Loading playlist: %s", playlist_url)
    else:
        logging.info("Loading resolved playlist with %s items", len(playlist_items or []))
    try:
        if isinstance(playlist_items, list) and playlist_items:
            playlist = player.set_playlist_items(playlist_items)
        else:
            playlist = player.load_playlist(playlist_url)
        if not playlist:
            return jsonify(ok=False, error="Playlist is empty"), 400
        now = player.play_index(start_index, paused=paused)
        return jsonify(ok=True, playlist=playlist, now=now, status=player.status())
    except Exception as exc:
        logging.exception("Error loading playlist")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/play_cached", methods=["POST"])
def music_play_cached():
    data = request.get_json(force=True, silent=True) or {}
    index = data.get("index")
    paused = bool(data.get("paused", False))

    if index is None:
        return jsonify(ok=False, error="index is required"), 400

    try:
        now = player.play_index(int(index), paused=paused)
        return jsonify(ok=True, now=now, status=player.status())
    except Exception as exc:
        logging.exception("Error in play_cached")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/next", methods=["POST"])
def music_next():
    try:
        now = player.next_track()
        return jsonify(ok=True, now=now, status=player.status())
    except Exception as exc:
        logging.exception("Error in next_track")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/prev", methods=["POST"])
def music_prev():
    try:
        now = player.prev_track()
        return jsonify(ok=True, now=now, status=player.status())
    except Exception as exc:
        logging.exception("Error in prev_track")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/pause", methods=["POST"])
def music_pause():
    data = request.get_json(force=True, silent=True) or {}
    paused = bool(data.get("paused", True))

    try:
        status = player.set_pause(paused)
        return jsonify(ok=True, paused=status.get("paused", paused), status=player.status())
    except Exception as exc:
        logging.exception("Error in set_pause")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/toggle", methods=["POST"])
def music_toggle():
    try:
        status = player.toggle_pause()
        return jsonify(ok=True, paused=status.get("paused"), status=player.status())
    except Exception as exc:
        logging.exception("Error in toggle_pause")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/mute", methods=["POST"])
def music_mute():
    data = request.get_json(force=True, silent=True) or {}
    mute = bool(data.get("mute", True))

    try:
        status = player.mute(mute)
        return jsonify(ok=True, muted=status.get("muted", mute), status=player.status())
    except Exception as exc:
        logging.exception("Error in mute")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/volume", methods=["POST"])
def music_volume():
    data = request.get_json(force=True, silent=True) or {}
    volume = data.get("volume")

    if volume is None:
        return jsonify(ok=False, error="volume is required"), 400

    try:
        volume = float(volume)
    except (TypeError, ValueError):
        return jsonify(ok=False, error="volume must be numeric"), 400

    try:
        status = player.set_volume(volume)
        return jsonify(ok=True, volume=status.get("volume"), status=player.status())
    except Exception as exc:
        logging.exception("Error in set_volume")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/seek", methods=["POST"])
def music_seek():
    data = request.get_json(force=True, silent=True) or {}
    position_seconds = data.get("positionSeconds")

    if position_seconds is None:
        return jsonify(ok=False, error="positionSeconds is required"), 400

    try:
        position_seconds = float(position_seconds)
    except (TypeError, ValueError):
        return jsonify(ok=False, error="positionSeconds must be numeric"), 400

    try:
        result = player.seek(position_seconds)
        return jsonify(ok=True, positionSeconds=result.get("positionSeconds"), status=player.status())
    except Exception as exc:
        logging.exception("Error in seek")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/stop", methods=["POST"])
def music_stop():
    try:
        status = player.stop()
        return jsonify(ok=True, status=status)
    except Exception as exc:
        logging.exception("Error in stop")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/status", methods=["GET"])
def music_status():
    try:
        status = player.status()
        status.setdefault("ok", True)
        return jsonify(status)
    except Exception as exc:
        logging.exception("Error in status")
        return jsonify(ok=False, error=str(exc)), 500


get_sync_status()


if __name__ == "__main__":
    logging.info("Starting %s on port %d", APP_TITLE, APP_PORT)
    app.run(host="0.0.0.0", port=APP_PORT, debug=APP_DEBUG)
