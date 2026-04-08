# Function Call Map

This file is the visual companion to [Function Map](./function-map.md).

Instead of listing functions one by one, it shows how important functions call into each other during real runtime paths.

Because the project has several subsystems, the diagrams are split into smaller maps instead of one unreadable giant graph.

## How To Read These Diagrams

- Boxes are functions or methods
- Arrows show the usual call direction
- The diagrams focus on important runtime paths, not every tiny helper
- Some Flask routes are grouped by behavior so the visuals stay useful

## 1. Backend Composition In `app.py`

```mermaid
flowchart TD
    A[load_env_file] --> B[Flask app setup]
    B --> C[MPVPlayer()]
    B --> D[NetworkSetupManager()]
    B --> E[get_sync_status]
    E --> F[refresh_local_sync_snapshot]
    F --> G[load_album_manifest]
    G --> H[_read_json]
    G --> I[_normalize_album_entry]
    G --> J[_scan_images_directory]
    G --> K[compute_album_fingerprint]
```

## 2. Page Render Call Map

This is the path used when the browser requests `/`.

```mermaid
flowchart TD
    R0[index route] --> R1[render_index]
    R1 --> R2[build_client_config]
    R2 --> R3[build_firebase_config]
    R2 --> R4[network_setup.enabled/setup_host/setup_ssid]
    R1 --> R5[build_firebase_sdk_html]
    R1 --> R6[inline HTML shell]
```

## 3. Album Manifest And Image Serving

```mermaid
flowchart TD
    A0[GET /album.json] --> A1[load_album_manifest]
    A1 --> A2[_read_json]
    A1 --> A3[_normalize_album_entry]
    A1 --> A4[_scan_images_directory]
    A1 --> A5[compute_album_fingerprint]

    B0[GET /images/<filename>] --> B1[image_file]
    B1 --> B2[send_from_directory IMAGES_DIR]
    B1 --> B3[send_from_directory LEGACY_IMAGES_DIR]
```

## 4. Setup Route Call Map

```mermaid
flowchart TD
    S0[GET /setup/status] --> S1[network_setup.status]

    S2[GET /setup/networks] --> S3[network_setup.list_networks]

    S4[POST /setup/connect] --> S5[network_setup.connect]
    S5 --> S6[_get_wifi_device]
    S5 --> S7[_run_nmcli]
    S5 --> S8[_get_active_wifi]
    S5 --> S1

    S9[POST /setup/hotspot] --> S10{enabled?}
    S10 -->|true| S11[network_setup.enable_hotspot]
    S10 -->|false| S12[network_setup.disable_hotspot]
    S11 --> S6
    S11 --> S7
    S11 --> S1
    S12 --> S7
    S12 --> S1
```

## 5. Sync Route Call Map

```mermaid
flowchart TD
    X0[GET /sync/status] --> X1[get_sync_status]
    X1 --> X2[refresh_local_sync_snapshot]
    X2 --> X3[load_album_manifest]

    X4[POST /sync/room-meta] --> X5[cache room fingerprint flags]
    X5 --> X1

    X6[POST /sync/drive] --> X7[sync_drive route handler]
    X7 --> X8[sync_drive_photos]
    X8 --> X9[compute_album_fingerprint]
    X7 --> X1

    X10[GET /healthz] --> X11[healthz]
    X11 --> X3
    X11 --> X12[player.status]
    X11 --> X1
```

## 6. Music Route Call Map

```mermaid
flowchart TD
    M0[POST /music/playlist] --> M1[player.load_playlist]
    M0 --> M2[player.play_index]
    M0 --> M3[player.status]

    M4[POST /music/play_cached] --> M2
    M4 --> M3

    M5[POST /music/next] --> M6[player.next_track]
    M6 --> M2
    M5 --> M3

    M7[POST /music/prev] --> M8[player.prev_track]
    M8 --> M2
    M7 --> M3

    M9[POST /music/pause] --> M10[player.set_pause]
    M9 --> M3

    M11[POST /music/toggle] --> M12[player.toggle_pause]
    M12 --> M3

    M13[POST /music/mute] --> M14[player.mute]
    M13 --> M3

    M15[POST /music/stop] --> M16[player.stop]
    M17[GET /music/status] --> M3
```

