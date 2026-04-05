# External Systems & API Cost Accounting

> Reference document extracted from CLAUDE.md. Loaded on-demand, not auto-loaded into context.

## API Cost Accounting (REQUIRED)

**Every feature that makes external API calls MUST log usage to the `api_usage_log` table for cost tracking.**

This is non-negotiable. When building or modifying any feature that calls a paid API, you must instrument it to log each API call with its cost data. This lets us track spending by vendor and by feature category.

### The `api_usage_log` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | Auto-generated |
| `vendor` | text NOT NULL | API provider (see vendor list below) |
| `category` | text NOT NULL | Granular feature category (see category list below) |
| `endpoint` | text | API endpoint or operation name |
| `input_tokens` | integer | Input/request tokens (for LLM APIs) |
| `output_tokens` | integer | Output/response tokens (for LLM APIs) |
| `units` | numeric | Non-token usage units (SMS segments, emails, minutes, etc.) |
| `unit_type` | text | What the units represent (e.g., "sms_segments", "emails", "call_minutes", "documents", "api_calls") |
| `estimated_cost_usd` | numeric | Calculated cost for this call |
| `metadata` | jsonb | Additional context (model name, prompt snippet, error info, etc.) |
| `app_user_id` | uuid FK→app_users | User who triggered the call (if applicable) |
| `created_at` | timestamptz | When the API call was made |

### Vendors

Use these exact vendor strings:

| Vendor | Services |
|--------|----------|
| `gemini` | Gemini API (image gen, PAI chat, payment matching) |
| `anthropic` | **Deprecated — do not use.** Workers use Claude CLI; edge functions use Gemini. |
| `vapi` | Vapi voice calls |
| `telnyx` | SMS sending/receiving |
| `resend` | Email sending |
| `signwell` | E-signature documents |
| `square` | Payment processing |
| `stripe` | Payment processing (ACH, card, Connect payouts) |
| `paypal` | Associate payouts |
| `openweathermap` | Weather API |
| `google_sdm` | Nest thermostat API (Google Smart Device Management) |
| `tesla` | Tesla Fleet API |
| `lg_thinq` | LG ThinQ API |
| `anova` | Anova Precision Oven Developer API |
| `glowforge` | Glowforge Cloud API (undocumented) |
| `flashforge` | FlashForge 3D printer TCP API (via proxy) |
| `govee` | Govee Cloud API |
| `supabase` | Supabase platform (storage, edge function invocations) |
| `cloudflare_r2` | Cloudflare R2 object storage |
| `brave` | Brave Search API (web search for PAI) |
| `openrouter` | OpenRouter multi-model gateway (future Gemini alternative) |

### Categories (Granular)

Use descriptive, granular categories that identify the specific feature. Examples:

| Category | Description |
|----------|-------------|
| `spaces_image_gen` | AI-generated space/marketing images |
| `pai_chat` | PAI conversational AI (text chat) |
| `pai_voice` | PAI voice assistant (Vapi calls) |
| `pai_smart_home` | PAI smart home commands (lights, music, climate) |
| `life_of_pai_backstory` | Life of PAI backstory generation |
| `life_of_pai_voice` | Life of PAI voice/personality generation |
| `identity_verification` | DL photo verification via Gemini Vision |
| `lease_esignature` | Lease document e-signatures |
| `payment_matching` | AI-assisted payment matching |
| `bug_analysis` | Bug Scout automated bug analysis |
| `feature_building` | Feature Builder automated implementation |
| `sms_tenant_notification` | SMS notifications to tenants |
| `sms_bulk_announcement` | Bulk SMS announcements |
| `email_tenant_notification` | Email notifications to tenants |
| `email_system_alert` | System alert emails (errors, digests) |
| `email_payment_receipt` | Payment receipt/confirmation emails |
| `weather_forecast` | Weather API calls |
| `nest_climate_control` | Thermostat reads and commands |
| `tesla_vehicle_poll` | Tesla vehicle data polling |
| `tesla_vehicle_command` | Tesla vehicle commands (lock, unlock, etc.) |
| `lg_laundry_poll` | LG washer/dryer status polling |
| `anova_oven_control` | Anova oven commands (start, stop) |
| `anova_oven_poll` | Anova oven status polling |
| `glowforge_status_poll` | Glowforge machine status polling |
| `printer_status_poll` | FlashForge 3D printer status polling |
| `printer_control` | FlashForge 3D printer commands (start, pause, cancel, temp, light) |
| `govee_lighting_control` | Govee light commands |
| `sonos_music_control` | Sonos playback commands |
| `square_payment_processing` | Square payment transactions |
| `stripe_payment_processing` | Stripe inbound payment transactions (ACH, card) |
| `stripe_associate_payout` | Stripe Connect outbound transfers to associates |
| `square_webhook` | Square webhook event receipt |
| `paypal_associate_payout` | PayPal associate payouts |
| `airbnb_ical_sync` | Airbnb calendar sync |
| `r2_document_upload` | Document upload to Cloudflare R2 |
| `pai_email_classification` | PAI email classification via Gemini |
| `pai_web_search` | PAI web search queries via Brave Search API |

