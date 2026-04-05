# Multi-Tenancy Effort Assessment — AlpacApps

**Version:** v260210.88 9:00a  
**Purpose:** Estimate effort to make AlpacApps multi-tenant so other Houses/Centers can sign up and deploy with minimal effort, with Claude Code (Bug Scout / Feature Builder) on each tenant’s own account and the rest run in aggregate, including base subscriptions and usage-based charges.

---

## 1. Current State (Single Tenant)

| Layer | Today |
|-------|--------|
| **Database** | Single Supabase project; ~50+ tables; **no tenant/org concept**. |
| **Config** | ~15 single-row “id=1” config tables (Telnyx, Resend, SignWell, Square, Govee, Nest, Weather, LG, R2, PayPal, Vapi, etc.). |
| **Auth** | `app_users` has `auth_user_id`, role, permissions; no org/tenant. |
| **Edge functions** | 29+ functions; all assume one tenant (e.g. `govee_config.eq('id', 1)`). |
| **Storage** | Buckets: `housephotos`, `lease-documents`, `bug-screenshots`, `identity-documents` — no tenant prefix. |
| **Frontend** | Single codebase; one GitHub Pages deploy; one domain. |
| **Workers (DO)** | Bug Scout, Feature Builder, Tesla poller, LG poller, Image Gen — one Supabase project, shared API keys. |

---

## 2. Target Model (What You Described)

- **Multi-tenant app:** Other Houses/Centers sign up and are “ready to deploy” with no extra effort.
- **Claude Code (Bug Scout / Feature Builder):** On **tenant’s own account** — they use their own API keys / Cursor / worker so you’re not on the hook for that usage.
- **Everything else:** Run **in aggregate** (shared infra, shared billing where you’re billed).
- **Monetization:** **Base subscriptions** + **usage charges** for usage where you are billed (e.g. SMS, email, PAI, payments).

---

## 3. High-Level Architecture Choices

### 3.1 Tenant isolation

- **Recommended:** **Single Supabase project, shared DB, `org_id` on (almost) every table.**  
  - One codebase, one deploy, one set of edge functions.  
  - RLS and all reads/writes scoped by `org_id` (derived from `app_users`).

### 3.2 Tenant identity and routing

- **Option A (simplest):** Tenant from **session only** — same app URL for everyone (e.g. `app.alpacapps.com`); after login, `app_user.org_id` drives all data.  
- **Option B:** **Subdomains** — `{slug}.alpacapps.com`; tenant from subdomain + DB lookup.  
- **Option C:** **Custom domains** per tenant (more ops: DNS, SSL, CORS).

For “no effort to deploy,” A or B is enough; C is optional later.

### 3.3 External integrations (aggregate vs bring-your-own)

- **Aggregate (you’re billed, you charge back):**  
  Use your Telnyx, Resend, Square, etc. for all tenants; **meter usage per org** (e.g. `api_usage_log.org_id`) and bill via base + usage.  
  - Requires: tenant-scoped *routing* (e.g. which phone number / from-address per tenant) and **per-tenant usage logging**.
- **Bring-your-own (optional later):**  
  Tenant supplies API keys (e.g. their Resend key); you store in tenant-scoped config and use their key for their org. No usage billing from you for that.

Starting with **aggregate + usage metering** matches “usage charges where we are being billed.”

### 3.4 Claude Code (Bug Scout / Feature Builder) — “on their account”

**Chosen model: You host workers on DigitalOcean; multiple instances; each job uses the tenant’s Claude plan.**

- **You run and host** the worker (same Bug Scout / Feature Builder codebase) on your own server(s), e.g. DigitalOcean.
- **Multiple instances:** You run **multiple worker processes** (or containers) for scale and availability. They all poll the same queue; each job is claimed by one instance (see below).
- **Tenant’s Claude plan:** For each job, the worker loads **that org’s** Anthropic API key from your DB and runs Claude Code with that key. Usage is billed to the tenant’s Claude/Anthropic account — not yours.
- **Result:** Tenants get a hosted Bug Scout/Feature Builder with “no effort to deploy” (they only add their API key in your UI); you don’t pay for their Claude usage; you can still charge a base or usage fee for the hosting/service.

Details and implementation are in **§ 10 (Hosted workers: multi-instance, tenant’s Claude keys)** below.

---

## 4. Effort Breakdown

### 4.1 Data model and migrations (Large — ~3–4 weeks)

