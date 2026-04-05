# Recent Changes Changelog

> Reference document extracted from CLAUDE.md. Loaded on-demand, not auto-loaded into context.

## Recent Changes to Be Aware Of

0. **Infra page hero banner redesign (v260310)** — Both `/infra/index.html` and `/docs/alpacappsinfra.html` use a full-width banner card hero (alpaca AI banner image spanning the card width, text below). **Do NOT revert to the old dark full-bleed hero** — it was lost once already and had to be restored. Both files have a `⚠️ HERO BANNER` HTML comment marking the section.
1. **Consumer view now loads real availability** - Fetches assignments to show actual dates
2. **Media system migration** - Using `media`/`media_spaces` tables instead of `photos`/`photo_spaces`
3. **Space archiving** - `is_archived` flag for soft deletes
4. **Image compression** - Client-side compression for images > 500KB
5. **Early exit feature** - `desired_departure_date` + `desired_departure_listed` on assignments
   - Admin sets desired departure date
   - Admin clicks "List" to publish it for consumers
   - Only when listed does it affect availability display
6. **Space type field** - Free-form `type` column on spaces table, editable in admin modal
7. **Manage page filters** - Search, parent area dropdown, dwelling/non-dwelling checkboxes
8. **URL parameter handling** - `/spaces/admin/?edit=<id>` auto-opens edit modal
9. **Lease Template System** - Database-driven lease generation with placeholders
   - Templates stored in `lease_templates` table with markdown + `{{placeholders}}`
   - PDF generation via jsPDF (client-side)
   - SignWell integration for e-signatures
   - Settings tab in manage.html for template editing
10. **Rental Pipeline** - Kanban-style rental application workflow
   - Stages: Applications → Approved → Contract → Deposit → Ready
   - Documents tab with PDF generation and signature tracking
11. **Telnyx SMS Integration** - Outbound and inbound SMS via Telnyx
   - `shared/sms-service.js` mirrors email-service.js pattern
   - Edge functions: `send-sms` (outbound) and `telnyx-webhook` (inbound)
   - Admin Settings: test mode toggle, compose SMS, bulk SMS, inbound SMS view
   - Config in `telnyx_config` table, messages logged in `sms_messages` table
12. **Bug Fix Verification Screenshots** - After fixing a bug, the worker takes a screenshot
   - Uses Puppeteer (headless Chromium) on the DigitalOcean droplet
   - Waits 90s for GitHub Pages deploy, then screenshots the page
   - For admin pages: injects bot user auth session into Puppeteer's localStorage
   - Uploads screenshot to `bug-screenshots` Supabase Storage bucket
   - Sends follow-up email (`bug_report_verified`) with the screenshot
13. **Bug Reports Browser Info** - Extensions collect full environment data
   - `bug_reports` table captures: `user_agent`, `browser_name`, `browser_version`, `os_name`, `os_version`, `screen_resolution`, `viewport_size`, `device_type`, `extension_platform`, `extension_version`
   - Worker writes back `diagnosis` (root cause) and `notes` (observations/caveats) after Claude Code analyzes the bug
   - Claude Code prompt instructs it to output structured JSON with `diagnosis`, `fix_summary`, and `notes`
14. **Resend Inbound Email** - Inbound email receiving and routing via Resend
   - Domain `alpacaplayhouse.com` configured for both sending and receiving
   - MX record points to `inbound-smtp.us-east-1.amazonaws.com`
   - Edge function: `resend-inbound-webhook` (SVIX signature verification)
   - Prefix-based routing: personal forwards, team@, auto@ (bug reply logic), herd@ (stub)
   - All emails logged to `inbound_emails` table
   - Forwarded emails preserve original sender name, set reply-to to original sender