**When adding a new feature that uses an API, add a new category to this list.** Categories should be specific enough to answer "how much does X feature cost us per month?"

### How to Log (Edge Functions)

In Supabase edge functions, log after each API call:

```typescript
// After making an API call, log the usage
await supabaseAdmin.from('api_usage_log').insert({
  vendor: 'gemini',
  category: 'pai_chat',
  endpoint: 'generateContent',
  input_tokens: response.usageMetadata?.promptTokenCount,
  output_tokens: response.usageMetadata?.candidatesTokenCount,
  estimated_cost_usd: calculateGeminiCost(inputTokens, outputTokens),
  metadata: { model: 'gemini-2.0-flash', conversation_id: '...' },
  app_user_id: userId
});
```

### How to Log (DO Droplet Workers)

Workers should log via direct Supabase insert (they already have service role keys):

```javascript
await supabase.from('api_usage_log').insert({
  vendor: 'tesla',
  category: 'tesla_vehicle_poll',
  endpoint: 'vehicle_data',
  units: vehicleCount,
  unit_type: 'api_calls',
  estimated_cost_usd: 0, // Free tier / included
  metadata: { vehicles_polled: vehicleNames }
});
```

### Cost Aggregation

The accounting admin page (`spaces/admin/accounting.html`) should show:
- **By vendor**: Total spend per vendor per month
- **By category**: Total spend per category per month
- **Drill-down**: Click vendor → see category breakdown

### Pricing Reference (for cost calculation)

| Vendor | Pricing |
|--------|---------|
| Gemini 2.5 Pro | Input: $1.25/1M tokens, Output: $10.00/1M tokens (PAI chat) |
| Gemini 2.5 Flash | Input: $0.15/1M tokens, Output: $3.50/1M tokens (under 200k context) |
| Gemini 2.0 Flash | Input: $0.10/1M tokens, Output: $0.40/1M tokens |
| Claude (Anthropic) | Varies by model — check current pricing |
| Vapi | ~$0.05-0.15/min (varies by provider + model) |
| Telnyx SMS | ~$0.004/segment outbound, ~$0.001/segment inbound |
| Resend Email | Free tier: 100/day, then $0.00028/email |
| SignWell | Included in plan (25 docs/month free) |
| Square | 2.6% + $0.10 per transaction |
| Stripe | ACH: 0.8% capped at $5; Cards: 2.9% + $0.30; Connect transfers: $0.25/payout |
| PayPal Payouts | $0.25/payout (US) |
| Glowforge | $0 (undocumented API, free) |
| Brave Search | Free: 2,000 queries/mo; Base: $5/mo for 20,000; $0.003/query overage |
| OpenRouter | Pass-through pricing per model — see https://openrouter.ai/models |


## External Systems

### SignWell (E-Signatures)
- API Key: Stored in `signwell_config` table (not hardcoded)
- API Base: `https://www.signwell.com/api/v1`
- Used for rental agreement e-signatures

**Workflow:**
1. Admin generates PDF from lease template (Documents tab)
2. Admin clicks "Send for Signature" → SignWell API creates document
3. Tenant receives email, signs in SignWell
4. Webhook notifies system → downloads signed PDF → stores in Supabase
5. `agreement_status` updated to "signed"

### Resend (Email)
- **Domain**: `alpacaplayhouse.com` (verified, sending + receiving)
- **Account**: wingsiebird@gmail.com
- **API Key**: Stored as Supabase secret `RESEND_API_KEY`
- **Webhook Secret**: Stored as Supabase secret `RESEND_WEBHOOK_SECRET` (SVIX-based)
- **Outbound**: `send-email` Edge Function sends via Resend API (43 templates)
  - From: `notifications@alpacaplayhouse.com` (forwarded emails) or `noreply@alpacaplayhouse.com` (system emails)
  - Client service: `shared/email-service.js`
