# Deployment Workflow

## Cloudflare Pages (Static Site)

Deploys from `main` branch via GitHub Actions → Cloudflare Pages. Push to main and it's live.

### Push Workflow
```bash
git add -A && git commit -m "message"
./scripts/push-main.sh   # pull --rebase, then push
```

### Post-Push Verification
1. Wait ~60s for CI to run (Tailwind build + Cloudflare Pages deploy)
2. `git pull --rebase origin main`
3. Read `version.json` — report version

### Version Format
`vYYMMDD.NN H:MMa` — date + daily counter + Austin time.
CI bumps automatically via GitHub Action on every push. **Never bump locally.**

### Post-Push Output Format
- **Main branch:** "Deployed to main — ..." with test URLs
- **Feature branch:** "Pushed to branch `name` (not yet deployed)" with changed files list

### Cloudflare Pages Setup

1. Create a Cloudflare Pages project connected to your GitHub repo
2. Build command: `npm run css:build`
3. Build output directory: `.` (root — the entire repo is the site)
4. Add GitHub secrets:
   - `CLOUDFLARE_API_TOKEN` — API token with Pages edit permissions
   - `CLOUDFLARE_ACCOUNT_ID` — Your Cloudflare account ID
5. Set GitHub variable `CLOUDFLARE_PAGES_PROJECT` to your project name

### Preview Deployments
Every pull request automatically gets a preview deployment URL:
`https://<branch>.<project>.pages.dev`

## Live URLs

| Environment | URL |
|---|---|
| Custom domain | https://YOUR_DOMAIN/ |
| Cloudflare Pages | https://YOUR_PROJECT.pages.dev/ |
| Resident portal | https://YOUR_DOMAIN/residents/ |
| Admin | https://YOUR_DOMAIN/spaces/admin/manage.html |
| Public spaces | https://YOUR_DOMAIN/spaces/ |
| Payments | https://YOUR_DOMAIN/pay/ |
| Repository | https://github.com/USERNAME/REPO |

## Tailwind CSS

After adding new Tailwind classes, run: `npm run css:build`
