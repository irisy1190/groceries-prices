// Groceries — web version.
// Uses exactly the same Firebase data as the iPhone app, so both stay in sync.

import { firebaseConfig } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signOut, updateProfile,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  doc, collection, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  writeBatch, query, orderBy, limit, where, Timestamp,
  arrayUnion, arrayRemove, increment, deleteField, FieldPath, Bytes
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() })
});

// Each household has its own list at lists/{householdId}.
// (The list you used before accounts lives at lists/home and becomes your household.)
let householdId = null;
let listRef, itemsCol, knownCol, knownRef, orderRef, historyCol, photosCol;
let unsubscribers = [];

function useHousehold(id) {
  householdId = id;
  listRef = doc(db, 'lists', id);
  itemsCol = collection(listRef, 'items');
  knownCol = collection(listRef, 'known');          // old storage, read once to move it over
  knownRef = doc(listRef, 'meta', 'known');         // new storage: one record for all
  orderRef = doc(listRef, 'meta', 'order');         // the order you dragged items into
  historyCol = collection(listRef, 'history');
  photosCol = collection(listRef, 'photos');
}

const HISTORY_DAYS = 30;

// ---------------------------------------------------------------------------
// Categories, colors, icons (same names as the iPhone app)
// ---------------------------------------------------------------------------

const FALLBACK = 'Supermarket';
const DEFAULTS = ['Supermarket', 'Market', 'Bakery', 'Butcher', 'Pharmacy'];

const PALETTE = [
  ['blue', '#007AFF'], ['green', '#34C759'], ['mint', '#00C7BE'], ['teal', '#30B0C7'],
  ['cyan', '#32ADE6'], ['indigo', '#5856D6'], ['purple', '#AF52DE'], ['pink', '#FF2D55'],
  ['red', '#FF3B30'], ['orange', '#FF9500'], ['yellow', '#FFCC00'], ['brown', '#A2845E'],
  ['gray', '#8E8E93']
];

// The iPhone app stores Apple icon names; here each one is shown as an emoji.
const ICONS = {
  'cart': '🛒', 'basket': '🧺', 'bag': '🛍️', 'leaf': '🥬', 'carrot': '🥕',
  'birthday.cake': '🥖', 'fork.knife': '🥩', 'fish': '🐟', 'cup.and.saucer': '☕',
  'wineglass': '🍷', 'takeoutbag.and.cup.and.straw': '🥤', 'snowflake': '❄️',
  'cross.case': '💊', 'pills': '💊', 'drop': '💧', 'sparkles': '✨', 'house': '🏠',
  'tshirt': '👕', 'stroller': '🍼', 'pawprint': '🐾', 'gift': '🎁', 'flame': '🔥',
  'tag': '🏷️', 'star': '⭐'
};
const ICON_CHOICES = Object.keys(ICONS);

function defaultIcon(cat) {
  return { Supermarket: 'cart', Market: 'leaf', Bakery: 'birthday.cake', Butcher: 'fork.knife', Pharmacy: 'cross.case' }[cat] || 'tag';
}

function defaultColorName(cat) {
  const fixed = { Supermarket: 'blue', Market: 'green', Bakery: 'orange', Butcher: 'red', Pharmacy: 'teal' }[cat];
  if (fixed) return fixed;
  const choices = ['indigo', 'pink', 'purple', 'mint', 'brown', 'cyan', 'yellow'];
  let sum = 0;
  for (const ch of cat) sum += ch.codePointAt(0);
  return choices[sum % choices.length];
}

const colorHex = name => (PALETTE.find(p => p[0] === name) || PALETTE[5])[1];
const catColor = cat => colorHex(state.styles[cat]?.color ?? defaultColorName(cat));
const catIconName = cat => state.styles[cat]?.icon ?? defaultIcon(cat);
const emoji = name => ICONS[name] || '🏷️';
const badge = (cat, extra = '') =>
  `<span class="badge ${extra}" style="background:${catColor(cat)}">${emoji(catIconName(cat))}</span>`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  user: null,
  household: null,   // { name, members, memberInfo, inviteCode }
  ready: false,
  items: [],
  custom: [],
  order: [],
  styles: {},
  names: {},         // { category: the name you renamed it to }
  known: {},
  knownLoaded: false,
  history: [],
  lastAction: null,
  newCategory: FALLBACK,
  focused: false,
  collapsed: loadCollapsed(),
  itemOrder: {}      // { category: [itemKey, ...] } — the order you dragged items into
};

let undoTimer = null;
const photoCache = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const trim = s => String(s ?? '').trim();

/** "  Milk " and "milk" are the same item. Matches the iPhone app. */
const keyFor = name => trim(name).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replaceAll('/', '-');
const validKey = k => k && k !== '.' && k !== '..' && !/^__.*__$/.test(k);

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).toUpperCase();
}

function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem('collapsed') || '[]')); }
  catch { return new Set(); }
}
function saveCollapsed() {
  try { localStorage.setItem('collapsed', JSON.stringify([...state.collapsed])); } catch {}
}