- **Inbound**: `resend-inbound-webhook` Edge Function (deployed with `--no-verify-jwt`)
  - Webhook URL: `https://aphrrfprbixmhissnjfn.supabase.co/functions/v1/resend-inbound-webhook`
  - Event: `email.received`
  - All inbound emails logged to `inbound_emails` table
  - Webhook payload doesn't include body — fetched separately via Resend API

**DNS Records** (GoDaddy, domain: `alpacaplayhouse.com`):
- MX `@` → `inbound-smtp.us-east-1.amazonaws.com` (priority 10) — inbound receiving
- MX `send` → `feedback-smtp.us-east-1.amazonses.com` (priority 10) — SPF for outbound
- TXT `send` → SPF record for outbound
- TXT `resend._domainkey` → DKIM record

**Inbound Email Routing** (`*@alpacaplayhouse.com`):
| Prefix | Action | Destination |
|--------|--------|-------------|
| `haydn@` | Forward | `hrsonnad@gmail.com` |
| `rahulio@` | Forward | `rahulioson@gmail.com` |
| `sonia@` | Forward | `sonia245g@gmail.com` |
| `team@` | Forward | `alpacaplayhouse@gmail.com` |
| `herd@` | Special logic | (stub — future AI processing) |
| `auto@` | Special logic | Bug report replies → new bug report; others → admin |
| `pai@` | Special logic | Gemini classifies → questions/commands get PAI reply; documents uploaded to R2; other forwarded to admin |
| Everything else | Forward | `alpacaplayhouse@gmail.com` |

### Telnyx (SMS)
- Config stored in `telnyx_config` table (api_key, messaging_profile_id, phone_number, test_mode)
- Outbound: `send-sms` Edge Function calls Telnyx Messages API
- Inbound: `telnyx-webhook` Edge Function receives SMS, stores in `sms_messages` table
- Client service: `shared/sms-service.js` (mirrors email-service.js pattern)
- Admin UI: Settings tab has test mode toggle, compose SMS, bulk SMS, inbound SMS view

### Hostinger VPS (OpenClaw Server)
- **URL:** https://alpaclaw.cloud (domain: `alpaclaw.cloud`, auto-HTTPS via Caddy + Let's Encrypt)
- **IP:** `93.188.164.224` | **SSH:** use password file: `sshpass -f ~/.ssh/alpacapps-hostinger.pass ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@93.188.164.224` (key auth broken on Hostinger; see CLAUDE.local.md for setup)
- **OS:** Ubuntu 24.04, KVM 4, 15 GB RAM, 200 GB disk
- **Docker:** OpenClaw v2026.2.23 chatbot gateway (multi-channel: Discord, WhatsApp, Telegram, Slack)
- **Docker Compose:** `/docker/openclaw-vnfd/docker-compose.yml` with `.env` file
- **Container:** `openclaw-vnfd-openclaw-1` from `ghcr.io/hostinger/hvps-openclaw:latest`
- **Ports:** `43414` (server.mjs proxy) → `18789` (internal gateway)
- **Reverse Proxy:** Caddy v2.11.1 on port 80/443 → localhost:43414 (Caddyfile: `/etc/caddy/Caddyfile`)
- **LLM:** Gemini (free tier) — `gemini-2.5-flash` primary model
- **MCP:** `hostinger-api-mcp` configured in `.mcp.json` for Claude Code management (VM ID: `1433869`)
- **Config file:** `/data/.openclaw/openclaw.json` inside container (NOT `/data/openclaw.json`)
- **IMPORTANT:** OpenClaw's `server.mjs` overwrites config on restart. `.env` sets tokens but does NOT auto-enable Discord — must use `openclaw config set` CLI inside container after recreation.
- **Channels enabled:** Discord (Alpaclaw bot), Telegram
- **Discord Bot:** Alpaclaw (ID: `1476649970823335998`) — DM policy: open, allowFrom: `["*"]`
- **Multi-agent routing:** 2 agents (Alpaclaw 🦙 + PAI 🧠), channel-based bindings route `#alpaclaw` → Alpaclaw, `#pai-in-the-sky` → PAI, DMs → Alpaclaw
- **Discord Server:** Alpacord (ID: `1471023710755487867`)
- **Discord Channels:** `#alpaclaw` (ID: `1477048544501174474`), `#pai-in-the-sky` (ID: `1471024050343247894`)
- **Credentials:** See `CLAUDE.local.md` for SSH password, API tokens, bot tokens, full `.env` contents

