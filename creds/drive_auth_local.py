"""
drive_auth_local.py
Handles OAuth 2.0 flow for Google Drive API.
"""

from __future__ import print_function
import os, json
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

def main():
    creds = None
    creds_path = "/home/messay/coding/own/sanny_photos/creds/token.json"
    client_secret_path = "/home/messay/coding/own/sanny_photos/creds/client_secret.json"

    if os.path.exists(creds_path):
        creds = Credentials.from_authorized_user_file(creds_path, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(client_secret_path, SCOPES)
            creds = flow.run_local_server(port=0)

        os.makedirs(os.path.dirname(creds_path), exist_ok=True)
        with open(creds_path, "w") as token:
            token.write(creds.to_json())

    print("✅ Token saved to", creds_path)

if __name__ == "__main__":
    main()
