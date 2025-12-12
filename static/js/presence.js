// static/js/presence.js
(function () {
  console.log("[presence.js] loaded");

  if (!window.SannyFirebase) {
    console.error("[presence.js] SannyFirebase not found");
    return;
  }

  window.SannyFirebase.onReady((ctx) => {
    console.log("[presence.js] onReady called");
    const { db, ROOM_ID, deviceID } = ctx;

    const presenceRef = db.ref(`rooms/${ROOM_ID}/presence/${deviceID}`);

    presenceRef.onDisconnect().set({
      online: false,
      lastSeen: firebase.database.ServerValue.TIMESTAMP
    });

    function touchPresence() {
      presenceRef.set({
        online: true,
        lastSeen: firebase.database.ServerValue.TIMESTAMP
      });
    }

    // initial + periodic heartbeat (60s)
    touchPresence();
    setInterval(touchPresence, 60000);
    console.log("[presence.js] presence initialized");
  });
})();
