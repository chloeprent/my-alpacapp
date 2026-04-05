# Optional Services Setup

Each service follows the same pattern:
1. Ask user for credentials in a single message with all URLs
2. Validate credentials immediately via API
3. Create DB tables, insert config, set Supabase secrets
4. Create and deploy edge functions (webhooks with `--no-verify-jwt`)
5. Create client service module
6. Append to CLAUDE.md + CLAUDE.local.md

---

## Resend (Email)

### Ask User

Pre-construct webhook URL: `https://{REF}.supabase.co/functions/v1/resend-inbound-webhook`

> Sign up at https://resend.com/signup (free: 3,000 emails/month), then:
> 1. Create an API key at https://resend.com/api-keys (Sending access)
> 2. **Optional:** Verify your domain at https://resend.com/domains (add DNS records for SPF/DKIM)
> 3. **Optional — Inbound email:** Add webhook at https://resend.com/webhooks
>    - URL: `https://{REF}.supabase.co/functions/v1/resend-inbound-webhook`
>    - Event: `email.received`
>    - Also need MX record → `inbound-smtp.us-east-1.amazonaws.com`
> 4. Paste the **API key**

### Validate

```bash
curl -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "onboarding@resend.dev",
    "to": ["delivered@resend.dev"],
    "subject": "Test from setup wizard",
    "html": "<p>API key validated</p>"
  }'
```
HTTP 200 = valid. HTTP 401/403 = invalid.

### Then

1. Set secret: `supabase secrets set RESEND_API_KEY={key}`
2. Validate: `supabase secrets list`
3. Create and deploy `supabase/functions/send-email/index.ts`
4. Test function: `curl https://{REF}.supabase.co/functions/v1/send-email` (expect auth error, NOT 404)
5. Create `shared/email-service.js`
6. Append to CLAUDE.md: API key location, from address, webhook URL, template pattern
7. Append to CLAUDE.local.md: API key, domain verification status

---

## Telnyx (SMS)

### Ask User

Pre-construct webhook URL: `https://{REF}.supabase.co/functions/v1/telnyx-webhook`

> Sign up at https://telnyx.com/sign-up and add a payment method, then:
> 1. Buy a number at https://portal.telnyx.com/#/app/numbers/search-numbers (~$1/mo)
> 2. Create a Messaging Profile at https://portal.telnyx.com/#/app/messaging
> 3. In the profile, set inbound webhook to: `https://{REF}.supabase.co/functions/v1/telnyx-webhook`
>    - Webhook API Version: V2, HTTP method: POST
> 4. Assign your number to the profile
> 5. Get API key at https://portal.telnyx.com/#/app/api-keys (Full Access)
>
> Paste: **phone number** (E.164, e.g. +12125551234), **Messaging Profile ID**, **API key**
>
> **Important:** US numbers require 10DLC registration. Go to https://portal.telnyx.com/#/app/messaging/compliance now — create Brand (Sole Proprietor) + Campaign. Approval takes days to weeks.

### Validate

```bash
# Validate API key
curl -X GET https://api.telnyx.com/v2/phone_numbers \
  -H "Authorization: Bearer {API_KEY}"

# Validate phone + profile match
curl -X GET "https://api.telnyx.com/v2/phone_numbers/{PHONE_NUMBER}" \
  -H "Authorization: Bearer {API_KEY}" | jq '.data.messaging_profile_id'
```

### Create Tables

