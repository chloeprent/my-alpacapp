# Service Connectivity Audit System

> **Created:** 2026-03-30 | **Status:** Active
> **Problem:** LLM agents waste significant time (3-10 min per session) trying to connect to services — wrong credentials, missing recipes, guessing auth methods.
> **Solution:** Three-layer continuous improvement system that prevents, catches, and audits connection waste.

## The Problem

When Claude Code needs to connect to an external service (SSH, API, R2, HAOS, Sonos, etc.), it often:
1. Tries the wrong credentials or Bitwarden item name
2. Uses the wrong auth method (key vs password, wrong token scope)
3. Connects to the wrong host or account
4. Has no documented recipe and improvises from scratch

**Real example (R2 upload session):** Agent needed to upload an APK to Cloudflare R2. Spent 5+ rounds trying wrong tokens, wrong item names, wrong field names — never completed the upload.

**Root cause:** No copy-paste R2 upload recipe existed. CREDENTIALS.md had outdated syntax but system uses `bw-read` (Bitwarden).

## Architecture

```
Layer 1: PREVENTION (every session, automatic)
  CLAUDE.md Service Connection Protocol
  → Check memory/service-access.md for verified recipe
  → Use bw-read with exact item names from docs
  → Never guess or improvise

Layer 2: CATCH (every session end, automatic)
  Taskmaster stop hook — Step 6
  → "Did any connections fail? Update recipes."

Layer 3: DEEP AUDIT (on demand)
  /connectivity-audit skill
  → 5-phase: detect → analyze → fix → verify → report

Layer 4: SINGLE SOURCE OF TRUTH (database)
  service_connections table in Supabase
  → All recipes queryable via SQL
  → /directory/services.html for visual browsing
  → LLM agents can query programmatically
```

## Database Table: `service_connections`

All service recipes are stored in the `service_connections` table with these key columns:

| Column | Purpose |
|--------|---------|
| `name` | Human-readable name (e.g. "Alpuca — Mac Mini M4") |
| `slug` | URL-safe key (e.g. "alpuca") |
| `category` | server, api, storage, database, iot, network |
| `host`, `port`, `protocol` | Connection details |
| `auth_method` | key, password, token, s3_keys, cookie, none |
| `bw_item_name`, `bw_field_name` | Exact Bitwarden references |
| `connect_command` | Copy-paste command with bw-read calls |
| `common_commands` | JSONB array of labeled commands |
| `status` | working, degraded, down, unknown, decommissioned |
| `last_tested_at` | When recipe was last verified |
| `gotchas` | Text array of common failure modes |
| `tags` | Searchable tags (lan, remote, home-automation, etc.) |

## Web UI: `/directory/services.html`

Card-based directory with:
- Category/status/protocol filters + search
- Click-to-expand detail panel with copy-paste commands
- Status dots (green=working, yellow=degraded, red=down, gray=unknown)
- Bitwarden credential references (item + field names)
- Gotchas and common commands per service

## Key Files

| File | Role |
|------|------|
| `CLAUDE.md` | Service Connection Protocol (auto-loaded) |
| `directory/services.html` + `.js` + `.css` | Web UI |
| `migrations/20260330_service_connections.sql` | Table schema |
| `memory/service-access.md` | Legacy text recipes (being replaced by DB) |
| `~/.claude/skills/connectivity-audit/SKILL.md` | Deep audit skill |
| `~/.claude/skills/taskmaster/hooks/check-completion.sh` | Stop hook with connectivity check |

## Bitwarden Naming Convention

Items: `"ServiceName — Purpose/Scope"`
Fields: `"API Token"`, `"Access Key ID"`, `"Secret Access Key"`, `"SSH Password"`, `"Management API Token"`, `"Client ID"`, `"Client Secret"`