## 7. `drive_sync_photos.py` Main Call Graph

This is the most important backend call chain for large photo libraries.

```mermaid
flowchart TD
    D0[sync_drive_photos] --> D1[get_drive_service]
    D0 --> D2[find_folder_id]
    D0 --> D3[list_images_in_folder]
    D0 --> D4[load_album_payload]
    D0 --> D5[load_existing_caption_lookup]
    D5 --> D4

    D0 --> D6{DOWNLOAD_IMAGES?}
    D6 -->|false| D7[build_remote_album_payload]
    D7 --> D8[commit_sync_metadata]
    D7 --> D9[compute_album_fingerprint]

    D6 -->|true| D10[load_sync_index]
    D0 --> D11[loop Drive files]
    D11 --> D12[build_local_path]
    D11 --> D13[build_album_url]
    D11 --> D14[needs_local_refresh]
    D14 -->|yes| D15[sync_local_image]
    D15 --> D16[download_image]
    D15 --> D17[write_display_derivative]
    D17 --> D18[normalize_for_display]
    D11 --> D19[build_index_entry]

    D0 --> D20[commit_sync_metadata]
    D0 --> D21[collect_migrated_legacy_files]
    D0 --> D22[remove_local_paths]
    D0 --> D9
```

## 8. `music_player.py` Call Graph

```mermaid
flowchart TD
    P0[load_playlist] --> P1[_build_playlist_ydl_opts]
    P1 --> P2[_build_ydl_opts]
    P0 --> P3[YoutubeDL.extract_info]

    P4[play_index] --> P5[_download_track_file]
    P5 --> P2
    P5 --> P6[YoutubeDL.extract_info download]
    P5 --> P7[_cleanup_cache]
    P4 --> P8[_start_mpv]
    P8 --> P9[stop]
    P8 --> P10[_remove_stale_socket]
    P8 --> P11[_build_mpv_command]
    P8 --> P12[_wait_for_ipc]
    P8 --> P13[_safe_set_property]

    P14[next_track] --> P4
    P15[prev_track] --> P4
    P16[toggle_pause] --> P17[status]
    P16 --> P18[set_pause]
    P19[mute] --> P13
    P9 --> P20[_mpv_command quit]
    P17 --> P21[_get_property]
    P21 --> P22[_mpv_command]
    P22 --> P23[_mpv_ipc_request]
```

## 9. `network_setup.py` Call Graph

```mermaid
flowchart TD
    N0[list_networks] --> N1[_is_hotspot_active]
    N0 --> N2[_scan_networks_now]
    N2 --> N3[_run_nmcli]

    N4[enable_hotspot] --> N5[_get_wifi_device]
    N4 --> N2
    N4 --> N3
    N4 --> N6[status]

    N7[disable_hotspot] --> N3
    N7 --> N6

    N8[connect] --> N5
    N8 --> N3
    N8 --> N9[_get_active_wifi]
    N8 --> N2
    N8 --> N6

    N6 --> N1
    N6 --> N9
    N6 --> N10[_get_connectivity]
    N6 --> N4
```

## 10. Frontend Boot Call Map

This shows how the browser-side modules come online after the page loads.

```mermaid
flowchart TD
    F0[window load] --> F1[firebase.js initFirebaseMode]
    F1 --> F2[flushReadyCallbacks]

    F2 --> F3[setup.js init]
    F2 --> F4[presence.js init]
    F2 --> F5[album.js init]
    F2 --> F6[music.js init]

    F5 --> F7[fetchAlbum]
    F5 --> F8[createStore album_local]
    F5 --> F9[createStore album]
    F5 --> F10[createStore library]
    F5 --> F11[fetchSyncStatus]

    F6 --> F12[createStore music]
    F6 --> F13[handleStateChange]
    F6 --> F14[wireControls]
```

## 11. `album.js` Main Call Graph