### DigitalOcean Droplet (DEPRECATED — migrating to Hostinger + Oracle)
- Runs Bug Scout (`bug_scout.js`) and background workers
- Bug Scout: polls `bug_reports` for pending bugs → runs Claude Code to fix → commits to `bugfix/` branch → merges to main
- Feature Builder: `feature-builder/feature_builder.js` — polls PAI feature requests → runs Claude Code to implement
- Bug fixer repo is a clone of this repo, used for verification screenshots
- Uses `SKILL.md` for API knowledge
- Queries Supabase directly for tenant/space info
- **Workers on droplet:** Bug Scout (`bug-fixer.service`), Tesla Poller (`tesla-poller.service`), Image Gen (`image-gen.service`), LG Poller (`lg-poller.service`), Feature Builder (`feature-builder.service`), PAI Discord Bot (`pai-discord.service`)

### Spotify (Music Integration)
- **API**: Spotify Web API + Authorization Code Flow with PKCE
- **App**: AlpacApps (Development mode)
- **Dashboard**: https://developer.spotify.com/dashboard
- **Config**: `spotify_config` table (client_id, client_secret, tokens)
- **Redirect URIs**: `http://127.0.0.1:8080` (local dev), `https://alpacaplayhouse.com/auth/spotify/callback` (production)
- **Scopes**: TBD (will need `user-read-playback-state`, `user-modify-playback-state`, etc.)
- **DB**: `spotify_config` (single row, id=1)

### Home Automation (Sonos, UniFi, Cameras)
- Full documentation in `HOMEAUTOMATION.md`
- Credentials and IPs in `HOMEAUTOMATION.local.md`
- Alpaca Mac (home server) bridges Hostinger/Oracle nodes to local LAN via Tailscale
- Sonos HTTP API on port 5005 remains for announce + EQ fallback path
- Music Assistant on Alpaca Mac port 8095 is the primary Sonos control plane
- Edge adapter mapping: `docs/music-assistant-api-mapping.md`
- UniFi Network API on UDM Pro port 443: firewall, DHCP, WiFi management
- 12 Sonos zones controllable via `http://<alpaca-tailscale-ip>:5005/{room}/{action}`

### Google Nest (Thermostats)
- **API**: Google Smart Device Management (SDM) API
- **Auth**: OAuth 2.0 with refresh token stored in `nest_config` table
- **Devices**: 3 Nest thermostats — Master, Kitchen, Skyloft
- **LAN IPs**: 192.168.1.111 (Master), .139 (Kitchen), .249 (Skyloft)
- **Edge function**: `nest-control` proxies to SDM API, handles token refresh
- **SDM API base**: `https://smartdevicemanagement.googleapis.com/v1`
- **Traits used**: Temperature, Humidity, ThermostatMode, ThermostatHvac, ThermostatEco, ThermostatTemperatureSetpoint, Connectivity
- **Temperature**: SDM API uses Celsius, UI shows Fahrenheit, edge function converts
- **Rate limit**: 5 QPS per SDM project (polling at 0.1 QPS is well within limit)
- **OAuth setup**: One-time admin flow via Climate tab Settings → "Authorize Google Account". If you get Error 400 redirect_uri_mismatch, add `https://alpacaplayhouse.com/residents/climate.html` to the OAuth client's Authorized redirect URIs in Google Cloud Console (APIs & Services → Credentials).

### OpenWeatherMap (Weather)
- **API**: One Call API 3.0 (with 2.5 free tier fallback)
- **Config**: `weather_config` table (owm_api_key, latitude, longitude, location_name)
- **Location**: 160 Still Forest Dr, Cedar Creek, TX (30.13, -97.46)
- **Display**: Rain windows summary + expandable hourly 48-hour forecast
- **Client-side only**: No edge function needed, API key safe for read-only weather

### Brave Search (Web Search API)
- **API**: Brave Search API v1 (`https://api.search.brave.com/res/v1/web/search`)
- **Auth**: `X-Subscription-Token` header with API key
- **Supabase Secret**: `BRAVE_API_KEY`
- **Purpose**: Real-time web search for PAI — answers questions about current events, local info, businesses, prices, and anything not in the property knowledge base
- **Used by**: `alpaca-pai` edge function (PAI chat + voice) as a dedicated `search_web` tool
- **Why not Google**: Gemini's built-in `google_search` tool is limited and opaque — Brave gives full control over search queries, result count, and response parsing
- **Rate limit**: 1 query/second, 2,000 queries/month (free tier) or 20,000/month (paid)
- **Pricing**: Free tier: 2,000 queries/month; Base: $5/mo for 20,000 queries; $0.003/query overage
- **Response**: JSON with `web.results[]` containing `title`, `url`, `description`, `age` (freshness)
- **Cost tracking**: Logged to `api_usage_log` with vendor `brave`, category `pai_web_search`

