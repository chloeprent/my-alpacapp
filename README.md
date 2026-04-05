# AlpacApps Infra

A complete property management platform template. Clone it, run the setup wizard, and get a full-featured system for managing rentals, events, smart home devices, payments, and more — all on free or near-free infrastructure.

## What you get

### Core Platform
- **Database + Auth + Storage** — Supabase (free tier)
- **Website + Hosting** — Cloudflare Pages (free tier: unlimited sites, 500 builds/month)
- **Login + Admin Dashboard** — Role-based auth, 15+ admin pages, DevControl AI dashboard
- **Resident Portal** — Smart home controls, profile, bookkeeping

### Communication
- **Email** — Resend (free: 3,000/month)
- **SMS** — Telnyx (~$0.004/message)
- **WhatsApp** — Meta Business API

### Payments & Documents
- **Payments** — Stripe, Square, or PayPal
- **E-Signatures** — SignWell (free: 3 docs/month)
- **PDF Generation** — Lease agreements, contracts, receipts

### Smart Home & IoT
- **Lighting** — Govee, Home Assistant, WiZ
- **Climate** — Google Nest thermostats
- **Music** — Sonos multi-room audio
- **Cameras** — UniFi Protect / RTSP via go2rtc
- **Laundry** — LG ThinQ washer/dryer monitoring
- **Vehicles** — Tesla Fleet API
- **Appliances** — Anova Precision Oven, 3D printers, laser cutters

### AI & Voice
- **AI Assistant** — Gemini-powered property assistant
- **Voice Calling** — Vapi voice agent
- **Alexa Skill** — Room control via Alexa

### Property Operations
- **Rental Pipeline** — Inquiry → apply → review → sign → move-in
- **Event Hosting** — Full event management workflow
- **Associate Management** — Clock in/out, timesheets, payouts
- **Airbnb Sync** — iCal calendar integration
- **Mobile App** — iOS/Android via Capacitor 8

## Prerequisites

| Tool | Install |
|------|---------|
| **Git** | [git-scm.com/downloads](https://git-scm.com/downloads) |
| **Claude Code** | [docs.anthropic.com/claude-code](https://docs.anthropic.com/en/docs/claude-code/overview) |
| **GitHub account** | [github.com/signup](https://github.com/signup) |
| **Cloudflare account** | [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) (free) |

## Quick start

```bash
# 1. Clone this repo
git clone https://github.com/rsonnad/alpacapps-infra.git my-project
cd my-project

# 2. Open Claude Code
claude

# 3. Run the setup wizard
/setup-alpacapps-infra
```

The wizard will:
1. Ask what you're building (7 persona templates available)
2. Create a new GitHub repo under your account
3. Set up Supabase (database, auth, storage, edge functions)
4. Customize branding, domain, and credentials
5. Deploy your site live on Cloudflare Pages

## Architecture

```
Browser → Cloudflare Pages (static HTML/JS/CSS, global CDN)
                ↓
         Supabase (PostgreSQL + Edge Functions + Auth + Storage)
```

- **Frontend:** Vanilla HTML/JS + Tailwind CSS v4
- **Backend:** Supabase (75+ edge functions, RLS, JWT auth)
- **Hosting:** Cloudflare Pages (global CDN, preview deploys, custom domains)
- **Mobile:** Capacitor 8 (iOS + Android wrapper)

## Project structure

```
shared/           — 50 JS modules (auth, services, shells, widgets)
styles/           — Tailwind v4 design tokens + CSS
login/            — Authentication pages (auto-installed)
spaces/           — Rental listing + admin dashboard (65+ pages)
  admin/devcontrol/ — AI development dashboard (auto-installed)
residents/        — Resident portal (device control, profile)
associates/       — Staff hours tracking + work photos
events/           — Event hosting pipeline
pay/              — Self-service payment page
supabase/
  functions/      — 67 edge functions
  migrations/     — 68 database migrations
cloudflare/       — Cloudflare Workers (session logging, downloads)
mobile/           — Capacitor iOS/Android app
```

## Persona templates

| Template | Best for |
|----------|----------|
| Vacation Rental | Short-term rentals with Airbnb sync + smart home |
| Long-term Landlord | Lease management + rent collection |
| Event Venue | Event pipeline with contracts + payments |
| Hostel / Co-living | Mixed rooms + work-trade + shared amenities |
| Personal AI Hub | Smart home + AI assistant (no property mgmt) |
| Small Business | CRM + invoicing + communication |
| Developer Portfolio | Auth + payments starter kit |

## Customization

See [CUSTOMIZATION.md](CUSTOMIZATION.md) for details on branding, features, and configuration.

## License

AGPL-3.0 — see [LICENSE](LICENSE).

