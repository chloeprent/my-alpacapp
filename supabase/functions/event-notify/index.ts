/**
 * Event Notify Edge Function
 *
 * Receives database trigger payloads, matches them against
 * notification_subscriptions, and sends emails via send-email.
 *
 * Payload shape (from the notify_event_subscribers() trigger):
 *   { event, table, operation, record, old_record, fired_at }
 *
 * Deploy: supabase functions deploy event-notify --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// Austin timezone for date formatting
const AUSTIN_TZ = "America/Chicago";

function formatDateAustin(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: AUSTIN_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTimeAustin(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: AUSTIN_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Check if a record matches a subscription's JSONB filters.
 * Each key in filters must match the corresponding value in the record.
 */
function matchesFilters(
  record: Record<string, any>,
  filters: Record<string, any>
): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (String(record[key]) !== String(value)) return false;
  }
  return true;
}

/**
 * Check if any watched columns actually changed (for UPDATE events).
 */
function watchedColumnsChanged(
  record: Record<string, any>,
  oldRecord: Record<string, any> | null,
  watchColumns: string[] | null
): boolean {
  // No watch_columns = fire on any change
  if (!watchColumns || watchColumns.length === 0) return true;
  if (!oldRecord) return true; // INSERT always fires

  for (const col of watchColumns) {
    const newVal = JSON.stringify(record[col] ?? null);
    const oldVal = JSON.stringify(oldRecord[col] ?? null);
    if (newVal !== oldVal) return true;
  }
  return false;
}

/**
 * Build a human-readable email for a time_entries event.
 */
function buildTimeEntryEmail(
  operation: string,
  record: Record<string, any>,
  oldRecord: Record<string, any> | null,
  associateName: string
): { subject: string; html: string } {
  const clockIn = record.clock_in
    ? formatTimeAustin(record.clock_in)
    : "—";
  const date = record.clock_in
    ? formatDateAustin(record.clock_in)
    : "Unknown date";

  // Determine what happened
  let action: string;
  if (operation === "insert") {
    action = "clocked in";
  } else if (
    oldRecord &&
    !oldRecord.clock_out &&
    record.clock_out
  ) {
    action = "clocked out";
  } else if (
    oldRecord &&
    oldRecord.status !== record.status
  ) {
    action = `status changed to ${record.status}`;
  } else {
    action = "entry updated";
  }

  const clockOut = record.clock_out
    ? formatTimeAustin(record.clock_out)
    : null;
  const duration = record.duration_minutes
    ? formatDuration(parseFloat(record.duration_minutes))
    : null;

  const subject = `${associateName} ${action} — ${date}`;

  const rows: string[] = [];
  rows.push(row("Date", date));
  rows.push(row("Clock In", clockIn));
  if (clockOut) rows.push(row("Clock Out", clockOut));
  if (duration) rows.push(row("Duration", duration));
  if (record.status) rows.push(row("Status", record.status));
  if (record.description)
    rows.push(row("Notes", record.description));

  const html = `
    <h2 style="margin:0 0 4px;">Work Hours Update</h2>
    <p style="margin:0 0 20px;color:#7d6f74;font-size:14px;">
      <strong>${associateName}</strong> ${action}.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
           style="background:#f2f0e8;border:1px solid #e6e2d9;border-radius:8px;margin:0 0 20px;">
      <tr>
        <td style="padding:20px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${rows.join("\n")}
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:16px 0 0;color:#7d6f74;font-size:13px;">
      This is an automated notification from Alpaca Playhouse event subscriptions.
    </p>
  `;

  return { subject, html };
}

function row(label: string, value: string): string {
  return `
    <tr>
      <td style="padding:0 0 8px;"><strong>${label}:</strong></td>
      <td style="padding:0 0 8px;text-align:right;">${value}</td>
    </tr>`;
}

/**
 * Build a generic email for any table event.
 */
