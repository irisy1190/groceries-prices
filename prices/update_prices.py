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

# macOS's built-in Python (3.9) lacks anext(), which the price tool uses.
import builtins

if not hasattr(builtins, "anext"):
    _missing = object()

    async def _anext(iterator, default=_missing):
        try:
            return await iterator.__anext__()
        except StopAsyncIteration:
            if default is _missing:
                raise
            return default

    builtins.anext = _anext

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
# Reading sales (PromoFull files)
# ---------------------------------------------------------------------------

def _israel_today():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Asia/Jerusalem")).date()
    except Exception:  # noqa: BLE001
        return datetime.now().date()


def _promo_date(text):
    m = re.search(r"(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})", text or "")
    if m:
        y, mo, d = (int(x) for x in m.groups())
    else:
        m = re.search(r"(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})", text or "")
        if not m:
            return None
        d, mo, y = (int(x) for x in m.groups())
    try:
        return datetime(y, mo, d).date()
    except ValueError:
        return None


def _number(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


_DEAL_N_FOR = re.compile(r"(\d+)\s*ב\s*-?\s*(\d+(?:\.\d+)?)")
_DEAL_PLUS = re.compile(r"(?<![\d.])(\d)\s*\+\s*(\d)(?![\d.])")
_DEAL_PCT = re.compile(r"(\d+(?:\.\d+)?)\s*%")
_DEAL_2ND = re.compile(r"שני\s*ב\s*-?\s*(\d+(?:\.\d+)?)(?![\d.])(?!\s*%)")
_IS_DEAL = re.compile(r"^(\d+(?:\.\d+)? for ₪|\d\+\d$|[\d.]+% off|₪|2nd for ₪)")


def promo_text(fields):
    """A short deal, e.g. '2 for ₪50', '1+1', '20% off' – or the chain's own words if it's something else."""
    desc = re.sub(r"\s+", " ", fields.get("promotiondescription", "")).strip()
    # Chains often repeat the product name in the description; keep just the deal when we can see it.
    m = _DEAL_N_FOR.search(desc)
    if m and int(m.group(1)) > 1:
        return f"{m.group(1)} for ₪{m.group(2)}"
    m = _DEAL_PLUS.search(desc)
    if m:
        return f"{m.group(1)}+{m.group(2)}"
    m = _DEAL_2ND.search(desc)
    if m:
        return f"2nd for ₪{m.group(1)}"
    m = _DEAL_PCT.search(desc)
    if m:
        return f"{m.group(1)}% off" + (" the 2nd" if "שני" in desc else "")
    qty = _number(fields.get("minqty"))
    price = _number(fields.get("discountedprice"))
    # A single sale price ("14.90לילי תחבושות", "… 13.90 ₪"): shorten it only if the sale-price field agrees.
    if price and price > 0 and (not qty or qty <= 1):
        numbers = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", desc)]
        if any(abs(n - price) < 0.011 for n in numbers):
            return f"₪{price:.2f}"
    built = ""
    if price and price > 0:
        shown = f"{price:g}" if price == int(price) else f"{price:.2f}"
        built = f"{qty:g} for ₪{shown}" if qty and qty > 1 else f"₪{shown}"
    if desc and (re.search(r"\d", desc) or not built):
        return desc[:60]
    return (built or desc)[:60]


def read_promos(folder, chain_id="", store_codes=None):
    """{barcode: [(text, end 'YYYY-MM-DD', club_only)]} for sales running today."""
    files = [f for f in xml_files(folder) if "promo" in os.path.basename(f).lower()]
    if chain_id:
        same_chain = [f for f in files if chain_id in os.path.basename(f)]
        files = same_chain or files
    if not files:
        log("   no sale file found")
        return {}
    latest = max(files, key=lambda f: (file_date(f), os.path.getsize(f)))
    log(f"   sales file: {os.path.basename(latest)} ({os.path.getsize(latest) // 1024} KB)")
    try:
        text = re.sub(r"^\s*<\?xml[^>]*\?>", "", read_text(latest))
        root = etree.fromstring(text.encode("utf-8"), etree.XMLParser(recover=True, huge_tree=True))
    except Exception as err:  # noqa: BLE001
        log(f"   could not read the sales file: {err}")
        return {}
    if root is None:
        return {}

    today = _israel_today()
    promos = {}
    seen = skipped_dates = skipped_broad = 0
    for el in root.iter():
        kids = [c for c in el if isinstance(c.tag, str)]
        if not any(local(c.tag) == "promotiondescription" for c in kids):
            continue
        seen += 1
        fields = {local(c.tag): (c.text or "").strip() for c in kids if len(c) == 0}
        # Some chains put the deal numbers one level down, in <Groups><Group>.
        for c in el.iter():
            key = local(c.tag)
            if key in ("minqty", "discountedprice", "discountrate") and len(c) == 0 and (c.text or "").strip() \
                    and not fields.get(key):
                fields[key] = c.text.strip()
        start = _promo_date(fields.get("promotionstartdate") or fields.get("promotionstartdatetime"))
        end = _promo_date(fields.get("promotionenddate") or fields.get("promotionenddatetime"))
        if (start and start > today) or (end and end < today):
            skipped_dates += 1
            continue
        # Club numbers are written as "0", or "0=אין" / "2=לייף סטייל" (0 = everyone).
        clubs = [re.sub(r"\D.*", "", (c.text or "").strip()) for c in el.iter() if local(c.tag) == "clubid"]
        club_only = any(c not in ("", "0") for c in clubs) and "0" not in clubs
        if fields.get("additionaliscoupon") == "1" or "קופון" in fields.get("promotiondescription", ""):
            club_only = True  # needs a club card or a coupon
        label = promo_text(fields)
        if not label:
            continue
        # Items: either nested <PromotionItems><Item>… or a flat row with its own <ItemCode>.
        codes = []
        for item in el.iter():
            sub = {local(c.tag): (c.text or "").strip() for c in item if isinstance(c.tag, str) and len(c) == 0}
            if "itemcode" in sub and sub.get("isgiftitem", "0") != "1":
                codes.append(re.sub(r"\D", "", sub["itemcode"]))
        # Store-wide offers in free text ("buy any beauty product, add ₪9.90 and get a gift…") are noise on a product.
        if len(codes) > 50 and not _IS_DEAL.match(label):
            skipped_broad += 1
            continue
        entry = (label, end.isoformat() if end else "", club_only)
        for code in codes:
            if len(code) < 8 or (store_codes is not None and code not in store_codes):
                continue
            lst = promos.setdefault(code, [])
            if entry not in lst:
                lst.append(entry)
    # Keep the two most useful sales per product (everyone's sales before club-only ones).
    for code, lst in promos.items():
        lst.sort(key=lambda e: (e[2], e[1] or "9999"))
        del lst[2:]
    log(f"   {seen} sale records, {skipped_dates} not running today, {skipped_broad} store-wide offers skipped, "
        f"{len(promos)} products on sale")
    if seen == 0:
        log(f"   sales file starts with: {text[:500]!r}")
    return promos


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


def previous_promos(prev, label):
    """Sales for this store from an earlier prices.json, minus those that have ended."""
    if not prev:
        return {}
    stores = prev.get("stores", [])
    idx = next((i for i, st in enumerate(stores) if st.get("label") == label), None)
    if idx is None:
        return {}
    today = _israel_today().isoformat()
    table = prev.get("promos", [])
    out = {}
    for code, ids in prev.get("itemPromos", {}).items():
        for i in ids:
            if i < len(table) and table[i][0] == idx:
                _, text, end, club = table[i]
                if end and end < today:
                    continue
                out.setdefault(code, []).append((text, end, bool(club)))
    return out


# ---------------------------------------------------------------------------
# Prices sent from the Mac (for chains that block computers outside Israel)
# ---------------------------------------------------------------------------

MAC_FILE = os.path.join(ROOT, "extra", "mac-prices.json")


def load_mac_prices():
    if not os.path.exists(MAC_FILE):
        log("No prices from the Mac yet (extra/mac-prices.json is missing).")
        return None
    try:
        data = json.load(open(MAC_FILE, encoding="utf-8"))
        log(f"Prices from the Mac: {data.get('updated')} – stores: {[s.get('label') for s in data.get('stores', [])]}")
        return data
    except Exception as err:  # noqa: BLE001
        log(f"Could not read the Mac's prices: {err}")
        return None


def is_recent(stamp, days=2):
    """Whether a YYYYMMDD… date is from today or the last "days" days (Israel time)."""
    try:
        from zoneinfo import ZoneInfo
        today = datetime.now(ZoneInfo("Asia/Jerusalem")).date()
        day = datetime.strptime(str(stamp)[:8], "%Y%m%d").date()
        return (today - day).days < days
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    stores_file = os.environ.get("STORES_FILE") or os.path.join(HERE, "stores.json")
    config = json.load(open(stores_file, encoding="utf-8"))
    prev = load_previous()
    mac = load_mac_prices() if any(t.get("source") == "mac" for t in config["stores"]) else None
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

        if target.get("source") == "mac":
            # This chain blocks computers outside Israel: its prices come from the Mac.
            store, items = previous_column(mac, label)
            promos = previous_promos(mac, label)
            if not items:
                store, items = previous_column(prev, label)
                promos = previous_promos(prev, label)
                stale = True
                how = "kept from the last run (no prices from the Mac)"
            else:
                stale = not is_recent(store.get("date"))
                how = "from your Mac" + (" (not updated recently – is the Mac on?)" if stale else "")
            if items:
                columns.append({
                    "label": label, "place": target["place"], "branch": store.get("branch", ""),
                    "date": store.get("date", ""), "stale": stale, "_items": items, "_promos": promos
                })
                entry.update(ok=not stale, items=len(items), promos=len(promos), how_chosen=how, file_date=store.get("date", ""),
                             branch={"id": "", "name": store.get("branch", ""), "address": ""})
                if stale:
                    entry["kept_previous"] = store.get("date", "")
                log(f"   {len(items)} products {how}, dated {store.get('date')}")
            else:
                entry["error"] = "no prices from the Mac yet – run the setup on the Mac"
                log(f"   FAILED: {entry['error']}")
            entry["seconds"] = round(time.time() - started)
            report.append(entry)
            continue
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
            # Today's sales for this branch (a problem here never loses the prices).
            try:
                promo_folder = os.path.join(DUMPS, scraper, f"promos-{branch['id']}")
                await download(scraper, promo_folder, "PROMO_FULL_FILE", store_id=branch["id"])
                promos = read_promos(promo_folder, branch.get("chain", ""), set(items))
            except Exception as err:  # noqa: BLE001
                log(f"   sales download problem: {err!r}")
                promos = {}
            if not promos:
                promos = previous_promos(prev, label)
                if promos:
                    log(f"   keeping {len(promos)} sales from the last run")
            columns[-1]["_promos"] = promos
            entry["promos"] = len(promos)
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
                    "_items": old_items, "_promos": previous_promos(prev, label)
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

    # Sales: a shared table [store index, text, end date, club only] and, per barcode, which rows apply.
    promo_table, promo_index, item_promos = [], {}, {}
    for idx, col in enumerate(columns):
        for code, entries in col.get("_promos", {}).items():
            if code not in combined:
                continue
            for text, end, club in entries:
                key = (idx, text, end, bool(club))
                if key not in promo_index:
                    promo_index[key] = len(promo_table)
                    promo_table.append([idx, text, end, 1 if club else 0])
                item_promos.setdefault(code, []).append(promo_index[key])

    out = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "stores": [{k: v for k, v in c.items() if not k.startswith("_")} for c in columns],
        "items": combined,
        "promos": promo_table,
        "itemPromos": item_promos,
    }
    with open(os.path.join(SITE, "prices.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(SITE, "report.json"), "w", encoding="utf-8") as fh:
        json.dump({"updated": out["updated"], "stores": report, "log": log_lines}, fh, ensure_ascii=False, indent=1)
    write_status_page(out, report)

    ok = sum(1 for r in report if r["ok"])
    log(f"Done: {ok} of {len(report)} stores updated, {len(combined)} products in total, {len(item_promos)} on sale.")
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
            f"<td>{esc(r.get('items', ''))}</td><td>{esc(r.get('promos', ''))}</td></tr>"
        )
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Grocery prices</title>
<style>body{{font:16px -apple-system,system-ui,sans-serif;margin:20px;color:#1c1c1e;background:#f8f2e8}}
table{{border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;width:100%}}
td,th{{padding:10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}}
small{{color:#8a8a8e}}</style></head><body>
<h1>Grocery prices</h1><p>Last update: {esc(out['updated'])} (UTC) · {len(out['items'])} products</p>
<table><tr><th>Store</th><th>Status</th><th>Branch used</th><th>Products</th><th>On sale</th></tr>{''.join(rows)}</table>
<p><small>The app reads <a href="prices.json">prices.json</a>. Details: <a href="report.json">report.json</a>.</small></p>
</body></html>"""
    with open(os.path.join(SITE, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(html)


if __name__ == "__main__":
    asyncio.run(main())
