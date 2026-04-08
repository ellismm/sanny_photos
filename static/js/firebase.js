// static/js/firebase.js
(function () {
  const appConfig = window.SANNY_CONFIG || {};
  const params = new URLSearchParams(window.location.search);

  let deviceId = window.localStorage.getItem("sanny.deviceId");
  if (!deviceId) {
    deviceId = "dev_" + Math.random().toString(36).slice(2, 10);
    window.localStorage.setItem("sanny.deviceId", deviceId);
  }

  const configuredRoomId = (appConfig.roomId || "").trim();
  const requestedRoomId = (params.get("room") || "").trim();
  const storedRoomId = (window.localStorage.getItem("sanny.roomId") || "").trim();
  const roomId = requestedRoomId || storedRoomId || configuredRoomId || "local-room";
  window.localStorage.setItem("sanny.roomId", roomId);

  const readyCallbacks = [];
  const storeCache = new Map();
  let ready = false;
  let serverTimeOffsetMs = 0;

  function clone(value) {
    if (value === null || value === undefined) {
      return value;
    }
    return JSON.parse(JSON.stringify(value));
  }

  function resolveScope(name, options) {
    const requestedScope = options && options.scope;
    if (requestedScope === "local" || requestedScope === "shared") {
      return requestedScope;
    }

    if (name === "music" && !ctx.syncMusicEnabled) {
      return "local";
    }

    if ((name === "album" || name === "library" || name === "presence") && ctx.syncSlidesEnabled) {
      return "shared";
    }

    return "shared";
  }

  function createLocalStore(name) {
    const storageKey = `sanny.room.${roomId}.${name}`;
    const listeners = new Set();
    const channel =
      typeof window.BroadcastChannel !== "undefined"
        ? new window.BroadcastChannel(storageKey)
        : null;

    function readState() {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        return null;
      }

      try {
        return JSON.parse(raw);
      } catch (error) {
        console.warn("[sync] ignoring invalid local state for", storageKey, error);
        return null;
      }
    }

    let currentState = readState();

    function emit(listenersSet, value) {
      const snapshot = clone(value);
      listenersSet.forEach((listener) => {
        try {
          listener(snapshot);
        } catch (error) {
          console.error("[sync] subscriber failed:", error);
        }
      });
    }

    function writeState(nextState) {
      currentState = clone(nextState);
      window.localStorage.setItem(storageKey, JSON.stringify(currentState));
      if (channel) {
        channel.postMessage(currentState);
      }
      emit(listeners, currentState);
    }

    function receiveState(nextState) {
      currentState = clone(nextState);
      emit(listeners, currentState);
    }

    if (channel) {
      channel.addEventListener("message", (event) => {
        receiveState(event.data);
      });
    }

    window.addEventListener("storage", (event) => {
      if (event.key !== storageKey) {
        return;
      }
      receiveState(readState());
    });

    return {
      key: storageKey,
      scope: "local",
      async get() {
        currentState = currentState === null ? readState() : currentState;
        return clone(currentState);
      },
      async set(value) {
        writeState(value);
        return clone(currentState);
      },
      async update(patch) {
        const base = (await this.get()) || {};
        const nextState = Object.assign({}, base, patch);
        writeState(nextState);
        return clone(nextState);
      },
      async mutate(mutator) {
        const base = await this.get();
        const nextState = mutator(clone(base));
        if (typeof nextState === "undefined") {
          return {
            committed: false,
            value: clone(base)
          };
        }
        writeState(nextState);
        return {
          committed: true,
          value: clone(currentState)
        };
      },
      subscribe(listener) {
        listeners.add(listener);
        listener(clone(currentState));
        return function unsubscribe() {
          listeners.delete(listener);
        };
      }
    };
  }

  function createFirebaseStore(name) {
    const ref = ctx.firebase.db.ref(`rooms/${roomId}/${name}`);

    return {
      ref,
      scope: "shared",
      async get() {
        const snapshot = await ref.once("value");
        return snapshot.val();
      },
      async set(value) {
        await ref.set(value);
        return value;
      },
      async update(patch) {
        await ref.update(patch);
        return this.get();
      },
      async mutate(mutator) {
        return new Promise((resolve, reject) => {
          ref.transaction(
            (currentValue) => {
              const nextValue = mutator(clone(currentValue));
              if (typeof nextValue === "undefined") {
                return;
              }
              return nextValue;
            },
            (error, committed, snapshot) => {
              if (error) {
                reject(error);
                return;
              }
              resolve({
                committed,
                value: snapshot ? snapshot.val() : null
              });
            },
            false
          );
        });
      },
      subscribe(listener) {
        const handler = (snapshot) => listener(snapshot.val());
        ref.on("value", handler);
        return function unsubscribe() {
          ref.off("value", handler);
        };
      }
    };
  }

  const ctx = {
    config: appConfig,
    deviceId,
    roomId,
    syncEnabled: false,
    syncMode: "local",
    syncSlidesEnabled: appConfig.syncSlides !== false,
    syncMusicEnabled: Boolean(appConfig.syncMusic),
    setupEnabled: appConfig.setupEnabled !== false,
    firebase: null,
    serverNow() {
      return Date.now() + serverTimeOffsetMs;
    },
    createLocalStore(name) {
      return this.createStore(name, { scope: "local" });
    },
    createSharedStore(name) {
      return this.createStore(name, { scope: "shared" });
    },
    createStore(name, options) {
      const scope = resolveScope(name, options || {});
      const cacheKey = `${scope}:${name}`;

      if (!storeCache.has(cacheKey)) {
        const canShare = scope === "shared" && ctx.syncEnabled;
        storeCache.set(cacheKey, canShare ? createFirebaseStore(name) : createLocalStore(name));
      }

      return storeCache.get(cacheKey);
    }
  };

  function flushReadyCallbacks() {
    if (ready) {
      return;
    }
    ready = true;
    readyCallbacks.splice(0).forEach((callback) => {
      try {
        callback(ctx);
      } catch (error) {
        console.error("[sync] onReady callback failed:", error);
      }
    });
  }

  window.SannySync = {
    onReady(callback) {
      if (typeof callback !== "function") {
        return;
      }

      if (ready) {
        callback(ctx);
        return;
      }

      readyCallbacks.push(callback);
    },
    getContext() {
      return ctx;
    }
  };

  window.SannyFirebase = window.SannySync;

  function initLocalMode(reason) {
    if (reason) {
      console.warn("[sync] falling back to local mode:", reason);
    }
    flushReadyCallbacks();
  }

  function initFirebaseMode() {
    const firebaseConfig = appConfig.firebase && appConfig.firebase.config;
    if (!appConfig.firebase || !appConfig.firebase.enabled || !firebaseConfig) {
      initLocalMode("firebase not configured");
      return;
    }

    if (!window.firebase) {
      initLocalMode("firebase SDK unavailable");
      return;
    }

    try {
      if (!window.firebase.apps.length) {
        window.firebase.initializeApp(firebaseConfig);
      }
    } catch (error) {
      initLocalMode(error.message || "firebase init failed");
      return;
    }

    window.firebase.auth().onAuthStateChanged((user) => {
      if (user) {
        const db = window.firebase.database();
        ctx.syncEnabled = true;
        ctx.syncMode = "firebase";
        ctx.firebase = { db, user };

        db.ref("/.info/serverTimeOffset").on("value", (snapshot) => {
          const value = Number(snapshot.val());
          serverTimeOffsetMs = Number.isFinite(value) ? value : 0;
        });

        flushReadyCallbacks();
        return;
      }

      window.firebase.auth().signInAnonymously().catch((error) => {
        initLocalMode(error.message || "firebase anonymous sign-in failed");
      });
    });
  }

  initFirebaseMode();
})();
