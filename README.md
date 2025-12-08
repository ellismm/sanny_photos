# Open Slideshow

A modern, web-based photo slideshow app with music playback, Google Drive photo sync, and optional multi-device synchronization.

## Features

- **Photo Slideshow**: Displays images from a local album or synced from Google Drive, with smooth transitions and captions.
- **Music Playback**: Play background music (including YouTube audio) during your slideshow, with play/pause, mute, and track navigation.
- **Google Drive Sync**: Easily sync photos from a Google Drive folder to your local slideshow with a single script.
- **Multi-Device Sync (Optional)**: Use Firebase to synchronize slideshow state (current photo, play/pause, etc.) across multiple devices.
- **Responsive Web UI**: Touch-friendly, works on desktop and mobile, with keyboard and gesture controls.
- **Customizable**: Adjust slide duration, shuffle, and other settings via the web interface.

## Project Structure

```
slideshow/
├── app.py                # Main Flask web server
├── drive_sync_photos.py  # Script to sync photos from Google Drive
├── music_player.py       # Music playback controller (mpv-based)
├── album.json            # Album metadata (auto-generated)
├── static/
│   ├── album.json        # (symlink or copy of album.json)
│   └── images/           # Local images for the slideshow
├── creds/                # Google API credentials for Drive sync
└── ...
```

## Getting Started

### Prerequisites

- Python 3.7+
- [mpv](https://mpv.io/) media player (`sudo apt install -y mpv`)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube audio (`pip install yt-dlp`)
- Google API credentials for Drive sync (see below)
- (Optional) Firebase project for multi-device sync

### 1. Install Dependencies

```bash
pip install flask flask-cors google-api-python-client google-auth requests yt-dlp
sudo apt install -y mpv
```

### 2. Set Up Google Drive Sync (Optional)

- Place your Google API credentials in `creds/` (see [Google Drive API Python Quickstart](https://developers.google.com/drive/api/quickstart/python)).
- Run `drive_sync_photos.py` to fetch photos from your Drive folder and generate `album.json` and images.

```bash
python drive_sync_photos.py
```

### 3. Add Your Photos

- Place images in `static/images/` and update `album.json` with their URLs and optional captions.
- Or, use the Drive sync script as above.

### 4. Run the Slideshow App

```bash
python app.py
```

- Open [http://localhost:5000](http://localhost:5000) in your browser.

### 5. Music Playback

- Use the web UI to play/pause music, skip tracks, or mute.
- Supports YouTube URLs (audio only, via yt-dlp and mpv).

### 6. Multi-Device Sync (Optional)

- Fill in your Firebase config in the HTML (see `app.py`).
- Devices on the same Firebase room will stay in sync (current slide, play/pause, etc.).

## Usage

- Navigate slides with arrow keys, toolbar buttons, or touch gestures.
- Adjust slide duration and shuffle in settings.
- Add captions in `album.json` for each image.

## Credentials & Configuration

- **Google Drive**: Place `client_id.json` and `token.json` in `creds/`.
- **Firebase**: Edit the Firebase config in the HTML section of `app.py`.

## Troubleshooting

- If music playback fails, ensure `mpv` and `yt-dlp` are installed and in your PATH.
- For Google Drive sync, ensure your credentials are valid and the Drive folder exists.
- For multi-device sync, ensure your Firebase config is correct.

## License

MIT License

---

**Open Slideshow** is designed for home photo frames, events, and collaborative viewing. Enjoy your memories with music and seamless sync!
