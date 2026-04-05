# Feature-Aware Documentation Templates

When generating project documentation, only include sections relevant to the user's enabled features. Read `feature-manifest.json` to determine which features are enabled, then concatenate the matching sections below into each doc file.

## CLAUDE.md Generation

Generate `CLAUDE.md` with on-demand doc references only for docs that were actually generated:

```markdown
# {PROJECT_NAME} — Project Directives

> **On-demand docs — load when the task matches:**
{DOC_REFS}

## Mandatory Behaviors

1. After code changes: end response with `vYYMMDD.NN H:MMa [model]` + affected URLs (read `version.json`)
2. Push immediately — Cloudflare Pages deploys on push to main. See `docs/DEPLOY.md`
3. CI bumps version — never bump locally

## Code Guards

- `showToast()` not `alert()` in admin
- Tailwind: use `aap-*` tokens (see `docs/PATTERNS.md`). Run `npm run css:build` after new classes.
{EXTRA_CODE_GUARDS}

## Quick Refs

- **Tech:** Vanilla HTML/JS + Tailwind v4 | Supabase | Cloudflare Pages
- **Live:** {LIVE_URL}
- **Architecture:** Browser → Cloudflare Pages → Supabase (no server-side code)
```

### DOC_REFS — include only for generated docs:
- `docs/CREDENTIALS.md` — always (gitignored, API keys)
- `docs/SCHEMA.md` — always (writing queries, modifying tables)
- `docs/PATTERNS.md` — always (writing UI code, Tailwind styling)
- `docs/DEPLOY.md` — always (pushing, deploying, version questions)
- `docs/KEY-FILES.md` — only if 4+ features enabled
- `docs/INTEGRATIONS.md` — only if any external service configured (email, SMS, payments, etc.)
- `docs/CHANGELOG.md` — only if 6+ features enabled

### EXTRA_CODE_GUARDS — include per feature:
- **rentals/events**: `Filter: .filter(s => !s.is_archived)` client-side
- **residents**: No personal info in consumer views — assignment dates only
- **media**: `openLightbox(url)` for images
- **smart_home (any)**: `media_spaces` not `photo_spaces` — legacy migrated

---

## docs/SCHEMA.md Sections

Always start with core tables. Append feature-specific table docs.

### Core (always included)
```
## Core Tables

### app_users
User accounts linked to Supabase Auth. Role: oracle|admin|staff|resident|associate|demo.
Columns: id, auth_user_id, email, display_name, role, avatar_url, person_id, permissions (JSONB), created_at

### people
Tenants, guests, associates, contacts.
Columns: id, first_name, last_name, email, phone, type, notes, created_at

### spaces
Rental units, amenities, event spaces.
Columns: id, name, type, description, rate_monthly, rate_nightly, beds, baths, sqft, is_listed, is_secret, is_archived, display_order, created_at

### assignments
Bookings linking people to spaces with dates and rates.
Columns: id, person_id, start_date, end_date, rate, status, deposit, notes, early_departure, created_at

### assignment_spaces
Junction table: which spaces are in an assignment.
Columns: id, assignment_id, space_id

### media
All uploaded files (photos, documents, images).
Columns: id, url, filename, mime_type, width, height, caption, category, display_order, created_at

### media_spaces
Junction: media ↔ spaces.
Columns: id, media_id, space_id

### media_tags / media_tag_assignments
Tag system for media organization.

### property_config
Singleton JSONB configuration (property name, domain, email, timezone, WiFi, features).

### brand_config
Singleton JSONB brand styling (colors, fonts, logos).

### user_invitations
Pending user invitations with role and expiry.

### upload_tokens / identity_verifications
Secure upload links and DL verification data.
```

### Feature: email
```
### email_templates
Customizable email templates with subject/body/category.

### inbound_emails
Log of all received emails via Resend webhook.
Columns: id, from_email, to_email, subject, body_text, body_html, received_at
```

### Feature: sms
```
### sms_messages
All SMS sent and received via Telnyx.
Columns: id, direction, from_number, to_number, body, status, telnyx_message_id, created_at

### telnyx_config
Telnyx API configuration (singleton).
```

### Feature: payments_stripe
```
### stripe_config
Stripe API keys and webhook secret (singleton).

### stripe_payments
All Stripe payment records.
Columns: id, payment_intent_id, amount, currency, status, person_id, assignment_id, description, created_at

### ledger
Financial ledger entries (rent, fees, refunds, manual).
Columns: id, type, amount, description, person_id, assignment_id, payment_id, period_start, period_end, created_at

### payouts
Outbound payouts to associates via Stripe Connect or PayPal.

### payment_methods
Display payment methods on the public pay page.
```

### Feature: payments_square
```
### square_config
Square API keys (singleton).

### square_payments
All Square payment records.
```

### Feature: payments_paypal
```
### paypal_config
PayPal API credentials (singleton).
```

### Feature: esignatures
```
### signwell_config
SignWell API configuration (singleton).
```

### Feature: documents
```
### lease_templates
Markdown templates with {{placeholder}} substitution for leases, events, work-trade agreements.
```

