import logging
import os
import shutil
import socket
import subprocess
import threading
import time


LOGGER = logging.getLogger(__name__)


def _env_flag(name, default=False):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def _split_nmcli_fields(line):
    fields = []
    current = []
    escape = False

    for char in line:
        if escape:
            current.append(char)
            escape = False
            continue

        if char == "\\":
            escape = True
            continue

        if char == ":":
            fields.append("".join(current))
            current = []
            continue

        current.append(char)

    fields.append("".join(current))
    return fields


class NetworkSetupManager:
    def __init__(self, port):
        self.port = int(port)
        self.lock = threading.RLock()
        self.boot_started_at = time.time()
        self.last_activity_at = self.boot_started_at
        self.hotspot_started_at = 0.0
        self.hotspot_snoozed = False
        self.cached_networks = []
        self.last_scan_at = 0.0
        self.last_error = ""
        self.nmcli_path = shutil.which(os.environ.get("SANNY_NMCLI_PATH", "nmcli"))
        self.enabled = _env_flag("SANNY_SETUP_ENABLED", True) and bool(self.nmcli_path)
        self.grace_seconds = max(5, int(os.environ.get("SANNY_SETUP_GRACE_SECONDS", "15")))
        self.hotspot_idle_seconds = max(
            60, int(os.environ.get("SANNY_SETUP_IDLE_SECONDS", str(30 * 60)))
        )
        self.hotspot_connection_name = os.environ.get(
            "SANNY_SETUP_CONNECTION_NAME", "sanny-setup-hotspot"
        ).strip() or "sanny-setup-hotspot"
        self.setup_host = os.environ.get("SANNY_SETUP_HOST", "192.168.4.1").strip() or "192.168.4.1"
        self.setup_ssid = self._build_setup_ssid()

    def _build_setup_ssid(self):
        prefix = os.environ.get("SANNY_SETUP_SSID_PREFIX", "Sanny Setup").strip() or "Sanny Setup"
        hostname = socket.gethostname().strip() or "frame"
        suffix = hostname.replace(" ", "-")[-4:] or "frame"
        return f"{prefix} {suffix}"

    def _touch_activity(self):
        self.last_activity_at = time.time()

    def _run_nmcli(self, *args, check=True, timeout=30):
        if not self.nmcli_path:
            raise RuntimeError("NetworkManager is not available on this device.")

        result = subprocess.run(
            [self.nmcli_path, "-t", *args],
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )

        if check and result.returncode != 0:
            stderr = (result.stderr or "").strip()
            stdout = (result.stdout or "").strip()
            message = stderr or stdout or "nmcli command failed"
            raise RuntimeError(message)

        return result

    def _get_wifi_device(self):
        result = self._run_nmcli("-f", "DEVICE,TYPE,STATE", "device", "status")

        preferred_device = ""
        fallback_device = ""
        for raw_line in result.stdout.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            parts = _split_nmcli_fields(line)
            if len(parts) < 3:
                continue
            device, device_type, state = parts[:3]
            if device_type != "wifi":
                continue
            if state in {"connected", "connecting", "disconnected"}:
                preferred_device = device
                break
            if not fallback_device:
                fallback_device = device

        return preferred_device or fallback_device

    def _get_active_wifi(self):
        result = self._run_nmcli("-f", "ACTIVE,SSID", "device", "wifi", "list", "--rescan", "no", check=False)
        for raw_line in result.stdout.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            parts = _split_nmcli_fields(line)
            if len(parts) < 2:
                continue
            active, ssid = parts[:2]
            if active.lower() == "yes":
                return True, ssid

        device_status = self._run_nmcli("-f", "TYPE,STATE,CONNECTION", "device", "status", check=False)
        for raw_line in device_status.stdout.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            parts = _split_nmcli_fields(line)
            if len(parts) < 3:
                continue
            device_type, state, connection = parts[:3]
            if device_type == "wifi" and state in {"connected", "connecting"} and connection:
                return True, connection

        return False, ""

    def _get_connectivity(self):
        result = self._run_nmcli("-f", "CONNECTIVITY", "general", "status", check=False)
        value = (result.stdout or "").strip().splitlines()
        if value:
            return value[0].strip().lower()
        return "unknown"

    def _is_hotspot_active(self):
        result = self._run_nmcli("-f", "NAME,TYPE", "connection", "show", "--active", check=False)
        for raw_line in result.stdout.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            parts = _split_nmcli_fields(line)
            if len(parts) < 2:
                continue
            name, connection_type = parts[:2]
            if name == self.hotspot_connection_name and connection_type in {
                "802-11-wireless",
                "wifi",
            }:
                return True
        return False

    def _scan_networks_now(self, rescan):
        args = ["-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list"]
        if rescan:
            args.extend(["--rescan", "yes"])
        else:
            args.extend(["--rescan", "no"])

        result = self._run_nmcli(*args, check=False)
        networks = []
        seen = set()

        for raw_line in result.stdout.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            parts = _split_nmcli_fields(line)
            while len(parts) < 3:
                parts.append("")
            ssid, signal, security = parts[:3]
            ssid = ssid.strip()
            if not ssid or ssid in seen:
                continue
            seen.add(ssid)
            try:
                signal_value = int(signal)
            except (TypeError, ValueError):
                signal_value = 0
            networks.append(
                {
                    "ssid": ssid,
                    "signal": signal_value,
                    "security": security.strip() or "open",
                }
            )

        networks.sort(key=lambda item: (-item["signal"], item["ssid"].lower()))
        self.cached_networks = networks
        self.last_scan_at = time.time()
        return networks

    def list_networks(self, rescan=True):
        with self.lock:
            self._touch_activity()
            if not self.enabled:
                return []

            hotspot_active = self._is_hotspot_active()
            if hotspot_active and self.cached_networks:
                return list(self.cached_networks)

            try:
                return self._scan_networks_now(rescan=rescan and not hotspot_active)
            except Exception as exc:
                self.last_error = str(exc)
                LOGGER.warning("Could not list Wi-Fi networks: %s", exc)
                return list(self.cached_networks)

    def enable_hotspot(self):
        with self.lock:
            self._touch_activity()
            self.hotspot_snoozed = False
            if not self.enabled:
                raise RuntimeError("Wi-Fi setup is not available on this device.")

            if self._is_hotspot_active():
                if not self.hotspot_started_at:
                    self.hotspot_started_at = time.time()
                return self.status(manage=False)

            wifi_device = self._get_wifi_device()
            if not wifi_device:
                raise RuntimeError("No Wi-Fi adapter was found for setup mode.")

            try:
                self._scan_networks_now(rescan=True)
            except Exception as exc:
                LOGGER.warning("Network scan before hotspot start failed: %s", exc)

            self._run_nmcli("device", "disconnect", wifi_device, check=False)
            self._run_nmcli("connection", "delete", self.hotspot_connection_name, check=False)
            self._run_nmcli(
                "connection",
                "add",
                "type",
                "wifi",
                "ifname",
                wifi_device,
                "con-name",
                self.hotspot_connection_name,
                "autoconnect",
                "no",
                "ssid",
                self.setup_ssid,
            )
            self._run_nmcli(
                "connection",
                "modify",
                self.hotspot_connection_name,
                "802-11-wireless.mode",
                "ap",
                "802-11-wireless.band",
                "bg",
                "ipv4.method",
                "shared",
                "ipv6.method",
                "ignore",
            )
            self._run_nmcli("connection", "up", self.hotspot_connection_name)
            self.hotspot_started_at = time.time()
            return self.status(manage=False)

    def disable_hotspot(self):
        with self.lock:
            self._touch_activity()
            if not self.enabled:
                return self.status(manage=False)

            self._run_nmcli("connection", "down", self.hotspot_connection_name, check=False)
            self.hotspot_started_at = 0.0
            return self.status(manage=False)

    def connect(self, ssid, password=""):
        with self.lock:
            self._touch_activity()
            if not self.enabled:
                raise RuntimeError("Wi-Fi setup is not available on this device.")

            ssid = (ssid or "").strip()
            password = password or ""
            if not ssid:
                raise RuntimeError("SSID is required.")

            wifi_device = self._get_wifi_device()
            if not wifi_device:
                raise RuntimeError("No Wi-Fi adapter was found for setup mode.")

            self._run_nmcli("connection", "down", self.hotspot_connection_name, check=False)

            args = ["device", "wifi", "connect", ssid, "ifname", wifi_device]
            if password:
                args.extend(["password", password])

            result = self._run_nmcli(*args, check=False, timeout=45)
            if result.returncode != 0:
                stderr = (result.stderr or "").strip()
                stdout = (result.stdout or "").strip()
                message = stderr or stdout or f"Could not connect to {ssid}."
                self.last_error = message
                raise RuntimeError(message)

            connected = False
            current_ssid = ""
            for _ in range(12):
                time.sleep(1)
                wifi_connected, current_ssid = self._get_active_wifi()
                if wifi_connected and current_ssid == ssid:
                    connected = True
                    break

            if not connected:
                wifi_connected, current_ssid = self._get_active_wifi()
                connected = wifi_connected and current_ssid == ssid

            if connected:
                self.hotspot_started_at = 0.0
                self.hotspot_snoozed = False
                self.last_error = ""
            else:
                self.last_error = f"Connected profile was created, but the device did not finish joining {ssid}."

            try:
                self._scan_networks_now(rescan=False)
            except Exception:
                pass

            status = self.status(manage=True)
            status["connected"] = connected
            status["currentSsid"] = current_ssid or status.get("currentSsid", "")
            return status

    def status(self, manage=True):
        with self.lock:
            hotspot_active = False
            wifi_connected = False
            current_ssid = ""
            connectivity = "unknown"
            error = self.last_error

            if self.enabled:
                try:
                    hotspot_active = self._is_hotspot_active()
                    wifi_connected, current_ssid = self._get_active_wifi()
                    connectivity = self._get_connectivity()
                except Exception as exc:
                    error = str(exc)
                    self.last_error = error
                    LOGGER.warning("Could not read NetworkManager status: %s", exc)
            else:
                error = "NetworkManager setup is not available."

            internet_reachable = connectivity in {"full", "limited"}
            waiting_for_setup = time.time() - self.boot_started_at < self.grace_seconds

            if manage and self.enabled:
                connected_enough = wifi_connected or internet_reachable

                if connected_enough:
                    self.hotspot_snoozed = False
                    if not hotspot_active:
                        self.hotspot_started_at = 0.0
                elif hotspot_active and self.hotspot_started_at:
                    idle_for = time.time() - max(self.hotspot_started_at, self.last_activity_at)
                    if idle_for >= self.hotspot_idle_seconds:
                        self._run_nmcli("connection", "down", self.hotspot_connection_name, check=False)
                        hotspot_active = False
                        self.hotspot_started_at = 0.0
                        self.hotspot_snoozed = True
                elif not waiting_for_setup and not self.hotspot_snoozed:
                    try:
                        self.enable_hotspot()
                        hotspot_active = True
                    except Exception as exc:
                        error = str(exc)
                        self.last_error = error
                        LOGGER.warning("Could not enable setup hotspot: %s", exc)

            if internet_reachable:
                mode = "online"
            elif wifi_connected:
                mode = "connected"
            elif hotspot_active:
                mode = "setup"
            elif waiting_for_setup:
                mode = "waiting"
            else:
                mode = "offline"

            return {
                "mode": mode,
                "wifiConnected": wifi_connected,
                "internetReachable": internet_reachable,
                "hotspotActive": hotspot_active,
                "currentSsid": current_ssid,
                "setupSsid": self.setup_ssid,
                "setupUrl": f"http://{self.setup_host}:{self.port}",
                "roomId": os.environ.get("SANNY_ROOM_ID", "sanny-photos"),
                "lastError": error,
            }