15. **Home Automation System** - Sonos + UniFi programmatic control
   - Alpaca Mac (macOS 12.7.6) runs as home server on Black Rock City WiFi
   - node-sonos-http-api discovers and controls 12 Sonos zones
   - Custom `balance.js` action added for L/R balance control (uses SOAP LF/RF channels)
   - Proxy chain: Browser → Supabase edge function → nginx on DO droplet (port 8055) → Alpaca Mac via Tailscale
   - `SONOS_PROXY_URL` and `SONOS_PROXY_SECRET` stored as Supabase secrets
   - Edge function `sonos-control` MUST be deployed with `--no-verify-jwt`
   - Tailscale mesh VPN connects DO droplet to Alpaca Mac
   - UniFi Network API for firewall/DHCP/WiFi management
   - `HOMEAUTOMATION.md` for full documentation (proxy chain details, balance action, troubleshooting)
16. **Govee Lighting Integration** - 63 Govee/AiDot smart lights backed up in Supabase
   - `govee_config` table stores API key, test mode toggle (single row, id=1)
   - `govee_devices` table stores all 63 devices with name, SKU, area, type
   - `govee_devices.parent_group_id` links individual devices to their parent group
   - `govee_devices.display_order` controls group sort order in UI
   - `govee_models` table maps SKU → friendly model name (e.g., H601F → "Recessed Lights Pro")
   - Cloud API base: `https://openapi.api.govee.com/router/api/v1/`
   - `govee_devices.space_id` links devices to spaces table for hierarchy-based UI grouping
   - Lighting page (`residents/lighting.html`) loads groups dynamically from DB
   - Groups organized into collapsible `<details>/<summary>` sections by space hierarchy (depth-1 ancestor)
   - Section collapse state persisted in localStorage
   - Settings (test mode toggle, device inventory) shown to admin users on lighting page
   - Edge function: `govee-control` proxies requests to Govee Cloud API (staff+ auth required)
   - Areas: Garage Mahal (17), Spartan (18), Outdoor (12), Outhouse (7), Interior (5), Bedrooms (4)
17. **Nest Thermostat Integration** - Climate page with Google SDM API
   - `residents/climate.html` + `residents/thermostat.js` — Climate tab in resident nav
   - 3 thermostats: Master, Kitchen, Skyloft (LAN IPs: .111, .139, .249)
   - Full controls: current temp, target temp +/-, mode (Heat/Cool/Heat-Cool/Off), eco toggle
   - Edge function: `nest-control` handles OAuth token refresh + SDM API proxy
   - DB: `nest_config` (OAuth creds), `nest_devices` (cached state), `thermostat_rules` (future)
   - OAuth flow: admin completes one-time Google authorization from Settings section
   - 30s polling with visibility-based pause (same pattern as Sonos/Govee)
18. **Weather Forecast on Climate Page** - 48-hour forecast via OpenWeatherMap
   - Rain windows summary at top: "Rain expected: Today 2 PM - 5 PM (70% chance)"
   - Expandable hourly detail chart with temp and precipitation probability per hour
   - `weather_config` table stores OWM API key + lat/lon (Cedar Creek, TX: 30.13, -97.46)
   - Supports One Call API 3.0 with 2.5 free tier fallback
   - Client-side API call (no edge function needed)
19. **AI Image Generation Worker** - Async Gemini image gen on DO droplet
   - Worker at `/opt/image-gen/worker.js` polls `image_gen_jobs` table every 10s
   - Gemini 2.5 Flash Image API generates images from text prompts
   - Uploads to Supabase Storage (`housephotos/ai-gen/`), creates `media` record
   - Per-job cost tracking from API response token counts (~$0.039/image)
   - Retry up to 3x on failure, 3s rate-limit delay between API calls
   - Systemd service: `image-gen.service` (runs as `bugfixer` user)
   - Nano Banana MCP (`.mcp.json`, gitignored) for interactive image gen in Claude Code