- Introduce **`orgs`** table (id, name, slug, plan, billing_*).
- **Org feature flags:** Either `orgs.features` (JSONB) or **`org_features`** (org_id, feature_key, enabled) so each org can enable only the integrations they use (lighting, cameras, Sonos, climate, laundry, cars, PAI, voice, SMS, etc.). See **§ 14**.
- Add **`org_id`** to all tenant-scoped tables (~50): spaces, people, assignments, app_users, media, rental_applications, sms_messages, govee_devices, nest_devices, vehicles, configs, etc.
- **Config tables:** move from “single row id=1” to “one row per org” (e.g. `telnyx_config(org_id, ...)` with unique on org_id).
- **RLS:** every policy includes `org_id = (SELECT org_id FROM app_users WHERE auth_user_id = auth.uid())` (and handle service role for cron/webhooks).
- Backfill: existing data gets one default `org_id` (e.g. “AlpacApps Residency”).
- Identify **global** tables (e.g. `govee_models` SKU lookup) and leave them without `org_id` or make them org-optional.

### 4.2 Auth and onboarding (Medium — ~1–2 weeks)

- **app_users:** add `org_id` (FK to orgs). Sign-up: create org (or join by invite).
- **user_invitations:** make org-scoped (invite to org); first user creates org.
- **Login/signup UI:** “Create your House” vs “Join existing House” (invite code or link).
- Optional: org settings page (name, slug, timezone).

### 4.3 Edge functions (Large — ~2–3 weeks)

- **Resolve tenant:** From JWT → `app_users` → `org_id`. For webhooks (no JWT): resolve org from payload (e.g. SignWell doc → rental_application → org; Telnyx → phone number → org; Resend inbound → address → org).
- **Every function:** pass `org_id` into all Supabase queries and config reads (e.g. `telnyx_config` per org, not `id=1`).
- **Webhooks:** SignWell, Telnyx, Resend, PayPal, Vapi — each needs a clear rule to get `org_id` from the incoming request, then use tenant-scoped config and data.
- Shared helper: e.g. `getOrgFromRequest(req)` (JWT or webhook payload) and `getConfig(supabase, orgId, 'telnyx_config')`.

### 4.4 Storage (Medium — ~1 week)

- Path prefix by tenant: e.g. `{org_id}/housephotos/...`, `{org_id}/lease-documents/...`.
- RLS/policies so tenants only access their prefix.
- Migrate existing objects into default org’s prefix.
- All client and edge-function uploads/downloads use org-scoped paths.

### 4.5 Frontend (Small–Medium — ~3–5 days)

- Tenant comes from session (`app_user.org_id`). No change to “one deploy” — same GitHub Pages (or future app host); tenant context from auth.
- Optional: subdomain → org lookup and set org in session.
- Admin: “Organization” or “House” in nav/settings; no need for multi-org switcher if one user belongs to one org.
- **Dynamic GUI from org feature flags:** See **§ 14**. Resident and admin nav (tabs, menu items) and optional Settings sections are driven by per-org feature preferences (lighting, cameras, Sonos, Tesla/cars, climate, laundry, PAI, voice, etc.). Nothing is shown for a feature the org hasn’t enabled.

### 4.6 External integrations — aggregate + usage (Medium–Large — ~2–3 weeks)

- **Per-tenant routing:** e.g. Telnyx: which phone number per org; Resend: which from-address or template set; SignWell/Square/PayPal: already tenant-scoped once config is per-org.
- **Usage metering:** you already have `api_usage_log` (vendor, category, units, estimated_cost_usd). Add **`org_id`** (and keep `app_user_id` where useful). All edge functions that call paid APIs insert with `org_id`.
- **Billing:** aggregate `api_usage_log` by `org_id` and period; feed into “usage” component of billing (see below). No need to change vendor contracts initially — same Telnyx/Resend/etc. account; you bill tenants.

### 4.7 Billing: base + usage (Medium — ~1–2 weeks)

- **Base subscription:** Stripe (or similar): plan per org (e.g. Basic / Pro), period, link to `orgs.id`.
- **Usage:** From `api_usage_log` grouped by `org_id`: SMS segments, emails, PAI tokens, payment fees, etc. Either monthly invoice line items or Stripe metered billing.
- **UI:** Optional “Billing” tab per org (invoices, usage summary). Platform-level “Revenue” view for you.

### 4.8 Hosted workers (you host on DO, tenant’s Claude keys)

