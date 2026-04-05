/**
 * Confirm Deposit Payment Edge Function
 *
 * Handles admin clicking the "Confirm" link from a Zelle payment notification email.
 * Looks up the pending confirmation by token, records the deposit payment,
 * and returns an HTML success/error page.
 *
 * Deploy with: supabase functions deploy confirm-deposit-payment --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const RESEND_API_URL = "https://api.resend.com";

function htmlPage(title: string, body: string): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - YOUR_PROPERTY_NAME</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; background: #faf9f6; color: #333; }
    .card { background: white; border-radius: 8px; padding: 30px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .success { border-left: 4px solid #2d7d46; }
    .error { border-left: 4px solid #e74c3c; }
    h2 { margin-top: 0; }
    .btn { display: inline-block; padding: 10px 20px; background: #c8a96e; color: white; text-decoration: none; border-radius: 4px; margin-top: 15px; }
    table { border-collapse: collapse; width: 100%; margin: 15px 0; }
    td { padding: 8px; border-bottom: 1px solid #eee; }
    td:first-child { font-weight: bold; width: 40%; }
  </style>
</head>
<body>
  <div class="card ${title === 'Payment Confirmed' ? 'success' : 'error'}">
    ${body}
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return htmlPage("Error", "<h2>Missing Token</h2><p>No confirmation token provided.</p>");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendApiKey = Deno.env.get("RESEND_API_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Look up confirmation
    const { data: conf, error } = await supabase
      .from("deposit_payment_confirmations")
      .select("*, application:rental_application_id(*, person:person_id(id, first_name, last_name, email))")
      .eq("token", token)
      .single();

    if (error || !conf) {
      return htmlPage("Not Found", "<h2>Confirmation Not Found</h2><p>This link may have already been used or is invalid.</p>");
    }

    if (conf.status !== "pending") {
      return htmlPage("Already Processed", `<h2>Already ${conf.status.charAt(0).toUpperCase() + conf.status.slice(1)}</h2><p>This payment confirmation was already processed.</p>`);
    }

    if (new Date(conf.expires_at) < new Date()) {
      await supabase
        .from("deposit_payment_confirmations")
        .update({ status: "expired" })
        .eq("id", conf.id);
      return htmlPage("Expired", "<h2>Link Expired</h2><p>This confirmation link has expired. Please record the payment manually in the admin panel.</p>");
    }

    const application = conf.application;
    if (!application || !application.person) {
      return htmlPage("Error", "<h2>Application Not Found</h2><p>The linked rental application could not be found.</p>");
    }

    // Deduplicate: check if this confirmation number was already recorded
    if (conf.confirmation_number) {
      const { data: existing } = await supabase
        .from("rental_payments")
        .select("id")
        .eq("transaction_id", conf.confirmation_number)
        .limit(1);

      if (existing && existing.length > 0) {
        await supabase
          .from("deposit_payment_confirmations")
          .update({ status: "confirmed", resolved_at: new Date().toISOString(), resolved_by: "admin_email_link_duplicate" })
          .eq("id", conf.id);
        return htmlPage("Already Recorded", "<h2>Already Recorded</h2><p>This payment was already recorded (possibly auto-matched after the confirmation email was sent).</p>");
      }
    }

    // Record deposit payments
    const now = new Date().toISOString();
    const today = now.split("T")[0];
    let remaining = Number(conf.amount);
    const personName = `${application.person.first_name} ${application.person.last_name}`;
    const depositsRecorded: string[] = [];

    // Move-in deposit first
    const moveInUnpaid = !application.move_in_deposit_paid && (application.move_in_deposit_amount || 0) > 0;
    if (moveInUnpaid && remaining > 0) {
      const moveInAmt = Number(application.move_in_deposit_amount);
      const applyAmt = Math.min(remaining, moveInAmt);

      const { data: rpData } = await supabase
        .from("rental_payments")
        .insert({
          rental_application_id: application.id,
          payment_type: "move_in_deposit",
          amount_due: moveInAmt,
          amount_paid: applyAmt,
          paid_date: today,
          payment_method: "zelle",
          transaction_id: conf.confirmation_number,
        })
        .select()
        .single();

      await supabase
        .from("rental_applications")
        .update({
          move_in_deposit_paid: true,
          move_in_deposit_paid_at: now,
          move_in_deposit_method: "zelle",
          updated_at: now,
        })
        .eq("id", application.id);

      await supabase.from("ledger").insert({
        direction: "income",
        category: "move_in_deposit",
        amount: applyAmt,
        payment_method: "zelle",
        transaction_date: today,
        person_id: application.person_id,
        person_name: personName,
        rental_application_id: application.id,
        rental_payment_id: rpData?.id,
        status: "completed",
        description: `Move-in deposit via Zelle (confirmed by admin, conf#${conf.confirmation_number || "N/A"})`,
        recorded_by: "system:zelle-confirm",
      });

      remaining -= applyAmt;
      depositsRecorded.push(`Move-in deposit: $${applyAmt.toFixed(2)}`);
    }

    // Security deposit
    const securityUnpaid = !application.security_deposit_paid && (application.security_deposit_amount || 0) > 0;
    if (securityUnpaid && remaining > 0) {
      const secAmt = Number(application.security_deposit_amount);
      const applyAmt = Math.min(remaining, secAmt);

      const { data: rpData } = await supabase
        .from("rental_payments")
        .insert({
          rental_application_id: application.id,
          payment_type: "security_deposit",
          amount_due: secAmt,
          amount_paid: applyAmt,
          paid_date: today,
          payment_method: "zelle",
          transaction_id: conf.confirmation_number,
        })
        .select()
        .single();

      await supabase
        .from("rental_applications")
        .update({
          security_deposit_paid: true,
          security_deposit_paid_at: now,
          security_deposit_method: "zelle",
          updated_at: now,
        })
        .eq("id", application.id);

      await supabase.from("ledger").insert({
        direction: "income",
        category: "security_deposit",
        amount: applyAmt,
        payment_method: "zelle",
        transaction_date: today,
        person_id: application.person_id,
        person_name: personName,
        rental_application_id: application.id,
        rental_payment_id: rpData?.id,
        status: "completed",
        description: `Security deposit via Zelle (confirmed by admin, conf#${conf.confirmation_number || "N/A"})`,
        recorded_by: "system:zelle-confirm",
      });

      remaining -= applyAmt;
      depositsRecorded.push(`Security deposit: $${applyAmt.toFixed(2)}`);
    }

    // Update overall deposit status
    const { data: updatedApp } = await supabase
      .from("rental_applications")
      .select("move_in_deposit_paid, security_deposit_paid, security_deposit_amount")
      .eq("id", application.id)
      .single();

    if (updatedApp) {
      const allPaid =
        updatedApp.move_in_deposit_paid &&
        (updatedApp.security_deposit_paid || (updatedApp.security_deposit_amount || 0) === 0);
      const anyPaid = updatedApp.move_in_deposit_paid || updatedApp.security_deposit_paid;
      const newStatus = allPaid ? "received" : anyPaid ? "partial" : "requested";
      await supabase
        .from("rental_applications")
        .update({ deposit_status: newStatus, updated_at: now })
        .eq("id", application.id);
    }

    // Save name mapping for future payments
    const normalized = conf.sender_name.toLowerCase().trim().replace(/\s+/g, " ").replace(/[^a-z0-9\s]/g, "");
    await supabase.from("payment_sender_mappings").upsert(
      {
        sender_name: conf.sender_name,
        sender_name_normalized: normalized,
        person_id: application.person_id,
        confidence_score: 1.0,
        match_source: "zelle_admin_confirmed",
        updated_at: now,
      },
      { onConflict: "sender_name_normalized" }
    );

    // Mark confirmation as resolved
    await supabase
      .from("deposit_payment_confirmations")
      .update({ status: "confirmed", resolved_at: now, resolved_by: "admin_email_link" })
      .eq("id", conf.id);

    // Send notification to admin
    const adminUrl = `https://YOUR_DOMAIN/spaces/admin/rentals.html#applicant=${application.id}`;
    const overpayStr = remaining > 0 ? `<p style="color:#e74c3c;"><strong>Overpayment:</strong> $${remaining.toFixed(2)} exceeds deposits owed.</p>` : "";

    try {
      await fetch(`${RESEND_API_URL}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Property Payments <noreply@YOUR_DOMAIN>",
          to: ["team@YOUR_DOMAIN"],
          subject: `Payment Confirmed: $${conf.amount} from ${conf.sender_name} → ${personName}`,
          html: `
            <div style="font-family:-apple-system,sans-serif;">
              <h2 style="color:#2d7d46;">Payment Confirmed by Admin</h2>
              <p>$${Number(conf.amount).toFixed(2)} from ${conf.sender_name} has been recorded for ${personName}.</p>
              <ul>${depositsRecorded.map((d: string) => `<li>${d}</li>`).join("")}</ul>
              ${overpayStr}
              <p><a href="${adminUrl}">View Application</a></p>
            </div>
          `,
        }),
      });
    } catch (emailErr) {
      console.error("Failed to send confirmation notification:", emailErr);
    }

    // Return success page
    return htmlPage(
      "Payment Confirmed",
      `
      <h2>&#x2705; Payment Confirmed!</h2>
      <table>
        <tr><td>Amount</td><td>$${Number(conf.amount).toFixed(2)}</td></tr>
        <tr><td>From</td><td>${conf.sender_name}</td></tr>
        <tr><td>Recorded For</td><td>${personName}</td></tr>
        ${conf.confirmation_number ? `<tr><td>Confirmation #</td><td>${conf.confirmation_number}</td></tr>` : ""}
      </table>
      <ul>${depositsRecorded.map((d: string) => `<li>&#x2705; ${d}</li>`).join("")}</ul>
      ${remaining > 0 ? `<p style="color:#e74c3c;"><strong>Note:</strong> $${remaining.toFixed(2)} overpayment detected.</p>` : ""}
      <a href="${adminUrl}" class="btn">View Application</a>
    `
    );
  } catch (err) {
    console.error("Confirm deposit payment error:", err);
    return htmlPage("Error", `<h2>Something went wrong</h2><p>${err instanceof Error ? err.message : "Unknown error"}</p>`);
  }
});
