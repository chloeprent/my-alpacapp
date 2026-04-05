-- Invitation email v5: match website brand (warm amber + cream palette, DM Sans, consistent 8px radius)
-- Branding: "Alpaca Playhouse Austin" wordmark, no address/geography
UPDATE email_templates
SET
  subject_template = 'You''re Invited to Alpaca Playhouse',
  sender_type = 'pai',
  html_template = $html$
<div style="max-width:600px;margin:0 auto;font-family:'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif;background:#faf9f6;border-radius:8px;overflow:hidden;">
  <!-- Header -->
  <div style="background:#1c1618;padding:36px 32px 30px;text-align:center;">
    <h1 style="margin:0;color:#faf9f6;font-size:24px;font-weight:700;letter-spacing:-0.3px;">Alpaca Playhouse Austin</h1>
    <p style="margin:6px 0 0;color:#7d6f74;font-size:13px;font-weight:500;">You've been invited</p>
  </div>
  <!-- Body -->
  <div style="padding:32px 32px 24px;">
    <p style="color:#2a1f23;font-size:16px;line-height:1.65;margin:0 0 14px;font-weight:400;">Hi there,</p>
    <p style="color:#2a1f23;font-size:16px;line-height:1.65;margin:0 0 14px;">You've been invited to join <strong>Alpaca Playhouse</strong> as a {{role}}. You'll have {{role}} access (cameras, lighting, and house info).</p>
    <p style="color:#2a1f23;font-size:16px;line-height:1.65;margin:0 0 24px;">Your access is <strong>pre-approved</strong> — just create your account and you're in.</p>
    <!-- Email callout -->
    <div style="background:#f2f0e8;border:1px solid #e6e2d9;border-radius:8px;padding:20px 24px;margin:0 0 24px;text-align:center;">
      <p style="color:#7d6f74;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;margin:0 0 6px;">Sign in with this email</p>
      <p style="color:#2a1f23;font-size:21px;font-weight:700;margin:0;">{{email}}</p>
    </div>
    <!-- CTA Button -->
    <div style="text-align:center;margin:28px 0;">
      <a href="{{loginUrl}}" style="background:#d4883a;color:#ffffff;padding:14px 36px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:600;font-size:15px;letter-spacing:0.2px;box-shadow:0 2px 8px rgba(212,136,58,0.30);">Sign in to AlpacApps</a>
    </div>
    <!-- Getting Started card -->
    <div style="background:#f2f0e8;border:1px solid #e6e2d9;border-radius:8px;padding:20px 24px;margin:24px 0 0;">
      <p style="color:#7d6f74;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;margin:0 0 14px;">Getting Started</p>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:5px 12px 5px 0;vertical-align:top;color:#d4883a;font-weight:700;font-size:14px;width:22px;">1.</td>
          <td style="padding:5px 0;color:#2a1f23;font-size:14px;line-height:1.55;">Click the button above to go to the login page</td>
        </tr>
        <tr>
          <td style="padding:5px 12px 5px 0;vertical-align:top;color:#d4883a;font-weight:700;font-size:14px;">2.</td>
          <td style="padding:5px 0;color:#2a1f23;font-size:14px;line-height:1.55;">Use <strong>Continue with Google</strong> (one tap) or create a password</td>
        </tr>
        <tr>
          <td style="padding:5px 12px 5px 0;vertical-align:top;color:#d4883a;font-weight:700;font-size:14px;">3.</td>
          <td style="padding:5px 0;color:#2a1f23;font-size:14px;line-height:1.55;">That's it — you'll have immediate access</td>
        </tr>
      </table>
    </div>
  </div>
  <!-- Alpaca art banner -->
  <div style="padding:0 32px;">
    <img src="https://aphrrfprbixmhissnjfn.supabase.co/storage/v1/object/public/housephotos/ai-gen/invite-banner-ghibli.png" alt="Alpaca Playhouse" style="width:100%;display:block;border-radius:8px;" />
  </div>
  <!-- Footer -->
  <div style="padding:24px 32px;text-align:center;">
    <p style="color:#7d6f74;font-size:12px;margin:0;">Questions? Just reply — PAI, our AI assistant, is happy to help.</p>
    <p style="margin:10px 0 0;color:#e6e2d9;font-size:11px;">Alpaca Playhouse Austin &bull; AlpacApps</p>
  </div>
</div>
$html$,
  text_template = $text$Welcome to Alpaca Playhouse!

Hi there,

You've been invited to join Alpaca Playhouse as a {{role}}. Your access is pre-approved.

Sign in with this email: {{email}}

Go to: {{loginUrl}}

Getting Started:
1. Click the link above
2. Use Continue with Google (one tap) or create a password
3. That's it — you'll have immediate access

Questions? Just reply to this email and PAI will help.

— Alpaca Playhouse Austin • AlpacApps$text$,
  version = version + 1,
  updated_at = now()
WHERE template_key = 'staff_invitation' AND is_active = true;