See **§ 10** for full design. Summary: per-tenant credential storage, job queue with org_id and claim/lock, multiple worker instances on DO, each job runs with that org’s Anthropic key. **Effort:** ~1.5–2.5 weeks.

### 4.9 Domains and hosting (Small if path/session; Medium if subdomains)

- **Path or session only:** No URL change; tenant from login. **Effort:** negligible.
- **Subdomains:** Wildcard DNS `*.alpacapps.com`; resolve org from subdomain; set cookie/session. **Effort:** ~3–5 days.
- **Custom domains:** Per-tenant SSL and CORS. **Effort:** 1–2 weeks (and ongoing ops).

---

## 5. Rough Total Effort (One Full-Stack Dev)

| Phase | Scope | Weeks (approx.) |
|-------|--------|-------------------|
| Data model + RLS + backfill | All tables, configs, RLS | 3–4 |
| Auth + onboarding | orgs, invites, sign-up flows | 1–2 |
| Edge functions | Tenant resolution + scoping in all 29+ | 2–3 |
| Storage | Prefixes + RLS + migration | 1 |
| Frontend | Org context, optional subdomain | 0.5–1 |
| Integrations + usage metering | Per-tenant config + org_id in api_usage_log | 2–3 |
| Billing (base + usage) | Stripe (or similar) + usage aggregation | 1–2 |
| Hosted workers (DO, multi-instance, tenant’s Claude keys) | § 10 | ~1.5–2.5 |
| Per-tenant feature flags + dynamic GUI | § 14 | ~0.5–1 |
| **Total (MVP multi-tenant + aggregate + billing + hosted workers + feature flags)** | | **~12.5–20 weeks** |

- **MVP without billing** (tenant isolation, auth, one default org, no Stripe): ~**8–12 weeks**.
- **With subdomains:** add ~**0.5–1 week**.

---

## 6. What Stays Shared vs Per-Tenant

| Component | Shared (aggregate) | Per-tenant |
|-----------|--------------------|------------|
| Supabase project | ✅ One project | — |
| DB schema | ✅ Same schema, `org_id` everywhere | Data isolated by RLS |
| Edge functions | ✅ Same codebase, tenant from context | — |
| Storage buckets | ✅ Same buckets, paths `{org_id}/...` | — |
| Telnyx / Resend / etc. | ✅ Your accounts, tenant routing + usage log | Config row per org (e.g. phone number) |
| PAI / Gemini / Vapi | ✅ Your keys, usage logged per org | — |
| Bug Scout / Feature Builder | ✅ You host workers on DO (multi-instance) | Their Claude plan (API key per org in DB) |
| Billing | Your Stripe (or similar) | Base subscription + usage per org |

---

## 7. Risks and Mitigations

- **RLS mistakes:** One missing `org_id` or policy can leak data. Mitigation: audit all tables and policies; integration tests that assert tenant A cannot see tenant B’s data.
- **Webhook tenant resolution:** Wrong org from webhook payload can attribute data to wrong tenant. Mitigation: stable mapping (e.g. SignWell doc id → application → org; Telnyx number → org); tests per webhook type.
- **Config migration:** Moving from “id=1” to “per-org” touches many functions. Mitigation: shared `getConfig(orgId, table)` helper; migrate one integration at a time.
- **Usage attribution:** If `api_usage_log` is missing `org_id` on some code paths, usage billing is wrong. Mitigation: add `org_id` to every insert and backfill from `app_user_id` where possible; alert on null `org_id` in new rows.

---

## 8. Suggested Phasing

1. **Phase 1 — Tenant isolation only**  
   Orgs table, `org_id` on tables, RLS, backfill one default org, auth (org create/join). **Org feature flags** (§ 14): `orgs.features` or `org_features`, load in frontend, dynamic resident/admin nav so only enabled features (lighting, cameras, Sonos, cars, etc.) are shown. No billing, no subdomains. **~6–8 weeks.**

2. **Phase 2 — Integrations and usage**  
   Config per org, tenant resolution in all edge functions and webhooks, `org_id` in `api_usage_log`. Edge functions check org feature flag before serving integration APIs. **~2–3 weeks.**

3. **Phase 3 — Billing**  
   Base subscription + usage aggregation and invoicing (Stripe or similar). **~1–2 weeks.**

4. **Phase 4 — Polish**  
   Subdomains (if desired), hosted workers (§ 10), dead simple adoption (§ 12), migration path (§ 13), custom domains if needed. **~1–2 weeks.**