function showError(message) {
  const el = document.createElement('div');
  el.className = 'banner';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

// ---------------------------------------------------------------------------
// Data conversion (same fields as the iPhone app)
// ---------------------------------------------------------------------------

function parseItem(id, d) {
  if (typeof d.name !== 'string') return null;
  return {
    id,
    name: d.name,
    category: d.category ?? FALLBACK,
    quantity: d.quantity ?? '',
    note: d.note ?? '',
    isChecked: !!d.isChecked,
    createdAt: d.createdAt?.toDate?.() ?? new Date(),
    checkedAt: d.checkedAt?.toDate?.() ?? null,
    hasPhoto: !!d.hasPhoto,
    barcode: d.barcode ?? ''
  };
}

function itemData(it) {
  return {
    name: it.name,
    category: it.category,
    quantity: it.quantity,
    note: it.note,
    isChecked: it.isChecked,
    createdAt: Timestamp.fromDate(it.createdAt),
    checkedAt: it.checkedAt ? Timestamp.fromDate(it.checkedAt) : null,
    hasPhoto: !!it.hasPhoto,
    barcode: it.barcode || ''
  };
}

const itemRef = id => doc(itemsCol, id);

// ---------------------------------------------------------------------------
// Categories & sections
// ---------------------------------------------------------------------------

/** The name shown for a category (you can rename any category, e.g. to Hebrew; its ID stays the same). */
function catName(c) {
  return state.names?.[c] || c;
}

function setCategoryName(category, name) {
  name = trim(name);
  const field = new FieldPath('categoryNames', category);
  state.names = { ...(state.names || {}) };
  if (!name || name === category) {
    delete state.names[category];
    return updateDoc(listRef, field, deleteField());
  }
  state.names[category] = name;
  return updateDoc(listRef, field, name);
}

function categories() {
  const all = [...DEFAULTS, ...state.custom.filter(c => !DEFAULTS.includes(c))];
  const ordered = state.order.filter(c => all.includes(c));
  return [...ordered, ...all.filter(c => !ordered.includes(c))];
}

/** Every category in your order (empty ones too, so each has a +), then any others that have items. */
function sections() {
  const order = categories();
  const extra = [...new Set(state.items.map(i => i.category))].filter(c => !order.includes(c)).sort();
  return [...order, ...extra]
    .map(category => {
      const rank = new Map((state.itemOrder[category] || []).map((key, i) => [key, i]));
      const rankOf = item => rank.get(keyFor(item.name)) ?? Infinity;
      return {
        category,
        items: state.items
          .filter(i => i.category === category)
          .sort((a, b) => {
            // Bought items go last; otherwise the order you dragged them into, then newest last.
            if (a.isChecked !== b.isChecked) return a.isChecked ? 1 : -1;
            const ra = rankOf(a), rb = rankOf(b);
            if (ra !== rb) return ra - rb;
            return a.createdAt - b.createdAt;
          })
      };
    })
    
}

// ---------------------------------------------------------------------------
// Item order (drag with the ≡ handle)
// ---------------------------------------------------------------------------

/**
 * Save the new order of one category.
 * Items that aren't on the list right now keep their place next to the items they were near,
 * so they fall back into the right spot when added again.
 */
function saveItemOrder(category, visibleKeys) {
  const prev = state.itemOrder[category] || [];
  const visible = new Set(visibleKeys);
  const leading = [];
  const after = new Map(); // visible key -> hidden keys that came right after it
  let anchor = null;
  for (const key of prev) {
    if (visible.has(key)) { anchor = key; continue; }
    if (anchor === null) leading.push(key);
    else after.set(anchor, [...(after.get(anchor) || []), key]);
  }
  const next = [...leading];
  for (const key of visibleKeys) next.push(key, ...(after.get(key) || []));

  state.itemOrder = { ...state.itemOrder, [category]: next };
  setDoc(orderRef, { orders: { [category]: next } }, { merge: true });
}

// ---------------------------------------------------------------------------
// Live sync
// ---------------------------------------------------------------------------

function stopListening() {
  unsubscribers.forEach(u => { try { u(); } catch {} });
  unsubscribers = [];
}

function resetState() {
  Object.assign(state, {
    household: null, ready: false, items: [], custom: [], order: [], styles: {},
    known: {}, knownLoaded: false, history: [], lastAction: null,
    itemOrder: {}
  });
  photoCache.clear();
}

/** Show the list of one household and keep it in sync. */
function start(id) {
  stopListening();
  resetState();
  useHousehold(id);
  listEl.innerHTML = `<div class="loading">Loading…</div>`;
  showMain();

  const onError = err => {
    if (err.code === 'permission-denied') {
      // Not a member any more (e.g. left on another phone).
      forgetHousehold();
      showHouseholdScreen();
    } else {
      showError(err.message);
    }
  };

  unsubscribers.push(onSnapshot(itemsCol, snap => {
    state.items = snap.docs.map(d => parseItem(d.id, d.data())).filter(Boolean);
    state.ready = true;
    learnUnknownItems();
    renderAll();
  }, onError));

  unsubscribers.push(onSnapshot(listRef, snap => {
    const d = snap.data() || {};
    state.household = {
      name: d.name || 'Our home',
      members: d.members || [],
      memberInfo: d.memberInfo || {},
      inviteCode: d.inviteCode || '',
      pricesUrl: d.pricesUrl || '',
      clubs: d.clubs || []
    };
    $('#title').textContent = state.household.name;
    state.custom = d.categories || [];
    state.order = d.categoryOrder || [];
    state.names = d.categoryNames || {};
    const styles = {};
    for (const [name, v] of Object.entries(d.categoryStyles || {})) {
      if (v && typeof v.color === 'string' && typeof v.icon === 'string') styles[name] = { color: v.color, icon: v.icon };
    }
    state.styles = styles;
    renderAll();
    refreshOpenSheet();
  }, onError));

  // All remembered items (autocomplete & favorites) live in ONE record,
  // so loading them costs 1 read instead of one read per item.
  let migrating = false;
  unsubscribers.push(onSnapshot(knownRef, snap => {
    const d = snap.data() || {};
    if (!d.migrated) {
      // First time on this version: move the old one-record-per-item data over.
      if (!migrating) { migrating = true; migrateKnown(); }
      return;
    }
    const known = {};
    for (const [key, k] of Object.entries(d.items || {})) {
      if (!k || typeof k.name !== 'string') continue;
      known[key] = {
        id: key,
        name: k.name,
        category: k.category ?? FALLBACK,
        count: Number(k.count ?? 0),
        isFavorite: !!k.isFavorite,
        barcode: k.barcode || '',
        lastUsed: k.lastUsed?.toMillis?.() ?? 0
      };
    }
    state.known = known;
    state.knownLoaded = true;
    learnUnknownItems();
    if (!d.historyLearned && !learningHistory) { learningHistory = true; learnFromHistory(); }
    renderList();
    renderAddSuggestions();
  }, onError));

  unsubscribers.push(onSnapshot(orderRef, snap => {
    if (drag) return; // don't redraw under your finger
    state.itemOrder = snap.data()?.orders || {};
    renderList();
  }, onError));

  // History is loaded only while the History screen is open (see openHistory).
  maybeCleanOldHistory();
}

async function migrateKnown() {
  try {
    const old = await getDocs(knownCol);
    const items = {};
    old.docs.forEach(d => {
      const k = d.data();
      if (typeof k.name !== 'string') return;
      items[d.id] = {
        name: k.name,
        category: k.category ?? FALLBACK,
        count: Number(k.count ?? 0),
        isFavorite: !!k.isFavorite
      };
    });
    await setDoc(knownRef, { items, migrated: true }, { merge: true });
  } catch (err) {
    showError(err.message);
  }
}

function parseHistory(d) {
  const h = d.data();
  if (typeof h.action !== 'string' || typeof h.name !== 'string') return null;
  return {
    id: d.id,
    action: h.action,
    name: h.name,
    category: h.category ?? FALLBACK,
    quantity: h.quantity ?? '',
    note: h.note ?? '',
    by: typeof h.by === 'string' ? h.by : '',
    byName: typeof h.byName === 'string' ? h.byName : '',
    date: h.date?.toDate?.() ?? new Date()
  };
}

/** Removes history older than 30 days. Runs at most once a day per phone. */
async function maybeCleanOldHistory() {
  const key = `cleaned:${householdId}`;
  try {
    const last = Number(localStorage.getItem(key) || 0);
    if (Date.now() - last < 86400000) return;
    localStorage.setItem(key, String(Date.now()));
  } catch {}
  try {
    const cutoff = new Date(Date.now() - HISTORY_DAYS * 86400000);
    const old = await getDocs(query(historyCol, where('date', '<', Timestamp.fromDate(cutoff)), limit(400)));
    if (old.empty) return;
    const batch = writeBatch(db);
    old.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  } catch {}
}

// ---------------------------------------------------------------------------
// Autocomplete & favorites
// ---------------------------------------------------------------------------

const openNames = () => new Set(state.items.filter(i => !i.isChecked).map(i => keyFor(i.name)));

// Favorites first, then what you buy most, then most recent.
const byUsefulness = (a, b) =>
  (b.isFavorite - a.isFavorite) || (b.count - a.count) || (b.lastUsed - a.lastUsed) ||
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Every item you've ever added whose name contains what you typed (not ones already on the list). */
function suggestions(text) {
  const q = keyFor(text);
  if (!q) return [];
  const open = openNames();
  return Object.values(state.known)
    .filter(k => k.id.includes(q) && !open.has(k.id))
    .sort((a, b) => (b.id.startsWith(q) - a.id.startsWith(q)) || byUsefulness(a, b));
}

/** With the box empty: everything you've ever added, favorites first (scroll the row sideways). */
function favoritesToAdd() {
  const open = openNames();
  return Object.values(state.known).filter(k => !open.has(k.id)).sort(byUsefulness);
}

/** One time: items from History (bought, deleted…) that autocomplete never learned. */
let learningHistory = false;
async function learnFromHistory() {
  try {
    const snap = await getDocs(query(historyCol, orderBy('date', 'desc'), limit(500)));
    const items = {};
    for (const d of snap.docs) {
      const h = parseHistory(d);
      if (!h || h.action === 'undo') continue;
      const key = keyFor(h.name);
      if (validKey(key) && !state.known[key] && !items[key]) items[key] = { name: h.name, category: h.category };
    }
    await setDoc(knownRef, { items, historyLearned: true }, { merge: true });
  } catch {
    learningHistory = false;
  }
}

const knownCategory = name => state.known[keyFor(name)]?.category;
const isFavorite = name => !!state.known[keyFor(name)]?.isFavorite;

function toggleFavorite(item) {
  const key = keyFor(item.name);
  if (!validKey(key)) return;
  setDoc(knownRef, {
    items: { [key]: { name: item.name, category: item.category, isFavorite: !isFavorite(item.name) } }
  }, { merge: true });
}

function forget(known) {
  updateDoc(knownRef, new FieldPath('items', known.id), deleteField());
}

function remember(name, category, used, barcode = '') {
  const key = keyFor(name);
  if (!validKey(key)) return;
  const entry = { name, category };
  if (barcode) entry.barcode = barcode;
  if (used) {
    entry.count = increment(1);
    entry.lastUsed = Timestamp.now();
  }
  setDoc(knownRef, { items: { [key]: entry } }, { merge: true });
}

/** Items that were added before autocomplete existed get learned too (in one write). */
function learnUnknownItems() {
  if (!state.knownLoaded) return;
  const items = {};
  for (const item of state.items) {
    const key = keyFor(item.name);
    if (validKey(key) && !state.known[key] && !items[key]) items[key] = { name: item.name, category: item.category };
  }
  if (Object.keys(items).length) setDoc(knownRef, { items }, { merge: true });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function logData(action, item) {
  return {
    action,
    name: item.name,
    category: item.category,
    quantity: item.quantity || '',
    note: item.note || '',
    ...byMe(),
    date: Timestamp.now()
  };
}

/** Who did it – saved with each history entry. */
function byMe() {
  return { by: state.user?.uid || '', byName: displayName() };
}

/** "You", or the member's current name (falls back to the name saved at the time). */
function whoDid(h) {
  if (!h.by && !h.byName) return '';
  if (h.by && h.by === state.user?.uid) return 'You';
  return state.household?.memberInfo?.[h.by]?.name || h.byName || '';
}

const log = (action, item) => setDoc(doc(historyCol), logData(action, item));

function recentlyBought() {
  const open = openNames();
  const seen = new Set();
  const result = [];
  for (const h of state.history) {
    if (h.action !== 'bought') continue;
    const k = keyFor(h.name);
    if (open.has(k) || seen.has(k)) continue;
    seen.add(k);
    result.push(h);
  }
  return result;
}

const isOnList = name => openNames().has(keyFor(name));
const restore = h => addItem(h.name, h.category, h.quantity, h.note);

// ---------------------------------------------------------------------------
// Item actions
// ---------------------------------------------------------------------------

function addItem(name, category, quantity = '', note = '', barcode = '') {
  name = trim(name);
  if (!name) return null;
  // A product we scanned before keeps its barcode, however it gets added.
  barcode = barcode || state.known[keyFor(name)]?.barcode || '';
  const item = {
    id: newId(), name, category,
    quantity: trim(quantity), note: trim(note),
    isChecked: false, createdAt: new Date(), checkedAt: null, hasPhoto: false, barcode
  };
  setDoc(itemRef(item.id), itemData(item));
  remember(name, category, true, barcode);
  log('added', item);
  register({ type: 'added', item });
  if (state.collapsed.has(category)) { state.collapsed.delete(category); saveCollapsed(); }
  return item;
}

function updateItem(item) {
  setDoc(itemRef(item.id), itemData(item));
  remember(item.name, item.category, false, item.barcode);
  log('edited', item);
}

// ---------------------------------------------------------------------------
// Barcodes
// ---------------------------------------------------------------------------

const findKnownByBarcode = code => Object.values(state.known).find(k => k.barcode === code);

/** Looks up a product name in Open Food Facts (a free shared product database). */
async function lookupBarcode(code) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_he,product_name_en,brands,quantity`,
      { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const p = data.product;
    if (!p) return null;
    const name = trim(p.product_name_he || p.product_name || p.product_name_en);
    if (!name) return null;
    const brand = trim((p.brands || '').split(',')[0]);
    const full = brand && !name.includes(brand) ? `${name} ${brand}` : name;
    return { name: full, quantity: trim(p.quantity) };
  } catch {
    return null;
  }
}

// ---------- Store prices (from the daily price job on GitHub) ----------

let pricesData = null;
let pricesLoadedAt = 0;
let pricesFrom = '';
let pricesPromise = null;

/** The household's prices link, always ending in prices.json. */
function pricesUrl() {
  let url = trim(state.household?.pricesUrl);
  if (!url) return '';
  if (!/prices\.json$/i.test(url)) url = url.replace(/\/?$/, '/') + 'prices.json';
  return url;
}

/** Loads today's prices (and keeps a copy, so it also works without internet). */
async function loadPrices() {
  const url = pricesUrl();
  if (!url) return null;
  const fresh = pricesData && pricesFrom === url && Date.now() - pricesLoadedAt < 3 * 3600 * 1000;
  if (fresh) return pricesData;
  if (pricesPromise && pricesFrom === url) return pricesPromise;
  pricesFrom = url;
  pricesPromise = (async () => {
    let res = null;
    try {
      res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      try { await (await caches.open('prices')).put(url, res.clone()); } catch {}
    } catch {
      try { res = await (await caches.open('prices')).match(url); } catch { res = null; }
    }
    let data = null;
    try { data = res ? await res.json() : null; } catch { data = null; }
    if (data?.items) { pricesData = data; pricesLoadedAt = Date.now(); }
    return pricesData;
  })();
  try { return await pricesPromise; } finally { pricesPromise = null; }
}

/** Name and per-store prices for a barcode, or null. */
async function priceLookup(code) {
  const data = await loadPrices();
  const row = data?.items?.[code];
  if (!row) return null;
  const [name, prices] = row;
  const today = new Date().toLocaleDateString('sv'); // YYYY-MM-DD, local time
  const stores = (data.stores || []).map((s, i) => ({ ...s, price: prices[i] ?? null, promos: [] }));
  for (const id of data.itemPromos?.[code] || []) {
    const p = data.promos?.[id];
    if (!p || !stores[p[0]] || (p[2] && p[2] < today)) continue;
    stores[p[0]].promos.push({ text: p[1], end: p[2], club: !!p[3] });
  }
  return { name, stores, updated: data.updated };
}

function promoEnd(end) {
  // "2026-10-31" → "31.10"
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(end || '');
  return m ? `${+m[2]}.${+m[1]}` : '';
}

function promoLabel(p) {
  return `${p.text}${p.club ? ' (club)' : ''}${promoEnd(p.end) ? ` till ${promoEnd(p.end)}` : ''}`;
}

/** Price per item with a deal, e.g. "2 for ₪75" or "2 ב-75" → 37.5. Null if the deal can't be worked out. */
function dealEach(price, text) {
  text = String(text || '');
  let m;
  if ((m = /(\d+) for ₪([\d.]+)/.exec(text)) || ((m = /(\d+)\s*ב\s*-?\s*(\d+(?:\.\d+)?)/.exec(text)) && +m[1] > 1)) {
    return +m[2] / +m[1];
  }
  if (price == null) return null;
  // "2nd for ₪10" / "השני ב-10 ₪": two items for the shelf price + 10.
  if ((m = /2nd for ₪([\d.]+)/.exec(text)) || (m = /שני\s*ב\s*-?\s*(\d+(?:\.\d+)?)(?![\d.])(?!\s*%)/.exec(text))) {
    return +m[1] < price ? (price + +m[1]) / 2 : null;
  }
  if ((m = /(?:^|[^\d.])(\d)\s*\+\s*(\d)(?![\d.])/.exec(text))) return price * +m[1] / (+m[1] + +m[2]);
  if ((m = /([\d.]+)\s*%/.exec(text))) {
    const pct = +m[1] / 100;
    if (!(pct > 0 && pct < 1)) return null;
    return /2nd|שני/.test(text) ? price * (2 - pct) / 2 : price * (1 - pct);
  }
  // A single sale price: "₪14.90", "14.90לילי תחבושות" (price first) or "… 14.90 ₪" / "14.90 ש"ח".
  const single = (m = /^₪?(\d+(?:\.\d+)?)(?![\d.])/.exec(text)) ? +m[1]
    : [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:₪|ש"ח|ש״ח|שח)/g)].map(x => +x[1]).pop();
  // Must be a real discount – not a size or pack count that happens to be a number.
  if (single > 0 && single < price - 0.005 && single >= price * 0.2) return single;
  return null;
}

/** Each store's best price per item: the shelf price, or a cheaper deal you can get (club deals count only where you're a member). */
function isClubMember(storeLabel) {
  return (state.household?.clubs || []).includes(storeLabel);
}

function withBestPrices(result) {
  return result.stores.map(s => {
    let each = s.price, deal = null;
    for (const p of s.promos) {
      if (p.club && !isClubMember(s.label)) continue;
      const v = dealEach(s.price, p.text);
      if (v != null && v > 0 && (each == null || v < each - 0.005)) { each = v; deal = p; }
    }
    return { ...s, each, deal };
  });
}

const money = v => `₪${v.toFixed(2)}`;

/** Every way to buy it – each store's shelf price and each of its sales – cheapest per item first. */
function buyOptions(result) {
  if (!result) return [];
  const opts = [];
  for (const s of result.stores) {
    if (s.price != null) opts.push({ store: s.label, each: s.price, price: s.price, deal: null, ok: true });
    for (const p of s.promos) {
      opts.push({ store: s.label, each: dealEach(s.price, p.text), price: s.price, deal: p, ok: !p.club || isClubMember(s.label) });
    }
  }
  // Drop sales that aren't cheaper than that store's shelf price.
  const list = opts.filter(o => !o.deal || o.each == null || o.price == null || o.each < o.price - 0.005);
  return list.sort((a, b) => ((a.each ?? Infinity) - (b.each ?? Infinity)) || (b.ok - a.ok));
}

/** The note for a chosen option, e.g. "Super-Pharm · 2 for ₪75 (₪37.50 each, club) till 3.11". */
function optionNote(o) {
  if (!o.deal) return `${o.store} · ${money(o.price)}`;
  const extra = [o.each != null ? `${money(o.each)} each` : '', o.deal.club ? 'club' : ''].filter(Boolean).join(', ');
  const till = promoEnd(o.deal.end) ? ` till ${promoEnd(o.deal.end)}` : '';
  return `${o.store} · ${o.deal.text}${extra ? ` (${extra})` : ''}${till}`;
}

/** "Where will you buy it?" – tap a store (you can change your mind), pick the category, then Add.
 *  onDone(note, category) gets the chosen store's details as the note. */
function chooseWhereToBuy(result, category, onDone) {
  const opts = buyOptions(result);
  if (!opts.length) return onDone('', category);
  const bestIdx = opts.findIndex(o => o.ok && o.each != null);
  let picked = bestIdx >= 0 ? bestIdx : -1; // -1 = no store note
  let cat = categories().includes(category) ? category : FALLBACK;
  openSheet({
    title: 'Where will you buy it?',
    left: { label: 'Cancel' },
    right: { label: 'Add', action: sh => { sh.close(); onDone(picked >= 0 ? optionNote(opts[picked]) : '', cat); } },
    render(body, sheet) {
      const radio = on => `<span class="radio ${on ? 'on' : ''}"></span>`;
      body.innerHTML = `
        <div class="group-title">Store</div>
        <div class="form prices picks">${opts.map((o, i) => `
          <button class="price-row pick ${i === bestIdx ? 'best' : ''} ${o.ok ? '' : 'not-member'} ${i === picked ? 'picked' : ''}" data-i="${i}">
            ${radio(i === picked)}
            <div class="main">
              <div class="store">${esc(o.store)}${i === bestIdx ? ` <span class="best-tag">${o.deal ? 'Best deal' : 'Cheapest'}</span>` : ''}</div>
              <div class="sub">${o.deal
                ? `🏷️ ${esc(o.deal.text)}${o.deal.club ? (o.ok ? ' · club' : ' · club – not a member') : ''}${promoEnd(o.deal.end) ? ` · till ${esc(promoEnd(o.deal.end))}` : ''}`
                : 'Regular price'}</div>
            </div>
            <div class="amount">${o.each != null ? money(o.each) : ''}${o.deal && o.each != null ? '<span class="diff">each</span>' : ''}</div>
          </button>`).join('')}
          <button class="price-row pick ${picked === -1 ? 'picked' : ''}" data-i="-1">
            ${radio(picked === -1)}<div class="main"><div class="store">No store note</div></div>
          </button>
        </div>
        <div class="footnote">The store you pick is written in the item's note. Club deals count as "best" only for clubs ticked in ⋯ → Household & invite → Store clubs.</div>

        <div class="group-title">Category</div>
        <div class="cat-pick">${categories().map(c => {
          const on = c === cat, color = catColor(c);
          const style = on ? `background:${color};color:#fff` : `background:color-mix(in srgb, ${color} 14%, transparent);color:${color}`;
          return `<button class="chip" data-cat="${esc(c)}" style="${style}">${emoji(catIconName(c))} ${esc(catName(c))}</button>`;
        }).join('')}</div>`;
      body.querySelectorAll('.pick').forEach(btn => btn.onclick = () => {
        picked = +btn.dataset.i;
        if (navigator.vibrate) navigator.vibrate(10);
        sheet.refresh();
      });
      body.querySelectorAll('.cat-pick .chip').forEach(btn => btn.onclick = () => {
        cat = btn.dataset.cat;
        sheet.refresh();
      });
    }
  });
}

function shortDate(stamp) {
  // "202610250500" → "25 Oct"
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(stamp || '');
  if (!m) return '';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function priceTableHTML(result) {
  const all = withBestPrices(result);
  const withPrice = all.filter(s => s.each != null).sort((a, b) => a.each - b.each);
  const without = all.filter(s => s.each == null);
  const bestEach = withPrice[0]?.each;
  const rows = [...withPrice, ...without].map(s => {
    const best = s.each != null && s.each <= bestEach + 0.005 && withPrice.length > 1;
    const dealLine = s.deal ? `<span class="diff deal">${money(s.each)} each on sale</span>` : '';
    const diff = s.each != null && bestEach != null && s.each > bestEach + 0.005
      ? `<span class="diff">+${money(s.each - bestEach)}</span>` : '';
    return `<div class="price-row ${best ? 'best' : ''} ${s.each == null ? 'none' : ''}">
      <div class="main"><div class="store">${esc(s.label)}${best ? ` <span class="best-tag">${s.deal ? 'Best deal' : 'Cheapest'}</span>` : ''}</div>
        <div class="sub">${esc(s.place)}${s.stale ? ` · prices from ${esc(shortDate(s.date))}` : ''}</div>
        ${s.promos.map(p => `<div class="sale">🏷️ ${esc(promoLabel(p))}</div>`).join('')}</div>
      <div class="amount">${s.price != null ? money(s.price) : '<span class="sub">Not sold</span>'}${dealLine}${diff}</div>
    </div>`;
  }).join('');
  const dates = [...new Set(result.stores.filter(s => !s.stale).map(s => shortDate(s.date)).filter(Boolean))];
  return `<div class="form prices">${rows}</div>
    <div class="footnote">Shelf prices${dates.length ? ` from ${esc(dates.join(', '))}` : ''}, from the chains' official price files. 🏷️ = sale running now; stores are ranked by the price per item with sales. "Club" deals count only for clubs you've ticked in Household settings.</div>`;
}

/** "Check a price": scan and see the price in each store, without adding anything. */
function openPriceCheck() {
  if (!pricesUrl()) return openPricesNotSetUp();
  loadPrices(); // start loading while the camera opens
  openScanner(code => openPriceSheet(code));
}

function openPricesNotSetUp() {
  openSheet({
    title: 'Store prices',
    left: { label: 'Close' },
    render(body, sheet) {
      body.innerHTML = `<div class="empty" style="padding:30px 10px"><div class="big">💰</div>
        <h3>Not set up yet</h3>Paste your prices link in ⋯ → Household & invite → Store prices.</div>
        <div class="form"><button class="action" id="goHousehold"><span class="ico">🏠</span>Open Household settings</button></div>`;
      $('#goHousehold', body).onclick = () => { sheet.close(); openHouseholdSettings(); };
    }
  });
}

function openPriceSheet(code) {
  let result;           // undefined = loading, null = not found
  let fallbackName = findKnownByBarcode(code)?.name || '';
  const sheet = openSheet({
    title: 'Price check',
    left: { label: 'Close' },
    right: { label: 'Scan again', action: s => { s.close(); openPriceCheck(); } },
    render(body, s) {
      const name = result?.name || fallbackName;
      const head = `<div class="form"><div class="hist-row"><div class="main">
          <div style="font-weight:600;font-size:18px">${esc(name || 'Unknown product')}</div>
          <div class="sub">Barcode ${esc(code)}</div></div></div></div>`;
      let main;
      if (result === undefined) main = `<div class="loading" style="padding:30px">Looking up prices…</div>`;
      else if (result === null) main = `<div class="empty" style="padding:24px 10px"><div class="big">🔍</div>
          <h3>No prices for this barcode</h3>It isn't sold in your stores, or it's missing from today's price files.</div>`;
      else main = priceTableHTML(result);

      const onList = name && isOnList(name);
      body.innerHTML = `${head}${main}
        <div class="form" style="margin-top:14px">
          ${name ? `<button class="action" id="pcAdd" ${onList ? 'disabled' : ''}><span class="ico">➕</span>${onList ? 'Already on the list' : 'Add to the list'}</button>` : ''}
          <button class="action" id="pcOnline"><span class="ico">🔎</span>Search other stores online</button>
        </div>`;
      const add = $('#pcAdd', body);
      if (add && !onList) add.onclick = () => {
        const known = findKnownByBarcode(code);
        s.close();
        chooseWhereToBuy(result, known?.category || state.newCategory, (note, cat) => addItem(name, cat, '', note, code));
      };
      $('#pcOnline', body).onclick = () => openCompare({ name: name || code, barcode: code, category: state.newCategory });
    }
  });
  priceLookup(code).then(async r => {
    result = r;
    if (!r && !fallbackName) fallbackName = (await lookupBarcode(code))?.name || '';
    sheet.refresh();
  });
}

