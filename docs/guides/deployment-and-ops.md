# Deployment And Operations

This guide is the practical "how to run and maintain it" view of the project.

## 1. Local Development Setup

### Create the preferred virtualenv

```bash
python3 -m venv env
./env/bin/pip install flask google-api-python-client google-auth google-auth-oauthlib requests yt-dlp pillow
```

System packages commonly needed on Linux frames:

```bash
sudo apt install -y mpv network-manager chromium-browser
```

## 2. Per-Device Config

Create a real `device.env` from the example:

```bash
cp device.env.example device.env
```

Typical values to set:

- `PORT=5002`
- `SANNY_ROOM_ID=...`
- `SANNY_IMAGES_DIR=...`
- `SANNY_ALBUM_PATH=...`
- `SANNY_GOOGLE_TOKEN_PATH=...`
- all `SANNY_FIREBASE_*` values

Optional large-library tuning:

- `SANNY_IMAGE_MAX_EDGE=1920`
- `SANNY_IMAGE_QUALITY=85`
- `SANNY_SYNC_INDEX_PATH=...`

## 3. Google Drive Auth

Run once on a machine with a browser:

```bash
./env/bin/python creds/drive_auth_local.py
```

That creates `creds/token.json`, which can then be copied to frame devices.

## 4. Running The App

Start the backend:

```bash
./env/bin/python app.py
```

Open:

```text
http://127.0.0.1:5002
```

## 5. Linux Frame Deployment

### Recommended user service

Use a `systemd --user` service like:

```ini
[Unit]
Description=Sanny Photos

[Service]
Type=simple
WorkingDirectory=/home/me/slideshow
EnvironmentFile=/home/me/slideshow/device.env
ExecStart=/home/me/slideshow/env/bin/python /home/me/slideshow/app.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

### Recommended Chromium kiosk launch

```bash
chromium \
  --kiosk \
  --incognito \
  --no-first-run \
  --password-store=basic \
  --user-data-dir=/home/me/.config/sanny-chromium \
  http://127.0.0.1:5002
```

That avoids keyring prompts and gives the device a dedicated kiosk browser profile.

## 6. Two-Frame Cross-Network Setup

To mirror the slideshow across two homes:

- use the same Firebase config on both devices
- use the same `SANNY_ROOM_ID`
- preload both devices with Drive auth token and playlist defaults
- keep `syncSlides=true`
- keep `syncMusic=true`

Current behavior:

- slideshow sync is shared
- music playlist/timeline/shuffle are shared across the room
- audio still plays locally on each device
- Drive sync is still manual per device

## 7. First-Boot Gift / Handoff Flow

Recommended appliance flow:

1. You provision the device image and config.
2. You preload `device.env` and `creds/token.json`.
3. The recipient plugs in the frame.
4. If the device does not know the local Wi-Fi yet, it enters setup mode.
5. The screen shows a temporary `Sanny Setup ...` hotspot name and local setup URL.
6. They join that hotspot on a phone, choose their home Wi-Fi, and the frame reconnects automatically.

## 8. Common Operations

### Check backend health

```bash
curl http://127.0.0.1:5002/healthz
```

### Check sync status

```bash
curl http://127.0.0.1:5002/sync/status
```

### Check setup status

```bash
curl http://127.0.0.1:5002/setup/status
```

### Restart the user service

```bash
systemctl --user restart sanny-photos.service
```

### Tail service logs

```bash
journalctl --user -u sanny-photos.service -n 100 --no-pager
```

### Inspect current music status

```bash
curl http://127.0.0.1:5002/music/status
```

### Inspect mpv log

```bash
cat /tmp/sanny_mpv.log
```

## 9. Operational Risks To Know

### Large photo libraries

The project is now much better prepared for large libraries because:

- Drive sync is incremental
- local photo files are resized for display
- the sync index avoids full redownloads

What still grows with time:

- total number of on-device slideshow images
- total cycle time for the full album

The next likely scaling step is a "smart active rotation set" rather than showing the full archive every loop.

### Wi-Fi setup constraints

The setup flow assumes:

- Linux
- NetworkManager
- `nmcli`
- normal home Wi-Fi networks

It is not aimed at hotel or captive-portal Wi-Fi.

### Music playback dependencies

Music requires:

- working `mpv`
- working `yt-dlp`
- YouTube access that the device/network allows
- sometimes cookies when YouTube is stricter

## 10. Troubleshooting

### Blank white screen

Usually means one of:

- Chromium kiosk pointed at the wrong port
- Flask backend not running
- stale autostart/service from an older deployment

Checks:

```bash
systemctl --user status sanny-photos.service
curl http://127.0.0.1:5002/healthz
ps -ef | grep chromium | grep -v grep
```

### Setup overlay keeps appearing

Likely causes:

- device has no Wi-Fi connection
- hotspot auto-setup is active
- setup mode was not snoozed

Workarounds:

- `Esc` temporarily hides the overlay
- the tray has `Wi-Fi Setup`
- connect Wi-Fi through the overlay or `nmtui`

### Playlist loads but no sound

Checks:

```bash
curl http://127.0.0.1:5002/music/status
cat /tmp/sanny_mpv.log
which mpv
which yt-dlp
```

### Drive sync fails

Checks:

```bash
./env/bin/python -c "import googleapiclient, PIL; print('deps ok')"
ls -l creds/token.json
./env/bin/python creds/drive_auth_local.py
```

## 11. Recommended Near-Term Improvements

From an operations point of view, the next strong candidates are:

- active rotation subsets for very large libraries
- scheduled background sync windows
- thumbnail or preview support in the operator tray
- richer health reporting for Wi-Fi and Firebase reachability
