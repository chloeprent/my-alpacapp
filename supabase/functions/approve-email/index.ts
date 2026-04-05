/**
 * Email Approval Handler (two-step to defeat Gmail link prefetch)
 *
 * Step 1: GET /functions/v1/approve-email?token=XXX&action=approve_one
 *         → Redirects to confirmation page (no approval happens)
 * Step 2: User clicks "Confirm" → GET with &confirm=1
 *         → Actually sends the email and marks approved
 *
 * Deploy: supabase functions deploy approve-email --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const RESEND_API_URL = "https://api.resend.com/emails";
const CONFIRM_PAGE = "https://YOUR_DOMAIN/admin/email-confirm.html";
const RESULT_PAGE = "https://YOUR_DOMAIN/admin/email-approved.html";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
    });
  }

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    const action = url.searchParams.get("action");
    const confirmed = url.searchParams.get("confirm") === "1";

    if (!token || !action || !["approve_one", "approve_all"].includes(action)) {
      return redirectToResult("error", "Invalid Request", "Missing or invalid token/action.");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // Look up pending approval
    const { data: approval, error } = await sb
      .from("pending_email_approvals")
      .select("*")
      .eq("approval_token", token)
      .single();

    if (error || !approval) {
      return redirectToResult("error", "Not Found", "This approval link is invalid or has expired.");
    }

    if (approval.status !== "pending") {
      // If action is approve_all and confirmed, still allow auto-approving the type
      if (action === "approve_all" && confirmed) {
        await sb.from("email_type_approval_config").update({
          requires_approval: false,
          auto_approved_at: new Date().toISOString(),
          auto_approved_by: "admin_button",
          updated_at: new Date().toISOString(),
        }).eq("email_type", approval.email_type);

        const autoType = approval.email_type.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
        return redirectToResult(
          "success",
          "Type Auto-Approved",
          `This email was already sent, but all future <strong>${autoType}</strong> emails will now send automatically.`,
          autoType,
        );
      }

      // Show "already processed" but offer the option to auto-approve the type
      const ts = new Date(approval.approved_at || approval.created_at)
        .toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });
      return redirectToResult(
        "warning",
        "Already Processed",
        `This email was already ${approval.status} on ${ts} CT.`,
        undefined,
        // Pass token + email_type so the result page can offer "approve type" button
        { token: token!, email_type: approval.email_type },
      );
    }

    if (new Date(approval.expires_at) < new Date()) {
      await sb.from("pending_email_approvals").update({ status: "expired" }).eq("id", approval.id);
      return redirectToResult("warning", "Expired", "This approval link has expired (7-day limit).");
    }

    // ─── STEP 1: Not yet confirmed → redirect to confirmation page ───
    if (!confirmed) {
      const typeLabel = approval.email_type.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
      const recipientDisplay = approval.to_addresses.join(", ");
      const confirmUrl = new URL(CONFIRM_PAGE);
      confirmUrl.searchParams.set("token", token);
      confirmUrl.searchParams.set("action", action);
      confirmUrl.searchParams.set("type", typeLabel);
      confirmUrl.searchParams.set("to", recipientDisplay);
      confirmUrl.searchParams.set("subject", approval.subject);
      return Response.redirect(confirmUrl.toString(), 302);
    }

    // ─── STEP 2: Confirmed → send the email ───
    const sendPayload: Record<string, unknown> = {
      from: approval.from_address,
      to: approval.to_addresses,
      subject: approval.subject,
      html: approval.html,
      text: approval.text_content || undefined,
    };
    if (approval.reply_to) sendPayload.reply_to = approval.reply_to;
    if (approval.cc?.length) sendPayload.cc = approval.cc;
    if (approval.bcc?.length) sendPayload.bcc = approval.bcc;

    const sendRes = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sendPayload),
    });

    if (!sendRes.ok) {
      const errBody = await sendRes.text();
      console.error("Resend send failed:", errBody);
      return redirectToResult("error", "Send Failed", `Failed to send email (${sendRes.status}). Please try again or contact support.`);
    }

    const sendResult = await sendRes.json();

    // Mark as approved
    await sb.from("pending_email_approvals").update({
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: "button",
    }).eq("id", approval.id);

    // Log usage
    const recipientCount = approval.to_addresses.length;
    await sb.from("api_usage_log").insert({
      vendor: "resend",
      category: `email_${approval.email_type}`,
      endpoint: "POST /emails",
      units: recipientCount,
      unit_type: "emails",
      estimated_cost_usd: recipientCount * 0.00028,
      metadata: {
        resend_id: sendResult.id,
        email_type: approval.email_type,
        recipient_count: recipientCount,
        approved_via: action,
        approval_id: approval.id,
      },
    });

    // ─── POST-APPROVAL HOOK: Weekly Payroll → trigger payout ───
    if (approval.email_type === "weekly_payroll_summary") {
      try {
        await processPayrollApproval(approval.html, supabaseUrl, supabaseKey);
      } catch (hookErr) {
        console.error("Payroll post-approval hook failed (non-blocking):", hookErr);
        // Don't block the approval redirect — email was sent, payout can be retried manually
      }
    }

    let autoType = "";

    // If approve_all, disable approval for this type going forward
    if (action === "approve_all") {
      await sb.from("email_type_approval_config").update({
        requires_approval: false,
        auto_approved_at: new Date().toISOString(),
        auto_approved_by: "admin_button",
        updated_at: new Date().toISOString(),
      }).eq("email_type", approval.email_type);

      autoType = approval.email_type.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    }

    const recipientDisplay = approval.to_addresses.join(", ");
    return redirectToResult("success",
      "Email Approved & Sent",
      `The email "<strong>${approval.subject}</strong>" has been sent to <strong>${recipientDisplay}</strong>.`,
      autoType,
    );
  } catch (err) {
    console.error("Approve-email error:", err);
    return redirectToResult("error", "Error", `An unexpected error occurred: ${(err as Error).message}`);
  }
});

/**
 * Post-approval hook for weekly_payroll_summary emails.
 * Parses PAYROLL_META from the approved email HTML and triggers:
 *   - Stripe payout (if associate has Connect account)
 *   - Stripe Connect onboarding link (if no Connect account)
 * The stripe-payout function already sends the associate_payout_sent notification.
 */