/** Scan → known product: add it right away. New product: open the editor with what we found. */
function scanToAdd(category = null) {
  openScanner(async code => {
    const known = findKnownByBarcode(code);
    if (known && isOnList(known.name)) return showNotice(`${known.name} is already on the list.`);
    const local = pricesUrl() ? await priceLookup(code).catch(() => null) : null;
    if (known) {
      chooseWhereToBuy(local, category || known.category, (note, cat) => addItem(known.name, cat, '', note, code));
      return;
    }
    showNotice('Looking up the product…');
    // Your stores' price files have the Hebrew product name; otherwise try the online database.
    const found = local ? { name: local.name, quantity: '' } : await lookupBarcode(code);
    hideNotice();
    chooseWhereToBuy(local, category || state.newCategory, (note, cat) => openEditor(null, found?.name || '', cat, {
      barcode: code,
      quantity: found?.quantity || '',
      note,
      hint: found
        ? 'Found this product. Check the name and category, then Save.'
        : "This product isn't known yet. Type its name once – next time the scan will recognize it."
    }));
  });
}

let noticeTimer = null;
function showNotice(text) {
  let el = $('#notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'notice';
    el.className = 'notice';
    document.body.append(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(hideNotice, 3000);
}
function hideNotice() { const el = $('#notice'); if (el) el.hidden = true; }

// ---------- Camera scanner ----------
// Main reader: ZXing compiled to WebAssembly (fast and good at shop barcodes).
// Backup reader: plain-JavaScript ZXing, for phones where the WebAssembly engine won't start.

const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];
let detectorPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the scanner. Check your internet, or type the numbers below.'));
    document.head.append(s);
  });
}

async function wasmDetector() {
  await loadScript('https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/iife/ponyfill.min.js');
  const api = window.BarcodeDetectionAPI;
  if (!api?.BarcodeDetector) throw new Error('reader script did not start');
  await api.prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => {
        const m = path.match(/_(.+?)\.wasm$/);
        return m ? `https://cdn.jsdelivr.net/npm/zxing-wasm@${api.ZXING_WASM_VERSION}/dist/${m[1]}/${path}` : prefix + path;
      }
    },
    fireImmediately: true
  });
  const detector = new api.BarcodeDetector({ formats: BARCODE_FORMATS });
  await detector.detect(new ImageData(8, 8)); // throws if the engine can't run here
  return detector;
}

async function jsDetector() {
  await loadScript('https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js');
  const Z = window.ZXing;
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
    Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.CODE_128
  ]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    backup: true,
    async detect(src) {
      if (src instanceof ImageData) {
        canvas.width = src.width; canvas.height = src.height;
        ctx.putImageData(src, 0, 0);
      } else {
        const scale = Math.min(1, 1600 / Math.max(src.width, src.height));
        canvas.width = Math.round(src.width * scale); canvas.height = Math.round(src.height * scale);
        ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      }
      try {
        const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
        return [{ rawValue: reader.decode(bitmap).getText(), format: 'zxing' }];
      } catch {
        return [];
      } finally {
        reader.reset();
      }
    }
  };
}

function getDetector() {
  if (!detectorPromise) {
    detectorPromise = wasmDetector()
      .catch(err => { console.warn('Main barcode reader unavailable, using the backup:', err); return jsDetector(); })
      .catch(err => { detectorPromise = null; throw err; });
  }
  return detectorPromise;
}

