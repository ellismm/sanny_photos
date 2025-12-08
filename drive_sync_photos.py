"""
sync_photos.py
Fetches photos from a Google Drive folder and generates album.json
"""

import os, json, requests
from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials

# Set to True if you want to download the images locally
DOWNLOAD_IMAGES = True
LOCAL_PHOTO_DIR = "/home/messay/coding/own/sanny_photos/static/images"
ALBUM_JSON_PATH = "/home/messay/coding/own/sanny_photos/static/album.json"

# Folder name to sync
DRIVE_FOLDER_NAME = "Sanny Photos"

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

def get_drive_service():
    creds_path = "/home/messay/coding/own/sanny_photos/creds/token.json"
    creds = Credentials.from_authorized_user_file(creds_path, SCOPES)
    return build("drive", "v3", credentials=creds)

def find_folder_id(service, name):
    q = f"mimeType='application/vnd.google-apps.folder' and name='{name}' and trashed=false"
    results = service.files().list(q=q, fields="files(id, name)").execute()
    items = results.get("files", [])
    if not items:
        raise RuntimeError(f"Folder '{name}' not found.")
    return items[0]["id"]

def list_images_in_folder(service, folder_id):
    q = f"'{folder_id}' in parents and mimeType contains 'image/' and trashed=false"
    results = service.files().list(q=q, fields="files(id, name, mimeType)").execute()
    return results.get("files", [])

def download_image(service, file_id, name):
    request = service.files().get_media(fileId=file_id)
    local_path = os.path.join(LOCAL_PHOTO_DIR, name)
    os.makedirs(LOCAL_PHOTO_DIR, exist_ok=True)
    with open(local_path, "wb") as f:
        downloader = requests.get(f"https://drive.google.com/uc?export=download&id={file_id}")
        f.write(downloader.content)
    return f"images/{name}"

def sync_drive_photos():
    service = get_drive_service()
    folder_id = find_folder_id(service, DRIVE_FOLDER_NAME)
    files = list_images_in_folder(service, folder_id)

    album = []
    for f in files:
        if DOWNLOAD_IMAGES:
            rel_path = download_image(service, f["id"], f["name"])
        else:
            rel_path = f"https://drive.google.com/uc?export=view&id={f['id']}"
        album.append({"url": rel_path})

    with open(ALBUM_JSON_PATH, "w") as out:
        json.dump({"images": album}, out, indent=2)
    print(f"✅ Synced {len(album)} photos to {ALBUM_JSON_PATH}")

def main():
    sync_drive_photos()

if __name__ == "__main__":
    main()