20. **Cars Resident Page + Tesla Fleet API** - Live Tesla vehicle data + commands at `residents/cars.html`
   - 6 Tesla vehicles on 1 account: Casper (Model 3 2019), Delphi (Model Y 2023), Sloop (Model Y 2026), Cygnus (Model Y 2026), Kimba (Model Y 2022), Brisa Branca (Model 3 2022)
   - Migrated from Tesla Owner API (dead) to Fleet API (`fleet-api.prd.na.vn.cloud.tesla.com`)
   - "Tespaca" app registered at developer.tesla.com, EC public key hosted in repo
   - Fleet API creds (`fleet_client_id`, `fleet_client_secret`) stored per account in `tesla_accounts`
   - DO droplet poller (`tesla-poller.service`) polls Fleet API every 5 min
   - Sleep-aware: doesn't wake sleeping cars, just records state
   - Client polls Supabase every 30s with visibility-based pause
   - Admin Settings tab for pasting refresh tokens per account
   - Data grid: battery, odometer, status, climate, location, tires, lock state
   - Lock/unlock + flash buttons on each car card via `tesla-command` edge function
   - Edge function handles wake-up (30s polling) before sending commands to sleeping cars
   - Staleness indicator shows time since last sync
21. **Camera Streaming via go2rtc** - Live HLS camera feeds on Cameras resident page
   - 3 UniFi G5 PTZ cameras restreamed via go2rtc on Alpaca Mac
   - go2rtc handles UniFi Protect's quirky RTSP (MediaMTX crashed on SPS parsing)
   - `rtspx://` protocol (RTSP over TLS control, no SRTP on media)
   - Caddy reverse proxy on DO droplet: `cam.alpacaplayhouse.com` → go2rtc:1984 via Tailscale
   - HLS fMP4 mode (`&mp4` parameter) required — without it, segments contain only audio
   - `camera_streams` DB table stores stream config, frontend constructs HLS URL dynamically
   - PTZ controls via UniFi Protect API (continuous move + preset goto)
   - Lightbox mode with camera navigation and quality switching
22. **LG Laundry Monitoring** - Live washer/dryer status on Laundry resident page
   - LG ThinQ Connect API with PAT auth from https://connect-pat.lgthinq.com/
   - Worker: `lg-poller` on DO droplet polls every 30s
   - Edge function: `lg-control` (status, control, watch/unwatch, push token registration)
   - Resident page: `residents/laundry.html` with progress bars, time remaining, "Notify When Done"
   - DB: `lg_config` (PAT), `lg_appliances` (cached state), `push_tokens` (FCM), `laundry_watchers`
   - Cycle completion detection: worker detects RUNNING→END transition, sends FCM push to watchers
   - QR codes on machines → deep link → auto-subscribe to notifications (Phase 5-6 pending)
   - Washer states: POWER_OFF, INITIAL, DETECTING, RUNNING, RINSING, SPINNING, DRYING, END, ERROR
   - Dryer states: POWER_OFF, INITIAL, RUNNING, PAUSE, END, ERROR
23. **Camera Two-Way Talkback Audio** - Push-to-talk on camera feeds via FFmpeg relay
   - `scripts/talkback-relay/talkback-relay.js` — WebSocket relay server on Alpaca Mac
   - Browser captures microphone (Web Audio API, 48kHz mono PCM)
   - FFmpeg transcodes PCM → AAC-ADTS 22.05kHz mono, streams UDP to camera:7004
   - WebSocket protocol on port 8902, health check on port 8903
   - 3 cameras supported: Alpacamera (.173), Front Of House (.182), Side Yard (.110)
   - Push-to-talk UI in both grid and lightbox views
   - LaunchAgent: `com.talkback-relay.plist` on Alpaca Mac
   - Requires FFmpeg installed on Alpaca Mac
24. **Vapi Voice Calling System** - AI phone assistant for property inquiries
   - Vapi handles phone calls → `vapi-server` edge function returns assistant config dynamically
   - Caller identification by phone number → personalized greeting
   - Dynamic prompt injection with current occupants, availability, caller name
   - Tool integration via PAI (smart home control, property Q&A)
   - `vapi-webhook` edge function logs call data (duration, cost, transcript)
   - Admin UI: `spaces/admin/voice.html` for managing assistants + viewing call logs
   - DB: `vapi_config`, `voice_assistants`, `voice_calls`
   - `send_link` tool: PAI can send clickable URLs via SMS instead of reading URLs aloud
