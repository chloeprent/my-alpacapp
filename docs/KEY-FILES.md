# Key Files Reference

> This file is loaded on-demand. Referenced from CLAUDE.md.

## Shared Modules (`/shared/`)
- `supabase.js` - Supabase client singleton (anon key embedded)
- `auth.js` - Authentication module for admin access
- `admin-shell.js` - Admin page shell (auth, nav, role checks)
- `resident-shell.js` - Resident page shell (auth, tab nav, PAI widget injection)
- `media-service.js` - Media upload, compression, tagging service
- `rental-service.js` - Rental application workflow management
- `event-service.js` - Event hosting request workflow
- `lease-template-service.js` - Lease template parsing and placeholder substitution
- `event-template-service.js` - Event agreement template parsing
- `worktrade-template-service.js` - Work trade agreement template parsing
- `pdf-service.js` - PDF generation from markdown using jsPDF
- `signwell-service.js` - SignWell e-signature API integration
- `email-service.js` - Email sending via Resend
- `brand-config.js` - Brand configuration loader (colors, fonts, logos from DB)
- `config-loader.js` - Property configuration loader (name, domain, email, payment, timezone from DB)
- `feature-registry.js` - Feature registry (core vs optional modules, config-driven enable/disable)
- `sms-service.js` - SMS sending via Telnyx (mirrors email-service.js pattern)
- `square-service.js` - Square payment processing (client-side tokenization)
- `hours-service.js` - Associate hours tracking (clock in/out, time entries)
- `identity-service.js` - Identity verification (upload tokens, DL verification)
- `payout-service.js` - PayPal payouts for associate payments
- `accounting-service.js` - Accounting/ledger service (Zelle auto-recording, payment tracking)
- `voice-service.js` - Vapi voice assistant configuration
- `pai-widget.js` - PAI floating chat widget (injected on all resident pages via resident-shell.js)
- `chat-widget.js` - Chat widget component
- `error-logger.js` - Client-side error capture and reporting
- `site-components.js` - Shared site UI components
- `version-info.js` - Version badge click handler
- `timezone.js` - Timezone utilities (Austin/Chicago)

## Shared Data Services (`/shared/services/`)
- `poll-manager.js` - Reusable polling class with visibility-based pause/resume
- `camera-data.js` - Camera stream config from `camera_streams` table
- `sonos-data.js` - Sonos zone state + control via `sonos-control` edge function
- `lighting-data.js` - Govee device groups + control via `govee-control` edge function
- `climate-data.js` - Nest thermostat state + control via `nest-control` edge function
- `cars-data.js` - Tesla vehicle data + commands via `tesla-command` edge function
- `laundry-data.js` - LG washer/dryer state + control via `lg-control` edge function
- `oven-data.js` - Anova oven state + control via `anova-control` edge function
- `glowforge-data.js` - Glowforge laser cutter status via `glowforge-control` edge function
- `printer-data.js` - FlashForge 3D printer state + control via `printer-control` edge function

## Mobile App (`/mobile/`)
- `capacitor.config.ts` - App config (ID: `com.yourorg.app`, plugins, platform settings)
- `scripts/copy-web.js` - Build script: copies web assets → www/, injects capacitor.js, patches redirects
- `app/index.html` - App shell (loading overlay, login overlay, tab sections, bottom nav bar)
- `app/mobile.css` - Dark theme stylesheet (all mobile CSS in one file)
- `app/mobile-app.js` - Orchestrator (auth, tab switching, lazy loading via dynamic import())
- `app/tabs/cameras-tab.js` - HLS camera feeds with quality switching, auto-reconnect
- `app/tabs/music-tab.js` - Sonos zones: play/pause, volume, scenes, favorites
- `app/tabs/lights-tab.js` - Govee groups: on/off, brightness, color presets
- `app/tabs/climate-tab.js` - Nest thermostats: temp +/-, mode, eco toggle
- `app/tabs/cars-tab.js` - Tesla vehicles: battery, lock/unlock, flash lights

## Payment Page (`/pay/`)
- `index.html` - Self-service payment page for tenants (Stripe PaymentElement + manual methods)
- URL params: `?amount=`, `?description=`, `?person_id=`, `?person_name=`, `?email=`, `?payment_type=`, `?reference_type=`, `?reference_id=`
- Shows Zelle/Venmo/PayPal (free, manual) + Stripe ACH/card (online, 0.8% fee capped at $5)
- Stripe PaymentElement mounts with PaymentIntent clientSecret from `process-stripe-payment`
- On success, Stripe webhook creates ledger entry + sends confirmation email with statement