function openScanner(onCode) {
  const view = document.createElement('div');
  view.className = 'scanner';
  view.innerHTML = `
    <div class="scanner-top">
      <span>Point the camera at the barcode</span>
      <button class="scanner-close" id="scanClose">Cancel</button>
    </div>
    <div class="scan-area">
      <video id="scanVideo" playsinline muted autoplay></video>
      <div class="scan-frame" id="scanFrame"></div>
    </div>
    <div class="scanner-bottom">
      <div class="scanner-msg" id="scanMsg">Starting the camera…</div>
      <button class="scan-photo" id="scanPhoto">📷 Take a photo of the barcode instead</button>
      <input type="file" id="scanFile" accept="image/*" capture="environment" hidden>
      <div class="manual">
        <input id="scanManual" inputmode="numeric" placeholder="Or type the barcode numbers">
        <button id="scanManualGo">Use</button>
      </div>
    </div>`;
  document.body.append(view);

  const video = $('#scanVideo', view);
  const msg = text => { if (!done) $('#scanMsg', view).textContent = text; };
  let stream = null;
  let done = false;
  let timer = null;

  const stopCamera = () => {
    clearTimeout(timer);
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
  };
  const close = () => {
    done = true;
    stopCamera();
    view.remove();
  };
  const finish = code => {
    if (done) return;
    code = String(code).replace(/\D/g, '');
    if (code.length < 6) return;
    $('#scanFrame', view).classList.add('hit');
    if (navigator.vibrate) navigator.vibrate(60);
    close();
    onCode(code);
  };
  const firstCode = codes => {
    const c = (codes || []).find(b => /^\d{6,14}$/.test(b.rawValue || ''));
    return c ? c.rawValue : null;
  };

  $('#scanClose', view).onclick = close;
  $('#scanManualGo', view).onclick = () => finish($('#scanManual', view).value);
  $('#scanManual', view).onkeydown = e => { if (e.key === 'Enter') finish(e.target.value); };

  // Photo fallback: the phone's own camera app focuses and exposes better than a live web view.
  $('#scanPhoto', view).onclick = () => $('#scanFile', view).click();
  $('#scanFile', view).onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    msg('Reading the photo…');
    try {
      const detector = await getDetector();
      const bitmap = await createImageBitmap(file);
      const code = firstCode(await detector.detect(bitmap));
      if (code) finish(code);
      else msg('No barcode found in the photo. Try again closer and sharper, or type the numbers.');
    } catch (err) {
      msg(err.message || 'Could not read the photo. Type the numbers below.');
    }
  };

  // A smaller copy of the middle of the picture, where the frame is – faster and more reliable.
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  function grabCenter() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const cw = Math.round(vw * 0.9), ch = Math.round(vh * 0.5);
    const scale = Math.min(1, 1280 / cw);
    canvas.width = Math.round(cw * scale);
    canvas.height = Math.round(ch * scale);
    ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  (async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      msg('Live scanning isn\'t available here – use "Take a photo" or type the numbers.');
      return;
    }
    const detectorReady = getDetector().catch(err => { msg(err.message); return null; });
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
    } catch {
      msg('The camera is not available. Allow camera access, or use "Take a photo" / type the numbers.');
      return;
    }
    if (done) { stopCamera(); return; }
    const track = stream.getVideoTracks()[0];
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch {}
    video.srcObject = stream;
    try { await video.play(); } catch {}
    msg('Loading the scanner…');
    const detector = await detectorReady;
    if (!detector || done) return;
    msg('Fit the barcode inside the box, about 20 cm away.' + (detector.backup ? ' (backup reader)' : ''));

    let misses = 0;
    const tick = async () => {
      if (done) return;
      try {
        const frame = grabCenter();
        const code = frame && firstCode(await detector.detect(frame));
        if (code) return finish(code);
      } catch {}
      if (++misses === 40) msg('Still looking… move a bit farther so it\'s sharp, or tap "Take a photo".');
      timer = setTimeout(tick, 120);
    };
    tick();
  })();
}

// ---------- Compare prices ----------

function openCompare(item) {
  const query = item.barcode || item.name;
  const usePrices = !!(item.barcode && pricesUrl());
  let local; // undefined = loading, null = not found
  const sheet = openSheet({
    title: 'Compare prices',
    left: { label: 'Close' },
    render(body, sheet) {
      let localHTML = '';
      if (usePrices) {
        localHTML = `<div class="group-title">Your stores</div>` + (
          local === undefined ? `<div class="loading" style="padding:20px">Looking up prices…</div>`
          : local === null ? `<div class="footnote" style="margin-top:0">This barcode isn't in your stores' price files today.</div>`
          : priceTableHTML(local));
      }
      body.innerHTML = `
        <div class="form">
          <div class="hist-row">
            ${badge(item.category)}
            <div class="main"><div style="font-weight:500">${esc(item.name)}</div>
            <div class="sub">${item.barcode ? `Barcode ${esc(item.barcode)}` : 'No barcode – searching by name'}</div></div>
          </div>
        </div>
        ${localHTML}
        <div class="group-title">${usePrices ? 'Other stores – search on' : 'Search on'}</div>
        <div class="form">
          <button class="action" data-go="chp"><span class="ico">🛒</span>CHP – supermarket prices near you</button>
          <button class="action" data-go="google"><span class="ico">🔎</span>Google</button>
        </div>
        <div class="footnote">${item.barcode
          ? 'For CHP, the barcode is copied for you – paste it in CHP\'s search box.'
          : 'For CHP, the name is copied for you – paste it in CHP\'s search box. Tip: scan the product\'s barcode (Edit → Scan barcode) for exact results.'}</div>`;
      body.onclick = e => {
        const go = e.target.closest('[data-go]')?.dataset.go;
        if (!go) return;
        if (go === 'chp') {
          // Copy and open in the same tap (Safari blocks pop-ups opened later).
          navigator.clipboard?.writeText(query).catch(() => {});
          window.open('https://chp.co.il/', '_blank');
        } else {
          window.open(`https://www.google.com/search?q=${encodeURIComponent(`${query} מחיר סופר`)}`, '_blank');
        }
        sheet.close();
      };
    }
  });
  if (usePrices) priceLookup(item.barcode).then(r => { local = r; sheet.refresh(); });
}

function toggleItem(item) {
  const nowChecked = !item.isChecked;
  updateDoc(itemRef(item.id), { isChecked: nowChecked, checkedAt: nowChecked ? Timestamp.now() : null });
  log(nowChecked ? 'bought' : 'unchecked', item);
  register({ type: 'toggled', item });
}

function moveItem(item, category) {
  if (item.category === category) return;
  updateDoc(itemRef(item.id), { category });
  remember(item.name, category, false);
  log('moved', { ...item, category });
  register({ type: 'moved', item, to: category });
}

function deleteItem(item) {
  deleteDoc(itemRef(item.id));
  log('deleted', item);
  register({ type: 'deleted', item });
}

function clearChecked() {
  const checked = state.items.filter(i => i.isChecked);
  if (!checked.length) return;
  const batch = writeBatch(db);
  checked.forEach(i => {
    batch.delete(itemRef(i.id));
    batch.set(doc(historyCol), logData('cleared', i));
  });
  batch.commit();
  register({ type: 'cleared', items: checked });
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

function actionMessage(a) {
  switch (a.type) {
    case 'added': return `Added ${a.item.name}`;
    case 'toggled': return a.item.isChecked ? `Unchecked ${a.item.name}` : `Checked ${a.item.name}`;
    case 'deleted': return `Deleted ${a.item.name}`;
    case 'moved': return `Moved ${a.item.name} to ${catName(a.to)}`;
    case 'cleared': return `Cleared ${a.items.length} item${a.items.length === 1 ? '' : 's'}`;
  }
  return '';
}

function register(action) {
  state.lastAction = action;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    if (state.lastAction === action) { state.lastAction = null; renderBottom(); }
  }, 4000);
  renderBottom();
}

function undo() {
  const a = state.lastAction;
  if (!a) return;
  if (a.type === 'added') {
    deleteDoc(itemRef(a.item.id));
  } else if (a.type === 'cleared') {
    const batch = writeBatch(db);
    a.items.forEach(i => batch.set(itemRef(i.id), itemData(i)));
    batch.commit();
  } else {
    setDoc(itemRef(a.item.id), itemData(a.item));
  }
  setDoc(doc(historyCol), { action: 'undo', name: actionMessage(a), category: '', ...byMe(), date: Timestamp.now() });
  clearTimeout(undoTimer);
  state.lastAction = null;
  renderBottom();
}

// ---------------------------------------------------------------------------
// Photos (stored small, inside the database, like the iPhone app)
// ---------------------------------------------------------------------------

async function getPhoto(id) {
  if (photoCache.has(id)) return photoCache.get(id);
  try {
    const snap = await getDoc(doc(photosCol, id));
    const bytes = snap.data()?.jpeg;
    if (!bytes) return null;
    const url = URL.createObjectURL(new Blob([bytes.toUint8Array()], { type: 'image/jpeg' }));
    photoCache.set(id, url);
    return url;
  } catch {
    return null;
  }
}

async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    let quality = 0.7;
    let blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
    while (blob && blob.size > 600000 && quality > 0.2) {
      quality -= 0.15;
      blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
    }
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function setPhoto(blob, id) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  photoCache.set(id, URL.createObjectURL(blob));
  setDoc(doc(photosCol, id), { jpeg: Bytes.fromUint8Array(bytes) });
  updateDoc(itemRef(id), { hasPhoto: true });
}

function removePhoto(id) {
  photoCache.delete(id);
  deleteDoc(doc(photosCol, id));
  updateDoc(itemRef(id), { hasPhoto: false });
}

// ---------------------------------------------------------------------------
// Category settings
// ---------------------------------------------------------------------------

function addCategory(name) {
  name = trim(name);
  if (!name || categories().some(c => c === name || catName(c) === name)) return;
  setDoc(listRef, { categories: arrayUnion(name) }, { merge: true });
}

function removeCategory(name) {
  if (DEFAULTS.includes(name)) return;
  setDoc(listRef, { categories: arrayRemove(name) }, { merge: true });
}

function setStyle(category, color, icon) {
  state.styles[category] = { color, icon };
  setDoc(listRef, { categoryStyles: { [category]: { color, icon } } }, { merge: true });
  renderAll();
}

function resetStyle(category) {
  delete state.styles[category];
  updateDoc(listRef, new FieldPath('categoryStyles', category), deleteField());
  renderAll();
}

// ---------------------------------------------------------------------------
// Share as text
// ---------------------------------------------------------------------------

function shareText() {
  const lines = [];
  for (const s of sections()) {
    const open = s.items.filter(i => !i.isChecked);
    if (!open.length) continue;
    lines.push(catName(s.category));
    for (const i of open) {
      let line = `• ${i.name}`;
      if (i.quantity) line += ` – ${i.quantity}`;
      if (i.note) line += ` (${i.note})`;
      lines.push(line);
    }
    lines.push('');
  }
  if (!lines.length) return '🛒 The grocery list is empty, everything is bought!';
  return ['🛒 Grocery list', '', ...lines].join('\n').trim();
}

