# Sanny Photos Docs

This directory is the structured reference for the current `Sanny Photos` codebase.

It is organized to answer a few different kinds of questions:

- "What is this project and how does it work?"
- "Which files actually matter at runtime?"
- "Which module owns which behavior?"
- "What data shapes and HTTP APIs does the app use?"
- "How do I deploy and operate it on a frame device?"

## Reading Order

If you are new to the project, start here:

1. [System Overview](./architecture/system-overview.md)
2. [Runtime Flows](./architecture/runtime-flows.md)
3. [File Map](./reference/file-map.md)
4. [Data Models](./reference/data-models.md)
5. [API Reference](./reference/api.md)
6. [Function Map](./reference/function-map.md)
7. [Function Call Map](./reference/function-call-map.md)
8. [Deployment And Operations](./guides/deployment-and-ops.md)

## Current Product Summary

Sanny Photos is a Linux-based photo-frame appliance built around:

- `Flask` as the local web server
- an inline single-page browser UI for slideshow and setup
- `mpv` for room-synced music playback on each device
- `yt-dlp` for YouTube playlist resolution and audio caching
- `Firebase Realtime Database` for cross-network slideshow sync
- `Google Drive API` for manual photo sync
- `NetworkManager` and `nmcli` for first-boot Wi-Fi setup

## Runtime Entry Points

The current active runtime starts here:

- [`app.py`](../app.py): main Flask app and HTML shell
- [`music_player.py`](../music_player.py): local audio playback controller
- [`drive_sync_photos.py`](../drive_sync_photos.py): Drive sync pipeline
- [`network_setup.py`](../network_setup.py): Wi-Fi setup/hotspot controller

Support files:

- [`album.json`](../album.json): canonical slideshow manifest
- [`device.env.example`](../device.env.example): per-device environment template
- [`creds/drive_auth_local.py`](../creds/drive_auth_local.py): one-time OAuth helper
- [`static/js/album.js`](../static/js/album.js): slideshow frontend
- [`static/js/music.js`](../static/js/music.js): music frontend
- [`static/js/firebase.js`](../static/js/firebase.js): sync abstraction
- [`static/js/setup.js`](../static/js/setup.js): Wi-Fi setup overlay
- [`static/js/presence.js`](../static/js/presence.js): presence heartbeat

## Legacy And Non-Primary Files

These exist in the repo but are not the main current runtime:

- [`backup_app.py`](../backup_app.py)
- [`minimal_flask_app.py`](../minimal_flask_app.py)
- [`static/album.json`](../static/album.json)
- [`static/js/init.js`](../static/js/init.js)
- `old/`, `old_files/`, and the older `venv/`

Those are documented in the [File Map](./reference/file-map.md) so it is clearer what is current versus historical.