## Consumer View (`/spaces/`)
- `app.js` - Public listing with real availability from assignments
- Shows only `is_listed=true AND is_secret=false` spaces
- Sorts: available first → highest price → name
- Loads assignment dates (no personal info) for availability display

## Admin View (`/spaces/admin/`)
- `app.js` - Full admin dashboard with all spaces
- `manage.html` - Management tabs (Spaces, Rentals, Media, Users, Settings)
- `media.js` - Media library with tagging and filtering
- `rentals.html` / `rentals.js` - Rental application pipeline (Kanban)
- `events.html` / `events.js` - Event hosting request pipeline
- `accounting.html` / `accounting.js` - Accounting/ledger dashboard
- `voice.html` / `voice.js` - Voice assistant config + call logs
- `faq.html` / `faq.js` - FAQ/AI configuration page
- `worktracking.html` / `worktracking.js` - Admin hours management for associates
- `sms-messages.html` / `sms-messages.js` - SMS conversation viewer
- `templates.html` / `templates.js` - Lease/event template editor
- `brand.html` / `brand.js` - Brand style guide (colors, logos, typography, email preview)
- `settings.html` / `settings.js` - System settings (SignWell, Telnyx, fees, etc.)
- `users.html` / `users.js` - User management + invitations
- Shows occupant info, visibility controls, edit capabilities

## Resident View (`/residents/`)
- `climate.html` / `thermostat.js` - Climate page: Nest thermostats + 48-hour weather forecast
- `lighting.html` / `lighting.js` - Govee lighting control
- `sonos.html` / `sonos.js` - Sonos music control
- `cameras.html` / `cameras.js` - Camera feeds + two-way talkback audio
- `laundry.html` / `laundry.js` - LG washer/dryer monitoring
- `cars.html` / `cars.js` - Vehicle info + Tesla commands
- `profile.html` / `profile.js` - User profile (avatar, bio, social, privacy settings)
- `sensorinstallation.html` - UP-SENSE smart sensor installation guide
- `residents.css` - Shared CSS for all resident pages

## Associate View (`/associates/`)
- `worktracking.html` / `worktracking.js` - Clock in/out, timesheets, work photos, payment preferences

## PAI Discord Bot (`/pai-discord/`)
- `bot.js` - Discord → property-ai edge function bridge (discord.js v14)
- `pai-discord.service` - Systemd service file for DO droplet
- `install.sh` - Droplet installation script