async function shareList() {
  const text = shareText();
  try {
    if (navigator.share) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(text);
      alert('The list was copied. Paste it in any message.');
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Rendering: main list
// ---------------------------------------------------------------------------

const listEl = $('#list');

function renderAll() {
  renderList();
  renderBottom();
}

function renderList() {
  if (!state.ready || drag) return;
  const secs = sections();
  const hint = state.items.length ? '' : `<div class="empty small"><h3>Your list is empty</h3>Tap + next to a category to add an item.</div>`;
  const html = hint + secs.map(s => {
    const adding = state.adding === s.category;
    const collapsed = state.collapsed.has(s.category) && !adding;
    const empty = !s.items.length;
    const left = s.items.filter(i => !i.isChecked).length;
    const count = empty ? '' : left === 0 ? `<span class="count done">✓ Done</span>` : `<span class="count">${left} left</span>`;
    const addRow = adding ? addRowHTML(s.category) : '';
    const rows = collapsed || (empty && !adding) ? ''
      : `<div class="card" data-cat="${esc(s.category)}">${s.items.map(rowHTML).join('')}${addRow}</div>`;
    return `<section class="cat ${collapsed ? 'collapsed' : ''} ${empty ? 'empty-cat' : ''}" data-cat="${esc(s.category)}">
      <button class="cat-head" data-cat="${esc(s.category)}">
        ${badge(s.category)}<span class="cat-name">${esc(catName(s.category))}</span>${count}<span class="cat-add" role="button" aria-label="Add an item to ${esc(catName(s.category))}">+</span><span class="chev">▼</span>
      </button>${rows}</section>`;
  }).join('');

  // While you're typing a new item, keep that box (and the keyboard) where it is; redraw everything around it.
  const liveRow = listEl.querySelector('.add-row');
  if (liveRow && liveRow.contains(document.activeElement)) {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const liveSec = liveRow.closest('section');
    const newSec = [...temp.children].find(el => el.matches('section') && el.dataset.cat === liveSec.dataset.cat);
    if (newSec) {
      liveSec.className = newSec.className;
      liveSec.querySelector('.cat-head').replaceWith(newSec.querySelector('.cat-head'));
      const liveCard = liveRow.parentElement;
      liveCard.querySelectorAll(':scope > .row').forEach(r => r.remove());
      newSec.querySelectorAll('.card > .row').forEach(r => liveCard.insertBefore(r, liveRow));
      [...listEl.children].forEach(el => { if (el !== liveSec) el.remove(); });
      let before = true;
      for (const el of [...temp.children]) {
        if (el === newSec) { before = false; continue; }
        if (before) listEl.insertBefore(el, liveSec); else listEl.append(el);
      }
      loadThumbs();
      return;
    }
  }
  listEl.innerHTML = html;
  loadThumbs();
}

function loadThumbs() {
  listEl.querySelectorAll('img.thumb[data-photo]:not([src])').forEach(async img => {
    const url = await getPhoto(img.dataset.photo);
    if (url) img.src = url;
  });
}

const SCAN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>`;

function addRowHTML(category) {
  return `<div class="add-row" data-cat="${esc(category)}">
      <span class="check ghost"></span>
      <input class="add-input" placeholder="New item" autocomplete="off" autocorrect="on" enterkeyhint="next" dir="auto" aria-label="New item in ${esc(catName(category))}">
      <button class="add-scan" aria-label="Scan a barcode into ${esc(catName(category))}">${SCAN_ICON}</button>
    </div>
    <div class="chips add-sugg"></div>`;
}

function rowHTML(i) {
  const star = isFavorite(i.name) ? `<span class="star">★</span>` : '';
  const qty = i.quantity ? `<span class="qty">${esc(i.quantity)}</span>` : '';
  const note = i.note ? `<div class="note">${esc(i.note)}</div>` : '';
  const thumb = i.hasPhoto ? `<img class="thumb" data-photo="${esc(i.id)}" alt="Photo">` : '';
  return `<div class="row ${i.isChecked ? 'checked' : ''}" data-id="${esc(i.id)}" data-key="${esc(keyFor(i.name))}">
    <span class="check">${i.isChecked ? '✓' : ''}</span>
    <div class="txt"><div class="name"><span class="name-text">${esc(i.name)}</span>${star}${qty}</div>${note}</div>
    ${thumb}
    <button class="more" aria-label="More options">⋯</button>
    <span class="handle" aria-label="Drag to reorder">≡</span>
  </div>`;
}

// ---------- Drag to reorder: the ≡ handle, or a long press on the item ----------

let drag = null;
let press = null; // a long press waiting to become a drag: { timer, x, y, row, pointerId }
const LONG_PRESS_MS = 450;

listEl.addEventListener('pointerdown', e => {
  const handle = e.target.closest('.handle');
  if (handle) {
    e.preventDefault();
    startDrag(handle.closest('.row'), e.pointerId, e.clientY, handle);
    return;
  }
  // Long press anywhere on an item (not its ⋯ button or photo) picks it up.
  const row = e.target.closest('.row');
  if (!row || e.target.closest('.more, .thumb') || e.button > 0) return;
  cancelPress();
  press = { x: e.clientX, y: e.clientY, row, pointerId: e.pointerId };
  press.timer = setTimeout(() => {
    const p = press;
    press = null;
    if (!p || !p.row.isConnected) return;
    if (navigator.vibrate) navigator.vibrate(25);
    startDrag(p.row, p.pointerId, p.lastY ?? p.y, p.row);
  }, LONG_PRESS_MS);
});

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

// While dragging, stop the page from scrolling under your finger (iPhone needs this on touchmove).
listEl.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
listEl.addEventListener('contextmenu', e => { if (drag || press) e.preventDefault(); });

function startDrag(row, pointerId, clientY, captureEl) {
  const card = row.parentElement;
  const rows = [...card.querySelectorAll('.row')];
  const rects = rows.map(r => {
    const b = r.getBoundingClientRect();
    return { top: b.top + window.scrollY, height: b.height };
  });
  // Every other category on screen, so you can drop the item into it.
  const pageRect = el => { const b = el.getBoundingClientRect(); return { top: b.top + window.scrollY, bottom: b.bottom + window.scrollY, left: b.left, width: b.width }; };
  const others = [...listEl.querySelectorAll('.card')].filter(c => c !== card).map(c => ({
    cat: c.dataset.cat, el: c, rect: pageRect(c),
    rows: [...c.querySelectorAll('.row')].map(r => ({ key: r.dataset.key, ...pageRect(r) }))
  }));
  const heads = [...listEl.querySelectorAll('.cat-head')].filter(h => h.dataset.cat !== card.dataset.cat)
    .map(h => ({ cat: h.dataset.cat, el: h, rect: pageRect(h) }));
  drag = {
    row, card, rows, rects, others, heads,
    home: pageRect(card),
    index: rows.indexOf(row),
    target: rows.indexOf(row),
    cross: null, // { cat, index, el } when hovering another category
    startY: clientY + window.scrollY,
    lastClientY: clientY
  };
  row.classList.add('dragging');
  try { captureEl.setPointerCapture(pointerId); } catch {}
  drag.scrollTimer = setInterval(autoScroll, 16);
}

let dropLine = null;
function showDropLine(left, width, pageY) {
  if (!dropLine) {
    dropLine = document.createElement('div');
    dropLine.className = 'drop-line';
    document.body.append(dropLine);
  }
  Object.assign(dropLine.style, { left: `${left + 10}px`, width: `${width - 20}px`, top: `${pageY - 1.5}px` });
}
function clearCross() {
  if (drag?.cross) drag.cross.el.classList.remove('drop-target');
  if (drag) drag.cross = null;
  dropLine?.remove();
  dropLine = null;
}

/** Is the finger over another category? Then that's where the item goes. */
function crossTarget(pageY) {
  const { home, others, heads } = drag;
  if (pageY >= home.top - 12 && pageY <= home.bottom + 12) return null;
  for (const o of others) {
    if (pageY < o.rect.top - 12 || pageY > o.rect.bottom + 12) continue;
    let index = 0;
    o.rows.forEach(r => { if ((r.top + r.bottom) / 2 < pageY) index++; });
    const lineY = index === 0 ? o.rect.top : index >= o.rows.length ? o.rect.bottom : o.rows[index].top;
    return { cat: o.cat, index, el: o.el, line: [o.rect.left, o.rect.width, lineY] };
  }
  for (const h of heads) {
    if (pageY >= h.rect.top - 4 && pageY <= h.rect.bottom + 4) {
      const o = others.find(x => x.cat === h.cat);
      return { cat: h.cat, index: o ? o.rows.length : 0, el: h.el, line: null };
    }
  }
  return null;
}

function moveDrag(clientY) {
  if (!drag) return;
  drag.lastClientY = clientY;
  const { rows, rects, index } = drag;
  const dy = clientY + window.scrollY - drag.startY;
  drag.row.style.transform = `translateY(${dy}px)`;

  const cross = crossTarget(clientY + window.scrollY);
  if (cross) {
    // Over another category: close the gap at home and mark where it will land.
    if (!drag.cross || drag.cross.el !== cross.el) { clearCross(); cross.el.classList.add('drop-target'); }
    drag.cross = cross;
    if (cross.line) showDropLine(...cross.line); else { dropLine?.remove(); dropLine = null; }
    rows.forEach((r, i) => { if (i !== index) r.style.transform = ''; });
    drag.target = index;
    return;
  }
  if (drag.cross) clearCross();
  const center = rects[index].top + rects[index].height / 2 + dy;
  let target = 0;
  rects.forEach((r, i) => { if (i !== index && r.top + r.height / 2 < center) target++; });
  drag.target = target;
  const h = rects[index].height;
  rows.forEach((r, i) => {
    if (i === index) return;
    let shift = 0;
    if (i > index && i <= target) shift = -h;
    if (i < index && i >= target) shift = h;
    r.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function autoScroll() {
  if (!drag) return;
  const y = drag.lastClientY;
  const bottomLimit = window.innerHeight - ($('#bottom').offsetHeight || 0) - 30;
  let step = 0;
  if (y < 140) step = -10;
  else if (y > bottomLimit) step = 10;
  if (step) {
    window.scrollBy(0, step);
    moveDrag(y);
  }
}

listEl.addEventListener('pointermove', e => {
  if (press && e.pointerId === press.pointerId) {
    // Moved before the long press finished: it's a scroll or a swipe, not a pick-up.
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancelPress();
    else press.lastY = e.clientY;
  }
  if (!drag) return;
  e.preventDefault();
  moveDrag(e.clientY);
});

function endDrag() {
  if (!drag) return;
  clearInterval(drag.scrollTimer);
  const { rows, index, target, card, cross } = drag;
  clearCross();
  rows.forEach(r => { r.style.transform = ''; });
  drag.row.classList.remove('dragging');
  if (cross) {
    // Dropped on another category: move it there, at the spot where it was let go.
    const item = state.items.find(i => i.id === drag.row.dataset.id);
    const other = drag.others.find(o => o.cat === cross.cat);
    const keys = (other ? other.rows.map(r => r.key) : []).filter(k => k !== drag.row.dataset.key);
    keys.splice(Math.min(cross.index, keys.length), 0, drag.row.dataset.key);
    drag = null;
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 50);
    if (item) {
      saveItemOrder(cross.cat, keys);
      moveItem(item, cross.cat);
      if (navigator.vibrate) navigator.vibrate(15);
    }
    return;
  }
  const ordered = rows.filter((_, i) => i !== index);
  ordered.splice(target, 0, rows[index]);
  drag = null;
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 50);
  if (target !== index) {
    ordered.forEach(r => card.append(r));
    saveItemOrder(card.dataset.cat, ordered.map(r => r.dataset.key));
  }
}
let justDragged = false;
listEl.addEventListener('pointerup', () => { cancelPress(); endDrag(); });
listEl.addEventListener('pointercancel', () => { cancelPress(); endDrag(); });

listEl.addEventListener('click', e => {
  if (e.target.closest('.handle') || justDragged) return; // the handle is only for dragging
  if (e.target.closest('.add-row, .add-sugg')) return;
  const plus = e.target.closest('.cat-add');
  if (plus) return startAdding(plus.closest('.cat-head').dataset.cat);
  const head = e.target.closest('.cat-head');
  if (head && head.closest('.empty-cat')) return startAdding(head.dataset.cat);
  if (head) {
    const cat = head.dataset.cat;
    state.collapsed.has(cat) ? state.collapsed.delete(cat) : state.collapsed.add(cat);
    saveCollapsed();
    renderList();
    return;
  }
  const row = e.target.closest('.row');
  if (!row) return;
  const item = state.items.find(i => i.id === row.dataset.id);
  if (!item) return;
  if (e.target.closest('.more')) return openItemActions(item);
  if (e.target.closest('.thumb')) {
    const src = e.target.closest('.thumb').src;
    if (src) return openViewer(src);
  }
  toggleItem(item);
});

// ---------------------------------------------------------------------------
// Adding items: tap + on a category, type in the new row that opens there
// ---------------------------------------------------------------------------

const addInput = () => listEl.querySelector('.add-input');

/** The + on a category (or tapping an empty category): open a new row in it, keyboard up. */
function startAdding(category) {
  if (state.adding && state.adding !== category) commitAdd();
  state.adding = category;
  state.newCategory = category;
  state.collapsed.delete(category);
  saveCollapsed();
  renderList();
  const inp = addInput();
  if (inp) {
    inp.focus();
    inp.closest('.add-row').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  renderAddSuggestions();
  renderBottom();
}

/** Add what's typed (if anything) to the open category. */
function commitAdd(text) {
  const inp = addInput();
  const name = trim(text ?? inp?.value ?? '');
  if (inp) inp.value = '';
  if (name && state.adding) addItem(name, state.adding);
  renderAddSuggestions();
}

function stopAdding() {
  if (!state.adding) return;
  commitAdd();
  state.adding = null;
  renderList();
  renderBottom();
}

function renderAddSuggestions() {
  const box = listEl.querySelector('.add-sugg');
  const inp = addInput();
  if (!box || !inp) return;
  const typed = !!trim(inp.value);
  const list = typed ? suggestions(inp.value) : favoritesToAdd();
  box.innerHTML = list.map(k =>
    `<button class="chip sugg" data-known="${esc(k.id)}" style="border-color:color-mix(in srgb, ${catColor(k.category)} 40%, transparent)">
      ${emoji(catIconName(k.category))} ${esc(k.name)}${k.isFavorite ? ' <span class="star">★</span>' : ''}
    </button>`).join('');
}

function renderBottom() {
  const a = state.lastAction;
  const toast = $('#toast');
  toast.hidden = !a;
  if (a) $('#toastMsg').textContent = actionMessage(a);

  const checked = state.items.filter(i => i.isChecked).length;
  const showClear = checked > 0 && !a && !state.adding;
  $('#clearWrap').hidden = !showClear;
  $('#clearBtn').textContent = `✓ Clear ${checked} bought`;
  requestAnimationFrame(updateBottomHeight);
}

function updateBottomHeight() {
  document.documentElement.style.setProperty('--bottom-h', `${$('#bottom').offsetHeight}px`);
}

// Typing in the new row
listEl.addEventListener('input', e => { if (e.target.matches('.add-input')) renderAddSuggestions(); });
listEl.addEventListener('keydown', e => {
  if (!e.target.matches('.add-input') || e.key !== 'Enter') return;
  e.preventDefault();
  commitAdd(); // stays open for the next item
});
listEl.addEventListener('focusout', e => {
  if (!e.target.matches('.add-input')) return;
  setTimeout(() => {
    // Still inside the new row (e.g. tapped a suggestion)? Keep going.
    if (listEl.querySelector('.add-row')?.contains(document.activeElement)) return;
    if (state.scanningFor) return;
    stopAdding();
  }, 150);
});
// Tapping a suggestion or the scan button shouldn't close the keyboard first.
listEl.addEventListener('pointerdown', e => {
  if (e.target.closest('.add-sugg [data-known], .add-scan')) e.preventDefault();
});
listEl.addEventListener('click', e => {
  const chip = e.target.closest('.add-sugg [data-known]');
  if (chip) {
    const k = state.known[chip.dataset.known];
    if (k && state.adding) commitAdd(k.name);
    addInput()?.focus();
    return;
  }
  if (e.target.closest('.add-scan')) {
    const cat = state.adding;
    commitAdd();
    state.scanningFor = cat;
    state.adding = null;
    renderList();
    renderBottom();
    state.scanningFor = null;
    scanToAdd(cat);
  }
}, true);

// Long-press a suggestion to forget it (e.g. a typo).
let pressTimer = null;
listEl.addEventListener('touchstart', e => {
  const chip = e.target.closest('.add-sugg [data-known]');
  if (!chip) return;
  pressTimer = setTimeout(() => {
    const k = state.known[chip.dataset.known];
    if (k && confirm(`Forget the suggestion "${k.name}"?`)) forget(k);
  }, 600);
}, { passive: true });
for (const ev of ['touchend', 'touchmove', 'touchcancel']) {
  listEl.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true });
}

$('#undoBtn').addEventListener('click', undo);
$('#clearBtn').addEventListener('click', clearChecked);

$('#catsBtn').addEventListener('click', openCategories);
$('#histBtn').addEventListener('click', openHistory);
$('#menuBtn').addEventListener('click', openMenu);
$('#priceBtn').addEventListener('click', openPriceCheck);

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

let openSheets = [];

function openSheet({ title, left, right, full, render, onClose }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="sheet ${full ? 'full' : ''}">
    <div class="sheet-head">
      <button class="link left">${esc(left?.label ?? '')}</button>
      <h2>${esc(title)}</h2>
      <button class="link strong right">${esc(right?.label ?? '')}</button>
    </div>
    <div class="sheet-body"></div>
  </div>`;
  const body = $('.sheet-body', overlay);
  const sheet = {
    overlay, body,
    close() {
      overlay.remove();
      openSheets = openSheets.filter(s => s !== sheet);
      if (onClose) onClose();
    },
    refresh() { if (render) render(body, sheet); },
    setRightEnabled(on) { $('.right', overlay).disabled = !on; }
  };
  $('.left', overlay).addEventListener('click', () => (left?.action ? left.action(sheet) : sheet.close()));
  $('.right', overlay).addEventListener('click', () => right?.action?.(sheet));
  overlay.addEventListener('click', e => { if (e.target === overlay) sheet.close(); });
  document.body.append(overlay);
  openSheets.push(sheet);
  sheet.refresh();
  return sheet;
}

/** Sheets that show live data re-draw when the data changes. */
function refreshOpenSheet() {
  openSheets.forEach(s => s.live && s.refresh());
}

// ---------- Item actions (the ⋯ on each row) ----------

function openItemActions(item) {
  const fav = isFavorite(item.name);
  openSheet({
    title: item.name,
    left: { label: 'Cancel' },
    render(body, sheet) {
      body.innerHTML = `<div class="form">
        <button class="action" data-a="edit"><span class="ico">✏️</span>Edit</button>
        <button class="action" data-a="fav"><span class="ico">${fav ? '☆' : '⭐'}</span>${fav ? 'Remove from favorites' : 'Add to favorites'}</button>
        <button class="action danger" data-a="delete"><span class="ico">🗑️</span>Delete</button>
      </div>`;
      body.onclick = e => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (!a) return;
        sheet.close();
        if (a === 'fav') toggleFavorite(item);
        if (a === 'edit') openEditor(item);
        if (a === 'delete') deleteItem(item);
      };
    }
  });
}

