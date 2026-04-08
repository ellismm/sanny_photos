"""Sync photos from Google Drive into the slideshow album manifest."""

import hashlib
import json
import logging
import os
import socket
import tempfile
import uuid
from pathlib import Path

try:
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseDownload
except ImportError:
    Credentials = None
    MediaIoBaseDownload = None
    build = None

try:
    from PIL import Image, ImageOps
except ImportError:
    Image = None
    ImageOps = None

try:
    from pillow_heif import register_heif_opener
except ImportError:
    register_heif_opener = None

try:
    import httplib2
except ImportError:
    httplib2 = None

try:
    from google_auth_httplib2 import AuthorizedHttp
except ImportError:
    AuthorizedHttp = None


ROOT = Path(__file__).resolve().parent
LOCAL_PHOTO_DIR = Path(os.environ.get("SANNY_IMAGES_DIR", ROOT / "static" / "images"))
ALBUM_JSON_PATH = Path(os.environ.get("SANNY_ALBUM_PATH", ROOT / "album.json"))
SYNC_INDEX_PATH = Path(
    os.environ.get("SANNY_SYNC_INDEX_PATH", ALBUM_JSON_PATH.parent / ".drive_sync_index.json")
)
CREDS_PATH = Path(os.environ.get("SANNY_GOOGLE_TOKEN_PATH", ROOT / "creds" / "token.json"))
DRIVE_FOLDER_NAME = os.environ.get("SANNY_DRIVE_FOLDER_NAME", "Sanny Photos")
DOWNLOAD_IMAGES = os.environ.get("SANNY_DOWNLOAD_IMAGES", "1").lower() not in {
    "0",
    "false",
    "no",
}
IMAGE_MAX_EDGE = max(640, int(os.environ.get("SANNY_IMAGE_MAX_EDGE", "1920")))
IMAGE_QUALITY = min(95, max(60, int(os.environ.get("SANNY_IMAGE_QUALITY", "85"))))
IMAGE_FORMAT = (os.environ.get("SANNY_IMAGE_FORMAT", "jpeg").strip().lower() or "jpeg")
if IMAGE_FORMAT not in {"jpeg", "jpg", "webp"}:
    IMAGE_FORMAT = "jpeg"
IMAGE_EXT = ".webp" if IMAGE_FORMAT == "webp" else ".jpg"
DRIVE_HTTP_TIMEOUT_SECONDS = max(
    15, int(os.environ.get("SANNY_DRIVE_HTTP_TIMEOUT_SECONDS", "90"))
)
DRIVE_DOWNLOAD_RETRIES = max(0, int(os.environ.get("SANNY_DRIVE_DOWNLOAD_RETRIES", "2")))
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

if Image is not None:
    if hasattr(Image, "Resampling"):
        RESAMPLE_FILTER = Image.Resampling.LANCZOS
    else:
        RESAMPLE_FILTER = Image.LANCZOS
else:
    RESAMPLE_FILTER = None

HEIF_SUPPORT_ENABLED = False
if Image is not None and register_heif_opener is not None:
    try:
        register_heif_opener()
        HEIF_SUPPORT_ENABLED = True
    except Exception as exc:
        logging.warning("Could not enable HEIF support: %s", exc)


def get_drive_service(token_path=None):
    if Credentials is None or MediaIoBaseDownload is None or build is None:
        raise RuntimeError(
            "Google Drive sync requires google-api-python-client in ./env. "
            "Run ./env/bin/pip install google-api-python-client."
        )

    token_path = Path(token_path or CREDS_PATH)
    if not token_path.exists():
        raise RuntimeError(
            "Google Drive auth is not set up. "
            "Run ./env/bin/python creds/drive_auth_local.py to create creds/token.json."
        )

    try:
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
    except Exception as exc:
        raise RuntimeError(
            "Google Drive auth token could not be read. "
            "Run ./env/bin/python creds/drive_auth_local.py to refresh creds/token.json."
        ) from exc

    if httplib2 is not None and AuthorizedHttp is not None:
        http = AuthorizedHttp(creds, http=httplib2.Http(timeout=DRIVE_HTTP_TIMEOUT_SECONDS))
        return build("drive", "v3", http=http, cache_discovery=False)

    socket.setdefaulttimeout(DRIVE_HTTP_TIMEOUT_SECONDS)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def require_image_pipeline():
    if DOWNLOAD_IMAGES and Image is None:
        raise RuntimeError(
            "Display-sized Drive sync requires Pillow in ./env. "
            "Run ./env/bin/pip install pillow."
        )


def find_folder_id(service, name):
    query = f"mimeType='application/vnd.google-apps.folder' and name='{name}' and trashed=false"
    results = service.files().list(q=query, fields="files(id, name)").execute()
    items = results.get("files", [])
    if not items:
        raise RuntimeError(f"Folder '{name}' not found.")
    return items[0]["id"]


