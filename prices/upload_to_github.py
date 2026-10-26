"""
Runs on the Mac after the daily download: sends site/prices.json to the GitHub project
as extra/mac-prices.json, then starts the GitHub job so the app gets the new prices right away.

Needs the GitHub key in the GH_TOKEN environment variable (the daily runner reads it from the Keychain).
"""

import base64
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime

REPO = os.environ.get("GH_REPO", "irisy1190/groceries-prices")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOURCE = os.path.join(ROOT, "site", "prices.json")
TARGET = "extra/mac-prices.json"
API = "https://api.github.com"


def call(method, path, token, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "groceries-mac-prices",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read().decode("utf-8")
            return res.status, (json.loads(text) if text else {})
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", errors="replace")
        return err.code, {"message": text[:300]}


def main():
    token = os.environ.get("GH_TOKEN", "").strip()
    if not token:
        print("No GitHub key found (GH_TOKEN). Run the setup again to save it.")
        sys.exit(1)
    if not os.path.exists(SOURCE):
        print("No prices.json to upload – the download step didn't produce one.")
        sys.exit(1)

    data = json.load(open(SOURCE, encoding="utf-8"))
    stores = [s for s in data.get("stores", []) if not s.get("stale")]
    if not stores:
        print("Nothing new to upload today (no store downloaded successfully). Keeping the previous file.")
        sys.exit(0)
    print(f"Uploading {len(data.get('items', {}))} products from: {[s['label'] for s in stores]}")

    status, current = call("GET", f"/repos/{REPO}/contents/{TARGET}", token)
    sha = current.get("sha") if status == 200 else None

    content = base64.b64encode(open(SOURCE, "rb").read()).decode("ascii")
    body = {"message": f"Prices from the Mac {datetime.now():%Y-%m-%d %H:%M}", "content": content}
    if sha:
        body["sha"] = sha
    status, result = call("PUT", f"/repos/{REPO}/contents/{TARGET}", token, body)
    if status not in (200, 201):
        print(f"Upload failed ({status}): {result.get('message')}")
        sys.exit(1)
    print("Uploaded to GitHub.")

    status, result = call("POST", f"/repos/{REPO}/actions/workflows/update-prices.yml/dispatches", token, {"ref": "main"})
    if status == 204:
        print("Started the GitHub job – the app will have the new prices in a few minutes.")
    else:
        print(f"Couldn't start the GitHub job ({status}): {result.get('message')}. It will still run on its daily schedule.")


if __name__ == "__main__":
    main()
