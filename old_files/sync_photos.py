#!/usr/bin/env python3
import os, sys, json, requests
from pathlib import Path
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request

# --------------------------------------------------------------------
# Paths and constants
# --------------------------------------------------------------------
BASE_DIR   = Path("/home/messay/coding/own/sanny_photos")
CREDS_DIR  = BASE_DIR / "creds"
IMAGES_DIR = BASE_DIR / "images"
ALBUM_JSON = BASE_DIR / "album.json"

CLIENT_SECRET_FILE = CREDS_DIR / "client_secret.json"
TOKEN_JSON         = CREDS_DIR / "token.json"

PHOTOS_API = "https://photoslibrary.googleapis.com/v1"
SCOPE      = "https://www.googleapis.com/auth/photoslibrary.readonly"

# --------------------------------------------------------------------
# Credentials handling
# --------------------------------------------------------------------
def get_credentials() -> Credentials:
    if not TOKEN_JSON.exists():
        sys.exit(f"Missing {TOKEN_JSON}. Run photos_auth_local.py first.")

    creds = Credentials.from_authorized_user_file(str(TOKEN_JSON), [SCOPE])
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            TOKEN_JSON.write_text(creds.to_json())
        else:
            sys.exit("Credentials invalid and no refresh token. Re-run auth.")
    return creds

# --------------------------------------------------------------------
# API helpers
# --------------------------------------------------------------------
def api_get(endpoint: str, creds: Credentials, params=None):
    url = f"{PHOTOS_API}/{endpoint}"
    headers = {"Authorization": f"Bearer {creds.token}"}
    r = requests.get(url, headers=headers, params=params)
    if r.status_code >= 400:
        print("GET error body:", r.text)
    r.raise_for_status()
    return r.json()

def api_post(endpoint: str, creds: Credentials, body=None):
    url = f"{PHOTOS_API}/{endpoint}"
    headers = {"Authorization": f"Bearer {creds.token}",
               "Content-Type": "application/json"}
    r = requests.post(url, headers=headers, json=body)
    if r.status_code >= 400:
        print("POST error body:", r.text)
    r.raise_for_status()
    return r.json()

# --------------------------------------------------------------------
# Album commands
# --------------------------------------------------------------------
def list_albums(creds: Credentials):
    albums, page_token = [], None
    while True:
        out = api_get("albums", creds, {"pageSize": 50, "pageToken": page_token})
        albums.extend(out.get("albums", []))
        page_token = out.get("nextPageToken")
        if not page_token:
            break
    return albums

def set_album(album_title: str):
    cfg = {"album_title": album_title}
    (CREDS_DIR / "config.json").write_text(json.dumps(cfg, indent=2))
    print("Album set:", album_title)

def get_album_title():
    cfg_file = CREDS_DIR / "config.json"
    if not cfg_file.exists():
        sys.exit("No album set. Use --set-album 'Album Name'")
    return json.loads(cfg_file.read_text())["album_title"]

def sync_album(creds: Credentials):
    album_title = get_album_title()
    # Find album id
    for a in list_albums(creds):
        if a["title"] == album_title:
            album_id = a["id"]
            break
    else:
        sys.exit(f"Album '{album_title}' not found")

    print(f"Syncing album: {album_title}")
    IMAGES_DIR.mkdir(exist_ok=True, parents=True)

    items, page_token = [], None
    while True:
        body = {"albumId": album_id, "pageSize": 50}
        if page_token:
            body["pageToken"] = page_token
        out = api_post("mediaItems:search", creds, body)
        items.extend(out.get("mediaItems", []))
        page_token = out.get("nextPageToken")
        if not page_token:
            break

    album_manifest = []
    for it in items:
        base_url, filename = it["baseUrl"], it["filename"]
        dest = IMAGES_DIR / filename
        if not dest.exists():
            url = base_url + "=d"  # full download
            r = requests.get(url, stream=True)
            if r.ok:
                with open(dest, "wb") as f:
                    for chunk in r.iter_content(8192):
                        f.write(chunk)
                print("Downloaded", filename)
            else:
                print("Failed to download", filename)
        album_manifest.append(filename)

    ALBUM_JSON.write_text(json.dumps(album_manifest, indent=2))
    print("Wrote album.json with", len(album_manifest), "items")

# --------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------
def main():
    if len(sys.argv) < 2:
        print("Usage: sync_photos.py --list-albums | --set-album 'Title' | --sync")
        sys.exit(1)

    creds = get_credentials()
    cmd = sys.argv[1]

    if cmd == "--list-albums":
        albums = list_albums(creds)
        for a in albums:
            print(a["title"], "(", a["id"], ")")
    elif cmd == "--set-album":
        if len(sys.argv) < 3:
            sys.exit("Need album title")
        set_album(sys.argv[2])
    elif cmd == "--sync":
        sync_album(creds)
    else:
        sys.exit("Unknown command: " + cmd)

if __name__ == "__main__":
    main()