25. **User Profile Page** - Self-service profile editor at `residents/profile.html`
   - Avatar upload, display name, first/last name, phone, email
   - Social links (Facebook, Instagram, LinkedIn, X)
   - Privacy controls: per-field visibility (public/residents/private)
   - Nationality + Location Base fields with flag emojis
   - Role + resident status badges
26. **Associate Hours Tracking** - Clock in/out system for property associates
   - Associate page: `associates/worktracking.html` (mobile-optimized)
   - Admin page: `spaces/admin/worktracking.html`
   - Clock in/out with GPS location, running timer, work photos (before/progress/after)
   - Manual entry with required justification (tracked for transparency)
   - Payment preferences: PayPal, Venmo, Zelle, Square, Cash, Check, Bank/ACH
   - Hourly rate per associate, space association
   - DB: `associate_profiles`, `time_entries`, `work_photos`
   - Service: `shared/hours-service.js`
27. **Identity Verification** - Driver's license verification via Gemini Vision API
   - `verify-identity` edge function: photo → Gemini Vision → extract name/DOB/DL#/address
   - Auto-compares to applicant or associate profile data
   - Auto-approves exact matches, flags mismatches for admin review
   - Tokenized secure upload links (expire after 7 days)
   - Storage: `identity-documents` bucket
   - Associates can self-initiate from Hours page Payment tab
   - DB: `upload_tokens`, `identity_verifications`
28. **PayPal Payouts** - Instant associate payments via PayPal
   - Edge functions: `paypal-payout` (send) + `paypal-webhook` (status updates)
   - OAuth client credentials flow for API auth
   - Sandbox + production mode support
   - DB: `paypal_config`, `payouts`
   - Linked to specific `time_entry_ids` for audit trail
   - Gate payouts on identity verification status
29. **Zelle Auto-Recording from Inbound Email** - Automatic payment detection
   - `resend-inbound-webhook` detects Zelle payment confirmation emails
   - Parses sender name, amount, date from email body
   - Auto-creates ledger entry for the payment
   - Fixes Zelle email address: `alpacaplayhouse@gmail.com` (not payments@)
30. **Airbnb iCal Sync** - Two-way calendar sync with Airbnb
   - `airbnb-sync` edge function: fetch Airbnb iCal → create blocking assignments
   - `ical` edge function: export assignments as iCal per space
   - `regenerate-ical`: regenerates on assignment changes
   - Parent/child space cascade: blocking parent blocks all children
   - 21 pre-configured space slugs
31. **Vehicle Management Overhaul** - Renamed `tesla_vehicles` → `vehicles` table
   - Added `owner_name`, `make` fields for non-Tesla vehicles
   - `vehicle_drivers` junction table (vehicles ↔ people)
   - Self-service Tesla OAuth connect/disconnect per vehicle
   - Vehicle visibility filtering by role
   - Vehicle registration email sent automatically after lease signing
32. **PAI Feature Builder** - Autonomous feature implementation from PAI chat
   - `feature-builder/feature_builder.js` on DO droplet
   - PAI can submit feature requests → worker polls DB → runs Claude Code
   - Git workflow: pull → feature branch → commit → merge to main with version bump
   - Systemd service: `feature-builder.service`
33. **Emergency Contacts Page** - `lost.html` for lockout scenarios
   - Phone numbers displayed reversed (obfuscation against scraping)
   - Clean card UI with Haydn, Rahulio, Sonia contacts
34. **Space Access Codes** - Removed (replaced by `password_vault` table with category='house')
35. **UP-SENSE Smart Sensors** - UniFi Protect sensor installation guide
   - `residents/sensorinstallation.html` — step-by-step installation instructions
