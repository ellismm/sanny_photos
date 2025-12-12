// static/js/firebase.js
(function () {
  console.log("[firebase.js] loading...");

  // 🔥 Replace with your real web config (the one that has apiKey starting with AIza...)
  const firebaseConfig = {
    apiKey: "...your_api_key_here...",
    authDomain: "sanny-photos.firebaseapp.com",
    databaseURL: "https://sanny-photos-default-rtdb.firebaseio.com",
    projectId: "sanny-photos",
    storageBucket: "sanny-photos.appspot.com",
    messagingSenderId: "126021881027",
    appId: "1:126021881027:web:6f4023e76816b26601a676"
  };

  // Initialize Firebase app
  firebase.initializeApp(firebaseConfig);
  console.log("[firebase.js] Firebase initialized");

  const ROOM_ID = "07291996";
  const deviceID = "dev_" + Math.random().toString(36).substring(2, 10);

  const readyCallbacks = [];
  const ctx = {
    ROOM_ID,
    deviceID,
    db: null,
    user: null
  };

  window.SannyFirebase = {
    ROOM_ID,
    deviceID,
    onReady: function (cb) {
      if (typeof cb === "function") {
        readyCallbacks.push(cb);
        // If ctx is already ready, fire immediately
        if (ctx.db && ctx.user) {
          cb(ctx);
        }
      }
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    console.log("[firebase.js] DOMContentLoaded");

    firebase.auth().onAuthStateChanged((user) => {
      if (user) {
        console.log("[firebase.js] Authenticated as", user.uid);
        ctx.user = user;
        ctx.db = firebase.database();

        // Attach db and user back onto SannyFirebase
        window.SannyFirebase.db = ctx.db;
        window.SannyFirebase.user = user;

        // Fire all registered callbacks
        readyCallbacks.forEach((cb) => {
          try {
            cb(ctx);
          } catch (err) {
            console.error("[firebase.js] onReady callback error:", err);
          }
        });

      } else {
        console.log("[firebase.js] Signing in anonymously...");
        firebase.auth().signInAnonymously().catch((err) => {
          console.error("[firebase.js] Anonymous auth error:", err);
        });
      }
    });
  });
})();
