"""
Search tags for products, written by an LLM (Google Gemini, free tier).

Store names are short and inconsistent ("דנונה PRO 20ג' טבעי", "מולר פרוטאין 0%"), so a search for
"יוגורט חלבון" misses many of them. Once per barcode, Gemini writes the words a shopper might type
(type, category, attributes, flavor, English) and the app searches those words too.

- Tags are kept by barcode, so each product is tagged once, and the same barcode in every store shares them.
- Each run tags only barcodes that have no tags yet, in batches, within a daily budget of requests.
- Progress is saved in site/tags.json (published with the prices) and loaded back on the next run, so a
  first run over the whole catalog simply continues over a few days, and a rate-limit error just stops early.
- With no GEMINI_API_KEY (e.g. on the Mac), it does nothing except carry over earlier tags.
"""

import json
import os
import re
import time
import urllib.error
import urllib.request

API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Tried in order; the first one this key can use is kept for the run. Override with GEMINI_MODEL.
MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"]

BATCH = int(os.environ.get("ENRICH_BATCH", "120"))        # products per request
MAX_CALLS = int(os.environ.get("ENRICH_MAX_CALLS", "40"))  # requests per run (free tier has a daily cap)
PAUSE = float(os.environ.get("ENRICH_PAUSE", "13"))        # seconds between requests (free tier ~5 per minute)

# Dairy first, so protein yogurts and friends are searchable after the first run.
FIRST = re.compile(r"יוגורט|חלבון|פרוטאין|\bפרו\b|\bpro\b|מעדן|גבינ|קוטג|חלב|שמנת|לבן|אשל|קפיר", re.I)

PROMPT = """You write search keywords for products in an Israeli supermarket price list.
Product names are in Hebrew, short, often abbreviated, and inconsistent between brands.
For each product, write the words a shopper might type to find it:
- the generic product type in Hebrew (e.g. יוגורט, גבינה לבנה, חלב, חטיף, שמפו, אבקת כביסה)
- the category in Hebrew (e.g. מוצרי חלב, ממתקים, ניקיון, טיפוח, ירקות, קפואים)
- key attributes the name implies, in plain Hebrew: חלבון (for protein / פרו / PRO / פרוטאין), דל שומן, ללא סוכר,
  ללא גלוטן, ללא לקטוז, טבעוני, אורגני, לתינוקות
- the flavor: the flavor word if flavored, or טבעי if the product is plainly unflavored (only for foods that come in flavors)
- the same type in English (e.g. yogurt protein)
Expand abbreviations (ללס = ללא סוכר, ללל = ללא לקטוז). Do not repeat the brand.
Use only what the name implies; if unsure what the product is, give just the type you are sure of.
Answer with 4 to 12 words per product, separated by spaces.

Products (index: name):
"""

SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {"i": {"type": "INTEGER"}, "t": {"type": "STRING"}},
        "required": ["i", "t"],
    },
}


class RateLimited(Exception):
    pass


def load_previous_tags(log):
    url = os.environ.get("PAGES_URL", "").strip()
    if not url:
        return {}
    url = url.rstrip("/") + "/tags.json"
    try:
        with urllib.request.urlopen(url, timeout=30) as res:
            data = json.loads(res.read().decode("utf-8"))
            tags = data.get("tags", {}) if isinstance(data, dict) else {}
            log(f"Loaded {len(tags)} search tags from the last run")
            return tags
    except Exception as err:  # noqa: BLE001
        log(f"No earlier search tags ({err}) – fine on the first run.")
        return {}


def _call(model, key, names):
    lines = "\n".join(f"{i}: {n}" for i, n in enumerate(names))
    body = {
        "contents": [{"role": "user", "parts": [{"text": PROMPT + lines}]}],
        "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json", "responseSchema": SCHEMA},
    }
    req = urllib.request.Request(
        API.format(model=model), data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            reply = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")[:300]
        if err.code == 429:
            raise RateLimited(detail) from err
        raise RuntimeError(f"HTTP {err.code}: {detail}") from err
    text = "".join(p.get("text", "") for p in reply["candidates"][0]["content"]["parts"])
    return json.loads(text)


def clean(words):
    words = re.sub(r"[^\w\s%\-]", " ", str(words), flags=re.U)
    seen, out = set(), []
    for w in words.split():
        w = w.lower()
        if w not in seen:
            seen.add(w)
            out.append(w)
    return " ".join(out[:14])[:140]


def enrich(combined, log, earlier=None):
    """Returns the full {barcode: "search words"} map to publish (earlier tags + today's new ones).
    earlier = the tags inside yesterday's prices.json, a backup in case tags.json can't be loaded."""
    tags = dict(earlier or {})
    tags.update(load_previous_tags(log))
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    todo = [c for c in combined if c not in tags]
    if not key:
        if todo:
            log(f"Search tags: no GEMINI_API_KEY, {len(todo)} products stay untagged this run.")
        return tags
    if not todo:
        log("Search tags: every product already has tags.")
        return tags

    stores = lambda c: sum(1 for p in combined[c][1] if p is not None)  # noqa: E731
    todo.sort(key=lambda c: (not FIRST.search(combined[c][0]), -stores(c)))

    models = [os.environ["GEMINI_MODEL"]] if os.environ.get("GEMINI_MODEL") else list(MODELS)
    added, calls = 0, 0
    log(f"Search tags: {len(todo)} products without tags; tagging up to {MAX_CALLS * BATCH} today.")
    for start in range(0, len(todo), BATCH):
        if calls >= MAX_CALLS:
            break
        batch = todo[start:start + BATCH]
        names = [combined[c][0] for c in batch]
        result = None
        while models and result is None:
            try:
                calls += 1
                result = _call(models[0], key, names)
            except RateLimited as err:
                log(f"   rate limit reached ({err}) – continuing tomorrow.")
                log(f"Search tags: added {added} this run, {len(tags)} in total.")
                return tags
            except RuntimeError as err:
                msg = str(err)
                if "HTTP 404" in msg or ("HTTP 400" in msg and "model" in msg.lower()):
                    log(f"   model {models[0]} not available, trying the next one")
                    models.pop(0)
                    continue
                log(f"   tagging request failed: {err}")
                result = []
            except Exception as err:  # noqa: BLE001
                log(f"   tagging reply could not be read: {err!r}")
                result = []
        if not models:
            log("   no Gemini model available for this key – skipping tags.")
            break
        for row in result or []:
            try:
                i, words = int(row["i"]), clean(row["t"])
            except Exception:  # noqa: BLE001
                continue
            if 0 <= i < len(batch) and words:
                tags[batch[i]] = words
                added += 1
        time.sleep(PAUSE)
    log(f"Search tags: added {added} this run ({calls} requests, model {models[0] if models else '-'}), {len(tags)} in total.")
    return tags