## Supabase Edge Functions (`/supabase/functions/`)
- `signwell-webhook/` - Receives SignWell webhook when documents are signed
- `send-sms/` - Outbound SMS via Telnyx API
- `telnyx-webhook/` - Receives inbound SMS from Telnyx
- `send-email/` - Outbound email via Resend API (45+ templates, branded wrapper)
- `_shared/email-brand-wrapper.ts` - Branded email shell (header/footer/buttons from brand_config)
- `resend-inbound-webhook/` - Receives inbound email via Resend webhook, routes/forwards, auto-records Zelle payments
- `approve-email/` - Email approval handler: validates token, sends held email to original recipient, supports "approve all" to disable approval for a type
- `govee-control/` - Proxies requests to Govee Cloud API (resident+ auth)
- `property-ai/` - PAI chat + voice assistant: Gemini-powered natural language smart home control + property Q&A + Vapi voice calling (resident+ auth)
- `sonos-control/` - Proxies requests to Sonos HTTP API via Home Server (resident+ auth)
- `nest-control/` - Proxies requests to Google SDM API with OAuth token management (resident+ auth)
- `nest-token-refresh/` - Standalone Nest OAuth token refresher (cron)
- `tesla-command/` - Sends commands to Tesla vehicles via Fleet API (lock, unlock, wake, flash, honk) (resident+ auth)
- `create-tesla-account/` - Creates tesla_accounts row with server-held Fleet API credentials (resident+ auth); use default JWT
- `lg-control/` - LG ThinQ laundry control (status, start/stop, watch/unwatch notifications, push token registration) (resident+ auth)
- `anova-control/` - Anova Precision Oven control via WebSocket API (getStatus, startCook, stopCook) (resident+ auth)
- `glowforge-control/` - Glowforge laser cutter status via cookie-based web API (getStatus) (resident+ auth)
- `printer-control/` - FlashForge 3D printer control via TCP proxy (getStatus, startPrint, pausePrint, resumePrint, cancelPrint, setTemperature, toggleLight, homeAxes, listFiles) (resident+ auth)
- `verify-identity/` - Driver's license photo → Gemini Vision → auto-verify applicants/associates
- `paypal-payout/` - Sends PayPal payouts to associates
- `paypal-webhook/` - Receives PayPal payout status updates
- `vapi-server/` - Returns dynamic assistant config to Vapi on incoming calls
- `vapi-webhook/` - Receives Vapi call lifecycle events (end, transcript)
- `airbnb-sync/` - Fetches Airbnb iCal feeds → creates blocking assignments
- `ical/` - Generates iCal feeds per space for external calendar sync
- `regenerate-ical/` - Regenerates iCal feeds when assignments change
- `process-square-payment/` - Server-side Square payment processing
- `refund-square-payment/` - Square payment refunds
- `square-webhook/` - Receives Square webhook for payment/refund status changes (ACH PENDING→COMPLETED/FAILED)
- `process-stripe-payment/` - Creates Stripe PaymentIntent for ACH/card payments (returns clientSecret)
- `stripe-webhook/` - Receives Stripe webhook for payment/transfer status changes, sends confirmation emails
- `stripe-connect-onboard/` - Stripe Connect Express account creation + onboarding for associate payouts
- `stripe-payout/` - Outbound ACH payments to associates via Stripe Connect Transfers
- `record-payment/` - AI-assisted payment matching (Gemini)
- `resolve-payment/` - Manual payment resolution for pending matches
- `confirm-deposit-payment/` - Deposit payment confirmation workflow
- `error-report/` - Error logging and daily digest emails
- `contact-form/` - Public contact form submission handler
- `event-payment-reminder/` - Daily cron: 10-day payment reminders for events
- `ask-question/` - PAI Q&A backend
- `share-space/` - Serves OG meta tags for space share links (dynamic title, image, description) + redirects to real page
- `api/` - **Centralized Internal REST API** — single permissioned endpoint for all entity CRUD (spaces, people, tasks, assignments, vehicles, media, payments, bug_reports, time_entries, events, documents, sms, faq, invitations, password_vault, feature_requests, pai_config, tesla_accounts). Role-based access control (0=public → 4=oracle). Smart behaviors: fuzzy name/space resolution, auto-timestamps, row-level scoping. See `API.md` for full reference.

## Edge Function Deployment Flags

Functions that handle auth internally MUST be deployed with `--no-verify-jwt` to prevent Supabase's gateway from rejecting valid user tokens before they reach the function code.

| Function | Deploy command |
|----------|---------------|
| `sonos-control` | `supabase functions deploy sonos-control --no-verify-jwt` |
| `govee-control` | `supabase functions deploy govee-control --no-verify-jwt` |
| `nest-control` | `supabase functions deploy nest-control --no-verify-jwt` |
| `resend-inbound-webhook` | `supabase functions deploy resend-inbound-webhook --no-verify-jwt` |
| `telnyx-webhook` | `supabase functions deploy telnyx-webhook --no-verify-jwt` |
| `signwell-webhook` | `supabase functions deploy signwell-webhook --no-verify-jwt` |
| `tesla-command` | `supabase functions deploy tesla-command --no-verify-jwt` |
| `lg-control` | `supabase functions deploy lg-control --no-verify-jwt` |
| `anova-control` | `supabase functions deploy anova-control --no-verify-jwt` |
| `glowforge-control` | `supabase functions deploy glowforge-control --no-verify-jwt` |
| `printer-control` | `supabase functions deploy printer-control --no-verify-jwt` |
| `property-ai` | `supabase functions deploy property-ai --no-verify-jwt` |
| `verify-identity` | `supabase functions deploy verify-identity --no-verify-jwt` |
| `vapi-server` | `supabase functions deploy vapi-server --no-verify-jwt` |
| `vapi-webhook` | `supabase functions deploy vapi-webhook --no-verify-jwt` |
| `paypal-webhook` | `supabase functions deploy paypal-webhook --no-verify-jwt` |
| `reprocess-pai-email` | `supabase functions deploy reprocess-pai-email --no-verify-jwt` |
| `api` | `supabase functions deploy api --no-verify-jwt` |
| `square-webhook` | `supabase functions deploy square-webhook --no-verify-jwt` |
| `stripe-webhook` | `supabase functions deploy stripe-webhook --no-verify-jwt` |
| `share-space` | `supabase functions deploy share-space --no-verify-jwt` |
| `approve-email` | `supabase functions deploy approve-email --no-verify-jwt` |
| All others | `supabase functions deploy <name>` (default JWT verification) |
