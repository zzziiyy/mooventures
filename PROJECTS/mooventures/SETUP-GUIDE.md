# Mooventures — Setup Guide
## From file to real app on your phone in ~15 minutes

---

## STEP 1 — Create your Supabase account (free database + auth)

1. Go to **supabase.com** and click "Start your project"
2. Sign up with GitHub or email
3. Click **"New project"**
4. Name it `mooventures`, choose a region close to you (e.g. West EU), set a database password (save it somewhere)
5. Wait ~2 minutes for it to set up

---

## STEP 2 — Set up the database

1. In your Supabase project, click **"SQL Editor"** in the left sidebar
2. Click **"New query"**
3. Open the file `supabase-setup.sql` (included in this folder)
4. Copy everything and paste it into the SQL editor
5. Click **"Run"** (green button)
6. You should see "Success. No rows returned" — that's correct!

---

## STEP 3 — Set up photo storage (for herd chat photos)

1. In Supabase, click **"Storage"** in the left sidebar
2. Click **"New bucket"**
3. Name it exactly: `chat-photos`
4. Check **"Public bucket"** ✓
5. Click **"Save"**

---

## STEP 4 — Get your API keys

1. In Supabase, click **"Project Settings"** (gear icon, bottom left)
2. Click **"API"**
3. You'll see two values you need:
   - **Project URL** (looks like: https://xxxxx.supabase.co)
   - **anon public key** (long string starting with "eyJ...")
4. Copy both — you'll need them in the next step

---

## STEP 5 — Add your keys to the app

1. Open the file `js/config.js` in a text editor
2. Replace `YOUR_SUPABASE_URL` with your Project URL
3. Replace `YOUR_SUPABASE_ANON_KEY` with your anon key
4. Save the file

It should look like:
```js
const SUPABASE_URL = 'https://abcdefgh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

---

## STEP 6 — Deploy to Netlify (free hosting)

1. Go to **netlify.com** and sign up (free)
2. Once logged in, look for **"Deploy manually"** or go to **app.netlify.com/drop**
3. Drag the entire **mooventures folder** onto the Netlify drop zone
4. Wait ~30 seconds
5. Netlify gives you a URL like `https://amazing-cow-123456.netlify.app`

That's your live app!

---

## STEP 7 — Open on your iPhone

1. On your iPhone, open **Safari**
2. Go to your Netlify URL
3. Tap the **Share button** (box with arrow at the bottom of Safari)
4. Tap **"Add to Home Screen"**
5. Name it **Mooventures** and tap **Add**

The app icon appears on your home screen and opens full-screen like a real app.

---

## STEP 8 — Create your account

1. Open Mooventures from your home screen
2. Tap **"Create account"**
3. Enter your name, email, and a password
4. You're in! Your data is now stored securely in your own database.

---

## Sharing with friends

To invite a travel buddy:
1. Send them your Netlify URL
2. They create their own account
3. In Mooventures, go to **Buddies → Add buddy**
4. Enter their email address

For **Serendipity** (meeting strangers):
1. Go to **Serendipity → Add new**
2. Share your Moo code with someone you've just met
3. They enter it in their app — neither of you sees anything until both accept

---

## Updating the app later

Whenever you want to make changes:
1. Edit the files on your computer
2. Go back to Netlify
3. Drag the updated folder onto your Netlify site
4. It updates automatically in ~30 seconds — everyone sees the new version instantly

---

## Costs

Everything above is **completely free** forever for personal use:
- Supabase free tier: up to 500MB database, 50,000 monthly active users
- Netlify free tier: unlimited deploys, 100GB bandwidth/month
- The app itself: free

The only cost if you ever want it: an Apple Developer account (€99/year) to publish to the App Store as a native app — but you don't need that for personal use.

---

*Built with love for highland cows and wanderers everywhere 🐄*