```sql
CREATE TABLE telnyx_config (
  id INT PRIMARY KEY DEFAULT 1,
  api_key TEXT NOT NULL,
  messaging_profile_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  test_mode BOOLEAN DEFAULT false,
  CHECK (id = 1)
);
CREATE TABLE sms_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID REFERENCES people(id),
  direction TEXT CHECK (direction IN ('inbound', 'outbound')),
  from_number TEXT,
  to_number TEXT,
  body TEXT,
  sms_type TEXT,
  telnyx_id TEXT UNIQUE,
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Then

1. Insert config row
2. Set secret: `supabase secrets set TELNYX_API_KEY={key}`
3. Create and deploy `send-sms` edge function
4. Create and deploy `telnyx-webhook` edge function with `--no-verify-jwt`
5. Test webhook: `curl https://{REF}.supabase.co/functions/v1/telnyx-webhook` (expect 400, NOT 404)
6. Create `shared/sms-service.js`
7. Append to CLAUDE.md: webhook URL, tables, edge functions, Bearer token auth pattern
8. Append to CLAUDE.local.md: API key, phone number, Messaging Profile ID, 10DLC status

---

## Square (Payments)

### Ask User

> Sign up at https://squareup.com/signup, then:
> 1. Create app at https://developer.squareup.com/console/en/apps
> 2. Go to Credentials page, copy from Sandbox:
>    - **Application ID** (starts with `sandbox-sq0idb-` or `sq0idp-`)
>    - **Access Token** (sandbox)
> 3. Go to Locations tab, copy **Location ID** for sandbox
>
> Paste: **Application ID**, **Sandbox Access Token**, **Location ID**

### Validate

```bash
curl -X GET https://connect.squareupsandbox.com/v2/locations \
  -H "Square-Version: 2024-02-14" \
  -H "Authorization: Bearer {ACCESS_TOKEN}" \
  -H "Content-Type: application/json"
```
Validate Application ID format: should start with `sandbox-sq0idb-` or `sq0idp-`.

### Create Tables

```sql
CREATE TABLE square_config (
  id INT PRIMARY KEY DEFAULT 1,
  application_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  location_id TEXT NOT NULL,
  environment TEXT CHECK (environment IN ('sandbox', 'production')) DEFAULT 'sandbox',
  is_active BOOLEAN DEFAULT true,
  CHECK (id = 1)
);
CREATE TABLE square_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID REFERENCES people(id),
  amount_cents INT NOT NULL,
  currency TEXT DEFAULT 'USD',
  square_payment_id TEXT UNIQUE,
  status TEXT,
  receipt_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Then

1. Insert config (environment = 'sandbox')
2. Set secret: `supabase secrets set SQUARE_ACCESS_TOKEN={token}`
3. Create and deploy `process-square-payment` edge function
4. Test: expect 400, NOT 404
5. Create `shared/square-service.js` with Web Payments SDK
6. Append to CLAUDE.md: sandbox vs production, SDK URLs, tables
7. Append to CLAUDE.local.md: Application ID, sandbox token, location ID

---

## Square Webhook (ACH Tracking)

Configure after Square payments are set up.

### Ask User

> Register webhook in Square Developer Console:
> 1. Go to your app → Webhooks tab
> 2. Add subscription
> 3. URL: `https://{REF}.supabase.co/functions/v1/square-webhook`
> 4. Events: `payment.created`, `payment.updated`, `refund.created`, `refund.updated`
> 5. Save → Copy the **Signature Key**
> 6. Paste the **Signature Key**

### Add Webhook Columns

```sql
ALTER TABLE square_config ADD COLUMN IF NOT EXISTS webhook_signature_key TEXT;
ALTER TABLE square_payments ADD COLUMN IF NOT EXISTS square_source_type TEXT;
ALTER TABLE square_payments ADD COLUMN IF NOT EXISTS square_event_id TEXT;
ALTER TABLE square_payments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE square_payments ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
ALTER TABLE square_payments ADD COLUMN IF NOT EXISTS failure_reason TEXT;
```

### Then

1. Update config with signature key
2. Create and deploy `square-webhook` with `--no-verify-jwt` (HMAC-SHA256 verification)
3. Test: expect 401 signature mismatch, NOT 404
4. Append to CLAUDE.md: webhook URL, signature pattern, ACH columns, deploy flag

---

## Stripe (Payments + ACH)

### Ask User