36. **Mobile App (iOS & Android)** - Native mobile apps via Capacitor 8
   - App ID: `com.alpacaplayhouse.app`, Capacitor 8 wrapping mobile-first SPA
   - 5 tabs: Cameras, Music, Lights, Climate, Cars (bottom tab bar)
   - Dark theme, inline login (email/password + Google OAuth), no page redirects
   - `mobile/app/` — SPA source (index.html, mobile.css, mobile-app.js, tabs/)
   - `mobile/scripts/copy-web.js` — Build script: web assets → www/, inject capacitor.js
   - `shared/services/` — Data layer modules shared between web and mobile
   - Lazy-loaded tab modules via dynamic `import()` on first tab switch
   - `PollManager` class for visibility-based polling (pauses when backgrounded)
   - OTA updates via `@capgo/capacitor-updater` (no App Store resubmission for code changes)
   - Build: `cd mobile && npm run sync` → open in Xcode/Android Studio → Run
37. **Cloudflare R2 Object Storage** - File storage backend replacing Google Drive
   - Bucket `alpacapps` on Cloudflare (APAC region), public dev URL enabled
   - S3-compatible API with AWS Signature V4 authentication
   - Shared helper: `supabase/functions/_shared/r2-upload.ts` (`uploadToR2`, `deleteFromR2`, `getR2PublicUrl`)
   - DB: `r2_config` (credentials/config), `document_index` (file metadata for PAI lookup)
   - Files stored under `documents/` prefix (manuals, guides)
   - Supabase secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL
   - Migrated 2 PDFs from Supabase Storage `instructions-and-manuals` bucket to R2
   - 10 GB free, zero egress fees, $0.015/GB-mo beyond free tier
38. **PAI Email Inbox** - `pai@alpacaplayhouse.com` processes inbound emails
   - Added `pai` to SPECIAL_PREFIXES and loop guard in `resend-inbound-webhook`
   - Gemini classifies emails: question, document, command, or other
   - Questions/commands: forwarded to `alpaca-pai` edge function, PAI reply sent via email
   - Documents: attachments downloaded from Resend, uploaded to R2 (`documents/email-uploads/`), indexed in `document_index` (inactive pending admin review), admin notified
   - Other: forwarded to admin
   - New templates: `pai_email_reply`, `pai_document_received` in send-email
   - New sender: `pai` in SENDER_MAP (`PAI <pai@alpacaplayhouse.com>`)
   - Loop guard prevents feedback loops (self-sent emails to pai@)

39. **Centralized Internal REST API** - Single permissioned edge function for all entity CRUD
   - `supabase/functions/api/index.ts` — main router with 20 resource handlers
   - `supabase/functions/_shared/api-permissions.ts` — permission matrix (5 levels: 0=public → 4=oracle)
   - `supabase/functions/_shared/api-helpers.ts` — auth resolution, response builders, query helpers
   - Endpoint: `POST /functions/v1/api` with `{ resource, action, id?, data?, filters? }`
   - Auth: Bearer JWT, service role key, or future X-API-Key
   - Resources: spaces, people, assignments, tasks, users, profile, vehicles, media, payments, bug_reports, time_entries, events, documents, sms, faq, invitations, password_vault, feature_requests, pai_config, tesla_accounts
   - Smart behaviors: fuzzy name/space resolution on tasks, auto-timestamps, duration computation, role-based vault filtering, rate limiting on feature requests
   - Row-level scoping: residents/associates only see own assignments, time entries, events
   - Soft deletes: spaces (is_archived), documents (is_active), vault (is_active), vehicles (is_active)
   - PAI `manage_data` tool: routes through the API for all data operations, replacing inline query patterns
   - Database schema context added to PAI system prompt
   - API usage logged to `api_usage_log` table
   - Full reference: `API.md`
