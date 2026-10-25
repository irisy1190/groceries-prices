"""
Looks inside the Kaggle daily copy of the supermarket files and writes site/kaggle.html,
so we can see whether it has Victory and Super-Pharm and how it's organised.
Needs the KAGGLE_USERNAME and KAGGLE_KEY secrets (or KAGGLE_API_TOKEN).
"""

import csv
import html
import io
import json
import os
import subprocess

DATASET = "erlichsefi/israeli-supermarkets-2024"
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(os.path.dirname(HERE), "site")
WANTED = ["victory", "super_pharm", "superpharm", "super-pharm", "7290696200003", "7290058103393", "7290172900007"]


def run(args):
    res = subprocess.run(args, capture_output=True, text=True, timeout=600)
    return res.returncode, (res.stdout or "") + (res.stderr or "")


def main():
    os.makedirs(SITE, exist_ok=True)
    parts = [f"<h1>Kaggle check</h1><p>Dataset: <b>{DATASET}</b></p>"]

    code, out = run(["kaggle", "datasets", "metadata", "-d", DATASET, "-p", SITE])
    meta_path = os.path.join(SITE, "dataset-metadata.json")
    if os.path.exists(meta_path):
        try:
            meta = json.load(open(meta_path, encoding="utf-8"))
            info = meta.get("info", meta)
            keep = {k: info.get(k) for k in ("title", "subtitle", "lastUpdated", "licenses", "totalBytes", "keywords") if k in info}
            parts.append("<h2>About</h2><pre>" + html.escape(json.dumps(keep, ensure_ascii=False, indent=1)[:3000]) + "</pre>")
            desc = (info.get("description") or "")[:4000]
            if desc:
                parts.append("<h2>Description</h2><pre>" + html.escape(desc) + "</pre>")
        except Exception as err:  # noqa: BLE001
            parts.append(f"<p>Could not read metadata: {html.escape(str(err))}</p>")
    else:
        parts.append("<h2>About</h2><pre>" + html.escape(out[-2000:]) + "</pre>")

    rows, token, pages = [], None, 0
    while pages < 30:
        args = ["kaggle", "datasets", "files", "-d", DATASET, "--page-size", "200", "--csv"]
        if token:
            args += ["--page-token", token]
        code, out = run(args)
        pages += 1
        lines = [l for l in out.splitlines() if l.strip()]
        token = None
        data_lines = []
        for line in lines:
            if line.lower().startswith("next page token"):
                token = line.split("=", 1)[-1].strip() if "=" in line else line.split(":", 1)[-1].strip()
            else:
                data_lines.append(line)
        reader = csv.reader(io.StringIO("\n".join(data_lines)))
        header = None
        for rec in reader:
            if header is None:
                header = rec
                continue
            if rec:
                rows.append(rec)
        if code != 0 or not token:
            if code != 0:
                parts.append("<h2>File list error</h2><pre>" + html.escape(out[-2000:]) + "</pre>")
            break

    parts.append(f"<h2>Files</h2><p>{len(rows)} files listed ({pages} page(s)).</p>")
    sample = rows[:40]
    parts.append("<h3>First files</h3><pre>" + html.escape("\n".join(" | ".join(r) for r in sample)) + "</pre>")
    matches = [r for r in rows if any(w in " ".join(r).lower() for w in WANTED)]
    parts.append(f"<h3>Victory / Super-Pharm files ({len(matches)})</h3><pre>"
                 + html.escape("\n".join(" | ".join(r) for r in matches[:60])) + "</pre>")
    with open(os.path.join(SITE, "kaggle-files.csv"), "w", encoding="utf-8") as fh:
        csv.writer(fh).writerows(rows)

    page = ("<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
            "<title>Kaggle check</title><style>body{font:15px -apple-system,system-ui,sans-serif;margin:20px;background:#f8f2e8}"
            "pre{white-space:pre-wrap;background:#fff;padding:12px;border-radius:10px;font-size:12px}</style></head><body>"
            + "".join(parts) + "</body></html>")
    with open(os.path.join(SITE, "kaggle.html"), "w", encoding="utf-8") as fh:
        fh.write(page)
    print(f"kaggle.html written: {len(rows)} files, {len(matches)} Victory/Super-Pharm matches")


if __name__ == "__main__":
    main()
