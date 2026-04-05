# Secrets Management Guide

> Cross-project guide for managing secrets with Bitwarden as source of truth.
> Replicable across all projects (alpacapps, finleg, portsie, etc.)

## Architecture: 4-Tier Model

```
Bitwarden Vaults (source of truth)
    ↓ bw-read references
Local Config Files (CREDENTIALS.md, .mcp.json, memory/)
    ↓ bw-read / env injection
Supabase Env Vars (runtime secrets for edge functions)
    ↓ RLS / service role
DB Row-Level Secrets (per-account tokens in config tables)
```

**Rule:** Secrets flow DOWN only. Never copy a runtime secret back up.

## Vault Naming Convention

| Pattern | Example | Contents |
|---------|---------|----------|
| `DevOps-{project}` | `DevOps-alpacapps` | API keys, OAuth, bot tokens, server access for one project |
| `DevOps-shared` | `DevOps-shared` | Cross-project infra (Cloudflare, R2, domain registrars) |

## Item Structure

### API Credentials (`API Credential` category)
```
Title: {Service} — {Purpose}
Tags: [service-name, category]
Sections:
  API Keys/    → token[password], key[password]
  OAuth/       → Client ID, Client Secret[password], Refresh Token[password]
  Config/      → Supabase Secret Name, Free Tier, API Base
  Endpoints/   → Base URL, Auth URL, Webhook URL
```

### Server Access (`Server` category)
```
Title: {Provider} — {Role}
Tags: [provider, ssh]
Sections:
  Account/     → Email, Dashboard Password[password]
  SSH/         → IP, User, Password[password], Auth Method, Command
  Server/      → OS, Specs, Domain, URL
  Docker/      → Tokens, Compose Path, Container
```

### Login Accounts (`Login` category)
```
Title: {Service} — {Context}
Tags: [category-tag]
Fields: username, password
URL: service login page
Sections:
  Billing/     → Autopay Account, Due Date, Account Number
  Policy/      → Policy Number, Coverage, Agent
  Config/      → Webhook URL, Plan details
```

## Reference Format in Config Files

In `CREDENTIALS.md` and memory files, replace plaintext secrets with:

```markdown
- **API Key:** `bw-read "Service Name" "Field"`
```

In shell commands:
```bash
# Inline substitution
curl -H "Authorization: Bearer $(bw-read "Supabase — AlpacApps Project" "Management API Token")"

# sshpass integration
sshpass -p "$(bw-read "Hostinger VPS — OpenClaw Server")" ssh root@host
```

## Setting Up a New Project

1. **Create folder:** `DevOps-{project}` in Bitwarden
2. **Add items:** Follow the structure patterns above
3. **Create CREDENTIALS.md:** Use `bw-read` references (never plaintext)
4. **Supabase secrets:** `supabase secrets set KEY=$(bw-read "Item" "Field")`
5. **MCP config:** Reference via env vars in `.mcp.json`

## Tag Taxonomy

| Tag | Usage |
|-----|-------|
| `core` | Critical infrastructure (Supabase, Cloudflare) |
| `ai` | LLM/AI services (Gemini, OpenRouter) |
| `iot` | Device APIs (Nest, Tesla, Govee) |
| `bot` | Chat bots (Discord, Telegram) |
| `ssh` | Server access |
| `banking` | Financial institutions |
| `insurance` | Insurance policies |
| `utility` | Utilities (electric, water, internet) |
| `austin` / `washington` / `california` | Geographic location |

## Rotation Checklist (future)

When rotating secrets:
1. Generate new secret in the service dashboard
2. Update Bitwarden item
3. Update Supabase env vars: `supabase secrets set KEY=new_value`
4. Restart affected edge functions: `supabase functions deploy <name>`
5. Verify with a test request
6. No need to update CREDENTIALS.md — `bw-read` references stay the same
