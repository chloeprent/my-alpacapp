# Final Validation Checklist & Summary Template

Run all applicable checks before presenting the final summary.

## Validation Checks

### 1. Cloudflare Pages

```bash
# Check site is live
curl -I https://{OWNER}.github.io/{REPO}/ | head -n 1
# Expect: HTTP 200

# Validate HTML is served
curl -s https://{OWNER}.github.io/{REPO}/ | head -n 5
# Expect: <!DOCTYPE html>
```

### 2. Supabase

```bash
# Ensure psql is available (macOS: brew install libpq, Linux: apt install postgresql-client)

# Database connection
psql "{POOLER_STRING}" -c "SELECT version(), current_database(), current_user"

# CLI is linked
supabase status

# List tables
psql "{POOLER_STRING}" -c "\dt"

# RLS enabled on all tables
psql "{POOLER_STRING}" -c "SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true"

# Secrets are set
supabase secrets list
```

### 3. Edge Functions

```bash
# List deployed functions
supabase functions list

# Test each endpoint (expect auth error or 400, NOT 404)
for func in send-email send-sms telnyx-webhook signwell-webhook process-square-payment stripe-webhook resend-inbound-webhook square-webhook; do
  echo "Testing $func..."
  curl -s -o /dev/null -w "%{http_code}" https://{REF}.supabase.co/functions/v1/$func
  echo ""
done
```

### 4. Service API Keys

```bash
# Resend
curl -s -o /dev/null -w "%{http_code}" -X GET https://api.resend.com/domains \
  -H "Authorization: Bearer {RESEND_KEY}"
# Expect: 200

# Telnyx
curl -s -o /dev/null -w "%{http_code}" -X GET "https://api.telnyx.com/v2/phone_numbers/{PHONE}" \
  -H "Authorization: Bearer {TELNYX_KEY}"
# Expect: 200

# Square
curl -s -o /dev/null -w "%{http_code}" -X GET https://connect.squareupsandbox.com/v2/locations \
  -H "Square-Version: 2024-02-14" \
  -H "Authorization: Bearer {SQUARE_TOKEN}"
# Expect: 200

# Stripe
curl -s -o /dev/null -w "%{http_code}" -X GET https://api.stripe.com/v1/balance \
  -u "{STRIPE_SECRET_KEY}:"
# Expect: 200

# SignWell
curl -s -o /dev/null -w "%{http_code}" -X GET https://www.signwell.com/api/v1/templates \
  -H "X-Api-Key: {SIGNWELL_KEY}"
# Expect: 200

# Gemini
curl -s -o /dev/null -w "%{http_code}" -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hi"}]}]}'
# Expect: 200
```

### 5. Storage Buckets

```bash
# List Supabase storage buckets
psql "{POOLER_STRING}" -c "SELECT name, public FROM storage.buckets"

# Verify public policies
psql "{POOLER_STRING}" -c "SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'"
```

### 6. Context Files

```bash
# Both files exist
ls -lh CLAUDE.md CLAUDE.local.md

# CLAUDE.local.md is gitignored
git check-ignore CLAUDE.local.md
# Should output: CLAUDE.local.md

# CLAUDE.md is tracked
git ls-files | grep CLAUDE.md
# Should output: CLAUDE.md
```

---

## Summary Template

After all checks pass, present this summary (fill in actual values):

```
Setup Complete! Your infrastructure is ready.

**Core Stack:**
- GitHub repo: https://github.com/{OWNER}/{REPO}
- Cloudflare Pages: https://{OWNER}.github.io/{REPO}/ (live)
- Supabase project: https://{REF}.supabase.co
- Database: {N} tables with RLS enabled
- Storage: {N} buckets configured

**Services Configured:**
{List each service with validation status}
- Resend (email): API key validated, {N} domains verified
- Telnyx (SMS): Phone {PHONE} active, webhook configured
- Square (payments): Sandbox environment, {N} locations
- Stripe (payments): Sandbox environment, webhook configured
- SignWell (e-signatures): API key validated, webhook configured
- Gemini (AI): API key validated
- Cloudflare R2: Bucket {BUCKET} created, 10 GB free
- DigitalOcean: Droplet at {IP}, SSH validated
- Oracle Cloud: Instance at {IP}, SSH validated

**Edge Functions Deployed:**
{List each with URL}
- send-email: https://{REF}.supabase.co/functions/v1/send-email
- send-sms: https://{REF}.supabase.co/functions/v1/send-sms
- telnyx-webhook: https://{REF}.supabase.co/functions/v1/telnyx-webhook
{...etc}

**Pending Actions:**
{List manual steps the user still needs to complete}
- Telnyx 10DLC registration (required for US SMS) — approval takes 1-2 weeks
- Resend domain verification (optional, improves deliverability)
- Square production credentials (when ready for real payments)
- Stripe production credentials (when ready for real payments)
- Google OAuth consent screen: publish app (currently in Testing mode)

**Claude Code Permissions:**
- File access enabled (Read, Write, Edit)
{List user's optional selections}
- Web Search & Fetch (WebSearch, WebFetch)
- Git commands (Bash(git *))

**Context Files:**
- CLAUDE.md — checked into repo (shareable project context)
- CLAUDE.local.md — gitignored (private credentials)

Your CLAUDE.md and CLAUDE.local.md are complete. Any future Claude Code session will have full context automatically.

**Next steps:**
1. Build your first feature: "Create a landing page with a contact form"
2. Deploy: `git add -A && git commit -m "Add landing page" && git push`
3. Site updates automatically on Cloudflare Pages (30-60 seconds)
```

Only include sections for services that were actually configured. Omit unconfigured services entirely.
