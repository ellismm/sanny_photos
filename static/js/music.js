// static/js/music.js
(function () {
  document.documentElement.dataset.sannyMusicScript = "loaded";
  const config = window.SANNY_CONFIG || {};
  const defaultPlaylistUrl = (config.defaultPlaylistUrl || "").trim();
  const leaderHeartbeatMs = 25000;
  const leaderStaleAfterMs = 90000;
  const leadershipMonitorMs = 10000;
  const reconcilePollMs = 3000;
  const driftThresholdSeconds = 2;
  const immediateSeekThresholdSeconds = 0.5;
  const trackEndThresholdSeconds = 0.75;
  const transitionSettleMs = 8000;
  const advanceLockMs = 8000;
  const alarmPollMs = 15000;
  const alarmMaxDurationMs = Math.max(
    60000,
    Math.round(Number(config.alarmMaxDurationSeconds || 300) * 1000)
  );
  const alarmMinVolume = Math.max(
    0,
    Math.min(100, Math.round(Number(config.alarmMinVolume || 45)))
  );
  const alarmDayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const frameTimeZoneOptions = [
    { value: "America/Los_Angeles", shortLabel: "PT", longLabel: "Pacific Time" },
    { value: "America/Denver", shortLabel: "MT", longLabel: "Mountain Time" },
    { value: "America/Chicago", shortLabel: "CT", longLabel: "Central Time" },
    { value: "America/New_York", shortLabel: "ET", longLabel: "Eastern Time" }
  ];
  const frameTimeZoneValues = new Set(frameTimeZoneOptions.map((option) => option.value));
  const frameTimeZoneStorageKey = "sanny.frameTimeZone";
  const defaultFrameTimeZone = "America/Chicago";

  let ctx = null;
  let musicStore = null;
  let musicState = null;
  let localStatus = normalizePlayerStatus(null);
  let heartbeatTimer = null;
  let leadershipMonitorTimer = null;
  let reconcileTimer = null;
  let reconcileQueue = Promise.resolve();
  let localPlaylistUrl = "";
  let localPlaylistSignature = "";
  let localPlaylistItems = [];
  let playlistItemsVersion = 0;
  let playlistRenderSignature = "";
  let localAlarmStore = null;
  let sharedAlarmStore = null;
  let localAlarmsState = null;
  let sharedAlarmsState = null;
  let alarmTimer = null;
  let frameClockTimer = null;
  let alarmQueue = Promise.resolve();
  let alarmEvaluationTimeout = null;
  let alarmMessage = { text: "", kind: "" };
  let alarmActiveKeys = new Set();
  let bootstrapped = false;
  let playlistPointerSession = null;
  let playlistSuppressClickUntil = 0;
  let alarmSession = {
    engaged: false,
    restoreVolume: null,
    volumeRaised: false,
    playbackStartedAt: null,
    resumeOffsetMs: null
  };
  let currentFrameTimeZone = resolveInitialFrameTimeZone();
  const formatterCache = new Map();
  let alarmFormState = buildDefaultAlarmFormState();

  const elements = {};

  function now() {
    return ctx && typeof ctx.serverNow === "function" ? ctx.serverNow() : Date.now();
  }

  function isSharedMusicMode() {
    return Boolean(ctx && ctx.syncEnabled && ctx.syncMusicEnabled);
  }

  function setMusicLabel(text, isError) {
    elements.title.textContent = text;
    elements.title.classList.toggle("status-danger", Boolean(isError));
  }

  async function fetchJSON(url, options) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        ...(options || {}),
        signal: controller.signal
      });
      return response.json();
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error(`Request timed out while loading ${url}`);
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function postJSON(url, body) {
    return fetchJSON(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  async function getJSON(url) {
    return fetchJSON(url, { cache: "no-store" });
  }

  function identityOrder(length) {
    return Array.from({ length }, (_, index) => index);
  }

  function normalizeOrder(order, length) {
    if (!length) {
      return [];
    }

    if (!Array.isArray(order) || order.length !== length) {
      return [];
    }

    const unique = new Set(order);
    if (unique.size !== length) {
      return [];
    }

    const valid = order.every((value) => Number.isInteger(value) && value >= 0 && value < length);
    return valid ? order.slice() : [];
  }

  function shuffleOrderKeepingCurrent(length, currentTrackIndex) {
    const rest = identityOrder(length).filter((index) => index !== currentTrackIndex);
    for (let index = rest.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      const temp = rest[index];
      rest[index] = rest[swapIndex];
      rest[swapIndex] = temp;
    }
    return [currentTrackIndex].concat(rest);
  }

  function ordersEqual(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => value === right[index]);
  }

  function buildFreshShuffleCycleOrder(length, avoidFirstIndex, previousOrder) {
    if (length <= 1) {
      return identityOrder(length);
    }

    const sourceOrder = identityOrder(length);
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

  function normalizePlayerStatus(rawStatus) {
    const base = rawStatus && typeof rawStatus === "object" ? rawStatus : {};
    return {
      ok: base.ok !== false,
      running: Boolean(base.running),
      paused: Boolean(base.paused),
      muted: Boolean(base.muted),
      index: Number.isFinite(Number(base.index)) ? Number(base.index) : -1,
      track: base.track || null,
      ended: Boolean(base.ended),
      loading: Boolean(base.loading),
      positionSeconds: Number.isFinite(Number(base.positionSeconds))
        ? Number(base.positionSeconds)
        : null,
      durationSeconds: Number.isFinite(Number(base.durationSeconds))
        ? Number(base.durationSeconds)
        : null,
      volume: Number.isFinite(Number(base.volume))
        ? Math.max(0, Math.min(100, Math.round(Number(base.volume))))
        : 80,
      lastError: (base.lastError || "").trim()
    };
  }

  function normalizePlaylistItems(rawItems) {
    if (!Array.isArray(rawItems)) {
      return [];
    }

    return rawItems
      .map((item, index) => {
        const base = item && typeof item === "object" ? item : {};
        const url = (base.url || "").trim();
        return {
          index,
          key: deriveTrackKey(base.key, url, index),
          title: (base.title || `Track ${index + 1}`).trim(),
          url
        };
      })
      .filter((item) => Boolean(item.title) && Boolean(item.url));
  }

  function deriveTrackKey(rawKey, rawUrl, index) {
    const directKey = String(rawKey || "").trim();
    if (directKey) {
      return directKey;
    }

    const url = String(rawUrl || "").trim();
    if (!url) {
      return `track-${index + 1}`;
    }

    try {
      const parsed = new URL(url, window.location.origin);
      const host = (parsed.hostname || "").toLowerCase();
      if (host.includes("youtu.be")) {
        const pathKey = parsed.pathname.replace(/^\/+/, "").trim();
        return pathKey || url;
      }

      if (host.includes("youtube.com") || host.includes("music.youtube.com")) {
        const watchKey = (parsed.searchParams.get("v") || "").trim();
        if (watchKey) {
          return watchKey;
        }
        const pathSegments = parsed.pathname.split("/").filter(Boolean);
        return pathSegments[pathSegments.length - 1] || url;
      }

      return parsed.toString();
    } catch (error) {
      return url;
    }
  }

  function computePlaylistSignature(items) {
    const normalized = normalizePlaylistItems(items);
    if (!normalized.length) {
      return "";
    }
    return normalized.map((item) => item.key).join("|");
  }

  function setLocalPlaylistItems(rawItems) {
    localPlaylistItems = normalizePlaylistItems(rawItems);
    localPlaylistSignature = computePlaylistSignature(localPlaylistItems);
    playlistItemsVersion += 1;
    playlistRenderSignature = "";
  }

  function clearLocalPlaylistItems() {
    localPlaylistItems = [];
    localPlaylistSignature = "";
    playlistItemsVersion += 1;
    playlistRenderSignature = "";
  }

  function normalizeFrameTimeZone(value) {
    const normalized = String(value || "").trim();
    return frameTimeZoneValues.has(normalized) ? normalized : "";
  }

  function detectBrowserTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (error) {
      return "";
    }
  }

  function resolveInitialFrameTimeZone() {
    try {
      const stored = normalizeFrameTimeZone(window.localStorage.getItem(frameTimeZoneStorageKey));
      if (stored) {
        return stored;
      }
    } catch (error) {
      // Ignore localStorage read failures and fall back to browser/default time zone.
    }

    return normalizeFrameTimeZone(detectBrowserTimeZone()) || defaultFrameTimeZone;
  }

  function setCurrentFrameTimeZone(nextTimeZone) {
    currentFrameTimeZone = normalizeFrameTimeZone(nextTimeZone) || defaultFrameTimeZone;
    try {
      window.localStorage.setItem(frameTimeZoneStorageKey, currentFrameTimeZone);
    } catch (error) {
      // Ignore localStorage write failures; the in-memory override still works for this session.
    }
    return currentFrameTimeZone;
  }

  function getCurrentFrameTimeZoneOption() {
    return frameTimeZoneOptions.find((option) => option.value === getCurrentTimeZone()) || frameTimeZoneOptions[2];
  }

  function getCurrentTimeZone() {
    return currentFrameTimeZone || defaultFrameTimeZone;
  }

  function alarmNowForScope(scope) {
    return scope === "shared" ? now() : Date.now();
  }

  function normalizeDaysOfWeek(days) {
    const source = Array.isArray(days) ? days : [];
    const unique = new Set();

    source.forEach((value) => {
      const day = Number(value);
      if (Number.isInteger(day) && day >= 0 && day <= 6) {
        unique.add(day);
      }
    });

    return Array.from(unique).sort((left, right) => left - right);
  }

  function clampTimeMinutes(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return 7 * 60;
    }
    return Math.max(0, Math.min(1439, Math.round(numeric)));
  }

  function minutesToTimeValue(timeMinutes) {
    const clamped = clampTimeMinutes(timeMinutes);
    const hour = Math.floor(clamped / 60);
    const minute = clamped % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function timeValueToMinutes(rawValue) {
    const value = String(rawValue || "").trim();
    const match = value.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      return null;
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }

    return hour * 60 + minute;
  }

  function createAlarmId() {
    return `alarm_${Math.random().toString(36).slice(2, 10)}`;
  }

  function buildDefaultAlarmFormState() {
    const current = getZonedParts(Date.now(), getCurrentTimeZone());
    const roundedMinutes = clampTimeMinutes((current.hour * 60 + current.minute + 4));
    const currentWeekday = Number.isInteger(current.weekday) && current.weekday >= 0
      ? current.weekday
      : new Date().getDay();
    return {
      id: "",
      sourceScope: "local",
      timeMinutes: roundedMinutes,
      daysOfWeek: [currentWeekday],
      shared: false,
      enabled: true,
      oneTime: false
    };
  }

  function getFormatter(timeZone, includeWeekday) {
    const key = `${timeZone}|${includeWeekday ? "weekday" : "plain"}`;
    if (!formatterCache.has(key)) {
      formatterCache.set(
        key,
        new Intl.DateTimeFormat("en-US", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          weekday: includeWeekday ? "short" : undefined
        })
      );
    }
    return formatterCache.get(key);
  }

  function getZonedParts(timestamp, timeZone) {
    const parts = getFormatter(timeZone, true).formatToParts(new Date(timestamp));
    const mapped = {
      year: 1970,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      weekday: "Sun"
    };

    parts.forEach((part) => {
      if (part.type === "year" || part.type === "month" || part.type === "day" || part.type === "hour" || part.type === "minute") {
        mapped[part.type] = Number(part.value);
      } else if (part.type === "weekday") {
        mapped.weekday = part.value;
      }
    });

    return {
      year: mapped.year,
      month: mapped.month,
      day: mapped.day,
      hour: mapped.hour,
      minute: mapped.minute,
      weekday: alarmDayLabels.indexOf(mapped.weekday)
    };
  }

  function calendarDatePlusDays(year, month, day, offsetDays) {
    const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      weekday: date.getUTCDay()
    };
  }

  function zonedDateTimeToUtc(year, month, day, hour, minute, timeZone) {
    let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = getZonedParts(guess, timeZone);
      const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
      const currentAsUtc = Date.UTC(
        current.year,
        current.month - 1,
        current.day,
        current.hour,
        current.minute,
        0,
        0
      );
      const difference = desiredAsUtc - currentAsUtc;
      if (difference === 0) {
        return guess;
      }
      guess += difference;
    }

    return guess;
  }

  function computeNextTriggerAt(timeMinutes, daysOfWeek, timeZone, fromTimestamp) {
    const normalizedDays = normalizeDaysOfWeek(daysOfWeek);
    if (!normalizedDays.length) {
      return 0;
    }

    const zone = (timeZone || getCurrentTimeZone()).trim() || "UTC";
    const current = getZonedParts(fromTimestamp, zone);
    const hour = Math.floor(clampTimeMinutes(timeMinutes) / 60);
    const minute = clampTimeMinutes(timeMinutes) % 60;

    for (let offset = 0; offset < 14; offset += 1) {
      const candidateDate = calendarDatePlusDays(current.year, current.month, current.day, offset);
      if (!normalizedDays.includes(candidateDate.weekday)) {
        continue;
      }

      const candidateTimestamp = zonedDateTimeToUtc(
        candidateDate.year,
        candidateDate.month,
        candidateDate.day,
        hour,
        minute,
        zone
      );

      if (candidateTimestamp > fromTimestamp + 999) {
        return candidateTimestamp;
      }
    }

    const fallbackDate = calendarDatePlusDays(current.year, current.month, current.day, 7);
    return zonedDateTimeToUtc(
      fallbackDate.year,
      fallbackDate.month,
      fallbackDate.day,
      hour,
      minute,
      zone
    );
  }

  function normalizeAlarm(rawAlarm, scope) {
    const base = rawAlarm && typeof rawAlarm === "object" ? rawAlarm : {};
    const shared = scope === "shared";
    const referenceNow = alarmNowForScope(scope);
    const timeMinutes = clampTimeMinutes(base.timeMinutes);
    const daysOfWeek = normalizeDaysOfWeek(base.daysOfWeek);
    const timeZone = (base.timeZone || getCurrentTimeZone()).trim() || "UTC";
    const enabled = base.enabled !== false;
    const nextTriggerAt = Number.isFinite(Number(base.nextTriggerAt))
      ? Number(base.nextTriggerAt)
      : computeNextTriggerAt(timeMinutes, daysOfWeek, timeZone, referenceNow);

    return {
      id: (base.id || createAlarmId()).trim(),
      timeMinutes,
      daysOfWeek: daysOfWeek.length ? daysOfWeek : [0, 1, 2, 3, 4, 5, 6],
      enabled,
      oneTime: Boolean(base.oneTime),
      shared,
      timeZone,
      nextTriggerAt,
      lastTriggeredAt: Number.isFinite(Number(base.lastTriggeredAt)) ? Number(base.lastTriggeredAt) : 0,
      activeUntilAt: Number.isFinite(Number(base.activeUntilAt)) ? Number(base.activeUntilAt) : 0,
      createdByDeviceId: (base.createdByDeviceId || (ctx && ctx.deviceId) || "local-device").trim(),
      updatedByDeviceId: (base.updatedByDeviceId || (ctx && ctx.deviceId) || "local-device").trim(),
      updatedAt: Number.isFinite(Number(base.updatedAt)) ? Number(base.updatedAt) : referenceNow
    };
  }

  function normalizeAlarmContainer(rawValue, scope) {
    const base = rawValue && typeof rawValue === "object" ? rawValue : {};
    const rawAlarms = Array.isArray(base.alarms)
      ? base.alarms
      : Array.isArray(rawValue)
        ? rawValue
        : [];
    const alarms = rawAlarms
      .map((alarm) => normalizeAlarm(alarm, scope))
      .sort((left, right) => {
        const leftActive = isAlarmActive(left, alarmNowForScope(scope));
        const rightActive = isAlarmActive(right, alarmNowForScope(scope));
        if (leftActive !== rightActive) {
          return leftActive ? -1 : 1;
        }
        if (left.enabled !== right.enabled) {
          return left.enabled ? -1 : 1;
        }
        if (left.nextTriggerAt !== right.nextTriggerAt) {
          return left.nextTriggerAt - right.nextTriggerAt;
        }
        return left.timeMinutes - right.timeMinutes;
      });

    return {
      alarms,
      updatedAt: Number.isFinite(Number(base.updatedAt)) ? Number(base.updatedAt) : alarmNowForScope(scope)
    };
  }

  function areSharedAlarmsAvailable() {
    return Boolean(sharedAlarmStore && isSharedMusicMode());
  }

  function setAlarmStatusMessage(text, kind) {
    alarmMessage = {
      text: (text || "").trim(),
      kind: (kind || "").trim()
    };
  }

  function isAlarmActive(alarm, referenceNow) {
    return Boolean(alarm && Number(alarm.activeUntilAt) > referenceNow);
  }

  function getCombinedAlarms() {
    const local = localAlarmsState && Array.isArray(localAlarmsState.alarms)
      ? localAlarmsState.alarms.map((alarm) => ({ ...alarm, scope: "local" }))
      : [];
    const shared = sharedAlarmsState && Array.isArray(sharedAlarmsState.alarms)
      ? sharedAlarmsState.alarms.map((alarm) => ({ ...alarm, scope: "shared" }))
      : [];

    return local.concat(shared).sort((left, right) => {
      const leftActive = isAlarmActive(left, alarmNowForScope(left.scope));
      const rightActive = isAlarmActive(right, alarmNowForScope(right.scope));
      if (leftActive !== rightActive) {
        return leftActive ? -1 : 1;
      }
      if (left.enabled !== right.enabled) {
        return left.enabled ? -1 : 1;
      }
      if (left.nextTriggerAt !== right.nextTriggerAt) {
        return left.nextTriggerAt - right.nextTriggerAt;
      }
      return left.timeMinutes - right.timeMinutes;
    });
  }

  function getActiveAlarms() {
    return getCombinedAlarms().filter((alarm) => isAlarmActive(alarm, alarmNowForScope(alarm.scope)));
  }

  function hasActiveLocalAlarms() {
    return getActiveAlarms().some((alarm) => !alarm.shared);
  }

  function hasActiveSharedAlarms() {
    return getActiveAlarms().some((alarm) => alarm.shared);
  }

  function activeAlarmKeyFor(alarm) {
    return `${alarm.scope}:${alarm.id}:${alarm.lastTriggeredAt || alarm.activeUntilAt}`;
  }

  function formatTimeMinutes(timeMinutes, timeZone) {
    const baseTimestamp = zonedDateTimeToUtc(2025, 1, 5, Math.floor(timeMinutes / 60), timeMinutes % 60, timeZone || getCurrentTimeZone());
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timeZone || getCurrentTimeZone(),
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(baseTimestamp));
  }

  function formatDaysSummary(daysOfWeek) {
    const days = normalizeDaysOfWeek(daysOfWeek);
    if (days.length === 7) {
      return "Every day";
    }
    if (days.join(",") === "1,2,3,4,5") {
      return "Weekdays";
    }
    if (days.join(",") === "0,6") {
      return "Weekends";
    }
    return days.map((day) => alarmDayLabels[day]).join(", ");
  }

  function formatAlarmDateTime(timestamp) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: getCurrentTimeZone(),
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(timestamp));
  }

  function formatAlarmDateTimeInZone(timestamp, timeZone) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(timestamp));
  }

  function formatFrameClock(timestamp) {
    const option = getCurrentFrameTimeZoneOption();
    const label = option ? option.shortLabel : getCurrentTimeZone();
    const formatted = new Intl.DateTimeFormat(undefined, {
      timeZone: getCurrentTimeZone(),
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(timestamp));
    return `${formatted} ${label}`;
  }

  function getNextEnabledAlarm() {
    return getCombinedAlarms().find((alarm) => alarm.enabled);
  }

  function getEffectivePlaybackState(baseState) {
    const state = normalizeState(baseState || {});
    if (!hasActiveLocalAlarms()) {
      return state;
    }

    const alarmBase = state.playlistUrl ? state : buildDefaultState();
    if (!alarmBase.playlistUrl) {
      return state;
    }

    const currentOffsetMs = Math.round(expectedPositionSeconds(state) * 1000);
    const anchoredOffsetMs = Number.isFinite(Number(alarmSession.resumeOffsetMs))
      ? Math.max(0, Number(alarmSession.resumeOffsetMs))
      : currentOffsetMs;
    const anchoredStartedAt = Number.isFinite(Number(alarmSession.playbackStartedAt))
      ? Number(alarmSession.playbackStartedAt)
      : now() - anchoredOffsetMs;
    return normalizeState({
      ...alarmBase,
      isPlaying: true,
      trackStartedAt: anchoredStartedAt,
      pausedTrackOffsetMs: anchoredOffsetMs
    });
  }

  function normalizeState(rawState) {
    const base = rawState && typeof rawState === "object" ? rawState : {};
    const playlistUrl = (base.playlistUrl || "").trim();
    const playlistItems = normalizePlaylistItems(base.playlistItems || []);
    const playlistLength = Math.max(playlistItems.length, Math.max(0, Number(base.playlistLength) || 0));
    let order = normalizeOrder(base.order, playlistLength);

    if (!order.length && playlistLength) {
      order = identityOrder(playlistLength);
    }

    const shuffleEnabled = Boolean(base.shuffleEnabled) && playlistLength > 1;
    const currentOrderIndex = playlistLength
      ? ((Number(base.currentOrderIndex ?? base.currentIndex) || 0) % playlistLength + playlistLength) % playlistLength
      : 0;
    const currentTrackIndex = playlistLength
      ? Math.max(
          0,
          Math.min(
            playlistLength - 1,
            order[currentOrderIndex] ?? Math.max(0, Number(base.currentTrackIndex) || 0)
          )
        )
      : 0;
    const pausedTrackOffsetMs = Math.max(
      0,
      Number(base.pausedTrackOffsetMs) || 0
    );
    const defaultStartedAt = now() - pausedTrackOffsetMs;
    const trackStartedAt = Number.isFinite(Number(base.trackStartedAt))
      ? Number(base.trackStartedAt)
      : defaultStartedAt;
    const currentTrackKey = playlistItems[currentTrackIndex]
      ? playlistItems[currentTrackIndex].key
      : (base.currentTrackKey || "").trim();
    const playlistSignature = (base.playlistSignature || "").trim() || computePlaylistSignature(playlistItems);
    const revision = Math.max(0, Number(base.revision) || 0);
    const lastAdvanceAt = Number.isFinite(Number(base.lastAdvanceAt)) ? Number(base.lastAdvanceAt) : 0;
    const advanceLockUntil = Number.isFinite(Number(base.advanceLockUntil)) ? Number(base.advanceLockUntil) : 0;
    const advanceToken = Math.max(0, Number(base.advanceToken) || 0);

    if (!playlistUrl) {
      return {
        playlistUrl: "",
        playlistLength: 0,
        playlistItems: [],
        playlistSignature: "",
        order: [],
        shuffleEnabled: false,
        currentOrderIndex: 0,
        currentTrackIndex: 0,
        currentTrackKey: "",
        isPlaying: false,
        trackStartedAt: now(),
        pausedTrackOffsetMs: 0,
        trackTitle: "",
        actor: base.actor || null,
        updatedAt: Number.isFinite(Number(base.updatedAt)) ? Number(base.updatedAt) : now(),
        revision,
        leaderDeviceId: (base.leaderDeviceId || "").trim(),
        leaderHeartbeatAt: Number.isFinite(Number(base.leaderHeartbeatAt))
          ? Number(base.leaderHeartbeatAt)
          : 0,
        lastAdvanceAt,
        advanceLockUntil,
        advanceToken
      };
    }

    return {
      playlistUrl,
      playlistLength,
      playlistItems,
      playlistSignature,
      order,
      shuffleEnabled,
      currentOrderIndex,
      currentTrackIndex,
      currentTrackKey,
      isPlaying: base.isPlaying !== false,
      trackStartedAt,
      pausedTrackOffsetMs,
      trackTitle: (base.trackTitle || "").trim(),
      actor: base.actor || null,
      updatedAt: Number.isFinite(Number(base.updatedAt)) ? Number(base.updatedAt) : now(),
      revision,
      leaderDeviceId: (base.leaderDeviceId || "").trim(),
      leaderHeartbeatAt: Number.isFinite(Number(base.leaderHeartbeatAt))
        ? Number(base.leaderHeartbeatAt)
        : 0,
      lastAdvanceAt,
      advanceLockUntil,
      advanceToken
    };
  }

  function buildDefaultState() {
    return normalizeState({
      playlistUrl: defaultPlaylistUrl,
      playlistLength: 0,
      playlistItems: [],
      playlistSignature: "",
      order: [],
      shuffleEnabled: false,
      currentOrderIndex: 0,
      currentTrackIndex: 0,
      currentTrackKey: "",
      isPlaying: Boolean(defaultPlaylistUrl),
      trackStartedAt: now(),
      pausedTrackOffsetMs: 0,
      trackTitle: "",
      revision: 0,
      leaderDeviceId: ctx && isSharedMusicMode() ? ctx.deviceId : "",
      leaderHeartbeatAt: now(),
      lastAdvanceAt: 0,
      advanceLockUntil: 0,
      advanceToken: 0
    });
  }

  function withDefaultPlaylist(state) {
    if (!defaultPlaylistUrl || state.playlistUrl) {
      return state;
    }

    return normalizeState({
      ...state,
      playlistUrl: defaultPlaylistUrl,
      playlistLength: 0,
      playlistItems: [],
      playlistSignature: "",
      order: [],
      shuffleEnabled: false,
      currentOrderIndex: 0,
      currentTrackIndex: 0,
      currentTrackKey: "",
      isPlaying: true,
      trackStartedAt: now(),
      pausedTrackOffsetMs: 0,
      trackTitle: ""
    });
  }

  function withAutoplay(state) {
    if (!state.playlistUrl || state.isPlaying) {
      return state;
    }

    return normalizeState({
      ...state,
      isPlaying: true,
      trackStartedAt: now() - state.pausedTrackOffsetMs
    });
  }

  function currentTrackIndexFor(state) {
    if (!state || !state.playlistLength) {
      return 0;
    }
    return state.order[state.currentOrderIndex] ?? state.currentTrackIndex ?? state.currentOrderIndex;
  }

  function currentTrackKeyFor(state) {
    if (!state || !state.playlistUrl) {
      return "";
    }

    const trackIndex = currentTrackIndexFor(state);
    if (Array.isArray(state.playlistItems) && state.playlistItems[trackIndex]) {
      return state.playlistItems[trackIndex].key;
    }

    return (state.currentTrackKey || "").trim();
  }

  function currentLocalTrackKey(status) {
    const resolvedStatus = normalizePlayerStatus(status || localStatus);
    const statusTrack = resolvedStatus.track && typeof resolvedStatus.track === "object" ? resolvedStatus.track : null;
    const directKey = statusTrack && typeof statusTrack.key === "string" ? statusTrack.key.trim() : "";
    if (directKey) {
      return directKey;
    }

    if (Number.isInteger(resolvedStatus.index) && resolvedStatus.index >= 0 && localPlaylistItems[resolvedStatus.index]) {
      return localPlaylistItems[resolvedStatus.index].key;
    }

    if (statusTrack && statusTrack.url) {
      return deriveTrackKey("", statusTrack.url, resolvedStatus.index >= 0 ? resolvedStatus.index : 0);
    }

    return "";
  }

  function isWithinTransitionSettleWindow(state, referenceNow) {
    const anchor = Math.max(
      Number(state && state.lastAdvanceAt) || 0,
      Number(state && state.trackStartedAt) || 0
    );
    return anchor > 0 && ((typeof referenceNow === "number" ? referenceNow : now()) - anchor) < transitionSettleMs;
  }

  function queuePositionForTrack(state, trackIndex) {
    if (!state || !state.playlistLength || !Array.isArray(state.order)) {
      return -1;
    }
    return state.order.indexOf(trackIndex);
  }

  function expectedPositionSeconds(state, at) {
    if (!state || !state.playlistUrl) {
      return 0;
    }

    if (!state.isPlaying) {
      return Math.max(0, state.pausedTrackOffsetMs / 1000);
    }

    return Math.max(0, ((typeof at === "number" ? at : now()) - state.trackStartedAt) / 1000);
  }

  function isCoordinatorFor(state) {
    return !isSharedMusicMode() || state.leaderDeviceId === ctx.deviceId;
  }

  function isCoordinatorStale(state) {
    return !state.leaderHeartbeatAt || now() - state.leaderHeartbeatAt > leaderStaleAfterMs;
  }

  async function refreshLocalStatus() {
    localStatus = normalizePlayerStatus(
      await getJSON("/music/status").catch(() => ({
        ok: false,
        running: false
      }))
    );
    return localStatus;
  }

  function updateUi() {
    const state = normalizeState(musicState || {});
    const displayState = getEffectivePlaybackState(state);
    const volume = Number.isFinite(localStatus.volume) ? localStatus.volume : 80;

    if (document.activeElement !== elements.input) {
      elements.input.value = displayState.playlistUrl;
    }
    if (elements.volume && document.activeElement !== elements.volume) {
      elements.volume.value = String(volume);
    }
    if (elements.volumeValue) {
      elements.volumeValue.textContent = `${volume}%`;
    }

    elements.mute.textContent = localStatus.muted ? "Muted" : "Mute";
    elements.toggle.textContent = displayState.isPlaying ? "Pause" : "Play";
    elements.shuffle.textContent = state.shuffleEnabled ? "Shuffled" : "Shuffle";
    elements.shuffle.classList.toggle("is-active", state.shuffleEnabled);
    elements.shuffle.setAttribute("aria-pressed", state.shuffleEnabled ? "true" : "false");
    renderAlarmUi();
    renderConfigurationTimeUi();

    const hasPlaylist = Boolean(displayState.playlistUrl);
    const hasQueue = hasPlaylist && displayState.playlistLength > 0;
    elements.toggle.disabled = !hasPlaylist;
    elements.next.disabled = !hasQueue;
    elements.prev.disabled = !hasQueue;
    elements.shuffle.disabled = !hasQueue || displayState.playlistLength < 2;
    elements.mute.disabled = !hasPlaylist;

    if (!hasPlaylist) {
      elements.queue.textContent = "Queue 0 / 0";
      setMusicLabel("No music loaded.", false);
      renderPlaylist();
      return;
    }

    if (hasQueue) {
      const queueLabel = `Track ${displayState.currentOrderIndex + 1} / ${displayState.playlistLength}${
        displayState.shuffleEnabled ? " • Shuffle on" : ""
      }`;
      elements.queue.textContent = queueLabel;
    } else {
      elements.queue.textContent = displayState.shuffleEnabled
        ? "Loading shared queue • Shuffle on"
        : "Loading shared queue...";
    }

    const baseTitle =
      (localStatus.track && localStatus.track.title) ||
      displayState.trackTitle ||
      "Loading playlist...";
    const suffix = isSharedMusicMode()
      ? isCoordinatorFor(state)
        ? " (shared room)"
        : " (following room)"
      : "";
    setMusicLabel(baseTitle + suffix, false);
    renderPlaylist();
  }

  async function claimLeadership() {
    if (!musicStore || !isSharedMusicMode()) {
      return;
    }

    await musicStore.update({
      leaderDeviceId: ctx.deviceId,
      leaderHeartbeatAt: now(),
      actor: ctx.deviceId,
      updatedAt: now()
    });
  }

  function startHeartbeat() {
    if (!isSharedMusicMode() || heartbeatTimer) {
      return;
    }

    heartbeatTimer = window.setInterval(() => {
      if (!musicState || !isCoordinatorFor(musicState)) {
        return;
      }

      musicStore.update({
        leaderDeviceId: ctx.deviceId,
        leaderHeartbeatAt: now(),
        actor: ctx.deviceId,
        updatedAt: now()
      });
    }, leaderHeartbeatMs);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startLeadershipMonitor() {
    if (!isSharedMusicMode() || leadershipMonitorTimer) {
      return;
    }

    leadershipMonitorTimer = window.setInterval(() => {
      if (!musicState || isCoordinatorFor(musicState)) {
        return;
      }

      if (isCoordinatorStale(musicState)) {
        claimLeadership();
      }
    }, leadershipMonitorMs);
  }

  function startReconcileTimer() {
    if (reconcileTimer) {
      return;
    }

    reconcileTimer = window.setInterval(() => {
      queueReconcile();
    }, reconcilePollMs);
  }

  function stopLocalPlaybackState() {
    localPlaylistUrl = "";
    clearLocalPlaylistItems();
    localStatus = normalizePlayerStatus({
      ok: true,
      running: false,
      paused: false,
      muted: localStatus.muted,
      index: -1,
      track: null,
      ended: false,
      positionSeconds: null,
      durationSeconds: null,
      volume: localStatus.volume,
      lastError: ""
    });
  }

  async function stopLocalPlayback() {
    try {
      await postJSON("/music/stop", {});
    } catch (error) {
      console.warn("[music] could not stop local playback:", error);
    } finally {
      stopLocalPlaybackState();
    }
  }

  function renderPlaylist() {
    if (!elements.playlist) {
      return;
    }

    const state = normalizeState(musicState || {});
    const displayState = getEffectivePlaybackState(state);
    const currentTrackIndex = currentTrackIndexFor(displayState);
    const renderSignature = [
      playlistItemsVersion,
      displayState.playlistUrl,
      displayState.playlistLength,
      displayState.shuffleEnabled ? 1 : 0,
      displayState.currentOrderIndex,
      currentTrackIndex,
      displayState.isPlaying ? 1 : 0
    ].join("|");

    if (renderSignature === playlistRenderSignature) {
      return;
    }
    playlistRenderSignature = renderSignature;

    elements.playlist.replaceChildren();
    elements.playlist.classList.toggle("empty", false);

    if (!displayState.playlistUrl) {
      elements.playlist.classList.add("empty");
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = "Load a playlist to choose a song.";
      elements.playlist.appendChild(meta);
      return;
    }

    if (!localPlaylistItems.length) {
      elements.playlist.classList.add("empty");
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = displayState.playlistLength
        ? "Loading the track list..."
        : "Playlist metadata is loading...";
      elements.playlist.appendChild(meta);
      return;
    }

    const list = document.createElement("div");
    list.className = "music-playlist-list";

    localPlaylistItems.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "playlist-track-button";
      button.dataset.trackIndex = String(item.index);
      button.title = item.title;

      const isCurrentTrack = item.index === currentTrackIndex;
      if (isCurrentTrack) {
        button.classList.add("active");
      }

      const badge = document.createElement("span");
      badge.className = "playlist-track-badge";
      badge.textContent = `${item.index + 1}`;

      const titleLine = document.createElement("span");
      titleLine.className = "playlist-track-title";
      titleLine.textContent = item.title;
      const queuePosition = queuePositionForTrack(displayState, item.index);

      button.appendChild(badge);
      button.appendChild(titleLine);

      const chip = document.createElement("span");
      chip.className = "playlist-track-chip";
      if (isCurrentTrack) {
        chip.classList.add("current");
        chip.textContent = displayState.isPlaying ? "Now" : "Selected";
      } else if (displayState.shuffleEnabled && queuePosition >= 0) {
        chip.textContent = `Q${queuePosition + 1}`;
      } else {
        chip.textContent = "";
        chip.style.visibility = "hidden";
      }
      button.appendChild(chip);

      list.appendChild(button);
    });

    elements.playlist.appendChild(list);
  }

  function queueAlarmWork(task) {
    alarmQueue = alarmQueue
      .then(() => task())
      .catch((error) => {
        console.error("[alarm] task failed:", error);
        setAlarmStatusMessage(error.message || "Alarm update failed.", "danger");
        updateUi();
      });
    return alarmQueue;
  }

  function queueAlarmEvaluation() {
    return queueAlarmWork(() => evaluateAlarms());
  }

  function scheduleAlarmEvaluation(delayMs) {
    if (alarmEvaluationTimeout) {
      return;
    }

    alarmEvaluationTimeout = window.setTimeout(() => {
      alarmEvaluationTimeout = null;
      queueAlarmEvaluation();
    }, Math.max(0, Number(delayMs) || 0));
  }

  async function runAlarmEvaluationImmediately() {
    try {
      await evaluateAlarms();
    } catch (error) {
      console.error("[alarm] evaluation failed:", error);
      setAlarmStatusMessage(error.message || "Alarm update failed.", "danger");
      updateUi();
      throw error;
    }
  }

  function getAlarmStore(scope) {
    return scope === "shared" ? sharedAlarmStore : localAlarmStore;
  }

  function getAlarmContainer(scope) {
    return scope === "shared"
      ? (sharedAlarmsState || normalizeAlarmContainer(null, "shared"))
      : (localAlarmsState || normalizeAlarmContainer(null, "local"));
  }

  function setAlarmContainer(scope, container) {
    if (scope === "shared") {
      sharedAlarmsState = container;
      return;
    }
    localAlarmsState = container;
  }

  async function writeAlarmContainer(scope, mutator) {
    const store = getAlarmStore(scope);
    if (!store) {
      throw new Error(scope === "shared"
        ? "Shared alarms need connected room sync."
        : "Alarm storage is not available.");
    }

    let base = getAlarmContainer(scope);
    if (typeof store.get === "function") {
      const latestRemoteValue = await store.get().catch(() => null);
      if (latestRemoteValue) {
        base = normalizeAlarmContainer(latestRemoteValue, scope);
        setAlarmContainer(scope, base);
      }
    }

    const baseClone = {
      ...base,
      alarms: base.alarms.map((alarm) => ({ ...alarm }))
    };
    const nextValue = mutator(baseClone) || baseClone;
    const nextContainer = normalizeAlarmContainer({
      alarms: Array.isArray(nextValue.alarms) ? nextValue.alarms : [],
      updatedAt: alarmNowForScope(scope)
    }, scope);
    await store.set(nextContainer);
    setAlarmContainer(scope, nextContainer);
    return nextContainer;
  }

  function ensureAlarmDayButtons() {
    if (!elements.alarmDays) {
      return;
    }

    if (
      elements.alarmDays.dataset.ready === "1" ||
      elements.alarmDays.querySelector("[data-alarm-day]")
    ) {
      elements.alarmDays.dataset.ready = "1";
      return;
    }

    alarmDayLabels.forEach((label, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "alarm-day-button";
      button.dataset.alarmDay = String(index);
      button.textContent = label;
      elements.alarmDays.appendChild(button);
    });

    elements.alarmDays.dataset.ready = "1";
  }

  function resetAlarmForm() {
    alarmFormState = buildDefaultAlarmFormState();
    setAlarmStatusMessage("", "");
    updateUi();
  }

  function setAlarmFormFromAlarm(alarm) {
    alarmFormState = {
      id: alarm.id,
      sourceScope: alarm.scope,
      timeMinutes: alarm.timeMinutes,
      daysOfWeek: alarm.daysOfWeek.slice(),
      shared: alarm.shared,
      enabled: alarm.enabled,
      oneTime: Boolean(alarm.oneTime)
    };
    setAlarmStatusMessage("", "");
    updateUi();
  }

  function renderAlarmForm() {
    if (!elements.alarmTime) {
      return;
    }

    const sharedAvailable = areSharedAlarmsAvailable();
    if (!sharedAvailable && alarmFormState.shared) {
      alarmFormState.shared = false;
      alarmFormState.sourceScope = "local";
    }

    if (document.activeElement !== elements.alarmTime) {
      elements.alarmTime.value = minutesToTimeValue(alarmFormState.timeMinutes);
    }

    elements.alarmShared.disabled = !sharedAvailable;
    elements.alarmShared.classList.toggle("is-active", alarmFormState.shared && sharedAvailable);
    elements.alarmShared.setAttribute("aria-pressed", alarmFormState.shared ? "true" : "false");
    elements.alarmShared.textContent = alarmFormState.shared ? "Shared" : "Local Only";

    elements.alarmEnabled.classList.toggle("is-active", alarmFormState.enabled);
    elements.alarmEnabled.setAttribute("aria-pressed", alarmFormState.enabled ? "true" : "false");
    elements.alarmEnabled.textContent = alarmFormState.enabled ? "Enabled" : "Paused";

    elements.alarmOneTime.classList.toggle("is-active", alarmFormState.oneTime);
    elements.alarmOneTime.setAttribute("aria-pressed", alarmFormState.oneTime ? "true" : "false");
    elements.alarmOneTime.textContent = alarmFormState.oneTime ? "One Time" : "Recurring";

    elements.alarmSave.textContent = alarmFormState.id ? "Update Alarm" : "Save Alarm";
    elements.alarmCancel.hidden = !alarmFormState.id;
    elements.alarmSharedNote.textContent = sharedAvailable
      ? alarmFormState.shared
        ? "Shared alarms fire everywhere at the same instant."
        : "Local alarms stay on this device."
      : "Shared alarms need connected room sync.";

    elements.alarmDays.querySelectorAll("[data-alarm-day]").forEach((button) => {
      const selected = alarmFormState.daysOfWeek.includes(Number(button.dataset.alarmDay));
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function renderAlarmList() {
    if (!elements.alarmList) {
      return;
    }

    const alarms = getCombinedAlarms();
    elements.alarmList.replaceChildren();
    elements.alarmList.classList.toggle("empty", alarms.length === 0);

    if (!alarms.length) {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = "No alarms set yet.";
      elements.alarmList.appendChild(meta);
      return;
    }

    alarms.forEach((alarm) => {
      const item = document.createElement("div");
      item.className = "alarm-item";

      const top = document.createElement("div");
      top.className = "alarm-item-top";

      const detail = document.createElement("div");
      const title = document.createElement("div");
      title.className = "alarm-item-title";
      title.textContent = `${formatTimeMinutes(
        alarm.timeMinutes,
        alarm.shared ? alarm.timeZone : getCurrentTimeZone()
      )} • ${formatDaysSummary(alarm.daysOfWeek)}`;

      const meta = document.createElement("div");
      meta.className = "alarm-item-meta";
      const metaParts = [];
      if (alarm.enabled) {
        metaParts.push(`Next: ${formatAlarmDateTime(alarm.nextTriggerAt)}`);
      } else {
        metaParts.push("Alarm paused");
      }
      if (alarm.shared) {
        metaParts.push(`Creator zone: ${alarm.timeZone}`);
        metaParts.push(`Creator time: ${formatAlarmDateTimeInZone(alarm.nextTriggerAt, alarm.timeZone)}`);
        metaParts.push(`Fires here: ${formatAlarmDateTime(alarm.nextTriggerAt)}`);
      }
      if (isAlarmActive(alarm, alarmNowForScope(alarm.scope))) {
        metaParts.push(`Active until ${formatAlarmDateTime(alarm.activeUntilAt)}`);
      }
      meta.textContent = metaParts.join(" • ");

      detail.appendChild(title);
      detail.appendChild(meta);

      const badges = document.createElement("div");
      badges.className = "alarm-badges";

      const scopeBadge = document.createElement("div");
      scopeBadge.className = "alarm-badge";
      scopeBadge.textContent = alarm.shared ? "Shared" : "Local";
      badges.appendChild(scopeBadge);

      const stateBadge = document.createElement("div");
      stateBadge.className = "alarm-badge";
      if (isAlarmActive(alarm, alarmNowForScope(alarm.scope))) {
        stateBadge.classList.add("active");
        stateBadge.textContent = "Active";
      } else if (alarm.enabled) {
        stateBadge.textContent = "Enabled";
      } else {
        stateBadge.textContent = "Paused";
      }
      badges.appendChild(stateBadge);

      const recurrenceBadge = document.createElement("div");
      recurrenceBadge.className = "alarm-badge";
      recurrenceBadge.textContent = alarm.oneTime ? "One Time" : "Recurring";
      badges.appendChild(recurrenceBadge);

      top.appendChild(detail);
      top.appendChild(badges);

      const actions = document.createElement("div");
      actions.className = "alarm-actions";

      ["Edit", alarm.enabled ? "Disable" : "Enable", "Delete"].forEach((label) => {
        const action = document.createElement("button");
        action.type = "button";
        action.className = "text-button";
        action.dataset.alarmAction = label.toLowerCase();
        action.dataset.alarmId = alarm.id;
        action.dataset.alarmScope = alarm.scope;
        action.textContent = label;
        actions.appendChild(action);
      });

      item.appendChild(top);
      item.appendChild(actions);
      elements.alarmList.appendChild(item);
    });
  }

  function renderAlarmSummary() {
    const nextAlarm = getNextEnabledAlarm();
    if (!nextAlarm) {
      elements.nextAlarmSummary.textContent = "No alarms set.";
    } else {
      elements.nextAlarmSummary.textContent = `Next alarm: ${formatAlarmDateTime(nextAlarm.nextTriggerAt)} • ${nextAlarm.shared ? "Shared" : "Local"}`;
    }

    const activeAlarms = getActiveAlarms();
    elements.dismissAlarm.disabled = activeAlarms.length === 0;

    if (activeAlarms.length) {
      const latestEnd = activeAlarms.reduce(
        (maxValue, alarm) => Math.max(maxValue, Number(alarm.activeUntilAt) || 0),
        0
      );
      const prefix = activeAlarms.some((alarm) => alarm.shared) ? "Shared alarm active" : "Alarm active";
      elements.alarmStatus.textContent = `${prefix} until ${formatAlarmDateTime(latestEnd)}`;
      elements.alarmStatus.className = "meta tray-status status-warn";
      return;
    }

    if (alarmMessage.text) {
      elements.alarmStatus.textContent = alarmMessage.text;
      elements.alarmStatus.className = `meta tray-status ${alarmMessage.kind === "danger" ? "status-danger" : alarmMessage.kind === "ok" ? "status-ok" : "status-warn"}`;
      return;
    }

    elements.alarmStatus.textContent = areSharedAlarmsAvailable()
      ? "Local alarms stay on this device. Shared alarms use the connected room."
      : "Shared alarms need connected room sync.";
    elements.alarmStatus.className = "meta tray-status";
  }

  function renderAlarmUi() {
    renderAlarmForm();
    renderAlarmList();
    renderAlarmSummary();
  }

  function renderConfigurationTimeUi() {
    if (elements.frameTimeZone) {
      elements.frameTimeZone.value = getCurrentTimeZone();
    }

    if (elements.frameTimeDisplay) {
      elements.frameTimeDisplay.textContent = formatFrameClock(Date.now());
    }

    if (elements.frameTimeZoneNote) {
      const option = getCurrentFrameTimeZoneOption();
      elements.frameTimeZoneNote.textContent = `Alarm times on this frame follow ${option.longLabel} (${option.shortLabel}).`;
    }
  }

  function startFrameClock() {
    if (frameClockTimer) {
      return;
    }

    renderConfigurationTimeUi();
    frameClockTimer = window.setInterval(() => {
      renderConfigurationTimeUi();
    }, 1000);
  }

  async function applyFrameTimeZoneSelection(nextTimeZone) {
    const previousTimeZone = getCurrentTimeZone();
    const normalizedTimeZone = setCurrentFrameTimeZone(nextTimeZone);
    if (normalizedTimeZone === previousTimeZone) {
      renderConfigurationTimeUi();
      return;
    }

    const localNow = alarmNowForScope("local");

    if (localAlarmStore) {
      await writeAlarmContainer("local", (container) => ({
        ...container,
        alarms: container.alarms.map((alarm) => normalizeAlarm({
          ...alarm,
          timeZone: normalizedTimeZone,
          nextTriggerAt: computeNextTriggerAt(
            alarm.timeMinutes,
            alarm.daysOfWeek,
            normalizedTimeZone,
            localNow
          ),
          updatedByDeviceId: ctx.deviceId,
          updatedAt: localNow
        }, "local"))
      }));
    }

    if (sharedAlarmStore) {
      const sharedNow = alarmNowForScope("shared");
      await writeAlarmContainer("shared", (container) => ({
        ...container,
        alarms: container.alarms.map((alarm) => {
          if (alarm.createdByDeviceId !== ctx.deviceId) {
            return alarm;
          }

          return normalizeAlarm({
            ...alarm,
            timeZone: normalizedTimeZone,
            nextTriggerAt: computeNextTriggerAt(
              alarm.timeMinutes,
              alarm.daysOfWeek,
              normalizedTimeZone,
              sharedNow
            ),
            updatedByDeviceId: ctx.deviceId,
            updatedAt: sharedNow
          }, "shared");
        })
      }));
    }

    setAlarmStatusMessage(`Time zone updated to ${getCurrentFrameTimeZoneOption().shortLabel}.`, "ok");
    renderConfigurationTimeUi();
    await runAlarmEvaluationImmediately();
  }

  function processAlarmContainer(container, scope) {
    const referenceNow = alarmNowForScope(scope);
    let changed = false;
    const triggered = [];
    const alarms = container.alarms.map((alarm) => {
      const nextAlarm = { ...alarm };

      if (!nextAlarm.nextTriggerAt) {
        nextAlarm.nextTriggerAt = computeNextTriggerAt(
          nextAlarm.timeMinutes,
          nextAlarm.daysOfWeek,
          nextAlarm.timeZone,
          referenceNow
        );
        changed = true;
      }

      if (nextAlarm.activeUntilAt && nextAlarm.activeUntilAt <= referenceNow) {
        nextAlarm.activeUntilAt = 0;
        changed = true;
      }

      if (!nextAlarm.enabled) {
        return nextAlarm;
      }

      if (nextAlarm.nextTriggerAt && nextAlarm.nextTriggerAt <= referenceNow) {
        const dueAt = nextAlarm.nextTriggerAt;
        const stillWithinWindow = referenceNow <= dueAt + alarmMaxDurationMs;
        nextAlarm.lastTriggeredAt = dueAt;
        nextAlarm.activeUntilAt = stillWithinWindow
          ? Math.max(nextAlarm.activeUntilAt || 0, dueAt + alarmMaxDurationMs)
          : 0;
        if (nextAlarm.oneTime) {
          nextAlarm.enabled = false;
        }
        nextAlarm.nextTriggerAt = nextAlarm.oneTime
          ? 0
          : computeNextTriggerAt(
              nextAlarm.timeMinutes,
              nextAlarm.daysOfWeek,
              nextAlarm.timeZone,
              Math.max(referenceNow, dueAt) + 60000
            );
        nextAlarm.updatedByDeviceId = ctx.deviceId;
        nextAlarm.updatedAt = referenceNow;
        changed = true;

        if (stillWithinWindow) {
          triggered.push({
            ...nextAlarm,
            scope
          });
        }
      }

      return nextAlarm;
    });

    return {
      changed,
      triggered,
      container: normalizeAlarmContainer({
        alarms,
        updatedAt: changed ? referenceNow : container.updatedAt
      }, scope)
    };
  }

  async function ensureSharedAlarmPlayback() {
    const nextState = await writeRoomState((baseState) => {
      const source = baseState.playlistUrl ? baseState : buildDefaultState();
      if (!source.playlistUrl) {
        return source;
      }

      const offsetMs = Math.round(expectedPositionSeconds(baseState) * 1000);
      return normalizeState({
        ...source,
        isPlaying: true,
        trackStartedAt: source.playlistUrl && baseState.playlistUrl
          ? now() - offsetMs
          : now(),
        pausedTrackOffsetMs: source.playlistUrl && baseState.playlistUrl
          ? offsetMs
          : 0
      });
    }, {
      claimLeadership: true,
      forceWrite: true
    });

    if (nextState) {
      musicState = normalizeState(nextState);
    }
  }

  async function engageAlarmAudio(triggeredAlarms) {
    if (!triggeredAlarms.length) {
      return;
    }

    const localAlarmTriggered = triggeredAlarms.some((alarm) => !alarm.shared);
    if (localAlarmTriggered) {
      const baseState = normalizeState(musicState || {});
      const sourceState = baseState.playlistUrl ? baseState : buildDefaultState();
      const resumeOffsetMs = Math.round(expectedPositionSeconds(sourceState) * 1000);
      alarmSession.playbackStartedAt = now() - resumeOffsetMs;
      alarmSession.resumeOffsetMs = resumeOffsetMs;
    }

    if (triggeredAlarms.some((alarm) => alarm.shared) && areSharedAlarmsAvailable()) {
      await ensureSharedAlarmPlayback();
    }

    await queueReconcile();
    await refreshLocalStatus();

    if (localStatus.muted) {
      const muteResult = await postJSON("/music/mute", { mute: false });
      if (muteResult.ok) {
        localStatus = normalizePlayerStatus(muteResult.status || localStatus);
      }
    }

    if (localStatus.volume < alarmMinVolume) {
      if (!alarmSession.volumeRaised) {
        alarmSession.restoreVolume = localStatus.volume;
      }
      alarmSession.volumeRaised = true;
      await handleLocalVolumeChange(alarmMinVolume);
    }

    alarmSession.engaged = true;
    setAlarmStatusMessage("", "");
    updateUi();
  }

  async function finishAlarmAudio() {
    if (!alarmSession.engaged) {
      return;
    }

    if (alarmSession.volumeRaised && Number.isFinite(Number(alarmSession.restoreVolume))) {
      await handleLocalVolumeChange(alarmSession.restoreVolume);
    }

    const muteResult = await postJSON("/music/mute", { mute: true }).catch(() => null);
    if (muteResult && muteResult.ok) {
      localStatus = normalizePlayerStatus(muteResult.status || localStatus);
    } else {
      await refreshLocalStatus();
    }

    alarmSession = {
      engaged: false,
      restoreVolume: null,
      volumeRaised: false,
      playbackStartedAt: null,
      resumeOffsetMs: null
    };
    updateUi();
  }

  async function evaluateAlarms() {
    let localContainer = getAlarmContainer("local");
    let sharedContainer = getAlarmContainer("shared");
    const previousActiveKeys = new Set(alarmActiveKeys);

    const localResult = processAlarmContainer(localContainer, "local");
    if (localResult.changed) {
      localContainer = await writeAlarmContainer("local", () => localResult.container);
    } else {
      localContainer = localResult.container;
      setAlarmContainer("local", localContainer);
    }

    let sharedTriggered = [];
    if (sharedAlarmStore) {
      const sharedResult = processAlarmContainer(sharedContainer, "shared");
      sharedTriggered = sharedResult.triggered;
      if (sharedResult.changed) {
        sharedContainer = await writeAlarmContainer("shared", () => sharedResult.container);
      } else {
        sharedContainer = sharedResult.container;
        setAlarmContainer("shared", sharedContainer);
      }
    } else {
      sharedContainer = normalizeAlarmContainer(null, "shared");
      setAlarmContainer("shared", sharedContainer);
    }

    const activeAlarms = getActiveAlarms();
    const nextActiveKeys = new Set(activeAlarms.map((alarm) => activeAlarmKeyFor(alarm)));
    alarmActiveKeys = nextActiveKeys;

    const newlyActivated = activeAlarms.filter((alarm) => !previousActiveKeys.has(activeAlarmKeyFor(alarm)));
    const triggeredAlarms = localResult.triggered.concat(sharedTriggered);

    if (newlyActivated.length || triggeredAlarms.length) {
      await engageAlarmAudio(newlyActivated.length ? newlyActivated : triggeredAlarms);
      return;
    }

    if (previousActiveKeys.size && !nextActiveKeys.size) {
      await finishAlarmAudio();
      return;
    }

    updateUi();
  }

  function startAlarmScheduler() {
    if (alarmTimer) {
      return;
    }

    alarmTimer = window.setInterval(() => {
      scheduleAlarmEvaluation(0);
    }, alarmPollMs);
  }

  async function saveAlarmFromForm() {
    const timeMinutes = timeValueToMinutes(elements.alarmTime.value);
    if (timeMinutes === null) {
      throw new Error("Choose a valid alarm time.");
    }

    const daysOfWeek = normalizeDaysOfWeek(alarmFormState.daysOfWeek);
    if (!daysOfWeek.length) {
      throw new Error("Choose at least one weekday.");
    }

    const targetScope = alarmFormState.shared && areSharedAlarmsAvailable() ? "shared" : "local";
    const sourceScope = alarmFormState.id ? alarmFormState.sourceScope : targetScope;
    const existingAlarm = alarmFormState.id
      ? getAlarmContainer(sourceScope).alarms.find((alarm) => alarm.id === alarmFormState.id)
      : null;
    const timeZone = targetScope === "shared"
      ? (existingAlarm && existingAlarm.shared ? existingAlarm.timeZone : getCurrentTimeZone())
      : getCurrentTimeZone();
    const nextTriggerAt = computeNextTriggerAt(
      timeMinutes,
      daysOfWeek,
      timeZone,
      alarmNowForScope(targetScope)
    );
    const nextAlarm = {
      id: alarmFormState.id || createAlarmId(),
      timeMinutes,
      daysOfWeek,
      enabled: alarmFormState.enabled,
      oneTime: Boolean(alarmFormState.oneTime),
      shared: targetScope === "shared",
      timeZone,
      nextTriggerAt,
      lastTriggeredAt: 0,
      activeUntilAt: 0,
      createdByDeviceId: existingAlarm ? existingAlarm.createdByDeviceId : ctx.deviceId,
      updatedByDeviceId: ctx.deviceId,
      updatedAt: alarmNowForScope(targetScope)
    };

    if (alarmFormState.id && sourceScope !== targetScope) {
      await writeAlarmContainer(sourceScope, (container) => ({
        ...container,
        alarms: container.alarms.filter((alarm) => alarm.id !== alarmFormState.id)
      }));
    }

    let nextContainer = await writeAlarmContainer(targetScope, (container) => ({
      ...container,
      alarms: container.alarms
        .filter((alarm) => alarm.id !== nextAlarm.id)
        .concat(nextAlarm)
    }));

    const alarmSaved = () => nextContainer.alarms.some((alarm) => alarm.id === nextAlarm.id);
    if (!alarmSaved()) {
      nextContainer = await writeAlarmContainer(targetScope, (container) => ({
        ...container,
        alarms: container.alarms
          .filter((alarm) => alarm.id !== nextAlarm.id)
          .concat(nextAlarm)
      }));
    }

    if (!alarmSaved()) {
      throw new Error("Alarm could not be saved yet. Please try again.");
    }

    resetAlarmForm();
    await runAlarmEvaluationImmediately();
  }

  async function toggleAlarmEnabled(scope, alarmId) {
    await writeAlarmContainer(scope, (container) => ({
      ...container,
      alarms: container.alarms.map((alarm) => {
        if (alarm.id !== alarmId) {
          return alarm;
        }

        const enabled = !alarm.enabled;
        return normalizeAlarm({
          ...alarm,
          enabled,
          activeUntilAt: enabled ? 0 : 0,
          nextTriggerAt: enabled
            ? computeNextTriggerAt(
                alarm.timeMinutes,
                alarm.daysOfWeek,
                alarm.timeZone,
                alarmNowForScope(scope)
              )
            : 0,
          updatedByDeviceId: ctx.deviceId,
          updatedAt: alarmNowForScope(scope)
        }, scope);
      })
    }));

    await runAlarmEvaluationImmediately();
  }

  async function deleteAlarm(scope, alarmId) {
    let nextContainer = await writeAlarmContainer(scope, (container) => ({
      ...container,
      alarms: container.alarms.filter((alarm) => alarm.id !== alarmId)
    }));

    if (scope === "shared" && nextContainer.alarms.some((alarm) => alarm.id === alarmId)) {
      nextContainer = await writeAlarmContainer(scope, (container) => ({
        ...container,
        alarms: container.alarms.filter((alarm) => alarm.id !== alarmId)
      }));
    }

    if (nextContainer.alarms.some((alarm) => alarm.id === alarmId)) {
      throw new Error("Alarm could not be deleted yet. Please try again.");
    }

    if (alarmFormState.id === alarmId) {
      resetAlarmForm();
    }
    await runAlarmEvaluationImmediately();
  }

  async function dismissActiveAlarms() {
    if (localAlarmStore) {
      await writeAlarmContainer("local", (container) => ({
        ...container,
        alarms: container.alarms.map((alarm) => ({
          ...alarm,
          activeUntilAt: 0,
          updatedByDeviceId: ctx.deviceId,
          updatedAt: alarmNowForScope("local")
        }))
      }));
    }

    if (sharedAlarmStore) {
      await writeAlarmContainer("shared", (container) => ({
        ...container,
        alarms: container.alarms.map((alarm) => ({
          ...alarm,
          activeUntilAt: 0,
          updatedByDeviceId: ctx.deviceId,
          updatedAt: alarmNowForScope("shared")
        }))
      }));
    }

    setAlarmStatusMessage("", "");
    await runAlarmEvaluationImmediately();
  }

  function handleAlarmStoreChange(scope, nextState) {
    setAlarmContainer(scope, normalizeAlarmContainer(nextState, scope));
    updateUi();
    scheduleAlarmEvaluation(0);
  }

  async function initializeAlarmStores() {
    localAlarmStore = ctx.createStore("alarms_local", { scope: "local" });
    const initialLocal = await localAlarmStore.get();
    localAlarmsState = normalizeAlarmContainer(initialLocal, "local");
    if (!initialLocal) {
      await localAlarmStore.set(localAlarmsState);
    }
    localAlarmStore.subscribe((nextState) => {
      handleAlarmStoreChange("local", nextState);
    });

    if (isSharedMusicMode()) {
      sharedAlarmStore = ctx.createStore("alarms_shared", { scope: "shared" });
      const initialShared = await sharedAlarmStore.get();
      sharedAlarmsState = normalizeAlarmContainer(initialShared, "shared");
      if (!initialShared) {
        await sharedAlarmStore.set(sharedAlarmsState);
      }
      sharedAlarmStore.subscribe((nextState) => {
        handleAlarmStoreChange("shared", nextState);
      });
    } else {
      sharedAlarmStore = null;
      sharedAlarmsState = normalizeAlarmContainer(null, "shared");
    }
  }

  function queueReconcile() {
    reconcileQueue = reconcileQueue
      .then(() => reconcileMusicPlayer())
      .catch((error) => {
        console.error("[music] reconcile failed:", error);
        setMusicLabel(error.message || "Music sync failed.", true);
      });
    return reconcileQueue;
  }

  function advanceState(baseState, offset) {
    if (!baseState.playlistLength) {
      return baseState;
    }

    const rawNextOrderIndex = baseState.currentOrderIndex + offset;
    let nextOrderIndex =
      ((rawNextOrderIndex % baseState.playlistLength) + baseState.playlistLength) %
      baseState.playlistLength;
    let nextOrder = baseState.order;

    if (
      baseState.shuffleEnabled &&
      baseState.playlistLength > 1 &&
      offset > 0 &&
      rawNextOrderIndex >= baseState.playlistLength
    ) {
      nextOrder = buildFreshShuffleCycleOrder(
        baseState.playlistLength,
        currentTrackIndexFor(baseState),
        normalizeOrder(baseState.order, baseState.playlistLength)
      );
      nextOrderIndex =
        ((rawNextOrderIndex - baseState.playlistLength) % baseState.playlistLength + baseState.playlistLength) %
        baseState.playlistLength;
    }

    const nextTrackIndex = nextOrder[nextOrderIndex] ?? nextOrderIndex;

    return normalizeState({
      ...baseState,
      order: nextOrder,
      currentOrderIndex: nextOrderIndex,
      currentTrackIndex: nextTrackIndex,
      currentTrackKey: baseState.playlistItems[nextTrackIndex]
        ? baseState.playlistItems[nextTrackIndex].key
        : baseState.currentTrackKey,
      isPlaying: true,
      trackStartedAt: now(),
      pausedTrackOffsetMs: 0,
      trackTitle: ""
    });
  }

  function toggleShuffleState(baseState) {
    if (baseState.playlistLength < 2) {
      return baseState;
    }

    const currentTrackIndex = currentTrackIndexFor(baseState);

    if (baseState.shuffleEnabled) {
      return normalizeState({
        ...baseState,
        shuffleEnabled: false,
        order: identityOrder(baseState.playlistLength),
        currentOrderIndex: currentTrackIndex,
        currentTrackIndex
      });
    }

    return normalizeState({
      ...baseState,
      shuffleEnabled: true,
      order: shuffleOrderKeepingCurrent(baseState.playlistLength, currentTrackIndex),
      currentOrderIndex: 0,
      currentTrackIndex
    });
  }

  function statesEqual(left, right) {
    return JSON.stringify(normalizeState(left)) === JSON.stringify(normalizeState(right));
  }

  function finalizeRoomStateWrite(baseState, desiredState, options) {
    const nextState = normalizeState({
      ...desiredState,
      actor: ctx.deviceId,
      updatedAt: now(),
      revision: Math.max(0, Number(baseState.revision) || 0) + 1
    });

    if (isSharedMusicMode()) {
      if (options && options.claimLeadership === false) {
        nextState.leaderDeviceId = desiredState.leaderDeviceId || baseState.leaderDeviceId || ctx.deviceId;
        nextState.leaderHeartbeatAt = options.touchHeartbeat
          ? now()
          : desiredState.leaderHeartbeatAt || baseState.leaderHeartbeatAt || now();
      } else {
        nextState.leaderDeviceId = ctx.deviceId;
        nextState.leaderHeartbeatAt = now();
      }
    } else {
      nextState.leaderDeviceId = "";
      nextState.leaderHeartbeatAt = 0;
    }

    if (options && options.advanceTransition) {
      nextState.lastAdvanceAt = now();
      nextState.advanceLockUntil = now() + advanceLockMs;
      nextState.advanceToken = Math.max(0, Number(baseState.advanceToken) || 0) + 1;
    } else {
      nextState.lastAdvanceAt = Number.isFinite(Number(desiredState.lastAdvanceAt))
        ? Number(desiredState.lastAdvanceAt)
        : Number(baseState.lastAdvanceAt) || 0;
      nextState.advanceLockUntil = Number.isFinite(Number(desiredState.advanceLockUntil))
        ? Number(desiredState.advanceLockUntil)
        : Number(baseState.advanceLockUntil) || 0;
      nextState.advanceToken = Number.isFinite(Number(desiredState.advanceToken))
        ? Number(desiredState.advanceToken)
        : Math.max(0, Number(baseState.advanceToken) || 0);
    }

    nextState.currentTrackKey = currentTrackKeyFor(nextState);
    nextState.playlistSignature = computePlaylistSignature(nextState.playlistItems);
    return nextState;
  }

  async function writeRoomState(mutator, options) {
    if (!musicStore) {
      return null;
    }

    const forceWrite = Boolean(options && options.forceWrite);

    if (isSharedMusicMode() && typeof musicStore.mutate === "function") {
      const result = await musicStore.mutate((remoteState) => {
        const baseState = normalizeState(remoteState || musicState || buildDefaultState());
        const desiredState = normalizeState(mutator(baseState));

        if (statesEqual(desiredState, baseState) && !forceWrite) {
          return;
        }

        return finalizeRoomStateWrite(baseState, desiredState, options);
      });

      if (!result || result.committed === false) {
        return normalizeState((result && result.value) || musicState || buildDefaultState());
      }

      return normalizeState(result.value || buildDefaultState());
    }

    const baseState = normalizeState(musicState || buildDefaultState());
    const desiredState = normalizeState(mutator(baseState));

    if (statesEqual(desiredState, baseState) && !forceWrite) {
      return baseState;
    }

    const nextState = finalizeRoomStateWrite(baseState, desiredState, options);

    await musicStore.set(nextState);
    return normalizeState(nextState);
  }

  async function maybePublishMetadata(playlistItems, trackTitle) {
    if (!musicState) {
      return;
    }

    let shouldUpdate = false;
    const normalizedItems = normalizePlaylistItems(playlistItems);
    const playlistLength = normalizedItems.length;
    const playlistSignature = computePlaylistSignature(normalizedItems);

    await writeRoomState((baseState) => {
      const nextState = { ...baseState };

      if (playlistLength && (
        playlistLength !== baseState.playlistLength ||
        playlistSignature !== baseState.playlistSignature
      )) {
        nextState.playlistLength = playlistLength;
        nextState.playlistItems = normalizedItems;
        nextState.playlistSignature = playlistSignature;
        if (baseState.shuffleEnabled && normalizeOrder(baseState.order, playlistLength).length === playlistLength) {
          nextState.order = normalizeOrder(baseState.order, playlistLength);
        } else {
          nextState.order = identityOrder(playlistLength);
          nextState.shuffleEnabled = false;
        }
        nextState.currentOrderIndex = Math.min(
          baseState.currentOrderIndex,
          Math.max(0, playlistLength - 1)
        );
        nextState.currentTrackIndex = currentTrackIndexFor(nextState);
        nextState.currentTrackKey = currentTrackKeyFor(normalizeState(nextState));
        shouldUpdate = true;
      }

      if (trackTitle && trackTitle !== baseState.trackTitle) {
        nextState.trackTitle = trackTitle;
        shouldUpdate = true;
      }

      if (!baseState.playlistLength && playlistLength) {
        nextState.currentTrackIndex = currentTrackIndexFor(nextState);
        nextState.currentTrackKey = currentTrackKeyFor(nextState);
      }

      return nextState;
    }, {
      claimLeadership: isSharedMusicMode(),
      forceWrite: shouldUpdate
    });
  }

  async function maybeAdvanceCompletedTrack(status) {
    if (!musicState || !musicState.playlistLength || !musicState.isPlaying || !isCoordinatorFor(musicState)) {
      return false;
    }

    if (status.loading) {
      return false;
    }

    if (Number(musicState.advanceLockUntil) > now()) {
      return false;
    }

    const duration = Number(status.durationSeconds);
    const position = Number(status.positionSeconds);
    const localTrackKey = currentLocalTrackKey(status);
    const roomTrackKey = currentTrackKeyFor(musicState);
    const endedOnRoomTrack = status.ended && (!localTrackKey || localTrackKey === roomTrackKey);
    const shouldAdvance =
      endedOnRoomTrack ||
      (status.running &&
        localTrackKey &&
        localTrackKey === roomTrackKey &&
        Number.isFinite(duration) &&
        Number.isFinite(position) &&
        position >= Math.max(0, duration - trackEndThresholdSeconds));

    if (!shouldAdvance) {
      return false;
    }

    const expectedAdvanceToken = Math.max(0, Number(musicState.advanceToken) || 0);
    const nextState = await writeRoomState((baseState) => {
      const normalizedBase = normalizeState(baseState);
      if (
        Number(normalizedBase.advanceLockUntil) > now() ||
        Math.max(0, Number(normalizedBase.advanceToken) || 0) !== expectedAdvanceToken ||
        currentTrackKeyFor(normalizedBase) !== roomTrackKey
      ) {
        return normalizedBase;
      }
      return advanceState(normalizedBase, 1);
    }, {
      claimLeadership: true,
      advanceTransition: true
    });
    return !statesEqual(nextState, musicState);
  }

  async function reconcileMusicPlayer() {
    if (!musicState) {
      return;
    }

    const baseState = normalizeState(musicState);
    const state = getEffectivePlaybackState(baseState);
    const localAlarmOverride = hasActiveLocalAlarms();
    updateUi();

    if (!state.playlistUrl) {
      await stopLocalPlayback();
      updateUi();
      return;
    }

    let status = await refreshLocalStatus();
    let playlistLength = state.playlistLength;
    let trackTitle = state.trackTitle;
    const expectedTrackIndex = currentTrackIndexFor(state);
    const expectedTrackKey = currentTrackKeyFor(state);
    let changedTrackLocally = false;
    const localTrackKey = currentLocalTrackKey(status);
    const followerWaitingForResolvedPlaylist =
      isSharedMusicMode() &&
      !isCoordinatorFor(baseState) &&
      Boolean(state.playlistUrl) &&
      !state.playlistItems.length;

    const needsPlaylistLoad =
      localPlaylistUrl !== state.playlistUrl ||
      (Boolean(state.playlistSignature) && localPlaylistSignature !== state.playlistSignature) ||
      status.index < 0 ||
      !status.track;

    if (followerWaitingForResolvedPlaylist) {
      localStatus = normalizePlayerStatus(status);
      updateUi();
      return;
    }

    if (needsPlaylistLoad) {
      if (localPlaylistUrl !== state.playlistUrl) {
        clearLocalPlaylistItems();
      }

      const loaded = await postJSON("/music/playlist", {
        playlist_url: state.playlistUrl,
        playlist_items: Array.isArray(state.playlistItems) && state.playlistItems.length
          ? state.playlistItems
          : undefined,
        start_index: expectedTrackIndex,
        paused: !state.isPlaying
      });

      if (!loaded.ok) {
        throw new Error(loaded.error || "Could not load playlist.");
      }

      localPlaylistUrl = state.playlistUrl;
      setLocalPlaylistItems(loaded.playlist);
      playlistLength = Array.isArray(loaded.playlist) ? loaded.playlist.length : playlistLength;
      trackTitle = loaded.now && loaded.now.title ? loaded.now.title : trackTitle;
      status = normalizePlayerStatus(loaded.status || status);
      changedTrackLocally = true;
    } else if (
      (expectedTrackKey && localTrackKey && localTrackKey !== expectedTrackKey) ||
      (!expectedTrackKey && status.index !== expectedTrackIndex)
    ) {
      const moved = await postJSON("/music/play_cached", {
        index: expectedTrackIndex,
        paused: !state.isPlaying
      });

      if (!moved.ok) {
        throw new Error(moved.error || "Could not change tracks.");
      }

      trackTitle = moved.now && moved.now.title ? moved.now.title : trackTitle;
      status = normalizePlayerStatus(moved.status || status);
      changedTrackLocally = true;
    } else if (!status.running && state.isPlaying && !status.ended) {
      const restarted = await postJSON("/music/play_cached", {
        index: expectedTrackIndex,
        paused: false
      });

      if (!restarted.ok) {
        throw new Error(restarted.error || "Could not restart the current track.");
      }

      trackTitle = restarted.now && restarted.now.title ? restarted.now.title : trackTitle;
      status = normalizePlayerStatus(restarted.status || status);
      changedTrackLocally = true;
    }

    if (status.loading) {
      localStatus = normalizePlayerStatus(status);
      updateUi();
      return;
    }

    if (await maybeAdvanceCompletedTrack(status)) {
      return;
    }

    if (status.ended) {
      updateUi();
      return;
    }

    if (
      !localAlarmOverride &&
      playlistLength &&
      (
        !baseState.playlistLength ||
        playlistLength !== baseState.playlistLength ||
        trackTitle !== baseState.trackTitle ||
        computePlaylistSignature(localPlaylistItems) !== baseState.playlistSignature
      )
    ) {
      if (!isSharedMusicMode() || isCoordinatorFor(baseState)) {
        await maybePublishMetadata(localPlaylistItems, trackTitle);
        return;
      }
    }

    if (status.paused !== !state.isPlaying) {
      const paused = await postJSON("/music/pause", {
        paused: !state.isPlaying
      });

      if (!paused.ok) {
        throw new Error(paused.error || "Could not update pause state.");
      }

      status = normalizePlayerStatus(paused.status || status);
    }

    const expectedPosition = expectedPositionSeconds(state);
    const durationSeconds = Number(status.durationSeconds);
    const clampedExpectedPosition = Number.isFinite(durationSeconds)
      ? Math.max(0, Math.min(expectedPosition, durationSeconds))
      : Math.max(0, expectedPosition);
    const actualPosition = Number(status.positionSeconds);
    const seekThreshold = changedTrackLocally
      ? immediateSeekThresholdSeconds
      : driftThresholdSeconds;
    const statusTrackKey = currentLocalTrackKey(status);
    const canSeekAggressively = !(
      expectedTrackKey &&
      statusTrackKey === expectedTrackKey &&
      isWithinTransitionSettleWindow(state, now())
    );

    if (
      status.running &&
      canSeekAggressively &&
      Number.isFinite(actualPosition) &&
      Math.abs(actualPosition - clampedExpectedPosition) > seekThreshold
    ) {
      const seekResult = await postJSON("/music/seek", {
        positionSeconds: clampedExpectedPosition
      });

      if (!seekResult.ok) {
        throw new Error(seekResult.error || "Could not seek to the shared room position.");
      }

      status = await refreshLocalStatus();
    }

    localStatus = normalizePlayerStatus(status);
    updateUi();
  }

  async function handleLocalMuteToggle() {
    const muted = !localStatus.muted;
    const response = await postJSON("/music/mute", {
      mute: muted
    });

    if (!response.ok) {
      throw new Error(response.error || "Could not change local mute.");
    }

    localStatus = normalizePlayerStatus(response.status || localStatus);
    updateUi();
  }

  async function handleLocalVolumeChange(volume) {
    const response = await postJSON("/music/volume", {
      volume
    });

    if (!response.ok) {
      throw new Error(response.error || "Could not change local volume.");
    }

    localStatus = normalizePlayerStatus(response.status || {
      ...localStatus,
      volume: response.volume
    });
    updateUi();
  }

  async function submitRoomAction(action, message, options) {
    try {
      const nextState = await writeRoomState(action, options);
      if (nextState) {
        musicState = normalizeState(nextState);
        updateUi();
        queueReconcile();
      }
    } catch (error) {
      console.error("[music] room action failed:", error);
      setMusicLabel(message || error.message || "Could not update shared music.", true);
    }
  }

  async function handleTrackSelection(trackIndex) {
    const normalizedIndex = Number(trackIndex);
    if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0) {
      return;
    }

    await submitRoomAction((baseState) => {
      if (!baseState.playlistLength || normalizedIndex >= baseState.playlistLength) {
        return baseState;
      }

      const queuePosition = baseState.shuffleEnabled
        ? baseState.order.indexOf(normalizedIndex)
        : normalizedIndex;

      if (queuePosition < 0) {
        return baseState;
      }

      return normalizeState({
        ...baseState,
        currentOrderIndex: queuePosition,
        currentTrackIndex: normalizedIndex,
        isPlaying: true,
        trackStartedAt: now(),
        pausedTrackOffsetMs: 0,
        trackTitle: localPlaylistItems[normalizedIndex]?.title || baseState.trackTitle || ""
      });
    }, "Could not switch to that song.", {
      claimLeadership: true,
      forceWrite: true
    });
  }

  function getPlaylistScrollElement(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    return target.closest(".music-playlist-list");
  }

  function startPlaylistPointerSession(event) {
    const scrollEl = getPlaylistScrollElement(event.target);
    if (!scrollEl) {
      playlistPointerSession = null;
      return;
    }

    playlistPointerSession = {
      pointerId: event.pointerId,
      scrollEl,
      startY: Number(event.clientY) || 0,
      startScrollTop: scrollEl.scrollTop,
      moved: false
    };

    if (typeof scrollEl.setPointerCapture === "function") {
      try {
        scrollEl.setPointerCapture(event.pointerId);
      } catch (error) {
        // Ignore pointer capture failures and continue with best-effort drag scrolling.
      }
    }
  }

  function updatePlaylistPointerSession(event) {
    if (!playlistPointerSession || event.pointerId !== playlistPointerSession.pointerId) {
      return;
    }

    const currentY = Number(event.clientY) || 0;
    const deltaY = currentY - playlistPointerSession.startY;
    if (!playlistPointerSession.moved && Math.abs(deltaY) >= 8) {
      playlistPointerSession.moved = true;
    }

    if (!playlistPointerSession.moved) {
      return;
    }

    playlistPointerSession.scrollEl.scrollTop = playlistPointerSession.startScrollTop - deltaY;
    event.preventDefault();
  }

  function finishPlaylistPointerSession(event) {
    if (!playlistPointerSession || event.pointerId !== playlistPointerSession.pointerId) {
      return;
    }

    const session = playlistPointerSession;
    playlistPointerSession = null;

    if (typeof session.scrollEl.releasePointerCapture === "function") {
      try {
        session.scrollEl.releasePointerCapture(event.pointerId);
      } catch (error) {
        // Ignore pointer release failures.
      }
    }

    if (session.moved) {
      playlistSuppressClickUntil = Date.now() + 500;
      event.preventDefault();
    }
  }

  function wireControls() {
    elements.next.addEventListener("click", () => {
      submitRoomAction((baseState) => advanceState(baseState, 1), "Could not move to the next shared track.", {
        claimLeadership: true
      });
    });

    elements.prev.addEventListener("click", () => {
      submitRoomAction((baseState) => advanceState(baseState, -1), "Could not move to the previous shared track.", {
        claimLeadership: true
      });
    });

    elements.toggle.addEventListener("click", () => {
      submitRoomAction((baseState) => {
        const nextPositionMs = Math.round(expectedPositionSeconds(baseState) * 1000);
        if (baseState.isPlaying) {
          return normalizeState({
            ...baseState,
            isPlaying: false,
            pausedTrackOffsetMs: nextPositionMs
          });
        }

        return normalizeState({
          ...baseState,
          isPlaying: true,
          trackStartedAt: now() - nextPositionMs,
          pausedTrackOffsetMs: nextPositionMs
        });
      }, "Could not update shared play state.", {
        claimLeadership: true
      });
    });

    elements.shuffle.addEventListener("click", () => {
      submitRoomAction((baseState) => toggleShuffleState(baseState), "Could not update shared shuffle.", {
        claimLeadership: true
      });
    });

    elements.mute.addEventListener("click", () => {
      handleLocalMuteToggle().catch((error) => {
        console.error("[music] mute failed:", error);
        setMusicLabel(error.message || "Could not change local mute.", true);
      });
    });

    elements.volume.addEventListener("input", () => {
      const value = Math.max(0, Math.min(100, Number(elements.volume.value) || 0));
      elements.volumeValue.textContent = `${Math.round(value)}%`;
    });

    elements.volume.addEventListener("change", () => {
      const value = Math.max(0, Math.min(100, Number(elements.volume.value) || 0));
      handleLocalVolumeChange(value).catch((error) => {
        console.error("[music] volume failed:", error);
        setMusicLabel(error.message || "Could not change local volume.", true);
      });
    });

    elements.load.addEventListener("click", async () => {
      const playlistUrl = (elements.input.value || "").trim();
      clearLocalPlaylistItems();
      await submitRoomAction(() => normalizeState({
        playlistUrl,
        playlistLength: 0,
        order: [],
        shuffleEnabled: false,
        currentOrderIndex: 0,
        currentTrackIndex: 0,
        isPlaying: Boolean(playlistUrl),
        trackStartedAt: now(),
        pausedTrackOffsetMs: 0,
        trackTitle: ""
      }), "Could not load the shared playlist.", {
        claimLeadership: true,
        forceWrite: true
      });
    });

    elements.playlist.addEventListener("click", (event) => {
      if (Date.now() < playlistSuppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const button = event.target.closest("[data-track-index]");
      if (!button) {
        return;
      }

      handleTrackSelection(button.dataset.trackIndex).catch((error) => {
        console.error("[music] track selection failed:", error);
        setMusicLabel(error.message || "Could not switch to that song.", true);
      });
    });

    elements.playlist.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      startPlaylistPointerSession(event);
    });

    elements.playlist.addEventListener("pointermove", (event) => {
      updatePlaylistPointerSession(event);
    }, { passive: false });

    elements.playlist.addEventListener("pointerup", (event) => {
      finishPlaylistPointerSession(event);
    }, { passive: false });

    elements.playlist.addEventListener("pointercancel", (event) => {
      finishPlaylistPointerSession(event);
    }, { passive: false });

    elements.alarmTime.addEventListener("change", () => {
      const timeMinutes = timeValueToMinutes(elements.alarmTime.value);
      if (timeMinutes !== null) {
        alarmFormState.timeMinutes = timeMinutes;
      }
    });

    elements.alarmDays.addEventListener("click", (event) => {
      const button = event.target.closest("[data-alarm-day]");
      if (!button) {
        return;
      }

      const day = Number(button.dataset.alarmDay);
      if (!Number.isInteger(day)) {
        return;
      }

      const nextDays = new Set(alarmFormState.daysOfWeek);
      if (nextDays.has(day)) {
        nextDays.delete(day);
      } else {
        nextDays.add(day);
      }
      alarmFormState.daysOfWeek = Array.from(nextDays).sort((left, right) => left - right);
      renderAlarmForm();
    });

    elements.alarmShared.addEventListener("click", () => {
      if (!areSharedAlarmsAvailable()) {
        setAlarmStatusMessage("Shared alarms need connected room sync.", "warn");
        updateUi();
        return;
      }
      alarmFormState.shared = !alarmFormState.shared;
      renderAlarmForm();
    });

    elements.alarmEnabled.addEventListener("click", () => {
      alarmFormState.enabled = !alarmFormState.enabled;
      renderAlarmForm();
    });

    elements.alarmOneTime.addEventListener("click", () => {
      alarmFormState.oneTime = !alarmFormState.oneTime;
      renderAlarmForm();
    });

    elements.alarmSave.addEventListener("click", () => {
      queueAlarmWork(async () => {
        await saveAlarmFromForm();
        setAlarmStatusMessage("Alarm saved.", "ok");
        updateUi();
      });
    });

    elements.alarmCancel.addEventListener("click", () => {
      resetAlarmForm();
    });

    elements.dismissAlarm.addEventListener("click", () => {
      queueAlarmWork(async () => {
        await dismissActiveAlarms();
        setAlarmStatusMessage("Alarm dismissed.", "ok");
        updateUi();
      });
    });

    if (elements.frameTimeZone) {
      elements.frameTimeZone.addEventListener("change", () => {
        const nextTimeZone = elements.frameTimeZone.value;
        queueAlarmWork(async () => {
          await applyFrameTimeZoneSelection(nextTimeZone);
          updateUi();
        });
      });
    }

    elements.alarmList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-alarm-action]");
      if (!button) {
        return;
      }

      const scope = button.dataset.alarmScope === "shared" ? "shared" : "local";
      const alarmId = (button.dataset.alarmId || "").trim();
      const action = (button.dataset.alarmAction || "").trim();
      const alarm = getCombinedAlarms().find((entry) => entry.id === alarmId && entry.scope === scope);

      if (!alarm) {
        return;
      }

      if (action === "edit") {
        setAlarmFormFromAlarm(alarm);
        return;
      }

      if (action === "disable" || action === "enable") {
        queueAlarmWork(async () => {
          await toggleAlarmEnabled(scope, alarmId);
          setAlarmStatusMessage(action === "disable" ? "Alarm paused." : "Alarm enabled.", "ok");
          updateUi();
        });
        return;
      }

      if (action === "delete") {
        queueAlarmWork(async () => {
          await deleteAlarm(scope, alarmId);
          setAlarmStatusMessage("Alarm deleted.", "ok");
          updateUi();
        });
      }
    });
  }

  async function handleStateChange(nextState) {
    musicState = normalizeState(nextState || buildDefaultState());

    if (isSharedMusicMode() && (!musicState.leaderDeviceId || isCoordinatorStale(musicState))) {
      await claimLeadership();
      return;
    }

    updateUi();

    if (isCoordinatorFor(musicState)) {
      startHeartbeat();
    } else {
      stopHeartbeat();
    }

    startReconcileTimer();
    queueReconcile();
  }

  async function init(syncContext) {
    document.documentElement.dataset.sannyMusicInit = "started";
    ctx = syncContext;
    ensureAlarmDayButtons();
    await initializeAlarmStores();

    wireControls();
    startFrameClock();
    startLeadershipMonitor();
    startAlarmScheduler();
    window.addEventListener("sanny:frame-timezone-changed", (event) => {
      const nextTimeZone = event && event.detail ? event.detail.timeZone : "";
      queueAlarmWork(async () => {
        await applyFrameTimeZoneSelection(nextTimeZone);
        updateUi();
      });
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        scheduleAlarmEvaluation(0);
      }
    });

    musicStore = ctx.createStore("music", {
      scope: ctx.syncMusicEnabled ? "shared" : "local"
    });

    try {
      const initialState = await musicStore.get();
      if (!initialState) {
        await musicStore.set(buildDefaultState());
      } else {
        const normalizedInitialState = normalizeState(initialState);
        const upgradedInitialState =
          isSharedMusicMode()
            ? withDefaultPlaylist(normalizedInitialState)
            : withAutoplay(withDefaultPlaylist(normalizedInitialState));

        if (JSON.stringify(upgradedInitialState) !== JSON.stringify(normalizedInitialState)) {
          const nextState = {
            ...upgradedInitialState,
            actor: ctx.deviceId,
            updatedAt: now(),
            leaderDeviceId: isSharedMusicMode()
              ? upgradedInitialState.leaderDeviceId || ctx.deviceId
              : "",
            leaderHeartbeatAt: isSharedMusicMode()
              ? upgradedInitialState.leaderHeartbeatAt || now()
              : 0
          };
          await musicStore.set(nextState);
        }
      }

      musicStore.subscribe((nextState) => {
        handleStateChange(nextState).catch((error) => {
          console.error("[music] state update failed:", error);
          setMusicLabel(error.message || "Music sync failed.", true);
        });
      });
    } catch (error) {
      console.error("[music] init failed:", error);
      setMusicLabel(error.message || "Music sync failed.", true);
    }

    updateUi();
    scheduleAlarmEvaluation(0);
    document.documentElement.dataset.sannyMusicInit = "ready";
  }

  function cacheElements() {
    elements.title = document.getElementById("music-title");
    elements.queue = document.getElementById("music-queue");
    elements.mute = document.getElementById("btn-mute");
    elements.prev = document.getElementById("btn-prev");
    elements.toggle = document.getElementById("btn-toggle");
    elements.next = document.getElementById("btn-next");
    elements.shuffle = document.getElementById("btn-shuffle");
    elements.volume = document.getElementById("music-volume");
    elements.volumeValue = document.getElementById("music-volume-value");
    elements.input = document.getElementById("playlist-url");
    elements.load = document.getElementById("load-playlist");
    elements.playlist = document.getElementById("music-playlist");
    elements.nextAlarmSummary = document.getElementById("next-alarm-summary");
    elements.alarmStatus = document.getElementById("alarm-status");
    elements.dismissAlarm = document.getElementById("dismiss-alarm");
    elements.alarmTime = document.getElementById("alarm-time");
    elements.alarmDays = document.getElementById("alarm-days");
    elements.alarmShared = document.getElementById("alarm-shared");
    elements.alarmEnabled = document.getElementById("alarm-enabled");
    elements.alarmOneTime = document.getElementById("alarm-one-time");
    elements.alarmSave = document.getElementById("alarm-save");
    elements.alarmCancel = document.getElementById("alarm-cancel");
    elements.alarmSharedNote = document.getElementById("alarm-shared-note");
    elements.alarmList = document.getElementById("alarm-list");
    elements.frameTimeDisplay = document.getElementById("frame-time-display");
    elements.frameTimeZone = document.getElementById("frame-timezone");
    elements.frameTimeZoneNote = document.getElementById("frame-timezone-note");
  }

  function beginWhenSyncReady() {
    if (!window.SannySync) {
      console.error("[music] Sync layer not found");
      return;
    }

    window.SannySync.onReady(init);
  }

  function bootstrap() {
    if (bootstrapped) {
      return;
    }

    document.documentElement.dataset.sannyMusicBootstrap = "started";
    cacheElements();
    if (!elements.title || !elements.alarmDays || !elements.alarmSave) {
      console.error("[music] Missing required DOM elements for music/alarm UI");
      document.documentElement.dataset.sannyMusicBootstrap = "missing-elements";
      return;
    }

    bootstrapped = true;
    document.documentElement.dataset.sannyMusicBootstrap = "ready";

    if (window.SannySync) {
      beginWhenSyncReady();
      return;
    }

    let attempts = 0;
    const retryTimer = window.setInterval(() => {
      attempts += 1;
      if (window.SannySync) {
        window.clearInterval(retryTimer);
        beginWhenSyncReady();
        return;
      }

      if (attempts >= 40) {
        window.clearInterval(retryTimer);
        console.error("[music] Sync layer not found");
      }
    }, 250);
  }

  window.SannyMusicBootstrap = bootstrap;

  bootstrap();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
    window.addEventListener("load", bootstrap, { once: true });
  } else {
    bootstrap();
  }

  window.addEventListener("pageshow", () => {
    bootstrap();
  });
})();
