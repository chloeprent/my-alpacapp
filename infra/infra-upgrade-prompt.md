# AlpacApps Infra — Upgrade Prompt

> **Paste this entire file into Claude Code in your project directory.**
> Claude will read the upgrade guide, compare your project against the template, and sync all new features while preserving your custom content.

---

Read https://alpacaplayhouse.com/infra/infra-upgrade-guide.md and upgrade my project to the latest template.

Here's what I need you to do:

1. Add the template as a git remote (if not already):
   git remote add infra-upstream https://github.com/rsonnad/alpacapps-infra.git

2. Fetch the latest:
   git fetch infra-upstream main

3. Cherry-pick ALL of these new files/directories from the template — these are safe to sync and won't overwrite my custom content:

   Infrastructure files:
   - shared/update-checker.js (auto-update notifications)
   - infra/infra-upgrade-guide.md (upgrade guide for future use)
   - docs/SECRETS-BITWARDEN.md (Bitwarden CLI patterns)
   - docs/CLAUDE-TEMPLATE.md (CLAUDE.md template system)
   - docs/LOCAL-AI-SETUP.md (local AI with msty + Gemma 3 + Ollama)
   - docs/TESTING-GUIDE.md (test accounts and QA workflows)
   - infra/infra-upgrade-prompt.md (this file — for future upgrades)

   Updated infrastructure pages:
   - infra/index.html (new Upgrade section with 3 upgrade options + architecture diagram)
   - infra/updates.json (4 new features: DevControl, DevDocs, Secrets, Upgrade Guide)
   - infra/updates.html (feature picker page)

   For each file: git checkout infra-upstream/main -- <path>

4. Update my CLAUDE.md — add these new on-demand doc references if missing:
   > - `docs/SECRETS-BITWARDEN.md` — **load for:** Bitwarden CLI, secrets management, vault organization, sharing credentials
   > - `docs/LOCAL-AI-SETUP.md` — **load for:** local AI models, Ollama, msty, Gemma 3 setup
   > - `docs/TESTING-GUIDE.md` — **load for:** test account credentials, auth testing, QA workflows
   > - `docs/OPEN-BRAIN-SETUP.md` — **load for:** Open Brain session dashboard, AI memory, embeddings

   Also add the upgrade reference block after the first-time setup note:
   > **Upgrading from the template?**
   > Read `infra/infra-upgrade-guide.md` for step-by-step instructions to sync new features from
   > the alpacapps-infra template repo. Machine-readable feature index: `infra/updates.json`

   And add to Quick Refs:
   - **Template repo:** https://github.com/rsonnad/alpacapps-infra
   - **Upgrade guide:** `infra/infra-upgrade-guide.md`

5. Check for new shared/ files I'm missing:
   git diff --name-only HEAD infra-upstream/main -- shared/
   Cherry-pick any new shared utilities.

6. Check for new Supabase migrations:
   git diff --name-only HEAD infra-upstream/main -- supabase/migrations/
   For each new migration, read it and run via Management API if applicable.

7. Rebuild CSS if needed: npm run css:build

8. Commit everything as one atomic commit:
   git commit -m "feat: upgrade infrastructure from alpacapps-infra template ($(date +%Y-%m-%d))"

9. Push to deploy:
   git push origin main

After pushing, show me:
- What files were added/updated
- The deployed version number
- Clickable live URLs for the updated pages
