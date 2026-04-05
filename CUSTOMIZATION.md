# Customization Guide

This document explains how to adapt the AlpacApps template for a new organization. Written for Claude Code sessions customizing this codebase.

## Overview

This repo is a **generic template** with placeholder values (`YOUR_*`) throughout. When a new organization clones it and runs `/setup-alpacapps-infra`, Claude customizes everything below.

## What to Customize

### 1. Supabase Credentials

| File | What to replace |
|------|----------------|
| `shared/supabase.js` | `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` |
| `CLAUDE.md` | All `YOUR_*` placeholders |
| `shared/config-loader.js` | Fallback property config values |

### 2. Organization Branding

| File | What to customize |
|------|------------------|
| `shared/config-loader.js` | Property name, address, domain, email addresses |
| `shared/site-components.js` | Header/footer branding, navigation links |
| `styles/tokens.css` | Color palette, typography, spacing |
| `index.html` | Landing page content |
| `assets/branding/` | Logos and wordmarks |

### 3. Page Shells (Navigation & Auth)

The platform uses three shell patterns that control navigation and access:

| Shell | Pages | Customization |
|-------|-------|--------------|
| `shared/admin-shell.js` | `spaces/admin/*` | Tab names, feature flags, role permissions |
| `shared/resident-shell.js` | `residents/*` | Device tabs, context switcher |
| `shared/public-shell.js` | `index.html`, `contact/`, `events/` | Nav links, footer content |
| `shared/associate-shell.js` | `associates/*` | Staff-specific tabs |

### 4. Feature Selection

Features are controlled by `feature-manifest.json`. The setup wizard enables/disables features based on the chosen persona. Each feature maps to:
- Shared JS modules
- Supabase edge functions
- Database tables
- Page directories

To disable a feature post-setup: remove its entry from `feature-manifest.json` and delete the associated files.

### 5. Context System (CLAUDE.md + docs/)

On-demand context loading minimizes tokens per conversation:

- **`CLAUDE.md`** (~30 lines, always loaded): Project directives + doc index
- **`docs/CREDENTIALS.md`** (gitignored): API keys, tokens, connection strings
- **`docs/SCHEMA.md`**: Database table definitions
- **`docs/PATTERNS.md`**: Code patterns, Tailwind tokens, auth conventions
- **`docs/KEY-FILES.md`**: Project file structure
- **`docs/DEPLOY.md`**: Deployment workflow, live URLs
- **`docs/INTEGRATIONS.md`**: External services, cost tiers
- **`docs/CHANGELOG.md`**: Recent changes

### 6. Database Schema

68 migrations in `supabase/migrations/` define the full schema. The setup wizard runs these via Management API. Core tables:

- `spaces` — Rental units, amenities, event venues
- `people` — Tenants, guests, associates
- `assignments` — Bookings (person + space + dates)
- `media` / `media_spaces` / `media_tags` — Photo/video management
- `app_users` — Auth users with roles (admin, staff, resident, associate, demo)
- `property_config` / `brand_config` — Singleton configuration
- Service configs: `stripe_config`, `telnyx_config`, `nest_config`, etc.

### 7. Edge Functions

67 Supabase edge functions in `supabase/functions/`. Key ones:

| Function | Purpose |
|----------|---------|
| `api/` | Central REST gateway for all CRUD |
| `send-email/` | Branded email via Resend (45+ templates) |
| `send-sms/` | SMS via Telnyx |
| `process-stripe-payment/` | Stripe payment processing |
| `property-ai/` | Gemini-powered AI assistant |
| `verify-identity/` | DL/ID verification via Gemini Vision |
| `govee-control/`, `nest-control/`, `sonos-control/` | Device control proxies |

### 8. Admin Dashboard Tabs

Tab visibility is controlled by `shared/feature-registry.js` and role permissions:

| Section | Tabs |
|---------|------|
| Staff | Spaces, Rentals, Events, Media, Passwords, Work Tracking, Users |
| Admin | Settings, Brand, Templates, Accounting, SMS, Voice, DevControl |
| Devices | Inventory, Purchases |

### 9. Mobile App

`mobile/` contains a Capacitor 8 wrapper (iOS + Android). Customize:
- `mobile/capacitor.config.ts` — App ID, server URL
- `mobile/android/.../AndroidManifest.xml` — Package name
- `mobile/ios/.../Info.plist` — Bundle identifier
- App icons and splash screens in platform-specific asset directories

## Checklist for New Organizations

- [ ] Clone repo and run `/setup-alpacapps-infra`
- [ ] Supabase credentials set in `shared/supabase.js`
- [ ] Property name/address updated in `shared/config-loader.js`
- [ ] Branding (colors, logos) updated in `styles/tokens.css` and `assets/branding/`
- [ ] CLAUDE.md placeholders replaced (project name, USERNAME, REPO)
- [ ] `docs/CREDENTIALS.md` filled with actual credentials (gitignored)
- [ ] Feature manifest trimmed to selected features
- [ ] Cloudflare Pages project created and connected to GitHub repo
- [ ] GitHub secrets set: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- [ ] Site pushed and live on Cloudflare Pages
