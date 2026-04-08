// static/js/setup.js
(function () {
  const config = window.SANNY_CONFIG || {};
  const pollIntervalMs = 8000;
  const keyboardLayouts = {
    alpha: [
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
      ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
      ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
      [
        { key: "shift", label: "Shift", className: "wide" },
        "z", "x", "c", "v", "b", "n", "m",
        { key: "backspace", label: "Back", className: "wide" }
      ],
      [
        { key: "mode", label: "123#", className: "wide" },
        { key: "space", label: "Space", className: "space" },
        ".", "@", "-",
        { key: "clear", label: "Clear", className: "wide" }
      ]
    ],
    symbol: [
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
      ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"],
      ["-", "_", "=", "+", "/", "?", ":", ";", ","],
      [
        { key: "mode", label: "ABC", className: "wide" },
        ".", "'", "\"", "\\", "[", "]",
        { key: "backspace", label: "Back", className: "wide" }
      ],
      [
        { key: "hide", label: "Hide", className: "wide" },
        { key: "space", label: "Space", className: "space" },
        { key: "clear", label: "Clear", className: "wide" }
      ]
    ]
  };

  const elements = {};
  let statusTimer = null;
  let statusState = null;
  let busy = false;
  let overlayPinnedOpen = false;
  let overlayManuallyClosed = false;
  let keyboardTarget = null;
  let keyboardMode = "alpha";
  let keyboardShift = false;

  function setBusy(nextBusy) {
    busy = Boolean(nextBusy);
    elements.refresh.disabled = busy;
    elements.connect.disabled = busy;
    elements.hotspotToggle.disabled = busy;
    if (elements.keyboardHide) {
      elements.keyboardHide.disabled = busy;
    }
  }

  function setBanner(text, tone) {
    elements.banner.textContent = text;
    elements.banner.classList.remove("status-danger", "status-ok", "status-warn");
    if (tone) {
      elements.banner.classList.add(tone);
    }
  }

  function openSetupOverlay(options) {
    const pinned = !options || options.pinned !== false;
    if (pinned) {
      overlayPinnedOpen = true;
      overlayManuallyClosed = false;
    }
    if (statusState) {
      renderStatus(statusState);
    }
  }

  function hideSetupOverlay() {
    overlayPinnedOpen = false;
    overlayManuallyClosed = true;
    closeKeyboard();
    if (statusState) {
      renderStatus(statusState);
    }
  }

  async function fetchJSON(url, options) {
    const response = await fetch(url, {
      cache: "no-store",
      ...(options || {})
    });
    return response.json();
  }

  function renderNetworks(networks) {
    const items = Array.isArray(networks) ? networks : [];
    if (!items.length) {
      elements.networkList.innerHTML = '<div class="meta">No nearby networks were found yet. You can still type the Wi-Fi name manually.</div>';
      return;
    }

    elements.networkList.innerHTML = "";
    items.forEach((network) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "network-option";
      button.innerHTML = `<strong>${network.ssid}</strong><span>${network.signal || 0}% signal • ${network.security || "open"}</span>`;
      button.addEventListener("click", () => {
        elements.ssidInput.value = network.ssid || "";
        openKeyboardFor(elements.passwordInput);
      });
      elements.networkList.appendChild(button);
    });
  }

  function renderStatus(status) {
    statusState = status || null;
    const setupSsid = (status && status.setupSsid) || config.setupHotspotSsid || "Sanny Setup";
    const setupUrl = (status && status.setupUrl) || config.setupUrl || "http://192.168.4.1";
    const currentSsid = (status && status.currentSsid) || "";
    const wifiConnected = Boolean(status && status.wifiConnected);
    const internetReachable = Boolean(status && status.internetReachable);
    const hotspotActive = Boolean(status && status.hotspotActive);
    const mode = (status && status.mode) || "offline";
    const trulyOffline = !wifiConnected && !internetReachable;
    const autoOverlay = trulyOffline && (mode === "setup" || mode === "waiting" || mode === "offline");

    if (!overlayPinnedOpen && !overlayManuallyClosed && autoOverlay) {
      overlayPinnedOpen = true;
    }

    const showOverlay = overlayPinnedOpen;

    elements.shell.classList.toggle("visible", showOverlay);
    elements.shell.setAttribute("aria-hidden", showOverlay ? "false" : "true");
    elements.ssid.textContent = setupSsid;
    elements.url.textContent = setupUrl;
    elements.hotspotToggle.textContent = hotspotActive ? "Close Setup Wi-Fi" : "Open Setup Wi-Fi";
    elements.close.disabled = !showOverlay;

    if (!showOverlay) {
      closeKeyboard();
    }

    if (internetReachable && !wifiConnected && !hotspotActive) {
      setBanner("This frame is online, but Wi-Fi status is ambiguous. Setup mode is available if you need it.", "status-ok");
    } else if (!wifiConnected && mode === "waiting") {
      setBanner("Checking for a saved Wi-Fi network. If nothing is found, setup mode will open automatically.", "status-warn");
    } else if (hotspotActive) {
      setBanner(`Join ${setupSsid} on your phone and open ${setupUrl}.`, "status-warn");
    } else if (wifiConnected) {
      setBanner(`Connected to ${currentSsid || "Wi-Fi"}. This frame is ready.`, "status-ok");
    } else if (status && status.lastError) {
      setBanner(status.lastError, "status-danger");
    } else {
      setBanner("This frame is offline. Open setup Wi-Fi to connect it to a home network.", "status-warn");
    }

    elements.meta.textContent = [
      `Room: ${(status && status.roomId) || config.roomId || "sanny-photos"}`,
      `Current Wi-Fi: ${currentSsid || "not connected"}`,
      `Internet: ${status && status.internetReachable ? "reachable" : "not reachable"}`
    ].join(" • ");
  }

  async function pollStatus() {
    try {
      const status = await fetchJSON("/setup/status");
      renderStatus(status);
      if ((!statusState || !statusState.wifiConnected) && elements.networkList.childElementCount <= 1) {
        scanNetworks(false);
      }
    } catch (error) {
      setBanner(error.message || "Could not read setup status.", "status-danger");
    }
  }

  async function scanNetworks(forceRescan) {
    try {
      const result = await fetchJSON(`/setup/networks?rescan=${forceRescan ? "1" : "0"}`);
      renderNetworks(result.networks);
      if (!result.ok && result.error) {
        setBanner(result.error, "status-danger");
      }
    } catch (error) {
      setBanner(error.message || "Could not scan Wi-Fi networks.", "status-danger");
    }
  }

  async function connectToWifi() {
    const ssid = (elements.ssidInput.value || "").trim();
    const password = elements.passwordInput.value || "";
    if (!ssid) {
      setBanner("Enter the Wi-Fi name first.", "status-danger");
      openKeyboardFor(elements.ssidInput);
      return;
    }

    setBusy(true);
    setBanner(`Connecting to ${ssid}...`, "status-warn");

    try {
      const result = await fetchJSON("/setup/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid, password })
      });

      if (!result.ok || !result.connected) {
        throw new Error(result.error || `Could not connect to ${ssid}.`);
      }

      closeKeyboard();
      setBanner(`Connected to ${result.currentSsid || ssid}. Reloading the frame...`, "status-ok");
      window.setTimeout(() => {
        window.location.reload();
      }, 1800);
    } catch (error) {
      setBanner(error.message || "Could not connect to Wi-Fi.", "status-danger");
    } finally {
      setBusy(false);
    }
  }

  async function toggleHotspot(enabled) {
    setBusy(true);
    try {
      const result = await fetchJSON("/setup/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled })
      });

      if (!result.ok) {
        throw new Error(result.error || "Could not change setup Wi-Fi.");
      }

      await pollStatus();
      if (enabled) {
        await scanNetworks(false);
      }
    } catch (error) {
      setBanner(error.message || "Could not change setup Wi-Fi.", "status-danger");
    } finally {
      setBusy(false);
    }
  }

  function insertIntoInput(input, text) {
    if (!input) {
      return;
    }

    input.focus({ preventScroll: true });
    const start = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
    const end = typeof input.selectionEnd === "number" ? input.selectionEnd : input.value.length;

    if (typeof input.setRangeText === "function") {
      input.setRangeText(text, start, end, "end");
    } else {
      input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
    }

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function backspaceInput(input) {
    if (!input) {
      return;
    }

    input.focus({ preventScroll: true });
    const start = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
    const end = typeof input.selectionEnd === "number" ? input.selectionEnd : input.value.length;

    if (typeof input.setRangeText === "function") {
      if (start !== end) {
        input.setRangeText("", start, end, "end");
      } else if (start > 0) {
        input.setRangeText("", start - 1, start, "end");
      }
    } else if (start !== end) {
      input.value = `${input.value.slice(0, start)}${input.value.slice(end)}`;
    } else if (start > 0) {
      input.value = `${input.value.slice(0, start - 1)}${input.value.slice(start)}`;
    }

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function renderKeyboard() {
    if (!elements.keyboard || !elements.keyboardKeys) {
      return;
    }

    const visible = Boolean(keyboardTarget);
    elements.keyboard.hidden = !visible;
    if (!visible) {
      elements.keyboardKeys.replaceChildren();
      return;
    }

    const targetLabel = keyboardTarget === elements.passwordInput ? "Wi-Fi password keyboard" : "Wi-Fi name keyboard";
    elements.keyboardTitle.textContent = targetLabel;
    elements.keyboardKeys.replaceChildren();

    const rows = keyboardLayouts[keyboardMode] || keyboardLayouts.alpha;
    rows.forEach((row) => {
      const rowEl = document.createElement("div");
      rowEl.className = "setup-keyboard-row";
      rowEl.style.setProperty("--setup-key-count", String(row.length));
      rowEl.style.setProperty("--setup-key-count-mobile", String(Math.min(row.length, 5)));

      row.forEach((entry) => {
        const descriptor = typeof entry === "string"
          ? { key: entry, label: keyboardShift && keyboardMode === "alpha" ? entry.toUpperCase() : entry, className: "" }
          : entry;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `setup-key ${descriptor.className || ""}`.trim();
        button.dataset.key = descriptor.key;
        button.textContent = descriptor.label;

        if (
          (descriptor.key === "shift" && keyboardShift) ||
          (descriptor.key === "mode" && keyboardMode === "symbol")
        ) {
          button.classList.add("is-active");
        }

        button.addEventListener("click", () => {
          handleKeyboardPress(descriptor.key);
        });
        rowEl.appendChild(button);
      });

      elements.keyboardKeys.appendChild(rowEl);
    });
  }

  function openKeyboardFor(target) {
    keyboardTarget = target || null;
    overlayPinnedOpen = true;
    overlayDismissedUntil = 0;
    renderKeyboard();
    if (statusState) {
      renderStatus(statusState);
    }
  }

  function closeKeyboard() {
    keyboardTarget = null;
    keyboardMode = "alpha";
    keyboardShift = false;
    renderKeyboard();
  }

  function handleKeyboardPress(key) {
    if (!keyboardTarget) {
      return;
    }

    if (key === "shift") {
      keyboardShift = !keyboardShift;
      renderKeyboard();
      return;
    }

    if (key === "mode") {
      keyboardMode = keyboardMode === "alpha" ? "symbol" : "alpha";
      keyboardShift = false;
      renderKeyboard();
      return;
    }

    if (key === "backspace") {
      backspaceInput(keyboardTarget);
      return;
    }

    if (key === "clear") {
      keyboardTarget.value = "";
      keyboardTarget.dispatchEvent(new Event("input", { bubbles: true }));
      keyboardTarget.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (key === "space") {
      insertIntoInput(keyboardTarget, " ");
      return;
    }

    if (key === "hide") {
      closeKeyboard();
      return;
    }

    const nextValue = keyboardShift && keyboardMode === "alpha" ? key.toUpperCase() : key;
    insertIntoInput(keyboardTarget, nextValue);
    if (keyboardShift && keyboardMode === "alpha") {
      keyboardShift = false;
      renderKeyboard();
    }
  }

  function wireEvents() {
    elements.refresh.addEventListener("click", () => {
      openSetupOverlay();
      scanNetworks(true);
    });

    elements.connect.addEventListener("click", () => {
      openSetupOverlay();
      connectToWifi();
    });

    elements.hotspotToggle.addEventListener("click", () => {
      openSetupOverlay();
      const shouldEnable = !(statusState && statusState.hotspotActive);
      toggleHotspot(shouldEnable);
    });

    elements.close.addEventListener("click", () => {
      hideSetupOverlay();
    });

    elements.keyboardHide.addEventListener("click", () => {
      closeKeyboard();
    });

    elements.passwordInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        connectToWifi();
      }
    });

    elements.ssidInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        connectToWifi();
      }
    });

    elements.ssidInput.addEventListener("focus", () => {
      openSetupOverlay();
      openKeyboardFor(elements.ssidInput);
    });
    elements.passwordInput.addEventListener("focus", () => {
      openSetupOverlay();
      openKeyboardFor(elements.passwordInput);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideSetupOverlay();
      }
    });

    if (elements.trayOpen) {
      elements.trayOpen.addEventListener("click", () => {
        openSetupOverlay();
        toggleHotspot(true);
      });
    }
  }

  function startPolling() {
    if (statusTimer) {
      window.clearInterval(statusTimer);
    }
    statusTimer = window.setInterval(() => {
      pollStatus();
    }, pollIntervalMs);
  }

  window.addEventListener("load", () => {
    elements.shell = document.getElementById("setup-shell");
    elements.banner = document.getElementById("setup-banner");
    elements.meta = document.getElementById("setup-meta");
    elements.ssid = document.getElementById("setup-ssid");
    elements.url = document.getElementById("setup-url");
    elements.networkList = document.getElementById("setup-network-list");
    elements.ssidInput = document.getElementById("setup-ssid-input");
    elements.passwordInput = document.getElementById("setup-password");
    elements.refresh = document.getElementById("setup-refresh");
    elements.connect = document.getElementById("setup-connect");
    elements.hotspotToggle = document.getElementById("setup-hotspot-toggle");
    elements.close = document.getElementById("setup-close");
    elements.trayOpen = document.getElementById("wifi-setup");
    elements.keyboard = document.getElementById("setup-keyboard");
    elements.keyboardTitle = document.getElementById("setup-keyboard-title");
    elements.keyboardKeys = document.getElementById("setup-keyboard-keys");
    elements.keyboardHide = document.getElementById("setup-keyboard-hide");

    if (!config.setupEnabled || !elements.shell) {
      if (elements.trayOpen) {
        elements.trayOpen.style.display = "none";
      }
      return;
    }

    wireEvents();
    pollStatus();
    startPolling();
  });
})();
