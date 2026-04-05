# AlpacApps Infra — Upgrade Guide

> **For Claude Code / LLM agents:** This document contains step-by-step instructions
> for upgrading an existing AlpacApps-based project to the latest template features.
> Follow these instructions exactly when a user asks to "upgrade", "sync", or "pull new features."

## Quick Summary

AlpacApps Infra is a template repo. Projects cloned from it diverge over time as they
add custom content. This guide lets you pull **new infrastructure features** from the
template without overwriting project-specific files.

**Template repo:** `https://github.com/rsonnad/alpacapps-infra.git`
**Feature index (machine-readable):** `https://alpacaplayhouse.com/infra/updates.json`
**Human-readable updates page:** `https://alpacaplayhouse.com/infra/updates.html`

---

## Step 1 — Add the template remote (one-time)

```bash
# Check if the remote already exists
git remote -v | grep alpacapps-infra

# If not present, add it:
git remote add infra-upstream https://github.com/rsonnad/alpacapps-infra.git
```

If the remote already exists under a different name, use that name in place of
`infra-upstream` throughout this guide.

## Step 2 — Fetch latest template changes

```bash
git fetch infra-upstream main
```

## Step 3 — See what's new

Compare the project's current state against the template:

```bash
# List files that differ between your project and the latest template
git diff --stat HEAD infra-upstream/main

# See the actual diff for shared infrastructure files
git diff HEAD infra-upstream/main -- \
  shared/ \
  docs/ \
  cloudflare/ \
  feature-manifest.json \
  infra/ \
  CLAUDE.md \
  scripts/ \
  .github/workflows/ \
  supabase/migrations/ \
  eslint.config.mjs
```

## Step 4 — Choose an upgrade strategy

### Option A: Cherry-pick specific files (recommended)

Best when you only want certain new features. For each file or directory you want:

```bash
# Checkout specific files from the template
git checkout infra-upstream/main -- shared/update-checker.js
git checkout infra-upstream/main -- docs/OPEN-BRAIN-SETUP.md
git checkout infra-upstream/main -- cloudflare/claude-sessions/

# For directories with new features
git checkout infra-upstream/main -- shared/services/
```

**Important:** After cherry-picking, review each file for template placeholders
that need replacing:
- `[Your Project Name]` → your project name
- `YOUR_PROJECT.pages.dev` → your actual Cloudflare Pages URL
- `YOUR_SUPABASE_REF` → your Supabase project ref
- `YOUR_SUPABASE_ANON_KEY` → your Supabase anon key

### Option B: Merge the full template branch

Best for catching up on many features at once:

```bash
# Create a temporary branch for the merge
git checkout -b upgrade/infra-sync-$(date +%Y%m%d)

# Merge — allow-unrelated-histories needed if repos diverged
git merge infra-upstream/main --allow-unrelated-histories --no-commit

# Review the merge result carefully
git diff --cached --stat

# Remove any files that are template-only and not relevant to your project
# (e.g., README.md, LICENSE, CUSTOMIZATION.md)
git reset HEAD README.md LICENSE CUSTOMIZATION.md 2>/dev/null
git checkout -- README.md LICENSE CUSTOMIZATION.md 2>/dev/null

# Commit the merge
git commit -m "feat: sync infrastructure updates from alpacapps-infra template"

# Merge back to main
git checkout main
git merge upgrade/infra-sync-$(date +%Y%m%d)
```

### Option C: Diff and manually apply

Best for highly customized projects:

```bash
# Generate a patch of template changes
git diff HEAD infra-upstream/main -- shared/ docs/ cloudflare/ > /tmp/infra-updates.patch

# Review it
cat /tmp/infra-updates.patch

# Apply selectively (with conflict markers for overlaps)
git apply --3way /tmp/infra-updates.patch
```

## Step 5 — Run migrations (if any)

Check for new Supabase migrations:

```bash
# List new migration files from the template
git diff --name-only HEAD infra-upstream/main -- supabase/migrations/
```

For each new migration:
1. Read the migration file to understand what it does
2. Run it via the Supabase Management API (never ask the user to run SQL manually):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"$(cat supabase/migrations/MIGRATION_FILE.sql)\"}" \
  "https://api.supabase.com/v1/projects/$SUPABASE_REF/database/query"
```

## Step 6 — Update CLAUDE.md references

After syncing, make sure your project's `CLAUDE.md` references any new on-demand docs.
Compare against the template's CLAUDE.md:

```bash
git diff HEAD infra-upstream/main -- CLAUDE.md
```

Add any new `> - docs/NEW-DOC.md — **load for:** ...` lines to your project's CLAUDE.md.

## Step 7 — Build and verify

```bash
# Rebuild Tailwind if new classes were added
npm run css:build 2>/dev/null || true

# Check version
cat version.json
```

## Step 8 — Commit and deploy

```bash
git add -A
git commit -m "feat: upgrade infrastructure from alpacapps-infra template ($(date +%Y-%m-%d))"
git push origin main
```

Wait ~60s for Cloudflare Pages to deploy, then verify the live site.

---

## Files safe to sync (shared infrastructure)

These files are generic infrastructure and safe to overwrite from the template:

| Path | Purpose |
|------|---------|
| `shared/*.js` | Auth, config, error logging, polling, components |
| `shared/*.css` | Admin styles, health dashboard styles |
| `shared/services/` | Poll manager, service utilities |
| `docs/*.md` | On-demand reference docs |
| `cloudflare/` | Claude session logging worker |
| `scripts/` | CI scripts, push helpers |
| `.github/workflows/` | Version bumping CI |
| `infra/` | Infrastructure setup pages |
| `feature-manifest.json` | Feature registry |
| `supabase/migrations/` | Database schema extensions |
| `eslint.config.mjs` | Lint config |

## Files to NEVER overwrite

These files contain project-specific content — never replace them from the template:

| Path | Why |
|------|-----|
| `CLAUDE.md` | Has project-specific directives (merge manually) |
| `index.html` | Project homepage |
| `version.json` | Project version state |
| `package.json` | May have different dependencies |
| `supabase/config.toml` | Has project-specific Supabase ref |
| `README.md` | Project-specific documentation |
| Any custom pages | Your content, not template content |

---

## Checking for updates programmatically

The template publishes a machine-readable feature index at:
```
https://alpacaplayhouse.com/infra/updates.json
```

To check which features your project is missing:

```bash
# Fetch the feature index
curl -s https://alpacaplayhouse.com/infra/updates.json | python3 -c "
import json, sys, os
data = json.load(sys.stdin)
for f in data['features']:
    detected = all(os.path.exists(p) for p in f.get('detects', []) if p)
    status = 'installed' if detected else 'AVAILABLE'
    print(f\"[{status}] {f['name']} ({f['date']})\")
"
```

## Troubleshooting

**Merge conflicts:** If `git merge` produces conflicts, resolve them by keeping your
project-specific content and accepting template infrastructure changes.

**Missing dependencies:** After sync, run `npm install` to pick up any new packages.

**Broken styles:** Run `npm run css:build` — new Tailwind classes may need compilation.

**Migration failures:** Check if the migration references tables that don't exist in
your project. Some migrations are optional and depend on features you may not use.