```mermaid
flowchart TD
    A0[init] --> A1[fetchAlbum]
    A0 --> A2[localAlbumStore.subscribe]
    A0 --> A3[sharedAlbumStore.subscribe]
    A0 --> A4[libraryStore.subscribe]
    A0 --> A5[fetchSyncStatus]
    A0 --> A6[wireControls]
    A0 --> A7[startRenderLoop]

    A2 --> A8[handleLocalAlbumState]
    A3 --> A9[handleSharedAlbumState]
    A4 --> A10[handleLibraryState]

    A8 --> A11[applyDisplayedState]
    A9 --> A11
    A10 --> A12[ensureRoomLibrarySeeded]
    A10 --> A13[maybeSeedSharedAlbumState]
    A10 --> A11

    A11 --> A14[normalizeState]
    A11 --> A15[render]
    A15 --> A16[getRenderedImage]
    A15 --> A17[showImage]
    A17 --> A18[pickTransition]
    A18 --> A19[getTransitionDurationMs]
    A17 --> A20[applyEnterTransition]
    A17 --> A21[applyExitTransition]
```

## 12. `album.js` User Interaction Call Map

```mermaid
flowchart TD
    U0[next/prev/play/pause/shuffle/change duration] --> U1[wireControls handlers]
    U1 --> U2[goToRelative]
    U1 --> U3[setPlaying]
    U1 --> U4[shuffleSlides]
    U1 --> U5[setDurationFromSeconds]

    U2 --> U6[commitState]
    U3 --> U6
    U4 --> U6
    U5 --> U6

    U6 --> U7[activeAlbumStore]
    U6 --> U8[localAlbumStore.set]
    U7 --> U9[sharedAlbumStore or localAlbumStore]
```

## 13. `album.js` Drive Sync UI Call Map

```mermaid
flowchart TD
    G0[Sync Now button] --> G1[runDriveSync]
    G1 --> G2[POST /sync/drive]
    G1 --> G3[fetch /album.json via refreshAlbumState]
    G3 --> G4[buildStateForAlbum]
    G1 --> G5[localAlbumStore.set]

    G1 --> G6{shared sync enabled?}
    G6 -->|yes| G7[publishLibraryFingerprint]
    G7 --> G8[libraryStore.set]
    G7 --> G9[cacheRoomMetaStatus]

    G6 -->|yes and in sync| G10[sharedAlbumStore.set]
```

## 14. `music.js` Call Graph

```mermaid
flowchart TD
    J0[init] --> J1[createStore music]
    J0 --> J2[buildDefaultState / withDefaultPlaylist / withAutoplay]
    J0 --> J3[musicStore.subscribe]
    J0 --> J4[wireControls]
    J0 --> J5[startLeadershipMonitor]

    J3 --> J6[handleStateChange]
    J6 --> J7[updateUi]
    J6 --> J8[queueReconcile]
    J8 --> J9[reconcileMusicPlayer]

    J9 --> J10[GET /music/status]
    J9 --> J11[POST /music/playlist]
    J9 --> J12[POST /music/play_cached]
    J9 --> J13[POST /music/pause]
    J9 --> J14[POST /music/mute]

    J4 --> J15[mutateState]
    J15 --> J16[musicStore.set]
```

## 15. Cross-Module Runtime Path

This is the shortest useful end-to-end "big picture" function map.

```mermaid
flowchart LR
    Browser[Browser UI]
    AlbumJS[album.js]
    MusicJS[music.js]
    SetupJS[setup.js]
    Flask[app.py routes]
    DriveSync[drive_sync_photos.py]
    MusicPlayer[music_player.py]
    NetSetup[network_setup.py]

    Browser --> AlbumJS
    Browser --> MusicJS
    Browser --> SetupJS

    AlbumJS --> Flask
    MusicJS --> Flask
    SetupJS --> Flask

    Flask --> DriveSync
    Flask --> MusicPlayer
    Flask --> NetSetup
```

## Practical Reading Advice

If you want to understand the code in a useful order:

1. Start with the backend overview maps above for `app.py`.
2. Then read the `album.js` call graphs, because slideshow behavior is the heart of the product.
3. Then read `drive_sync_photos.py` and `music_player.py`, because those are the two big integration engines.
4. Use the non-visual [Function Map](./function-map.md) afterward when you need exact names and responsibilities.