### OpenRouter (Multi-Model LLM Gateway)
- **API**: OpenAI-compatible REST API (`https://openrouter.ai/api/v1`)
- **Auth**: `Authorization: Bearer sk-or-v1-...` header
- **Dashboard**: https://openrouter.ai/settings/keys
- **Status**: Not yet integrated — stored for future use as Gemini alternative
- **Why OpenRouter**: Access to 200+ models (MiniMax-M1, DeepSeek R1, Qwen, Llama, Mistral, etc.) through a single API key with OpenAI-compatible interface
- **Notable models for our use case**:
  - `minimax/minimax-m1` — MiniMax-M1 reasoning model, competitive pricing
  - `deepseek/deepseek-r1` — strong reasoning, very cheap
  - `google/gemini-2.5-flash` — same Gemini Flash we use now, but via OpenRouter
  - `qwen/qwen-2.5-72b-instruct` — strong open-source alternative
- **Integration pattern**: Drop-in replacement for Gemini in edge functions — same chat completion API shape as OpenAI
- **Supabase Secret (when ready)**: `OPENROUTER_API_KEY`
- **Cost tracking**: Will use vendor `openrouter` in `api_usage_log`
- **Pricing**: Pass-through per model — see https://openrouter.ai/models

### AI Image Generation (Gemini)
- **Worker:** `/opt/image-gen/worker.js` on DO droplet (systemd: `image-gen.service`)
- **API:** Gemini 2.5 Flash Image (`generateContent` with `responseModalities: ["TEXT","IMAGE"]`)
- **Cost:** ~$0.039/image (1290 output tokens x $30/1M tokens)
- **Storage:** `housephotos/ai-gen/` prefix in Supabase Storage
- **DB:** `image_gen_jobs` table (job queue), results link to `media` table
- **Trigger:** Insert rows into `image_gen_jobs` — worker polls every 10s
- **Batch:** Set `batch_id` + `batch_label` for grouped jobs
- **Cost tracking:** API response includes `usageMetadata` token counts, stored per-job
- **MCP (local):** Nano Banana MCP configured in `.mcp.json` for interactive Claude Code sessions
  - Uses same Gemini API key as the worker
  - Tools: `generate_image`, `edit_image`, `continue_editing`
  - Restart Claude Code after changing `.mcp.json`