### Feature: rentals
```
### rental_applications
Rental application workflow records (status, PDF URLs, SignWell document IDs).
```

### Feature: associates
```
### associate_profiles
Associate metadata and payment preferences.

### time_entries
Clock in/out records with location, duration, paid status.

### work_photos
Before/after work photos linked to time entries.
```

### Feature: lighting
```
### govee_config
Govee API key (singleton).

### govee_devices
Govee light devices and groups.

### govee_models
Govee device model capabilities.
```

### Feature: cameras
```
### camera_streams
HLS stream URLs for security cameras.
```

### Feature: music
```
### sonos_config
Sonos HTTP API endpoint configuration (singleton).
```

### Feature: climate
```
### nest_config
Google Nest SDM API credentials (singleton).

### nest_devices
Nest thermostat devices and current state.

### thermostat_rules
Automated thermostat rules (schedules, eco mode triggers).
```

### Feature: vehicles
```
### tesla_accounts
Tesla Fleet API credentials.

### vehicles
Vehicle state cache (battery, location, lock status).

### vehicle_drivers
Junction: vehicles ↔ people.
```

### Feature: laundry
```
### lg_config
LG ThinQ API credentials (singleton).

### lg_appliances
LG washer/dryer devices.

### push_tokens
FCM push notification tokens for laundry alerts.
```

### Feature: oven
```
### anova_config
Anova API credentials (singleton).

### anova_ovens
Anova precision oven devices.
```

### Feature: printer_3d
```
### printer_config
FlashForge printer proxy configuration (singleton).

### printer_devices
FlashForge 3D printer devices.
```

### Feature: glowforge
```
### glowforge_config
Glowforge cookie-based auth (singleton).

### glowforge_machines
Glowforge laser cutter machines.
```

### Feature: voice
```
### vapi_config
Vapi API credentials (singleton).

### voice_assistants
Voice assistant configurations.

### voice_calls
Voice call logs with transcripts.
```

---

## docs/PATTERNS.md Sections

Always include the base section. Add feature-specific patterns.

### Base (always included)
```
## Design Tokens (Tailwind v4)

Custom tokens: `aap-cream`, `aap-dark`, `aap-amber`, `shadow-aap`, `rounded-aap`
See `styles/tailwind.css` @theme block for full list.

## Auth System

- Supabase Auth with PKCE OAuth flow
- Roles: oracle (4), admin (3), staff (2), resident (1), associate (1), demo (read-only)
- Permission checks: `authState.hasPermission('view_spaces')`
- Shell modules handle auth gating automatically

## Common Patterns

- `showToast(message, type)` — toast notifications (success, error, warning, info)
- `openLightbox(url)` — image viewing with gallery navigation
- ES6 modules with `import/export` — no bundler, native browser modules
- Config singletons: `getPropertyConfig()`, `getBrandConfig()` with 5-min TTL cache
```

### If any smart_home or vehicles feature enabled:
```
## Device Proxy Pattern

Edge functions proxy requests to external device APIs:
1. Client calls edge function with `{ action, device, ... }`
2. Edge function checks user permission
3. Edge function calls external API (Govee, Nest, Tesla, etc.)
4. Returns normalized response

## Polling Pattern (Poll Manager)

`shared/services/poll-manager.js` — reusable polling with:
- Configurable interval
- Exponential backoff on failure
- Visibility-aware pause/resume (stop when tab hidden)
- Manual refresh trigger
```

### If rentals or events feature enabled:
```
## Pipeline Workflow Pattern

Kanban state machine: status field drives the pipeline.
- Rental: inquiry → applied → reviewing → approved → lease_sent → signed → moved_in
- Event: inquiry → reviewing → approved → contract_sent → signed → payment_pending → confirmed
- Status changes trigger email notifications
```

---

## docs/INTEGRATIONS.md Sections

Only include sections for services that were actually configured during setup.

### Section template for each service:
```
## {SERVICE_NAME}

**Purpose:** {what it does}
**Dashboard:** {URL}
**Pricing:** {tier info}
**Edge Functions:** {list of deployed functions}
**DB Tables:** {list of tables}
**Webhook URL:** `https://{SUPABASE_REF}.supabase.co/functions/v1/{webhook-function}`
```

---

## docs/KEY-FILES.md Generation

Only generate if 4+ features are enabled. List files grouped by feature.

### Template:
```
# Key Files

## Core
- `shared/supabase.js` — Supabase client singleton
- `shared/auth.js` — Authentication wrapper
- `shared/admin-shell.js` — Admin page shell (auth, tabs, toast)
- `shared/config-loader.js` — Property config with TTL cache
- `shared/brand-config.js` — Brand styling from DB
- `shared/feature-registry.js` — Config-driven feature toggling
- `shared/error-logger.js` — Client-side error capture
- `login/` — Login page (email/password, Google SSO)
- `contact/` — Public contact form

## {FEATURE_LABEL}
{list files from feature-manifest.json shared, pages, dirs}
```