function openMoveTo(item) {
  openSheet({
    title: `Move ${item.name}`,
    left: { label: 'Cancel' },
    render(body, sheet) {
      body.innerHTML = `<div class="form">${categories().filter(c => c !== item.category).map(c =>
        `<button class="action" data-cat="${esc(c)}" style="color:var(--text)">${badge(c)}${esc(catName(c))}</button>`).join('')}</div>`;
      body.onclick = e => {
        const c = e.target.closest('[data-cat]')?.dataset.cat;
        if (!c) return;
        moveItem(item, c);
        sheet.close();
      };
    }
  });
}

// ---------- Add / edit item ----------

function openEditor(existing, defaultName = '', defaultCategory = FALLBACK, extra = {}) {
  const draft = {
    name: existing?.name ?? defaultName,
    category: existing?.category ?? defaultCategory,
    quantity: existing?.quantity ?? extra.quantity ?? '',
    note: existing?.note ?? extra.note ?? '',
    barcode: existing?.barcode ?? extra.barcode ?? '',
    hint: extra.hint || '',
    photoURL: null,
    newPhoto: null,
    photoRemoved: false
  };

  const sheet = openSheet({
    title: existing ? 'Edit item' : 'New item',
    full: true,
    left: { label: 'Cancel' },
    right: {
      label: 'Save',
      action(s) {
        if (!trim(draft.name)) return;
        if (existing) {
          const item = {
            ...existing,
            name: trim(draft.name),
            category: draft.category,
            quantity: trim(draft.quantity),
            note: trim(draft.note),
            barcode: draft.barcode,
            hasPhoto: !!draft.newPhoto || (existing.hasPhoto && !draft.photoRemoved)
          };
          updateItem(item);
          if (existing.barcode && !draft.barcode) {
            const key = keyFor(item.name);
            if (validKey(key)) updateDoc(knownRef, new FieldPath('items', key, 'barcode'), deleteField()).catch(() => {});
          }
          if (draft.newPhoto) setPhoto(draft.newPhoto, item.id);
          else if (draft.photoRemoved) removePhoto(item.id);
        } else {
          const item = addItem(draft.name, draft.category, draft.quantity, draft.note, draft.barcode);
          if (item && draft.newPhoto) setPhoto(draft.newPhoto, item.id);
        }
        s.close();
      }
    },
    render(body, s) {
      const cats = categories();
      if (!cats.includes(draft.category)) cats.push(draft.category);
      body.innerHTML = `
        ${draft.hint ? `<div class="hint">${esc(draft.hint)}</div>` : ''}
        <div class="form" style="margin-top:6px">
          <input id="edName" placeholder="Item" value="${esc(draft.name)}">
          <div class="line"><span>Category</span>
            <select id="edCat">${cats.map(c => `<option value="${esc(c)}" ${c === draft.category ? 'selected' : ''}>${esc(catName(c))}</option>`).join('')}</select>
          </div>
        </div>
        <div class="group-title">Quantity</div>
        <div class="form">
          <input id="edQty" placeholder="e.g. 2, 1 kg, a big pack" value="${esc(draft.quantity)}">
        </div>
        <div class="group-title">Note</div>
        <div class="form">
          <textarea id="edNote" rows="3" placeholder="e.g. 3% fat, the one with the blue label">${esc(draft.note)}</textarea>
        </div>
        <div class="group-title">Photo</div>
        <div class="form">
          ${draft.photoURL ? `<img class="preview" src="${draft.photoURL}" alt="Photo">` : ''}
          <label class="action"><span class="ico">📷</span>${draft.photoURL ? 'Take or choose another photo' : 'Take or choose a photo'}
            <input id="edFile" type="file" accept="image/*" hidden>
          </label>
          ${draft.photoURL ? `<button class="action danger" id="edRemove"><span class="ico">🗑️</span>Remove photo</button>` : ''}
        </div>
        <div class="group-title">Barcode</div>
        <div class="form">
          ${draft.barcode ? `<div class="hist-row"><div class="main"><div class="barcode-num">${esc(draft.barcode)}</div>
            <div class="sub">Scanning this product again will add it right away.</div></div></div>` : ''}
          <button class="action" id="edScan"><span class="ico">📷</span>${draft.barcode ? 'Scan again' : 'Scan barcode'}</button>
          ${draft.barcode ? `<button class="action danger" id="edNoCode"><span class="ico">🗑️</span>Remove barcode</button>` : ''}
        </div>
        <div class="footnote">With a barcode, scanning this product next time recognizes it right away.</div>`;

      const name = $('#edName', body);
      name.oninput = () => { draft.name = name.value; s.setRightEnabled(!!trim(name.value)); };
      $('#edCat', body).onchange = e => { draft.category = e.target.value; };
      $('#edQty', body).oninput = e => { draft.quantity = e.target.value; };
      $('#edNote', body).oninput = e => { draft.note = e.target.value; };
      $('#edFile', body).onchange = async e => {
        const file = e.target.files?.[0];
        if (!file) return;
        const blob = await compressImage(file).catch(() => null);
        if (!blob) return showError("Couldn't read that photo.");
        draft.newPhoto = blob;
        draft.photoRemoved = false;
        draft.photoURL = URL.createObjectURL(blob);
        s.refresh();
      };
      const remove = $('#edRemove', body);
      if (remove) remove.onclick = () => {
        draft.newPhoto = null;
        draft.photoURL = null;
        draft.photoRemoved = true;
        s.refresh();
      };
      $('#edScan', body).onclick = () => openScanner(async code => {
        draft.barcode = code;
        draft.hint = '';
        if (!trim(draft.name)) {
          const known = findKnownByBarcode(code);
          const found = known ? { name: known.name } : await lookupBarcode(code);
          if (found?.name) draft.name = found.name;
          if (known) draft.category = known.category;
        }
        s.refresh();
      });
      const noCode = $('#edNoCode', body);
      if (noCode) noCode.onclick = () => { draft.barcode = ''; s.refresh(); };
      s.setRightEnabled(!!trim(draft.name));
    }
  });

  if (existing?.hasPhoto) {
    getPhoto(existing.id).then(url => {
      if (url && !draft.newPhoto && !draft.photoRemoved) { draft.photoURL = url; sheet.refresh(); }
    });
  }
  if (!existing) setTimeout(() => $('#edName', sheet.body)?.focus(), 300);
}

// ---------- Menu (⋯ at the top) ----------

function openMenu() {
  openSheet({
    title: 'More',
    left: { label: 'Close' },
    render(body, sheet) {
      body.innerHTML = `<div class="form">
        <button class="action" data-a="household"><span class="ico">🏠</span>Household & invite</button>
        <button class="action" data-a="share"><span class="ico">📤</span>Share list as text</button>
      </div>`;
      body.onclick = e => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (!a) return;
        sheet.close();
        if (a === 'household') openHouseholdSettings();
        if (a === 'share') shareList();
        if (a === 'cats') openCategories();
      };
    }
  });
}

// ---------- Categories ----------

function setCategoryOrder(order) {
  state.order = order;
  setDoc(listRef, { categoryOrder: order }, { merge: true });
  renderAll();
}

/** Drag rows inside `box` to reorder them: by the ≡ handle, or a long press on the row.
 *  onDrop(keys) gets the rows' data-key values in their new order. */