> Sign up at https://dashboard.stripe.com/register, then:
> 1. API keys at https://dashboard.stripe.com/test/apikeys
>    - Copy **Publishable key** (`pk_test_...`) and **Secret key** (`sk_test_...`)
> 2. Webhooks at https://dashboard.stripe.com/test/webhooks → Add endpoint
>    - URL: `https://{REF}.supabase.co/functions/v1/stripe-webhook`
>    - Events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `transfer.paid`, `transfer.failed`, `transfer.reversed`, `account.updated`
>    - Copy **Signing secret** (`whsec_...`)
>
> Paste: **Publishable key**, **Secret key**, **Webhook signing secret**

### Validate

```bash
curl -X GET https://api.stripe.com/v1/balance -u "{SECRET_KEY}:"
```
HTTP 200 = valid. HTTP 401 = invalid.

### Create Tables

```sql
CREATE TABLE stripe_config (
  id INT PRIMARY KEY DEFAULT 1,
  publishable_key TEXT, secret_key TEXT,
  sandbox_publishable_key TEXT, sandbox_secret_key TEXT,
  webhook_secret TEXT, sandbox_webhook_secret TEXT,
  connect_enabled BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  test_mode BOOLEAN DEFAULT true,
  CHECK (id = 1)
);
CREATE TABLE stripe_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_type TEXT, reference_type TEXT, reference_id UUID,
  amount NUMERIC, original_amount NUMERIC, fee_code_used TEXT,
  status TEXT CHECK (status IN ('pending','completed','failed','refunded')) DEFAULT 'pending',
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_charge_id TEXT, receipt_url TEXT, error_message TEXT,
  person_id UUID, person_name TEXT,
  ledger_id UUID, is_test BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL, method_type TEXT, account_identifier TEXT,
  account_name TEXT, qr_code_media_id UUID,
  display_order INT DEFAULT 0, is_active BOOLEAN DEFAULT true,
  instructions TEXT
);
```

### Then

1. Insert config (sandbox keys in sandbox columns, test_mode = true)
2. Set secrets: `supabase secrets set STRIPE_SECRET_KEY={key} STRIPE_WEBHOOK_SECRET={secret}`
3. Create and deploy edge functions:
   - `process-stripe-payment` (default JWT)
   - `stripe-webhook` (`--no-verify-jwt`)
   - `stripe-connect-onboard` (default JWT)
   - `stripe-payout` (default JWT)
4. Create `shared/stripe-service.js` (config loader, PaymentIntent, Stripe.js CDN)
5. Create `/pay/index.html` (self-service payment page with PaymentElement)
6. Test webhook: expect 400/signature mismatch, NOT 404
7. Append to CLAUDE.md: config, webhook URL, edge functions, pay page URL, pricing
8. Append to CLAUDE.local.md: keys, webhook secret, test mode

---

## SignWell (E-Signatures)

### Ask User

Pre-construct webhook URL: `https://{REF}.supabase.co/functions/v1/signwell-webhook`

> Sign up at https://www.signwell.com/sign_up/ (free: 3 docs/month, 25 with credit card), then:
> 1. Copy API key at https://www.signwell.com/app/settings/api
> 2. **Optional:** Add webhook at https://www.signwell.com/app/settings/webhooks
>    - URL: `https://{REF}.supabase.co/functions/v1/signwell-webhook`
>    - Event: `document_completed`
>    - Copy **Webhook Secret**
> 3. Paste **API key** (and **Webhook Secret** if configured)

### Validate

```bash
curl -X GET https://www.signwell.com/api/v1/templates \
  -H "X-Api-Key: {API_KEY}"
```
HTTP 200 = valid (even if empty). HTTP 401 = invalid.

### Create Table

```sql
CREATE TABLE signwell_config (
  id INT PRIMARY KEY DEFAULT 1,
  api_key TEXT NOT NULL,
  webhook_secret TEXT,
  test_mode BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  CHECK (id = 1)
);
```

### Then

