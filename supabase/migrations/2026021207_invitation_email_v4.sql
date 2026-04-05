-- v4: Fix email contrast — white text on dark bg was hard to read. Now white bg with bold dark text.
UPDATE email_templates
SET
  html_template = $html$
<div style="max-width:600px;margin:0 auto;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);padding:40px 32px 28px;text-align:center;">
    <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Welcome to AlpacApps</h1>
    <p style="margin:8px 0 0;color:#94a3b8;font-size:14px;font-weight:400;">Alpaca Playhouse &bull; Cedar Creek, Texas</p>
  </div>
  <div style="padding:32px;">
    <p style="color:#334155;font-size:16px;line-height:1.6;margin:0 0 16px;">Hi there,</p>
    <p style="color:#334155;font-size:16px;line-height:1.6;margin:0 0 16px;">You've been invited to join <strong style="color:#0f3460;">Alpaca Playhouse</strong> as {{role_label}}. You'll have {{role_description}}.</p>
    <p style="color:#334155;font-size:16px;line-height:1.6;margin:0 0 24px;">Your access is <strong>pre-approved</strong> — just create your account and you're in.</p>
    <div style="background:#f8fafc;border:2px solid #e2e8f0;border-radius:10px;padding:24px 28px;margin:24px 0;text-align:center;">
      <p style="color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;">Sign in with this email</p>
      <p style="color:#0f3460;font-size:22px;font-weight:700;margin:0;letter-spacing:0.2px;">{{email}}</p>
    </div>
    <div style="text-align:center;margin:32px 0;">
      <a href="{{login_url}}" style="background:linear-gradient(135deg,#c2410c 0%,#ea580c 100%);color:#ffffff;padding:16px 40px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:700;font-size:16px;letter-spacing:0.3px;box-shadow:0 4px 12px rgba(194,65,12,0.3);">Sign in to AlpacApps</a>
    </div>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px 24px;margin:24px 0;">
      <p style="color:#64748b;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 12px;">Getting Started</p>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:6px 12px 6px 0;vertical-align:top;color:#c2410c;font-weight:700;font-size:14px;width:24px;">1.</td>
          <td style="padding:6px 0;color:#475569;font-size:14px;line-height:1.5;">Click the button above to go to the login page</td>
        </tr>
        <tr>
          <td style="padding:6px 12px 6px 0;vertical-align:top;color:#c2410c;font-weight:700;font-size:14px;">2.</td>
          <td style="padding:6px 0;color:#475569;font-size:14px;line-height:1.5;">Use <strong>Continue with Google</strong> (one tap) or create a password</td>
        </tr>
        <tr>
          <td style="padding:6px 12px 6px 0;vertical-align:top;color:#c2410c;font-weight:700;font-size:14px;">3.</td>
          <td style="padding:6px 0;color:#475569;font-size:14px;line-height:1.5;">That's it — you'll have immediate access</td>
        </tr>
      </table>
    </div>
    <p style="color:#94a3b8;font-size:13px;text-align:center;margin:24px 0 0;">Questions? Just reply to this email — PAI, our AI assistant, is happy to help.</p>
  </div>
  <div style="padding:0;">
    <img src="https://aphrrfprbixmhissnjfn.supabase.co/storage/v1/object/public/housephotos/ai-gen/invite-banner-ghibli.png" alt="Alpaca Playhouse" style="width:100%;display:block;" />
  </div>
  <div style="background:#f8fafc;padding:20px 32px;text-align:center;border-top:1px solid #e2e8f0;">
    <p style="margin:0;color:#94a3b8;font-size:12px;">Alpaca Playhouse &bull; 160 Still Forest Dr, Cedar Creek, TX 78612</p>
    <p style="margin:6px 0 0;color:#cbd5e1;font-size:11px;">AlpacApps &bull; Where the herd gathers</p>
  </div>
</div>
$html$,
  version = version + 1,
  updated_at = now()
WHERE template_key = 'staff_invitation'
  AND is_active = true;
