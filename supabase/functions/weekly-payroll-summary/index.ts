/**
 * Weekly Payroll Summary Edge Function
 *
 * Triggered by pg_cron every Monday at 9:15 AM Central (14:15 UTC).
 * For each active associate with unpaid time entries:
 *   1. Builds a rich HTML work summary with daily breakdown
 *   2. Embeds PAYROLL_META for post-approval payout processing
 *   3. Sends via send-email with type weekly_payroll_summary (approval-gated)
 *
 * Admin receives one approval email per associate. On approval, approve-email
 * triggers the Stripe payout and associate notification automatically.
 *
 * Deploy: supabase functions deploy weekly-payroll-summary --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

serve(async (_req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, supabaseKey);

  const results: { associate: string; status: string; amount?: number }[] = [];

  try {
    // ─── 1. Load all active associates ───
    const { data: associates, error: assocErr } = await sb
      .from("associate_profiles")
      .select(`
        id, hourly_rate, stripe_connect_account_id, daily_extra,
        app_user:app_user_id(id, email, first_name, last_name, display_name, person_id)
      `)
      .eq("is_active", true);

    if (assocErr) throw new Error(`Failed to load associates: ${assocErr.message}`);
    if (!associates || associates.length === 0) {
      return jsonResponse({ success: true, message: "No active associates found", results });
    }

    // ─── 2. Process each associate ───
    for (const assoc of associates) {
      const user = assoc.app_user as any;
      if (!user) continue;

      const name = user.display_name || `${user.first_name || ""} ${user.last_name || ""}`.trim() || "Unknown";
      const firstName = user.first_name || name.split(" ")[0] || "there";
      const email = user.email;

      // ─── 2a. Get unpaid time entries ───
      const { data: entries, error: entryErr } = await sb
        .from("time_entries")
        .select("id, clock_in, clock_out, duration_minutes, description, hourly_rate, space_id, is_manual")
        .eq("associate_id", assoc.id)
        .eq("is_paid", false)
        .order("clock_in", { ascending: true });

      if (entryErr) {
        console.error(`Error loading entries for ${name}:`, entryErr);
        results.push({ associate: name, status: "error", amount: 0 });
        continue;
      }

      if (!entries || entries.length === 0) {
        results.push({ associate: name, status: "no_unpaid_hours" });
        continue;
      }

      // Skip if total minutes or amount would be $0
      const quickTotalMinutes = entries.reduce((sum, e) => sum + parseFloat(e.duration_minutes || "0"), 0);
      const quickRate = parseFloat(assoc.hourly_rate || "0");
      const quickAmount = (quickTotalMinutes / 60) * quickRate;
      if (quickTotalMinutes <= 0 || quickAmount <= 0) {
        results.push({ associate: name, status: "no_payable_hours" });
        continue;
      }

      // ─── 2b. Idempotency: check for existing pending approval this week ───
      const mondayStart = getMondayOfWeek(new Date());
      const { data: existing } = await sb
        .from("pending_email_approvals")
        .select("id")
        .eq("email_type", "weekly_payroll_summary")
        .eq("status", "pending")
        .gte("created_at", mondayStart.toISOString())
        .contains("to_addresses", [email])
        .limit(1);

      if (existing && existing.length > 0) {
        results.push({ associate: name, status: "already_pending" });
        continue;
      }

      // ─── 2c. Load space names for entries ───
      const spaceIds = [...new Set(entries.filter(e => e.space_id).map(e => e.space_id))];
      const spaceMap: Record<string, string> = {};
      if (spaceIds.length > 0) {
        const { data: spaces } = await sb
          .from("spaces")
          .select("id, name")
          .in("id", spaceIds);
        if (spaces) {
          for (const s of spaces) spaceMap[s.id] = s.name;
        }
      }

      // ─── 2d. Calculate totals and build daily breakdown ───
      const rate = parseFloat(assoc.hourly_rate || "0");
      const entryIds = entries.map(e => e.id);
      let totalMinutes = 0;

      // Group entries by date (Chicago timezone)
      const dailyMap = new Map<string, { minutes: number; descriptions: string[] }>();

      for (const e of entries) {
        const mins = parseFloat(e.duration_minutes || "0");
        totalMinutes += mins;

        const dateStr = new Date(e.clock_in).toLocaleDateString("en-US", {
          timeZone: "America/Chicago",
          month: "short",
          day: "numeric",
        });

        const existing = dailyMap.get(dateStr) || { minutes: 0, descriptions: [] };
        existing.minutes += mins;
        const desc = e.description || spaceMap[e.space_id] || "Work";
        existing.descriptions.push(desc);
        dailyMap.set(dateStr, existing);
      }

      const totalHours = totalMinutes / 60;
      const amount = Math.round(totalHours * rate * 100) / 100;

      // Determine period range
      const firstDate = new Date(entries[0].clock_in).toLocaleDateString("en-US", {
        timeZone: "America/Chicago", month: "short", day: "numeric",
      });
      const lastDate = new Date(entries[entries.length - 1].clock_in).toLocaleDateString("en-US", {
        timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric",
      });
      const period = `${firstDate} – ${lastDate}`;

      const hasStripe = !!assoc.stripe_connect_account_id;
      const stripeStatus = hasStripe ? "Ready" : "Not Set Up";
      const stripeIcon = hasStripe ? "\u2705" : "\u26a0\ufe0f";

      // ─── 2e. Build HTML daily breakdown table ───
      const dailyRows = [...dailyMap.entries()].map(([date, info]) => {
        const hrs = Math.floor(info.minutes / 60);
        const mins = Math.round(info.minutes % 60);
        const hourStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        // Truncate descriptions to avoid mega-long emails
        const descList = info.descriptions.slice(0, 5).join("; ");
        const descTrunc = descList.length > 120 ? descList.slice(0, 117) + "..." : descList;
        return `<tr style="background:${dailyMap.size % 2 === 0 ? '#faf9f6' : '#f2f0e8'};">
          <td style="padding:8px 12px;border-bottom:1px solid #e6e2d9;white-space:nowrap;">${date}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e6e2d9;text-align:right;font-weight:600;white-space:nowrap;">${hourStr}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e6e2d9;color:#7d6f74;font-size:13px;">${descTrunc}</td>
        </tr>`;
      });

      const totalHrs = Math.floor(totalMinutes / 60);
      const totalMins = Math.round(totalMinutes % 60);
      const totalStr = totalHrs > 0 ? `${totalHrs}h ${totalMins}m` : `${totalMins}m`;

      const summaryHtml = `
<h2 style="margin:0 0 4px;color:#1c1618;">Weekly Work Summary</h2>
<p style="margin:0 0 20px;color:#7d6f74;font-size:14px;">Payroll review for <strong>${name}</strong></p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f2f0e8;border:1px solid #e6e2d9;border-radius:8px;margin:0 0 20px;">
  <tr><td style="padding:20px 24px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td style="padding:0 0 8px;"><strong>Associate:</strong></td>
        <td style="padding:0 0 8px;text-align:right;font-weight:600;">${name}</td>
      </tr>
      <tr>
        <td style="padding:0 0 8px;"><strong>Period:</strong></td>
        <td style="padding:0 0 8px;text-align:right;">${period}</td>
      </tr>
      <tr>
        <td style="padding:0 0 8px;"><strong>Rate:</strong></td>
        <td style="padding:0 0 8px;text-align:right;">$${rate.toFixed(2)}/hr</td>
      </tr>
      <tr>
        <td style="padding:0 0 8px;"><strong>Total Hours:</strong></td>
        <td style="padding:0 0 8px;text-align:right;">${totalStr} (${totalHours.toFixed(2)} hrs)</td>
      </tr>
      <tr>
        <td style="padding:0;border-top:1px solid #e6e2d9;padding-top:8px;"><strong>Amount Due:</strong></td>
        <td style="padding:0;border-top:1px solid #e6e2d9;padding-top:8px;text-align:right;font-weight:600;color:#d4883a;font-size:18px;">$${amount.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0 0;"><strong>Stripe:</strong></td>
        <td style="padding:8px 0 0;text-align:right;">${stripeIcon} ${stripeStatus}</td>
      </tr>
    </table>
  </td></tr>
</table>

<p style="margin:0 0 12px;font-weight:700;color:#1c1618;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Daily Breakdown</p>
<table style="border-collapse:collapse;width:100%;margin:0 0 20px;font-size:14px;border:1px solid #e6e2d9;border-radius:8px;overflow:hidden;">
  <thead>
    <tr style="background:#1c1618;">
      <th style="padding:10px 12px;text-align:left;color:#faf9f6;font-weight:600;font-size:12px;letter-spacing:0.3px;">Date</th>
      <th style="padding:10px 12px;text-align:right;color:#faf9f6;font-weight:600;font-size:12px;">Hours</th>
      <th style="padding:10px 12px;text-align:left;color:#faf9f6;font-weight:600;font-size:12px;">Work</th>
    </tr>
  </thead>
  <tbody>
    ${dailyRows.join("\n")}
    <tr style="background:#1c1618;">
      <td style="padding:10px 12px;color:#faf9f6;font-weight:700;">Total</td>
      <td style="padding:10px 12px;text-align:right;color:#d4883a;font-weight:700;">${totalStr}</td>
      <td style="padding:10px 12px;color:#d4883a;font-weight:700;">$${amount.toFixed(2)}</td>
    </tr>
  </tbody>
</table>

<p style="margin:0 0 8px;color:#7d6f74;font-size:13px;">${entries.length} time entries &bull; ${totalHours.toFixed(2)} hrs &times; $${rate.toFixed(2)}/hr = <strong>$${amount.toFixed(2)}</strong></p>
${!hasStripe ? `<div style="background:#fff8e1;border-left:4px solid #f9a825;padding:14px 20px;margin:16px 0;border-radius:0 8px 8px 0;">
  <p style="margin:0;font-weight:600;color:#e65100;">\u26a0\ufe0f Stripe Not Set Up</p>
  <p style="margin:4px 0 0;color:#2a1f23;font-size:14px;">${firstName} needs to complete Stripe Connect onboarding before payment can be sent. A setup link will be generated on approval.</p>
</div>` : ""}`;

      // ─── 2f. Embed payroll metadata for post-approval processing ───
      const payrollMeta = JSON.stringify({
        associate_id: assoc.id,
        amount,
        hourly_rate: rate,
        total_hours: totalHours,
        total_minutes: totalMinutes,
        time_entry_ids: entryIds,
        period,
        associate_name: name,
        associate_email: email,
        associate_first_name: firstName,
        has_stripe: hasStripe,
        person_id: user.person_id,
      });

      const metaComment = `<!--[PAYROLL_META:${payrollMeta}:PAYROLL_META]-->`;
      const fullHtml = summaryHtml + metaComment;

      // ─── 2g. Send via send-email (approval-gated) ───
      const sendRes = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({
          type: "weekly_payroll_summary",
          to: "admin@YOUR_DOMAIN", // admin receives it
          subject: `Weekly Payroll — ${name} — $${amount.toFixed(2)} (${period})`,
          data: {
            _raw_html: fullHtml,
            first_name: firstName,
            associate_name: name,
            amount: amount.toFixed(2),
            period,
            total_hours: totalStr,
            hourly_rate: rate.toFixed(2),
            entry_count: entries.length,
            has_stripe: hasStripe,
          },
        }),
      });

      const sendResultText = await sendRes.text();
      let sendResult: Record<string, unknown>;
      try {
        sendResult = JSON.parse(sendResultText);
      } catch {
        console.error(`send-email returned non-JSON for ${name}:`, sendResultText.slice(0, 500));
        results.push({ associate: name, status: "error_non_json", amount });
        continue;
      }

      if (!sendRes.ok || sendResult.error) {
        console.error(`send-email error for ${name} (${sendRes.status}):`, sendResult.error || sendResultText.slice(0, 300));
        results.push({ associate: name, status: `error_${sendRes.status}`, amount });
        continue;
      }

      console.log(`Payroll summary for ${name}: $${amount.toFixed(2)}`, JSON.stringify(sendResult));

      results.push({
        associate: name,
        status: sendResult.status === "pending_approval" ? "approval_sent" : String(sendResult.status || "sent"),
        amount,
      });
    }

    return jsonResponse({ success: true, results });
  } catch (err) {
    console.error("Weekly payroll summary error:", err);
    return jsonResponse({ success: false, error: (err as Error).message, results }, 500);
  }
});

function getMondayOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