1. Insert config
2. Set secrets: `supabase secrets set SIGNWELL_API_KEY={key}` (+ webhook secret if provided)
3. Create and deploy `signwell-webhook` with `--no-verify-jwt`
4. Test: expect 400/signature mismatch, NOT 404
5. Create `shared/signwell-service.js` (API wrapper)
6. Create `shared/pdf-service.js` (jsPDF for markdown→PDF)
7. Append to CLAUDE.md: API base, webhook URL, tables
8. Append to CLAUDE.local.md: API key, webhook secret, test/production mode

---

## Google Gemini (AI)

If user also set up Google Sign-In, remind them to use the same Google Cloud project.

### Ask User

> Get a free API key at https://aistudio.google.com/apikey and paste it here.

### Validate

```bash
curl -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"test"}]}]}'
```
HTTP 200 = valid. HTTP 400 with "API_KEY_INVALID" = invalid.

### Then

1. Set secret: `supabase secrets set GEMINI_API_KEY={key}`
2. Validate: `supabase secrets list`
3. Create test edge function or add Gemini usage demo
4. Append to CLAUDE.md: API endpoint, model names (gemini-2.0-flash, gemini-2.5-flash), pricing
5. Append to CLAUDE.local.md: API key, free tier limits (15 RPM, 1500 RPD)

---

## Cloudflare R2 (Object Storage)

### Ask User

> Sign up at https://dash.cloudflare.com/sign-up (free, no credit card), then:
> 1. Go to R2 Object Storage → Create bucket (lowercase name, choose region)
> 2. In bucket Settings, enable Public Development URL
> 3. Go to R2 → Manage R2 API Tokens → Create API token
>    - Name: "Upload Token", Permissions: Object Read & Write, apply to your bucket
> 4. Copy Access Key ID and Secret Access Key (shown only once!)
> 5. Note Account ID (in URL: `dash.cloudflare.com/{ACCOUNT_ID}/r2/...`)
>
> Paste: **Account ID**, **bucket name**, **public dev URL**, **Access Key ID**, **Secret Access Key**

### Then

1. Set Supabase secrets:
   ```bash
   supabase secrets set \
     R2_ACCOUNT_ID="{ACCOUNT_ID}" \
     R2_ACCESS_KEY_ID="{ACCESS_KEY}" \
     R2_SECRET_ACCESS_KEY="{SECRET_KEY}" \
     R2_BUCKET_NAME="{BUCKET}" \
     R2_PUBLIC_URL="{PUBLIC_URL}"
   ```
2. Validate: `supabase secrets list` (should show all 5)
3. Create tables:
   ```sql
   CREATE TABLE r2_config (
     id INT PRIMARY KEY DEFAULT 1,
     account_id TEXT NOT NULL,
     bucket_name TEXT NOT NULL,
     public_url TEXT NOT NULL,
     is_active BOOLEAN DEFAULT true,
     CHECK (id = 1)
   );
   CREATE TABLE document_index (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     title TEXT NOT NULL,
     description TEXT,
     keywords TEXT[],
     source_url TEXT,
     file_type TEXT,
     file_size_bytes INT,
     storage_backend TEXT CHECK (storage_backend IN ('supabase', 'r2')) DEFAULT 'r2',
     is_active BOOLEAN DEFAULT true,
     uploaded_by UUID REFERENCES app_users(id),
     created_at TIMESTAMPTZ DEFAULT NOW(),
     updated_at TIMESTAMPTZ DEFAULT NOW()
   );
   ```
4. Insert config
5. Create `supabase/functions/_shared/r2-upload.ts` with AWS Signature V4:
   - `uploadToR2(key, body, contentType)` → returns public URL
   - `deleteFromR2(key)` → deletes object
   - `getR2PublicUrl(key)` → constructs URL
6. Test with dummy upload (create small file, upload, verify public URL returns 200, delete)
7. Append to CLAUDE.md: S3 endpoint, public URL pattern, helpers, pricing (10 GB free)
8. Append to CLAUDE.local.md: account ID, access keys, bucket name, dashboard URL
