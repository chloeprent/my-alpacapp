# CLAUDE.md Templates

The setup wizard generates CLAUDE.md based on the user's selected persona and features. Use `references/doc-templates.md` for feature-specific documentation sections. Replace all `{PLACEHOLDERS}` with actual values during setup.

**Doc generation rules:**
- `docs/CREDENTIALS.md`, `docs/SCHEMA.md`, `docs/PATTERNS.md`, `docs/DEPLOY.md` — always generated
- `docs/KEY-FILES.md` — only if 4+ features enabled
- `docs/INTEGRATIONS.md` — only if any external service configured
- `docs/CHANGELOG.md` — only if 6+ features enabled
- Only list generated docs in the `CLAUDE.md` on-demand index

---

## Minimal Profile (Developer Portfolio, Small Business, or few features)

Use for projects with 3 or fewer features beyond core.

```markdown
# {PROJECT_NAME} — Project Directives

> **On-demand docs — load when the task matches:**
> - `docs/CREDENTIALS.md` — SQL queries, deploying functions, API calls
> - `docs/SCHEMA.md` — writing queries, modifying tables, debugging data
> - `docs/PATTERNS.md` — writing UI code, Tailwind styling, testing
> - `docs/DEPLOY.md` — pushing, deploying, version questions

## Mandatory Behaviors

1. After code changes: end response with `vYYMMDD.NN H:MMa [model]` + affected URLs (read `version.json`)
2. Push immediately — Cloudflare Pages deploys on push to main. See `docs/DEPLOY.md`
3. CI bumps version — never bump locally

## Code Guards

- Filter archived items: `.filter(s => !s.is_archived)` client-side
- `showToast()` not `alert()` in admin
- Tailwind: use project tokens (see `docs/PATTERNS.md`). Run `npm run css:build` after new classes.

## Quick Refs

- **Tech:** Vanilla HTML/JS + Tailwind v4 | Supabase | Cloudflare Pages
- **Live:** https://{PROJECT}.pages.dev/
- **Architecture:** Browser → Cloudflare Pages → Supabase (no server-side code)
```

---

## Full Profile (Property Management, Hostel, Personal AI Hub, or many features)

Use for projects with 4+ features. Include all relevant doc references and code guards based on enabled features.

```markdown
# {PROJECT_NAME} — Project Directives

> **On-demand docs — load when the task matches:**
> - `docs/CREDENTIALS.md` — SQL queries, deploying functions, SSH, API calls
> - `docs/SCHEMA.md` — writing queries, modifying tables, debugging data
> - `docs/PATTERNS.md` — writing UI code, Tailwind styling, code review, testing
> - `docs/KEY-FILES.md` — finding files, understanding project structure
> - `docs/DEPLOY.md` — pushing, deploying, version questions
> - `docs/INTEGRATIONS.md` — external APIs, vendor setup, pricing
> - `docs/CHANGELOG.md` — understanding recent changes, migration context

## Mandatory Behaviors

1. After code changes: end response with `vYYMMDD.NN H:MMa [model]` + affected URLs (read `version.json`)
2. On significant decisions: update `PRODUCTDESIGN.md` with **Decision** and **Why**
3. Push immediately — Cloudflare Pages deploys on push to main. See `docs/DEPLOY.md`
4. CI bumps version — never bump locally

## Code Guards

- `media_spaces` not `photo_spaces` — legacy migrated
- Filter archived items: `.filter(s => !s.is_archived)` client-side
- No personal info in consumer views — assignment dates only
- `showToast()` not `alert()` in admin
- `openLightbox(url)` for images
- Tailwind: use project tokens (see `docs/PATTERNS.md`). Run `npm run css:build` after new classes.
- Claude CLI as subprocess, never Anthropic API. Edge functions use Gemini.

## Quick Refs

- **Tech:** Vanilla HTML/JS + Tailwind v4 | Supabase | Cloudflare Pages | Capacitor 8
- **Live:** https://{PROJECT}.pages.dev/
- **Architecture:** Browser → Cloudflare Pages → Supabase (no server-side code)
```

---

## CLAUDE.local.md Template (both profiles)

Always gitignored. Created during setup.

```markdown
# Operator Directives

> **DB access:** Read `docs/CREDENTIALS.md`. Use Supabase Management API (never psql).
> **Push:** Always push immediately. Never bump version locally — CI handles it.
> **After push:** Wait ~60s, `git pull --rebase origin main`, read `version.json`.
> **Links:** Always include clickable URLs to affected pages after every push.
> **SQL:** Run migrations directly via Management API — never ask user to run SQL manually.

## Live URLs

- https://{PROJECT}.pages.dev/ (Cloudflare Pages)
- https://github.com/{USERNAME}/{REPO} (repo)
```
