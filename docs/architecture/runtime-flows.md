# Runtime Flows

This file focuses on "how the system behaves over time" rather than just which files exist.

## 1. App Boot Flow

```mermaid
sequenceDiagram
    participant Device as Linux Device
    participant Flask as app.py
    participant Browser as Chromium
    participant Sync as firebase.js
    participant Album as album.js
    participant Music as music.js
    participant Setup as setup.js

    Device->>Flask: start app.py
    Flask->>Flask: load device.env
    Flask->>Flask: create MPVPlayer + NetworkSetupManager
    Browser->>Flask: GET /
    Flask-->>Browser: inline HTML + JS config
    Browser->>Sync: initialize sync layer
    Sync-->>Browser: local mode or Firebase mode
    Browser->>Setup: poll /setup/status
    Browser->>Album: fetch /album.json
    Browser->>Music: initialize room music state
    Album->>Flask: GET /sync/status
    Music->>Flask: GET /music/status
```

## 2. First-Boot Wi-Fi Setup Flow

```mermaid
sequenceDiagram
    participant Browser as Kiosk Browser
    participant SetupJS as setup.js
    participant Flask as app.py
    participant NetSetup as network_setup.py
    participant NM as NetworkManager
    participant Phone as User Phone

    SetupJS->>Flask: GET /setup/status
    Flask->>NetSetup: status()
    NetSetup->>NM: inspect Wi-Fi + hotspot status
    alt no saved Wi-Fi after grace period
        NetSetup->>NM: enable hotspot
        Flask-->>SetupJS: mode=setup, hotspotActive=true
        SetupJS-->>Browser: show overlay with SSID + setup URL
        Phone->>Flask: GET /setup/networks
        Flask->>NetSetup: list_networks()
        NetSetup->>NM: nmcli device wifi list
        Phone->>Flask: POST /setup/connect
        Flask->>NetSetup: connect(ssid, password)
        NetSetup->>NM: nmcli device wifi connect
        NM-->>NetSetup: connection result
        NetSetup-->>Flask: connected status
        Flask-->>Phone: ok=true
        SetupJS-->>Browser: reload frame UI
    end
```

## 3. Manual Google Drive Sync Flow

```mermaid
sequenceDiagram
    participant User as Operator Tray
    participant AlbumJS as album.js
    participant Flask as app.py
    participant DriveSync as drive_sync_photos.py
    participant Drive as Google Drive
    participant Files as album.json + images + sync index
    participant Firebase as Firebase library metadata

    User->>AlbumJS: Click "Sync Now"
    AlbumJS->>Flask: POST /sync/drive
    Flask->>DriveSync: sync_drive_photos()
    DriveSync->>Drive: list folder + photo metadata
    loop for each Drive image
        DriveSync->>DriveSync: compare against local sync index
        alt file changed or missing
            DriveSync->>Drive: download file
            DriveSync->>DriveSync: resize/compress derivative
            DriveSync->>Files: write local image
        else unchanged
            DriveSync->>DriveSync: reuse existing local file
        end
    end
    DriveSync->>Files: atomically write album.json
    DriveSync->>Files: atomically write .drive_sync_index.json
    DriveSync->>Files: remove deleted/migrated files
    Flask-->>AlbumJS: sync status JSON
    alt shared slideshow sync enabled
        AlbumJS->>Firebase: publish libraryFingerprint
    end
```

## 4. Cross-Network Slideshow Sync Flow

```mermaid
sequenceDiagram
    participant A as Frame A album.js
    participant Firebase as Firebase RTDB
    participant B as Frame B album.js

    A->>Firebase: write album state {currentIndex, startedAt, duration, order}
    Firebase-->>B: push new shared album state
    B->>B: compare room libraryFingerprint vs localFingerprint
    alt fingerprints match
        B->>B: apply shared album state
        B->>B: render same slide progression using serverNow()
    else fingerprints differ
        B->>B: ignore shared slideshow state
        B->>B: show warning in tray
    end
```

## 5. Shared Room Music Flow

```mermaid
sequenceDiagram
    participant User as Operator Tray
    participant MusicJS as music.js
    participant Firebase as Firebase RTDB
    participant Flask as app.py
    participant Player as music_player.py
    participant YTDLP as yt-dlp
    participant MPV as mpv

    User->>MusicJS: Load playlist URL
    MusicJS->>Firebase: write shared room playlist + timeline
    MusicJS->>Flask: POST /music/playlist
    Flask->>Player: load_playlist(url)
    Player->>YTDLP: extract playlist metadata
    Flask->>Player: play_index(startIndex)
    Player->>YTDLP: download audio track file
    Player->>MPV: start local file playback
    MusicJS->>Flask: GET /music/status
    Flask-->>MusicJS: running/paused/muted/current track/position
    Note over MusicJS,Firebase: Late-joining devices load the same playlist and seek into the current shared position.
```

## 6. Network Setup State Diagram

```mermaid
stateDiagram-v2
    [*] --> waiting
    waiting --> online: saved Wi-Fi connected + internet
    waiting --> connected: Wi-Fi connected, internet limited/unknown
    waiting --> setup: no Wi-Fi after grace period, hotspot enabled
    waiting --> offline: no Wi-Fi, hotspot not active

    setup --> connected: user joins home Wi-Fi
    setup --> online: user joins home Wi-Fi + internet reachable
    setup --> offline: hotspot disabled or setup failure

    connected --> online: internet becomes reachable
    connected --> setup: Wi-Fi lost, setup reopened
    online --> setup: Wi-Fi lost, hotspot reopened
    offline --> setup: hotspot enabled
```

## Key Runtime Concepts

### Shared slideshow state

The slideshow state includes:

- current sequence index
- whether playback is running
- start timestamp
- slide duration
- order/shuffle mapping
- manifest version

### Shared library metadata

The room-level library metadata is separate from slideshow position. It includes:

- `libraryFingerprint`
- `count`
- `updatedAt`
- `updatedBy`

This is what lets one frame detect that another frame has synced a different photo library.

### Local music state

Even when slideshow sync is enabled, music is intentionally local in the current device mode:

- each frame can autoplay music independently
- changing a song on one frame does not change it on another

### Incremental Drive sync

Drive sync no longer behaves like "redownload the entire folder every time." It now:

- tracks Drive file metadata in a local sync index
- regenerates local images only when files changed or cache settings changed
- stores display-sized files instead of full originals
