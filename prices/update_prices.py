"""
Daily price update for the Groceries app.

1. For each store in stores.json: download the chain's store list, find the right branch,
   then download that branch's full price file (published by law, see gov.il "שקיפות מחירים").
2. Combine everything into site/prices.json, which the app reads.
3. Write site/report.json and site/index.html so you can see what happened.

If a chain fails on a given day, that store keeps its prices from the last good run.
"""

import asyncio
import glob
import json
import logging
import os
import re
import time
import traceback
import urllib.request
from datetime import datetime, timezone

from lxml import etree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SITE = os.path.join(ROOT, "site")
DUMPS = os.path.join(ROOT, "dumps")
STEP_TIMEOUT = 20 * 60  # seconds per download step

log_lines = []
details = []  # warnings/errors from the downloader for the store being processed


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    log_lines.append(line)


class _Collect(logging.Handler):
    """Keeps the downloader's warnings and errors, so the status page can show why something failed."""

    def emit(self, record):
        try:
            text = record.getMessage()
        except Exception:  # noqa: BLE001
            text = str(record.msg)
        details.append(f"{record.levelname}: {text[:400]}")
        log_lines.append(f"   [{record.levelname}] {text[:400]}")


_collector_installed = False


def _install_collector():
    global _collector_installed
    if _collector_installed:
        return
    try:
        from il_supermarket_scarper.utils.core.logger import Logger
        handler = _Collect(level=logging.WARNING)
        Logger.logger.addHandler(handler)
    except Exception as err:  # noqa: BLE001
        log(f"(could not attach to the downloader's log: {err})")
    _collector_installed = True


# ---------------------------------------------------------------------------
# XML reading (chains differ in tag case and layout, so match tags loosely)
# ---------------------------------------------------------------------------

def local(tag):
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].lower()


_BAD_XML_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_BARE_AMP = re.compile(r"&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)")