---

## 9. Summary

- **Effort:** About **3–4 months** (one experienced full-stack dev) for a solid MVP: multi-tenant data and auth, tenant-scoped edge functions and storage, aggregate integrations with per-org usage metering, base + usage billing, and hosted workers (you host on DO; each job uses the tenant’s Claude key).
- **Largest chunks:** data model + RLS (~3–4 weeks), edge function tenantization (~2–3 weeks), and integrations + usage metering (~2–3 weeks).
- **Adoption and migration:** Design for **dead simple** onboarding (§ 12) and a **clear path to migrate to their own infrastructure** (§ 13) so adopters can start instantly and move off when they want.

---

## 10. Hosted workers: multi-instance, tenant’s Claude keys

- **Per-tenant credentials:** Table e.g. `org_worker_config(org_id, anthropic_api_key_encrypted, repo_url, github_ssh_key_encrypted?, is_active)`. Only service role / workers can read; keys decrypted in memory only for the duration of a job.
- **Job queue:** `bug_reports` and `feature_requests` have `org_id` and `status`. Add optional `claimed_by_worker_id` and `claimed_at` (or use `SELECT ... FOR UPDATE SKIP LOCKED`) so multiple instances don’t double-process.
- **Worker loop:** Poll for pending jobs (e.g. `status = 'pending'`), claim one, load that org’s Anthropic key from DB, set in env for the child process, run Claude Code, update status. No long-lived tenant keys in process env.
- **Multiple instances:** Run N worker processes (or containers) on DO; same codebase, same queue; claim/lock ensures each job is handled by one instance. Scale by adding more workers.
- **Repo per org (optional):** For Feature Builder / Bug Scout, each org can have its own `repo_url` (and optional SSH key) so fixes and features apply to their repo; or start with one shared repo and branch per org.

---

## 11. Cursor AI development: time and token cost

**What “3–4 months (one experienced full-stack dev)” means in Cursor terms:**

- **Calendar time:** ~12–19 weeks of focused work. With Cursor (or similar AI-assisted dev), the same scope often ships in **less calendar time** (e.g. 25–40% reduction) because boilerplate, repetitive edits, and migration patterns are generated; the human focuses on design, review, and integration. So a plausible range is **~2.5–3.5 months** with heavy AI use, depending on how much is “pattern work” vs. novel design.
- **Human hours:** Total effort is still on the order of **400–700 effective dev hours**. AI doesn’t remove the need for architecture decisions, testing, and debugging; it reduces time per task (e.g. “add org_id to these 20 tables” or “scope this edge function”).
- **Token cost:** Cursor’s pricing is subscription-based (Pro/Business) plus usage for premium models. Exact **token cost** depends on:
  - How many requests and how much context (full codebase vs. single file) per task.
  - Which model is “best” (e.g. Claude Opus vs. Sonnet) and Cursor’s current per-token or per-request pricing.
  - A very rough ballpark for **this** project: if 30–50% of the work is “AI-assisted” at ~50–200K tokens per dev-day (conversations + edits + reads), over ~60–80 dev-days that’s on the order of **~3M–16M input tokens** and **~0.5M–3M output tokens** for the multi-tenant MVP. Convert to cost using Cursor’s current pricing (check **Settings → Usage** or their pricing page).
- **Recommendation:** Use Cursor’s usage dashboard during the first 2–3 weeks of the project to measure tokens per day, then extrapolate for the full MVP. That gives a realistic cost for “best models” without guessing Cursor’s exact rates.

---

## 12. Dead simple for adopters

Goal: **Sign up and be productive in minutes; no DevOps, no required API keys for the base experience.**

- **Signup and first run:**
  - Single flow: **Sign up → Name your House → You’re in.** No “create project” or “configure backend.”
  - First user automatically creates the org; they see the admin dashboard (spaces, people, rentals) with empty or demo data. Optional: one-click “Add sample space” to unblock.
  - **No required config for base tier:** Core features (spaces, people, assignments, rental pipeline, media, resident pages) work with **your** aggregate Supabase and your routing. They never see Supabase, env vars, or API keys unless they opt in to advanced features.

