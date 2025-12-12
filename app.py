#!/usr/bin/env python3
import logging
import os

from flask import Flask, request, jsonify

from music_player import MPVPlayer  # assumes music_player.py is in the same folder

# ------------------------------------------------------------------------------
# Logging
# ------------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)

# ------------------------------------------------------------------------------
# Flask app
# ------------------------------------------------------------------------------
app = Flask(__name__, static_folder="static", static_url_path="/static")

# Global music player instance
player = MPVPlayer()

# ------------------------------------------------------------------------------
# HTML UI
# ------------------------------------------------------------------------------

HTML = """
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Sanny Photos</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />

  <style>
    html, body {
      height: 100%;
      margin: 0;
      background: #000;
      color: #fff;
    }
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    }
    .stage {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
      background: #000;
    }
    img {
      position: absolute;
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      transition: opacity 0.5s linear;
    }
    #imgA { opacity: 1; }
    #imgB { opacity: 0; }

    #music-overlay {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      background: rgba(0,0,0,0.75);
      color: #fff;
      font-size: 18px;
      z-index: 9999;
    }
    #music-overlay input {
      width: 260px;
    }
    .tbtn {
      width: 44px;
      height: 44px;
      border: none;
      border-radius: 50%;
      background: rgba(255,255,255,0.15);
      color: #fff;
      font-size: 20px;
      cursor: pointer;
    }
    .tbtn:hover {
      background: rgba(255,255,255,0.3);
    }
  </style>

  <!-- Firebase SDK v8 -->
  <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
  <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>
  <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-database.js"></script>

  <!-- Our Firebase wrapper -->
  <script src="/static/js/firebase.js"></script>
</head>
<body>
  <!-- MUSIC OVERLAY -->
  <div id="music-overlay">
    <div>
      <span>🎵</span> <span id="music-title">No music</span>
    </div>
    <div>
      <button id="btn-mute">🔊</button>
      <button id="btn-prev">⏮️</button>
      <button id="btn-toggle">⏯️</button>
      <button id="btn-next">⏭️</button>
      <input id="playlist-url" placeholder="YouTube playlist URL" />
      <button id="load-playlist">Refresh</button>
    </div>
  </div>

  <!-- SLIDESHOW -->
  <div class="stage">
    <img id="imgA" alt="" />
    <img id="imgB" alt="" />
    <div style="position:absolute;bottom:20px;left:50%;transform:translateX(-50%);display:flex;gap:12px;">
      <button id="prev" class="tbtn">⏮️</button>
      <button id="pause" class="tbtn">⏸️</button>
      <button id="play" class="tbtn">▶️</button>
      <button id="next" class="tbtn">⏭️</button>
      <button id="shuffle" class="tbtn">🔀</button>
    </div>
  </div>

  <!-- Presence, album, music logic -->
  <script src="/static/js/presence.js"></script>
  <script src="/static/js/album.js"></script>
  <script src="/static/js/music.js"></script>
</body>
</html>
"""

# ------------------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------------------


@app.route("/")
def index():
    """Serve the main UI."""
    return HTML


# --- MUSIC API ---------------------------------------------------------------

@app.route("/music/playlist", methods=["POST"])
def music_playlist():
    """
    Load a YouTube playlist and start playing from the first track.

    Expected JSON body: { "playlist_url": "<url>" }
    Returns: { ok: bool, error?: str, playlist?: [...], now?: {...} }
    """
    data = request.get_json(force=True, silent=True) or {}
    playlist_url = data.get("playlist_url")

    if not playlist_url:
        return jsonify(ok=False, error="playlist_url is required"), 400

    logging.info("Loading playlist: %s", playlist_url)
    try:
        # Assumes MusicPlayer has a method like: load_playlist(url) -> list of dicts
        playlist = player.load_playlist(playlist_url)

        if not playlist:
            return jsonify(ok=False, error="Empty playlist"), 400

        # Start with first track
        now = player.play_index(0) if hasattr(player, "play_index") else None
        if not now:
            # Fallback if play_index doesn't return metadata
            now = {
                "index": 0,
                "title": playlist[0].get("title"),
                "url": playlist[0].get("url"),
            }

        return jsonify(ok=True, playlist=playlist, now=now)
    except Exception as exc:
        logging.exception("Error loading playlist")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/next", methods=["POST"])
def music_next():
    """Skip to the next track."""
    try:
        now = player.next_track()
        return jsonify(ok=True, now=now)
    except Exception as exc:
        logging.exception("Error in next_track")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/prev", methods=["POST"])
def music_prev():
    """Go to the previous track."""
    try:
        now = player.prev_track()
        return jsonify(ok=True, now=now)
    except Exception as exc:
        logging.exception("Error in prev_track")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/toggle", methods=["POST"])
def music_toggle():
    """Toggle play/pause."""
    try:
        status = player.toggle_pause()
        # Expect status to include a 'paused' field; if not, we patch it.
        paused = status.get("paused") if isinstance(status, dict) else None
        return jsonify(ok=True, paused=paused)
    except Exception as exc:
        logging.exception("Error in toggle_pause")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/mute", methods=["POST"])
def music_mute():
    """
    Mute or unmute audio.

    Expected JSON body: { "mute": true/false }
    """
    data = request.get_json(force=True, silent=True) or {}
    mute = bool(data.get("mute", True))
    try:
        status = player.mute(mute)
        # Expect status to include 'muted', otherwise patch:
        muted = status.get("muted") if isinstance(status, dict) else mute
        return jsonify(ok=True, muted=muted)
    except Exception as exc:
        logging.exception("Error in mute()")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/status", methods=["GET"])
def music_status():
    """Return basic status info from the music player."""
    try:
        status = player.status()
        # Ensure 'ok' + 'paused' keys exist for frontend
        if isinstance(status, dict):
            status.setdefault("ok", True)
        else:
            status = {"ok": True}
        return jsonify(status)
    except Exception as exc:
        logging.exception("Error in status()")
        return jsonify(ok=False, error=str(exc)), 500


@app.route("/music/play_cached", methods=["POST"])
def music_play_cached():
    """
    Play a track by index from the already loaded playlist.

    Expected JSON body: { "index": <int> }
    """
    data = request.get_json(force=True, silent=True) or {}
    index = data.get("index")
    if index is None:
        return jsonify(ok=False, error="index is required"), 400

    try:
        now = player.play_index(int(index))
        if not isinstance(now, dict):
            now = {"index": int(index)}
        # Ensure 'title' is present if possible
        return jsonify(ok=True, **now)
    except Exception as exc:
        logging.exception("Error in play_cached / play_index")
        return jsonify(ok=False, error=str(exc)), 500


# ------------------------------------------------------------------------------
# Main entry
# ------------------------------------------------------------------------------

if __name__ == "__main__":
    # Host 0.0.0.0 so your Pi is reachable on the LAN
    port = int(os.environ.get("PORT", "5000"))
    logging.info("Starting Sanny Photos Flask app on port %d", port)
    app.run(host="0.0.0.0", port=port, debug=True)