def read_text(path):
    """The file as text, whatever its encoding (chains use UTF-8, UTF-16 or Windows-1255)."""
    raw = open(path, "rb").read()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = raw.decode("utf-16", errors="replace")
    else:
        for enc in ("utf-8-sig", "cp1255", "latin-1"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
    text = _BAD_XML_CHARS.sub(" ", text)
    return _BARE_AMP.sub("&amp;", text)


def _records_lxml(text, key_field):
    text = re.sub(r"^\s*<\?xml[^>]*\?>", "", text)  # the encoding is already handled
    parser = etree.XMLParser(recover=True, huge_tree=True, remove_blank_text=True)
    root = etree.fromstring(text.encode("utf-8"), parser)
    if root is None:
        return []
    out = []
    for el in root.iter():
        children = {local(c.tag): (c.text or "").strip() for c in el if len(c) == 0}
        if key_field in children:
            out.append(children)
    return out


_FIELD = re.compile(r"<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)</\1\s*>", re.S)


# An element whose children are all simple fields, e.g. <Item><ItemCode>…</ItemCode><ItemPrice>…</ItemPrice></Item>
_FLAT_ELEMENT = re.compile(
    r"<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>\s*"
    r"((?:<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>[^<]*</\3\s*>\s*|<[A-Za-z_][\w.-]*(?:\s[^>]*)?/>\s*)+)"
    r"</\1\s*>",
    re.S,
)


def _records_regex(text, key_field):
    """Forgiving fallback: find every element made of simple fields that includes key_field."""
    out = []
    key = re.compile(rf"<{key_field}[\s>/]", re.I)
    for m in _FLAT_ELEMENT.finditer(text):
        body = m.group(2)
        if not key.search(body):
            continue
        fields = {name.lower(): value.strip() for name, value in _FIELD.findall(body)}
        fields.setdefault(key_field, "")
        out.append(fields)
    return out


def records(path, key_field):
    """Every element that has a child named key_field, as {field: text}. Tolerates broken files."""
    try:
        text = read_text(path)
    except Exception as err:  # noqa: BLE001
        log(f"   could not read {os.path.basename(path)}: {err}")
        return []
    try:
        found = _records_lxml(text, key_field)
    except Exception as err:  # noqa: BLE001
        log(f"   XML reader problem in {os.path.basename(path)}: {err}")
        found = []
    # If the strict reader stopped early (common with badly formed files), use the forgiving one.
    expected = len(re.findall(rf"<{key_field}\b", text, re.I))
    if len(found) < expected * 0.9:
        loose = _records_regex(text, key_field)
        if len(loose) > len(found):
            log(f"   {os.path.basename(path)}: strict reader got {len(found)}, forgiving reader got {len(loose)}")
            found = loose
    return found


def file_date(path):
    """The date and time in a file name, as YYYYMMDDHHMM(SS).

    Chains write it as 202410250500 or 20241025-050909 – both are understood.
    """
    name = os.path.basename(path)
    # Remove the chain number first so its digits can't be mistaken for a date.
    rest = re.sub(r"\d{13}", "", name)
    found = re.findall(r"(20\d{2}[01]\d[0-3]\d)[-_]?(\d{4,6})?", rest)
    if not found:
        return "0"
    day, time_part = found[-1]
    return (day + (time_part or "")).ljust(14, "0")


def xml_files(folder):
    files = []
    for ext in ("*.xml", "*.XML"):
        files += glob.glob(os.path.join(folder, "**", ext), recursive=True)
    return sorted(set(files))


# ---------------------------------------------------------------------------
# Downloading with il-supermarket-scraper
# ---------------------------------------------------------------------------

async def download(scraper_name, folder, file_type, store_id=None):
    from il_supermarket_scarper import ScraperFactory, FileTypesFilters
    from il_supermarket_scarper.utils import DiskFileOutput

    _install_collector()
    os.makedirs(folder, exist_ok=True)
    scraper_cls = ScraperFactory[scraper_name].value
    scraper = scraper_cls(file_output=DiskFileOutput(folder, extract_gz=True))
    kwargs = {"files_types": [FileTypesFilters[file_type].name]}
    if store_id:
        kwargs["store_id"] = int(store_id)

    async def run():
        count = 0
        async for result in scraper.scrape(**kwargs):
            count += 1
            err = getattr(result, "error", None)
            if err:
                log(f"   download problem: {err}")
        return count

    return await asyncio.wait_for(run(), timeout=STEP_TIMEOUT)


# ---------------------------------------------------------------------------
# Finding the right branch
# ---------------------------------------------------------------------------

def norm(text):
    return re.sub(r"[\"'׳״`.,\-()]", " ", (text or "").lower()).replace("  ", " ").strip()


def chain_id_of(path):
    """The ChainId written in a file (some download sites serve two chains, e.g. Fresh Market and Super Dosh)."""
    for rec in records(path, "chainid"):
        cid = re.sub(r"\D", "", rec.get("chainid", ""))
        if cid:
            return cid
    found = re.search(r"(\d{13})", os.path.basename(path))
    return found.group(1) if found else ""


def read_stores(folder):
    stores = {}
    for path in xml_files(folder):
        file_chain = chain_id_of(path)
        for rec in records(path, "storeid"):
            sid = rec.get("storeid", "").lstrip("0") or "0"
            chain = re.sub(r"\D", "", rec.get("chainid", "")) or file_chain
            stores[(chain, sid)] = {
                "id": sid,
                "chain": chain,
                "name": rec.get("storename", ""),
                "address": rec.get("address", ""),
                "city": rec.get("city", ""),
            }
    return list(stores.values())


def choose_store(stores, target, city_terms):
    city_terms = [norm(c) for c in city_terms]

    def in_city(s):
        city = norm(s["city"])
        text = norm(f"{s['name']} {s['address']}")
        return any(c and (c == city or c in city or c in text) for c in city_terms)

    candidates = [s for s in stores if in_city(s)]
    if target.get("store_id"):
        sid = str(target["store_id"]).lstrip("0")
        match = next((s for s in stores if s["id"] == sid), None)
        return match, candidates, "chosen by store_id in stores.json" if match else "store_id not found"

    def score(s):
        text = norm(f"{s['name']} {s['address']}")
        return sum(len(k) for k in target["keywords"] if norm(k) in text)

    ranked = sorted(candidates, key=score, reverse=True)
    if ranked and score(ranked[0]) > 0:
        return ranked[0], candidates, "matched by name"
    if len(candidates) == 1:
        return candidates[0], candidates, "the only branch in the city"
    return None, candidates, "no branch matched – see the list and set store_id"


# ---------------------------------------------------------------------------
# Reading prices
# ---------------------------------------------------------------------------

def to_price(text):
    try:
        value = float(text)
        return round(value, 2) if value > 0 else None
    except (TypeError, ValueError):
        return None


def read_prices(folder, chain_id=""):
    files = xml_files(folder)
    full = [f for f in files if "pricefull" in os.path.basename(f).lower()] or files
    for f in full:
        log(f"   file: {os.path.basename(f)} ({os.path.getsize(f) // 1024} KB)")
    if chain_id:
        # Only this chain's files: the same store number can exist in another chain on the same site.
        same_chain = [f for f in full if chain_id in os.path.basename(f)]
        if same_chain:
            full = same_chain
    if not full:
        return None, {}
    latest = max(full, key=lambda f: (file_date(f), os.path.getsize(f)))
    items = {}
    recs = records(latest, "itemcode")
    dropped = {"short code": 0, "no price": 0}
    for rec in recs:
        code = re.sub(r"\D", "", rec.get("itemcode", ""))
        # Real barcodes have 8+ digits. Shorter codes are the store's own (weighed produce etc.)
        # and don't match across chains. (ItemType isn't used: some chains mark every item 0.)
        if len(code) < 8:
            dropped["short code"] += 1
            continue
        price = to_price(rec.get("itemprice"))
        if price is None:
            dropped["no price"] += 1
            continue
        # (ManufacturerName is often the importer or the store itself, so it's not added to the name.)
        name = rec.get("itemname", "") or rec.get("manufactureritemdescription", "")
        items[code] = (name, price)
    diagnose(latest, recs, items, dropped)
    return latest, items


def diagnose(path, recs, items, dropped):
    """Writes what the file looked like to the log, to fix unusual chains quickly."""
    try:
        text = read_text(path)
        tags = re.findall(r"<([A-Za-z_][\w.-]*)", text)
        common = {}
        for t in tags:
            common[t] = common.get(t, 0) + 1
        top = sorted(common.items(), key=lambda kv: -kv[1])[:15]
        log(f"   read {len(recs)} records, kept {len(items)}, dropped {dropped}")
        log(f"   most common tags: {top}")
        log(f"   file starts with: {text[:700]!r}")
        if recs:
            log(f"   first record: {dict(list(recs[0].items())[:14])}")
    except Exception as err:  # noqa: BLE001
        log(f"   (diagnose failed: {err})")


# ---------------------------------------------------------------------------
# Previous results (kept when a chain fails today)
# ---------------------------------------------------------------------------

def load_previous():
    url = os.environ.get("PAGES_URL", "").strip()
    if not url:
        return None
    url = url.rstrip("/") + "/prices.json"
    try:
        with urllib.request.urlopen(url, timeout=30) as res:
            data = json.loads(res.read().decode("utf-8"))
            log(f"Loaded previous prices from {url}")
            return data
    except Exception as err:  # noqa: BLE001
        log(f"No previous prices found ({err}) – fine on the first run.")
        return None


def previous_column(prev, label):
    if not prev:
        return None, {}
    for idx, store in enumerate(prev.get("stores", [])):
        if store.get("label") == label:
            column = {}
            for code, row in prev.get("items", {}).items():
                prices = row[1] if len(row) > 1 else []
                if idx < len(prices) and prices[idx] is not None:
                    column[code] = (row[0], prices[idx])
            return store, column
    return None, {}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    config = json.load(open(os.path.join(HERE, "stores.json"), encoding="utf-8"))
    prev = load_previous()
    os.makedirs(SITE, exist_ok=True)

    store_lists = {}
    columns = []
    report = []

    for target in config["stores"]:
        label, scraper = target["label"], target["scraper"]
        log(f"=== {label} ({target['place']}) – {scraper}")
        entry = {"label": label, "place": target["place"], "scraper": scraper, "ok": False}
        started = time.time()
        details.clear()
        try:
            if scraper not in store_lists:
                folder = os.path.join(DUMPS, scraper, "stores")
                try:
                    await download(scraper, folder, "STORE_FILE")
                except Exception as err:  # noqa: BLE001
                    log(f"   store list download error: {err!r}")
                store_lists[scraper] = read_stores(folder)
                log(f"   {len(store_lists[scraper])} branches in the chain's store list")
            stores = store_lists[scraper]

            if stores:
                branch, candidates, how = choose_store(stores, target, config["city"])
                entry["branches_in_city"] = candidates
                entry["how_chosen"] = how
                if not branch:
                    raise RuntimeError(how)
            elif target.get("store_id"):
                # No store list today, but we know the branch number from stores.json.
                branch = {"id": str(target["store_id"]).lstrip("0"), "chain": "",
                          "name": f"{label} {target['place']}", "address": "", "city": ""}
                entry["how_chosen"] = "store_id from stores.json (no store list today)"
            else:
                raise RuntimeError("could not get the chain's list of branches (maybe blocked outside Israel)")
            entry["branch"] = branch
            log(f"   branch: #{branch['id']} {branch['name']} – {branch['address']} ({entry['how_chosen']})")

            folder = os.path.join(DUMPS, scraper, f"prices-{branch['id']}")
            await download(scraper, folder, "PRICE_FULL_FILE", store_id=branch["id"])
            source, items = read_prices(folder, branch.get("chain", ""))
            if not items:
                raise RuntimeError("no price file found for this branch (maybe blocked outside Israel)")
            entry.update(ok=True, items=len(items), file=os.path.basename(source), file_date=file_date(source))
            log(f"   {len(items)} products from {os.path.basename(source)}")
            columns.append({
                "label": label, "place": target["place"],
                "branch": branch["name"], "date": file_date(source), "stale": False
            })
            columns[-1]["_items"] = items
        except Exception as err:  # noqa: BLE001
            entry["error"] = str(err) or err.__class__.__name__
            log(f"   FAILED: {entry['error']}")
            if not isinstance(err, RuntimeError):
                log(traceback.format_exc(limit=3))
            old_store, old_items = previous_column(prev, label)
            if old_items:
                log(f"   keeping {len(old_items)} prices from {old_store.get('date')}")
                columns.append({
                    "label": label, "place": target["place"],
                    "branch": old_store.get("branch", ""), "date": old_store.get("date", ""), "stale": True,
                    "_items": old_items
                })
                entry["kept_previous"] = old_store.get("date")
        entry["seconds"] = round(time.time() - started)
        if details:
            entry["details"] = details[-10:]
        report.append(entry)

    # Combine: { barcode: [name, [price per store]] }
    combined = {}
    for idx, col in enumerate(columns):
        for code, (name, price) in col["_items"].items():
            row = combined.setdefault(code, [name, [None] * len(columns)])
            if len(name) > len(row[0]):
                row[0] = name
            row[1][idx] = price

    out = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "stores": [{k: v for k, v in c.items() if not k.startswith("_")} for c in columns],
        "items": combined,
    }
    with open(os.path.join(SITE, "prices.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(SITE, "report.json"), "w", encoding="utf-8") as fh:
        json.dump({"updated": out["updated"], "stores": report, "log": log_lines}, fh, ensure_ascii=False, indent=1)
    write_status_page(out, report)

    ok = sum(1 for r in report if r["ok"])
    log(f"Done: {ok} of {len(report)} stores updated, {len(combined)} products in total.")
    # Always finish normally, so the status page (index.html) gets published and shows what failed.


def write_status_page(out, report):
    def esc(s):
        return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    rows = []
    for r in report:
        status = "✅ updated" if r["ok"] else ("⚠️ kept " + esc(r["kept_previous"]) if r.get("kept_previous") else "❌ failed")
        branch = r.get("branch") or {}
        detail = f"#{esc(branch.get('id', ''))} {esc(branch.get('name', ''))} – {esc(branch.get('address', ''))}" if branch else ""
        extra = f"<br><small>{esc(r.get('error', ''))}</small>" if r.get("error") else ""
        if r.get("details") and not r["ok"]:
            lines = "".join(f"<li><small>{esc(d)}</small></li>" for d in r["details"])
            extra += f"<details><summary><small>Technical details</small></summary><ul>{lines}</ul></details>"
        cands = "".join(
            f"<li>#{esc(c['id'])} {esc(c['name'])} – {esc(c['address'])}</li>" for c in r.get("branches_in_city", [])
        )
        rows.append(
            f"<tr><td><b>{esc(r['label'])}</b><br>{esc(r['place'])}</td><td>{status}{extra}</td>"
            f"<td>{detail}<br><small>{esc(r.get('how_chosen', ''))}</small>"
            f"{'<details><summary>Branches in the city</summary><ul>' + cands + '</ul></details>' if cands else ''}</td>"
            f"<td>{esc(r.get('items', ''))}</td></tr>"
        )
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Grocery prices</title>
<style>body{{font:16px -apple-system,system-ui,sans-serif;margin:20px;color:#1c1c1e;background:#f8f2e8}}
table{{border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;width:100%}}
td,th{{padding:10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}}
small{{color:#8a8a8e}}</style></head><body>
<h1>Grocery prices</h1><p>Last update: {esc(out['updated'])} (UTC) · {len(out['items'])} products</p>
<table><tr><th>Store</th><th>Status</th><th>Branch used</th><th>Products</th></tr>{''.join(rows)}</table>
<p><small>The app reads <a href="prices.json">prices.json</a>. Details: <a href="report.json">report.json</a>.</small></p>
</body></html>"""
    with open(os.path.join(SITE, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(html)


if __name__ == "__main__":
    asyncio.run(main())
