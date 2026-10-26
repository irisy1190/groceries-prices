# Update: accounts & households

Do the steps **in this order**. About 15 minutes.
Your list, history, favorites, categories and photos are kept – step 4 moves them into your household.

## 1. Turn on email sign-in (Firebase)
1. Firebase console → your **Groceries** project → **Security → Authentication** → **Sign-in method** tab.
2. Click **Add new provider** → **Email/Password** → turn on the first switch (**Email/Password**) → **Save**.
   (Leave "Email link" off.)

## 2. Publish the new security rules (Firebase)
1. Firebase console → **Databases & Storage → Firestore** → **Rules** tab.
2. Delete everything there, and paste the whole content of **firestore.rules** from the new folder.
   (Open it with Xcode, select all with ⌘A, copy with ⌘C.)
3. Click **Publish**.

From this moment, only signed-in members of a household can see its list.
The old Xcode iPhone app stops working now – that's expected, you can delete it.

## 3. Upload the new version (Netlify)
1. Unzip the new **groceries-web.zip**.
2. Copy your **config.js** from the old `groceries-web` folder into the new one (replace the empty one).
   Your config.js has your Firebase settings – the new one only has `PASTE-HERE`.
3. Netlify → your site → **Deploys** → drag the new folder onto the page.

## 4. You: create your account and move your list (do this first!)
1. On your iPhone, close the Groceries app completely and open it again. You'll see **Sign in / Create account**.
   (If you still see the old list, close and open it once more.)
2. Tap **Create account**, enter your name, email and a password.
3. On the next screen, type a household name at the top (e.g. "Our home"), then tap the link at the bottom:
   **"Used Groceries before accounts? Move your existing list here"** → OK.
4. Your list appears, with your household name as the title.

Do this before anyone else signs up – the old list can be moved only once, by the first person who does it.

## 5. Your husband joins
1. In the app tap **⋯ → Household & invite** → **Send the invite**, and send it to him.
2. He opens the app, taps **Create account**, then types the code under **Or join one** → **Join household**.
3. He now sees the same list. Check **⋯ → Household & invite** – you should both be under Members.

## 6. Friends
Send them the link (or the same invite text, without the code). They create an account and tap
**Create household** – they get their own empty list and their own invite code for their partner.
They never see your list, and you don't see theirs in the app.

## Good to know
- **Forgot password:** on the sign-in screen, type the email and tap "Forgot password?" – an email arrives with a reset link.
  (It may land in spam the first time.)
- **Leaving:** ⋯ → Household & invite → Leave this household. The others keep the list.
- **Optional clean-up:** Firebase → Authentication → Sign-in method → **Anonymous** → turn it off. The app doesn't use it any more.
- **Who can see what:** as the owner of the Firebase project, you can technically see every household's data in the Firebase console.
  It's fair to tell friends that.
- **Free plan:** plenty for a handful of households. Photos use the most space.