async function processPayrollApproval(html: string, supabaseUrl: string, supabaseKey: string): Promise<void> {
  // Extract PAYROLL_META from HTML
  const metaMatch = html.match(/<!--\[PAYROLL_META:(.*?):PAYROLL_META\]-->/);
  if (!metaMatch) {
    console.warn("No PAYROLL_META found in approved payroll email — skipping payout");
    return;
  }

  const meta = JSON.parse(metaMatch[1]);
  const { associate_id, amount, time_entry_ids, has_stripe, associate_email, associate_first_name, period } = meta;

  console.log(`Processing payroll approval: ${meta.associate_name}, $${amount}, ${time_entry_ids.length} entries, stripe=${has_stripe}`);

  if (has_stripe) {
    // Trigger Stripe payout — this also sends associate_payout_sent email
    const payoutRes = await fetch(`${supabaseUrl}/functions/v1/stripe-payout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        associate_id,
        amount,
        time_entry_ids,
        notes: `Weekly payroll: ${period}`,
      }),
    });

    const payoutResult = await payoutRes.json();
    if (!payoutResult.success) {
      console.error("Stripe payout failed:", payoutResult.error);
      // Send admin an error notification
      await fetch(`${supabaseUrl}/functions/v1/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseKey}` },
        body: JSON.stringify({
          type: "custom",
          to: "admin@YOUR_DOMAIN",
          subject: `Payroll Payout FAILED — ${meta.associate_name}`,
          data: {
            _raw_html: `<h2 style="color:#c62828;">Payout Failed</h2>
              <p>The payroll approval for <strong>${meta.associate_name}</strong> ($${amount.toFixed(2)}) was approved, but the Stripe payout failed:</p>
              <p style="background:#ffebee;padding:12px;border-radius:8px;font-family:monospace;">${payoutResult.error}</p>
              <p>You can retry the payout manually from the <a href="https://YOUR_DOMAIN/spaces/admin/worktracking.html">Work Tracking</a> page.</p>`,
          },
        }),
      });
    } else {
      console.log(`Payout sent: ${payoutResult.transfer_id || payoutResult.payout_id}`);
    }
  } else {
    // No Stripe Connect — send setup link to associate
    try {
      // Generate Stripe Connect onboarding link
      const onboardRes = await fetch(`${supabaseUrl}/functions/v1/stripe-connect-onboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseKey}` },
        body: JSON.stringify({ action: "create_account", associate_id }),
      });
      const onboardResult = await onboardRes.json();

      let setupUrl = "https://YOUR_DOMAIN/associates/worktracking.html";
      if (onboardResult.success && onboardResult.account_id) {
        // Get the account link
        const linkRes = await fetch(`${supabaseUrl}/functions/v1/stripe-connect-onboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseKey}` },
          body: JSON.stringify({ action: "create_account_link", associate_id }),
        });
        const linkResult = await linkRes.json();
        if (linkResult.success && linkResult.url) setupUrl = linkResult.url;
      }

      // Send setup email to associate
      await fetch(`${supabaseUrl}/functions/v1/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseKey}` },
        body: JSON.stringify({
          type: "custom",
          to: associate_email,
          subject: `Set Up Direct Deposit — $${amount.toFixed(2)} Ready to Send`,
          data: {
            _raw_html: `<h2 style="margin:0 0 4px;">Payment Ready — Set Up Direct Deposit</h2>
              <p style="margin:0 0 20px;color:#7d6f74;">Hi ${associate_first_name},</p>
              <p>You have <strong>$${amount.toFixed(2)}</strong> in approved wages for <strong>${period}</strong>.</p>
              <p>To receive this payment (and all future payments) via direct deposit, please set up your Stripe account — it takes about 5 minutes:</p>
              <div style="text-align:center;margin:24px 0;">
                <a href="${setupUrl}" style="display:inline-block;padding:14px 32px;background:#635bff;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">Set Up Direct Deposit</a>
              </div>
              <p style="color:#7d6f74;font-size:13px;">Once your account is set up, your payment will be sent automatically. Questions? Just reply to this email.</p>`,
          },
        }),
      });
      console.log(`Stripe setup email sent to ${associate_email}`);
    } catch (setupErr) {
      console.error("Stripe Connect setup email failed:", setupErr);
    }
  }
}

function redirectToResult(status: string, title: string, message: string, autoType?: string, typeApproval?: { token: string; email_type: string }): Response {
  const url = new URL(RESULT_PAGE);
  url.searchParams.set("status", status);
  url.searchParams.set("title", title);
  url.searchParams.set("message", message);
  if (autoType) url.searchParams.set("auto_type", autoType);
  if (typeApproval) {
    url.searchParams.set("offer_type_approval", "1");
    url.searchParams.set("approval_token", typeApproval.token);
    url.searchParams.set("email_type_label", typeApproval.email_type.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()));
  }
  return Response.redirect(url.toString(), 302);
}
