# Data Models

This file documents the key JSON shapes and configuration concepts used by the app.

## 1. Album Manifest

Primary file:

- `album.json`

Shape:

```json
{
  "version": 2,
  "images": [
    {
      "url": "images/abc123.jpg",
      "caption": "A favorite memory",
      "driveFileId": "1AbCdEf..."
    }
  ]
}
```

Fields:

- `version`: manifest format version
- `images`: ordered slideshow items
- `url`: local path or remote URL
- `caption`: optional text shown over the image
- `driveFileId`: Drive identifier used for sync and fingerprinting

## 2. Album Response From `/album.json`

The Flask route returns a normalized version of the manifest:

```json
{
  "version": 2,
  "title": "Sanny Photos",
  "fingerprint": "stable-library-hash",
  "images": [
    {
      "id": "img-0001",
      "url": "images/abc123.jpg",
      "caption": "",
      "driveFileId": "1AbCdEf..."
    }
  ]
}
```

Additional server-added fields:

- `title`: app title for the frontend
- `fingerprint`: stable hash for the currently loaded album
- `id`: frontend-friendly image identifier

## 3. Shared / Local Slideshow State

Used by `album.js` through local storage or Firebase.

Shape:

```json
{
  "currentIndex": 0,
  "isPlaying": true,
  "startedAt": 1710000000000,
  "slideDurationMs": 10000,
  "order": [0, 1, 2, 3],
  "actor": "dev_ab12cd34",
  "updatedAt": 1710000005000,
  "manifestVersion": 2
}
```

Fields:

- `currentIndex`: sequence position, not raw image array index after shuffle
- `isPlaying`: slideshow paused/running flag
- `startedAt`: timestamp used to derive the currently visible slide
- `slideDurationMs`: per-slide duration
- `order`: mapping from sequence order to actual image index
- `actor`: last device to change state
- `updatedAt`: last write timestamp
- `manifestVersion`: local album generation marker

## 4. Library Metadata State

Used to decide whether a frame can participate in shared slideshow sync.

Shape:

```json
{
  "libraryFingerprint": "fingerprint-string",
  "count": 90,
  "updatedAt": 1710000005000,
  "updatedBy": "dev_ab12cd34"
}
```

Fields:

- `libraryFingerprint`: stable identity of the current local photo library
- `count`: image count
- `updatedAt`: last published timestamp
- `updatedBy`: publishing device ID

## 5. Music State

Used by `music.js` through the shared room store when `syncMusic` is enabled, and through local storage when it is disabled.

Shape:

```json
{
  "playlistUrl": "https://www.youtube.com/playlist?...",
  "playlistLength": 42,
  "order": [0, 1, 2, 3],
  "shuffleEnabled": true,
  "currentOrderIndex": 0,
  "currentTrackIndex": 0,
  "isPlaying": true,
  "trackStartedAt": 1710000000000,
  "pausedTrackOffsetMs": 0,
  "trackTitle": "Current Song",
  "leaderDeviceId": "dev_ab12cd34",
  "leaderHeartbeatAt": 1710000005000,
  "actor": "dev_ab12cd34",
  "updatedAt": 1710000005000
}
```

Important notes:

- `order` is the shared queue order for the room.
- `shuffleEnabled` applies to the whole room, not each device separately.
- `trackStartedAt` and `pausedTrackOffsetMs` let late joiners compute the current shared song position without per-second database writes.
- `leaderDeviceId` and `leaderHeartbeatAt` now represent the room music coordinator, not the only device that is allowed to play.

## 6. Presence State

Used by `presence.js`.

Shape:

```json
{
  "dev_ab12cd34": {
    "online": true,
    "lastSeen": 1710000005000
  }
}
```

## 7. Drive Sync Index

Default path:

- `.drive_sync_index.json`

Shape:

```json
{
  "version": 1,
  "folderId": "drive-folder-id",
  "images": {
    "drive-file-id": {
      "fileId": "drive-file-id",
      "name": "IMG_1234.JPG",
      "mimeType": "image/jpeg",
      "modifiedTime": "2026-03-19T00:00:00.000Z",
      "fileName": "drive-file-id.jpg",
      "url": "images/drive-file-id.jpg",
      "maxEdge": 1920,
      "quality": 85,
      "format": "jpeg"
    }
  },
  "settings": {
    "downloadImages": true,
    "maxEdge": 1920,
    "quality": 85,
    "format": "jpeg"
  }
}
```

Purpose:

- remembers what was downloaded before
- lets future syncs skip unchanged Drive files
- invalidates cached images if display settings change

## 8. Sync Status Response

Returned by `GET /sync/status`.

Shape:

```json
{
  "ok": true,
  "running": false,
  "count": 90,
  "changed": true,
  "lastSuccessAt": "2026-03-19T12:34:56.000000+00:00",
  "lastError": "",
  "libraryFingerprint": "local-fingerprint",
  "roomLibraryFingerprint": "room-fingerprint",
  "inSyncWithRoom": true
}
```

## 9. Setup Status Response

Returned by `GET /setup/status`.

Shape:

```json
{
  "mode": "online",
  "wifiConnected": true,
  "internetReachable": true,
  "hotspotActive": false,
  "currentSsid": "HomeWiFi",
  "setupSsid": "Sanny Setup ame1",
  "setupUrl": "http://192.168.4.1:5002",
  "roomId": "sanny-photos",
  "lastError": ""
}
```

Modes:

- `waiting`
- `setup`
- `offline`
- `connected`
- `online`

## 10. Health Response

Returned by `GET /healthz`.

Shape:

```json
{
  "ok": true,
  "albumCount": 90,
  "musicRunning": true,
  "lastSyncAt": "2026-03-19T12:34:56.000000+00:00"
}
```

## 11. Device Environment Variables

The app reads `device.env` through `load_env_file()` in `app.py`.

Most important variables:

| Variable | Meaning |
| --- | --- |
| `PORT` | Flask port, usually `5002` |
| `SANNY_IMAGES_DIR` | Local image directory |
| `SANNY_ALBUM_PATH` | Canonical album path |
| `SANNY_GOOGLE_TOKEN_PATH` | Drive OAuth token path |
| `SANNY_DEFAULT_SLIDE_DURATION_MS` | Default slideshow timing |
| `SANNY_DEFAULT_PLAYLIST_URL` | Default music playlist |
| `SANNY_ROOM_ID` | Shared room identifier |
| `SANNY_FIREBASE_*` | Firebase web config values |
| `SANNY_IMAGE_MAX_EDGE` | Local slideshow derivative max edge |
| `SANNY_IMAGE_QUALITY` | Derivative quality |
| `SANNY_SYNC_INDEX_PATH` | Optional custom path for sync index |
| `SANNY_SETUP_ENABLED` | Enable or disable Wi-Fi setup flow |
| `SANNY_SETUP_SSID_PREFIX` | Hotspot SSID prefix |
| `SANNY_MPV_*` | `mpv`-related runtime tuning |
| `SANNY_AUDIO_CACHE_DIR` | Local audio cache directory |

## 12. Fingerprinting Strategy

Two related fingerprints exist in the app:

### Album fingerprint

- calculated from ordered images in the local manifest
- exposed at `/album.json`
- used by backend and frontend sync status logic

### Room library fingerprint

- published through the shared `library` store
- used to decide whether a frame can trust the shared slideshow state

If the room fingerprint and local fingerprint differ:

- the frame keeps showing its local album
- it stops following room slideshow state
- the tray warns the operator to run `Sync Now`
