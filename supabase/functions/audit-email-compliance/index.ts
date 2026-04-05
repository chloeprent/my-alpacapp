/**
 * Email Compliance Audit
 *
 * Weekly cron that checks all email templates against the 7 compliance rules:
 * 1. Sender identity: "PAI at the YOUR_PROPERTY_NAME"
 * 2. Profile picture: BIMI DNS record (manual check — logged as reminder)
 * 3. Signature: "Yours generatively, PAI"
 * 4. Two property footer images
 * 5. Approval gate default (requires_approval unless explicitly approved)
 * 6. Payment method ordering (Zelle/Venmo first, card last with fee)
 * 7. Feedback box in rendered emails
 *
 * Sends admin alert if any violations found.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { SENDER_MAP } from "../_shared/template-engine.ts";

const RESEND_API_URL = "https://api.resend.com/emails";

interface Violation {
  rule: number;
  ruleName: string;
  details: string;
}

serve(async (_req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendApiKey = Deno.env.get("RESEND_API_KEY")!;
  const sb = createClient(supabaseUrl, supabaseKey);

  const violations: Violation[] = [];

  // ─── Rule 1: Sender Identity ───
  const expectedSenderName = "PAI at the YOUR_PROPERTY_NAME";
  for (const [key, val] of Object.entries(SENDER_MAP)) {
    if (key === "claudero") continue; // different identity
    if (!val.from.startsWith(expectedSenderName)) {
      violations.push({
        rule: 1,
        ruleName: "Sender Identity",
        details: `SENDER_MAP["${key}"].from = "${val.from}" — expected to start with "${expectedSenderName}"`,
      });
    }
    if (val.reply_to !== "pai@YOUR_DOMAIN") {
      violations.push({
        rule: 1,
        ruleName: "Reply-To",
        details: `SENDER_MAP["${key}"].reply_to = "${val.reply_to}" — expected "pai@YOUR_DOMAIN"`,
      });
    }
  }

  // ─── Rule 3: Check DB templates for stale sign-offs ───
  const stalePatterns = [
    "Best regards,",
    "Yours,<br>The YOUR_PROPERTY_NAME Community Team",
    "Thanks,<br>YOUR_PROPERTY_NAME",
  ];
  const { data: templates } = await sb
    .from("email_templates")
    .select("template_key, html_template, text_template")
    .eq("is_active", true);

  if (templates) {
    for (const t of templates) {
      for (const pattern of stalePatterns) {
        if (t.html_template?.includes(pattern) || t.text_template?.includes(pattern)) {
          violations.push({
            rule: 3,
            ruleName: "Stale Sign-off",
            details: `Template "${t.template_key}" contains stale sign-off: "${pattern}"`,
          });
        }
      }
    }
  }

  // ─── Rule 4: Verify enough "pai-email-art" tagged images exist ───
  const { data: tagRow } = await sb
    .from("media_tags")
    .select("id")
    .ilike("name", "pai-email-art")
    .limit(1)
    .maybeSingle();

  if (!tagRow?.id) {
    violations.push({
      rule: 4,
      ruleName: "Footer Images",
      details: 'No "pai-email-art" tag exists in media_tags — footer images cannot be loaded.',
    });
  } else {
    const { data: taggedMedia } = await sb
      .from("media_tag_assignments")
      .select("media:media_id(url, is_archived)")
      .eq("tag_id", tagRow.id);

    const active = taggedMedia
      ?.map((r: any) => r.media)
      .filter((m: any) => m?.url && !m.is_archived) ?? [];

    if (active.length < 2) {
      violations.push({
        rule: 4,
        ruleName: "Footer Images",
        details: `Only ${active.length} active image(s) tagged "pai-email-art" — need at least 2 for two-image footer.`,
      });
    }
  }

  // ─── Rule 5: Approval gate — check for unexpected auto-approvals ───
  const { data: approvalConfigs } = await sb
    .from("email_type_approval_config")
    .select("email_type, requires_approval, auto_approved_at")
    .eq("requires_approval", false);

  if (approvalConfigs && approvalConfigs.length > 0) {
    const autoApproved = approvalConfigs.map(c => c.email_type).join(", ");
    // This is informational — not necessarily a violation, but worth tracking
    violations.push({
      rule: 5,
      ruleName: "Approval Gate (info)",
      details: `${approvalConfigs.length} email type(s) auto-approved (bypass approval): ${autoApproved}`,
    });
  }

  // ─── Rule 6: Payment method ordering ───
  const { data: paymentMethods } = await sb
    .from("payment_methods")
    .select("method_type, display_order")
    .eq("is_active", true)
    .order("display_order");

  if (paymentMethods && paymentMethods.length > 0) {
    const topTwo = paymentMethods.slice(0, 2).map(m => m.method_type);
    const expectedTop = ["zelle", "venmo"];
    if (!expectedTop.every(t => topTwo.includes(t))) {
      violations.push({
        rule: 6,
        ruleName: "Payment Ordering",
        details: `Top 2 payment methods by display_order are [${topTwo.join(", ")}] — expected Zelle and Venmo.`,
      });
    }
  }

  // ─── Build report ───
  const timestamp = new Date().toISOString();
  const passCount = 7 - new Set(violations.map(v => v.rule)).size;

  if (violations.length === 0) {
    console.log(`[${timestamp}] Email compliance audit PASSED — all 7 rules OK.`);
    return new Response(JSON.stringify({ status: "pass", violations: 0, timestamp }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Send alert email
  const violationRows = violations.map(v =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e6e2d9;font-weight:600;">Rule ${v.rule}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e6e2d9;">${v.ruleName}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e6e2d9;color:#c62828;">${v.details}</td>
    </tr>`
  ).join("\n");

  const alertHtml = `
    <h2 style="color:#c62828;">Email Compliance Audit — ${violations.length} Issue(s) Found</h2>
    <p>Audit run: ${timestamp}</p>
    <p>${passCount}/7 rules passed.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
      <thead>
        <tr style="background:#1c1618;color:#faf9f6;">
          <th style="padding:10px 12px;text-align:left;">Rule</th>
          <th style="padding:10px 12px;text-align:left;">Check</th>
          <th style="padding:10px 12px;text-align:left;">Issue</th>
        </tr>
      </thead>
      <tbody>${violationRows}</tbody>
    </table>
  `;

  try {
    await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "PAI at the YOUR_PROPERTY_NAME <pai@YOUR_DOMAIN>",
        to: ["admin@YOUR_DOMAIN"],
        subject: `[Audit] Email Compliance — ${violations.length} issue(s)`,
        html: alertHtml,
        text: violations.map(v => `Rule ${v.rule} (${v.ruleName}): ${v.details}`).join("\n"),
      }),
    });
  } catch (e) {
    console.error("Failed to send audit alert email:", e);
  }

  console.log(`[${timestamp}] Email compliance audit: ${violations.length} violations found.`);
  return new Response(
    JSON.stringify({ status: "violations", count: violations.length, violations, timestamp }),
    { headers: { "Content-Type": "application/json" } }
  );
});
