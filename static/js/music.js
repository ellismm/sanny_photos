// static/js/music.js
(function () {
  console.log("[music.js] loaded");

  function setTitle(t) {
    document.getElementById("music-title").textContent = t || "No music";
  }

  async function postJSON(url, body = {}) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return res.json();
  }

  let localMusicState = {
    index: -1,
    isPlaying: false,
    isMuted: false
  };

  window.addEventListener("load", () => {
    if (!window.SannyFirebase) {
      console.error("[music.js] SannyFirebase not found");
      return;
    }

    window.SannyFirebase.onReady((ctx) => {
      console.log("[music.js] onReady called");
      const { db, ROOM_ID, deviceID } = ctx;
      const musicRef = db.ref(`rooms/${ROOM_ID}/music`);

      const btnNext   = document.getElementById("btn-next");
      const btnPrev   = document.getElementById("btn-prev");
      const btnToggle = document.getElementById("btn-toggle");
      const btnMute   = document.getElementById("btn-mute");
      const btnLoad   = document.getElementById("load-playlist");
      const input     = document.getElementById("playlist-url");

      async function initMusicFromRoom() {
        const snap = await musicRef.once("value");
        const data = snap.val() || {};
        const defaultPlaylist = "https://www.youtube.com/playlist?list=PLcFTWWe4qhjz7HsajwpVjMkFchD3FdxNR";
        const playlistUrl = data.playlistUrl || defaultPlaylist;
        input.value = playlistUrl;

        const res = await postJSON("/music/playlist", { playlist_url: playlistUrl });
        if (res.ok) {
          const title = res.now?.title || (res.playlist?.[0]?.title) || "No music";
          setTitle(title);
          localMusicState.index = res.now?.index ?? 0;

          if (data.currentIndex === undefined) {
            musicRef.set({
              playlistUrl,
              currentIndex: localMusicState.index,
              isPlaying: true,
              isMuted: false,
              actor: deviceID,
              ts: Date.now()
            });
          }
        } else {
          console.error("[music.js] playlist load failed:", res.error);
        }
      }

      // Remote listener
      musicRef.on("value", async (snap) => {
        const m = snap.val();
        if (!m) return;
        if (m.actor && m.actor === deviceID) return; // ignore our own writes

        // Track index change
        if (typeof m.currentIndex === "number" && m.currentIndex !== localMusicState.index) {
          localMusicState.index = m.currentIndex;
          const r = await postJSON("/music/play_cached", { index: m.currentIndex });
          if (r.ok) setTitle(r.title);
        }

        // Mute sync
        if (typeof m.isMuted === "boolean" && m.isMuted !== localMusicState.isMuted) {
          localMusicState.isMuted = m.isMuted;
          const r = await postJSON("/music/mute", { mute: m.isMuted });
          if (r.ok) {
            btnMute.dataset.muted = r.muted ? "1" : "0";
            btnMute.textContent = r.muted ? "🔇" : "🔊";
          }
        }

        // Play/pause sync
        if (typeof m.isPlaying === "boolean") {
          try {
            const status = await fetch("/music/status").then(r => r.json());
            if (status.ok) {
              const currentlyPaused = status.paused;
              const shouldBePaused = !m.isPlaying;
              if (currentlyPaused !== shouldBePaused) {
                const r = await postJSON("/music/toggle");
                if (r.ok) {
                  btnToggle.textContent = r.paused ? "▶️" : "⏯️";
                }
              }
            }
          } catch (err) {
            console.error("[music.js] music/status check failed:", err);
          }
        }
      });

      // Button wiring
      btnNext.onclick = async () => {
        const r = await postJSON("/music/next");
        if (r.ok) {
          setTitle(r.now.title);
          localMusicState.index = r.now.index;
          musicRef.update({
            currentIndex: r.now.index,
            isPlaying: true,
            actor: deviceID,
            ts: Date.now()
          });
        }
      };

      btnPrev.onclick = async () => {
        const r = await postJSON("/music/prev");
        if (r.ok) {
          setTitle(r.now.title);
          localMusicState.index = r.now.index;
          musicRef.update({
            currentIndex: r.now.index,
            isPlaying: true,
            actor: deviceID,
            ts: Date.now()
          });
        }
      };

      btnToggle.onclick = async () => {
        const r = await postJSON("/music/toggle");
        if (r.ok) {
          btnToggle.textContent = r.paused ? "▶️" : "⏯️";
          localMusicState.isPlaying = !r.paused;
          musicRef.update({
            isPlaying: localMusicState.isPlaying,
            actor: deviceID,
            ts: Date.now()
          });
        }
      };

      btnMute.onclick = async () => {
        const isMuted = btnMute.dataset.muted === "1";
        const r = await postJSON("/music/mute", { mute: !isMuted });
        if (r.ok) {
          btnMute.dataset.muted = r.muted ? "1" : "0";
          btnMute.textContent = r.muted ? "🔇" : "🔊";
          localMusicState.isMuted = r.muted;
          musicRef.update({
            isMuted: r.muted,
            actor: deviceID,
            ts: Date.now()
          });
        }
      };

      btnLoad.onclick = async () => {
        const url = (input.value || "").trim();
        if (!url) return;
        const r = await postJSON("/music/playlist", { playlist_url: url });
        if (r.ok) {
          const title = r.now?.title || r.playlist?.[0]?.title || "No music";
          setTitle(title);
          localMusicState.index = r.now?.index ?? 0;
          musicRef.set({
            playlistUrl: url,
            currentIndex: localMusicState.index,
            isPlaying: true,
            isMuted: false,
            actor: deviceID,
            ts: Date.Now
          });
        } else {
          console.error("[music.js] playlist load failed:", r.error);
        }
      };

      // Initial load
      initMusicFromRoom();
      console.log("[music.js] music sync initialized");
    });
  });
})();
