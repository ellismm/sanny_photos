"""
drive_auth_local.py
Handles OAuth 2.0 flow for Google Drive API.
"""

from __future__ import print_function
import os
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
ROOT = Path(__file__).resolve().parents[1]
CREDS_PATH = ROOT / "creds" / "token.json"
CLIENT_SECRET_PATH = ROOT / "creds" / "client_secret.json"

def main():
    creds = None

    if os.path.exists(CREDS_PATH):
        creds = Credentials.from_authorized_user_file(str(CREDS_PATH), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET_PATH), SCOPES)
            creds = flow.run_local_server(port=0)

        os.makedirs(CREDS_PATH.parent, exist_ok=True)
        with open(CREDS_PATH, "w", encoding="utf-8") as token:
            token.write(creds.to_json())

    print("✅ Token saved to", CREDS_PATH)

if __name__ == "__main__":
    main()