- **Pro/optional features — opt-in only:**
  - **SMS / Voice / Payments / E-sign:** Offered as add-ons. “Turn on SMS” → you assign them a number (or they bring their own later); same for SignWell, Square, etc. Config is in your UI; keys stay on your side for aggregate mode.
  - **Bug Scout / Feature Builder:** “Turn on AI fixes” → single field: **Anthropic API key**. They paste it; you store it per-org and use it only for their jobs. No repo URL required initially (optional “use your own repo” later).
  - **Custom domain / subdomain:** Optional. Default: they use `app.alpacapps.com` (or `{slug}.alpacapps.com`). Custom domain is a later, documented step.

- **Onboarding UX:**
  - Post-signup: short checklist. “Add your first space”, “Invite a teammate”, “Turn on payments (optional)”. No long forms; sensible defaults everywhere.
  - In-app help or short docs: “What is a space?”, “How do residents log in?”. Link to “Migrate to your own infrastructure” when they’re ready (§ 13).

- **Messaging:** “Your data is yours. Start in minutes; move to your own infra when you’re ready.” Reduces perceived lock-in and supports the migration path below.

---

## 13. Path to migrate to their own infrastructure

Goal: **Adopters can move to their own hosting/Supabase when they want, with clear steps and no lock-in.**

- **Data portability (from day one):**
  - **Export my data:** In org settings, “Export all data” → generates a structured export (e.g. JSON or ZIP of JSON/CSV) containing: org profile, spaces, people, assignments, media metadata, rental applications, ledger, users, config (redact secrets or export placeholders). Optionally include storage file listing + signed download URLs for a short window.
  - **Format:** Documented schema (e.g. “export_v1”) so they or a tool can re-import into another system or their own Supabase. No proprietary binary format.
  - **Frequency:** Self-serve, on demand. Optional: “Schedule monthly export to my bucket” (bring-your-own S3/R2 URL with credentials they provide).

- **Config and secrets:**
  - **Export config (no secrets):** Export of non-secret org config (name, slug, feature flags, which integrations are enabled). Secrets (API keys) are never exported; they re-add those in their own deployment.
  - **“Bring your own” from the start:** Where you support it (e.g. Bug Scout API key, optional Telnyx/Resend keys), document that “if you later self-host, you’ll use this same key there.” So they’re not inventing new keys at migration time.

- **Self-hosted / single-tenant option:**
  - **Documented path:** A clear doc: “Migrate to your own infrastructure” with steps: (1) Export your data (above). (2) Create your own Supabase project (and optionally storage). (3) Run schema migrations (same as your multi-tenant schema, minus multi-org or with a single default org). (4) Import the export into that DB (script or Supabase import). (5) Deploy the same app code (or a single-tenant build) pointing at their Supabase URL and keys. (6) Re-add secrets (SignWell, Telnyx, etc.) in their env or config.
  - **Single-tenant build (optional product):** Offer or open-source a “single-tenant” mode: same codebase, `ORG_ID` fixed or omitted, one Supabase project per deploy. They run it on their DO/Railway/Fly.io and point it at their Supabase. You don’t have to host it; you provide the code path and docs.
  - **Workers:** They can run Bug Scout / Feature Builder on their own server (their keys already work); doc: “Point the worker at your Supabase and repo.” No change to worker code; they use their export to seed their DB.

- **Contract and billing:**
  - No long-term lock-in: month-to-month or clear cancellation. On cancellation, “Your data remains exportable for 30 days” (or longer). Makes “dead simple” adoption safe.

Implementing **§ 12** and **§ 13** is mostly product and docs (export API, export format, migration doc, single-tenant deploy path); add ~1–2 weeks to the MVP if you want export and migration docs in scope for launch.

---

## 14. Per-tenant feature flags and dynamic GUI

**Goal:** Each org chooses which integrations they use (lighting, cameras, Sonos, Tesla cars, climate, laundry, PAI, voice, etc.). The GUI shows only what’s enabled for that tenant — nothing is exposed for features they haven’t turned on.

### 14.1 Feature list (toggleable per org)