40. **Brand Style Guide & Email Consistency** - Centralized brand configuration
   - `brand_config` DB table (singleton JSONB) stores all brand tokens: colors, fonts, logos, visual elements, email template specs
   - `shared/brand-config.js` — client-side loader with DB fetch + hardcoded fallback
   - `supabase/functions/_shared/email-brand-wrapper.ts` — branded email shell (header with logo+wordmark, consistent body, footer with address+tagline)
   - `spaces/admin/brand.html` + `brand.js` — visual style guide page showing all brand elements
   - All non-custom emails now wrapped in branded shell (header, footer, button styles, callout boxes)
   - Skip list: `custom`, `staff_invitation`, `pai_email_reply`, `payment_statement` (have their own layouts)
   - Brand page shows: identity, logos, color palette, typography, visual elements, email preview, raw JSON config
   - Colors: warm alpaca palette (cream `#faf9f6`, amber accent `#d4883a`, dark `#1c1618`)
   - Font: DM Sans (300-700 weights)
   - Logos: alpaca head icon + wordmark in dark/light variants (Supabase Storage)
41. **PAI Discord Bot** - Native Discord bot replacing OpenClaw paibot
   - Lightweight Node.js bot (`pai-discord/bot.js`) using discord.js v14
   - Bridges Discord messages → `alpaca-pai` edge function (same as web chat, email, voice)
   - Runs on DO droplet as `pai-discord.service` (systemd, bugfixer user)
   - Auth: service role key with `context.source: "discord"`, user lookup via `app_users.discord_id`
   - Features: per-user conversation history (12 msgs, 30 min TTL), typing indicators, message splitting (2000 char limit)
   - Listens to: configured channel IDs + DMs + @mentions
   - Replaces OpenClaw-based `paibot.service` which had no database/tool access
   - Fixed `alpaca-pai` edge function auth bug: Discord branch was unreachable (caught by email/API condition first)

42. **Anova Precision Oven Integration** - Cloud API control for Anova Precision Oven
   - **API**: Anova Developer API via WebSocket (`wss://devices.anovaculinary.io`)
   - **Auth**: Personal Access Token (PAT) from Anova app (More > Developer > Personal Access Tokens)
   - **Architecture**: Per-request WebSocket in edge function (no DO droplet worker — on-demand only)
   - **Edge function**: `anova-control` (getStatus, startCook, stopCook, setTemperatureUnit)
   - **Data service**: `shared/services/oven-data.js` (display helpers, cook stage builder)
   - **DB**: `anova_config` (PAT/config), `anova_ovens` (cached state in `last_state` JSONB)
   - **Permissions**: `view_oven` (all residents), `control_oven` (all residents), `admin_oven_settings` (admin/oracle)
   - **UI**: Appliances page — live temp, mode, timer, door, fan, steam, heating elements, water tank
   - **Admin settings**: PAT input, test mode toggle, test connection, discovered ovens list
   - **PAI tools**: `get_oven_status`, `control_oven` (chat + voice)
   - **Network**: IP 192.168.1.181, MAC 10:52:1c:be:49:b8, WiFi Alpacalypse, Espressif ESP32
   - **Auto-discovery**: First getStatus creates anova_ovens row from WebSocket device list

43. **Glowforge Laser Cutter Integration** - Read-only status monitoring for Glowforge
   - **API**: Undocumented Glowforge Cloud API (community reverse-engineered)
   - **Auth**: Cookie-based session auth (email/password → CSRF token → login → session cookies)
   - **Architecture**: Per-request in edge function (no DO droplet worker — on-demand only)
   - **Edge function**: `glowforge-control` (getStatus only — no control endpoints documented)
   - **Data service**: `shared/services/glowforge-data.js` (display helpers)
   - **DB**: `glowforge_config` (session cookies/config), `glowforge_machines` (cached state in `last_state` JSONB)
   - **Credentials**: Stored as Supabase secrets (`GLOWFORGE_EMAIL`, `GLOWFORGE_PASSWORD`), not in DB
   - **Permissions**: `view_glowforge` (all residents), `admin_glowforge_settings` (admin/oracle)
   - **UI**: Appliances page "Maker Tools" section — machine name, online/offline status, last activity, refresh button
   - **Admin settings**: Active toggle, test mode toggle, test connection, discovered machines list
   - **Auto-discovery**: First getStatus creates glowforge_machines rows from API response
   - **Cost**: $0 (undocumented API, no rate limits known)