function buildGenericEmail(
  event: string,
  record: Record<string, any>
): { subject: string; html: string } {
  const subject = `Event: ${event}`;
  const fields = Object.entries(record)
    .filter(([_, v]) => v != null)
    .slice(0, 15) // Limit fields shown
    .map(([k, v]) => row(k, String(v)))
    .join("\n");

  const html = `
    <h2 style="margin:0 0 4px;">Event Notification</h2>
    <p style="margin:0 0 20px;color:#7d6f74;font-size:14px;">Event: <strong>${event}</strong></p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
           style="background:#f2f0e8;border:1px solid #e6e2d9;border-radius:8px;margin:0 0 20px;">
      <tr>
        <td style="padding:20px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${fields}
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:16px 0 0;color:#7d6f74;font-size:13px;">
      This is an automated notification from Alpaca Playhouse event subscriptions.
    </p>
  `;

  return { subject, html };
}

// ─── Main handler ──────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, supabaseKey);

  try {
    const payload = await req.json();
    const {
      event,
      table,
      operation,
      record,
      old_record: oldRecord,
    } = payload as {
      event: string;
      table: string;
      operation: string;
      record: Record<string, any>;
      old_record: Record<string, any> | null;
      fired_at: string;
    };

    console.log(`[event-notify] Received: ${event}`);

    // ─── 1. Find matching active subscriptions ───
    const { data: subs, error: subErr } = await sb
      .from("notification_subscriptions")
      .select("*")
      .eq("event", event)
      .eq("is_active", true);

    if (subErr) {
      console.error("[event-notify] Subscription lookup error:", subErr);
      return json({ success: false, error: subErr.message }, 500);
    }

    if (!subs || subs.length === 0) {
      console.log(`[event-notify] No subscriptions for ${event}`);
      return json({ success: true, matched: 0 });
    }

    // ─── 2. Filter by JSONB match and watch_columns ───
    const matched = subs.filter((s) => {
      if (!matchesFilters(record, s.filters || {})) return false;
      if (operation === "update" && !watchedColumnsChanged(record, oldRecord, s.watch_columns)) return false;
      return true;
    });

    if (matched.length === 0) {
      console.log(`[event-notify] No subscriptions matched filters for ${event}`);
      return json({ success: true, matched: 0 });
    }

    console.log(`[event-notify] ${matched.length} subscription(s) matched`);

    // ─── 3. Resolve associate name for time_entries ───
    let associateName = "Unknown";
    if (table === "time_entries" && record.associate_id) {
      const { data: assocData } = await sb
        .from("associate_profiles")
        .select(`app_user:app_user_id(first_name, last_name, display_name)`)
        .eq("id", record.associate_id)
        .single();

      if (assocData?.app_user) {
        const u = assocData.app_user as any;
        associateName =
          u.display_name ||
          `${u.first_name || ""} ${u.last_name || ""}`.trim() ||
          "Unknown";
      }
    }

    // ─── 4. Build email content ───
    let emailContent: { subject: string; html: string };
    if (table === "time_entries") {
      emailContent = buildTimeEntryEmail(operation, record, oldRecord, associateName);
    } else {
      emailContent = buildGenericEmail(event, record);
    }

    // ─── 5. Collect all unique recipient emails ───
    const allEmails = new Set<string>();
    for (const sub of matched) {
      for (const email of sub.notify_emails) {
        allEmails.add(email);
      }
    }

    // ─── 6. Send email via send-email edge function ───
    const sendRes = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        type: "event_notification",
        to: [...allEmails],
        subject: emailContent.subject,
        data: {
          _raw_html: emailContent.html,
          event,
          table,
          operation,
        },
      }),
    });

    const sendResult = await sendRes.json();
    console.log(`[event-notify] Email sent:`, sendResult);

    return json({
      success: true,
      matched: matched.length,
      recipients: [...allEmails],
      email_result: sendResult,
    });
  } catch (err) {
    console.error("[event-notify] Error:", err);
    return json({ success: false, error: String(err) }, 500);
  }
});

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
