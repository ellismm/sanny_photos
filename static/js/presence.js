// static/js/presence.js
(function () {
  function now() {
    return Date.now();
  }

  function buildPresence(deviceId, online) {
    return {
      [deviceId]: {
        online,
        lastSeen: now()
      }
    };
  }

  window.addEventListener("load", () => {
    if (!window.SannySync) {
      return;
    }

    window.SannySync.onReady((ctx) => {
      const presenceStore = ctx.createStore("presence");

      function touch(online) {
        presenceStore.update(buildPresence(ctx.deviceId, online));
      }

      touch(true);
      const intervalId = window.setInterval(() => touch(true), 60000);

      window.addEventListener("beforeunload", () => touch(false));
      window.addEventListener("pagehide", () => touch(false));
      window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          touch(true);
        }
      });

      window.addEventListener("unload", () => {
        window.clearInterval(intervalId);
      });
    });
  });
})();
