PAYDAY - SETUP GUIDE
====================

LIVE BANK PULLS: see SETUP-PLAID.txt (Accounts tab).


UPDATING YOUR SITE FROM INSIDE THE APP (after the one-time setup in Settings > Update the app)
1. Settings > Update the app > Choose update zip, and pick Payday-app.zip.
2. Review the list of changed files, tap Publish.
3. Wait about 2 minutes, then tap Refresh app.


UPDATING YOUR GITHUB SITE BY HAND (the old way)
1. Unzip Payday-app.zip on your computer.
2. In your GitHub repo: Add file > Upload files. Drag in EVERY file from the zip
   (the old ones get replaced; three firebase-*.js files are new). Commit changes.
3. Wait about 2 minutes, then close and reopen Payday twice.


TURNING ON SYNC + GOOGLE DRIVE BACKUPS  (one time, about 15 minutes, easiest on a computer)
Everything below is free and lives in YOUR Google account. Nothing here is connected to Claude.

1. CREATE THE PROJECT
   Go to console.firebase.google.com and sign in with your Google account.
   Create a project, name it "Payday". Turn OFF Google Analytics. Create.

2. TURN ON GOOGLE SIGN-IN
   Left menu: Build > Authentication > Get started.
   Sign-in method tab > Google > Enable. Pick your email as support email. Save.

3. ALLOW YOUR SITE
   Still in Authentication: Settings tab > Authorized domains > Add domain:
       yianni1997.github.io

4. CREATE THE DATABASE
   Left menu: Build > Firestore Database > Create database.
   Pick a location near you. Choose "Start in production mode". Create.
   Then open the Rules tab, delete everything there, paste this, and Publish:

rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}

   (These rules mean only you, signed in with your Google account, can read or change your data.)

5. GET THE SETUP CODE
   Click the gear next to "Project Overview" > Project settings.
   Scroll to "Your apps" > click the web icon </>. Nickname: Payday. Register app.
   Copy the whole block that starts with  const firebaseConfig = {  and ends with  };
   (Skip "Firebase Hosting".)

6. TURN ON GOOGLE DRIVE ACCESS
   Go to console.cloud.google.com/apis/library/drive.googleapis.com
   At the top, make sure your Payday project is selected. Click Enable.

7. CONNECT PAYDAY (on your computer)
   Open your Payday site > Settings > "Sync and Google Drive backup".
   Paste the block from step 5 > Save setup > Sign in with Google.
   Allow it to see the Drive files it creates.

8. CONNECT YOUR PHONE
   On the computer: Settings > "Copy link for another device". Email or text that link to yourself.
   On the phone, open the link in Chrome (or open it, then reopen Payday from your home screen).
   Settings > Sign in with Google (same account).
   Whatever is on each device gets combined. Nothing is lost.


HOW BACKUPS WORK ONCE IT'S ON
- Your data lives in your Firebase project, so clearing your phone or browser doesn't delete it.
- Once a day, a dated copy goes in a "Payday backups" folder in your Google Drive (last 60 days kept).
  It runs the first time you tap anything in the app that day. Google may flash up for a second.
- Once a day a copy is also kept in Firebase (last 30 days). Settings > "Show daily backups"
  lets you go back if you delete something by mistake.


IF SOMETHING GOES WRONG
- "Add yianni1997.github.io to Authorized domains": redo step 3.
- "Turn on the Google Drive API": redo step 6 with the Payday project selected.
- Google says "Access blocked" or "app not verified": in console.cloud.google.com go to
  APIs & Services > OAuth consent screen. If it's in Testing, add your Gmail under Test users
  (or click Publish app).
- Sign-in window doesn't appear: allow pop-ups for your Payday site in the browser.