44. **Square Webhook for ACH Payment Tracking** - Async payment status updates
   - **Edge function**: `square-webhook` — receives `payment.created`, `payment.updated`, `refund.created`, `refund.updated`
   - **Signature verification**: HMAC-SHA256 (`x-square-hmacsha256-signature` header)
   - **Key use case**: ACH bank transfer payments go PENDING → COMPLETED/FAILED over 1-3 business days
   - **DB**: `square_config.webhook_signature_key` stores the HMAC key from Square Developer Console
   - **DB**: `square_payments` columns: `square_source_type`, `square_event_id` (dedup), `completed_at`, `failed_at`, `failure_reason`
   - **Notifications**: Sends admin email to `payments@alpacaplayhouse.com` on ACH status changes
   - **Ledger sync**: Automatically updates linked `ledger` entries on payment completion/failure
   - **Dedup**: Tracks `square_event_id` to prevent duplicate processing on webhook retries (up to 11 retries over 24h)
   - **Deployment**: `supabase functions deploy square-webhook --no-verify-jwt`
   - **Setup**: Register webhook at Square Developer Console → Webhooks → Add subscription → copy Signature Key → store in `square_config.webhook_signature_key`
   - **Webhook URL**: `https://aphrrfprbixmhissnjfn.supabase.co/functions/v1/square-webhook`

45. **Stripe Payment Integration** - Full inbound/outbound payment system via Stripe
   - **Inbound payments**: Tenant pay page at `/pay/` with Stripe PaymentElement (ACH bank transfer + card)
   - **Edge functions**: `process-stripe-payment` (create PaymentIntent), `stripe-webhook` (HMAC-verified status updates), `stripe-connect-onboard` (associate Express accounts), `stripe-payout` (outbound transfers)
   - **Payment flow**: PaymentIntent → Payment Element → confirm → webhook → ledger + confirmation email
   - **Confirmation email**: Rich receipt with payment history, outstanding balance calculation, "Pay Now" link for remaining balance
   - **DB**: `stripe_config` (keys, webhook secret, test_mode), `stripe_payments` (intent tracking, ledger linkage), `payment_methods` (Zelle/Venmo/PayPal/ACH display)
   - **Stripe Connect**: Associates onboard Express accounts for direct ACH payouts (gated on identity verification)
   - **Ledger sync**: Webhook creates ledger entries on `payment_intent.succeeded`, links `stripe_payments.ledger_id`
   - **Client service**: `shared/stripe-service.js` (config loader, PaymentIntent creation, Stripe.js loader)
   - **Admin settings**: Stripe section in Settings page (keys, test mode toggle, test connection button)
   - **Deployment**: `stripe-webhook` with `--no-verify-jwt`; others with default JWT
   - **Webhook URL**: `https://aphrrfprbixmhissnjfn.supabase.co/functions/v1/stripe-webhook`
   - **Events**: `payment_intent.succeeded`, `payment_intent.payment_failed`, `transfer.paid/failed/reversed`, `account.updated`

46. **Brave Search API for PAI** - Real-time web search capability for PAI assistant
   - **API**: Brave Search API v1 (`https://api.search.brave.com/res/v1/web/search`)
   - **Auth**: `X-Subscription-Token` header, API key stored as Supabase secret `BRAVE_API_KEY`
   - **Purpose**: Gives PAI the ability to search the web for current events, local businesses, prices, news, and anything not in the property knowledge base
   - **Why Brave over Google**: Gemini's built-in `google_search` is limited/opaque — Brave provides full control over queries, result parsing, and cost tracking
   - **Integration point**: `alpaca-pai` edge function will use as a dedicated `search_web` tool
   - **Cost tracking**: `api_usage_log` with vendor `brave`, category `pai_web_search`
   - **Pricing**: Free tier 2,000 queries/month, Base $5/mo for 20,000 queries
   - **Rate limit**: 1 QPS