def list_images_in_folder(service, folder_id):
    query = f"'{folder_id}' in parents and mimeType contains 'image/' and trashed=false"
    page_token = None
    files = []

    while True:
        results = (
            service.files()
            .list(
                q=query,
                fields="nextPageToken, files(id, name, mimeType, createdTime, modifiedTime)",
                orderBy="createdTime,name",
                pageToken=page_token,
                pageSize=1000,
            )
            .execute()
        )
        files.extend(results.get("files", []))
        page_token = results.get("nextPageToken")
        if not page_token:
            break

    return files


def load_json_payload(path, default):
    path = Path(path)
    if not path.exists():
        return default

    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except Exception:
        return default

    return payload if isinstance(payload, type(default)) else default


def load_album_payload(path=None):
    path = Path(path or ALBUM_JSON_PATH)
    payload = load_json_payload(path, {"version": 2, "images": []})

    if isinstance(payload, dict):
        payload.setdefault("version", 2)
        payload.setdefault("images", [])
        return payload

    if isinstance(payload, list):
        return {"version": 2, "images": payload}

    return {"version": 2, "images": []}


def load_sync_index(path=None):
    path = Path(path or SYNC_INDEX_PATH)
    payload = load_json_payload(
        path,
        {
            "version": 1,
            "images": {},
            "settings": {},
        },
    )

    if not isinstance(payload, dict):
        payload = {"version": 1, "images": {}, "settings": {}}

    if not isinstance(payload.get("images"), dict):
        payload["images"] = {}

    if not isinstance(payload.get("settings"), dict):
        payload["settings"] = {}

    return payload


def load_existing_caption_lookup(path=None):
    by_id = {}
    by_url = {}
    payload = load_album_payload(path)

    for entry in payload.get("images", []):
        normalized = normalize_album_entry(entry)
        if not normalized:
            continue
        if normalized["caption"]:
            if normalized["driveFileId"]:
                by_id[normalized["driveFileId"]] = normalized["caption"]
            by_url[normalized["url"]] = normalized["caption"]

    return {"by_id": by_id, "by_url": by_url}


def resolve_caption(lookup, file_id, url):
    return lookup["by_id"].get(file_id) or lookup["by_url"].get(url, "")


def normalize_album_entry(entry):
    if isinstance(entry, str):
        url = entry.strip()
        caption = ""
        drive_file_id = ""
    elif isinstance(entry, dict):
        url = (entry.get("url") or "").strip()
        caption = (entry.get("caption") or "").strip()
        drive_file_id = (entry.get("driveFileId") or "").strip()
    else:
        return None

    if not url:
        return None

    return {
        "url": url,
        "caption": caption,
        "driveFileId": drive_file_id,
    }


