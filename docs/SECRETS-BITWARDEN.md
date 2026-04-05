# Secrets Management — Bitwarden

## Quick Access (Claude Code)

Unlock Bitwarden in any session — no manual password entry needed:

```bash
export BW_SESSION=$(~/bin/bw-unlock)
```

This retrieves the master password from macOS Keychain and returns a session token.

## Setup

| Component | Location |
|---|---|
| Bitwarden CLI | `/opt/homebrew/bin/bw` |
| Auto-unlock script | `~/bin/bw-unlock` |
| Master password | macOS Keychain (service: `bitwarden-cli`, account: `rahulioson@gmail.com`) |

### How it works

1. `bw-unlock` calls `security find-generic-password` to get the master password from Keychain
2. Passes it to `bw unlock --passwordenv` to get a session token
3. Returns the token for use as `BW_SESSION`

### To update the master password

```bash
security add-generic-password -a "rahulioson@gmail.com" -s "bitwarden-cli" -w "NEW_PASSWORD" -U
```

## Organization Structure

**Org:** ALPU.CA (Bitwarden Families — $40/yr, 6 seats)

| Collection | Items | Purpose |
|---|---|---|
| Alpaca E-Commerce | 0 | Alpaca e-commerce accounts |
| Alpaca House | 11 | Shareable house credentials (WiFi, doors, smart home) |
| Alpaca Internet | 70 | Alpaca business internet accounts |
| DevOps-alpacapps | 65 | AlpacApps infrastructure secrets |
| DevOps-finleg | 10 | Finleg infrastructure secrets |
| DevOps-portsie | 3 | Portsie infrastructure secrets |
| DevOps-shared | 5 | Shared infra (Cloudflare, domains) |
| Family Tax | 16 | SSNs, tax accounts, security questions |
| Haydn Sonnad | 2 | Haydn's accounts |
| Kathy Financial | 10 | Kathy's financial accounts |
| Phoebe Sonnad | 2 | Phoebe's accounts |
| Rahul Ecommerce | 0 | Rahul e-commerce accounts |
| Rahul Financial | 36 | Rahul banking, credit, loans, insurance |
| Rahul General | 190 | Rahul general accounts |
| SubTrust Financial | 2 | Subhash Trust financial accounts |
| Subhash Legacy | 16 | Subhash's accounts |

## Common CLI Commands

```bash
# Unlock
export BW_SESSION=$(~/bin/bw-unlock)

# List all items
bw list items

# Search
bw list items --search "Chase"

# Get item details
bw get item "item-name-or-id"

# Create item (pipe JSON through bw encode)
echo '{"type":1,"name":"Example","login":{"username":"user","password":"pass"}}' | bw encode | bw create item

# Move item to org collection
echo '["collection-id"]' | bw encode | bw move "item-id" "org-id"

# Sync after web vault changes
bw sync
```

## Collection Naming Convention

| Pattern | Example | Contents |
|---|---|---|
| `DevOps-{project}` | `DevOps-alpacapps` | API keys, OAuth, bot tokens, server access for one project |
| `DevOps-shared` | `DevOps-shared` | Cross-project infra (Cloudflare, R2, domain registrars) |
| `{Person} Financial` | `Rahul Financial` | Banks, cards, loans, investments |
| `{Person} General` | `Rahul General` | Utilities, insurance, shopping, govt, medical |
| `{Business} Internet` | `Alpaca Internet` | Business web accounts (Airbnb, VRBO, social media) |
| `Family Tax` | `Family Tax` | SSNs, security Q&A, identity info |
| `Alpaca House` | `Alpaca House` | Shareable house credentials (WiFi, doors, smart home) |

## Item Structure

### API Credentials
- **Title:** `{Service} — {Purpose}` (e.g., "Stripe — Payment Processing")
- **Fields:** API key, OAuth client ID/secret, refresh tokens, base URL, webhook URL

### Server Access
- **Title:** `{Provider} — {Role}` (e.g., "Hostinger VPS — OpenClaw Server")
- **Fields:** IP, SSH user, password, OS, specs, domain

### Login Accounts
- **Title:** `{Service}` or `{Service} — {Context}`
- **Fields:** Account number, card number, autopay account, due date, policy number

## Sharing Collections

To share a collection with someone (e.g., accountant):

1. Invite them: Bitwarden web vault → Organization → Members → Invite
2. Assign collections: grant access to only specific collections
3. Set permissions: read-only or can edit

## Shell Integration (Portsie)

Portsie has additional `bw-*` helper functions for `.env.local` generation:

```bash
source ~/Documents/CodingProjects/portsie/scripts/bw-secrets.sh
bw-env          # Generate .env.local from Bitwarden "Portsie Dev Env" item
bw-get FIELD    # Get a single secret
bw-status       # Check session status
```

See `scripts/bw-profile.sh` (sourced in `~/.zshrc`) for auto-session restore on shell startup.
