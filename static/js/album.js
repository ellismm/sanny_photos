// static/js/album.js
(function () {
  console.log("[album.js] loaded");

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
      imgB.src = url;
      imgB.style.opacity = 1;
      imgA.style.opacity = 0;
    } else {
      imgA.src = url;
      imgA.style.opacity = 1;
      imgB.style.opacity = 0;
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
        console.warn("[album.js] album.json is empty");
      }
    } catch (err) {
      console.error("[album.js] Failed to load album.json:", err);
    }
  }

  function nextImageLocal() {
    if (images.length === 0) return;
    currentIndex = (currentIndex + 1) % images.length;
    showImage("/static/" + images[currentIndex].url);
  }

  function prevImageLocal() {
    if (images.length === 0) return;
    currentIndex = (currentIndex - 1 + images.length) % images.length;
    showImage("/static/" + images[currentIndex].url);
  }

  function startSlideshowLocal() {
    if (!slideshowTimer) {
      slideshowTimer = setInterval(nextImageLocal, 10000);
    }
    slideshowRunning = true;
  }

  function stopSlideshowLocal() {
    if (slideshowTimer) clearInterval(slideshowTimer);
    slideshowTimer = null;
    slideshowRunning = false;
  }

  function wireLocalButtons(albumRef, deviceID) {
    document.getElementById("next").addEventListener("click", () => {
      nextImageLocal();
      albumRef.update({
        currentIndex,
        isPlaying: true,
        actor: deviceID,
        ts: Date.now()
      });
    });

    document.getElementById("prev").addEventListener("click", () => {
      prevImageLocal();
      albumRef.update({
        currentIndex,
        isPlaying: true,
        actor: deviceID,
        ts: Date.now()
      });
    });

    document.getElementById("pause").addEventListener("click", () => {
      stopSlideshowLocal();
      albumRef.update({
        isPlaying: false,
        actor: deviceID,
        ts: Date.now()
      });
    });

    document.getElementById("play").addEventListener("click", () => {
      startSlideshowLocal();
      albumRef.update({
        isPlaying: true,
        actor: deviceID,
        ts: Date.now()
      });
    });

    // Local-only shuffle for now
    document.getElementById("shuffle").addEventListener("click", () => {
      if (images.length <= 1) return;
      for (let i = images.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [images[i], images[j]] = [images[j], images[i]];
      }
      currentIndex = 0;
      showImage("/static/" + images[currentIndex].url);
    });
  }

  // Wait for DOM and Firebase
  window.addEventListener("load", () => {
    imgA = document.getElementById("imgA");
    imgB = document.getElementById("imgB");

    if (!window.SannyFirebase) {
      console.error("[album.js] SannyFirebase not found");
      return;
    }

    window.SannyFirebase.onReady(async (ctx) => {
      console.log("[album.js] onReady called");
      const { db, ROOM_ID, deviceID } = ctx;
      const albumRef = db.ref(`rooms/${ROOM_ID}/album`);

      await loadAlbum();

      const snap = await albumRef.once("value");
      const data = snap.val();
      if (data && images.length > 0) {
        if (typeof data.currentIndex === "number") {
          currentIndex = data.currentIndex % images.length;
          showImage("/static/" + images[currentIndex].url);
        }
        if (data.isPlaying === false) {
          stopSlideshowLocal();
        } else {
          startSlideshowLocal();
        }
      } else {
        // seed
        albumRef.set({
          currentIndex,
          isPlaying: true,
          actor: deviceID,
          ts: Date.now()
        });
        startSlideshowLocal();
      }

      // Listen for remote changes
      albumRef.on("value", (s) => {
        const d = s.val();
        if (!d) return;
        if (d.actor && d.actor === deviceID) return; // ignore own writes

        if (typeof d.currentIndex === "number" && images.length > 0) {
          currentIndex = d.currentIndex % images.length;
          showImage("/static/" + images[currentIndex].url);
        }
        if (typeof d.isPlaying === "boolean") {
          if (d.isPlaying && !slideshowRunning) startSlideshowLocal();
          if (!d.isPlaying && slideshowRunning) stopSlideshowLocal();
        }
      });

      wireLocalButtons(albumRef, deviceID);
      console.log("[album.js] album sync initialized");
    });
  });
})();