### Tesla Vehicle Data Poller + Commands
- **Worker:** `/opt/tesla-poller/worker.js` on DO droplet (systemd: `tesla-poller.service`)
- **API:** Tesla Fleet API (`https://fleet-api.prd.na.vn.cloud.tesla.com`)
- **Auth URL:** `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token`
- **App:** "Tespaca" registered at developer.tesla.com, public key at `.well-known/appspecific/com.tesla.3p.public-key.pem`
- **Fleet creds:** `fleet_client_id`, `fleet_client_secret`, `fleet_api_base` stored per account in `tesla_accounts` table
- **Token rotation:** Refresh tokens may rotate — new token saved immediately after exchange
- **Polling:** Every 5 min, sleep-aware (doesn't wake sleeping cars)
- **DB:** `tesla_accounts` (credentials + Fleet API config), `vehicles` (cached state in `last_state` JSONB), `vehicle_drivers` (vehicle ↔ person junction)
- **Client:** `residents/cars.js` polls Supabase every 30s with visibility-based pause
- **Vehicles:** 6 cars on 1 account: Casper (Model 3 2019), Delphi (Model Y 2023), Sloop (Model Y 2026), Cygnus (Model Y 2026), Kimba (Model Y 2022), Brisa Branca (Model 3 2022)
- **Data tracked:** battery, range, charging state, odometer, climate, location, tire pressure, lock state
- **Commands:** `tesla-command` Supabase edge function — lock, unlock, wake, flash lights, honk horn
- **Commands auth:** resident+ role required (any resident can unlock to rotate cars off chargers)
- **UI:** Lock/unlock and flash buttons on each car card in `residents/cars.js`

### Camera Streaming (go2rtc + Caddy)
- **Server:** go2rtc v1.9.14 on Alpaca Mac (`~/go2rtc/go2rtc`)
- **Config:** `~/go2rtc/go2rtc.yaml` (also in repo at `scripts/go2rtc/go2rtc.yaml`)
- **Protocol:** `rtspx://` (RTSP over TLS, no SRTP) to UniFi Protect on UDM Pro
- **Cameras:** 3 UniFi G5 PTZ cameras × 3 quality levels = 9 streams
- **Proxy:** Caddy on DO droplet at `cam.alpacaplayhouse.com/api/*` → go2rtc:1984 via Tailscale
- **HLS URL format:** `https://cam.alpacaplayhouse.com/api/stream.m3u8?src={stream_name}&mp4`
- **DB:** `camera_streams` table stores stream config (stream_name, proxy_base_url, quality, location)
- **Client:** `residents/cameras.js` loads streams from DB, plays via HLS.js with fMP4 mode (`&mp4` parameter)
- **PTZ:** UniFi Protect API — continuous move at `POST /proxy/protect/api/cameras/{id}/move`, presets at `POST .../ptz/goto/{slot}`
- **CORS:** Caddy strips go2rtc's CORS headers, adds origin-specific ones for `rsonnad.github.io` and `alpacaplayhouse.com`
- **Launchd:** `com.go2rtc` service (KeepAlive + RunAtLoad)
- **Full docs:** `HOMEAUTOMATION.md`

### LG ThinQ (Washer/Dryer)
- **API**: LG ThinQ Connect REST API (PAT auth)
- **PAT Portal**: https://connect-pat.lgthinq.com/
- **API Base**: `https://api-aic.lgthinq.com` (Americas region)
- **Worker**: `/opt/lg-poller/worker.js` on DO droplet (systemd: `lg-poller.service`)
- **Polling**: Every 30s for rapid laundry status updates
- **DB**: `lg_config` (PAT/API config), `lg_appliances` (cached state in `last_state` JSONB)
- **Edge Function**: `lg-control` (status, control, watch/unwatch, push token registration)
- **Push**: FCM push notifications when cycle ends to subscribed watchers
- **QR**: Deep link QR codes on machines → auto-subscribe to notifications
- **Devices**: Washer (192.168.1.246), Dryer (192.168.1.22)
- **Washer states**: POWER_OFF, INITIAL, DETECTING, RUNNING, RINSING, SPINNING, DRYING, STEAM_SOFTENING, COOL_DOWN, RINSE_HOLD, REFRESHING, PAUSE, RESERVED, END, SLEEP, ERROR
- **Dryer states**: POWER_OFF, INITIAL, RUNNING, PAUSE, END, ERROR, DIAGNOSIS, RESERVED
- **Client**: `residents/laundry.js` polls Supabase every 15s with visibility-based pause

### Anova Precision Oven
- **API**: Anova Developer API via WebSocket (`wss://devices.anovaculinary.io`)
- **Auth**: Personal Access Token (PAT) from Anova app → stored in `anova_config` table
- **Architecture**: Per-request WebSocket in `anova-control` edge function (no polling worker)
- **WebSocket flow**: Connect with PAT → receive `EVENT_APO_WIFI_LIST` (device discovery) + `EVENT_APO_STATE` (state) → send commands → close
- **Commands**: `CMD_APO_START` (stages array), `CMD_APO_STOP`, `CMD_APO_SET_TEMPERATURE_UNIT`
- **State data**: temp (dry/wet bulbs), probe, timer, door, fan speed, steam/humidity, heating elements (top/bottom/rear), water tank
- **DB**: `anova_config` (PAT, ws_url), `anova_ovens` (cached state in `last_state` JSONB)
- **Edge function**: `anova-control` — deployed with `--no-verify-jwt`
- **Client**: `residents/appliances.js` renders oven cards with live data + controls
- **PAI tools**: `get_oven_status`, `control_oven` (chat + voice)
- **Device**: IP 192.168.1.181, MAC 10:52:1c:be:49:b8, Espressif ESP32, WiFi Alpacalypse
- **Cost**: $0 (free API, no rate limits documented)

### Glowforge (Laser Cutter)
- **API**: Undocumented Glowforge Cloud API (community reverse-engineered)
- **Auth**: Cookie-based session auth (email/password login → session cookies)
- **Architecture**: Per-request in `glowforge-control` edge function (no polling worker)
- **Auth flow**: GET app.glowforge.com (CSRF token) → POST accounts.glowforge.com/users/sign_in → collect cookies → GET api.glowforge.com/gfcore/users/machines
- **Credentials**: Stored as Supabase secrets (`GLOWFORGE_EMAIL`, `GLOWFORGE_PASSWORD`)
- **Session caching**: Cookies cached in `glowforge_config.session_cookies` with 7-day expiry, auto-re-authenticates on failure
- **Read-only**: No documented control endpoints — status only (machine name, online/offline state, last activity)
- **DB**: `glowforge_config` (session/config), `glowforge_machines` (cached state in `last_state` JSONB)
- **Edge function**: `glowforge-control` — deployed with `--no-verify-jwt`
- **Client**: `residents/appliances.js` renders Glowforge card in "Maker Tools" section
- **Permissions**: `view_glowforge` (all residents), `admin_glowforge_settings` (admin/oracle)
- **Cost**: $0 (undocumented API, no rate limits documented)

### FlashForge (3D Printer)
- **API**: FlashForge TCP G-code protocol (port 8899, no auth needed on LAN)
- **Printer**: "Alpaca Foundry" — Adventurer 5M Pro, SN SNMSQE9C09604, FW v3.2.7
- **Architecture**: Per-request via printer proxy on Alpaca Mac (HTTP→TCP bridge, same pattern as Sonos/cameras)
- **Proxy chain**: Browser → Supabase edge function → Caddy on Hostinger → Alpaca Mac printer-proxy.js (port 8903) → TCP to printer at 192.168.1.106:8899
- **Proxy**: `scripts/printer-proxy/printer-proxy.js` on Alpaca Mac, health check on port 8904
- **LaunchAgent**: `scripts/printer-proxy/com.printer-proxy.plist`
- **Control flow**: M601 S1 (request control) → command → M602 (release control) — proxy handles this automatically
- **Commands**: M115 (info), M105 (temps), M27 (progress), M119 (endstops), M23/M24/M25/M26 (print control), M104/M140 (set temps), M146 (LED), G28 (home), M661 (list files)
- **DB**: `printer_config` (proxy URL, proxy secret, config), `printer_devices` (cached state in `last_state` JSONB)
- **Edge function**: `printer-control` — deployed with `--no-verify-jwt`
- **Data service**: `shared/services/printer-data.js`
- **Client**: `residents/appliances.js` renders printer cards in "3D Printing" section
- **Permissions**: `view_printer` (all residents), `control_printer` (all residents), `admin_printer_settings` (admin/oracle)
- **Camera**: MJPEG stream at `http://192.168.1.106:8080/?action=stream` (proxied via Caddy/Tailscale)
- **Network**: LAN IP 192.168.1.106, build volume 220×220×220mm
- **Cost**: $0 (direct TCP, no cloud API, no rate limits)

### Vapi (AI Voice Calling)
- **API**: Vapi.ai (voice AI platform)
- **Pattern**: Server URL — Vapi calls `vapi-server` edge function on each incoming call to get assistant config dynamically
- **Webhook**: `vapi-webhook` edge function receives call lifecycle events
- **Caller ID**: Matches caller phone → `people` table for personalized greeting
- **Dynamic prompt**: Injects current occupants, availability, caller name into system prompt
- **Tools**: Routes tool calls to PAI (smart home control, property Q&A, send links)
- **DB**: `vapi_config`, `voice_assistants`, `voice_calls`
- **Admin UI**: `spaces/admin/voice.html` — manage assistants, view call logs, configure settings
- **Cost**: ~$0.10-$0.30 per call

### PAI Discord Bot
- **Architecture**: Lightweight Node.js bot that bridges Discord → `alpaca-pai` edge function
- **Source**: `pai-discord/bot.js` (in repo), deployed to `/opt/pai-discord/` on DO droplet
- **Library**: discord.js v14
- **Service**: `pai-discord.service` (systemd, runs as `bugfixer` user)
- **Auth**: Service role key → `alpaca-pai` with `context.source: "discord"`
- **User lookup**: Matches `discord_user_id` → `app_users.discord_id` for role-based access
- **Channels**: Listens to configured `CHANNEL_IDS` + DMs + @mentions
- **History**: In-memory per-user conversation history (12 messages, 30 min TTL)
- **Env vars**: `DISCORD_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CHANNEL_IDS`
- **Discord guild**: Alpacord (ID: `1471023710755487867`), channel `#pai-in-the-sky` (ID: `1471024050343247894`)
- **Install**: `cd pai-discord && bash install.sh` on droplet, then edit `.env`

### Stripe (Inbound Payments + Associate Payouts)
- **API**: Stripe PaymentIntents (inbound ACH/card) + Stripe Connect Transfers (outbound payouts)
- **Auth**: Secret key for server-side, publishable key for client-side Stripe.js
- **Edge functions**: `process-stripe-payment` (create PaymentIntent), `stripe-webhook` (HMAC-SHA256 verified), `stripe-connect-onboard` (Express accounts), `stripe-payout` (transfers)
- **Config**: `stripe_config` table (publishable/secret keys for sandbox + production, webhook secrets, is_active, test_mode, connect_enabled)
- **DB**: `stripe_payments` (PaymentIntent tracking), `payment_methods` (display methods on pay page)
- **Payment page**: `/pay/index.html` — self-service payment with URL params for pre-filling
- **Client service**: `shared/stripe-service.js` (config loader, PaymentIntent creation, Stripe.js v3 loader)
- **Confirmation email**: Rich receipt with payment history, outstanding balance, "Pay Now" link
- **Webhook events**: `payment_intent.succeeded/failed`, `transfer.paid/failed/reversed`, `account.updated`
- **Connect**: Associates onboard Express accounts for direct ACH payouts, gated on identity verification
- **Pricing**: 0.8% capped at $5 per ACH transaction (displayed on pay page)

### PayPal (Associate Payouts)
- **API**: PayPal Payouts API (batch payments)
- **Auth**: OAuth client credentials flow
- **Edge functions**: `paypal-payout` (send) + `paypal-webhook` (status updates)
- **Config**: `paypal_config` table (client_id, client_secret, sandbox variants, test_mode)
- **DB**: `payouts` table (amount, status, time_entry_ids linkage)
- **Supports**: Sandbox + production environments
- **Gated on**: Associate identity verification status

### Camera Talkback (Two-Way Audio via FFmpeg)
- **Relay server**: `scripts/talkback-relay/talkback-relay.js` on Alpaca Mac
- **Protocol**: WebSocket (port 8902) → FFmpeg → UDP to camera:7004
- **Audio pipeline**: Browser PCM S16LE 48kHz mono → FFmpeg → AAC-ADTS 22.05kHz mono 32kbps
- **Cameras**: Alpacamera (192.168.1.173), Front Of House (.182), Side Yard (.110)
- **Health check**: Port 8903
- **LaunchAgent**: `com.talkback-relay.plist`
- **Requires**: FFmpeg installed on Alpaca Mac (`FFMPEG_PATH` env var, defaults to `ffmpeg`)
- **Client**: `residents/cameras.js` CameraTalkback class — Web Audio API microphone capture, push-to-talk UI

### Airbnb (iCal Sync)
- **Edge functions**: `airbnb-sync` (fetch iCal), `ical` (export iCal), `regenerate-ical` (on changes)
- **Inbound**: Fetches Airbnb iCal feeds from `spaces.airbnb_ical_url`
- **Outbound**: Exports assignments per space as iCal (GET `/functions/v1/ical?space={slug}`)
- **Parent cascade**: Blocking parent space blocks all child spaces
- **DB columns on spaces**: `airbnb_ical_url`, `airbnb_link`, `airbnb_rate`, `airbnb_blocked_dates`

### Cloudflare R2 (Object Storage)
- **Account**: Cloudflare AlpacApps (wingsiebird@gmail.com)
- **Bucket**: `alpacapps` (APAC region)
- **S3 API**: `https://<account_id>.r2.cloudflarestorage.com`
- **Public URL**: `https://pub-5a7344c4dab2467eb917ff4b897e066d.r2.dev`
- **Auth**: S3-compatible API with AWS Signature V4
- **Supabase Secrets**: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`
- **DB config**: `r2_config` table (single row, id=1)
- **Shared helper**: `supabase/functions/_shared/r2-upload.ts` — `uploadToR2()`, `deleteFromR2()`, `getR2PublicUrl()`
- **Key paths in bucket**: `documents/` (manuals, guides for PAI lookup)
- **Document tracking**: `document_index` table maps files to R2 URLs with metadata for PAI's `lookup_document` tool
- **Pricing**: 10 GB free, $0.015/GB-mo beyond that, zero egress fees
- **Legacy**: Google Drive folder still has old rental agreements (not programmatically accessed)

### Google Drive (Legacy)
- Rental agreements stored in a shared folder (legacy)
- Not programmatically accessed

