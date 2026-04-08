# File Map

This file explains which files matter, what each one is for, and which ones are legacy or support-only.

## Top-Level Runtime Files

| Path | Role | Notes |
| --- | --- | --- |
| `app.py` | Main Flask entry point | Current server entry point for the whole app |
| `drive_sync_photos.py` | Google Drive sync engine | Rewrites `album.json` and local image cache |
| `music_player.py` | Local audio engine | Wraps `yt-dlp` + `mpv` |
| `network_setup.py` | Wi-Fi setup controller | Talks to NetworkManager through `nmcli` |
| `album.json` | Canonical album manifest | Preferred source of slideshow truth |
| `device.env.example` | Device config template | Copy to `device.env` for actual deployments |
| `README.md` | Main project readme | High-level setup and operation notes |

## Credentials And Auth

| Path | Role | Notes |
| --- | --- | --- |
| `creds/drive_auth_local.py` | One-time OAuth helper | Generates or refreshes `creds/token.json` |
| `creds/client_id.json` | OAuth client secret input | Needed by Drive auth helper |
| `creds/token.json` | Generated OAuth token | Not always committed; should exist on deployed devices |

## Frontend Scripts

| Path | Role | Notes |
| --- | --- | --- |
| `static/js/firebase.js` | Sync abstraction | Chooses Firebase shared mode vs local fallback |
| `static/js/album.js` | Slideshow app | Rendering, transitions, tray, Drive sync UI, sync behavior |
| `static/js/music.js` | Music app | Local music state and backend API control |
| `static/js/setup.js` | Setup overlay | Wi-Fi onboarding UI and polling |
| `static/js/presence.js` | Presence heartbeat | Tracks active devices in the room |
| `static/js/init.js` | Empty placeholder | Currently unused |

## Image Storage

| Path | Role | Notes |
| --- | --- | --- |
| `static/images/` | Primary runtime image directory | Main served local slideshow cache |
| `images/` | Legacy image fallback | Still served if a requested file exists there |

## Additional Runtime Artifacts

| Path | Role | Notes |
| --- | --- | --- |
| `ytdlp_cookies.txt` | Optional cookies for YouTube access | Used by `yt-dlp` when available |
| `ytdlp_cookies_old.txt` | Older cookie snapshot | Historical support file |
| `.drive_sync_index.json` | Incremental Drive sync index | Generated at runtime, location configurable |

## Virtual Environments

| Path | Role | Notes |
| --- | --- | --- |
| `env/` | Current preferred virtualenv | The docs and recent work standardize on this |
| `venv/` | Older virtualenv | Still present in repo, but not the preferred one |

## Legacy / Historical Files

| Path | Role | Notes |
| --- | --- | --- |
| `backup_app.py` | Older app variant | Not the primary runtime |
| `minimal_flask_app.py` | Minimal experiment | Not the primary runtime |
| `static/album.json` | Older manifest location | Current app prefers top-level `album.json` |
| `old/` | Historical snapshots | Useful only for archaeology or rollback ideas |
| `old_files/` | Historical helpers | Not part of the main runtime |

## Miscellaneous Repository Files

These are not part of the core runtime, but they appear in the repo:

- screenshot PNGs in the root
- `2025_hightower_1098.pdf`
- `__pycache__/` outputs

They should not be treated as application modules.

## Project Tree (Conceptual)

```text
sanny_photos/
├── app.py
├── drive_sync_photos.py
├── music_player.py
├── network_setup.py
├── album.json
├── device.env.example
├── creds/
│   ├── drive_auth_local.py
│   ├── client_id.json
│   └── token.json
├── static/
│   ├── images/
│   └── js/
│       ├── firebase.js
│       ├── album.js
│       ├── music.js
│       ├── setup.js
│       └── presence.js
├── images/              # legacy fallback
├── env/                 # preferred virtualenv
├── venv/                # older virtualenv
├── old/
└── old_files/
```

## Runtime Ownership Summary

### Primary active path

- browser -> `app.py`
- `app.py` -> `music_player.py`
- `app.py` -> `drive_sync_photos.py`
- `app.py` -> `network_setup.py`
- browser scripts -> Flask JSON routes

### Secondary / compatibility path

- `images/` top-level directory fallback
- `static/album.json` fallback if the top-level manifest is missing or unreadable

### Historical / not for normal development

- `backup_app.py`
- `minimal_flask_app.py`
- `old/`
- `old_files/`
