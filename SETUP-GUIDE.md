# Setup Guide — Email Sign-In & Database (free, ~10 minutes)

Your tracker needs a **Firebase** project. Firebase is Google's free backend
service — it gives you email/password sign-in and a cloud database that
syncs across every device, with no server for you to run or maintain.

## 1. Create the Firebase project
1. Go to https://console.firebase.google.com and sign in with the Google
   account you want to manage this with.
2. Click **Add project**, give it a name (e.g. `my-boarding-house`), and
   finish the wizard (you can skip Google Analytics).

## 2. Turn on Sign-In Providers
1. In the left sidebar: **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Email/Password** and **Google**.
3. For Google, select a support email, then click **Save**.

## 3. Turn on the database (Firestore)
1. In the left sidebar: **Build → Firestore Database → Create database**.
2. Choose **Start in production mode** → pick a location close to you → **Enable**.
3. Go to the **Rules** tab and replace the contents with:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
     }
   }
   ```
  This means: users can only read or write data stored under their own
  UID. Click **Publish**. Do not keep a broader signed-in-user rule, or it
  will allow accounts to access each other's data.
  Alternatively, deploy the included `firestore.rules` with
  `firebase deploy --only firestore:rules` from this folder.

## 4. Register a web app & copy your config
1. In the left sidebar, click the gear icon → **Project settings**.
2. Scroll to **Your apps** → click the **</>** (web) icon.
3. Give it a nickname (e.g. `tracker-web`) → **Register app**.
4. Firebase shows a code block with a `firebaseConfig` object — copy it.
5. Open **`firebase-config.js`** in this folder and paste your values into
   the matching fields, replacing the placeholder text.

## 5. Create a login account
Use **Create account** on the sign-in screen, or create an account in
Firebase Console under **Authentication → Users → Add user**. Keep the
`ALLOWED_EMAILS` list in `firebase-config.js` empty to allow email accounts
to sign in, or list the allowed email addresses there.

Each account's rooms and reserve clients are stored separately under
`users/{uid}`. Existing records in the old top-level `rooms` and
`prospects` collections are not moved automatically; back them up before
making any manual migration.

## 6. Authorize the domain you'll host this on
Firebase only allows authentication requests from approved domains.
1. **Authentication → Settings → Authorized domains**.
2. `localhost` is already allowed (for testing on your own computer).
3. If you upload this site somewhere (e.g. GitHub Pages, Netlify, Vercel,
   Firebase Hosting itself), add that domain here too, or the Google
   sign-in popup will show an error.

## 7. Open the site
Because this uses Firebase Auth, it needs to be loaded over `http://` or
`https://`, not by double-clicking the file. Easiest options:
- **Firebase Hosting** (free, and it's already your project): install the
  Firebase CLI, run `firebase init hosting` in this folder, then
  `firebase deploy`.
- Any static host — Netlify, Vercel, GitHub Pages — just upload the folder.
- For local testing: run `npx serve .` (or any local static server) in this
  folder and open the printed `http://localhost:...` address.

Once `firebase-config.js` has real values and both sign-in providers are
enabled, reload the page — the login screen will accept email/password
credentials or open Google's account chooser, and any
data you add will sync to Firestore instantly across every device signed
in with an authorized account.

## Importing your existing rooms
The first time you sign in with an empty database, click **"Import my
existing rooms"** on the Dashboard tab — it loads all 19 rooms and tenants
from your original spreadsheet as a starting point. You can edit, delete,
or add to them freely after that.
