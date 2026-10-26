# Our Groceries – the app

A shared grocery list for a household, as a web app you add to the iPhone home screen.
Live at **https://our-groceries.netlify.app** (hosted on Netlify, data in Firebase).

## Files

| File | What it is |
|---|---|
| `index.html` | The page and all the styles |
| `app.js` | Everything the app does: list, categories, history, photos, barcode scanner, prices, households |
| `config.js` | The Firebase project settings (safe to be public – access is controlled by `firestore.rules`) |
| `firestore.rules` | Who may read/write what in Firebase. Paste into Firebase console → Firestore → Rules if you change it |
| `sw.js` | Lets the app open offline. **Bump `CACHE` (e.g. `groceries-v18` → `v19`) whenever you change a file**, so phones pick up the update |
| `manifest.json`, `*.png` | Home-screen name and icons |
| `SETUP-WEB.md`, `UPDATE-ACCOUNTS.md` | Older setup notes |

## Publishing a change

1. Edit the files.
2. Bump `CACHE` in `sw.js`.
3. Zip the files (not the folder) and drag the zip onto Netlify → our-groceries → **Deploys**.
4. On the phone, close and reopen the app.

## Store prices

Prices and sales come from the `prices/` folder of this same project (GitHub runs it daily, and the Mac
adds Victory and Super-Pharm). The app reads `https://irisy1190.github.io/groceries-prices/prices.json`,
set in the app under ⋯ → Household & invite → Store prices.
