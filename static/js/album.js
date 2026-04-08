// static/js/album.js
(function () {
  const config = window.SANNY_CONFIG || {};
  const defaultSlideDurationMs = Math.max(
    3000,
    Number(config.defaultSlideDurationMs) || 10000
  );
  const trayPanelStorageKey = "sanny.trayPanel";
  const frameTimeZoneStorageKey = "sanny.frameTimeZone";
  const defaultFrameTimeZone = "America/Chicago";
  const frameTimeZoneOptions = [
    { value: "America/Los_Angeles", shortLabel: "PT", longLabel: "Pacific Time" },
    { value: "America/Denver", shortLabel: "MT", longLabel: "Mountain Time" },
    { value: "America/Chicago", shortLabel: "CT", longLabel: "Central Time" },
    { value: "America/New_York", shortLabel: "ET", longLabel: "Eastern Time" }
  ];
  const trayPanelNames = ["slideshow", "music", "alarm", "configuration"];
  const trayLongPressMs = 2000;
  const touchDebugEnabled = Boolean(config.touchDebugEnabled);
  const fastTapSelector = "button:not(.playlist-track-button)";
  const fastTapMoveThresholdPx = 14;
  const drawingEnabled = config.drawingEnabled !== false;
  const drawingLongPressMs = Math.max(400, Number(config.drawingLongPressMs) || 650);
  const drawingPointBatchMs = Math.max(40, Number(config.drawingPointBatchMs) || 80);
  const drawingStrokeWidthRatio = 0.0062;
  const drawingPointDistancePx = 4;
  const drawingActivationMoveThresholdPx = 20;
  const drawingMaxStoredStrokes = 80;
  const drawingMaxPointsPerStroke = 220;
  const drawingPalette = normalizeDrawingPalette(config.drawingPalette);
  const transitionPresets = [
    {
      name: "crossfade",
      enter: { fromScale: "1.025", fromBlur: "6px" },
      exit: { toScale: "0.99", toBlur: "6px" }
    },
    {
      name: "glide-left",
      enter: { fromX: "5%", fromScale: "1.03", origin: "40% 50%" },
      exit: { toX: "-4%", toScale: "0.985", origin: "60% 50%" }
    },
    {
      name: "glide-right",
      enter: { fromX: "-5%", fromScale: "1.03", origin: "60% 50%" },
      exit: { toX: "4%", toScale: "0.985", origin: "40% 50%" }
    },
    {
      name: "glide-up",
      enter: { fromY: "5%", fromScale: "1.03", origin: "50% 60%" },
      exit: { toY: "-4%", toScale: "0.985", origin: "50% 40%" }
    },
    {
      name: "glide-down",
      enter: { fromY: "-5%", fromScale: "1.03", origin: "50% 40%" },
      exit: { toY: "4%", toScale: "0.985", origin: "50% 60%" }
    },
    {
      name: "zoom-in",
      enter: { fromScale: "1.085", fromBlur: "10px" },
      exit: { toScale: "0.965", toBlur: "6px" }
    },
    {
      name: "zoom-out",
      enter: { fromScale: "0.94", fromBlur: "4px" },
      exit: { toScale: "1.045", toBlur: "8px" }
    },
    {
      name: "sweep-left",
      enter: { fromX: "8%", fromScale: "1.035", origin: "32% 50%" },
      exit: { toX: "-6%", toScale: "1.015", origin: "68% 50%" }
    },
    {
      name: "sweep-right",
      enter: { fromX: "-8%", fromScale: "1.035", origin: "68% 50%" },
      exit: { toX: "6%", toScale: "1.015", origin: "32% 50%" }
    },
    {
      name: "tilt-left",
      enter: { fromX: "3%", fromScale: "1.04", fromRotate: "-1.4deg", origin: "35% 45%" },
      exit: { toX: "-2%", toScale: "0.99", toRotate: "0.8deg", origin: "65% 55%" }
    },
    {
      name: "tilt-right",
      enter: { fromX: "-3%", fromScale: "1.04", fromRotate: "1.4deg", origin: "65% 45%" },
      exit: { toX: "2%", toScale: "0.99", toRotate: "-0.8deg", origin: "35% 55%" }
    },
    {
      name: "corner-nw",
      enter: { fromX: "3%", fromY: "3%", fromScale: "1.09", origin: "0% 0%" },
      exit: { toX: "-2%", toY: "-2%", toScale: "0.985", origin: "100% 100%" }
    },
    {
      name: "corner-ne",
      enter: { fromX: "-3%", fromY: "3%", fromScale: "1.09", origin: "100% 0%" },
      exit: { toX: "2%", toY: "-2%", toScale: "0.985", origin: "0% 100%" }
    },
    {
      name: "corner-sw",
      enter: { fromX: "3%", fromY: "-3%", fromScale: "1.09", origin: "0% 100%" },
      exit: { toX: "-2%", toY: "2%", toScale: "0.985", origin: "100% 0%" }
    },
    {
      name: "corner-se",
      enter: { fromX: "-3%", fromY: "-3%", fromScale: "1.09", origin: "100% 100%" },
      exit: { toX: "2%", toY: "2%", toScale: "0.985", origin: "0% 0%" }
    },
    {
      name: "corner-turn-nw",
      enter: { fromX: "10%", fromY: "10%", fromScale: "0.94", fromRotate: "-3deg", fromRotateY: "-18deg", fromBlur: "8px", origin: "0% 0%" },
      exit: { toX: "-8%", toY: "-8%", toScale: "1.02", toRotate: "2deg", toRotateY: "10deg", origin: "100% 100%" }
    },
    {
      name: "corner-turn-ne",
      enter: { fromX: "-10%", fromY: "10%", fromScale: "0.94", fromRotate: "3deg", fromRotateY: "18deg", fromBlur: "8px", origin: "100% 0%" },
      exit: { toX: "8%", toY: "-8%", toScale: "1.02", toRotate: "-2deg", toRotateY: "-10deg", origin: "0% 100%" }
    },
    {
      name: "corner-turn-sw",
      enter: { fromX: "10%", fromY: "-10%", fromScale: "0.94", fromRotate: "3deg", fromRotateY: "-18deg", fromBlur: "8px", origin: "0% 100%" },
      exit: { toX: "-8%", toY: "8%", toScale: "1.02", toRotate: "-2deg", toRotateY: "10deg", origin: "100% 0%" }
    },
    {
      name: "corner-turn-se",
      enter: { fromX: "-10%", fromY: "-10%", fromScale: "0.94", fromRotate: "-3deg", fromRotateY: "18deg", fromBlur: "8px", origin: "100% 100%" },
      exit: { toX: "8%", toY: "8%", toScale: "1.02", toRotate: "2deg", toRotateY: "-10deg", origin: "0% 0%" }
    },
    {
      name: "soft-focus",
      enter: { fromScale: "1.035", fromBlur: "14px" },
      exit: { toScale: "0.985", toBlur: "12px" }
    },
    {
      name: "turn-left",
      enter: { fromX: "4%", fromScale: "1.02", fromRotateY: "-16deg", origin: "0% 50%" },
      exit: { toX: "-3%", toScale: "0.985", toRotateY: "10deg", origin: "100% 50%" }
    },
    {
      name: "turn-right",
      enter: { fromX: "-4%", fromScale: "1.02", fromRotateY: "16deg", origin: "100% 50%" },
      exit: { toX: "3%", toScale: "0.985", toRotateY: "-10deg", origin: "0% 50%" }
    },
    {
      name: "flip-up",
      enter: { fromY: "4%", fromScale: "1.015", fromRotateX: "-16deg", origin: "50% 0%" },
      exit: { toY: "-3%", toScale: "0.99", toRotateX: "10deg", origin: "50% 100%" }
    },
    {
      name: "flip-down",
      enter: { fromY: "-4%", fromScale: "1.015", fromRotateX: "16deg", origin: "50% 100%" },
      exit: { toY: "3%", toScale: "0.99", toRotateX: "-10deg", origin: "50% 0%" }
    },
    {
      name: "mirror-left",
      enter: { fromX: "3%", fromScaleX: "-0.18", fromScaleY: "1.04", fromRotateY: "-10deg", fromBlur: "5px", origin: "0% 50%" },
      exit: { toX: "-2%", toScaleX: "0.76", toScaleY: "0.98", toRotateY: "7deg", origin: "100% 50%" }
    },
    {
      name: "mirror-right",
      enter: { fromX: "-3%", fromScaleX: "-0.18", fromScaleY: "1.04", fromRotateY: "10deg", fromBlur: "5px", origin: "100% 50%" },
      exit: { toX: "2%", toScaleX: "0.76", toScaleY: "0.98", toRotateY: "-7deg", origin: "0% 50%" }
    },
    {
      name: "hinge-left",
      enter: { fromX: "7%", fromScale: "1.03", fromRotate: "-4deg", fromRotateY: "-12deg", origin: "0% 50%" },
      exit: { toX: "-5%", toScale: "0.98", toRotate: "3deg", toRotateY: "8deg", origin: "0% 50%" }
    },
    {
      name: "hinge-right",
      enter: { fromX: "-7%", fromScale: "1.03", fromRotate: "4deg", fromRotateY: "12deg", origin: "100% 50%" },
      exit: { toX: "5%", toScale: "0.98", toRotate: "-3deg", toRotateY: "-8deg", origin: "100% 50%" }
    },
    {
      name: "skew-left",
      enter: { fromX: "6%", fromScale: "1.025", fromSkewX: "-7deg", origin: "20% 50%" },
      exit: { toX: "-4%", toScale: "0.99", toSkewX: "5deg", origin: "80% 50%" }
    },
    {
      name: "skew-right",
      enter: { fromX: "-6%", fromScale: "1.025", fromSkewX: "7deg", origin: "80% 50%" },
      exit: { toX: "4%", toScale: "0.99", toSkewX: "-5deg", origin: "20% 50%" }
    },
    {
      name: "skew-up",
      enter: { fromY: "6%", fromScale: "1.025", fromSkewY: "-6deg", origin: "50% 20%" },
      exit: { toY: "-4%", toScale: "0.99", toSkewY: "4deg", origin: "50% 80%" }
    },
    {
      name: "skew-down",
      enter: { fromY: "-6%", fromScale: "1.025", fromSkewY: "6deg", origin: "50% 80%" },
      exit: { toY: "4%", toScale: "0.99", toSkewY: "-4deg", origin: "50% 20%" }
    },
    {
      name: "door-left",
      enter: { fromX: "-12%", fromScale: "0.96", fromRotateY: "14deg", fromBlur: "8px", origin: "100% 50%" },
      exit: { toX: "10%", toScale: "1.02", toRotateY: "-12deg", origin: "0% 50%" }
    },
    {
      name: "door-right",
      enter: { fromX: "12%", fromScale: "0.96", fromRotateY: "-14deg", fromBlur: "8px", origin: "0% 50%" },
      exit: { toX: "-10%", toScale: "1.02", toRotateY: "12deg", origin: "100% 50%" }
    },
    {
      name: "edge-turn-left",
      enter: { fromX: "-18%", fromScale: "0.92", fromRotateY: "24deg", fromRotate: "-2deg", fromBlur: "10px", origin: "0% 50%" },
      exit: { toX: "12%", toScale: "1.03", toRotateY: "-14deg", toRotate: "1deg", origin: "100% 50%" }
    },
    {
      name: "edge-turn-right",
      enter: { fromX: "18%", fromScale: "0.92", fromRotateY: "-24deg", fromRotate: "2deg", fromBlur: "10px", origin: "100% 50%" },
      exit: { toX: "-12%", toScale: "1.03", toRotateY: "14deg", toRotate: "-1deg", origin: "0% 50%" }
    },
    {
      name: "edge-flip-top",
      enter: { fromY: "-18%", fromScale: "0.93", fromRotateX: "-22deg", fromRotate: "-1.5deg", fromBlur: "10px", origin: "50% 0%" },
      exit: { toY: "12%", toScale: "1.03", toRotateX: "14deg", toRotate: "1deg", origin: "50% 100%" }
    },
    {
      name: "edge-flip-bottom",
      enter: { fromY: "18%", fromScale: "0.93", fromRotateX: "22deg", fromRotate: "1.5deg", fromBlur: "10px", origin: "50% 100%" },
      exit: { toY: "-12%", toScale: "1.03", toRotateX: "-14deg", toRotate: "-1deg", origin: "50% 0%" }
    },
    {
      name: "rise-reveal",
      enter: { fromY: "12%", fromScale: "1.08", fromBlur: "12px", origin: "50% 70%" },
      exit: { toY: "-9%", toScale: "0.97", toBlur: "6px", origin: "50% 30%" }
    },
    {
      name: "fall-reveal",
      enter: { fromY: "-12%", fromScale: "1.08", fromBlur: "12px", origin: "50% 30%" },
      exit: { toY: "9%", toScale: "0.97", toBlur: "6px", origin: "50% 70%" }
    },
    {
      name: "arrival-left",
      enter: { fromX: "-16%", fromScale: "0.95", fromRotate: "-2.5deg", fromBlur: "10px", origin: "20% 50%" },
      exit: { toX: "10%", toScale: "1.03", toRotate: "1.5deg", toBlur: "4px", origin: "80% 50%" }
    },
    {
      name: "arrival-right",
      enter: { fromX: "16%", fromScale: "0.95", fromRotate: "2.5deg", fromBlur: "10px", origin: "80% 50%" },
      exit: { toX: "-10%", toScale: "1.03", toRotate: "-1.5deg", toBlur: "4px", origin: "20% 50%" }
    },
    {
      name: "arrival-top",
      enter: { fromY: "-14%", fromScale: "0.95", fromRotate: "-1.8deg", fromBlur: "9px", origin: "50% 20%" },
      exit: { toY: "10%", toScale: "1.03", toRotate: "1.2deg", toBlur: "4px", origin: "50% 80%" }
    },
    {
      name: "arrival-bottom",
      enter: { fromY: "14%", fromScale: "0.95", fromRotate: "1.8deg", fromBlur: "9px", origin: "50% 80%" },
      exit: { toY: "-10%", toScale: "1.03", toRotate: "-1.2deg", toBlur: "4px", origin: "50% 20%" }
    },
    {
      name: "bloom-close",
      enter: { fromScale: "1.16", fromBlur: "18px", origin: "50% 50%" },
      exit: { toScale: "0.94", toBlur: "8px", origin: "50% 50%" }
    },
    {
      name: "bloom-open",
      enter: { fromScale: "0.86", fromBlur: "10px", origin: "50% 50%" },
      exit: { toScale: "1.08", toBlur: "10px", origin: "50% 50%" }
    },
    {
      name: "carousel-left",
      enter: { fromX: "10%", fromScale: "0.94", fromRotateY: "-20deg", fromRotate: "-2deg", origin: "100% 50%" },
      exit: { toX: "-8%", toScale: "1.02", toRotateY: "14deg", toRotate: "1deg", origin: "0% 50%" }
    },
    {
      name: "carousel-right",
      enter: { fromX: "-10%", fromScale: "0.94", fromRotateY: "20deg", fromRotate: "2deg", origin: "0% 50%" },
      exit: { toX: "8%", toScale: "1.02", toRotateY: "-14deg", toRotate: "-1deg", origin: "100% 50%" }
    },
    {
      name: "whisper-left",
      enter: { fromX: "4%", fromScale: "1.01", fromRotate: "-3.5deg", fromBlur: "7px", origin: "32% 50%" },
      exit: { toX: "-3%", toScale: "0.995", toRotate: "2deg", toBlur: "5px", origin: "68% 50%" }
    },
    {
      name: "whisper-right",
      enter: { fromX: "-4%", fromScale: "1.01", fromRotate: "3.5deg", fromBlur: "7px", origin: "68% 50%" },
      exit: { toX: "3%", toScale: "0.995", toRotate: "-2deg", toBlur: "5px", origin: "32% 50%" }
    }
  ];

  let ctx = null;
  let images = [];
  let localFingerprint = "";
  let currentManifestVersion = 0;

  let sharedAlbumStore = null;
  let localAlbumStore = null;
  let libraryStore = null;
  let drawingStore = null;

  let sharedAlbumState = null;
  let localAlbumState = null;
  let slideshowState = null;
  let drawingState = buildDefaultDrawingState();
  let renderTimer = null;
  let showingA = true;
  let lastRenderedKey = "";
  let lastRenderedImage = null;
  let lastTransitionIndex = -1;
  let cycleReshuffleInFlight = false;

  let roomLibraryFingerprint = "";
  let inSyncWithRoom = true;
  let syncState = null;
  let syncInFlight = false;
  let lastRoomMetaCacheKey = "";

  let trayHideTimer = null;
  let trayLongPressTimer = null;
  let drawLongPressTimer = null;
  let isTrayOpen = false;
  let isDrawModeActive = false;
  let touchStartX = 0;
  let touchStartY = 0;
  let suppressStageClickUntil = 0;
  let suppressNextStageClick = false;
  let drawingRenderQueued = false;
  let drawingMutationQueue = Promise.resolve();
  let drawingFlushTimer = null;
  let activeDrawColorId = drawingPalette[0] ? drawingPalette[0].id : "cream";
  let pendingDrawActivation = null;
  let activeLocalStroke = null;
  let activeDrawPointerId = null;
  let activeDrawInputType = null;
  let lastObservedDrawingClearAt = 0;

  let imgA;
  let imgB;
  let drawingLayerEl;
  let drawingLayerContext = null;
  let drawingToolbarEl;
  let drawingPaletteEl;
  let drawingDoneButtonEl;
  let drawingUndoButtonEl;
  let drawingClearButtonEl;
  let captionEl;
  let slidePositionEl;
  let slideDurationInput;
  let slideShuffleButtonEl;
  let stageEl;
  let trayEl;
  let trayContextEl;
  let trayCloseButton;
  let trayToggleButton;
  let trayActivatorEl;
  let syncButtonEl;
  let syncStatusEl;
  let reloadButtonEl;
  let frameTimeDisplayEl;
  let frameTimeZoneSelectEl;
  let frameTimeZoneNoteEl;
  let touchDebugOverlayEl;
  let frameClockTimer = null;
  let trayPanelButtons = [];
  let trayPanels = [];
  let activeTrayPanel = window.localStorage.getItem(trayPanelStorageKey) || "slideshow";
  let touchDebugSequence = 0;
  let touchDebugLines = [];
  let fastTapInstalled = false;
  let lastFastTapTarget = null;
  let lastFastTapAt = 0;
  let activeFastTapPointer = null;
  let drawingColorButtons = [];

  function now() {
    return ctx && typeof ctx.serverNow === "function" ? ctx.serverNow() : Date.now();
  }

  function formatTouchDebugLine(prefix, payload) {
    return `${String(++touchDebugSequence).padStart(3, "0")} ${prefix} ${payload}`;
  }

  function updateTouchDebugOverlay() {
    if (!touchDebugEnabled || !touchDebugOverlayEl) {
      return;
    }
    touchDebugOverlayEl.hidden = false;
    touchDebugOverlayEl.textContent = touchDebugLines.join("\n");
  }

  function queueTouchDebug(prefix, details) {
    if (!touchDebugEnabled) {
      return;
    }

    touchDebugLines.push(formatTouchDebugLine(prefix, details));
    if (touchDebugLines.length > 18) {
      touchDebugLines = touchDebugLines.slice(-18);
    }
    updateTouchDebugOverlay();
  }

  async function postTouchDebug(prefix, event, extra = {}) {
    if (!touchDebugEnabled) {
      return;
    }

    const target = event && event.target ? event.target : null;
    const pointSource = (event && event.changedTouches && event.changedTouches[0]) ||
      (event && event.touches && event.touches[0]) ||
      event ||
      {};
    const clientX = Number(pointSource.clientX);
    const clientY = Number(pointSource.clientY);
    const elementAtPoint = Number.isFinite(clientX) && Number.isFinite(clientY)
      ? document.elementFromPoint(clientX, clientY)
      : null;
    const rect = trayEl ? trayEl.getBoundingClientRect() : null;
    const payload = {
      prefix,
      eventType: event && event.type ? event.type : "",
      isTrayOpen,
      clientX: Number.isFinite(clientX) ? Math.round(clientX) : null,
      clientY: Number.isFinite(clientY) ? Math.round(clientY) : null,
      targetTag: target && target.tagName ? target.tagName : "",
      targetId: target && target.id ? target.id : "",
      targetClass: target && target.className ? String(target.className).slice(0, 120) : "",
      elementAtPoint: elementAtPoint
        ? {
            tag: elementAtPoint.tagName || "",
            id: elementAtPoint.id || "",
            className: String(elementAtPoint.className || "").slice(0, 120)
          }
        : null,
      insideTray: eventPointIsInsideTray(event),
      trayRect: rect
        ? {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom)
          }
        : null,
      extra
    };

    queueTouchDebug(
      prefix,
      `${payload.eventType || "-"} @ ${payload.clientX ?? "?"},${payload.clientY ?? "?"} inside=${payload.insideTray} target=${payload.targetTag || "-"}#${payload.targetId || "-"} point=${payload.elementAtPoint ? `${payload.elementAtPoint.tag}#${payload.elementAtPoint.id || "-"}` : "-"}`
    );

    try {
      await fetch("/debug/touch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      });
    } catch (error) {
      queueTouchDebug("post-error", String(error && error.message ? error.message : error));
    }
  }

  function normalizeDrawingPalette(rawPalette) {
    const fallback = [
      { id: "cream", label: "Cream", color: "#f6e7c3" },
      { id: "blush", label: "Blush", color: "#e7a9b8" },
      { id: "gold", label: "Gold", color: "#d1b174" }
    ];

    if (!Array.isArray(rawPalette) || !rawPalette.length) {
      return fallback;
    }

    const normalized = rawPalette
      .map((entry, index) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const color = typeof entry.color === "string" ? entry.color.trim() : "";
        if (!color) {
          return null;
        }

        return {
          id: typeof entry.id === "string" && entry.id.trim()
            ? entry.id.trim()
            : `color-${index + 1}`,
          label: typeof entry.label === "string" && entry.label.trim()
            ? entry.label.trim()
            : `Color ${index + 1}`,
          color
        };
      })
      .filter(Boolean);

    return normalized.length ? normalized : fallback;
  }

  function createDrawingId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function clampDrawingUnit(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return 0;
    }
    return Math.min(1, Math.max(0, Number(numericValue.toFixed(4))));
  }

  function normalizeDrawingPoint(rawPoint) {
    if (!rawPoint || typeof rawPoint !== "object") {
      return null;
    }

    return {
      x: clampDrawingUnit(rawPoint.x),
      y: clampDrawingUnit(rawPoint.y)
    };
  }

  function normalizeDrawingStroke(rawStroke) {
    if (!rawStroke || typeof rawStroke !== "object") {
      return null;
    }

    const points = Array.isArray(rawStroke.points)
      ? rawStroke.points
          .map((point) => normalizeDrawingPoint(point))
          .filter(Boolean)
          .slice(-drawingMaxPointsPerStroke)
      : [];

    if (!points.length) {
      return null;
    }

    return {
      id: typeof rawStroke.id === "string" && rawStroke.id.trim()
        ? rawStroke.id.trim()
        : createDrawingId("stroke"),
      deviceId: typeof rawStroke.deviceId === "string" && rawStroke.deviceId.trim()
        ? rawStroke.deviceId.trim()
        : "unknown-device",
      color: typeof rawStroke.color === "string" && rawStroke.color.trim()
        ? rawStroke.color.trim()
        : drawingPalette[0].color,
      width: Number.isFinite(Number(rawStroke.width))
        ? Math.min(0.03, Math.max(0.0025, Number(rawStroke.width)))
        : drawingStrokeWidthRatio,
      points,
      createdAt: Number.isFinite(Number(rawStroke.createdAt))
        ? Number(rawStroke.createdAt)
        : now(),
      updatedAt: Number.isFinite(Number(rawStroke.updatedAt))
        ? Number(rawStroke.updatedAt)
        : now()
    };
  }

  function buildDefaultDrawingState() {
    return {
      revision: 0,
      clearedAt: 0,
      strokes: [],
      inProgress: {},
      updatedAt: 0,
      actor: null
    };
  }

  function normalizeDrawingState(rawState) {
    const base = rawState && typeof rawState === "object" ? rawState : {};
    const inProgress = {};

    if (base.inProgress && typeof base.inProgress === "object") {
      Object.entries(base.inProgress).forEach(([deviceId, stroke]) => {
        const normalizedStroke = normalizeDrawingStroke(stroke);
        if (normalizedStroke) {
          inProgress[deviceId] = normalizedStroke;
        }
      });
    }

    return {
      revision: Number.isFinite(Number(base.revision)) ? Number(base.revision) : 0,
      clearedAt: Number.isFinite(Number(base.clearedAt)) ? Number(base.clearedAt) : 0,
      strokes: Array.isArray(base.strokes)
        ? base.strokes
            .map((stroke) => normalizeDrawingStroke(stroke))
            .filter(Boolean)
            .slice(-drawingMaxStoredStrokes)
        : [],
      inProgress,
      updatedAt: Number.isFinite(Number(base.updatedAt)) ? Number(base.updatedAt) : 0,
      actor: typeof base.actor === "string" && base.actor.trim() ? base.actor.trim() : null
    };
  }

  function applyIncomingDrawingState(rawState) {
    const nextState = normalizeDrawingState(rawState);
    const clearRaised = nextState.clearedAt > lastObservedDrawingClearAt;

    lastObservedDrawingClearAt = nextState.clearedAt;
    drawingState = nextState;

    if (clearRaised) {
      cancelDrawingFlush();
      activeLocalStroke = null;
      activeDrawPointerId = null;
      activeDrawInputType = null;
      pendingDrawActivation = null;
    }

    scheduleDrawingRender();
    renderDrawingUi();
  }

  function getDrawingBounds() {
    const rect = stageEl
      ? stageEl.getBoundingClientRect()
      : drawingLayerEl
        ? drawingLayerEl.getBoundingClientRect()
        : null;

    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
  }

  function pointFromClientPosition(clientX, clientY) {
    const bounds = getDrawingBounds();
    if (!bounds) {
      return null;
    }

    return {
      x: clampDrawingUnit((clientX - bounds.left) / bounds.width),
      y: clampDrawingUnit((clientY - bounds.top) / bounds.height)
    };
  }

  function activeDrawingColor() {
    return drawingPalette.find((entry) => entry.id === activeDrawColorId) || drawingPalette[0];
  }

  function resizeDrawingLayer() {
    if (!drawingLayerEl || !drawingLayerContext) {
      return null;
    }

    const bounds = getDrawingBounds();
    if (!bounds) {
      return null;
    }

    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const backingWidth = Math.max(1, Math.round(bounds.width * pixelRatio));
    const backingHeight = Math.max(1, Math.round(bounds.height * pixelRatio));

    if (drawingLayerEl.width !== backingWidth || drawingLayerEl.height !== backingHeight) {
      drawingLayerEl.width = backingWidth;
      drawingLayerEl.height = backingHeight;
      drawingLayerEl.style.width = `${Math.round(bounds.width)}px`;
      drawingLayerEl.style.height = `${Math.round(bounds.height)}px`;
    }

    drawingLayerContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    return bounds;
  }

  function drawStrokeOnLayer(context2d, stroke, bounds, alpha) {
    if (!stroke || !stroke.points.length) {
      return;
    }

    const scaleBase = Math.min(bounds.width, bounds.height);
    const points = stroke.points.map((point) => ({
      x: point.x * bounds.width,
      y: point.y * bounds.height
    }));

    context2d.save();
    context2d.globalAlpha = alpha;
    context2d.strokeStyle = stroke.color;
    context2d.fillStyle = stroke.color;
    context2d.lineWidth = Math.max(3.5, stroke.width * scaleBase);
    context2d.lineCap = "round";
    context2d.lineJoin = "round";

    if (points.length === 1) {
      context2d.beginPath();
      context2d.arc(points[0].x, points[0].y, context2d.lineWidth * 0.5, 0, Math.PI * 2);
      context2d.fill();
      context2d.restore();
      return;
    }

    context2d.beginPath();
    context2d.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      context2d.lineTo(points[index].x, points[index].y);
    }
    context2d.stroke();
    context2d.restore();
  }

  function collectRenderableDrawingStrokes() {
    const renderable = drawingState.strokes.slice();
    const localDeviceId = ctx ? ctx.deviceId : null;
    Object.entries(drawingState.inProgress).forEach(([deviceId, stroke]) => {
      if (activeLocalStroke && localDeviceId && deviceId === localDeviceId) {
        return;
      }
      renderable.push(stroke);
    });

    if (activeLocalStroke) {
      const previewStroke = normalizeDrawingStroke(activeLocalStroke);
      if (previewStroke) {
        renderable.push(previewStroke);
      }
    }

    return renderable;
  }

  function scheduleDrawingRender() {
    if (drawingRenderQueued) {
      return;
    }

    drawingRenderQueued = true;
    window.requestAnimationFrame(() => {
      drawingRenderQueued = false;
      renderDrawingLayer();
    });
  }

  function renderDrawingLayer() {
    if (!drawingLayerContext || !drawingLayerEl) {
      return;
    }

    const bounds = resizeDrawingLayer();
    if (!bounds) {
      return;
    }

    drawingLayerContext.clearRect(0, 0, bounds.width, bounds.height);
    collectRenderableDrawingStrokes().forEach((stroke) => {
      drawStrokeOnLayer(drawingLayerContext, stroke, bounds, 0.94);
    });
  }

  function drawingHasContent() {
    return Boolean(
      activeLocalStroke ||
      drawingState.strokes.length ||
      Object.keys(drawingState.inProgress).length
    );
  }

  function setActiveDrawColor(colorId) {
    if (!drawingPalette.some((entry) => entry.id === colorId)) {
      return;
    }
    activeDrawColorId = colorId;
    renderDrawingUi();
  }

  function renderDrawingUi() {
    const deviceId = ctx ? ctx.deviceId : "";

    if (drawingLayerEl) {
      drawingLayerEl.classList.toggle("active", isDrawModeActive);
      drawingLayerEl.setAttribute("aria-hidden", isDrawModeActive ? "false" : "true");
    }

    if (drawingToolbarEl) {
      drawingToolbarEl.classList.toggle("open", isDrawModeActive);
      drawingToolbarEl.setAttribute("aria-hidden", isDrawModeActive ? "false" : "true");
    }

    drawingColorButtons.forEach((button) => {
      const isActive = button.dataset.drawColorId === activeDrawColorId;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

    if (drawingUndoButtonEl) {
      drawingUndoButtonEl.disabled = !activeLocalStroke && !drawingState.strokes.some((stroke) => stroke.deviceId === deviceId);
    }

    if (drawingClearButtonEl) {
      drawingClearButtonEl.disabled = !drawingHasContent();
    }
  }

  function buildDrawingPaletteButtons() {
    if (!drawingPaletteEl) {
      return;
    }

    drawingPaletteEl.innerHTML = "";
    drawingColorButtons = drawingPalette.map((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "draw-color-button";
      button.dataset.drawColorId = entry.id;
      button.style.setProperty("--swatch-color", entry.color);
      button.title = entry.label;
      button.setAttribute("aria-label", entry.label);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setActiveDrawColor(entry.id);
      });
      drawingPaletteEl.appendChild(button);
      return button;
    });
    renderDrawingUi();
  }

  function setDrawModeActive(nextActive) {
    if (!drawingEnabled) {
      return;
    }

    isDrawModeActive = Boolean(nextActive);
    if (isDrawModeActive) {
      setTrayOpen(false);
      suppressStageToggleOnce();
    } else {
      cancelPendingDrawActivation();
    }
    renderDrawingUi();
  }

  function cancelDrawingFlush() {
    if (drawingFlushTimer) {
      window.clearTimeout(drawingFlushTimer);
      drawingFlushTimer = null;
    }
  }

  function queueDrawingMutation(mutator) {
    if (!drawingStore) {
      return Promise.resolve(null);
    }

    drawingMutationQueue = drawingMutationQueue
      .catch(() => null)
      .then(async () => {
        const currentValue = await drawingStore.get();
        const baseState = normalizeDrawingState(currentValue || drawingState);
        const nextState = mutator(baseState);
        if (typeof nextState === "undefined") {
          return {
            committed: false,
            value: baseState
          };
        }

        const normalizedState = normalizeDrawingState(nextState);
        normalizedState.updatedAt = now();
        normalizedState.actor = ctx.deviceId;
        normalizedState.revision = (Number(baseState.revision) || 0) + 1;

        await drawingStore.set(normalizedState);
        applyIncomingDrawingState(normalizedState);
        return {
          committed: true,
          value: normalizedState
        };
      })
      .catch((error) => {
        console.error("[drawing] mutation failed:", error);
        return null;
      });

    return drawingMutationQueue;
  }

  function snapshotActiveLocalStroke() {
    return activeLocalStroke ? normalizeDrawingStroke(activeLocalStroke) : null;
  }

  function scheduleDrawingPreviewFlush() {
    if (drawingFlushTimer || !activeLocalStroke) {
      return;
    }

    drawingFlushTimer = window.setTimeout(() => {
      drawingFlushTimer = null;
      const strokeSnapshot = snapshotActiveLocalStroke();
      if (!strokeSnapshot) {
        return;
      }
      void queueDrawingMutation((baseState) => {
        const nextState = normalizeDrawingState(baseState);
        nextState.inProgress = Object.assign({}, nextState.inProgress, {
          [ctx.deviceId]: strokeSnapshot
        });
        return nextState;
      });
    }, drawingPointBatchMs);
  }

  function startLocalStrokeFromClientPoint(clientX, clientY, pointerId) {
    const point = pointFromClientPosition(clientX, clientY);
    const color = activeDrawingColor();
    if (!point || !color) {
      return false;
    }

    activeDrawPointerId = pointerId;
    activeDrawInputType = typeof pointerId === "string" && pointerId.startsWith("touch-")
      ? "touch"
      : "pointer";
    activeLocalStroke = {
      id: createDrawingId("stroke"),
      deviceId: ctx.deviceId,
      color: color.color,
      width: drawingStrokeWidthRatio,
      points: [point],
      createdAt: now(),
      updatedAt: now(),
      lastClientX: Number(clientX) || 0,
      lastClientY: Number(clientY) || 0
    };
    scheduleDrawingRender();
    renderDrawingUi();
    scheduleDrawingPreviewFlush();
    return true;
  }

  function extendLocalStroke(clientX, clientY) {
    if (!activeLocalStroke) {
      return;
    }

    const dx = (Number(clientX) || 0) - activeLocalStroke.lastClientX;
    const dy = (Number(clientY) || 0) - activeLocalStroke.lastClientY;
    if (Math.hypot(dx, dy) < drawingPointDistancePx) {
      return;
    }

    const point = pointFromClientPosition(clientX, clientY);
    if (!point) {
      return;
    }

    if (activeLocalStroke.points.length >= drawingMaxPointsPerStroke) {
      activeLocalStroke.points[activeLocalStroke.points.length - 1] = point;
    } else {
      activeLocalStroke.points.push(point);
    }

    activeLocalStroke.lastClientX = Number(clientX) || 0;
    activeLocalStroke.lastClientY = Number(clientY) || 0;
    activeLocalStroke.updatedAt = now();
    scheduleDrawingRender();
    scheduleDrawingPreviewFlush();
  }

  function clearLocalDrawingInteraction() {
    cancelDrawingFlush();
    cancelPendingDrawActivation();
    activeDrawPointerId = null;
    activeDrawInputType = null;
    activeLocalStroke = null;
    scheduleDrawingRender();
    renderDrawingUi();
  }

  async function finishLocalStroke(commitStroke) {
    const finalStroke = snapshotActiveLocalStroke();
    cancelDrawingFlush();
    activeLocalStroke = null;
    activeDrawPointerId = null;
    activeDrawInputType = null;
    pendingDrawActivation = null;
    scheduleDrawingRender();
    renderDrawingUi();

    await queueDrawingMutation((baseState) => {
      const nextState = normalizeDrawingState(baseState);
      nextState.inProgress = Object.assign({}, nextState.inProgress);
      delete nextState.inProgress[ctx.deviceId];
      if (commitStroke && finalStroke) {
        nextState.strokes = nextState.strokes.concat(finalStroke).slice(-drawingMaxStoredStrokes);
      }
      return nextState;
    });
  }

  function cancelPendingDrawActivation() {
    if (drawLongPressTimer) {
      window.clearTimeout(drawLongPressTimer);
      drawLongPressTimer = null;
    }
    pendingDrawActivation = null;
  }

  function beginDrawModeActivation(event) {
    if (!drawingEnabled || isTrayOpen || isDrawModeActive || !stageEl || !event) {
      return;
    }

    if (trayActivatorEl && trayActivatorEl.contains(event.target)) {
      return;
    }

    if (event.isPrimary === false) {
      return;
    }

    if (event.button !== undefined && event.button !== 0) {
      return;
    }

    cancelPendingDrawActivation();
    pendingDrawActivation = {
      pointerId: event.pointerId,
      startX: Number(event.clientX) || 0,
      startY: Number(event.clientY) || 0
    };
    drawLongPressTimer = window.setTimeout(() => {
      const activation = pendingDrawActivation;
      drawLongPressTimer = null;
      pendingDrawActivation = null;
      if (!activation) {
        return;
      }

      setDrawModeActive(true);
      suppressStageToggleOnce();
      startLocalStrokeFromClientPoint(activation.startX, activation.startY, activation.pointerId);
    }, drawingLongPressMs);
  }

  function beginTouchDrawActivation(touch) {
    if (!drawingEnabled || isTrayOpen || isDrawModeActive || !touch) {
      return;
    }

    cancelPendingDrawActivation();
    pendingDrawActivation = {
      pointerId: `touch-${touch.identifier}`,
      startX: Number(touch.clientX) || 0,
      startY: Number(touch.clientY) || 0
    };
    drawLongPressTimer = window.setTimeout(() => {
      const activation = pendingDrawActivation;
      drawLongPressTimer = null;
      pendingDrawActivation = null;
      if (!activation) {
        return;
      }

      setDrawModeActive(true);
      suppressStageToggleOnce();
      startLocalStrokeFromClientPoint(activation.startX, activation.startY, activation.pointerId);
    }, drawingLongPressMs);
  }

  function updateTouchDrawActivation(touch) {
    if (!pendingDrawActivation || !touch) {
      return;
    }

    if (pendingDrawActivation.pointerId !== `touch-${touch.identifier}`) {
      return;
    }

    const dx = (Number(touch.clientX) || 0) - pendingDrawActivation.startX;
    const dy = (Number(touch.clientY) || 0) - pendingDrawActivation.startY;
    if (Math.hypot(dx, dy) >= drawingActivationMoveThresholdPx) {
      cancelPendingDrawActivation();
    }
  }

  function updateDrawActivation(event) {
    if (!pendingDrawActivation || event.pointerId !== pendingDrawActivation.pointerId) {
      return;
    }

    const dx = (Number(event.clientX) || 0) - pendingDrawActivation.startX;
    const dy = (Number(event.clientY) || 0) - pendingDrawActivation.startY;
    if (Math.hypot(dx, dy) >= drawingActivationMoveThresholdPx) {
      cancelPendingDrawActivation();
    }
  }

  function handleDrawingUndo() {
    if (activeLocalStroke) {
      clearLocalDrawingInteraction();
      void queueDrawingMutation((baseState) => {
        const nextState = normalizeDrawingState(baseState);
        nextState.inProgress = Object.assign({}, nextState.inProgress);
        delete nextState.inProgress[ctx.deviceId];
        return nextState;
      });
      return;
    }

    void queueDrawingMutation((baseState) => {
      const nextState = normalizeDrawingState(baseState);
      for (let index = nextState.strokes.length - 1; index >= 0; index -= 1) {
        if (nextState.strokes[index].deviceId === ctx.deviceId) {
          nextState.strokes = nextState.strokes.slice(0, index).concat(nextState.strokes.slice(index + 1));
          return nextState;
        }
      }
      return undefined;
    });
  }

  function handleDrawingClear() {
    clearLocalDrawingInteraction();
    void queueDrawingMutation((baseState) => {
      const nextState = normalizeDrawingState(baseState);
      if (!nextState.strokes.length && !Object.keys(nextState.inProgress).length) {
        return undefined;
      }
      nextState.strokes = [];
      nextState.inProgress = {};
      nextState.clearedAt = now();
      return nextState;
    });
  }

  function installFastTapBridge() {
    if (fastTapInstalled) {
      return;
    }
    fastTapInstalled = true;

    document.addEventListener("pointerdown", (event) => {
      if (!event || (event.pointerType !== "touch" && event.pointerType !== "pen")) {
        return;
      }

      const target = event.target instanceof Element
        ? event.target.closest(fastTapSelector)
        : null;

      if (!target || target.disabled) {
        activeFastTapPointer = null;
        return;
      }

      activeFastTapPointer = {
        pointerId: event.pointerId,
        target,
        startX: Number(event.clientX) || 0,
        startY: Number(event.clientY) || 0,
        moved: false
      };
    }, { capture: true, passive: true });

    document.addEventListener("pointermove", (event) => {
      if (!activeFastTapPointer || event.pointerId !== activeFastTapPointer.pointerId) {
        return;
      }

      const dx = (Number(event.clientX) || 0) - activeFastTapPointer.startX;
      const dy = (Number(event.clientY) || 0) - activeFastTapPointer.startY;
      if (Math.hypot(dx, dy) >= fastTapMoveThresholdPx) {
        activeFastTapPointer.moved = true;
      }
    }, { capture: true, passive: true });

    document.addEventListener("pointerup", (event) => {
      if (!event || (event.pointerType !== "touch" && event.pointerType !== "pen")) {
        return;
      }

      const pointerState = activeFastTapPointer;
      activeFastTapPointer = null;

      const target = event.target instanceof Element
        ? event.target.closest(fastTapSelector)
        : null;

      if (!target || target.disabled) {
        return;
      }

      if (!pointerState || pointerState.pointerId !== event.pointerId) {
        return;
      }

      if (pointerState.moved) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      target.click();
      lastFastTapTarget = target;
      lastFastTapAt = Date.now();
    }, { capture: true, passive: false });

    document.addEventListener("click", (event) => {
      if (!lastFastTapTarget || (Date.now() - lastFastTapAt) > 900) {
        return;
      }

      const target = event.target instanceof Element
        ? event.target.closest(fastTapSelector)
        : null;

      if (!target || target !== lastFastTapTarget) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      lastFastTapTarget = null;
      lastFastTapAt = 0;
    }, true);

    document.addEventListener("pointercancel", (event) => {
      if (!activeFastTapPointer || event.pointerId !== activeFastTapPointer.pointerId) {
        return;
      }
      activeFastTapPointer = null;
    }, { capture: true, passive: true });
  }

  function normalizeFrameTimeZone(value) {
    const normalized = String(value || "").trim();
    return frameTimeZoneOptions.some((option) => option.value === normalized) ? normalized : "";
  }

  function getFrameTimeZone() {
    try {
      const stored = normalizeFrameTimeZone(window.localStorage.getItem(frameTimeZoneStorageKey));
      if (stored) {
        return stored;
      }
    } catch (error) {
      // Ignore localStorage read failures and fall back to the default frame time zone.
    }
    return defaultFrameTimeZone;
  }

  function setFrameTimeZone(value) {
    const nextValue = normalizeFrameTimeZone(value) || defaultFrameTimeZone;
    try {
      window.localStorage.setItem(frameTimeZoneStorageKey, nextValue);
    } catch (error) {
      // Ignore localStorage write failures; this session can still render using nextValue.
    }
    return nextValue;
  }

  function getFrameTimeZoneOption() {
    return frameTimeZoneOptions.find((option) => option.value === getFrameTimeZone()) || frameTimeZoneOptions[2];
  }

  function formatFrameClock(timestamp) {
    const option = getFrameTimeZoneOption();
    const formatted = new Intl.DateTimeFormat(undefined, {
      timeZone: option.value,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(timestamp));
    return `${formatted} ${option.shortLabel}`;
  }

  function renderFrameTimeUi() {
    const option = getFrameTimeZoneOption();

    if (frameTimeDisplayEl) {
      frameTimeDisplayEl.textContent = formatFrameClock(Date.now());
    }

    if (frameTimeZoneSelectEl) {
      frameTimeZoneSelectEl.value = option.value;
    }

    if (frameTimeZoneNoteEl) {
      frameTimeZoneNoteEl.textContent = `Alarm times on this frame follow ${option.longLabel} (${option.shortLabel}).`;
    }
  }

  function startFrameClock() {
    if (frameClockTimer) {
      return;
    }

    renderFrameTimeUi();
    frameClockTimer = window.setInterval(() => {
      renderFrameTimeUi();
    }, 1000);
  }

  function normalizeImageUrl(url) {
    if (!url) {
      return "";
    }
    if (/^https?:\/\//i.test(url) || url.startsWith("/")) {
      return url;
    }
    return "/" + url.replace(/^\.?\//, "");
  }

  function normalizeImages(rawImages) {
    return (rawImages || [])
      .map((entry, index) => {
        if (!entry || !entry.url) {
          return null;
        }
        return {
          id: entry.id || `img-${index + 1}`,
          url: normalizeImageUrl(entry.url),
          caption: (entry.caption || "").trim(),
          driveFileId: (entry.driveFileId || "").trim()
        };
      })
      .filter(Boolean);
  }

  function clampDurationMs(value) {
    const durationMs = Number(value) || defaultSlideDurationMs;
    return Math.min(120000, Math.max(3000, durationMs));
  }

  function identityOrder(length) {
    return Array.from({ length }, (_, index) => index);
  }

  function ordersEqual(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => value === right[index]);
  }

  function normalizeOrder(order) {
    if (!Array.isArray(order) || order.length !== images.length) {
      return identityOrder(images.length);
    }

    const uniqueValues = new Set(order);
    if (uniqueValues.size !== images.length) {
      return identityOrder(images.length);
    }

    const valid = order.every((value) => Number.isInteger(value) && value >= 0 && value < images.length);
    return valid ? order.slice() : identityOrder(images.length);
  }

  function normalizeState(rawState) {
    const base = rawState && typeof rawState === "object" ? rawState : {};
    const count = images.length;
    const order = normalizeOrder(base.order);
    const durationMs = clampDurationMs(base.slideDurationMs);
    const startedAt = typeof base.startedAt === "number" ? base.startedAt : now();
    const currentIndex = count
      ? ((Number(base.currentIndex) || 0) % count + count) % count
      : 0;

    return {
      currentIndex,
      isPlaying: base.isPlaying !== false,
      startedAt,
      slideDurationMs: durationMs,
      order,
      actor: base.actor || null,
      updatedAt: typeof base.updatedAt === "number" ? base.updatedAt : now(),
      manifestVersion: typeof base.manifestVersion === "number" ? base.manifestVersion : currentManifestVersion
    };
  }

  function buildDefaultState() {
    return normalizeState({
      currentIndex: 0,
      isPlaying: true,
      startedAt: now(),
      slideDurationMs: defaultSlideDurationMs,
      order: identityOrder(images.length),
      manifestVersion: currentManifestVersion
    });
  }

  function getEffectiveSequenceIndex(state, at) {
    const timestamp = typeof at === "number" ? at : now();
    if (!images.length || !state) {
      return 0;
    }

    if (!state.isPlaying) {
      return state.currentIndex;
    }

    const elapsed = Math.max(0, timestamp - state.startedAt);
    const offset = Math.floor(elapsed / state.slideDurationMs);
    return (state.currentIndex + offset) % images.length;
  }

  function getRenderedImage(state, at) {
    if (!images.length || !state) {
      return null;
    }

    const sequenceIndex = getEffectiveSequenceIndex(state, at);
    const imageIndex = state.order[sequenceIndex] ?? sequenceIndex;
    return {
      sequenceIndex,
      imageIndex,
      image: images[imageIndex]
    };
  }

  function getCurrentImageUrl() {
    const rendered = getRenderedImage(slideshowState);
    return rendered && rendered.image ? rendered.image.url : "";
  }

  function computeLocalFingerprint(imagesList) {
    return (imagesList || [])
      .map((image) => image.driveFileId || image.url)
      .join("|");
  }

  function isSlideShuffleActive(state) {
    if (!state || images.length < 2) {
      return false;
    }

    const order = normalizeOrder(state.order);
    return order.some((value, index) => value !== index);
  }

  function prefersReducedMotion() {
    return Boolean(
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function getTransitionDurationMs() {
    const slideDurationMs = slideshowState ? slideshowState.slideDurationMs : defaultSlideDurationMs;
    return Math.max(2200, Math.min(4200, Math.round(slideDurationMs * 0.28)));
  }

  function getTransitionWeight(preset) {
    const name = (preset && preset.name) || "";

    if (/^(corner-turn|edge-turn|edge-flip)/.test(name)) {
      return 7;
    }

    if (/^(turn|flip|mirror|hinge|door|carousel)/.test(name)) {
      return 5;
    }

    if (/^(corner|arrival|rise-reveal|fall-reveal|sweep|glide|skew)/.test(name)) {
      return 4;
    }

    if (/^(tilt|whisper|bloom|zoom|soft-focus)/.test(name)) {
      return 2;
    }

    return 1;
  }

  function pickTransition(previousImage, nextImage) {
    if (!previousImage || !nextImage || prefersReducedMotion()) {
      return transitionPresets[0];
    }

    const weightedIndexes = [];
    transitionPresets.forEach((preset, index) => {
      const weight = Math.max(1, Number(preset.weight) || getTransitionWeight(preset));
      for (let count = 0; count < weight; count += 1) {
        weightedIndexes.push(index);
      }
    });

    let nextIndex = weightedIndexes[Math.floor(Math.random() * weightedIndexes.length)] || 0;
    if (transitionPresets.length > 1 && nextIndex === lastTransitionIndex) {
      const filteredIndexes = weightedIndexes.filter((index) => index !== lastTransitionIndex);
      if (filteredIndexes.length) {
        nextIndex = filteredIndexes[Math.floor(Math.random() * filteredIndexes.length)];
      }
    }
    lastTransitionIndex = nextIndex;
    return transitionPresets[nextIndex];
  }

  function clearTransitionVariables(element) {
    [
      "--photo-enter-from-x",
      "--photo-enter-from-y",
      "--photo-enter-from-scale",
      "--photo-enter-from-scale-x",
      "--photo-enter-from-scale-y",
      "--photo-enter-from-rotate",
      "--photo-enter-from-rotate-x",
      "--photo-enter-from-rotate-y",
      "--photo-enter-from-skew-x",
      "--photo-enter-from-skew-y",
      "--photo-enter-from-blur",
      "--photo-exit-to-x",
      "--photo-exit-to-y",
      "--photo-exit-to-scale",
      "--photo-exit-to-scale-x",
      "--photo-exit-to-scale-y",
      "--photo-exit-to-rotate",
      "--photo-exit-to-rotate-x",
      "--photo-exit-to-rotate-y",
      "--photo-exit-to-skew-x",
      "--photo-exit-to-skew-y",
      "--photo-exit-to-blur"
    ].forEach((property) => {
      element.style.removeProperty(property);
    });
  }

  function resetPhotoElement(element, opacity) {
    element.style.animation = "none";
    element.style.opacity = String(opacity);
    element.style.transform = "translate3d(0, 0, 0) rotateX(0deg) rotateY(0deg) rotate(0deg) skewX(0deg) skewY(0deg) scale(1, 1)";
    element.style.filter = "blur(0px)";
    element.style.transformOrigin = "50% 50%";
    element.style.zIndex = opacity ? "1" : "0";
    clearTransitionVariables(element);
    void element.offsetWidth;
  }

  function applyEnterTransition(element, preset, durationMs) {
    const enter = (preset && preset.enter) || {};
    element.style.setProperty("--photo-enter-from-x", enter.fromX || "0%");
    element.style.setProperty("--photo-enter-from-y", enter.fromY || "0%");
    element.style.setProperty("--photo-enter-from-scale", enter.fromScale || "1.02");
    element.style.setProperty("--photo-enter-from-scale-x", enter.fromScaleX || enter.fromScale || "1.02");
    element.style.setProperty("--photo-enter-from-scale-y", enter.fromScaleY || enter.fromScale || "1.02");
    element.style.setProperty("--photo-enter-from-rotate", enter.fromRotate || "0deg");
    element.style.setProperty("--photo-enter-from-rotate-x", enter.fromRotateX || "0deg");
    element.style.setProperty("--photo-enter-from-rotate-y", enter.fromRotateY || "0deg");
    element.style.setProperty("--photo-enter-from-skew-x", enter.fromSkewX || "0deg");
    element.style.setProperty("--photo-enter-from-skew-y", enter.fromSkewY || "0deg");
    element.style.setProperty("--photo-enter-from-blur", enter.fromBlur || "0px");
    element.style.transformOrigin = enter.origin || "50% 50%";
    element.style.zIndex = "2";
    element.style.opacity = "1";
    element.style.animation = `sanny-photo-enter ${durationMs}ms cubic-bezier(0.23, 0.82, 0.32, 1) both`;
  }

  function applyExitTransition(element, preset, durationMs) {
    const exit = (preset && preset.exit) || {};
    element.style.setProperty("--photo-exit-to-x", exit.toX || "0%");
    element.style.setProperty("--photo-exit-to-y", exit.toY || "0%");
    element.style.setProperty("--photo-exit-to-scale", exit.toScale || "0.985");
    element.style.setProperty("--photo-exit-to-scale-x", exit.toScaleX || exit.toScale || "0.985");
    element.style.setProperty("--photo-exit-to-scale-y", exit.toScaleY || exit.toScale || "0.985");
    element.style.setProperty("--photo-exit-to-rotate", exit.toRotate || "0deg");
    element.style.setProperty("--photo-exit-to-rotate-x", exit.toRotateX || "0deg");
    element.style.setProperty("--photo-exit-to-rotate-y", exit.toRotateY || "0deg");
    element.style.setProperty("--photo-exit-to-skew-x", exit.toSkewX || "0deg");
    element.style.setProperty("--photo-exit-to-skew-y", exit.toSkewY || "0deg");
    element.style.setProperty("--photo-exit-to-blur", exit.toBlur || "0px");
    element.style.transformOrigin = exit.origin || "50% 50%";
    element.style.zIndex = "1";
    element.style.opacity = "1";
    element.style.animation = `sanny-photo-exit ${durationMs}ms cubic-bezier(0.3, 0.0, 0.18, 1) both`;
  }

  async function fetchAlbum() {
    const response = await fetch("/album.json", { cache: "no-store" });
    const data = await response.json();
    images = normalizeImages(data.images);
    localFingerprint = (data.fingerprint || "").trim() || computeLocalFingerprint(images);
    if (!currentManifestVersion) {
      currentManifestVersion = 0;
    }
    return data;
  }

  function buildStateForAlbum(baseState, preferredImageUrl, manifestVersion) {
    const order = identityOrder(images.length);
    let currentIndex = 0;

    if (preferredImageUrl) {
      const matchedIndex = images.findIndex((image) => image.url === preferredImageUrl);
      if (matchedIndex >= 0) {
        currentIndex = matchedIndex;
      }
    }

    return normalizeState({
      ...baseState,
      currentIndex,
      startedAt: now(),
      order,
      manifestVersion
    });
  }

  function shouldUseSharedAlbum() {
    return Boolean(ctx && ctx.syncEnabled && ctx.syncSlidesEnabled && inSyncWithRoom);
  }

  function activeAlbumStore() {
    return shouldUseSharedAlbum() ? sharedAlbumStore : localAlbumStore;
  }

  function showImage(image, previousImage, sequenceIndex) {
    if (!image || !imgA || !imgB) {
      return;
    }

    const nextImg = showingA ? imgB : imgA;
    const prevImg = showingA ? imgA : imgB;
    const visibleImg = showingA ? imgA : imgB;

    if (previousImage && previousImage.url === image.url) {
      visibleImg.alt = image.caption || "Slideshow photo";
      return;
    }

    resetPhotoElement(prevImg, previousImage ? 1 : 0);
    resetPhotoElement(nextImg, 0);

    nextImg.src = image.url;
    nextImg.alt = image.caption || "Slideshow photo";

    if (!previousImage || prefersReducedMotion()) {
      nextImg.style.zIndex = "2";
      nextImg.style.opacity = "1";
      prevImg.style.opacity = "0";
    } else {
      const transition = pickTransition(previousImage, image);
      const durationMs = getTransitionDurationMs();
      applyEnterTransition(nextImg, transition, durationMs);
      applyExitTransition(prevImg, transition, durationMs);
    }

    showingA = !showingA;
  }

  function render(force) {
    if (!slideshowState) {
      return;
    }

    const timestamp = now();
    if (!force && shouldReshuffleSlideCycle(slideshowState, timestamp)) {
      maybeReshuffleSlideCycle(timestamp).catch((error) => {
        console.error("[album] failed to reshuffle slide cycle:", error);
      });
      return;
    }

    if (slideShuffleButtonEl) {
      const shuffleActive = isSlideShuffleActive(slideshowState);
      slideShuffleButtonEl.classList.toggle("is-active", shuffleActive);
      slideShuffleButtonEl.setAttribute("aria-pressed", shuffleActive ? "true" : "false");
      slideShuffleButtonEl.textContent = shuffleActive ? "Shuffled" : "Shuffle";
      slideShuffleButtonEl.title = shuffleActive
        ? "Slides are in shuffled order. Tap to reshuffle."
        : "Shuffle slides";
    }

    const rendered = getRenderedImage(slideshowState, timestamp);
    if (!rendered || !rendered.image) {
      captionEl.textContent = "No photos found. Add files to static/images or run Drive sync.";
      captionEl.classList.remove("empty");
      slidePositionEl.textContent = "0 / 0";
      return;
    }

    const renderKey = `${rendered.sequenceIndex}:${rendered.image.id}`;
    if (force || renderKey !== lastRenderedKey) {
      showImage(rendered.image, lastRenderedImage, rendered.sequenceIndex);
      lastRenderedImage = rendered.image;
      lastRenderedKey = renderKey;
    }

    slidePositionEl.textContent = `${rendered.sequenceIndex + 1} / ${images.length}`;

    if (rendered.image.caption) {
      captionEl.textContent = rendered.image.caption;
      captionEl.classList.remove("empty");
    } else {
      captionEl.textContent = "";
      captionEl.classList.add("empty");
    }

    const currentSeconds = Math.round(slideshowState.slideDurationMs / 1000);
    if (document.activeElement !== slideDurationInput) {
      slideDurationInput.value = String(currentSeconds);
    }
  }

  function startRenderLoop() {
    if (renderTimer) {
      return;
    }
    renderTimer = window.setInterval(() => render(false), 250);
  }

  function randomizeOrderKeepingCurrent(state) {
    const current = getRenderedImage(state);
    const currentImageIndex = current ? current.imageIndex : 0;
    const remaining = identityOrder(images.length).filter((value) => value !== currentImageIndex);

    for (let index = remaining.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      const tmp = remaining[index];
      remaining[index] = remaining[swapIndex];
      remaining[swapIndex] = tmp;
    }

    return [currentImageIndex].concat(remaining);
  }

  function buildFreshCycleOrder(avoidFirstIndex, previousOrder) {
    const total = images.length;
    if (total <= 1) {
      return identityOrder(total);
    }

    const sourceOrder = identityOrder(total);
    let candidate = sourceOrder.slice();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      candidate = sourceOrder.slice();
      for (let index = candidate.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        const temp = candidate[index];
        candidate[index] = candidate[swapIndex];
        candidate[swapIndex] = temp;
      }

      if (candidate[0] === avoidFirstIndex && candidate.length > 1) {
        const swapIndex = 1 + Math.floor(Math.random() * (candidate.length - 1));
        const temp = candidate[0];
        candidate[0] = candidate[swapIndex];
        candidate[swapIndex] = temp;
      }

      if (!ordersEqual(candidate, previousOrder)) {
        return candidate;
      }
    }

    if (ordersEqual(candidate, previousOrder) && candidate.length > 2) {
      const rotated = candidate.slice(1).concat(candidate[0]);
      if (rotated[0] !== avoidFirstIndex && !ordersEqual(rotated, previousOrder)) {
        return rotated;
      }
    }

    return candidate;
  }

  function shouldReshuffleSlideCycle(state, timestamp) {
    if (!state || !state.isPlaying || !isSlideShuffleActive(state) || images.length < 2) {
      return false;
    }

    const elapsed = Math.max(0, timestamp - state.startedAt);
    const advancedSlides = Math.floor(elapsed / state.slideDurationMs);
    return state.currentIndex + advancedSlides >= images.length;
  }

  async function maybeReshuffleSlideCycle(timestamp) {
    if (cycleReshuffleInFlight || !shouldReshuffleSlideCycle(slideshowState, timestamp)) {
      return false;
    }

    const store = activeAlbumStore();
    if (!store || typeof store.mutate !== "function") {
      return false;
    }

    cycleReshuffleInFlight = true;
    try {
      const result = await store.mutate((currentState) => {
        const baseState = normalizeState(currentState || slideshowState || buildDefaultState());
        if (!shouldReshuffleSlideCycle(baseState, timestamp)) {
          return;
        }

        const elapsed = Math.max(0, timestamp - baseState.startedAt);
        const advancedSlides = Math.floor(elapsed / baseState.slideDurationMs);
        const wrappedIndex = (baseState.currentIndex + advancedSlides) % images.length;
        const remainderMs = elapsed % baseState.slideDurationMs;
        const previousOrder = normalizeOrder(baseState.order);
        const terminalImageIndex = previousOrder[images.length - 1] ?? previousOrder[0] ?? 0;
        const nextOrder = buildFreshCycleOrder(terminalImageIndex, previousOrder);
        const nextState = normalizeState({
          ...baseState,
          currentIndex: wrappedIndex,
          order: nextOrder,
          startedAt: timestamp - remainderMs
        });

        nextState.actor = ctx.deviceId;
        nextState.updatedAt = timestamp;
        return nextState;
      });

      if (!result || result.committed === false || !result.value) {
        return false;
      }

      if (store !== localAlbumStore) {
        await localAlbumStore.set(normalizeState(result.value));
      }
      return true;
    } finally {
      cycleReshuffleInFlight = false;
    }
  }

  function shouldIgnoreKeyboardTarget(target) {
    if (!target) {
      return false;
    }
    const tagName = target.tagName ? target.tagName.toLowerCase() : "";
    return tagName === "input" || tagName === "textarea" || target.isContentEditable;
  }

  function clearTrayHideTimer() {
    if (trayHideTimer) {
      window.clearTimeout(trayHideTimer);
      trayHideTimer = null;
    }
  }

  function scheduleTrayHide() {
    clearTrayHideTimer();
  }

  function normalizeTrayPanel(panelName) {
    return trayPanelNames.includes(panelName) ? panelName : "slideshow";
  }

  function setActiveTrayPanel(panelName) {
    activeTrayPanel = normalizeTrayPanel(panelName);
    window.localStorage.setItem(trayPanelStorageKey, activeTrayPanel);

    trayPanelButtons.forEach((button) => {
      const isActive = button.dataset.trayPanelTarget === activeTrayPanel;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

    trayPanels.forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.trayPanel === activeTrayPanel);
    });
  }

  function setTrayOpen(open) {
    if (open && isDrawModeActive) {
      return;
    }

    isTrayOpen = Boolean(open);
    trayEl.classList.toggle("open", isTrayOpen);
    trayEl.setAttribute("aria-hidden", isTrayOpen ? "false" : "true");
    if (trayToggleButton) {
      trayToggleButton.classList.toggle("hidden-while-open", isTrayOpen);
      trayToggleButton.textContent = isTrayOpen ? "Controls Open" : "Controls";
    }
    clearTrayHideTimer();
  }

  function markTrayActivity() {
    clearTrayHideTimer();
  }

  function handleTrayCloseInteraction(event) {
    void postTouchDebug("tray-close", event, { source: "close-interaction" });
    if (event) {
      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();
    }
    setTrayOpen(false);
  }

  function suppressStageToggleOnce() {
    suppressNextStageClick = true;
    suppressStageClickUntil = Date.now() + 700;
  }

  function handleStageTrayToggle() {
    setTrayOpen(!isTrayOpen);
  }

  function isPointInsideTray(clientX, clientY) {
    if (!trayEl || !isTrayOpen) {
      return false;
    }

    const rect = trayEl.getBoundingClientRect();
    return (
      Number.isFinite(clientX) &&
      Number.isFinite(clientY) &&
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  function eventPointIsInsideTray(event) {
    if (!event) {
      return false;
    }

    if (trayEl && trayEl.contains(event.target)) {
      return true;
    }

    if (event.changedTouches && event.changedTouches[0]) {
      const touch = event.changedTouches[0];
      return isPointInsideTray(touch.clientX, touch.clientY);
    }

    if (event.touches && event.touches[0]) {
      const touch = event.touches[0];
      return isPointInsideTray(touch.clientX, touch.clientY);
    }

    return isPointInsideTray(event.clientX, event.clientY);
  }

  function handleOpenTrayDocumentInteraction(event) {
    void postTouchDebug("doc-capture", event, { source: "document-capture" });
    if (!isTrayOpen) {
      return;
    }

    if (eventPointIsInsideTray(event)) {
      markTrayActivity();
      suppressStageToggleOnce();
      return;
    }

    handleTrayCloseInteraction(event);
    suppressStageToggleOnce();
  }

  function updateTrayContext() {
    if (!ctx) {
      trayContextEl.textContent = "Local appliance mode";
      return;
    }

    if (!ctx.syncEnabled || !ctx.syncSlidesEnabled) {
      trayContextEl.textContent = "Local appliance mode";
      return;
    }

    trayContextEl.textContent = inSyncWithRoom
      ? `Mirroring room ${ctx.roomId}`
      : `Room ${ctx.roomId} • waiting for local photo sync`;
  }

  async function cacheRoomMetaStatus() {
    const nextKey = `${roomLibraryFingerprint}|${inSyncWithRoom}`;
    if (!nextKey || nextKey === lastRoomMetaCacheKey) {
      return;
    }

    lastRoomMetaCacheKey = nextKey;
    try {
      await fetch("/sync/room-meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomLibraryFingerprint,
          inSyncWithRoom
        })
      });
    } catch (error) {
      console.warn("[album] Could not cache room library metadata:", error);
    }
  }

  function renderSyncStatus() {
    syncStatusEl.classList.remove("status-danger", "status-ok", "status-warn");
    syncButtonEl.disabled = Boolean(syncInFlight || (syncState && syncState.running));

    if (ctx && ctx.syncEnabled && ctx.syncSlidesEnabled && !inSyncWithRoom) {
      syncStatusEl.textContent = "Library changed on another frame. Run Sync Now to rejoin sync.";
      syncStatusEl.classList.add("status-warn");
      return;
    }

    if (syncInFlight || (syncState && syncState.running)) {
      syncStatusEl.textContent = "Syncing photos from Google Drive...";
      syncStatusEl.classList.add("status-warn");
      return;
    }

    if (!syncState) {
      syncStatusEl.textContent = ctx && ctx.syncEnabled
        ? `Mirroring room ${ctx.roomId}.`
        : "No sync activity yet.";
      return;
    }

    if (syncState.lastError) {
      syncStatusEl.textContent = `Sync failed: ${syncState.lastError}`;
      syncStatusEl.classList.add("status-danger");
      return;
    }

    if (syncState.lastSuccessAt) {
      const when = new Date(syncState.lastSuccessAt).toLocaleString();
      const action = syncState.changed ? "updated" : "checked";
      if (syncState.lastWarning) {
        syncStatusEl.textContent = `Drive sync ${action} ${syncState.count} photos at ${when}. ${syncState.lastWarning}`;
        syncStatusEl.classList.add("status-warn");
      } else {
        syncStatusEl.textContent = `Drive sync ${action} ${syncState.count} photos at ${when}.`;
        syncStatusEl.classList.add("status-ok");
      }
      return;
    }

    syncStatusEl.textContent = ctx && ctx.syncEnabled
      ? `Mirroring room ${ctx.roomId}.`
      : "No sync activity yet.";
  }

  async function fetchSyncStatus() {
    try {
      const response = await fetch("/sync/status", { cache: "no-store" });
      syncState = await response.json();
      if (!roomLibraryFingerprint && syncState.roomLibraryFingerprint) {
        roomLibraryFingerprint = syncState.roomLibraryFingerprint;
      }
      if (typeof syncState.inSyncWithRoom === "boolean" && !ctx.syncEnabled) {
        inSyncWithRoom = syncState.inSyncWithRoom;
      }
    } catch (error) {
      syncState = {
        ok: false,
        running: false,
        count: images.length,
        changed: false,
        lastSuccessAt: null,
        lastError: "Could not read sync status.",
        lastWarning: ""
      };
    }
    updateTrayContext();
    renderSyncStatus();
  }

  async function ensureRoomLibrarySeeded() {
    if (!ctx.syncEnabled || !ctx.syncSlidesEnabled || !libraryStore || !localFingerprint) {
      return;
    }

    const existingMeta = await libraryStore.get();
    if (existingMeta && existingMeta.libraryFingerprint) {
      return;
    }

    await libraryStore.set({
      libraryFingerprint: localFingerprint,
      count: images.length,
      updatedAt: now(),
      updatedBy: ctx.deviceId
    });
  }

  async function publishLibraryFingerprint() {
    if (!ctx.syncEnabled || !ctx.syncSlidesEnabled || !libraryStore || !localFingerprint) {
      return;
    }

    roomLibraryFingerprint = localFingerprint;
    inSyncWithRoom = true;
    await libraryStore.set({
      libraryFingerprint: localFingerprint,
      count: images.length,
      updatedAt: now(),
      updatedBy: ctx.deviceId
    });
    updateTrayContext();
    renderSyncStatus();
    cacheRoomMetaStatus();
  }

  async function maybeSeedSharedAlbumState() {
    if (!ctx.syncEnabled || !ctx.syncSlidesEnabled || !sharedAlbumStore || !inSyncWithRoom) {
      return;
    }

    const existing = await sharedAlbumStore.get();
    if (existing) {
      return;
    }

    const baseState = localAlbumState || buildDefaultState();
    await sharedAlbumStore.set(normalizeState(baseState));
  }

  async function applyDisplayedState(sourceState) {
    if (!sourceState) {
      return;
    }

    const normalizedState = normalizeState(sourceState);

    if (normalizedState.manifestVersion !== currentManifestVersion) {
      try {
        await fetchAlbum();
        currentManifestVersion = normalizedState.manifestVersion;
      } catch (error) {
        console.error("[album] Failed to refresh album manifest:", error);
      }
    }

    slideshowState = normalizeState(normalizedState);
    render(true);
  }

  async function handleLocalAlbumState(nextState) {
    localAlbumState = normalizeState(nextState || buildDefaultState());
    if (!shouldUseSharedAlbum()) {
      await applyDisplayedState(localAlbumState);
    }
  }

  async function handleSharedAlbumState(nextState) {
    sharedAlbumState = normalizeState(nextState || buildDefaultState());
    if (shouldUseSharedAlbum()) {
      await applyDisplayedState(sharedAlbumState);
    }
  }

  async function handleLibraryState(nextState) {
    const meta = nextState && typeof nextState === "object" ? nextState : {};

    if (!meta.libraryFingerprint) {
      await ensureRoomLibrarySeeded();
      return;
    }

    roomLibraryFingerprint = String(meta.libraryFingerprint || "");
    inSyncWithRoom = !roomLibraryFingerprint || roomLibraryFingerprint === localFingerprint;
    updateTrayContext();
    renderSyncStatus();
    cacheRoomMetaStatus();

    if (inSyncWithRoom) {
      await maybeSeedSharedAlbumState();
      await applyDisplayedState(sharedAlbumState || localAlbumState || buildDefaultState());
    } else {
      await applyDisplayedState(localAlbumState || buildDefaultState());
    }
  }

  async function commitState(mutator) {
    const store = activeAlbumStore();
    if (!store || !slideshowState) {
      return;
    }

    const baseState = normalizeState(slideshowState);
    const nextState = normalizeState(mutator(baseState));
    nextState.actor = ctx.deviceId;
    nextState.updatedAt = now();

    await store.set(nextState);
    await localAlbumStore.set(nextState);
  }

  async function goToRelative(offset) {
    if (!images.length) {
      return;
    }
    await commitState((baseState) => ({
      ...baseState,
      currentIndex: (getEffectiveSequenceIndex(baseState) + offset + images.length) % images.length,
      startedAt: now()
    }));
  }

  async function setPlaying(isPlaying) {
    await commitState((baseState) => ({
      ...baseState,
      currentIndex: getEffectiveSequenceIndex(baseState),
      isPlaying,
      startedAt: now()
    }));
  }

  async function setDurationFromSeconds(seconds) {
    const nextDurationMs = clampDurationMs(Number(seconds) * 1000);
    await commitState((baseState) => ({
      ...baseState,
      currentIndex: getEffectiveSequenceIndex(baseState),
      slideDurationMs: nextDurationMs,
      startedAt: now()
    }));
  }

  async function shuffleSlides() {
    await commitState((baseState) => ({
      ...baseState,
      currentIndex: 0,
      order: randomizeOrderKeepingCurrent(baseState),
      startedAt: now()
    }));
  }

  function clearTrayLongPress() {
    if (trayLongPressTimer) {
      window.clearTimeout(trayLongPressTimer);
      trayLongPressTimer = null;
    }
  }

  function startTrayLongPress(event) {
    if (isTrayOpen || isDrawModeActive) {
      return;
    }

    if (event.pointerType && event.pointerType !== "touch") {
      return;
    }

    clearTrayLongPress();
    trayLongPressTimer = window.setTimeout(() => {
      setTrayOpen(true);
    }, trayLongPressMs);
  }

  async function refreshAlbumState(preferredImageUrl, manifestVersion) {
    await fetchAlbum();
    currentManifestVersion = manifestVersion;

    const baseState = normalizeState(slideshowState || localAlbumState || buildDefaultState());
    const nextState = buildStateForAlbum(baseState, preferredImageUrl, manifestVersion);
    nextState.actor = ctx.deviceId;
    nextState.updatedAt = now();
    await localAlbumStore.set(nextState);
    return nextState;
  }

  async function runDriveSync() {
    if (syncInFlight) {
      return;
    }

    syncInFlight = true;
    renderSyncStatus();
    markTrayActivity();

    const preferredImageUrl = getCurrentImageUrl();
    const previousLocalFingerprint = localFingerprint;

    try {
      const response = await fetch("/sync/drive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      syncState = await response.json();
      renderSyncStatus();

      if (!syncState.ok) {
        return;
      }

      const manifestVersion = now();
      const nextLocalState = await refreshAlbumState(preferredImageUrl, manifestVersion);
      const shouldRefreshSharedState = Boolean(
        ctx.syncEnabled &&
        ctx.syncSlidesEnabled &&
        sharedAlbumStore &&
        (!roomLibraryFingerprint || roomLibraryFingerprint === previousLocalFingerprint)
      );

      if (shouldRefreshSharedState) {
        await sharedAlbumStore.set(nextLocalState);
      }

      if (ctx.syncEnabled && ctx.syncSlidesEnabled) {
        await publishLibraryFingerprint();
      } else {
        inSyncWithRoom = true;
        roomLibraryFingerprint = localFingerprint;
        cacheRoomMetaStatus();
      }
    } catch (error) {
      syncState = {
        ok: false,
        running: false,
        count: images.length,
        changed: false,
        lastSuccessAt: null,
        lastError: error.message || "Drive sync failed.",
        lastWarning: ""
      };
      renderSyncStatus();
    } finally {
      syncInFlight = false;
      renderSyncStatus();
    }
  }

  function wireControls() {
    document.getElementById("next").addEventListener("click", () => {
      markTrayActivity();
      if (images.length) {
        goToRelative(1);
      }
    });

    document.getElementById("prev").addEventListener("click", () => {
      markTrayActivity();
      if (images.length) {
        goToRelative(-1);
      }
    });

    document.getElementById("play").addEventListener("click", () => {
      markTrayActivity();
      setPlaying(true);
    });

    document.getElementById("pause").addEventListener("click", () => {
      markTrayActivity();
      setPlaying(false);
    });

    document.getElementById("shuffle").addEventListener("click", () => {
      markTrayActivity();
      if (images.length > 1) {
        shuffleSlides();
      }
    });

    slideDurationInput.addEventListener("change", () => {
      markTrayActivity();
      setDurationFromSeconds(slideDurationInput.value);
    });

    syncButtonEl.addEventListener("click", () => {
      runDriveSync();
    });

    if (frameTimeZoneSelectEl) {
      frameTimeZoneSelectEl.addEventListener("change", () => {
        const nextTimeZone = setFrameTimeZone(frameTimeZoneSelectEl.value);
        renderFrameTimeUi();
        window.dispatchEvent(new window.CustomEvent("sanny:frame-timezone-changed", {
          detail: { timeZone: nextTimeZone }
        }));
      });
    }

    reloadButtonEl.addEventListener("click", () => {
      window.location.reload();
    });

    if (drawingToolbarEl) {
      ["pointerdown", "pointerup", "click", "touchstart", "touchend"].forEach((eventName) => {
        drawingToolbarEl.addEventListener(eventName, (event) => {
          if (event.type !== "pointerdown" && event.type !== "touchstart") {
            event.stopPropagation();
            return;
          }
          suppressStageToggleOnce();
          event.stopPropagation();
        }, { passive: eventName.startsWith("touch") });
      });
    }

    if (drawingDoneButtonEl) {
      drawingDoneButtonEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setDrawModeActive(false);
      });
    }

    if (drawingUndoButtonEl) {
      drawingUndoButtonEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleDrawingUndo();
      });
    }

    if (drawingClearButtonEl) {
      drawingClearButtonEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleDrawingClear();
      });
    }

    if (trayToggleButton) {
      trayToggleButton.addEventListener("click", () => {
        setTrayOpen(!isTrayOpen);
      });
    }

    trayCloseButton.addEventListener("pointerdown", handleTrayCloseInteraction);
    trayCloseButton.addEventListener("click", handleTrayCloseInteraction);

    trayEl.addEventListener("pointerdown", (event) => {
      void postTouchDebug("tray-pointerdown", event);
      suppressStageToggleOnce();
      markTrayActivity();
    });
    trayEl.addEventListener("pointermove", markTrayActivity);
    trayEl.addEventListener("touchstart", (event) => {
      void postTouchDebug("tray-touchstart", event);
      suppressStageToggleOnce();
      markTrayActivity();
    }, { passive: true });
    trayEl.addEventListener("touchend", (event) => {
      void postTouchDebug("tray-touchend", event);
      suppressStageToggleOnce();
      markTrayActivity();
    }, { passive: true });
    trayEl.addEventListener("input", markTrayActivity);
    trayEl.addEventListener("focusin", markTrayActivity);
    trayEl.addEventListener("click", (event) => {
      event.stopPropagation();
      void postTouchDebug("tray-click", event);
      suppressStageToggleOnce();
      const button = event.target.closest("[data-tray-panel-target]");
      if (!button) {
        return;
      }

      setActiveTrayPanel(button.dataset.trayPanelTarget);
      markTrayActivity();
    });

    document.addEventListener("pointerdown", handleOpenTrayDocumentInteraction, true);
    document.addEventListener("touchstart", handleOpenTrayDocumentInteraction, { capture: true, passive: false });

    document.addEventListener("keydown", (event) => {
      if (isDrawModeActive) {
        if (event.key === "Escape") {
          event.preventDefault();
          setDrawModeActive(false);
        }
        return;
      }

      if (event.key.toLowerCase() === "s" && !shouldIgnoreKeyboardTarget(event.target)) {
        event.preventDefault();
        setTrayOpen(!isTrayOpen);
        return;
      }

      if (event.key === "Escape" && isTrayOpen) {
        event.preventDefault();
        setTrayOpen(false);
        return;
      }

      if (shouldIgnoreKeyboardTarget(event.target)) {
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        goToRelative(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToRelative(-1);
      } else if (event.key === " ") {
        event.preventDefault();
        setPlaying(!(slideshowState && slideshowState.isPlaying));
      }
    });

    stageEl.addEventListener("click", (event) => {
      void postTouchDebug("stage-click", event, { suppressNextStageClick, suppressStageClickUntil });
      if (isDrawModeActive) {
        return;
      }
      if (isTrayOpen || trayEl.contains(event.target)) {
        return;
      }
      if (suppressNextStageClick || Date.now() < suppressStageClickUntil) {
        suppressNextStageClick = false;
        return;
      }
      handleStageTrayToggle();
    });

    trayActivatorEl.addEventListener("pointerdown", startTrayLongPress);
    trayActivatorEl.addEventListener("pointerup", clearTrayLongPress);
    trayActivatorEl.addEventListener("pointercancel", clearTrayLongPress);
    trayActivatorEl.addEventListener("pointerleave", clearTrayLongPress);

    stageEl.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch") {
        return;
      }
      if (isDrawModeActive || !drawingEnabled || drawingLayerEl === event.target) {
        return;
      }
      beginDrawModeActivation(event);
    });

    document.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") {
        return;
      }
      updateDrawActivation(event);
      if (!isDrawModeActive || activeDrawPointerId === null || event.pointerId !== activeDrawPointerId) {
        return;
      }
      event.preventDefault();
      extendLocalStroke(event.clientX, event.clientY);
    }, { capture: true });

    document.addEventListener("pointerup", (event) => {
      if (event.pointerType === "touch") {
        return;
      }
      if (pendingDrawActivation && event.pointerId === pendingDrawActivation.pointerId) {
        cancelPendingDrawActivation();
      }
      if (!isDrawModeActive || activeDrawPointerId === null || event.pointerId !== activeDrawPointerId) {
        return;
      }
      event.preventDefault();
      void finishLocalStroke(true);
    }, { capture: true });

    document.addEventListener("pointercancel", (event) => {
      if (event.pointerType === "touch") {
        return;
      }
      if (pendingDrawActivation && event.pointerId === pendingDrawActivation.pointerId) {
        cancelPendingDrawActivation();
      }
      if (!isDrawModeActive || activeDrawPointerId === null || event.pointerId !== activeDrawPointerId) {
        return;
      }
      void finishLocalStroke(true);
    }, { capture: true });

    if (drawingLayerEl) {
      drawingLayerEl.addEventListener("contextmenu", (event) => {
        event.preventDefault();
      });
      drawingLayerEl.addEventListener("pointerdown", (event) => {
        if (!isDrawModeActive) {
          return;
        }
        if (event.pointerType === "touch") {
          return;
        }
        if (event.button !== undefined && event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        suppressStageToggleOnce();
        startLocalStrokeFromClientPoint(event.clientX, event.clientY, event.pointerId);
      });
      drawingLayerEl.addEventListener("touchstart", (event) => {
        if (!isDrawModeActive) {
          return;
        }
        const touch = event.changedTouches[0];
        if (!touch) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        suppressStageToggleOnce();
        startLocalStrokeFromClientPoint(touch.clientX, touch.clientY, `touch-${touch.identifier}`);
      }, { passive: false });
      drawingLayerEl.addEventListener("touchmove", (event) => {
        if (!isDrawModeActive || activeDrawInputType !== "touch") {
          return;
        }
        const touch = event.changedTouches[0];
        if (!touch || activeDrawPointerId !== `touch-${touch.identifier}`) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        extendLocalStroke(touch.clientX, touch.clientY);
      }, { passive: false });
      drawingLayerEl.addEventListener("touchend", (event) => {
        if (!isDrawModeActive || activeDrawInputType !== "touch") {
          return;
        }
        const touch = event.changedTouches[0];
        if (!touch || activeDrawPointerId !== `touch-${touch.identifier}`) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void finishLocalStroke(true);
      }, { passive: false });
      drawingLayerEl.addEventListener("touchcancel", (event) => {
        if (!isDrawModeActive || activeDrawInputType !== "touch") {
          return;
        }
        const touch = event.changedTouches[0];
        if (!touch || activeDrawPointerId !== `touch-${touch.identifier}`) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void finishLocalStroke(true);
      }, { passive: false });
    }

    window.addEventListener("resize", () => {
      scheduleDrawingRender();
    });

    stageEl.addEventListener("touchstart", (event) => {
      void postTouchDebug("stage-touchstart", event, { suppressNextStageClick, suppressStageClickUntil });
      if (isDrawModeActive) {
        return;
      }
      if (isTrayOpen || trayEl.contains(event.target)) {
        return;
      }
      const touch = event.changedTouches[0];
      if (drawingEnabled && touch) {
        beginTouchDrawActivation(touch);
      }
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
    }, { passive: true });

    stageEl.addEventListener("touchmove", (event) => {
      const touch = event.changedTouches[0];
      if (touch) {
        updateTouchDrawActivation(touch);
      }

      if (!isDrawModeActive || activeDrawInputType !== "touch" || activeDrawPointerId === null || !touch) {
        return;
      }

      if (activeDrawPointerId !== `touch-${touch.identifier}`) {
        return;
      }

      extendLocalStroke(touch.clientX, touch.clientY);
    }, { passive: true });

    stageEl.addEventListener("touchend", (event) => {
      void postTouchDebug("stage-touchend", event, { suppressNextStageClick, suppressStageClickUntil });
      const touch = event.changedTouches[0];
      if (touch && pendingDrawActivation && pendingDrawActivation.pointerId === `touch-${touch.identifier}`) {
        cancelPendingDrawActivation();
      }
      if (isDrawModeActive && activeDrawInputType === "touch" && activeDrawPointerId === `touch-${touch.identifier}`) {
        void finishLocalStroke(true);
        return;
      }
      if (isDrawModeActive) {
        return;
      }
      if (isTrayOpen || trayEl.contains(event.target)) {
        return;
      }
      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;

      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) {
        suppressNextStageClick = true;
        handleStageTrayToggle();
        return;
      }

      suppressNextStageClick = true;

      if (dx < 0) {
        goToRelative(1);
      } else {
        goToRelative(-1);
      }
    }, { passive: true });

    stageEl.addEventListener("touchcancel", (event) => {
      const touch = event.changedTouches[0];
      if (touch && pendingDrawActivation && pendingDrawActivation.pointerId === `touch-${touch.identifier}`) {
        cancelPendingDrawActivation();
      }
      if (isDrawModeActive && activeDrawInputType === "touch" && activeDrawPointerId === `touch-${touch.identifier}`) {
        void finishLocalStroke(true);
      }
    }, { passive: true });
  }

  function cacheDom() {
    imgA = document.getElementById("imgA");
    imgB = document.getElementById("imgB");
    drawingLayerEl = document.getElementById("drawing-layer");
    drawingLayerContext = drawingLayerEl ? drawingLayerEl.getContext("2d") : null;
    drawingToolbarEl = document.getElementById("drawing-toolbar");
    drawingPaletteEl = document.getElementById("drawing-palette");
    drawingDoneButtonEl = document.getElementById("drawing-done");
    drawingUndoButtonEl = document.getElementById("drawing-undo");
    drawingClearButtonEl = document.getElementById("drawing-clear");
    captionEl = document.getElementById("caption");
    slidePositionEl = document.getElementById("slide-position");
    slideDurationInput = document.getElementById("slide-duration");
    slideShuffleButtonEl = document.getElementById("shuffle");
    stageEl = document.getElementById("stage");
    trayEl = document.getElementById("operator-tray");
    trayContextEl = document.getElementById("tray-context");
    trayCloseButton = document.getElementById("tray-close");
    trayToggleButton = document.getElementById("tray-toggle");
    trayActivatorEl = document.getElementById("tray-activator");
    syncButtonEl = document.getElementById("sync-drive");
    syncStatusEl = document.getElementById("sync-status");
    reloadButtonEl = document.getElementById("reload-browser");
    frameTimeDisplayEl = document.getElementById("frame-time-display");
    frameTimeZoneSelectEl = document.getElementById("frame-timezone");
    frameTimeZoneNoteEl = document.getElementById("frame-timezone-note");
    touchDebugOverlayEl = document.getElementById("touch-debug-overlay");
    trayPanelButtons = Array.from(document.querySelectorAll("[data-tray-panel-target]"));
    trayPanels = Array.from(document.querySelectorAll("[data-tray-panel]"));
    setActiveTrayPanel(activeTrayPanel);
    buildDrawingPaletteButtons();
    renderFrameTimeUi();
    renderDrawingUi();
    scheduleDrawingRender();
    updateTouchDebugOverlay();
  }

  async function init(syncContext) {
    ctx = syncContext;
    updateTrayContext();
    installFastTapBridge();

    try {
      await fetchAlbum();
    } catch (error) {
      console.error("[album] Failed to load album:", error);
      images = [];
      localFingerprint = "";
    }

    localAlbumStore = ctx.createStore("album_local", { scope: "local" });
    sharedAlbumStore = ctx.createStore("album", {
      scope: ctx.syncSlidesEnabled ? "shared" : "local"
    });
    libraryStore = ctx.createStore("library", {
      scope: ctx.syncSlidesEnabled ? "shared" : "local"
    });
    drawingStore = ctx.createStore("drawing", {
      scope: ctx.syncEnabled && ctx.syncSlidesEnabled ? "shared" : "local"
    });

    const initialLocalState = await localAlbumStore.get();
    if (!initialLocalState) {
      await localAlbumStore.set(buildDefaultState());
    }

    const initialDrawingState = await drawingStore.get();
    if (!initialDrawingState) {
      await drawingStore.set(buildDefaultDrawingState());
    }

    drawingStore.subscribe((nextState) => {
      applyIncomingDrawingState(nextState);
    });

    localAlbumStore.subscribe((nextState) => {
      handleLocalAlbumState(nextState).catch((error) => {
        console.error("[album] failed to apply local state:", error);
      });
    });

    if (ctx.syncEnabled && ctx.syncSlidesEnabled) {
      const initialSharedState = await sharedAlbumStore.get();
      if (!initialSharedState) {
        await sharedAlbumStore.set(buildDefaultState());
      }

      sharedAlbumStore.subscribe((nextState) => {
        handleSharedAlbumState(nextState).catch((error) => {
          console.error("[album] failed to apply shared state:", error);
        });
      });

      await ensureRoomLibrarySeeded();
      libraryStore.subscribe((nextState) => {
        handleLibraryState(nextState).catch((error) => {
          console.error("[album] failed to apply library metadata:", error);
        });
      });
    } else {
      roomLibraryFingerprint = localFingerprint;
      inSyncWithRoom = true;
      cacheRoomMetaStatus();
    }

    await fetchSyncStatus();
    wireControls();
    startFrameClock();
    startRenderLoop();
    render(true);
  }

  window.addEventListener("load", () => {
    cacheDom();
    if (!window.SannySync) {
      console.error("[album] Sync layer not found");
      return;
    }
    window.SannySync.onReady(init);
  });
})();