function makeSortable(box, onDrop) {
  let s = null, press = null;
  const scroller = box.closest('.sheet-body') || document.scrollingElement;
  const begin = (row, pointerId, clientY, captureEl) => {
    const rows = [...box.querySelectorAll('[data-key]')];
    const rects = rows.map(r => r.getBoundingClientRect()).map(b => ({ mid: b.top + b.height / 2, h: b.height }));
    s = { row, rows, rects, index: rows.indexOf(row), target: rows.indexOf(row), startY: clientY, startScroll: scroller.scrollTop };
    row.classList.add('dragging');
    box.classList.add('sorting');
    try { captureEl.setPointerCapture(pointerId); } catch {}
  };
  const move = clientY => {
    const { rows, rects, index } = s;
    const scrolled = scroller.scrollTop - s.startScroll;
    const dy = clientY - s.startY + scrolled;
    s.row.style.transform = `translateY(${dy}px)`;
    const center = rects[index].mid + dy - scrolled;
    let target = 0;
    rects.forEach((r, i) => { if (i !== index && r.mid - scrolled < center) target++; });
    s.target = target;
    rows.forEach((r, i) => {
      if (i === index) return;
      const shift = i > index && i <= target ? -rects[index].h : i < index && i >= target ? rects[index].h : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const end = () => {
    if (press) { clearTimeout(press.timer); press = null; }
    if (!s) return;
    const { rows, index, target } = s;
    rows.forEach(r => { r.style.transform = ''; });
    s.row.classList.remove('dragging');
    box.classList.remove('sorting');
    s = null;
    box.dataset.justDragged = '1';
    setTimeout(() => { delete box.dataset.justDragged; }, 50);
    if (target === index) return;
    const ordered = rows.filter((_, i) => i !== index);
    ordered.splice(target, 0, rows[index]);
    onDrop(ordered.map(r => r.dataset.key));
  };
  box.addEventListener('pointerdown', e => {
    const row = e.target.closest('[data-key]');
    if (!row) return;
    const handle = e.target.closest('.handle');
    if (handle) { e.preventDefault(); begin(row, e.pointerId, e.clientY, handle); return; }
    if (e.target.closest('input, button') || e.button > 0) return; // typing a name or tapping the icon
    press = { x: e.clientX, y: e.clientY, lastY: e.clientY, row, pointerId: e.pointerId };
    press.timer = setTimeout(() => {
      const p = press; press = null;
      if (navigator.vibrate) navigator.vibrate(25);
      begin(p.row, p.pointerId, p.lastY, p.row);
    }, LONG_PRESS_MS);
  });
  box.addEventListener('pointermove', e => {
    if (press) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) { clearTimeout(press.timer); press = null; }
      else press.lastY = e.clientY;
    }
    if (!s) return;
    e.preventDefault();
    move(e.clientY);
  });
  box.addEventListener('touchmove', e => { if (s) e.preventDefault(); }, { passive: false });
  box.addEventListener('contextmenu', e => { if (s || press) e.preventDefault(); });
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  return () => !!s;
}

function openCategories() {
  const sheet = openSheet({
    title: 'Categories',
    full: true,
    right: { label: 'Done', action: s => s.close() },
    render(body, s) {
      // Don't redraw while you're typing a new name or dragging a category.
      if (body.contains(document.activeElement) && document.activeElement.matches('.cat-name-input')) return;
      if (s.isSorting?.()) return;
      const cats = categories();
      body.innerHTML = `
        <div class="group-title">Shopping order</div>
        <div class="form" id="catSort">${cats.map(c => `
          <div class="cat-row" data-key="${esc(c)}">
            <button class="badge-btn" data-style="${esc(c)}" aria-label="Color and icon">${badge(c)}</button>
            <input class="cat-name-input" data-rename="${esc(c)}" value="${esc(catName(c))}" placeholder="${esc(c)}" enterkeyhint="done" dir="auto" aria-label="Category name">
            ${DEFAULTS.includes(c) ? '' : `<button class="mini del" data-del="${esc(c)}" aria-label="Delete">✕</button>`}
            <span class="handle" aria-label="Drag to reorder">≡</span>
          </div>`).join('')}
        </div>
        <div class="footnote">Drag ≡ (or hold a category) to put them in the order you shop. Tap a name to rename it (e.g. in Hebrew); clear it to go back to the original. Tap the icon to change its color and icon.</div>
        <div class="group-title">Add a category</div>
        <div class="form add-cat">
          <input id="newCat" placeholder="New category" enterkeyhint="done">
          <button class="link strong" id="addCat">Add</button>
        </div>`;
      const add = () => {
        const v = $('#newCat', body).value;
        if (!trim(v)) return;
        addCategory(v);
        $('#newCat', body).value = '';
      };
      body.querySelectorAll('.cat-name-input').forEach(inp => {
        const save = () => {
          const c = inp.dataset.rename;
          if (trim(inp.value) !== catName(c)) { setCategoryName(c, inp.value); renderAll(); }
          if (!trim(inp.value)) inp.value = c;
        };
        inp.onchange = save;
        inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); };
      });
      s.isSorting = makeSortable($('#catSort', body), keys => { setCategoryOrder(keys); s.refresh(); });
      $('#addCat', body).onclick = add;
      $('#newCat', body).onkeydown = e => { if (e.key === 'Enter') add(); };
      body.onclick = e => {
        const t = e.target.closest('button');
        if (!t) return;
        if ($('#catSort', body).dataset.justDragged) return;
        if (t.dataset.del && confirm(`Delete "${catName(t.dataset.del)}"? Its items stay on the list.`)) removeCategory(t.dataset.del);
        if (t.dataset.style) openStyleEditor(t.dataset.style);
      };
    }
  });
  sheet.live = true;
}

function openStyleEditor(category) {
  const draft = {
    name: catName(category),
    color: state.styles[category]?.color ?? defaultColorName(category),
    icon: state.styles[category]?.icon ?? defaultIcon(category)
  };
  openSheet({
    title: 'Edit category',
    full: true,
    left: { label: 'Cancel' },
    right: { label: 'Save', action(s) {
      const input = $('#catNameInput', s.body);
      if (input) draft.name = input.value;
      setStyle(category, draft.color, draft.icon);
      if (trim(draft.name) !== catName(category)) setCategoryName(category, draft.name);
      s.close(); renderAll(); refreshOpenSheet();
    } },
    render(body, s) {
      body.innerHTML = `
        <div class="style-preview">
          <span class="badge" style="background:${colorHex(draft.color)}">${emoji(draft.icon)}</span>
          <strong>${esc(draft.name || category)}</strong>
        </div>
        <div class="group-title">Name</div>
        <div class="form add-cat">
          <input id="catNameInput" value="${esc(draft.name)}" placeholder="${esc(category)}" enterkeyhint="done" dir="auto">
        </div>
        ${state.names?.[category] ? `<div class="footnote">Original name: ${esc(category)}. Clear the box and Save to go back to it.</div>` : ''}
        <div class="group-title">Color</div>
        <div class="form"><div class="grid">${PALETTE.map(([name, hex]) =>
          `<button class="swatch" data-color="${name}" style="background:${hex}" aria-label="${name}">${name === draft.color ? '✓' : ''}</button>`).join('')}
        </div></div>
        <div class="group-title">Icon</div>
        <div class="form"><div class="grid">${ICON_CHOICES.map(name =>
          `<button class="icon-choice ${name === draft.icon ? 'on' : ''}" data-icon="${name}">${emoji(name)}</button>`).join('')}
        </div></div>
        ${state.styles[category] ? `<button class="reset" id="reset">Back to default</button>` : ''}`;
      body.onclick = e => {
        const t = e.target.closest('button');
        if (!t) return;
        const keepName = () => { const i = $('#catNameInput', body); if (i) draft.name = i.value; };
        if (t.dataset.color) { keepName(); draft.color = t.dataset.color; s.refresh(); }
        if (t.dataset.icon) { keepName(); draft.icon = t.dataset.icon; s.refresh(); }
        if (t.id === 'reset') { resetStyle(category); s.close(); refreshOpenSheet(); }
      };
    }
  });
}

// ---------- History ----------

const ACTIONS = {
  added: ['Added', '+', '#007AFF'],
  bought: ['Bought', '✓', '#3D9E73'],
  unchecked: ['Unchecked', '↩', '#8E8E93'],
  deleted: ['Deleted', '✕', '#FF3B30'],
  cleared: ['Cleared', '✓', '#FF3B30'],
  moved: ['Moved', '→', '#FF9500'],
  edited: ['Edited', '✎', '#AF52DE'],
  undo: ['Undo:', '↶', '#8E8E93']
};

function dayTitle(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function relative(d) {
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const mins = Math.round((d - Date.now()) / 60000);
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

const timeOf = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function openHistory() {
  let tab = 'bought';
  let loaded = false;
  let stop = null;
  const sheet = openSheet({
    title: 'History',
    full: true,
    right: { label: 'Done', action: s => s.close() },
    onClose: () => { if (stop) stop(); state.history = []; },
    render(body) {
      if (!loaded) { body.innerHTML = `<div class="loading">Loading…</div>`; return; }
      let html = `<div class="tabs">
        <button data-tab="bought" class="${tab === 'bought' ? 'on' : ''}">Recently bought</button>
        <button data-tab="activity" class="${tab === 'activity' ? 'on' : ''}">Activity</button>
      </div>`;

      if (tab === 'bought') {
        const list = recentlyBought();
        html += list.length
          ? `<div class="form" style="margin-top:12px">${list.map(h => `
              <div class="hist-row">
                ${badge(h.category)}
                <div class="main"><div style="font-weight:500">${esc(h.name)}</div><div class="sub">Bought ${relative(h.date)}</div></div>
                <button class="add-circle" data-restore="${esc(h.id)}" aria-label="Add again">+</button>
              </div>`).join('')}</div>
             <div class="footnote">Tap + to put an item back on the list.</div>`
          : `<div class="empty"><div class="big">🛍️</div><h3>Nothing here yet</h3>Items you check off will show up here, ready to add again.</div>`;
      } else {
        const groups = new Map();
        for (const h of state.history) {
          const key = new Date(h.date).toDateString();
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(h);
        }
        html += groups.size
          ? [...groups.values()].map(entries => `
              <div class="group-title" style="text-transform:none;font-size:15px;font-weight:600;color:var(--text)">${esc(dayTitle(entries[0].date))}</div>
              <div class="form">${entries.map(h => {
                const [verb, icon, color] = ACTIONS[h.action] || ['', '•', '#8E8E93'];
                const title = h.action === 'undo'
                  ? `${verb} ${esc(h.name)}`
                  : h.action === 'moved'
                    ? `${verb} <strong>${esc(h.name)}</strong> to ${esc(catName(h.category))}`
                    : `${verb} <strong>${esc(h.name)}</strong>`;
                const who = whoDid(h);
                const sub = [h.action === 'undo' ? '' : esc(catName(h.category)), who ? `<span class="who">${esc(who)}</span>` : '', timeOf(h.date)]
                  .filter(Boolean).join(' · ');
                const canRestore = (h.action === 'deleted' || h.action === 'cleared') && !isOnList(h.name);
                return `<div class="hist-row">
                  <span class="dot" style="background:${color}">${icon}</span>
                  <div class="main"><div>${title}</div><div class="sub">${sub}</div></div>
                  ${canRestore ? `<button class="small-btn" data-restore="${esc(h.id)}">Restore</button>` : ''}
                </div>`;
              }).join('')}</div>`).join('')
          : `<div class="empty"><div class="big">🕘</div><h3>No activity yet</h3>Everything added, bought or deleted in the last 30 days shows up here.</div>`;
      }

      body.innerHTML = html;
      body.onclick = e => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.dataset.tab) { tab = t.dataset.tab; sheet.refresh(); }
        if (t.dataset.restore) {
          const h = state.history.find(x => x.id === t.dataset.restore);
          if (h) { restore(h); sheet.refresh(); }
        }
      };
    }
  });
  sheet.live = true;

  // Load history only now, and keep it live only while this screen is open.
  stop = onSnapshot(query(historyCol, orderBy('date', 'desc'), limit(150)), snap => {
    state.history = snap.docs.map(parseHistory).filter(Boolean);
    loaded = true;
    sheet.refresh();
  }, err => showError(err.message));
}

// ---------- Photo viewer ----------

function openViewer(src) {
  const v = document.createElement('div');
  v.className = 'viewer';
  v.innerHTML = `<img src="${src}" alt="Photo"><button>Done</button>`;
  v.addEventListener('click', () => v.remove());
  document.body.append(v);
}

// ---------------------------------------------------------------------------
// Accounts & households
// ---------------------------------------------------------------------------

const gate = $('#gate');
const userDoc = uid => doc(db, 'users', uid);
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups

const savedHouseholdKey = () => `household:${state.user?.uid}`;
function rememberHousehold(id) { try { localStorage.setItem(savedHouseholdKey(), id); } catch {} }
function savedHousehold() { try { return localStorage.getItem(savedHouseholdKey()); } catch { return null; } }
function forgetHousehold() {
  try { localStorage.removeItem(savedHouseholdKey()); } catch {}
  if (state.user) setDoc(userDoc(state.user.uid), { householdId: null }, { merge: true }).catch(() => {});
}

function showMain() {
  gate.hidden = true;
  document.body.classList.remove('gated');
}

function showGate(html) {
  stopListening();
  closeAllSheets();
  gate.innerHTML = `<div class="gate-card">${html}</div>`;
  gate.hidden = false;
  document.body.classList.add('gated');
  window.scrollTo(0, 0);
}

function closeAllSheets() {
  [...openSheets].forEach(s => s.close());
}

const displayName = () => state.user?.displayName || state.user?.email?.split('@')[0] || 'there';

function friendlyAuthError(err) {
  const code = err?.code || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found'))
    return 'Wrong email or password.';
  if (code.includes('email-already-in-use')) return 'There is already an account with this email. Try signing in.';
  if (code.includes('weak-password')) return 'The password needs at least 6 characters.';
  if (code.includes('invalid-email')) return "That email address doesn't look right.";
  if (code.includes('missing-password')) return 'Please enter a password.';
  if (code.includes('too-many-requests')) return 'Too many tries. Wait a few minutes and try again.';
  if (code.includes('network')) return 'No internet connection. Check it and try again.';
  if (code.includes('permission-denied')) return "You don't have access to that. Check the code and try again.";
  return err?.message || 'Something went wrong. Please try again.';
}

// ---------- Sign in / create account ----------

