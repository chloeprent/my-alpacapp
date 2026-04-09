# Swoon Lead Listener — Setup Guide

> This script finds Reddit posts from people considering opening their relationship
> who haven't had the conversation yet. It sends you a daily email digest.
> **You review everything before responding. This finds — you decide.**

---

## Step 1: Get Reddit API Credentials

1. Go to https://www.reddit.com/prefs/apps
2. Scroll to the bottom and click **"create another app..."**
3. Fill in:
   - **Name:** `swoon-lead-listener`
   - **Type:** Select **"script"**
   - **Description:** `Lead listening for relationship coaching`
   - **Redirect URI:** `http://localhost:8080` (required but we don't use it)
4. Click **"create app"**
5. You'll see two values you need:
   - **Client ID** — the short string under the app name (looks like `a1b2c3d4e5f6g7`)
   - **Client Secret** — next to "secret"

> Save these somewhere safe — you'll add them to your `.env` file in Step 4.

---

## Step 2: Create the Supabase Table

Run this SQL in your Supabase dashboard (SQL Editor):

The migration file is already at `supabase/migrations/20260406_lead_listener_posts.sql`.

1. Go to your Supabase dashboard → **SQL Editor**
2. Open the migration file and paste the contents, then click **Run**

Or if you have the Supabase CLI set up:
```bash
supabase db push
```

---

## Step 3: Set Up SendGrid for Email

1. Go to https://app.sendgrid.com and create a free account (100 emails/day free)
2. Go to **Settings → API Keys → Create API Key**
3. Give it a name like `swoon-lead-listener`
4. Choose **"Restricted Access"** and enable only **Mail Send**
5. Copy the API key (it starts with `SG.`)

> **Important:** You also need to verify a sender identity:
> Go to **Settings → Sender Authentication** and verify `hello@swoon.coach`
> (or whatever email you want to send from)

---

## Step 4: Set Up Your Environment

```bash
# Navigate to the lead-listener folder
cd lead-listener

# Create a Python virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Create your .env file from the example
cp .env.example .env
```

Now open `.env` in a text editor and fill in your real values:

```
REDDIT_CLIENT_ID=paste_your_reddit_client_id
REDDIT_CLIENT_SECRET=paste_your_reddit_client_secret
REDDIT_USER_AGENT=swoon-lead-listener/1.0 by YourRedditUsername

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key_from_supabase_dashboard

SENDGRID_API_KEY=SG.your_sendgrid_api_key
SENDGRID_FROM_EMAIL=hello@swoon.coach
DIGEST_TO_EMAIL=your-personal-email@gmail.com
```

**Where to find your Supabase credentials:**
- Go to your Supabase dashboard → **Settings → API**
- **URL** = the "Project URL"
- **Service Key** = the `service_role` key (NOT the `anon` key)

---

## Step 5: Run It for the First Time

```bash
# Make sure you're in the lead-listener folder with venv activated
cd lead-listener
source venv/bin/activate

# Run the script
python lead_listener.py
```

You should see output like:
```
==================================================
  Swoon Lead Listener — Starting scan
  2026-04-06 09:00
==================================================

→ Connecting to Reddit...
→ Connecting to Supabase...

→ Scanning subreddits for leads...

  Scanning r/nonmonogamy...
    ✓ Found match: How do I bring up the idea of... (score: 8/10)
  Scanning r/openrelationships...
  ...

→ Found 4 new leads

→ Sending digest with 4 posts...

  ✉ Digest email sent! Status: 202

✓ Done! Check your inbox.
==================================================
```

---

## Step 6: Schedule It to Run Daily

### Option A: Mac (using launchd — recommended)

Create a file at `~/Library/LaunchAgents/com.swoon.leadlistener.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.swoon.leadlistener</string>
    <key>ProgramArguments</key>
    <array>
        <string>/full/path/to/lead-listener/venv/bin/python</string>
        <string>/full/path/to/lead-listener/lead_listener.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/full/path/to/lead-listener</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>8</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/swoon-lead-listener.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/swoon-lead-listener-error.log</string>
</dict>
</plist>
```

Then load it:
```bash
launchctl load ~/Library/LaunchAgents/com.swoon.leadlistener.plist
```

This runs every day at 8:00 AM.

### Option B: Simple cron job (Linux/Mac)

```bash
crontab -e
```

Add this line (runs daily at 8 AM):
```
0 8 * * * cd /full/path/to/lead-listener && /full/path/to/lead-listener/venv/bin/python lead_listener.py >> /tmp/swoon-lead-listener.log 2>&1
```

### Option C: Free cloud hosting (recommended for always-on)

Use **Railway**, **Render**, or **GitHub Actions** to run this as a scheduled job.
The simplest free option is a **GitHub Actions workflow** — ask me and I'll set that up.

---

## Quick Checklist

- [ ] **Reddit API credentials** — Create app at reddit.com/prefs/apps
- [ ] **Supabase table** — Run the migration SQL in your dashboard
- [ ] **SendGrid API key** — Create account and verify sender email
- [ ] **Fill in .env** — Copy .env.example → .env and add all credentials
- [ ] **First run** — `python lead_listener.py` to test it works

---

## Troubleshooting

**"401 Unauthorized" from Reddit:**
Your Reddit client ID or secret is wrong. Double-check them at reddit.com/prefs/apps.

**"Invalid API key" from SendGrid:**
Make sure your API key starts with `SG.` and has Mail Send permissions.

**No posts found:**
This is normal if there aren't recent matching posts. Try running again tomorrow.
You can also temporarily increase `MAX_AGE_HOURS` in the script to test with older posts.

**Email not arriving:**
Check your spam folder. Also verify your sender email in SendGrid dashboard.
