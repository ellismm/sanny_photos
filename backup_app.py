"""Legacy prototype kept for reference only.

Run app.py for the current slideshow server.
"""

from flask import Flask, render_template_string, jsonify, request
from flask_cors import CORS
import os, json, logging
from music_player import player  # <- your mpv controller

# -----------------------------------------------------------
# Flask setup
# -----------------------------------------------------------
app = Flask(__name__, static_folder="static", static_url_path="/static")
CORS(app, resources={r"/music/*": {"origins": "*"}})

import subprocess

def is_video_playable(video_url):
    """
    Returns True if yt-dlp can extract an audio stream URL for this video.
    """
    try:
        # Run yt-dlp in info JSON mode
        cmd = [
            "/usr/local/bin/yt-dlp",
            "--quiet",
            "--no-warnings",
            "-f", "bestaudio",
            "--cookies", "/home/messay/coding/own/sanny_photos/ytdlp_cookies.txt",
            "--get-url",
            video_url,
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        # If stdout is non-empty and no "Sign in" or "ERROR" appears, it’s playable
        out = result.stdout.decode().strip()
        err = result.stderr.decode().strip()
        if out.startswith("https://") and "Sign in" not in err and "ERROR" not in err:
            return True
        return False
    except Exception as e:
        print(f"Playable test failed for {video_url}: {e}")
        return False


@app.after_request
def add_cors_headers(response):
    response.headers.add("Access-Control-Allow-Origin", "*")
    response.headers.add("Access-Control-Allow-Headers", "Content-Type,Authorization")
    response.headers.add("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    return response

# -----------------------------------------------------------
# Paths and constants
# -----------------------------------------------------------
ROOT = "/home/messay/coding/own/sanny_photos"
IMAGE_FOLDER = os.path.join(ROOT, "static/images")
ALBUM_JSON = os.path.join(ROOT, "static/album.json")

current_playlist = []
current_index = -1


# -----------------------------------------------------------
# Music routes
# -----------------------------------------------------------


def _start_track(i: int):
    global current_index, current_playlist
    if not current_playlist:
        raise ValueError("No playlist loaded")
    if i < 0 or i >= len(current_playlist):
        raise IndexError("Track index out of range")
    current_index = i
    url = current_playlist[i]["url"]
    player.play(url)
    return {"index": current_index, "title": current_playlist[i]["title"]}


@app.route("/music/playlist", methods=["POST"])
def music_playlist():
    import yt_dlp

    logging.basicConfig(level=logging.DEBUG)
    logger = logging.getLogger("music_playlist")

    global current_playlist

    data = request.get_json()
    playlist_url = data.get("playlist_url")
    if not playlist_url:
        return jsonify({"ok": False, "error": "No playlist_url provided"}), 400

    ydl_opts = {
        "quiet": True,
        "skip_download": True,
        "extract_flat": True,
        "forceurl": True,
        "simulate": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            logger.info(f"Extracting info for playlist URL: {playlist_url}")
            info = ydl.extract_info(playlist_url, download=False)
            entries = info.get("entries", [])
            playlist = []
            for entry in entries:
              title = entry.get("title")
              url = entry.get("url")
              if title and url:
                  if not url.startswith("http"):
                      url = f"https://www.youtube.com/watch?v={url}"
                  # Test video accessibility
                  if is_video_playable(url):
                      playlist.append({"title": title, "url": url})
                  else:
                      logging.warning(f"Skipping restricted or broken video: {title} ({url})")


            current_playlist = playlist
            logger.info(f"Playlist extracted with {len(playlist)} entries")

            # Play first track automatically
            if playlist:
              info = _start_track(0)
              logger.info(f"Playing first track via mpv: {playlist[0]['url']}")
              return jsonify({"ok": True, "playlist": playlist, "now": info})

            return jsonify({"ok": True, "playlist": playlist})

    except Exception as e:
        logger.error(f"Error in music_playlist: {e}", exc_info=True)
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/music/play_cached", methods=["POST"])
def play_cached():
    global current_playlist

    data = request.get_json()
    index = data.get("index")
    if index is None:
        return jsonify({"ok": False, "error": "No index provided"}), 400

    try:
        index = int(index)
        if index < 0 or index >= len(current_playlist):
            return jsonify({"ok": False, "error": "Index out of range"}), 400

        track = current_playlist[index]
        url = track.get("url")
        if not url:
            return jsonify({"ok": False, "error": "No URL for track"}), 400

        player.play(url)
        return jsonify({"ok": True, "title": track.get("title", "Track")})

    except Exception as e:
        logging.error(f"Error in play_cached: {e}", exc_info=True)
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/music/shuffle", methods=["POST"])
def shuffle_playlist():
    global current_playlist
    import random
    if not current_playlist:
        return jsonify({"ok": False, "error": "No playlist to shuffle"}), 400
    random.shuffle(current_playlist)
    return jsonify({"ok": True, "playlist": current_playlist})


# -----------------------------------------------------------
# Helper: rebuild album.json from images folder
# -----------------------------------------------------------
@app.route("/refresh_album")
def refresh_album():
    try:
        images = [
            {"url": f"images/{f}"}
            for f in sorted(os.listdir(IMAGE_FOLDER))
            if f.lower().endswith((".jpg", ".jpeg", ".png"))
        ]
        with open(ALBUM_JSON, "w") as f:
            json.dump({"images": images}, f, indent=2)
        return jsonify({"ok": True, "count": len(images)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})
    

@app.route("/music/next", methods=["POST"])
def music_next():
    try:
        global current_index, current_playlist
        if not current_playlist:
            return jsonify({"ok": False, "error": "No playlist"}), 400
        i = 0 if current_index == -1 else (current_index + 1) % len(current_playlist)
        info = _start_track(i)
        return jsonify({"ok": True, "now": info})
    except Exception as e:
        logging.exception("music_next failed")
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/music/prev", methods=["POST"])
def music_prev():
    try:
        global current_index, current_playlist
        if not current_playlist:
            return jsonify({"ok": False, "error": "No playlist"}), 400
        i = len(current_playlist)-1 if current_index == -1 else (current_index - 1 + len(current_playlist)) % len(current_playlist)
        info = _start_track(i)
        return jsonify({"ok": True, "now": info})
    except Exception as e:
        logging.exception("music_prev failed")
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/music/toggle", methods=["POST"])
def music_toggle():
    try:
        player.toggle_pause()
        return jsonify({"ok": True, "paused": player.paused})
    except Exception as e:
        logging.exception("music_toggle failed")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/music/status", methods=["GET"])
def music_status():
    try:
        global current_index, current_playlist
        title = current_playlist[current_index]["title"] if (0 <= current_index < len(current_playlist)) else "No music"
        return jsonify({
            "ok": True,
            "index": current_index,
            "title": title,
            "paused": getattr(player, "paused", False)
        })
    except Exception as e:
        logging.exception("music_status failed")
        return jsonify({"ok": False, "error": str(e)}), 500


# -----------------------------------------------------------
# HTML / Frontend
# -----------------------------------------------------------
HTML = """
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sanny Photos</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html,body { height:100%; margin:0; background:#000; color:#fff; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
    .stage {
      position:relative; width:100%; height:100%;
      display:flex; justify-content:center; align-items:center;
      overflow:hidden; background:#000;
    }
    img {
      position:absolute; max-width:100%; max-height:100%;
      object-fit:contain; transition:opacity 0.5s linear;
    }
    #imgA { opacity:1; }
    #imgB { opacity:0; }

    .overlay { position:absolute; inset:0; z-index:10; pointer-events:none; }
    .toolbar {
      position:absolute; bottom:16px; left:50%; transform:translateX(-50%);
      display:flex; gap:10px; background:rgba(0,0,0,0.6);
      padding:8px 14px; border-radius:999px; pointer-events:auto;
    }
    .tbtn {
      width:44px; height:44px; border:none; border-radius:50%;
      background:rgba(255,255,255,0.15); color:#fff; font-size:20px; cursor:pointer;
    }
    .tbtn:hover { background:rgba(255,255,255,0.3); }

    #music-overlay {
      position: fixed; left: 0; right: 0; bottom: 0;
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 14px; background: rgba(0, 0, 0, 0.75);
      color: #fff; font-size: 18px; z-index: 9999;
    }
    #music-overlay input { width: 280px; }
  </style>
</head>
<body>

  <!-- Music overlay -->
  <div id="music-overlay">
    <div>
      <span>🎵</span> <span id="music-title">No music</span>
    </div>
    <div>
      <button id="btn-mute">🔊</button>
      <button id="btn-prev">⏮️</button>
      <button id="btn-toggle">⏯️</button>
      <button id="btn-next">⏭️</button>
      <input id="playlist-url" placeholder="YouTube playlist URL">
      <button id="load-playlist">Load</button>
    </div>
  </div>

  <!-- Slideshow -->
  <div class="stage">
    <img id="imgA" alt="">
    <img id="imgB" alt="">
    <div class="toolbar">
      <button id="prev" class="tbtn">⏮️</button>
      <button id="pause" class="tbtn">⏸️</button>
      <button id="play" class="tbtn">▶️</button>
      <button id="next" class="tbtn">⏭️</button>
      <button id="shuffle" class="tbtn">🔀</button>
    </div>
  </div>

  <script>
    function setTitle(t) {
      document.getElementById("music-title").textContent = t || "No music";
    }

    async function postJSON(url, body={}) {
      const res = await fetch(url, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify(body)
      });
      return res.json();
    }

    window.addEventListener("load", () => {
      // Load initial playlist (keep your URL or input box)
      const defaultPlaylist = "https://www.youtube.com/playlist?list=PLcFTWWe4qhjz7HsajwpVjMkFchD3FdxNR";
      fetch("/music/playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playlist_url: defaultPlaylist }),
      })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          const title = data.now?.title || (data.playlist?.[0]?.title) || "No music";
          setTitle(title);
        } else {
          console.error("Playlist load failed:", data.error);
        }
      });

      // Controls
      document.getElementById("btn-next").onclick = async () => {
        const r = await postJSON("/music/next");
        if (r.ok) setTitle(r.now.title);
      };
      document.getElementById("btn-prev").onclick = async () => {
        const r = await postJSON("/music/prev");
        if (r.ok) setTitle(r.now.title);
      };
      document.getElementById("btn-toggle").onclick = async () => {
        const r = await postJSON("/music/toggle");
        if (r.ok) {
          document.getElementById("btn-toggle").textContent = r.paused ? "▶️" : "⏯️";
        }
        const s = await fetch("/music/status").then(r=>r.json());
        if (s.ok) setTitle(s.title);
      };
      document.getElementById("btn-mute").onclick = async () => {
        const isMuted = document.getElementById("btn-mute").dataset.muted === "1";
        const r = await postJSON("/music/mute", { mute: !isMuted });
        if (r.ok) {
          document.getElementById("btn-mute").dataset.muted = r.muted ? "1" : "0";
          document.getElementById("btn-mute").textContent = r.muted ? "🔇" : "🔊";
        }
      };

      // Optional: support loading a custom playlist from the input
      document.getElementById("load-playlist").onclick = async () => {
        const url = document.getElementById("playlist-url").value.trim();
        if (!url) return;
        const r = await postJSON("/music/playlist", { playlist_url: url });
        if (r.ok) setTitle(r.now?.title || r.playlist?.[0]?.title || "No music");
      };

      // Keep the title fresh if user watches a while
      setInterval(async () => {
        const s = await fetch("/music/status").then(r=>r.json()).catch(()=>null);
        if (s && s.ok) setTitle(s.title);
      }, 8000);
    });
  </script>


  <script>
  window.addEventListener("load", () => {
    const playlistUrl = "https://www.youtube.com/playlist?list=PLcFTWWe4qhjz7HsajwpVjMkFchD3FdxNR";
    fetch("/music/playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlist_url: playlistUrl }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) {
          console.log("Playlist loaded:", data.playlist.length, "tracks");
        } else {
          console.error("Playlist load failed:", data.error);
        }
      })
      .catch((err) => console.error("Playlist fetch failed:", err));
  });
  </script>

  <script>
    const albumUrl = "/static/album.json";
    let images = [];
    let currentIndex = 0;
    let imgA, imgB;
    let showingA = true;
    let slideshowTimer = null;
    let slideshowRunning = false;

    function showImage(url) {
      if (!imgA || !imgB) return;
      if (showingA) {
        imgB.src = url; imgB.style.opacity = 1; imgA.style.opacity = 0;
      } else {
        imgA.src = url; imgA.style.opacity = 1; imgB.style.opacity = 0;
      }
      showingA = !showingA;
    }

    async function loadAlbum() {
      try {
        const res = await fetch(albumUrl, { cache: "no-store" });
        const data = await res.json();
        images = data.images || [];
        if (images.length > 0) {
          currentIndex = 0;
          showImage("/static/" + images[currentIndex].url);
        } else {
          console.warn("album.json is empty");
        }
      } catch (err) {
        console.error("Failed to load album.json:", err);
      }
    }

    function nextImage() {
      if (images.length === 0) return;
      currentIndex = (currentIndex + 1) % images.length;
      showImage("/static/" + images[currentIndex].url);
    }
    function prevImage() {
      if (images.length === 0) return;
      currentIndex = (currentIndex - 1 + images.length) % images.length;
      showImage("/static/" + images[currentIndex].url);
    }
    function startSlideshow() {
      if (!slideshowTimer) slideshowTimer = setInterval(nextImage, 10000);
      slideshowRunning = true;
    }
    function stopSlideshow() {
      if (slideshowTimer) clearInterval(slideshowTimer);
      slideshowTimer = null;
      slideshowRunning = false;
    }

    window.addEventListener("load", () => {
      imgA = document.getElementById("imgA");
      imgB = document.getElementById("imgB");
      loadAlbum();
      startSlideshow();

      document.getElementById("next").addEventListener("click", nextImage);
      document.getElementById("prev").addEventListener("click", prevImage);
      document.getElementById("pause").addEventListener("click", stopSlideshow);
      document.getElementById("play").addEventListener("click", startSlideshow);
      document.getElementById("shuffle").addEventListener("click", () => {
        for (let i = images.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [images[i], images[j]] = [images[j], images[i]];
        }
        currentIndex = 0;
        showImage("/static/" + images[currentIndex].url);
      });
    });
  </script>
</body>
</html>
"""

# -----------------------------------------------------------
# Routes
# -----------------------------------------------------------
@app.route("/")
def index():
    return render_template_string(HTML)


# -----------------------------------------------------------
# Music control endpoints
# -----------------------------------------------------------

@app.route("/music/pause", methods=["POST"])
def music_pause():
    try:
        player.pause()
        return jsonify({"ok": True})
    except Exception as e:
        logging.error(f"Error in music_pause: {e}", exc_info=True)
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/music/mute", methods=["POST"])
def music_mute():
    try:
        data = request.get_json(force=True)
        mute = data.get("mute", False)
        player.set_mute(bool(mute))
        return jsonify({"ok": True, "muted": player.muted})
    except Exception as e:
        logging.error(f"Error in music_mute: {e}", exc_info=True)
        return jsonify({"ok": False, "error": str(e)}), 500



# -----------------------------------------------------------
# Main entry
# -----------------------------------------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=False)
