# AlpacApps Setup Instructions (Machine-Readable)

> **For Claude, ChatGPT, or any LLM helping a user set up AlpacApps.**
> This file is the canonical setup reference. The HTML page at `/infra/` is the human-friendly overview.

## Overview

AlpacApps is a full-stack platform using:
- **Cloudflare Pages** — static site hosting with global CDN (free tier: unlimited sites, 500 builds/month)
- **Supabase** — PostgreSQL database, auth, storage, edge functions (free tier)
- **Claude Code** — AI developer agent that writes and deploys code
- **Conductor** — Mac app for running parallel Claude Code agents (macOS only)
- **Tailwind CSS v4** — styling framework

Architecture: Browser → Cloudflare Pages → Supabase (no server-side code). Edge functions handle sensitive operations.

## Setup Flow

### Phase 1: Claude Code guides initial setup
The user pastes a setup prompt into Claude Code. Claude Code should:

1. **Set up screenshots** — Detect the user's OS and help them set up one-click full-screen screenshot-to-clipboard:
   - **macOS**: Install [Shottr](https://shottr.cc) (free) or use ⌘+Ctrl+Shift+3
   - **Windows**: Win+Shift+S (Snip & Sketch) or PrtScn
   - **Linux**: Install [Flameshot](https://flameshot.org) or use desktop screenshot tool
   - Test by having user paste a screenshot into the conversation

2. **Install prerequisites** — Check and install as needed:
   - Git
   - GitHub CLI (`gh`)
   - Node.js (for Claude Code)

3. **Create GitHub repository** — From the template at `https://github.com/rsonnad/alpacapps-infra`

4. **Set up Cloudflare Pages** — Create a Pages project connected to the GitHub repo:
      - Go to Cloudflare Dashboard → Pages → Create a project → Connect to Git
      - Select the new GitHub repo
      - Build command: `npm run css:build`
      - Build output directory: `.` (root)
      - Add GitHub secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
      - Optionally set `CLOUDFLARE_PAGES_PROJECT` as a GitHub variable

5. **Set up Supabase** — Create project, configure auth, run initial migrations

6. **Install Conductor** — Download and install the Mac app (macOS only)

### Phase 2: Switch to Conductor
Once Conductor is installed, the user switches from Claude Code in the terminal to Conductor for:
- Running the setup wizard (configures services based on user's needs)
- All future development (each task gets its own workspace with a dedicated AI agent)
- Code pushes to GitHub and the site updates automatically

## Detailed Step-by-Step Guide

For the full detailed setup procedure with checkpoints and validation steps, read:
**https://alpacaplayhouse.com/infra/setup-guide.html**

## Service Options

### Core (always included, free)
| Service | Purpose |
|---------|---------|
| Cloudflare Pages | Static site hosting, global CDN, preview deploys |
| Supabase | PostgreSQL, auth, file storage, edge functions |
| Conductor | Parallel AI coding agents (macOS only) |
| Claude Code | AI developer — writes, tests, deploys code |

### Optional services
| Service | Purpose | Cost |
|---------|---------|------|
| Google Sign-In | OAuth authentication | Free |
| Resend | Transactional email | Free (3K/mo) |
| Telnyx | SMS messaging | ~$5/mo |
| Square | Payment processing | % per transaction |
| Stripe | Payment processing (ACH, cards) | % per transaction |
| SignWell | E-signatures | Free (25 docs/mo) |
| Google Gemini | AI features (chat, matching, image gen) | Free–$50/mo |
| Cloudflare R2 | Object storage (zero egress) | Free (10 GB) |
| Cloudflare D1 | Session logging database | Free |
| gstack | QA testing & browser automation | Free |
| Background Workers | Cloud VM for pollers, automation | $12–32/mo |
| Custom Domain | Your own domain name | ~$10/yr |
| PayPal | Checkout, payouts & instant transfers | % per transaction |
| VAPI | AI voice calling & phone agents | Pay-as-you-go |
| Discord Bot | AI assistant bot for community server | Free |
| iPhone App | Native iOS (Swift/SwiftUI) + App Store | $99/yr (Apple Developer) |
| Android App | Native Android (Kotlin/Compose) + Play Store | $25 one-time (Google Play) |
| Home Server | Local Mac for HAOS, cameras, media, 30+ devices | ~$150 one-time |

## Project Profiles

1. **Property Management** — Full stack: spaces, tenants, devices, events, smart home, bookings
2. **General AI Enablement** — Core framework: auth, payments, email, permissions, web pages (SaaS, CRM, portfolio, etc.)

Both use the same template. The setup wizard tailors the project to the user's choice.

## Updates

After initial setup, users can adopt new features by reading:
**https://alpacaplayhouse.com/infra/updates.html**

Feature index (machine-readable): **https://alpacaplayhouse.com/infra/updates.json**

## First-Run Behavior & Gotchas

When someone first clones and sets up the project, be aware of these:

### Admin tabs not showing
On a fresh project, the `get_effective_permissions` RPC may not exist or return empty results.
The admin-shell.js has a built-in fallback: if the user has an `admin` or `oracle` role but
their permissions set is empty, all tabs are shown. Once `syncTabPermissions()` runs and
creates the permission rows, the normal permission filter takes over.

**If tabs are still missing:**
1. Check that the user's `role` in `app_users` is set to `admin` or `oracle`
2. Ensure the `get_effective_permissions` RPC function exists in the database
3. Check the browser console for Supabase RPC errors
4. The `syncTabPermissions()` function auto-creates missing permission keys on each page load

### Feature flags
Optional features (rentals, events, SMS, voice, etc.) are toggled via `property_config.features` JSONB.
**All optional features default to `false`** — only enable features the user explicitly selected during setup.
If `property_config` doesn't exist or has no `features` key, only core tabs show (Spaces, Media,
Purchases, Todo, PhyProp, Inventory, App Dev). To enable specific features:

```sql
-- Enable only the features the user selected (all others stay false)
UPDATE property_config
SET config = jsonb_set(config, '{features}',
  COALESCE(config->'features', '{}'::jsonb) || '{"rentals": true, "events": true}'::jsonb)
WHERE id = 1;
```

**Never set all features to `true` by default.** Each feature should only be enabled after its
corresponding service is configured (e.g., don't enable "sms" until Telnyx is set up).

### First user setup
The first user to sign in should be granted admin role. After Supabase auth is configured:
1. User signs in via Google OAuth or email
2. An `app_users` row is created automatically
3. Set their role to `admin`: `UPDATE app_users SET role = 'admin' WHERE email = 'user@example.com';`
4. On next page load, `syncTabPermissions` creates all permission keys and grants them to the admin role

### Mobile apps
The mobile apps are **native** (not Capacitor):
- **iOS**: Swift + SwiftUI (`mobile-ios/`)
- **Android**: Kotlin + Jetpack Compose (`mobile-android/`)
- **Kiosk**: Kotlin lockdown app (`alpaca-kiosk/`)

### Current scale
- **67 Supabase edge functions** — serverless TypeScript for all integrations
- **11 background workers** — device pollers, AI image gen, Discord bot, live subtitles, etc.
- **2 native mobile apps** + Android kiosk + macOS kiosk
- **3 payment processors** — Stripe, Square, PayPal
- **30+ smart home devices** via Home Assistant OS (HAOS)

## How to Update an Existing Project

If the user already has a running project and wants to adopt new features:

1. **Read the update index**: Fetch `https://alpacaplayhouse.com/infra/updates.json` for the machine-readable feature list
2. **Check what's missing**: Each feature has `detectionPaths` — check if those files exist in the project
3. **Read the upgrade guide**: `https://alpacaplayhouse.com/infra/infra-upgrade-guide.md` has step-by-step instructions
4. **Run the upgrade prompt**: `https://alpacaplayhouse.com/infra/infra-upgrade-prompt.md` can be pasted into Claude Code to auto-upgrade

### Key files to sync from template
When updating an existing project from the template (`https://github.com/rsonnad/alpacapps-infra`):
- `shared/admin-shell.js` — tab navigation, auth flow, permission system
- `shared/feature-registry.js` — feature flag definitions
- `shared/config-loader.js` — property config loader with fallbacks
- `shared/auth.js` — authentication and permission checks
- `shared/site-components.js` — header, footer, navigation components
- `infra/` — setup guides and update system

## Platform Notes

- **Conductor**: macOS only (as of March 2026). Non-Mac users use Claude Code directly in the terminal.
- **iPhone App**: Native Swift/SwiftUI, requires macOS for Xcode builds
- **Android App**: Native Kotlin/Jetpack Compose, builds on any OS via Android Studio
- **Home Server**: Requires a dedicated Mac on the local network running HAOS