function showAuthScreen(mode = 'signin') {
  const signup = mode === 'signup';
  showGate(`
    <img class="gate-icon" src="apple-touch-icon.png?v=3" alt="">
    <h2>Groceries</h2>
    <p class="gate-sub">A shared grocery list for your home.</p>
    <div class="tabs">
      <button data-mode="signin" class="${signup ? '' : 'on'}">Sign in</button>
      <button data-mode="signup" class="${signup ? 'on' : ''}">Create account</button>
    </div>
    <div class="form">
      ${signup ? `<input id="gName" placeholder="Your name" autocomplete="name">` : ''}
      <input id="gEmail" type="email" placeholder="Email" autocomplete="email" autocapitalize="off" inputmode="email">
      <input id="gPass" type="password" placeholder="${signup ? 'Password (at least 6 characters)' : 'Password'}"
             autocomplete="${signup ? 'new-password' : 'current-password'}">
    </div>
    <button class="big-btn" id="gGo">${signup ? 'Create account' : 'Sign in'}</button>
    ${signup ? '' : `<button class="link gate-link" id="gForgot">Forgot password?</button>`}
    <div class="gate-msg" id="gMsg"></div>`);

  const msg = (text, ok = false) => { const m = $('#gMsg'); m.textContent = text; m.classList.toggle('ok', ok); };
  gate.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => showAuthScreen(b.dataset.mode));

  const go = async () => {
    const email = trim($('#gEmail').value);
    const pass = $('#gPass').value;
    const btn = $('#gGo');
    btn.disabled = true;
    msg('');
    try {
      if (signup) {
        const name = trim($('#gName').value);
        if (!name) { msg('Please enter your name.'); btn.disabled = false; return; }
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await updateProfile(cred.user, { displayName: name });
        await setDoc(userDoc(cred.user.uid), { name, email, householdId: null }, { merge: true });
        state.user = cred.user;
        showHouseholdScreen();
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
    } catch (err) {
      msg(friendlyAuthError(err));
      btn.disabled = false;
    }
  };
  $('#gGo').onclick = go;
  $('#gPass').onkeydown = e => { if (e.key === 'Enter') go(); };

  const forgot = $('#gForgot');
  if (forgot) forgot.onclick = async () => {
    const email = trim($('#gEmail').value);
    if (!email) return msg('Type your email above, then tap "Forgot password?" again.');
    try {
      await sendPasswordResetEmail(auth, email);
      msg('We sent you an email with a link to choose a new password.', true);
    } catch (err) {
      msg(friendlyAuthError(err));
    }
  };
}

// ---------- Create or join a household ----------

function showHouseholdScreen() {
  showGate(`
    <h2>Hi ${esc(displayName())} 👋</h2>
    <p class="gate-sub">Set up your household's list. Everyone in a household shares one list.</p>

    <div class="group-title">Start a new household</div>
    <div class="form"><input id="hName" placeholder="Name, e.g. The Levi family"></div>
    <button class="big-btn" id="hCreate">Create household</button>

    <div class="group-title">Or join one</div>
    <div class="form"><input id="hCode" placeholder="Invite code, e.g. K7P-4QX" autocapitalize="characters" autocomplete="off"></div>
    <button class="big-btn secondary" id="hJoin">Join household</button>

    <div class="gate-msg" id="hMsg"></div>
    <button class="link gate-link small" id="hClaim">Used Groceries before accounts? Move your existing list here</button>
    <button class="link gate-link small" id="hOut">Sign out (${esc(state.user?.email || '')})</button>`);

  const msg = text => { $('#hMsg').textContent = text; };
  const busy = on => gate.querySelectorAll('.big-btn, .gate-link').forEach(b => b.disabled = on);

  $('#hCreate').onclick = async () => {
    busy(true); msg('');
    try { await createHousehold(trim($('#hName').value) || `${displayName()}'s home`); }
    catch (err) { msg(friendlyAuthError(err)); busy(false); }
  };
  $('#hJoin').onclick = async () => {
    busy(true); msg('');
    try { await joinHousehold($('#hCode').value); }
    catch (err) { msg(err.userMessage || friendlyAuthError(err)); busy(false); }
  };
  $('#hClaim').onclick = async () => {
    if (!confirm('Move the list you used before accounts into a household with you as its first member? Do this only if it was YOUR list.')) return;
    busy(true); msg('');
    try { await claimOldList(trim($('#hName').value) || 'Our home'); }
    catch (err) {
      msg(err.code === 'permission-denied'
        ? 'That list was already moved into a household. Ask its members for their invite code.'
        : friendlyAuthError(err));
      busy(false);
    }
  };
  $('#hOut').onclick = () => signOut(auth);
}

async function newInviteCode(id) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = '';
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    for (const b of bytes) code += CODE_LETTERS[b % CODE_LETTERS.length];
    const ref = doc(db, 'invites', code);
    const existing = await getDoc(ref).catch(() => null);
    if (existing?.exists?.()) continue;
    await setDoc(ref, { householdId: id, createdBy: state.user.uid, createdAt: Timestamp.now() });
    return code;
  }
  throw new Error('Could not make an invite code. Please try again.');
}

const formatCode = c => (c && c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c || '');
const memberEntry = () => ({ name: displayName(), email: state.user.email || '' });

async function enterHousehold(id) {
  await setDoc(userDoc(state.user.uid), { householdId: id, name: displayName(), email: state.user.email || '' }, { merge: true });
  rememberHousehold(id);
  start(id);
}

async function createHousehold(name) {
  const ref = doc(collection(db, 'lists'));
  const uid = state.user.uid;
  await setDoc(ref, {
    name,
    members: [uid],
    memberInfo: { [uid]: memberEntry() },
    ownerUid: uid,
    createdAt: Timestamp.now()
  });
  const code = await newInviteCode(ref.id);
  await updateDoc(ref, { inviteCode: code });
  await enterHousehold(ref.id);
}

async function claimOldList(name) {
  const ref = doc(db, 'lists', 'home');
  const uid = state.user.uid;
  await setDoc(ref, {
    name,
    members: [uid],
    memberInfo: { [uid]: memberEntry() },
    ownerUid: uid
  }, { merge: true });
  const code = await newInviteCode('home');
  await updateDoc(ref, { inviteCode: code });
  await enterHousehold('home');
}

async function joinHousehold(rawCode) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) {
    const e = new Error(); e.userMessage = 'The code has 6 letters and numbers, like K7P-4QX.'; throw e;
  }
  const invite = await getDoc(doc(db, 'invites', code));
  const id = invite.data()?.householdId;
  if (!id) {
    const e = new Error(); e.userMessage = "That code doesn't exist. Check it and try again."; throw e;
  }
  const uid = state.user.uid;
  await updateDoc(doc(db, 'lists', id),
    'members', arrayUnion(uid),
    new FieldPath('memberInfo', uid), memberEntry(),
    'lastJoinCode', code);
  await enterHousehold(id);
}

// ---------- Household settings (from the ⋯ menu) ----------

function inviteMessage() {
  const link = location.origin + location.pathname.replace(/index\.html$/, '');
  return `Join our grocery list 🛒\n\n1. Open ${link} in Safari\n2. Create an account\n3. Tap "Join household" and enter the code: ${formatCode(state.household?.inviteCode)}`;
}

function openHouseholdSettings() {
  let pricesMessage = '';
  const sheet = openSheet({
    title: 'Household',
    full: true,
    right: { label: 'Done', action: s => s.close() },
    render(body, sheet) {
      const h = state.household || { name: '', members: [], memberInfo: {} };
      const clubStores = (pricesData?.stores || []).map(st => st.label);
      if (!pricesData && pricesUrl()) loadPrices().then(d => { if (d && body.isConnected) sheet.refresh(); });
      const members = h.members.map(uid => {
        const info = h.memberInfo[uid] || {};
        const me = uid === state.user?.uid;
        return `<div class="hist-row">
          <span class="dot" style="background:var(--accent)">${esc((info.name || '?').slice(0, 1).toUpperCase())}</span>
          <div class="main"><div>${esc(info.name || 'Member')}${me ? ' <span class="sub">(you)</span>' : ''}</div>
          <div class="sub">${esc(info.email || '')}</div></div>
        </div>`;
      }).join('');

      body.innerHTML = `
        <div class="group-title">Name</div>
        <div class="form add-cat">
          <input id="hhName" value="${esc(h.name)}" placeholder="Household name">
          <button class="link strong" id="hhSave">Save</button>
        </div>

        <div class="group-title">Invite someone</div>
        <div class="form invite">
          <div class="code">${esc(formatCode(h.inviteCode)) || '—'}</div>
          <button class="action" id="hhShare"><span class="ico">📤</span>Send the invite</button>
        </div>
        <div class="footnote">They open the app, create an account, tap "Join household" and type this code.</div>

        <div class="group-title">Members</div>
        <div class="form">${members || '<div class="hist-row sub">No members</div>'}</div>

        <div class="group-title">Store prices</div>
        <div class="form add-cat">
          <input id="hhPrices" value="${esc(h.pricesUrl || '')}" placeholder="Your prices link (from GitHub)" autocapitalize="off" autocorrect="off" inputmode="url">
          <button class="link strong" id="hhPricesSave">Save</button>
        </div>
        <div class="footnote" id="hhPricesMsg">${h.pricesUrl
          ? `Shared with everyone in this household. <a href="${esc(h.pricesUrl.replace(/prices\.json$/i, ''))}" target="_blank">Open the status page</a>`
          : 'Paste the link of your GitHub price page, e.g. https://yourname.github.io/groceries-prices/'}</div>

        ${clubStores.length ? `<div class="group-title">Store clubs</div>
        <div class="form">${clubStores.map(label => `
          <button class="action club-toggle" data-store="${esc(label)}">
            <span class="ico">${(h.clubs || []).includes(label) ? '✅' : '⬜️'}</span>${esc(label)} club member</button>`).join('')}
        </div>
        <div class="footnote">Tick the stores whose club you (or someone in your home) belong to. Their club deals then count when the app picks the best price.</div>` : ''}

        <div class="group-title">Account</div>
        <div class="form">
          <div class="hist-row"><div class="main"><div>${esc(displayName())}</div><div class="sub">${esc(state.user?.email || '')}</div></div></div>
          <button class="action" id="hhOut"><span class="ico">🚪</span>Sign out</button>
          <button class="action danger" id="hhLeave"><span class="ico">↩️</span>Leave this household</button>
        </div>
        <div class="footnote">Leaving removes you from this list. The others keep it. You can join again with the code.</div>`;

      body.querySelectorAll('.club-toggle').forEach(btn => btn.onclick = async () => {
        const label = btn.dataset.store;
        const on = !(state.household.clubs || []).includes(label);
        state.household = { ...state.household, clubs: on
          ? [...(state.household.clubs || []), label]
          : (state.household.clubs || []).filter(c => c !== label) };
        sheet.refresh();
        await updateDoc(listRef, { clubs: on ? arrayUnion(label) : arrayRemove(label) });
      });
      $('#hhSave', body).onclick = () => {
        const name = trim($('#hhName', body).value);
        if (name) updateDoc(listRef, { name });
      };
      if (pricesMessage) $('#hhPricesMsg', body).textContent = pricesMessage;
      $('#hhPricesSave', body).onclick = async () => {
        let url = trim($('#hhPrices', body).value);
        if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
        const show = text => { pricesMessage = text; const m = $('#hhPricesMsg', sheet.body); if (m) m.textContent = text; };
        state.household = { ...state.household, pricesUrl: url };
        pricesData = null;
        show(url ? 'Checking the link…' : 'Store prices turned off.');
        await updateDoc(listRef, { pricesUrl: url });
        if (!url) return;
        const data = await loadPrices();
        show(data
          ? `✓ Works: ${Object.keys(data.items).length.toLocaleString()} products from ${data.stores.length} stores.`
          : "Saved, but the prices couldn't be loaded yet. Check the link, or wait for the first daily run on GitHub.");
      };
      $('#hhShare', body).onclick = async () => {
        const text = inviteMessage();
        try {
          if (navigator.share) await navigator.share({ text });
          else { await navigator.clipboard.writeText(text); alert('The invite was copied. Paste it in any message.'); }
        } catch {}
      };
      $('#hhOut', body).onclick = () => signOut(auth);
      $('#hhLeave', body).onclick = async () => {
        if (!confirm(`Leave "${h.name}"? You'll stop seeing this list.`)) return;
        const uid = state.user.uid;
        try {
          stopListening();
          await updateDoc(listRef, 'members', arrayRemove(uid), new FieldPath('memberInfo', uid), deleteField());
          forgetHousehold();
          showHouseholdScreen();
        } catch (err) {
          showError(friendlyAuthError(err));
        }
      };
    }
  });
  sheet.live = true;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

renderBottom();
new ResizeObserver(updateBottomHeight).observe($('#bottom'));

if (firebaseConfig.apiKey === 'PASTE-HERE') {
  listEl.innerHTML = `<div class="empty"><div class="big">🔧</div><h3>Almost there</h3>Paste your Firebase web settings into <b>config.js</b> (see the setup guide).</div>`;
} else {
  onAuthStateChanged(auth, async user => {
    // The old version signed in anonymously; those sessions need a real account now.
    if (user?.isAnonymous) { await signOut(auth); return; }
    state.user = user;
    if (!user) { stopListening(); resetState(); showAuthScreen(); return; }

    // Open straight away if this phone knows the household (also works offline)…
    const known = savedHousehold();
    if (known) { start(known); return; }

    // …otherwise look it up.
    try {
      const snap = await getDoc(userDoc(user.uid));
      const id = snap.data()?.householdId;
      if (id) { rememberHousehold(id); start(id); }
      else showHouseholdScreen();
    } catch {
      showHouseholdScreen();
    }
  });
}
