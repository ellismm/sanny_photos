# Sanny Photos

Sanny Photos is a Linux photo-frame appliance: Flask serves the fullscreen slideshow, `mpv` handles room-synced music playback on each device, Firebase mirrors slideshow and music state across frames, Google Drive provides the shared photo library, and NetworkManager powers first-boot Wi-Fi setup.

## What It Does

- Fullscreen slideshow with crossfades, captions, shuffle, adjustable slide timing, and hidden appliance controls.
- Cross-network mirrored slideshow when both frames share the same Firebase room.
- Shared room music playback with a shared playlist, direct track picking, shared shuffle order, and late-join seeking.
- Manual Google Drive sync into the local `album.json` and an optimized on-device `static/images/` library.
- Library mismatch detection: if one frame syncs new photos first, the other frame shows a warning and stops following the mirrored slideshow until it runs `Sync Now`.
- First-boot Wi-Fi setup for normal home networks using a temporary `Sanny Setup ...` hotspot and a phone-friendly setup page.

## Project Layout

```text
.
├── app.py                  # Main Flask server and appliance UI
├── music_player.py         # mpv-backed music controller
├── drive_sync_photos.py    # Google Drive -> album.json sync script
├── network_setup.py        # NetworkManager / nmcli setup-mode helper
├── album.json              # Canonical slideshow manifest
├── device.env.example      # Per-device runtime config template
├── creds/
│   └── drive_auth_local.py # One-time Google OAuth helper
└── static/
    ├── images/             # Slideshow images
    └── js/                 # Frontend logic
```

`app.py` is the only server entry point you should run for the current app.

## Album Format

The app treats [album.json](/home/messay/coding/own/sanny_photos/album.json) as the source of truth.

```json
{
  "version": 2,
  "images": [
    {
      "url": "images/IMG_2097.JPG",
      "caption": "",
      "driveFileId": "google-drive-file-id"
    }
  ]
}
```

- `url` can be `images/...`, `/images/...`, `/static/images/...`, or a full remote URL.
- Local `images/...` entries are served from `static/images/`, with legacy fallback support for the old top-level `images/` folder.
- The app exposes a stable `fingerprint` field at `/album.json` for library sync checks.

## Setup

### 1. Create the virtualenv and install dependencies

```bash
python3 -m venv env
./env/bin/pip install flask google-api-python-client google-auth google-auth-oauthlib requests yt-dlp pillow pillow-heif
sudo apt install -y mpv network-manager
```

This milestone assumes Linux with NetworkManager and `nmcli`.

`pillow-heif` is included so Google Drive sync can decode iPhone `HEIC` / `HEIF` photos too.

### 2. Create a per-device env file

```bash
cp device.env.example device.env
```

Fill in the Firebase values, shared room ID, Drive token path, and any local overrides. The app reads `device.env` automatically at startup.

For large libraries, you can tune the local display cache:

- `SANNY_IMAGE_MAX_EDGE` controls the longest edge of locally cached slideshow images. Default: `1920`
- `SANNY_IMAGE_QUALITY` controls JPEG/WebP output quality. Default: `85`
- `SANNY_SYNC_INDEX_PATH` optionally moves the incremental Drive sync index file
- `SANNY_SYNC_MUSIC` enables or disables shared room music sync. Default: `1`

### 3. Authenticate Google Drive once

```bash
./env/bin/python creds/drive_auth_local.py
```

That writes `creds/token.json` for later manual `Sync Now` runs on the frame.

### 4. Run the app

```bash
./env/bin/python app.py
```

Then open `http://localhost:5002`.

## Two-Frame Cross-Network Mode

For the two-frame setup you described:

- Put the same Firebase config on both devices.
- Give both devices the same `SANNY_ROOM_ID`.
- Preload the same Drive token and default playlist on both devices.
- Both frames will mirror slideshow state across different networks.
- Music now mirrors across both frames too: loading a playlist, play/pause, next/prev, and shuffle affect the whole room.
- Recurring alarms are local by default, with an explicit shared option when you want both frames to ring at the same instant.
- Google Drive sync stays manual per device in this version.