def compute_album_fingerprint(payload):
    if isinstance(payload, dict):
        raw_images = payload.get("images") or []
    elif isinstance(payload, list):
        raw_images = payload
    else:
        raw_images = []

    identities = []
    for entry in raw_images:
        normalized = normalize_album_entry(entry)
        if not normalized:
            continue
        identities.append(normalized["driveFileId"] or normalized["url"])

    digest_input = json.dumps(identities, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(digest_input.encode("utf-8")).hexdigest()[:16]


def build_local_filename(file_id):
    return f"{file_id}{IMAGE_EXT}"


def build_local_path(file_id, image_dir=None):
    image_dir = Path(image_dir or LOCAL_PHOTO_DIR)
    return image_dir / build_local_filename(file_id)


def build_album_url(file_id):
    return f"images/{build_local_filename(file_id)}"


def write_json_temp(payload, destination_path):
    destination_path = Path(destination_path)
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = destination_path.parent / f".{destination_path.name}.{uuid.uuid4().hex}.tmp"
    temp_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return temp_path


def download_image(service, file_id, destination_path):
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    request = service.files().get_media(fileId=file_id)
    with destination_path.open("wb") as handle:
        downloader = MediaIoBaseDownload(handle, request)
        done = False
        while not done:
            _, done = downloader.next_chunk(num_retries=DRIVE_DOWNLOAD_RETRIES)


def normalize_for_display(image):
    image = ImageOps.exif_transpose(image)

    if image.mode in {"RGBA", "LA"} or (
        image.mode == "P" and "transparency" in image.info
    ):
        image = image.convert("RGBA")
        background = Image.new("RGBA", image.size, (0, 0, 0, 255))
        background.alpha_composite(image)
        image = background.convert("RGB")
    elif image.mode != "RGB":
        image = image.convert("RGB")

    if max(image.size) > IMAGE_MAX_EDGE:
        image.thumbnail((IMAGE_MAX_EDGE, IMAGE_MAX_EDGE), RESAMPLE_FILTER)

    return image


def write_display_derivative(source_path, destination_path):
    require_image_pipeline()

    destination_path = Path(destination_path)
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temp_output_path = destination_path.parent / f".{destination_path.name}.{uuid.uuid4().hex}.tmp"

    try:
        with Image.open(source_path) as image:
            image = normalize_for_display(image)
            if IMAGE_FORMAT == "webp":
                image.save(
                    temp_output_path,
                    format="WEBP",
                    quality=IMAGE_QUALITY,
                    method=6,
                )
            else:
                image.save(
                    temp_output_path,
                    format="JPEG",
                    quality=IMAGE_QUALITY,
                    optimize=True,
                    progressive=True,
                )
        os.replace(temp_output_path, destination_path)
    except Exception:
        temp_output_path.unlink(missing_ok=True)
        raise


def needs_local_refresh(index_entry, file_info, local_path):
    if not local_path.exists():
        return True

    if not index_entry:
        return True

    settings = {
        "maxEdge": IMAGE_MAX_EDGE,
        "quality": IMAGE_QUALITY,
        "format": IMAGE_FORMAT,
        "fileName": local_path.name,
    }
    for key, value in settings.items():
        if index_entry.get(key) != value:
            return True

    return any(
        index_entry.get(field) != file_info.get(field)
        for field in ("name", "mimeType", "modifiedTime")
    )


def sync_local_image(service, file_info, destination_path):
    destination_path = Path(destination_path)
    destination_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(
        delete=False,
        suffix=".download",
        dir=str(destination_path.parent),
    ) as handle:
        temp_download_path = Path(handle.name)

    try:
        download_image(service, file_info["id"], temp_download_path)
        write_display_derivative(temp_download_path, destination_path)
    finally:
        temp_download_path.unlink(missing_ok=True)


def build_index_entry(file_info, local_path, url):
    return {
        "fileId": file_info["id"],
        "name": file_info.get("name", ""),
        "mimeType": file_info.get("mimeType", ""),
        "modifiedTime": file_info.get("modifiedTime", ""),
        "fileName": Path(local_path).name,
        "url": url,
        "maxEdge": IMAGE_MAX_EDGE,
        "quality": IMAGE_QUALITY,
        "format": IMAGE_FORMAT,
    }


def build_album_entry(file_id, url, caption_lookup):
    return {
        "url": url,
        "caption": resolve_caption(caption_lookup, file_id, url),
        "driveFileId": file_id,
    }


def build_skip_warning(skipped_files):
    if not skipped_files:
        return ""

    sample_names = [item["name"] for item in skipped_files[:3] if item.get("name")]
    sample_suffix = ""
    if sample_names:
        sample_suffix = ": " + ", ".join(sample_names)
        if len(skipped_files) > len(sample_names):
            sample_suffix += ", ..."

    timed_out = sum(
        1
        for item in skipped_files
        if "timed out" in (item.get("reason") or "").lower()
        or "timeout" in (item.get("reason") or "").lower()
    )
    timeout_suffix = ""
    if timed_out:
        timeout_noun = "download" if timed_out == 1 else "downloads"
        timeout_suffix = f" ({timed_out} stalled {timeout_noun})"

    noun = "image" if len(skipped_files) == 1 else "images"
    return f"Skipped {len(skipped_files)} unreadable {noun}{timeout_suffix}{sample_suffix}."


def build_preserved_entry(previous_entry, file_info, caption_lookup):
    if not previous_entry:
        return None

    file_name = (previous_entry.get("fileName") or "").strip()
    url = (previous_entry.get("url") or "").strip()
    if not file_name or not url:
        return None

    preserved_path = LOCAL_PHOTO_DIR / file_name
    if not preserved_path.exists():
        return None

    next_index_entry = dict(previous_entry)
    next_index_entry["name"] = file_info.get("name", "")
    next_index_entry["mimeType"] = file_info.get("mimeType", "")
    next_index_entry["modifiedTime"] = file_info.get("modifiedTime", "")

    return {
        "index": next_index_entry,
        "url": url,
        "album": build_album_entry(file_info["id"], url, caption_lookup),
    }


def collect_migrated_legacy_files(previous_payload, next_urls_by_id):
    legacy_paths = set()

    for entry in previous_payload.get("images", []):
        normalized = normalize_album_entry(entry)
        if not normalized or not normalized["driveFileId"]:
            continue
        url = normalized["url"]
        if not url.startswith("images/"):
            continue
        if next_urls_by_id.get(normalized["driveFileId"]) == url:
            continue
        legacy_paths.add(LOCAL_PHOTO_DIR / Path(url).name)

    return legacy_paths


def remove_local_paths(paths):
    for path in paths:
        try:
            Path(path).unlink(missing_ok=True)
        except Exception:
            continue


def commit_sync_metadata(album_payload, sync_index, album_path=None, index_path=None):
    album_path = Path(album_path or ALBUM_JSON_PATH)
    index_path = Path(index_path or SYNC_INDEX_PATH)
    album_temp_path = write_json_temp(album_payload, album_path)
    index_temp_path = write_json_temp(sync_index, index_path)

    try:
        os.replace(index_temp_path, index_path)
        os.replace(album_temp_path, album_path)
    except Exception:
        index_temp_path.unlink(missing_ok=True)
        album_temp_path.unlink(missing_ok=True)
        raise


def build_remote_album_payload(files, caption_lookup):
    payload_images = []

    for file_info in files:
        url = f"https://drive.google.com/uc?export=view&id={file_info['id']}"
        payload_images.append(build_album_entry(file_info["id"], url, caption_lookup))

    return {"version": 2, "images": payload_images}


def sync_drive_photos(service=None):
    service = service or get_drive_service()

    folder_id = find_folder_id(service, DRIVE_FOLDER_NAME)
    files = list_images_in_folder(service, folder_id)
    previous_payload = load_album_payload(ALBUM_JSON_PATH)
    caption_lookup = load_existing_caption_lookup(ALBUM_JSON_PATH)

    if not DOWNLOAD_IMAGES:
        album_payload = build_remote_album_payload(files, caption_lookup)
        changed = previous_payload != album_payload
        commit_sync_metadata(
            album_payload,
            {"version": 1, "images": {}, "settings": {"downloadImages": False}},
            ALBUM_JSON_PATH,
            SYNC_INDEX_PATH,
        )
        return {
            "count": len(album_payload["images"]),
            "changed": changed,
            "album": album_payload,
            "fingerprint": compute_album_fingerprint(album_payload),
        }

    LOCAL_PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    require_image_pipeline()

    previous_index = load_sync_index(SYNC_INDEX_PATH)
    previous_index_images = previous_index.get("images", {})

    next_index_images = {}
    payload_images = []
    next_urls_by_id = {}
    skipped_files = []

    for file_info in files:
        file_id = file_info["id"]
        local_path = build_local_path(file_id, LOCAL_PHOTO_DIR)
        url = build_album_url(file_id)
        previous_entry = previous_index_images.get(file_id)

        if needs_local_refresh(previous_entry, file_info, local_path):
            try:
                sync_local_image(service, file_info, local_path)
            except Exception as exc:
                preserved = build_preserved_entry(previous_entry, file_info, caption_lookup)
                skipped_files.append(
                    {
                        "id": file_id,
                        "name": file_info.get("name", "") or file_id,
                        "reason": str(exc),
                        "preserved": bool(preserved),
                    }
                )
                logging.warning(
                    "Skipping unreadable Drive image %s (%s): %s",
                    file_info.get("name", file_id),
                    file_id,
                    exc,
                )

                if preserved:
                    next_index_images[file_id] = preserved["index"]
                    next_urls_by_id[file_id] = preserved["url"]
                    payload_images.append(preserved["album"])
                continue

        next_index_images[file_id] = build_index_entry(file_info, local_path, url)
        next_urls_by_id[file_id] = url
        payload_images.append(build_album_entry(file_id, url, caption_lookup))

    if files and not payload_images:
        raise RuntimeError(build_skip_warning(skipped_files) or "No readable images were found in Google Drive.")

    album_payload = {"version": 2, "images": payload_images}
    changed = previous_payload != album_payload

    next_index = {
        "version": 1,
        "folderId": folder_id,
        "images": next_index_images,
        "settings": {
            "downloadImages": True,
            "maxEdge": IMAGE_MAX_EDGE,
            "quality": IMAGE_QUALITY,
            "format": IMAGE_FORMAT,
        },
    }

    commit_sync_metadata(album_payload, next_index, ALBUM_JSON_PATH, SYNC_INDEX_PATH)

    removed_file_ids = set(previous_index_images) - set(next_index_images)
    removed_paths = {
        LOCAL_PHOTO_DIR / previous_index_images[file_id]["fileName"]
        for file_id in removed_file_ids
        if previous_index_images.get(file_id, {}).get("fileName")
    }
    removed_paths.update(collect_migrated_legacy_files(previous_payload, next_urls_by_id))
    remove_local_paths(removed_paths)

    return {
        "count": len(album_payload["images"]),
        "changed": changed,
        "album": album_payload,
        "fingerprint": compute_album_fingerprint(album_payload),
        "skippedCount": len(skipped_files),
        "warning": build_skip_warning(skipped_files),
    }


def main():
    result = sync_drive_photos()
    print(
        f"Synced {result['count']} photos to {ALBUM_JSON_PATH}"
        + (" (changed)" if result["changed"] else " (no changes)")
    )


if __name__ == "__main__":
    main()