47. **Tailwind CSS v4 Integration** - Utility-class CSS alongside existing custom properties
   - **Version**: Tailwind CSS v4.1 (CSS-first config, no `tailwind.config.js`)
   - **Source**: `styles/tailwind.css` — theme definition with AAP tokens + content sources
   - **Output**: `styles/tailwind.out.css` — compiled + minified, committed to repo
   - **CI**: GitHub Actions builds Tailwind before version bump on every push to main
   - **Local dev**: `npm run css:watch` for live rebuilds, `npm run css:build` for one-time
   - **Coverage**: All 54 pages that load `site.css` also load `tailwind.out.css`
   - **Coexistence**: Existing `--aap-*` CSS custom properties remain unchanged; Tailwind adds utility classes
   - **Theme tokens**: `bg-aap-cream`, `text-aap-amber`, `border-aap-border`, `shadow-aap`, `rounded-aap`, etc.
   - **No framework**: Still vanilla HTML/CSS/JS — Tailwind is CSS-only, no React required
   - **Package.json**: Root `package.json` added for Tailwind CLI (`npm run css:build`)

48. **Music Assistant as Sonos Control Plane** - MA-first routing with Sonos fallback
 - `supabase/functions/sonos-control/index.ts` now routes core playback/grouping/library actions to Music Assistant first (`MUSIC_ASSISTANT_URL`, `MUSIC_ASSISTANT_TOKEN`, `USE_MUSIC_ASSISTANT`)
 - Maintains Sonos fallback for compatibility and for actions MA does not cover
 - `announce`, `bass`, `treble`, `loudness`, `balance`, and `tts_preview` remain Sonos-proxy-first
 - Hostinger Caddy is the expected external proxy (`/sonos` and `/ma-api`) to Alpaca Mac over Tailscale
 - Mapping + response-contract notes live in `docs/music-assistant-api-mapping.md`

49. **FlashForge 3D Printer Integration** - Live status + control for FlashForge Adventurer 5M Pro
   - **API**: FlashForge TCP G-code protocol (port 8899, no auth needed)
   - **Printer**: "Alpaca Foundry" — Adventurer 5M Pro, SN SNMSQE9C09604, FW v3.2.7
   - **Architecture**: Per-request via printer proxy on Alpaca Mac (HTTP→TCP bridge)
   - **Proxy chain**: Browser → Supabase edge function → Caddy on Hostinger → Alpaca Mac printer-proxy.js → TCP to printer LAN IP
   - **Proxy**: `scripts/printer-proxy/printer-proxy.js` on Alpaca Mac (port 8903, health check 8904)
   - **LaunchAgent**: `scripts/printer-proxy/com.printer-proxy.plist`
   - **Edge function**: `printer-control` (getStatus, startPrint, pausePrint, resumePrint, cancelPrint, setTemperature, toggleLight, homeAxes, listFiles)
   - **Data service**: `shared/services/printer-data.js` (display helpers, API wrapper)
   - **DB**: `printer_config` (proxy URL/secret/config), `printer_devices` (cached state in `last_state` JSONB)
   - **Permissions**: `view_printer` (all residents), `control_printer` (all residents), `admin_printer_settings` (admin/oracle)
   - **UI**: Appliances page "3D Printing" section — status badge, nozzle/bed temps, print progress bar, LED toggle, pause/resume/cancel controls
   - **Admin settings**: Proxy URL, proxy secret, test mode, active toggle, test connection, discovered printers
   - **Camera**: MJPEG stream at port 8080 (proxied via Caddy/Tailscale)
   - **Network**: LAN IP 192.168.1.106, TCP 8899 (G-code), 8080 (MJPEG camera)
   - **Cost**: $0 (direct TCP, no cloud API)