If one frame syncs Drive first, the other frame will show:

`Library changed on another frame. Run Sync Now to rejoin sync.`

That second frame keeps showing its local photos until it syncs and rejoins the room.

## First-Boot Wi-Fi Setup

If the device boots without a saved Wi-Fi connection:

- after a short grace period it enters setup mode
- it brings up a temporary hotspot like `Sanny Setup 1a2b`
- the frame display shows setup instructions
- from a phone, join that hotspot and open the local setup page shown on screen, usually `http://192.168.4.1:5002`
- pick the home Wi-Fi network, enter the password, and the frame will reconnect automatically

Notes:

- This version is designed for normal home Wi-Fi, not hotel/apartment captive portals.
- The setup hotspot auto-stops after a long idle period or after a successful Wi-Fi connection.
- You can reopen setup mode later from the tray with `Wi-Fi Setup`.

## Appliance Controls

- `Left` / `Right`: previous or next slide
- `Space`: pause or resume the slideshow
- `Controls` button: open the operator tray
- `S`: open or close the operator tray
- Touch swipe: move between slides
- Long-press the top-right corner for 2 seconds on touch devices to reveal the tray

The tray includes slideshow controls, shared room music controls, `Sync Now`, `Wi-Fi Setup`, and `Reload`.

## Runtime Endpoints

- `GET /healthz` -> `{ ok, albumCount, musicRunning, lastSyncAt }`
- `GET /sync/status` -> includes Drive sync state plus `libraryFingerprint`, `roomLibraryFingerprint`, and `inSyncWithRoom`
- `POST /sync/drive` -> runs manual Google Drive sync
- `GET /setup/status` -> current Wi-Fi/setup mode state
- `GET /setup/networks` -> visible or cached SSIDs
- `POST /setup/connect` -> connect to a Wi-Fi network
- `POST /setup/hotspot` -> open or close setup Wi-Fi
- `POST /music/seek` -> seek the local player to a shared room position

## Linux Appliance Setup

Use a per-user service for Flask and let it start even if the network is not ready yet.

Example `systemd --user` service:

```ini
[Unit]
Description=Sanny Photos

[Service]
Type=simple
WorkingDirectory=/home/me/coding/own/sanny_photos
EnvironmentFile=/home/me/coding/own/sanny_photos/device.env
ExecStart=/home/me/coding/own/sanny_photos/env/bin/python /home/me/coding/own/sanny_photos/app.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

Example browser autostart command:

```bash
chromium --kiosk --incognito http://127.0.0.1:5002
```

Put that browser command in your desktop environment's autostart settings or session startup script.

## Handoff Flow

Recommended gift/setup flow:

1. Provision the Linux image yourself.
2. Copy in `device.env`, `creds/token.json`, and any cookies or local runtime assets you want preloaded.
3. Set the same Firebase room on both devices.
4. Hand your girlfriend the device.
5. She plugs it in.
6. If the device does not already know her Wi-Fi, it opens setup mode and tells her exactly which hotspot to join and which local URL to open.
7. Once she enters her home Wi-Fi password, the frame reconnects and starts working automatically.

## Notes

- `backup_app.py` and `minimal_flask_app.py` are legacy references, not the main app.
- `static/album.json` may still exist from older versions, but the current app reads `album.json` first.
- Music playback depends on local `mpv` availability on each device.
- Shared music uses one room playlist/order/timeline, while mute remains local to each device.
- Drive sync now keeps a local sync index and downloads only changed photos, storing display-sized assets on-device instead of mirroring full originals every time.
- Tracks are cached locally before playback to avoid fragile direct YouTube stream URLs.
- The audio cache trims itself automatically: files older than 7 days are removed and the cache keeps at most the 20 most recent track files.