| Feature key   | Resident-facing              | Admin-facing              | Backend / data                    |
|---------------|------------------------------|---------------------------|-----------------------------------|
| `lighting`    | Lighting tab                 | Settings → Govee          | govee-control, govee_devices      |
| `cameras`     | Cameras tab (+ sensors link) | Settings → Cameras        | camera_streams, cameras.js        |
| `music`       | Music (Sonos) tab            | (config via proxy/server) | sonos-control, sonos-data         |
| `climate`     | Climate tab                  | Settings → Nest           | nest-control, nest_devices        |
| `laundry`     | Laundry tab                  | (config per-org)          | lg-control, lg_appliances         |
| `cars`        | Cars tab                     | Settings → Tesla          | tesla-command, vehicles           |
| `pai`         | PAI widget, Life of PAI      | FAQ/AI, PAI config        | alpaca-pai, pai_config            |
| `voice`       | —                            | Voice tab                 | vapi-server, vapi-webhook         |
| `sms`         | —                            | SMS tab                   | send-sms, telnyx_config           |
| `weather`     | (e.g. on climate/dashboard)   | Settings → Weather        | weather_config                    |

Optional: `events`, `rentals`, `hours`, `accounting` can be feature flags too if you want to offer “core only” vs “full” plans.

### 14.2 Data model

- **Option A — JSONB on orgs:** `orgs.features` = `{ "lighting": true, "cameras": true, "sonos": false, "cars": false, ... }`. Simple; one column; easy to extend.
- **Option B — Rows:** `org_features(org_id, feature_key, enabled)` with one row per feature per org. Easier to query “all orgs with lighting” and to add metadata (e.g. enabled_at) later.

Default for new orgs: either all off (they opt in) or a sensible default set (e.g. lighting, cameras, climate on; cars, voice off).

### 14.3 Loading and using flags in the frontend

- **Load once per session:** When the user logs in or the app loads, fetch org profile including feature flags (e.g. from `app_users` → org → `orgs.features` or join to `org_features`). Store in a small client-side context (e.g. `window.__orgFeatures` or your auth/org module).
- **Resident shell (`resident-shell.js`):** Today tabs are filtered by **permission** (`view_lighting`, `view_cameras`, etc.). Add a **second filter**: show tab only if `orgFeatures[tab.featureKey] === true` (and user has permission). Map each resident tab to a feature key (e.g. Lighting → `lighting`, Music → `music`). If a feature is disabled for the org, that tab is hidden for everyone in that org.
- **Admin shell (`admin-shell.js`):** Same idea. Tabs that are feature-specific (Voice, SMS, and optionally Media, Events, etc.) are shown only when the org has that feature enabled. Settings page can show sections (Govee, Nest, Cameras, Tesla, etc.) only when the corresponding feature is on; or show all sections but with “Enable Lighting” toggles that write to `org_features` / `orgs.features`.
- **Mobile app:** Same logic: tabs in the bottom nav (Cameras, Music, Lights, Climate, Cars) are driven by org feature flags (and permissions). Fetch flags after login and build tab list dynamically.

### 14.4 Admin UI for choosing features

- **Org Settings → Features (or “Integrations”):** List of toggleable features with short labels (Lighting, Cameras, Music (Sonos), Climate, Laundry, Cars, PAI, Voice calling, SMS, Weather). Admin turns on only what they use. Optional: link each to the relevant config (e.g. “Lighting” → “Add Govee API key” or “Managed by us”).
- **First-run / onboarding:** Optional “Which of these do you want to use?” checklist during org setup, pre-setting `orgs.features` so the GUI is tailored from day one.

### 14.5 Backend behavior

- **Edge functions:** For integration-specific endpoints (govee-control, sonos-control, nest-control, tesla-command, lg-control, alpaca-pai, vapi-server, send-sms, etc.), after resolving `org_id`, check that the org has the corresponding feature enabled. If not, return `403 Forbidden` or a clear “Feature not enabled” so tenants can’t call APIs for disabled features.
- **Data services / RLS:** Optionally, restrict read access to integration tables (govee_devices, camera_streams, nest_devices, vehicles, lg_appliances, etc.) by feature flag (e.g. a policy that joins to orgs.features or org_features). Simpler approach: rely on the GUI hiding everything and edge functions rejecting disabled-feature calls; add RLS by feature later if needed.

### 14.6 Effort

- **Data:** `orgs.features` or `org_features` + migration + default flags: **~0.5–1 day**.
- **Frontend:** Load flags with auth; filter resident and admin tabs (and optional Settings sections) by feature: **~1–2 days**.
- **Admin Features UI:** Settings page with toggles and optional links to config: **~0.5–1 day**.
- **Backend:** Feature check in each integration edge function (shared helper `orgHasFeature(supabase, orgId, 'lighting')`): **~1 day**.
- **Total:** ~**3–5 days** for per-tenant feature flags and dynamic GUI so “everything isn’t exposed to everyone.”
