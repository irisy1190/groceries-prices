# Groceries web app – setup guide

About 15 minutes. No Xcode, no Apple Developer account, no cost.
The web app uses the **same Firebase database** as your iPhone app, so your list,
history, favorites and categories are all already there.

## 1. Get your Firebase web settings
1. Go to **console.firebase.google.com** and open your **Groceries** project.
2. Click the **gear icon** next to "Project Overview" → **Project settings**.
3. Scroll down to **Your apps** → **Add app** → choose the **Web** icon ( **</>** ).
4. Nickname: `Groceries web`. Leave "Firebase Hosting" **unticked**. Click **Register app**.
5. You'll see a block of code with `const firebaseConfig = { ... }`. Keep this page open.

## 2. Put the settings into config.js
1. Unzip **groceries-web.zip** (double-click it in Downloads).
2. Open the `groceries-web` folder, right-click **config.js** → **Open With** → **Xcode**.
   (Use Xcode, not TextEdit – TextEdit can change the quote marks and break the file.)
3. Replace each `"PASTE-HERE"` with the matching value from the Firebase page:
   apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId.
   Keep the quote marks around each value.
4. Save (⌘S).

## 3. Put it online (free, with Netlify)
1. Go to **app.netlify.com/drop** and sign up for a free account (you can use Google).
2. Drag the whole **groceries-web** folder onto the page.
3. After a few seconds you get a link like `https://something-random.netlify.app`.
   You can give it a nicer name: **Site configuration → Change site name**,
   e.g. `our-groceries` → `https://our-groceries.netlify.app`.

## 4. Allow that address in Firebase
1. Firebase console → **Security → Authentication** → **Settings** tab → **Authorized domains**.
2. Click **Add domain** and enter your Netlify address without `https://`,
   e.g. `our-groceries.netlify.app`.

## 5. Install it on both iPhones
1. Open the link in **Safari** (it must be Safari).
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Open it from the new icon on the home screen. It opens full screen, like an app.
4. Send the link to your husband and he does the same.

You can now delete the old Xcode version from your iPhone. Nothing is lost – the list lives in Firebase.

## How to use it
- **Tap** an item to check it off. **Undo** shows for 4 seconds after any change.
- **⋯ on an item:** Move to another category, add to favorites, edit (quantity, note, photo), delete.
- **Bottom:** pick a category chip, type, tap **+**. Suggestions appear while you type.
  Tap the empty field to see your ★ favorites. Long-press a suggestion to forget it.
- The **list icon** inside the text field adds an item with quantity, note or photo.
- **Clear N bought** appears above the add bar when something is checked.
- **Top left:** categories (order, colors, icons) and history.
- **Top right ⋯:** share the list as a text message.
- Tap a category title to collapse or open it.

## Updating the app later
When I send you new files: replace them in the `groceries-web` folder (keep your config.js),
then on Netlify open your site → **Deploys** → drag the folder onto the page again.
Close and reopen the app on the phone to get the new version.
