import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { decode as base64Decode } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import { uploadToR2 } from "../_shared/r2-upload.ts";
import {
  extractReceiptData,
  looksLikeReceipt,
  upsertVendor,
  createPurchase,
} from "../_shared/receipt-processor.ts";
import {
  classifyEmail,
  logClassificationCost,
  isReplyToOurEmail,
  type ClassificationResult,
  type EmailAction,
  type OutboundEmailMeta,
} from "../_shared/email-classifier.ts";

const RESEND_API_URL = "https://api.resend.com";

/**
 * Special-logic prefixes that are NOT simple forwards.
 * These are handled by handleSpecialLogic() instead of forwarding.
 */
const SPECIAL_PREFIXES: Record<string, string> = {
  "herd": "herd",
  "auto": "auto",
  "payments": "payments",
  "pai": "pai",
  "claudero": "claudero",
  "ai-admin": "ai-admin",
  "guestbook": "guestbook",
};

/**
 * Load forwarding rules from the email_forwarding_config table.
 * Returns a map of prefix → array of forward-to addresses.
 * Falls back to hardcoded defaults if the DB query fails.
 */
async function loadForwardingRules(supabase: any): Promise<Record<string, string[]>> {
  try {
    const { data, error } = await supabase
      .from("email_forwarding_config")
      .select("address_prefix, forward_to")
      .eq("is_active", true);

    if (error) throw error;

    const rules: Record<string, string[]> = {};
    for (const row of data || []) {
      const prefix = row.address_prefix.toLowerCase();
      if (!rules[prefix]) rules[prefix] = [];
      rules[prefix].push(row.forward_to);
    }
    return rules;
  } catch (err) {
    console.error("Failed to load forwarding rules from DB, using defaults:", err);
    return {
      team: ["admin@YOUR_DOMAIN"],
    };
  }
}

const DEFAULT_FORWARD_TO = "admin@YOUR_DOMAIN";

/**
 * Extract the local part (prefix) from an email address.
 * e.g. "haydn@mail.YOUR_DOMAIN" → "haydn"
 */
function extractPrefix(email: string): string {
  return email.split("@")[0].toLowerCase().trim();
}

/**
 * Verify Resend webhook signature (SVIX-based).
 * Returns true if signature is valid.
 */
async function verifyWebhookSignature(
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  secret: string
): Promise<boolean> {
  try {
    // Remove "whsec_" prefix from secret and decode base64
    const secretBytes = base64Decode(secret.replace("whsec_", ""));

    // Construct signed content: {msg_id}.{timestamp}.{body}
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(signedContent));
    const expectedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

    // svix-signature can contain multiple signatures separated by spaces: "v1,sig1 v1,sig2"
    const signatures = svixSignature.split(" ");
    for (const sig of signatures) {
      const sigValue = sig.split(",")[1]; // Remove "v1," prefix
      if (sigValue === expectedSignature) {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error("Signature verification error:", error.message);
    return false;
  }
}

/**
 * Fetch full email content (body) from Resend API.
 * The webhook payload doesn't include the body — we need to fetch it separately.
 * Retries with delay because the body may not be available immediately
 * (race condition when sending to our own domain).
 */
async function fetchEmailContent(emailId: string, apiKey: string): Promise<{ html: string; text: string } | null> {
  const MAX_ATTEMPTS = 3;
  const DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`Retry ${attempt}/${MAX_ATTEMPTS} fetching email body (waiting ${DELAY_MS}ms)...`);
        await new Promise(r => setTimeout(r, DELAY_MS));
      }

      // Use the Received Emails API endpoint (not /emails/ which is for outbound only)
      const res = await fetch(`${RESEND_API_URL}/emails/receiving/${emailId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        const errBody = await res.text();
        console.error(`Failed to fetch email content: ${res.status} ${res.statusText} - ${errBody}`);
        if (attempt === MAX_ATTEMPTS) return null;
        continue;
      }
      const data = await res.json();
      const html = data.html || "";
      const text = data.text || "";

      // If body is empty and we have retries left, try again
      if (!html && !text && attempt < MAX_ATTEMPTS) {
        console.warn(`Email body empty on attempt ${attempt}, will retry...`);
        continue;
      }

      return { html, text };
    } catch (error) {
      console.error("Error fetching email content:", error.message);
      if (attempt === MAX_ATTEMPTS) return null;
    }
  }
  return null;
}

/**
 * Forward an email via Resend send API.
 */
async function forwardEmail(
  apiKey: string,
  to: string,
  originalFrom: string,
  subject: string,
  html: string,
  text: string
): Promise<boolean> {
  try {
    const res = await fetch(`${RESEND_API_URL}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${originalFrom.replace(/<.*>/, '').trim() || originalFrom} <notifications@YOUR_DOMAIN>`,
        to: [to],
        reply_to: originalFrom,
        subject: subject,
        html: html || `<pre>${text}</pre>`,
        text: text || "(HTML-only email)",
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Forward failed: ${res.status} ${errText}`);
      return false;
    }

    console.log(`Forwarded to ${to}`);
    return true;
  } catch (error) {
    console.error("Forward error:", error.message);
    return false;
  }
}

/**
 * Handle special logic for herd@ and auto@ addresses.
 *
 * auto@ handles replies to automated system emails:
 * - Bug report replies (subject contains "Bug by") → creates a follow-up bug report
 *   so the bug fixer worker picks it up for another fix attempt
 * - Other auto@ emails → forwarded to admin for manual review
 */
async function handleSpecialLogic(
  type: string,
  emailRecord: any,
  supabase: any,
  resendApiKey: string
): Promise<void> {
  console.log(`Special logic triggered: type=${type}, from=${emailRecord.from_address}, subject=${emailRecord.subject}`);

  if (type === "auto") {
    await handleAutoReply(emailRecord, supabase, resendApiKey);
  } else if (type === "payments") {
    await handlePaymentEmail(emailRecord, supabase, resendApiKey);
  } else if (type === "pai") {
    await handlePaiEmail(emailRecord, supabase, resendApiKey);
  } else if (type === "claudero") {
    await handleClauderoEmail(emailRecord, supabase, resendApiKey);
  } else if (type === "ai-admin") {
    await handleAI AdminEmail(emailRecord, supabase, resendApiKey);
  } else if (type === "guestbook") {
    await handleGuestbookEmail(emailRecord, supabase);
  } else if (type === "herd") {
    await handleHerdEmail(emailRecord, supabase, resendApiKey);
  }
}

// =============================================
// HERD EMAIL HANDLER (universal classifier)
// =============================================

/**
 * Handle inbound emails to herd@YOUR_DOMAIN.
 * Uses the dual-model classifier to determine what to do with the email,
 * then routes accordingly.
 */
async function handleHerdEmail(
  emailRecord: any,
  supabase: any,
  resendApiKey: string
): Promise<void> {
  const subject = emailRecord.subject || "";
  const bodyText = emailRecord.body_text || "";
  const bodyHtml = emailRecord.body_html || "";
  const from = emailRecord.from_address || "";
  const hasAttachments = (emailRecord.attachments || []).length > 0;
  const senderEmail = (from.match(/<(.+)>/)?.[1] || from).trim();

  console.log(`Herd email from ${senderEmail}: subject="${subject}"`);

  // Check if this is a reply to one of our outbound emails
  const { isReply, meta: replyMeta } = isReplyToOurEmail(subject, bodyHtml);
  if (isReply && replyMeta) {
    console.log(`Herd reply detected: original type=${replyMeta.type}, eid=${replyMeta.eid}`);
    // Store reply context in the email record
    await supabase
      .from("inbound_emails")
      .update({
        reply_to_email_id: replyMeta.eid,
        reply_context: replyMeta,
      })
      .eq("id", emailRecord.id);
  }

  // Classify with dual-model consensus
  const classification = await classifyEmail(subject, bodyText || bodyHtml, hasAttachments, from);
  console.log(`Herd classification: category=${classification.category}, confidence=${classification.confidence}, consensus=${classification.consensus}, action=${classification.action}`);

  // Store classification in the inbound_emails record
  await supabase
    .from("inbound_emails")
    .update({
      classification: {
        category: classification.category,
        confidence: classification.confidence,
        summary: classification.summary,
        consensus: classification.consensus,
        primary_model: classification.primaryModel,
        secondary_category: classification.secondaryCategory,
        secondary_model: classification.secondaryModel,
      },
      classification_consensus: classification.consensus,
      classification_action: classification.action,
    })
    .eq("id", emailRecord.id);

  // Log classification costs
  await logClassificationCost(supabase, classification, emailRecord.id, senderEmail);

  // Route based on classification action
  await routeByClassification(classification, emailRecord, supabase, resendApiKey);
}

/**
 * Route an email based on its classification action.
 * This is shared between herd@ and catch-all routing.
 */
async function routeByClassification(
  classification: ClassificationResult,
  emailRecord: any,
  supabase: any,
  resendApiKey: string
): Promise<void> {
  const subject = emailRecord.subject || "";
  const bodyText = emailRecord.body_text || "";
  const bodyHtml = emailRecord.body_html || "";
  const from = emailRecord.from_address || "";
  const senderEmail = (from.match(/<(.+)>/)?.[1] || from).trim();
  const senderName = (from.match(/^([^<]+)/)?.[1] || "").trim() || from.split("@")[0];

  switch (classification.action) {
    case "drop_spam":
      console.log(`Dropping spam email: "${classification.summary}"`);
      await supabase
        .from("inbound_emails")
        .update({ route_action: "spam_blocked" })
        .eq("id", emailRecord.id);
      break;

    case "process_payment":
      // Re-route to the payments handler
      console.log("Re-routing to payment handler");
      await handlePaymentEmail(emailRecord, supabase, resendApiKey);
      break;

    case "process_receipt":
      // Re-route to PAI for receipt processing
      console.log("Re-routing to PAI for receipt processing");
      await handlePaiEmail(emailRecord, supabase, resendApiKey);
      break;

    case "process_guestbook":
      console.log("Re-routing to guestbook handler");
      await handleGuestbookEmail(emailRecord, supabase);
      break;

    case "process_document":
      // Re-route to PAI for document processing
      console.log("Re-routing to PAI for document processing");
      await handlePaiEmail(emailRecord, supabase, resendApiKey);
      break;

    case "process_command":
      // Forward to PAI for smart home command
      console.log("Re-routing to PAI for command processing");
      await handlePaiEmail(emailRecord, supabase, resendApiKey);
      break;

    case "auto_reply":
      // Forward to PAI for question answering
      console.log("Re-routing to PAI for auto-reply");
      await handlePaiEmail(emailRecord, supabase, resendApiKey);
      break;

    case "forward_person": {
      // Forward to the person it's addressed to
      // Try to find the person by the to-address prefix
      const prefix = extractPrefix(emailRecord.to_address || "");
      const forwardingRules = await loadForwardingRules(supabase);
      const targets = forwardingRules[prefix] || ["admin@YOUR_DOMAIN"];

      for (const target of targets) {
        await forwardEmail(resendApiKey, target, from, subject, bodyHtml, bodyText);
      }

      await supabase
        .from("inbound_emails")
        .update({
          route_action: "forward",
          forwarded_to: targets[0],
          forwarded_at: new Date().toISOString(),
        })
        .eq("id", emailRecord.id);
      break;
    }

    case "flag_review":
      // Disputed classification — forward to admin with classification context
      console.log(`Flagging for review: ${classification.summary}`);
      const flagSubject = `[Review Needed] ${subject}`;
      const flagHtml = `
        <div style="background:#fff8e1;border:1px solid #f9a825;border-radius:8px;padding:16px;margin-bottom:16px;">
          <p style="margin:0 0 8px;font-weight:600;color:#f57f17;">Classification Needs Review</p>
          <p style="margin:0;font-size:13px;color:#555;">${classification.summary}</p>
          <p style="margin:8px 0 0;font-size:12px;color:#888;">Confidence: ${(classification.confidence * 100).toFixed(0)}% | Consensus: ${classification.consensus ? 'Yes' : 'No'}</p>
        </div>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
        <p><strong>From:</strong> ${from}</p>
        <p><strong>Subject:</strong> ${subject}</p>
        <div>${bodyHtml || `<pre>${bodyText}</pre>`}</div>
      `;

      await forwardEmail(resendApiKey, "admin@YOUR_DOMAIN", from, flagSubject, flagHtml, bodyText);
      await supabase
        .from("inbound_emails")
        .update({
          route_action: "flagged_review",
          forwarded_to: "admin@YOUR_DOMAIN",
          forwarded_at: new Date().toISOString(),
        })
        .eq("id", emailRecord.id);
      break;

    case "forward_admin":
    default:
      // Forward to admin
      await forwardEmail(resendApiKey, "admin@YOUR_DOMAIN", from, subject, bodyHtml, bodyText);
      await supabase
        .from("inbound_emails")
        .update({
          route_action: "forward",
          forwarded_to: "admin@YOUR_DOMAIN",
          forwarded_at: new Date().toISOString(),
        })
        .eq("id", emailRecord.id);
      break;
  }
}

// =============================================
// GUESTBOOK EMAIL HANDLER
// =============================================

/**
 * Handle inbound emails to guestbook@YOUR_DOMAIN.
 * Extracts sender name and message body, inserts into guestbook_entries.
 */
async function handleGuestbookEmail(
  emailRecord: any,
  supabase: any
): Promise<void> {
  const fromName = emailRecord.from_name || emailRecord.from_address?.split("@")[0] || "Email Guest";
  const message = (emailRecord.body_text || emailRecord.subject || "").trim().slice(0, 1000);

  if (!message) {
    console.log("Guestbook email had no message body, skipping");
    return;
  }

  const { error } = await supabase
    .from("guestbook_entries")
    .insert({
      guest_name: fromName,
      message,
      entry_type: "email",
      media_type: "email",
      source: "email",
    });

  if (error) {
    console.error("Failed to insert guestbook email entry:", error);
  } else {
    console.log(`Guestbook email entry created from ${fromName}`);
  }
}

// =============================================
// CLAUDERO EMAIL HANDLER
// =============================================

/**
 * Handle inbound emails to claudero@YOUR_DOMAIN.
 * These are replies to feature build result emails.
 *
 * 1. Scan subject + body for version pattern (vYYMMDD.NN) or feature request context
 * 2. Look up the original feature_request by commit SHA or version
 * 3. Create a new feature_request with parent_request_id linking to original
 * 4. Send acknowledgment reply
 */
async function handleClauderoEmail(
  emailRecord: any,
  supabase: any,
  resendApiKey: string
): Promise<void> {
  const subject = emailRecord.subject || "";
  const bodyText = emailRecord.body_text || "";
  const bodyHtml = emailRecord.body_html || "";
  const from = emailRecord.from_address || "";

  const senderName = (from.match(/^([^<]+)/)?.[1] || "").trim() || from.split("@")[0];
  const senderEmail = (from.match(/<(.+)>/)?.[1] || from).trim();
  const messageBody = bodyText || bodyHtml || "";

  console.log(`Claudero email from ${senderEmail}: subject="${subject}"`);

  // Try to find the original feature request by scanning for version or commit SHA
  let parentRequest: any = null;

  // Look for version pattern: vYYMMDD.NN
  const versionMatch = (subject + " " + messageBody).match(/v(\d{6}\.\d{2})/);
  if (versionMatch) {
    const version = `v${versionMatch[1]}`;
    console.log(`Found version reference: ${version}`);

    // Look up release_events for this version
    const { data: releaseEvent } = await supabase
      .from("release_events")
      .select("sha")
      .eq("version_string", version)
      .limit(1)
      .maybeSingle();

    if (releaseEvent?.sha) {
      // Find feature request by commit SHA
      const { data: req } = await supabase
        .from("feature_requests")
        .select("*")
        .eq("commit_sha", releaseEvent.sha)
        .limit(1)
        .maybeSingle();

      if (req) parentRequest = req;
    }
  }

  // Fallback: look for commit SHA in subject/body (8+ hex chars)
  if (!parentRequest) {
    const shaMatch = (subject + " " + messageBody).match(/\b([0-9a-f]{8,40})\b/i);
    if (shaMatch) {
      const shaPrefix = shaMatch[1].substring(0, 8);
      const { data: reqs } = await supabase
        .from("feature_requests")
        .select("*")
        .ilike("commit_sha", `${shaPrefix}%`)
        .limit(1);

      if (reqs?.length) parentRequest = reqs[0];
    }
  }

  // Fallback: look for most recent completed request from this sender
  if (!parentRequest) {
    const { data: reqs } = await supabase
      .from("feature_requests")
      .select("*")
      .eq("requester_email", senderEmail)
      .in("status", ["completed", "review"])
      .order("completed_at", { ascending: false })
      .limit(1);

    if (reqs?.length) parentRequest = reqs[0];
  }

  // Look up the sender's app_user for proper requester info
  let requesterName = senderName;
  let requesterRole = "staff";
  let requesterUserId: string | null = null;

  const { data: appUser } = await supabase
    .from("app_users")
    .select("id, display_name, role, email")
    .eq("email", senderEmail)
    .limit(1)
    .maybeSingle();

  if (appUser) {
    requesterName = appUser.display_name || senderName;
    requesterRole = appUser.role || "staff";
    requesterUserId = appUser.id;
  }

  // Strip quoted reply content — keep only the new message
  // Common patterns: lines starting with ">" or "On ... wrote:"
  let cleanBody = messageBody;
  const onWroteIdx = cleanBody.search(/^On\s.+wrote:\s*$/m);
  if (onWroteIdx > 0) cleanBody = cleanBody.substring(0, onWroteIdx).trim();
  // Also strip lines starting with ">"
  cleanBody = cleanBody.split("\n").filter((l: string) => !l.startsWith(">")).join("\n").trim();

  if (!cleanBody || cleanBody.length < 3) {
    console.log("Claudero email body too short after stripping quotes, ignoring");
    return;
  }

  // Build context for the follow-up request
  const structuredSpec: any = {};
  if (parentRequest) {
    structuredSpec.context = {
      parent_request_id: parentRequest.id,
      parent_version: versionMatch ? `v${versionMatch[1]}` : null,
      parent_commit_sha: parentRequest.commit_sha,
      parent_description: parentRequest.description?.substring(0, 200),
      parent_build_summary: parentRequest.build_summary?.substring(0, 300),
      parent_files_created: parentRequest.files_created,
    };
  }

  // Create follow-up feature request
  const { data: newReq, error } = await supabase
    .from("feature_requests")
    .insert({
      requester_user_id: requesterUserId,
      requester_name: requesterName,
      requester_role: requesterRole,
      requester_email: senderEmail,
      description: cleanBody,
      parent_request_id: parentRequest?.id || null,
      structured_spec: Object.keys(structuredSpec).length ? structuredSpec : null,
      status: "pending",
    })
    .select()
    .single();

  if (error) {
    console.error("Failed to create follow-up feature request:", error.message);
    return;
  }

  console.log(`Created follow-up feature request: ${newReq.id}${parentRequest ? ` (parent: ${parentRequest.id})` : ""}`);

  // Send acknowledgment reply
  const ackText = parentRequest
    ? `Got it — I'll look at the context from ${versionMatch ? `version ${`v${versionMatch[1]}`}` : `your previous build`} and process your feedback. You can track progress at https://YOUR_DOMAIN/spaces/admin/appdev.html`
    : `Got it — I'll process your request. You can track progress at https://YOUR_DOMAIN/spaces/admin/appdev.html`;

  await sendClauderoReply(resendApiKey, senderEmail, ackText, subject, messageBody);
}

/**
 * Send a reply from claudero@YOUR_DOMAIN via Resend API directly.
 */
async function sendClauderoReply(
  resendApiKey: string,
  to: string,
  replyBody: string,
  originalSubject: string,
  originalBody: string
): Promise<{ ok: boolean; status: number }> {
  const bodySnippet = originalBody.substring(0, 500);
  const reSubject = originalSubject.startsWith("Re:") ? originalSubject : `Re: ${originalSubject || "Your message to Claudero"}`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1c1618; padding: 20px; border-radius: 12px 12px 0 0;">
        <h2 style="color: #d4883a; margin: 0;">Claudero</h2>
        <p style="color: #aaa; margin: 4px 0 0 0; font-size: 13px;">AI developer extraordinaire</p>
      </div>
      <div style="background: #fff; padding: 24px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 12px 12px;">
        <div style="white-space: pre-wrap; line-height: 1.6;">${(replyBody || "").replace(/</g, "&lt;")}</div>
        ${bodySnippet ? `
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0 16px;">
        <p style="color: #888; font-size: 12px; margin-bottom: 8px;">Your original message:</p>
        <div style="color: #999; font-size: 13px; border-left: 3px solid #ddd; padding-left: 12px;">${bodySnippet.replace(/</g, "&lt;")}</div>
        ` : ""}
      </div>
      <p style="color: #999; font-size: 11px; text-align: center; margin-top: 12px;">
        This is an automated reply from Claudero at YOUR_PROPERTY_NAME. Reply to continue the conversation.
      </p>
    </div>`;
  const text = `Claudero - AI developer extraordinaire

${replyBody || ""}

${bodySnippet ? `---\nYour original message:\n${bodySnippet}` : ""}

This is an automated reply from Claudero at YOUR_PROPERTY_NAME.`;

  const res = await fetch(`${RESEND_API_URL}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Claudero <claudero@YOUR_DOMAIN>",
      to: [to],
      reply_to: "claudero@YOUR_DOMAIN",
      subject: reSubject,
      html,
      text,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Failed to send Claudero reply: ${res.status} ${errText}`);
  } else {
    console.log(`Claudero reply sent to ${to}`);
  }
  return { ok: res.ok, status: res.status };
}

// =============================================
// PAI EMAIL HANDLER
// =============================================

type PaiEmailClassification = "question" | "document" | "receipt" | "command" | "spam" | "other";

/** Spam emails per rolling window that triggers an admin alert. */
const PAI_SPAM_ALERT_THRESHOLD = 10;
const PAI_SPAM_WINDOW_HOURS = 24;

interface PaiClassificationResult {
  type: PaiEmailClassification;
  confidence: number;
  summary: string;
}

/**
 * Classify an inbound email using Gemini.
 * Returns the email type (question, document, command, other) with confidence.
 */
async function classifyPaiEmail(
  subject: string,
  bodyText: string,
  hasAttachments: boolean
): Promise<PaiClassificationResult> {
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiApiKey) {
    console.warn("GEMINI_API_KEY not set, defaulting to 'other'");
    return { type: hasAttachments ? "document" : "question", confidence: 0.5, summary: "No Gemini key" };
  }

  const prompt = `You are an email classifier for PAI (Property AI Assistant) at YOUR_PROPERTY_NAME, a residential property.

Classify this email into ONE of these categories:
- "spam" — Unsolicited marketing, phishing, scams, newsletters the recipient didn't sign up for, SEO pitches, link spam, crypto spam, adult content, automated bot messages, or any clearly unwanted bulk email. When in doubt between spam and other, lean toward spam.
- "question" — A real person asking about the property, amenities, policies, move-in, availability, etc.
- "receipt" — A receipt, invoice, or purchase confirmation from a business. Keywords: receipt, invoice, order, purchase, payment confirmation.
- "document" — A real person sending a document (manual, guide, etc.) for storage/reference. Has attachments or mentions sending a file.
- "command" — A real person requesting a smart home action (lights, music, thermostat, locks, etc.)
- "other" — Legitimate but unrelated email that doesn't fit the above categories.

Email subject: ${subject}
Email body (first 1000 chars): ${bodyText.substring(0, 1000)}
Has attachments: ${hasAttachments}

Respond with ONLY a JSON object: {"type": "spam|question|receipt|document|command|other", "confidence": 0.0-1.0, "summary": "brief one-line summary"}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
        }),
      }
    );

    if (!res.ok) {
      console.error(`Gemini classification failed: ${res.status}`);
      return { type: hasAttachments ? "document" : "question", confidence: 0.5, summary: "Gemini API error" };
    }

    const result = await res.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Log usage for cost tracking
    const usage = result.usageMetadata;
    if (usage) {
      console.log(`Gemini classification tokens: in=${usage.promptTokenCount}, out=${usage.candidatesTokenCount}`);
    }

    // Parse JSON from response (may be wrapped in ```json ... ```)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        type: ["question", "document", "receipt", "command", "spam", "other"].includes(parsed.type) ? parsed.type : "other",
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        summary: parsed.summary || "",
      };
    }

    return { type: hasAttachments ? "document" : "question", confidence: 0.5, summary: "Could not parse" };
  } catch (err) {
    console.error("Gemini classification error:", err.message);
    return { type: hasAttachments ? "document" : "question", confidence: 0.5, summary: err.message };
  }
}

/**
 * Check recent spam volume and send admin alert if threshold is crossed.
 * Only alerts once per window (checks if an alert was already sent recently).
 */
async function checkSpamThresholdAndAlert(
  supabase: any,
  senderEmail: string,
  summary: string
): Promise<void> {
  try {
    const windowStart = new Date(Date.now() - PAI_SPAM_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    // Count spam in the rolling window
    const { count, error } = await supabase
      .from("inbound_emails")
      .select("id", { count: "exact", head: true })
      .eq("special_logic_type", "pai")
      .eq("route_action", "spam_blocked")
      .gte("created_at", windowStart);

    if (error) {
      console.error("Error checking spam count:", error);
      return;
    }

    const spamCount = count || 0;
    console.log(`PAI spam count in last ${PAI_SPAM_WINDOW_HOURS}h: ${spamCount}`);

    // Only alert at the threshold crossing (not on every spam after)
    if (spamCount === PAI_SPAM_ALERT_THRESHOLD) {
      console.log(`PAI spam threshold (${PAI_SPAM_ALERT_THRESHOLD}) reached, alerting admin`);

      const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
      const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";

      // Get admin emails
      const { data: admins } = await supabase
        .from("app_users")
        .select("email")
        .eq("role", "admin");
      const adminEmails = admins?.map((a: any) => a.email) || ["admin@YOUR_DOMAIN"];

      await fetch(`${supabaseUrl}/functions/v1/send-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseAnonKey}`,
        },
        body: JSON.stringify({
          type: "pai_email_reply",
          to: adminEmails,
          data: {
            reply_body: `<strong>Spam Alert:</strong> pai@YOUR_DOMAIN has received <strong>${spamCount} spam emails</strong> in the last ${PAI_SPAM_WINDOW_HOURS} hours.\n\nMost recent: from ${senderEmail} — "${summary}"\n\nAll spam is being silently dropped (no replies sent). If this continues, consider removing the address from public-facing pages or adding domain-level filtering.`,
            original_subject: "PAI Spam Alert",
            original_body: "",
          },
          sender_type: "auto",
          subject: `PAI Spam Alert: ${spamCount} spam emails in ${PAI_SPAM_WINDOW_HOURS}h`,
        }),
      });
    }
  } catch (err) {
    console.error("Spam threshold check error:", err.message);
  }
}

/**
 * Send PAI reply email via Resend API directly (avoids edge→edge 401 when calling send-email).
 * Uses same layout as send-email's pai_email_reply template.
 * Returns { ok, status } for diagnostics.
 */
async function sendPaiReply(
  resendApiKey: string,
  to: string,
  replyBody: string,
  originalSubject: string,
  originalBody: string
): Promise<{ ok: boolean; status: number }> {
  // Check if PAI replies require approval — route through send-email if so
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (supabaseUrl && supabaseKey) {
      const sb = createClient(supabaseUrl, supabaseKey);
      const { data: config } = await sb
        .from("email_type_approval_config")
        .select("requires_approval")
        .eq("email_type", "pai_email_reply")
        .maybeSingle();

      if (config?.requires_approval) {
        // Route through send-email edge function (which has the approval gate)
        const sendEmailRes = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({
            type: "pai_email_reply",
            to: to,
            from: "PAI <pai@YOUR_DOMAIN>",
            reply_to: "pai@YOUR_DOMAIN",
            data: {
              reply_body: replyBody,
              original_subject: originalSubject,
              original_body: originalBody.substring(0, 500),
            },
          }),
        });
        const result = await sendEmailRes.json();
        if (result.status === "pending_approval") {
          console.log(`PAI reply to ${to} held for approval: ${result.approval_id}`);
          return { ok: true, status: 202 };
        }
        return { ok: sendEmailRes.ok, status: sendEmailRes.status };
      }
    }
  } catch (e) {
    console.warn("Approval check for PAI reply failed, sending directly:", e);
  }

  // Direct send (no approval required or check failed)
  const bodySnippet = originalBody.substring(0, 500);
  const subject = `Re: ${originalSubject || "Your message to PAI"}`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1a1a2e; padding: 20px; border-radius: 12px 12px 0 0;">
        <h2 style="color: #e0d68a; margin: 0;">PAI</h2>
        <p style="color: #aaa; margin: 4px 0 0 0; font-size: 13px;">Property AI Assistant</p>
      </div>
      <div style="background: #fff; padding: 24px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 12px 12px;">
        <div style="white-space: pre-wrap; line-height: 1.6;">${(replyBody || "").replace(/</g, "&lt;")}</div>
        ${bodySnippet ? `
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0 16px;">
        <p style="color: #888; font-size: 12px; margin-bottom: 8px;">Your original message:</p>
        <div style="color: #999; font-size: 13px; border-left: 3px solid #ddd; padding-left: 12px;">${bodySnippet.replace(/</g, "&lt;")}</div>
        ` : ""}
      </div>
      <p style="color: #999; font-size: 11px; text-align: center; margin-top: 12px;">
        This is an automated reply from PAI at YOUR_PROPERTY_NAME. Reply to this email to continue the conversation.
      </p>
    </div>`;
  const text = `PAI - Property AI Assistant

${replyBody || ""}

${bodySnippet ? `---\nYour original message:\n${bodySnippet}` : ""}

This is an automated reply from PAI at YOUR_PROPERTY_NAME.`;

  const res = await fetch(`${RESEND_API_URL}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "PAI <pai@YOUR_DOMAIN>",
      to: [to],
      reply_to: "pai@YOUR_DOMAIN",
      subject,
      html,
      text,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Failed to send PAI reply: ${res.status} ${errText}`);
  } else {
    console.log(`PAI reply sent to ${to}`);
  }
  return { ok: res.ok, status: res.status };
}

/**
 * Send a reply email from AlpaClaw.
 */
async function sendAI AdminReply(
  resendApiKey: string,
  to: string,
  replyBody: string,
  originalSubject: string,
  originalBody: string
): Promise<{ ok: boolean; status: number }> {
  const bodySnippet = originalBody.substring(0, 500);
  const subject = `Re: ${originalSubject || "Your message to AlpaClaw"}`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1c1618; padding: 20px; border-radius: 12px 12px 0 0;">
        <h2 style="color: #d4883a; margin: 0;">AlpaClaw</h2>
        <p style="color: #aaa; margin: 4px 0 0 0; font-size: 13px;">YOUR_PROPERTY_NAME AI</p>
      </div>
      <div style="background: #fff; padding: 24px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 12px 12px;">
        <div style="white-space: pre-wrap; line-height: 1.6;">${(replyBody || "").replace(/</g, "&lt;")}</div>
        ${bodySnippet ? `
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0 16px;">
        <p style="color: #888; font-size: 12px; margin-bottom: 8px;">Your original message:</p>
        <div style="color: #999; font-size: 13px; border-left: 3px solid #ddd; padding-left: 12px;">${bodySnippet.replace(/</g, "&lt;")}</div>
        ` : ""}
      </div>
      <p style="color: #999; font-size: 11px; text-align: center; margin-top: 12px;">
        This is an automated reply from AlpaClaw at YOUR_PROPERTY_NAME. Reply to this email to continue the conversation.
      </p>
    </div>`;
  const text = `AlpaClaw - YOUR_PROPERTY_NAME AI

${replyBody || ""}

${bodySnippet ? `---\nYour original message:\n${bodySnippet}` : ""}

This is an automated reply from AlpaClaw at YOUR_PROPERTY_NAME.`;

  const res = await fetch(`${RESEND_API_URL}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "AlpaClaw <ai-admin@YOUR_DOMAIN>",
      to: [to],
      reply_to: "ai-admin@YOUR_DOMAIN",
      subject,
      html,
      text,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Failed to send AlpaClaw reply: ${res.status} ${errText}`);
  } else {
    console.log(`AlpaClaw reply sent to ${to}`);
  }
  return { ok: res.ok, status: res.status };
}

// =============================================
// ALPACLAW EMAIL HANDLER
// =============================================

/**
 * Handle inbound email to ai-admin@YOUR_DOMAIN.
 *
 * Routes to PAI edge function with context.source = "ai-admin-email"
 * so that the ai-admin_addendum (AlpaClaw personality) is injected.
 * Sends reply back via email from ai-admin@.
 */
async function handleAI AdminEmail(
  emailRecord: any,
  supabase: any,
  resendApiKey: string
): Promise<void> {
  const subject = emailRecord.subject || "";
  const bodyText = emailRecord.body_text || "";
  const bodyHtml = emailRecord.body_html || "";
  const from = emailRecord.from_address || "";

  const senderName = (from.match(/^([^<]+)/)?.[1] || "").trim() || from.split("@")[0];
  const senderEmail = (from.match(/<(.+)>/)?.[1] || from).trim();
  const message = bodyText || bodyHtml || subject;

  console.log(`AlpaClaw email from ${senderEmail}: subject="${subject}"`);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    const paiRes = await fetch(`${supabaseUrl}/functions/v1/property-ai`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        message: `[Email from ${senderName}] ${message.substring(0, 2000)}`,
        serviceKey: supabaseServiceKey,
        context: { source: "ai-admin-email", sender: senderEmail, subject },
      }),
    });

    let replyText = "";

    if (paiRes.ok) {
      const paiData = await paiRes.json();
      replyText = paiData.reply || paiData.response || paiData.text || "";
    }

    if (!replyText) {
      replyText = `Thank you for your email! I've received your message and I'll do my best to help.\n\nFor faster responses, you can also chat with me on Discord at the Alpacord server, or visit https://YOUR_DOMAIN/residents/ (requires resident login).`;
    }

    const sendResult = await sendAI AdminReply(resendApiKey, senderEmail, replyText, subject, bodyText || bodyHtml || "");
    await supabase.from("api_usage_log").insert({
      vendor: "supabase",
      category: "ai-admin_email_reply_attempt",
      metadata: {
        success: sendResult.ok,
        status: sendResult.status,
        to: senderEmail,
        inbound_email_id: emailRecord.id,
        pai_status: paiRes?.status,
        pai_ok: paiRes?.ok,
      },
    });
    if (sendResult.ok) {
      await supabase.from("api_usage_log").insert({
        vendor: "resend",
        category: "email_ai-admin_email_reply",
        endpoint: "POST /emails",
        units: 1,
        unit_type: "emails",
        estimated_cost_usd: 0.00028,
        metadata: { to: senderEmail, inbound_email_id: emailRecord.id },
      });
    }
  } catch (err) {
    console.error(`AlpaClaw response error: ${err.message}`);
    const sendResult = await sendAI AdminReply(
      resendApiKey,
      senderEmail,
      "Thank you for your email! I've received your message and the team will review it shortly.\n\nFor immediate assistance, you can reach us on Discord or at https://YOUR_DOMAIN/residents/.",
      subject,
      bodyText || bodyHtml || ""
    );
    await supabase.from("api_usage_log").insert({
      vendor: "supabase",
      category: "ai-admin_email_reply_attempt",
      metadata: { success: sendResult.ok, status: sendResult.status, to: senderEmail, inbound_email_id: emailRecord.id, error: String(err?.message || err) },
    });
  }
}

/**
 * Send admin notification about uploaded documents.
 */
async function sendPaiDocumentNotification(
  supabase: any,
  senderName: string,
  senderEmail: string,
  originalSubject: string,
  messageBody: string,
  files: Array<{ name: string; type: string; size: string }>
): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";

  // Get admin emails
  const { data: admins } = await supabase
    .from("app_users")
    .select("email")
    .eq("role", "admin");

  const adminEmails = admins?.map((a: any) => a.email) || ["admin@YOUR_DOMAIN"];

  const res = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify({
      type: "pai_document_received",
      to: adminEmails,
      data: {
        sender_name: senderName,
        sender_email: senderEmail,
        original_subject: originalSubject,
        message_body: messageBody,
        files,
        file_count: files.length,
        admin_url: "https://YOUR_DOMAIN/spaces/admin/manage.html",
      },
      sender_type: "auto",
    }),
  });

  if (!res.ok) {
    console.error(`Failed to send document notification: ${res.status}`);
  }
}

/**
 * Download attachment from Resend and return as Uint8Array.
 */
async function downloadResendAttachment(
  resendApiKey: string,
  emailId: string,
  attachmentId: string,
  fallbackFilename: string
): Promise<{ data: Uint8Array; filename: string; contentType: string } | null> {
  try {
    // Use Resend's attachment endpoint to get the download URL
    const attRes = await fetch(
      `${RESEND_API_URL}/emails/receiving/${emailId}/attachments/${attachmentId}`,
      { headers: { Authorization: `Bearer ${resendApiKey}` } }
    );

    if (!attRes.ok) {
      console.error(`Failed to fetch attachment metadata: ${attRes.status} ${await attRes.text()}`);
      return null;
    }

    const attData = await attRes.json();
    const downloadUrl = attData.download_url;
    const filename = attData.filename || fallbackFilename;
    const contentType = attData.content_type || "application/octet-stream";

    if (!downloadUrl) {
      console.error(`No download_url for attachment ${attachmentId}`);
      return null;
    }

    // Download the actual file content from the signed URL
    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) {
      console.error(`Failed to download attachment file: ${fileRes.status}`);
      return null;
    }

    const data = new Uint8Array(await fileRes.arrayBuffer());
    console.log(`Downloaded attachment: ${filename} (${data.length} bytes)`);
    return { data, filename, contentType };
  } catch (err) {
    console.error(`Error downloading attachment: ${err.message}`);
    return null;
  }
}

/**
 * Format file size in human-readable form.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Heuristic: treat short "other" emails that look like questions as questions so we still reply.
 */
function looksLikeQuestion(subject: string, body: string): boolean {
  const combined = `${(subject || "").trim()} ${(body || "").trim()}`.toLowerCase();
  if (combined.length > 500) return false;
  if (combined.includes("?")) return true;
  const questionPhrases = ["can i ", "can we ", "could i ", "may i ", "how do ", "how can ", "is it ok", "is it okay", "are we ", "do you ", "does the ", "should i ", "would it "];
  return questionPhrases.some((p) => combined.includes(p));
}

/**
 * Handle inbound email to pai@YOUR_DOMAIN.
 *
 * 1. Classify via Gemini (question/document/command/other)
 * 2. Questions & commands → forward to PAI chat, send reply email
 * 3. Documents → download attachments, upload to R2, index, notify admin
 */
async function handlePaiEmail(
  emailRecord: any,
  supabase: any,
  resendApiKey: string
): Promise<void> {
  const subject = emailRecord.subject || "";
  const bodyText = emailRecord.body_text || "";
  const bodyHtml = emailRecord.body_html || "";
  const from = emailRecord.from_address || "";
  const emailId = emailRecord.resend_email_id || "";
  const rawPayload = emailRecord.raw_payload || {};
  const attachmentsMetadata = emailRecord.attachments || rawPayload.attachments || [];

  // Extract sender info
  const senderName = (from.match(/^([^<]+)/)?.[1] || "").trim() || from.split("@")[0];
  const senderEmail = (from.match(/<(.+)>/)?.[1] || from).trim();

  const hasAttachments = attachmentsMetadata.length > 0;

  console.log(`PAI email from ${senderEmail}: subject="${subject}", attachments=${attachmentsMetadata.length}`);

  // Check if this is a reply to one of our outbound emails (has hidden metadata)
  const { isReply: isPaiReply, meta: paiReplyMeta } = isReplyToOurEmail(subject, bodyHtml);
  if (isPaiReply && paiReplyMeta) {
    console.log(`PAI reply detected: original type=${paiReplyMeta.type}, eid=${paiReplyMeta.eid}, to=[${paiReplyMeta.to}]`);
    // Store reply context for downstream handlers
    await supabase
      .from("inbound_emails")
      .update({
        reply_to_email_id: paiReplyMeta.eid,
        reply_context: paiReplyMeta,
      })
      .eq("id", emailRecord.id);
    // Enrich the email record so handlers can use it
    emailRecord.reply_context = paiReplyMeta;
  }

  // Classify the email
  const classification = await classifyPaiEmail(subject, bodyText || bodyHtml, hasAttachments);
  console.log(`PAI classification: type=${classification.type}, confidence=${classification.confidence}, summary="${classification.summary}"`);

  // Heuristic override: if classified as "document" but subject/filenames look like a receipt, upgrade to "receipt"
  if (classification.type === "document" && hasAttachments) {
    const attachmentFilenames = attachmentsMetadata.map((a: any) => a.filename || a.name || "").join(" ");
    if (looksLikeReceipt(attachmentFilenames, subject)) {
      console.log(`Overriding classification from "document" to "receipt" based on subject/filename heuristic`);
      classification.type = "receipt";
      classification.summary = `[heuristic override] ${classification.summary}`;
    }
  }

  // Log usage for cost tracking
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  if (geminiApiKey) {
    await supabase.from("api_usage_log").insert({
      vendor: "gemini",
      category: "pai_email_classification",
      endpoint: "generateContent",
      estimated_cost_usd: 0.0001, // ~100 input tokens + ~50 output tokens on flash
      metadata: {
        model: "gemini-2.0-flash",
        email_from: senderEmail,
        classification: classification.type,
        confidence: classification.confidence,
      },
    });
  }

  // Handle based on classification
  if (classification.type === "spam") {
    // === SPAM: Silently drop, log, check threshold ===
    console.log(`PAI email classified as spam, dropping silently: "${classification.summary}"`);

    // Update the inbound_emails record to mark as spam
    await supabase
      .from("inbound_emails")
      .update({ route_action: "spam_blocked" })
      .eq("id", emailRecord.id);

    // Check if we've crossed the alert threshold
    await checkSpamThresholdAndAlert(supabase, senderEmail, classification.summary);
    return;
  }

  if (classification.type === "receipt" && hasAttachments) {
    // === RECEIPT: Extract vendor info, create purchase record, upload receipt ===
    console.log("Processing receipt email...");
    const processedReceipts: Array<{ vendor: string; amount: number; filename: string }> = [];

    for (let i = 0; i < attachmentsMetadata.length; i++) {
      const att = attachmentsMetadata[i];
      const filename = att.filename || att.name || `receipt-${i}`;
      const contentType = att.content_type || att.type || "application/octet-stream";

      // Only process images and PDFs as potential receipts
      if (
        !contentType.startsWith("image/") &&
        !contentType.includes("pdf") &&
        !looksLikeReceipt(filename, subject)
      ) {
        console.log(`Skipping non-receipt attachment: ${filename}`);
        continue;
      }

      try {
        const attachmentId = att.id;
        if (!attachmentId) {
          console.error(`No attachment ID for attachment ${i}, skipping`);
          continue;
        }

        // Download attachment
        const downloaded = await downloadResendAttachment(resendApiKey, emailId, attachmentId, filename);
        if (!downloaded) continue;

        // Extract receipt data using Gemini Vision
        console.log(`Extracting receipt data from ${filename}...`);
        const receiptData = await extractReceiptData(downloaded.data, downloaded.contentType, filename);

        if (!receiptData) {
          console.log(`Could not extract receipt data from ${filename}, treating as regular document`);
          continue;
        }

        console.log(`Extracted receipt: ${receiptData.vendor.name}, $${receiptData.totalAmount}`);

        // Upload to R2 for permanent storage
        const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
        const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const r2Key = `receipts/${datePrefix}/${sanitizedFilename}`;
        const publicUrl = await uploadToR2(r2Key, downloaded.data, downloaded.contentType);

        // Upsert vendor
        const vendorId = await upsertVendor(supabase, receiptData.vendor);
        console.log(`Vendor ${receiptData.vendor.name}: ${vendorId || "not created"}`);

        // Create purchase record
        const purchaseId = await createPurchase(
          supabase,
          receiptData,
          vendorId,
          publicUrl,
          emailRecord.id
        );

        if (purchaseId) {
          processedReceipts.push({
            vendor: receiptData.vendor.name,
            amount: receiptData.totalAmount,
            filename,
          });

          // Log Gemini API usage
          await supabase.from("api_usage_log").insert({
            vendor: "gemini",
            category: "receipt_extraction",
            endpoint: "generateContent",
            estimated_cost_usd: 0.001, // Approximate cost for vision API call
            metadata: {
              vendor: receiptData.vendor.name,
              amount: receiptData.totalAmount,
              filename,
              source: "pai_email",
            },
          });
        }

        // Log R2 upload
        await supabase.from("api_usage_log").insert({
          vendor: "cloudflare_r2",
          category: "r2_receipt_upload",
          endpoint: "PutObject",
          units: 1,
          unit_type: "api_calls",
          estimated_cost_usd: 0,
          metadata: { key: r2Key, size_bytes: downloaded.data.length },
        });
      } catch (err) {
        console.error(`Error processing receipt ${filename}:`, err.message);
      }
    }

    if (processedReceipts.length > 0) {
      // Auto-reply confirming receipt processing
      const receiptsList = processedReceipts
        .map((r) => `• ${r.vendor}: $${r.amount.toFixed(2)} (${r.filename})`)
        .join("\n");

      await sendPaiReply(
        resendApiKey,
        senderEmail,
        `Thank you for sending ${processedReceipts.length === 1 ? "the receipt" : `${processedReceipts.length} receipts`}! I've processed and logged:\n\n${receiptsList}\n\nYou can view all purchases at https://YOUR_DOMAIN/spaces/admin/purchases.html`,
        subject,
        bodyText || bodyHtml || ""
      );

      // Update email record
      await supabase
        .from("inbound_emails")
        .update({ route_action: "receipt_processed" })
        .eq("id", emailRecord.id);
    }
  } else if (classification.type === "document" && hasAttachments) {
    // === DOCUMENT: Download, upload to R2, index, notify admin ===
    const uploadedFiles: Array<{ name: string; type: string; size: string }> = [];

    for (let i = 0; i < attachmentsMetadata.length; i++) {
      const att = attachmentsMetadata[i];
      const filename = att.filename || att.name || `attachment-${i}`;
      const contentType = att.content_type || att.type || "application/octet-stream";

      // Skip non-document types (e.g., inline images, signatures)
      if (contentType.startsWith("image/") && !filename.match(/\.(pdf|doc|docx|xls|xlsx|csv|txt)$/i)) {
        console.log(`Skipping inline image: ${filename}`);
        continue;
      }

      try {
        // Download from Resend using the attachment ID from the webhook payload
        const attachmentId = att.id;
        if (!attachmentId) {
          console.error(`No attachment ID for attachment ${i}, skipping`);
          continue;
        }
        const downloaded = await downloadResendAttachment(resendApiKey, emailId, attachmentId, filename);
        if (!downloaded) continue;

        // Generate R2 key
        const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
        const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const r2Key = `documents/email-uploads/${datePrefix}/${sanitizedFilename}`;

        // Upload to R2
        const publicUrl = await uploadToR2(r2Key, downloaded.data, downloaded.contentType);
        console.log(`Uploaded to R2: ${r2Key} → ${publicUrl}`);

        // Create document_index entry (inactive pending admin review)
        const fileExt = filename.split(".").pop()?.toLowerCase() || "";
        const docSlug = sanitizedFilename.replace(/\.[^.]+$/, ""); // strip extension for slug
        await supabase.from("document_index").insert({
          slug: `email-${datePrefix}-${docSlug}`,
          title: filename,
          description: `Uploaded via email by ${senderName} (${senderEmail}). Subject: ${subject}`,
          category: "email-upload",
          keywords: [fileExt, "email-upload", senderName.toLowerCase()],
          storage_bucket: "r2",
          storage_path: r2Key,
          source_url: publicUrl,
          file_size_bytes: downloaded.data.length,
          storage_backend: "r2",
          is_active: false, // Pending admin review
        });

        uploadedFiles.push({
          name: filename,
          type: contentType,
          size: formatFileSize(downloaded.data.length),
        });

        // Log R2 upload cost
        await supabase.from("api_usage_log").insert({
          vendor: "cloudflare_r2",
          category: "r2_document_upload",
          endpoint: "PutObject",
          units: 1,
          unit_type: "api_calls",
          estimated_cost_usd: 0, // Free tier
          metadata: { key: r2Key, size_bytes: downloaded.data.length, source: "pai_email" },
        });
      } catch (err) {
        console.error(`Error processing attachment ${filename}:`, err.message);
      }
    }

    if (uploadedFiles.length > 0) {
      // Notify admin
      await sendPaiDocumentNotification(
        supabase,
        senderName,
        senderEmail,
        subject,
        (bodyText || bodyHtml || "").substring(0, 500),
        uploadedFiles
      );

      // Auto-reply to sender
      const fileNames = uploadedFiles.map(f => f.name).join(", ");
      await sendPaiReply(
        resendApiKey,
        senderEmail,
        `Thank you for sending ${uploadedFiles.length === 1 ? "the document" : `${uploadedFiles.length} documents`} (${fileNames}). I've received ${uploadedFiles.length === 1 ? "it" : "them"} and ${uploadedFiles.length === 1 ? "it's" : "they're"} now pending admin review before being added to my knowledge base.\n\nYou'll be able to ask me about ${uploadedFiles.length === 1 ? "this document" : "these documents"} once ${uploadedFiles.length === 1 ? "it's" : "they're"} approved.`,
        subject,
        bodyText || bodyHtml || ""
      );
    }
  } else if (
    classification.type === "question" ||
    classification.type === "command" ||
    (classification.type === "other" && looksLikeQuestion(subject, bodyText || bodyHtml))
  ) {
    // === QUESTION or COMMAND (or other that looks like a question): Forward to PAI, send reply ===
    const message = bodyText || bodyHtml || subject;

    try {
      // Call the property-ai edge function directly
      const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

      const paiRes = await fetch(`${supabaseUrl}/functions/v1/property-ai`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({
          message: `[Email from ${senderName}] ${message.substring(0, 2000)}`,
          serviceKey: supabaseServiceKey,
          context: { source: "email", sender: senderEmail, subject },
        }),
      });

      let replyText = "";

      if (paiRes.ok) {
        const paiData = await paiRes.json();
        replyText = paiData.reply || paiData.response || paiData.text || "";
      }

      if (!replyText) {
        replyText = `Thank you for your email. I've received your ${classification.type === "command" ? "request" : "question"} and I'll have someone from the team follow up with you.\n\nFor faster responses, you can chat with me directly at https://YOUR_DOMAIN/residents/ (requires resident login).`;
      }

      const sendResult = await sendPaiReply(resendApiKey, senderEmail, replyText, subject, bodyText || bodyHtml || "");
      await supabase.from("api_usage_log").insert({
        vendor: "supabase",
        category: "pai_email_reply_attempt",
        metadata: {
          success: sendResult.ok,
          status: sendResult.status,
          to: senderEmail,
          inbound_email_id: emailRecord.id,
          pai_status: paiRes?.status,
          pai_ok: paiRes?.ok,
        },
      });
      if (sendResult.ok) {
        await supabase.from("api_usage_log").insert({
          vendor: "resend",
          category: "email_pai_email_reply",
          endpoint: "POST /emails",
          units: 1,
          unit_type: "emails",
          estimated_cost_usd: 0.00028,
          metadata: { to: senderEmail, inbound_email_id: emailRecord.id },
        });
      }
    } catch (err) {
      console.error(`PAI response error: ${err.message}`);
      // Send generic reply on error
      const sendResult = await sendPaiReply(
        resendApiKey,
        senderEmail,
        "Thank you for your email. I've received your message and the team will review it shortly.\n\nFor immediate assistance, you can call us or chat with me at https://YOUR_DOMAIN/residents/.",
        subject,
        bodyText || bodyHtml || ""
      );
      await supabase.from("api_usage_log").insert({
        vendor: "supabase",
        category: "pai_email_reply_attempt",
        metadata: { success: sendResult.ok, status: sendResult.status, to: senderEmail, inbound_email_id: emailRecord.id, error: String(err?.message || err) },
      });
    }
  } else {
    // === OTHER: Forward to admin ===
    console.log(`PAI email classified as 'other', forwarding to admin`);
    // Just forward — the normal forwarding logic handles this since we don't set forwardTargets for special logic
    // But since special logic handlers don't forward by default, let's manually forward
    const adminEmail = "admin@YOUR_DOMAIN";
    const forwardRes = await fetch(`${RESEND_API_URL}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `PAI Forward <notifications@YOUR_DOMAIN>`,
        to: [adminEmail],
        reply_to: senderEmail,
        subject: `[PAI Forward] ${subject}`,
        html: bodyHtml || `<pre>${bodyText}</pre>`,
        text: bodyText || "(HTML-only email)",
      }),
    });

    if (!forwardRes.ok) {
      console.error(`PAI forward failed: ${forwardRes.status}`);
    } else {
      console.log(`PAI email forwarded to admin (classified as 'other')`);
    }
  }
}

// =============================================
// ZELLE PAYMENT AUTO-RECORDING
// =============================================

interface ZellePayment {
  amount: number;
  senderName: string;
  confirmationNumber: string | null;
  bank: string;
}

/**
 * Normalize a name for consistent matching.
 */
function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ").replace(/[^a-z0-9\s]/g, "");
}

/**
 * Parse Zelle payment details from email body text.
 */
function parseZellePayment(bodyText: string): ZellePayment | null {
  // Normalize: collapse all whitespace (newlines, tabs, multiple spaces) into single spaces
  // Gmail forwarding and email clients insert line breaks mid-sentence
  const normalized = bodyText.replace(/\s+/g, " ");

  // Charles Schwab format:
  // "deposited the $130.00 payment from MAYA WHITE (confirmation number 4864859525)"
  const schwabPattern = /deposited the \$([\d,]+\.\d{2}) payment from (.+?) \(confirmation number (\d+)\)/i;
  const schwabMatch = normalized.match(schwabPattern);
  if (schwabMatch) {
    return {
      amount: parseFloat(schwabMatch[1].replace(/,/g, "")),
      senderName: schwabMatch[2].trim(),
      confirmationNumber: schwabMatch[3],
      bank: "schwab",
    };
  }

  // Chase format: "sent you $X.XX" or "You received $X.XX from NAME"
  const chasePattern = /(?:received|sent you) \$([\d,]+\.\d{2}).*?(?:from|by)\s+(.+?)(?:\s*\.|$)/im;
  const chaseMatch = normalized.match(chasePattern);
  if (chaseMatch) {
    return {
      amount: parseFloat(chaseMatch[1].replace(/,/g, "")),
      senderName: chaseMatch[2].trim(),
      confirmationNumber: null,
      bank: "chase",
    };
  }

  // Bank of America format: "A Zelle payment of $X.XX was received from NAME"
  const boaPattern = /Zelle payment of \$([\d,]+\.\d{2}) was received from (.+?)(?:\s*\.|$)/im;
  const boaMatch = normalized.match(boaPattern);
  if (boaMatch) {
    return {
      amount: parseFloat(boaMatch[1].replace(/,/g, "")),
      senderName: boaMatch[2].trim(),
      confirmationNumber: null,
      bank: "boa",
    };
  }

  // US Bank format (from sender's bank perspective):
  // "Your Zelle payment of $999.77 to YOUR_PROPERTY_NAME has been deposited."
  // This is inbound — someone sent money TO YOUR_PROPERTY_NAME via their US Bank account.
  // Sender name comes from the email's From or account info, not the body text.
  // We extract the amount; sender name needs to come from email metadata or "Sent from account" info.
  const usbankInbound = /Your Zelle.{0,5} payment of \$([\d,]+\.\d{2}) to (?:Property|property)/im;
  const usbankMatch = normalized.match(usbankInbound);
  if (usbankMatch) {
    // US Bank emails don't include sender's name in body — they say "Sent from account ending in: XXXX"
    // The sender name must be resolved from the forwarding context or email From header
    return {
      amount: parseFloat(usbankMatch[1].replace(/,/g, "")),
      senderName: "Unknown (US Bank sender)",
      confirmationNumber: null,
      bank: "usbank",
    };
  }

  return null;
}

// =============================================
// OUTBOUND ZELLE PAYMENT PARSING (sent payments / refunds)
// =============================================

interface OutboundZellePayment {
  amount: number;
  recipientName: string;
  confirmationNumber: string | null;
  bank: string;
  memo: string | null;
}

/**
 * Parse outbound Zelle payment details from email body text.
 * Detects sent/outbound payment patterns from various banks.
 *
 * Common traits across banks (for future-proofing):
 * - All mention "Zelle" somewhere in the email
 * - All contain a dollar amount
 * - All reference a recipient name
 * - Many have a confirmation/transaction number
 * - Many use structured fields (Amount, To, Confirmation Number)
 *
 * Bank-specific patterns are tried first, then a generic structured-field
 * fallback catches new banks that use similar layouts.
 *
 * Known formats:
 * - Schwab: "your payment to NAME has finished processing" + structured fields
 * - Chase: "You sent $X to NAME with Zelle"
 * - BOA: "Your Zelle payment of $X to NAME was successful"
 * - US Bank: "Your Zelle payment of $X to NAME has been deposited" (outbound variant)
 *
 * IMPORTANT: Inbound payments TO YOUR_PROPERTY_NAME are handled by parseZellePayment.
 * This function only handles money SENT FROM YOUR_PROPERTY_NAME accounts.
 */
function parseOutboundZellePayment(bodyText: string): OutboundZellePayment | null {
  const normalized = bodyText.replace(/\s+/g, " ");

  // ---- Bank-specific patterns (high confidence) ----

  // Charles Schwab outbound (structured format):
  // "your payment to Fabiola has finished processing"
  // "Confirmation Number 4886778504"
  // "Amount $105.00"
  // "To Fabiola Batres (555-555-5555)"
  if (/your payment to .+? has finished processing/i.test(normalized)) {
    const amountMatch = normalized.match(/Amount\s+\$([\d,]+\.\d{2})/i);
    // "To" field has name, sometimes with phone: "Fabiola Batres (555-555-5555)" or "ZIA - 808-855-8882"
    // Support single-word names (ZIA), multi-word names (Fabiola Batres), and names followed by phone/dash
    const toMatch = normalized.match(/\bTo\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)(?:\s*[-–(]\s*[\d-]+)?/);
    const confMatch = normalized.match(/Confirmation\s+Number\s+(\d+)/i);
    // Schwab includes a "Message" field with the sender's memo (e.g., "property playhouse cleaning")
    // The memo is short text between "Message" and "As of" (or next sentence boundary).
    // Be strict: only grab up to ~100 chars, stop at "As of", "Thank", "Sincerely", period+space, or newline-like patterns.
    const msgMatch = normalized.match(/\bMessage\s+([A-Za-z0-9][^.]{2,100}?)(?:\s+As of\b|\s+Thank|\s+Sincerely|\.\s|$)/i);
    if (amountMatch && toMatch) {
      return {
        amount: parseFloat(amountMatch[1].replace(/,/g, "")),
        recipientName: toMatch[1].trim(),
        confirmationNumber: confMatch ? confMatch[1] : null,
        bank: "schwab",
        memo: msgMatch ? msgMatch[1].trim() : null,
      };
    }
  }

  // Chase outbound: "You sent $841.47 to Rachel Wen with Zelle"
  const chaseOutbound = /You sent \$([\d,]+\.\d{2}) to (.+?)(?:\s+with Zelle)?(?:\s*\.|$)/im;
  const chaseMatch = normalized.match(chaseOutbound);
  if (chaseMatch) {
    return {
      amount: parseFloat(chaseMatch[1].replace(/,/g, "")),
      recipientName: chaseMatch[2].trim(),
      confirmationNumber: null,
      bank: "chase",
      memo: null,
    };
  }

  // BOA / US Bank / generic: "Your Zelle payment of $X to NAME was successful/deposited/sent/completed"
  // Covers multiple banks that use "Zelle payment of $X to NAME" phrasing.
  // Only treated as outbound if recipient is NOT YOUR_PROPERTY_NAME (that's inbound).
  const zellePaymentTo = /(?:Your )?Zelle.{0,5} payment of \$([\d,]+\.\d{2}) to (.+?) (?:was |has been )(?:successful|sent|completed|deposited|processed)/im;
  const zelleToMatch = normalized.match(zellePaymentTo);
  if (zelleToMatch) {
    const recipientName = zelleToMatch[2].trim();
    if (/property/i.test(recipientName)) {
      return null; // Inbound — handled by parseZellePayment
    }
    return {
      amount: parseFloat(zelleToMatch[1].replace(/,/g, "")),
      recipientName,
      confirmationNumber: null,
      bank: "generic",
      memo: null,
    };
  }

  // ---- Generic structured-field fallback ----
  // Many bank Zelle emails use structured fields like:
  //   Amount: $105.00    To: Fabiola Batres    Confirmation Number: 123456
  // If the email mentions "Zelle" and has these fields, treat as outbound.
  // Guard: only match if NOT mentioning "received from" (which is inbound).
  if (/zelle/i.test(normalized) && !/received from/i.test(normalized) && !/deposited the \$/i.test(normalized)) {
    const amountField = normalized.match(/Amount:?\s+\$([\d,]+\.\d{2})/i);
    const toField = normalized.match(/(?:Recipient|Sent to|To):?\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)(?:\s*[-–(]\s*[\d-]+)?/i);
    const confField = normalized.match(/(?:Confirmation|Transaction|Reference)\s*(?:Number|ID|#):?\s*(\d+)/i);
    // Try to extract memo/note/message field
    const memoField = normalized.match(/(?:Message|Memo|Note|Description):?\s+(.+?)(?:\s+(?:As of|From|Sent|Thank)\b|$)/i);
    if (amountField && toField) {
      const recipientName = toField[1].trim();
      if (/property/i.test(recipientName)) {
        return null; // Inbound
      }
      return {
        amount: parseFloat(amountField[1].replace(/,/g, "")),
        recipientName,
        confirmationNumber: confField ? confField[1] : null,
        bank: "generic",
        memo: memoField ? memoField[1].trim() : null,
      };
    }
  }

  return null;
}

/**
 * Handle an outbound Zelle payment (refund/payout sent to someone).
 * Creates an expense ledger entry and notifies admin.
 */
async function handleOutboundZellePayment(
  supabase: any,
  resendApiKey: string,
  outbound: OutboundZellePayment
): Promise<void> {
  // Try to match recipient to a person in the DB
  const nameMatch = await matchByName(supabase, outbound.recipientName);
  const personId = nameMatch?.person_id || null;
  const personName = nameMatch?.name || outbound.recipientName;

  const today = new Date().toISOString().split("T")[0];

  // Determine category from memo or context:
  // - "cleaning", "maintenance", "repair" → associate_payment (contractor work)
  // - "refund", "deposit" → refund
  // - "decor", "supplies", "order", "purchase", "merch" → merchandise
  // - Known person in DB → associate_payment (contractor)
  // - Otherwise → other (admin can recategorize)
  const memoLower = (outbound.memo || "").toLowerCase();
  let category = "other";
  if (/refund|deposit return/i.test(memoLower)) {
    category = "refund";
  } else if (/clean|maint|repair|lawn|landscap|plumb|electric|paint|handyman|contractor|work/i.test(memoLower)) {
    category = "associate_payment";
  } else if (/decor|suppli|order|purchas|merch|material|equipment|furniture|appliance|hardware|tool|part/i.test(memoLower)) {
    category = "merchandise";
  } else if (nameMatch) {
    // If we matched a known person but no clear memo, default to associate_payment
    category = "associate_payment";
  }

  // Build description with memo
  const memoStr = outbound.memo ? ` — "${outbound.memo}"` : "";
  const confStr = outbound.confirmationNumber ? `, conf#${outbound.confirmationNumber}` : "";

  // Create expense ledger entry
  const { data: ledgerEntry, error: ledgerError } = await supabase.from("ledger").insert({
    direction: "expense",
    category,
    amount: outbound.amount,
    payment_method: "zelle",
    transaction_date: today,
    person_id: personId,
    person_name: personName,
    status: "completed",
    description: `Outbound Zelle to ${personName}${memoStr} (auto-recorded${confStr})`,
    notes: outbound.memo || null,
    recorded_by: "system:zelle-outbound-email",
  }).select("id").single();

  if (ledgerError) {
    console.error("Failed to create outbound Zelle ledger entry:", ledgerError);
  } else {
    console.log(`Outbound Zelle ledger entry created: ${ledgerEntry.id}, $${outbound.amount} to ${personName}, category=${category}`);
  }

  // Notify admin
  const adminEmail = "team@YOUR_DOMAIN";
  const categoryLabel = category === "associate_payment" ? "Contractor Payment" : category === "refund" ? "Refund" : category === "merchandise" ? "Merchandise/Supplies" : "Other (verify)";
  const subject = `Outbound Zelle Recorded: $${outbound.amount.toFixed(2)} to ${personName}${outbound.memo ? ` — ${outbound.memo}` : ""}`;
  const html = `
    <div style="font-family:-apple-system,sans-serif;max-width:600px;">
      <h2 style="color:#2d7d46;">&#x2705; Outbound Payment Auto-Recorded</h2>
      <table style="border-collapse:collapse;width:100%;">
        <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Amount</td><td style="padding:8px;border-bottom:1px solid #eee;">$${outbound.amount.toFixed(2)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Sent To</td><td style="padding:8px;border-bottom:1px solid #eee;">${outbound.recipientName}</td></tr>
        ${nameMatch ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Matched To</td><td style="padding:8px;border-bottom:1px solid #eee;">${personName}</td></tr>` : `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Match</td><td style="padding:8px;border-bottom:1px solid #eee;color:#e67e22;">No person match found</td></tr>`}
        ${outbound.memo ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Memo</td><td style="padding:8px;border-bottom:1px solid #eee;">${outbound.memo}</td></tr>` : ""}
        ${outbound.confirmationNumber ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Confirmation #</td><td style="padding:8px;border-bottom:1px solid #eee;">${outbound.confirmationNumber}</td></tr>` : ""}
        <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Method</td><td style="padding:8px;border-bottom:1px solid #eee;">Zelle outbound (${outbound.bank})</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Category</td><td style="padding:8px;border-bottom:1px solid #eee;">${categoryLabel}</td></tr>
      </table>
      <p style="color:#666;font-size:0.85rem;margin-top:12px;">This outbound payment was auto-recorded in the ledger. Verify the category in the <a href="https://YOUR_DOMAIN/spaces/admin/accounting.html">accounting dashboard</a>.</p>
    </div>
  `;

  try {
    await fetch(`${RESEND_API_URL}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Property Payments <noreply@YOUR_DOMAIN>",
        to: [adminEmail],
        subject,
        html,
      }),
    });
    console.log("Outbound Zelle payment notification sent to admin");
  } catch (err) {
    console.error("Failed to send outbound Zelle notification:", err);
  }
}

// =============================================
// PAYPAL PAYMENT EMAIL PARSING
// =============================================

interface PayPalPaymentEmail {
  amount: number;
  senderName: string;
  senderEmail: string | null;
  transactionId: string | null;
  source: string; // "paypal_notification", "paypal_receipt"
}

/**
 * Parse PayPal payment notification emails.
 * Handles multiple PayPal email formats:
 * - "You've received $X.XX from Name" (instant notification)
 * - "You received a payment of $X.XX from Name" (payment received)
 * - "Name sent you $X.XX" (money received)
 * - "Payment received: $X.XX" with sender details
 */
function parsePayPalPayment(bodyText: string, fromAddress: string): PayPalPaymentEmail | null {
  // Only process emails from PayPal
  const fromLower = fromAddress.toLowerCase();
  if (!fromLower.includes("paypal") && !fromLower.includes("service@paypal.com") && !fromLower.includes("service@intl.paypal.com")) {
    return null;
  }

  const normalized = bodyText.replace(/\s+/g, " ");

  // Reject OUTBOUND PayPal payments — we only care about money received, not money sent
  if (/you sent \$[\d,]+\.\d{2}/i.test(normalized) || /you sent a payment/i.test(normalized)) {
    return null;
  }

  // Pattern 1: "You've received $X.XX from Name"
  const receivedPattern1 = /(?:You['']ve received|You received|received a payment of) \$([\d,]+\.\d{2})(?: USD)? from (.+?)(?:\s*\.|$|!|\s+for\b)/im;
  const match1 = normalized.match(receivedPattern1);
  if (match1) {
    const txMatch = normalized.match(/Transaction ID[:\s]*([A-Z0-9]+)/i);
    return {
      amount: parseFloat(match1[1].replace(/,/g, "")),
      senderName: match1[2].trim(),
      senderEmail: null,
      transactionId: txMatch?.[1] || null,
      source: "paypal_notification",
    };
  }

  // Pattern 2: "Name sent you $X.XX"
  const sentPattern = /(.+?) sent you \$([\d,]+\.\d{2})/im;
  const match2 = normalized.match(sentPattern);
  if (match2) {
    const txMatch = normalized.match(/Transaction ID[:\s]*([A-Z0-9]+)/i);
    return {
      amount: parseFloat(match2[2].replace(/,/g, "")),
      senderName: match2[1].trim(),
      senderEmail: null,
      transactionId: txMatch?.[1] || null,
      source: "paypal_notification",
    };
  }

  // Pattern 3: "Payment of $X.XX received" or "Payment received: $X.XX"
  const paymentReceivedPattern = /[Pp]ayment (?:of \$([\d,]+\.\d{2}) received|received[:\s]+\$([\d,]+\.\d{2}))/;
  const match3 = normalized.match(paymentReceivedPattern);
  if (match3) {
    const amt = match3[1] || match3[2];
    // Try to find sender
    const senderMatch = normalized.match(/(?:from|sender|paid by)[:\s]+(.+?)(?:\s*\.|$|!)/i);
    const txMatch = normalized.match(/Transaction ID[:\s]*([A-Z0-9]+)/i);
    return {
      amount: parseFloat(amt.replace(/,/g, "")),
      senderName: senderMatch?.[1]?.trim() || "Unknown",
      senderEmail: null,
      transactionId: txMatch?.[1] || null,
      source: "paypal_receipt",
    };
  }

  // Pattern 4: Generic amount extraction from PayPal emails as fallback
  const genericAmount = normalized.match(/\$([\d,]+\.\d{2})/);
  if (genericAmount) {
    const nameMatch = normalized.match(/(?:from|sender|paid by)[:\s]+(.+?)(?:\s*\.|$|!|\s+for\b)/i);
    const txMatch = normalized.match(/Transaction ID[:\s]*([A-Z0-9]+)/i);
    if (nameMatch) {
      return {
        amount: parseFloat(genericAmount[1].replace(/,/g, "")),
        senderName: nameMatch[1].trim(),
        senderEmail: null,
        transactionId: txMatch?.[1] || null,
        source: "paypal_receipt",
      };
    }
  }

  return null;
}

/**
 * Try to match a Zelle sender name to a person in the people table.
 */
async function matchByName(
  supabase: any,
  senderName: string
): Promise<{ person_id: string; name: string } | null> {
  const normalized = normalizeName(senderName);

  // 1. Check payment_sender_mappings cache
  const { data: cached } = await supabase
    .from("payment_sender_mappings")
    .select("person_id")
    .eq("sender_name_normalized", normalized)
    .single();

  if (cached) {
    const { data: person } = await supabase
      .from("people")
      .select("id, first_name, last_name")
      .eq("id", cached.person_id)
      .single();
    if (person) {
      return { person_id: person.id, name: `${person.first_name} ${person.last_name}` };
    }
  }

  // 2. Load all people for matching
  const { data: people } = await supabase
    .from("people")
    .select("id, first_name, last_name");

  if (!people) return null;

  // 3. Exact full-name match (case-insensitive)
  for (const person of people) {
    const fullName = `${person.first_name} ${person.last_name}`;
    if (normalizeName(fullName) === normalized) {
      // Save mapping for future
      await supabase.from("payment_sender_mappings").upsert(
        {
          sender_name: senderName,
          sender_name_normalized: normalized,
          person_id: person.id,
          confidence_score: 1.0,
          match_source: "zelle_email_exact",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "sender_name_normalized" }
      );
      return { person_id: person.id, name: fullName };
    }
  }

  // 4. Fuzzy: check if all parts of person's name appear in sender name parts
  //    Handles multi-word first names like "Maya Nicole" matching "MAYA WHITE"
  //    by checking if first-name parts AND last-name parts all exist in sender parts
  const parts = normalized.split(/\s+/);
  if (parts.length >= 2) {
    for (const person of people) {
      const firstParts = (person.first_name || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
      const lastParts = (person.last_name || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
      if (firstParts.length === 0 || lastParts.length === 0) continue;
      // At minimum, first part of first name AND last part of last name must appear
      const firstMatch = firstParts.some((fp: string) => parts.includes(fp));
      const lastMatch = lastParts.some((lp: string) => parts.includes(lp));
      if (firstMatch && lastMatch) {
        await supabase.from("payment_sender_mappings").upsert(
          {
            sender_name: senderName,
            sender_name_normalized: normalized,
            person_id: person.id,
            confidence_score: 0.8,
            match_source: "zelle_email_fuzzy",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "sender_name_normalized" }
        );
        return { person_id: person.id, name: `${person.first_name} ${person.last_name}` };
      }
    }
  }

  // 5. Last-name-only match — if exactly one person has that last name, it's a strong signal
  //    Handles cases like "AGNIESZKA KORDEK" where "kordek" uniquely identifies Ai Kordek
  if (parts.length >= 2) {
    const lastNameCandidates: Array<{ id: string; first_name: string; last_name: string }> = [];
    for (const person of people) {
      const lastParts = (person.last_name || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
      if (lastParts.some((lp: string) => parts.includes(lp))) {
        lastNameCandidates.push(person);
      }
    }
    if (lastNameCandidates.length === 1) {
      const person = lastNameCandidates[0];
      console.log(`Last-name-only match: "${senderName}" → ${person.first_name} ${person.last_name} (unique last name)`);
      await supabase.from("payment_sender_mappings").upsert(
        {
          sender_name: senderName,
          sender_name_normalized: normalized,
          person_id: person.id,
          confidence_score: 0.75,
          match_source: "zelle_email_lastname",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "sender_name_normalized" }
      );
      return { person_id: person.id, name: `${person.first_name} ${person.last_name}` };
    }
  }

  // 6. Gemini Flash AI matching — handles nicknames, legal names, transliterations
  const geminiMatch = await matchByNameWithGemini(supabase, senderName, people);
  if (geminiMatch) {
    // Save mapping so future payments auto-match instantly
    await supabase.from("payment_sender_mappings").upsert(
      {
        sender_name: senderName,
        sender_name_normalized: normalized,
        person_id: geminiMatch.person_id,
        confidence_score: geminiMatch.confidence,
        match_source: "zelle_email_gemini",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "sender_name_normalized" }
    );
    return { person_id: geminiMatch.person_id, name: geminiMatch.name };
  }

  return null;
}

/**
 * Use Gemini Flash to match a Zelle sender name to a person.
 * Handles cases where sender uses legal name vs nickname (e.g., AGNIESZKA KORDEK → Ai Kordek).
 */
async function matchByNameWithGemini(
  supabase: any,
  senderName: string,
  people: Array<{ id: string; first_name: string; last_name: string }>
): Promise<{ person_id: string; name: string; confidence: number } | null> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    console.log("Gemini API key not configured, skipping AI name matching");
    return null;
  }

  // Build list of active tenants with assignments for context
  const { data: activeTenants } = await supabase
    .from("assignments")
    .select(`
      id,
      rate_amount,
      monthly_rent,
      person:person_id (id, first_name, last_name, email)
    `)
    .in("status", ["active", "pending_contract", "contract_sent"]);

  if (!activeTenants || activeTenants.length === 0) {
    console.log("No active tenants for Gemini matching");
    return null;
  }

  const tenantList = activeTenants.map((t: any, idx: number) => {
    const p = t.person;
    return `${idx + 1}. ${p.first_name} ${p.last_name}${p.email ? ` (${p.email})` : ""}`;
  }).join("\n");

  const prompt = `You are matching a Zelle payment sender name to a property tenant.

SENDER NAME: "${senderName}"

ACTIVE TENANTS:
${tenantList}

Match the sender to a tenant considering:
- Legal names vs nicknames (e.g., "AGNIESZKA" could be "Ai", "WILLIAM" could be "Will/Bill", "ROBERT" could be "Bob")
- Maiden/married name differences (same last name = strong signal)
- Transliterations and cultural name variations
- Middle names used instead of first names

Return JSON:
{
  "best_match": <tenant number or null>,
  "confidence": <0.0-1.0>,
  "reasoning": "<brief explanation>"
}

When last names match exactly, return confidence >= 0.80 even if the first name appears to be a nickname or legal name variant (e.g., "AGNIESZKA" → "Ai", "WILLIAM" → "Bill", "ROBERT" → "Bob"). Only return null if there is genuine ambiguity between multiple tenants.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 512,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    if (!response.ok) {
      console.error("Gemini name match API error:", response.status);
      return null;
    }

    const geminiResponse = await response.json();
    const content = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) return null;

    const parsed = JSON.parse(content);
    console.log(`Gemini name match: sender="${senderName}" → match=${parsed.best_match}, confidence=${parsed.confidence}, reasoning="${parsed.reasoning}"`);

    // Log API usage
    const usageMetadata = geminiResponse.usageMetadata;
    const inputTokens = usageMetadata?.promptTokenCount || 0;
    const outputTokens = usageMetadata?.candidatesTokenCount || 0;
    await supabase.from("api_usage_log").insert({
      vendor: "gemini",
      category: "payment_matching",
      endpoint: "generateContent",
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: (inputTokens * 0.10 + outputTokens * 0.40) / 1_000_000,
      metadata: { model: "gemini-2.0-flash", sender_name: senderName, confidence: parsed.confidence, reasoning: parsed.reasoning },
    });

    if (parsed.best_match && parsed.confidence >= 0.75) {
      const matchedTenant = activeTenants[parsed.best_match - 1];
      if (matchedTenant) {
        const person = matchedTenant.person;
        return {
          person_id: person.id,
          name: `${person.first_name} ${person.last_name}`,
          confidence: parsed.confidence,
        };
      }
    }

    return null;
  } catch (err) {
    console.error("Gemini name matching error:", err);
    return null;
  }
}

/**
 * Find an active rental application with unpaid deposits for a person.
 */
async function findDepositApplication(supabase: any, personId: string): Promise<any | null> {
  const { data } = await supabase
    .from("rental_applications")
    .select("*, person:person_id(id, first_name, last_name, email)")
    .eq("person_id", personId)
    .in("deposit_status", ["pending", "requested", "partial"])
    .neq("is_archived", true)
    .neq("is_test", true)
    .order("created_at", { ascending: false })
    .limit(1);

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Auto-record a deposit payment on a rental application.
 * Splits across move-in and security deposits, flags overpayment.
 */
async function autoRecordDeposit(
  supabase: any,
  application: any,
  parsed: ZellePayment,
  resendApiKey: string
): Promise<void> {
  const now = new Date().toISOString();
  const today = now.split("T")[0];
  let remaining = parsed.amount;
  const personName = `${application.person.first_name} ${application.person.last_name}`;

  // Deduplicate: check if this confirmation number was already recorded
  if (parsed.confirmationNumber) {
    const { data: existing } = await supabase
      .from("rental_payments")
      .select("id")
      .eq("transaction_id", parsed.confirmationNumber)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`Duplicate payment detected (conf#${parsed.confirmationNumber}), skipping`);
      await sendPaymentNotification(resendApiKey, "duplicate", {
        parsed,
        personName,
        applicationId: application.id,
      });
      return;
    }
  }

  // Record move-in deposit first
  const moveInUnpaid = !application.move_in_deposit_paid && (application.move_in_deposit_amount || 0) > 0;
  if (moveInUnpaid && remaining > 0) {
    const moveInAmt = application.move_in_deposit_amount;
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
        transaction_id: parsed.confirmationNumber,
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
      description: `Move-in deposit via Zelle (auto-recorded, conf#${parsed.confirmationNumber || "N/A"})`,
      recorded_by: "system:zelle-email",
    });

    remaining -= applyAmt;
    console.log(`Recorded move-in deposit: $${applyAmt} for ${personName}`);
  }

  // Record security deposit
  const securityUnpaid = !application.security_deposit_paid && (application.security_deposit_amount || 0) > 0;
  if (securityUnpaid && remaining > 0) {
    const secAmt = application.security_deposit_amount;
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
        transaction_id: parsed.confirmationNumber,
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
      description: `Security deposit via Zelle (auto-recorded, conf#${parsed.confirmationNumber || "N/A"})`,
      recorded_by: "system:zelle-email",
    });

    remaining -= applyAmt;
    console.log(`Recorded security deposit: $${applyAmt} for ${personName}`);
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

  // Record any overpayment as rent credit
  const overpayment = remaining > 0 ? remaining : 0;
  if (overpayment > 0) {
    const { data: rpData } = await supabase
      .from("rental_payments")
      .insert({
        rental_application_id: application.id,
        payment_type: "rent_credit",
        amount_due: 0,
        amount_paid: overpayment,
        paid_date: today,
        payment_method: "zelle",
        transaction_id: parsed.confirmationNumber,
        notes: `Overpayment credit from $${parsed.amount.toFixed(2)} Zelle payment (deposits totaled $${(parsed.amount - overpayment).toFixed(2)})`,
      })
      .select()
      .single();

    await supabase.from("ledger").insert({
      direction: "income",
      category: "rent",
      amount: overpayment,
      payment_method: "zelle",
      transaction_date: today,
      person_id: application.person_id,
      person_name: personName,
      rental_application_id: application.id,
      rental_payment_id: rpData?.id,
      status: "completed",
      description: `Rent prepayment / overpayment credit via Zelle (auto-recorded, conf#${parsed.confirmationNumber || "N/A"})`,
      recorded_by: "system:zelle-email",
    });

    console.log(`Recorded overpayment credit: $${overpayment.toFixed(2)} for ${personName}`);
  }

  // Build payment summary for receipt email
  const chargeLines: { label: string; amount: number }[] = [];
  if (moveInUnpaid) chargeLines.push({ label: "Move-in Deposit", amount: application.move_in_deposit_amount || 0 });
  if (securityUnpaid) chargeLines.push({ label: "Security Deposit", amount: application.security_deposit_amount || 0 });
  const totalCharges = chargeLines.reduce((sum, l) => sum + l.amount, 0);
  const balance = totalCharges - parsed.amount; // Negative = credit, positive = still owed

  // Send receipt email to the tenant
  if (application.person?.email) {
    await sendTenantReceipt(resendApiKey, {
      tenantEmail: application.person.email,
      tenantName: application.person.first_name,
      paymentAmount: parsed.amount,
      confirmationNumber: parsed.confirmationNumber,
      chargeLines,
      totalCharges,
      balance,
      overpayment,
    });
  }

  // Notify admin
  await sendPaymentNotification(resendApiKey, "auto_recorded", {
    parsed,
    personName,
    applicationId: application.id,
    overpayment,
    moveInRecorded: moveInUnpaid,
    securityRecorded: securityUnpaid,
  });
}

/**
 * Send a payment receipt email to the tenant.
 */
async function sendTenantReceipt(
  resendApiKey: string,
  details: {
    tenantEmail: string;
    tenantName: string;
    paymentAmount: number;
    confirmationNumber: string | null;
    chargeLines: { label: string; amount: number }[];
    totalCharges: number;
    balance: number;
    overpayment: number;
  }
): Promise<void> {
  const chargeRowsHtml = details.chargeLines
    .map(
      (l) =>
        `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;">${l.label}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">$${l.amount.toFixed(2)}</td></tr>`
    )
    .join("");

  const balanceColor = details.balance > 0 ? "#e74c3c" : details.balance < 0 ? "#2d7d46" : "#333";
  const balanceLabel =
    details.balance > 0
      ? `$${details.balance.toFixed(2)} remaining`
      : details.balance < 0
      ? `$${Math.abs(details.balance).toFixed(2)} credit on account`
      : "$0.00 — Paid in full";

  const subject = `Payment Received — $${details.paymentAmount.toFixed(2)}`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#2d7d46;color:white;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;font-size:20px;">&#x2705; Payment Received</h2>
        <p style="margin:8px 0 0;opacity:0.9;">Thank you, ${details.tenantName}!</p>
      </div>
      <div style="border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;padding:24px;">
        <table style="border-collapse:collapse;width:100%;margin-bottom:16px;">
          <tr style="background:#f8f9fa;">
            <td style="padding:10px 12px;font-weight:bold;border-bottom:2px solid #ddd;">Description</td>
            <td style="padding:10px 12px;font-weight:bold;border-bottom:2px solid #ddd;text-align:right;">Amount</td>
          </tr>
          ${chargeRowsHtml}
          <tr style="background:#f8f9fa;">
            <td style="padding:10px 12px;font-weight:bold;border-top:2px solid #ddd;">Total Charges</td>
            <td style="padding:10px 12px;font-weight:bold;border-top:2px solid #ddd;text-align:right;">$${details.totalCharges.toFixed(2)}</td>
          </tr>
        </table>

        <table style="border-collapse:collapse;width:100%;margin-bottom:16px;">
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">Payment Received (Zelle)</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;color:#2d7d46;font-weight:bold;">-$${details.paymentAmount.toFixed(2)}</td>
          </tr>
          ${details.confirmationNumber ? `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#999;font-size:0.85rem;">Confirmation #${details.confirmationNumber}</td><td></td></tr>` : ""}
        </table>

        <div style="background:#f8f9fa;border-radius:6px;padding:14px 16px;text-align:center;">
          <span style="font-size:0.85rem;color:#666;">Balance</span><br/>
          <span style="font-size:1.4rem;font-weight:bold;color:${balanceColor};">${balanceLabel}</span>
        </div>

        <p style="color:#999;font-size:0.8rem;margin-top:20px;text-align:center;">
          YOUR_APP_NAME Residency &bull; This is an automated receipt.
        </p>
      </div>
    </div>
  `;

  try {
    const res = await fetch(`${RESEND_API_URL}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "YOUR_APP_NAME <noreply@YOUR_DOMAIN>",
        to: [details.tenantEmail],
        bcc: ["automation@YOUR_DOMAIN"],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      console.error("Failed to send tenant receipt:", await res.text());
    } else {
      console.log(`Sent payment receipt to ${details.tenantEmail}`);
    }
  } catch (err) {
    console.error("Error sending tenant receipt:", err.message);
  }
}

/**
 * Find applications where outstanding deposit amount matches the payment.
 */
async function matchByAmount(supabase: any, amount: number): Promise<any[]> {
  const { data: apps } = await supabase
    .from("rental_applications")
    .select("*, person:person_id(id, first_name, last_name, email)")
    .in("deposit_status", ["pending", "requested", "partial"])
    .neq("is_archived", true)
    .neq("is_test", true);

  const matches: any[] = [];
  for (const app of apps || []) {
    const moveInDue = !app.move_in_deposit_paid ? (app.move_in_deposit_amount || 0) : 0;
    const securityDue = !app.security_deposit_paid ? (app.security_deposit_amount || 0) : 0;
    const totalDue = moveInDue + securityDue;

    if (
      (totalDue > 0 && Math.abs(amount - totalDue) < 0.01) ||
      (totalDue > 0 && amount > totalDue && amount <= totalDue * 3) ||  // Mild overpayment (up to 3x)
      (moveInDue > 0 && Math.abs(amount - moveInDue) < 0.01) ||
      (securityDue > 0 && Math.abs(amount - securityDue) < 0.01)
    ) {
      matches.push(app);
    }
  }

  return matches;
}

/**
 * Create a confirmation request for Tier 2 (amount match, name mismatch).
 */
async function createConfirmationRequest(
  supabase: any,
  resendApiKey: string,
  parsed: ZellePayment,
  application: any,
  inboundEmailId: string
): Promise<void> {
  const { data: conf } = await supabase
    .from("deposit_payment_confirmations")
    .insert({
      sender_name: parsed.senderName,
      amount: parsed.amount,
      confirmation_number: parsed.confirmationNumber,
      payment_method: "zelle",
      rental_application_id: application.id,
      person_id: application.person_id,
      inbound_email_id: inboundEmailId,
    })
    .select()
    .single();

  if (!conf) {
    console.error("Failed to create confirmation record");
    return;
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const confirmUrl = `${supabaseUrl}/functions/v1/confirm-deposit-payment?token=${conf.token}`;
  const personName = `${application.person.first_name} ${application.person.last_name}`;

  await sendPaymentNotification(resendApiKey, "confirm_request", {
    parsed,
    personName,
    applicationId: application.id,
    confirmUrl,
  });
}

/**
 * Send payment notification emails to admin.
 */
async function sendPaymentNotification(
  resendApiKey: string,
  type: string,
  details: any
): Promise<void> {
  const adminEmail = "team@YOUR_DOMAIN";
  const { parsed, personName, applicationId } = details;
  const adminUrl = `https://YOUR_DOMAIN/spaces/admin/rentals.html#applicant=${applicationId}`;

  let subject = "";
  let html = "";

  if (type === "auto_recorded") {
    const overpayStr = details.overpayment > 0
      ? `<p style="color:#e74c3c;font-weight:bold;">&#x26A0; Overpayment: $${details.overpayment.toFixed(2)} exceeds deposits owed. May need manual handling.</p>`
      : "";
    subject = `Zelle Payment Recorded: $${parsed.amount.toFixed(2)} from ${parsed.senderName}`;
    html = `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;">
        <h2 style="color:#2d7d46;">&#x2705; Payment Auto-Recorded</h2>
        <table style="border-collapse:collapse;width:100%;">
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Amount</td><td style="padding:8px;border-bottom:1px solid #eee;">$${parsed.amount.toFixed(2)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">From</td><td style="padding:8px;border-bottom:1px solid #eee;">${parsed.senderName}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Matched To</td><td style="padding:8px;border-bottom:1px solid #eee;">${personName}</td></tr>
          ${parsed.confirmationNumber ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Confirmation #</td><td style="padding:8px;border-bottom:1px solid #eee;">${parsed.confirmationNumber}</td></tr>` : ""}
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Method</td><td style="padding:8px;border-bottom:1px solid #eee;">Zelle (${parsed.bank})</td></tr>
        </table>
        ${details.moveInRecorded ? "<p>&#x2705; Move-in deposit marked as paid</p>" : ""}
        ${details.securityRecorded ? "<p>&#x2705; Security deposit marked as paid</p>" : ""}
        ${overpayStr}
        <p><a href="${adminUrl}" style="display:inline-block;padding:10px 20px;background:#2d7d46;color:white;text-decoration:none;border-radius:4px;margin-top:10px;">View Application</a></p>
      </div>
    `;
  } else if (type === "confirm_request") {
    subject = `Confirm Zelle Payment: $${parsed.amount.toFixed(2)} from ${parsed.senderName} → ${personName}?`;
    html = `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;">
        <h2 style="color:#e67e22;">&#x1F4B0; Payment Needs Confirmation</h2>
        <p>A Zelle payment was received but the sender name didn't match anyone exactly. However, the <strong>amount matches</strong> an outstanding deposit.</p>
        <table style="border-collapse:collapse;width:100%;">
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Amount</td><td style="padding:8px;border-bottom:1px solid #eee;">$${parsed.amount.toFixed(2)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Zelle Sender</td><td style="padding:8px;border-bottom:1px solid #eee;">${parsed.senderName}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Suggested Match</td><td style="padding:8px;border-bottom:1px solid #eee;">${personName}</td></tr>
          ${parsed.confirmationNumber ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Confirmation #</td><td style="padding:8px;border-bottom:1px solid #eee;">${parsed.confirmationNumber}</td></tr>` : ""}
        </table>
        <p style="margin-top:20px;">
          <a href="${details.confirmUrl}" style="display:inline-block;padding:12px 30px;background:#2d7d46;color:white;text-decoration:none;border-radius:4px;font-size:16px;font-weight:bold;">Confirm Payment</a>
        </p>
        <p style="color:#999;font-size:0.85rem;">This link expires in 7 days. If this is not the right match, you can ignore this email and record it manually in the <a href="${adminUrl}">admin panel</a>.</p>
      </div>
    `;
  } else if (type === "no_match") {
    subject = `Unmatched Zelle Payment: $${parsed.amount.toFixed(2)} from ${parsed.senderName}`;
    html = `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;">
        <h2 style="color:#e74c3c;">&#x2753; Unmatched Payment</h2>
        <p>A Zelle payment was received but could not be matched to any tenant or outstanding deposit.</p>
        <table style="border-collapse:collapse;width:100%;">
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Amount</td><td style="padding:8px;border-bottom:1px solid #eee;">$${parsed.amount.toFixed(2)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Zelle Sender</td><td style="padding:8px;border-bottom:1px solid #eee;">${parsed.senderName}</td></tr>
          ${parsed.confirmationNumber ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Confirmation #</td><td style="padding:8px;border-bottom:1px solid #eee;">${parsed.confirmationNumber}</td></tr>` : ""}
        </table>
        <p>Please record this payment manually in the admin panel.</p>
        ${details.pendingApps ? `<p><strong>Current applications with pending deposits:</strong></p><ul>${details.pendingApps}</ul>` : ""}
      </div>
    `;
  } else if (type === "duplicate") {
    subject = `Duplicate Zelle Payment Detected: $${parsed.amount.toFixed(2)} from ${parsed.senderName}`;
    html = `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;">
        <h2 style="color:#e67e22;">&#x26A0; Duplicate Payment</h2>
        <p>A Zelle payment notification was received but confirmation #${parsed.confirmationNumber} was already recorded. No action taken.</p>
        <p><a href="${adminUrl}">View Application</a></p>
      </div>
    `;
  } else if (type === "auto_recorded_paypal") {
    subject = `PayPal Payment Recorded: $${parsed.amount.toFixed(2)} from ${parsed.senderName}`;
    html = `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;">
        <h2 style="color:#003087;">&#x2705; PayPal Payment Auto-Recorded</h2>
        <table style="border-collapse:collapse;width:100%;">
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Amount</td><td style="padding:8px;border-bottom:1px solid #eee;">$${parsed.amount.toFixed(2)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">From</td><td style="padding:8px;border-bottom:1px solid #eee;">${parsed.senderName}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Matched To</td><td style="padding:8px;border-bottom:1px solid #eee;">${personName}</td></tr>
          ${parsed.confirmationNumber ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Transaction ID</td><td style="padding:8px;border-bottom:1px solid #eee;">${parsed.confirmationNumber}</td></tr>` : ""}
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Method</td><td style="padding:8px;border-bottom:1px solid #eee;">PayPal</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Category</td><td style="padding:8px;border-bottom:1px solid #eee;">${details.category || 'other'}</td></tr>
        </table>
        ${applicationId ? `<p><a href="${adminUrl}" style="display:inline-block;padding:10px 20px;background:#003087;color:white;text-decoration:none;border-radius:4px;margin-top:10px;">View Application</a></p>` : ""}
      </div>
    `;
  } else if (type === "unparseable") {
    subject = "Unrecognized Payment Email";
    html = `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;">
        <h2 style="color:#999;">&#x2709; Unrecognized Payment Email</h2>
        <p>An email was sent to payments@ but could not be parsed as a payment notification (tried Zelle and PayPal patterns). It has been forwarded for manual review.</p>
      </div>
    `;
  }

  if (!subject) return;

  try {
    await fetch(`${RESEND_API_URL}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Property Payments <noreply@YOUR_DOMAIN>",
        to: [adminEmail],
        subject,
        html,
      }),
    });
    console.log(`Payment notification sent: ${type}`);
  } catch (err) {
    console.error("Failed to send payment notification:", err);
  }
}

/**
 * Main handler for payments@ emails.
 * Attempts to parse Zelle (inbound + outbound) and PayPal payment notifications.
 */
async function handlePaymentEmail(
  emailRecord: any,
  supabase: any,
  resendApiKey: string
): Promise<void> {
  const bodyText = emailRecord.body_text || "";
  const fromAddress = emailRecord.from_address || "";

  // 1a. Try to parse as PayPal payment first
  const paypalParsed = parsePayPalPayment(bodyText, fromAddress);
  if (paypalParsed) {
    console.log(`Parsed PayPal payment: $${paypalParsed.amount} from ${paypalParsed.senderName}, txn=${paypalParsed.transactionId}`);
    await handleParsedPayPalPayment(supabase, resendApiKey, paypalParsed, emailRecord);
    return;
  }

  // 1b. Try to parse as outbound Zelle payment (refund/payout sent)
  const outboundParsed = parseOutboundZellePayment(bodyText);
  if (outboundParsed) {
    console.log(`Parsed outbound Zelle payment: $${outboundParsed.amount} to ${outboundParsed.recipientName}, conf#${outboundParsed.confirmationNumber}, memo="${outboundParsed.memo || ""}"`);
    await handleOutboundZellePayment(supabase, resendApiKey, outboundParsed);
    return;
  }

  // 1c. Try to parse as inbound Zelle payment
  const parsed = parseZellePayment(bodyText);
  if (!parsed) {
    console.log("Could not parse payment from email (tried Zelle + PayPal + outbound Zelle), forwarding to admin for review");
    // Forward the unrecognized email to admin for manual classification
    try {
      const subject = emailRecord.subject || "Unknown payment email";
      const snippet = (bodyText || "").substring(0, 500).replace(/\s+/g, " ").trim();
      await fetch(`${RESEND_API_URL}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Property Payments <noreply@YOUR_DOMAIN>",
          to: ["admin@YOUR_DOMAIN"],
          subject: `Unrecognized payment email: ${subject}`,
          html: `
            <div style="font-family:-apple-system,sans-serif;max-width:600px;">
              <h2 style="color:#e67e22;">&#x26A0;&#xFE0F; Unrecognized Payment Email</h2>
              <p>A forwarded email to <strong>payments@YOUR_DOMAIN</strong> could not be automatically classified as Zelle, PayPal, or any known payment format.</p>
              <p><strong>Original subject:</strong> ${subject}</p>
              <p><strong>From:</strong> ${emailRecord.from_address || "unknown"}</p>
              <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
              <p style="font-size:0.85rem;color:#666;"><strong>Body preview:</strong></p>
              <pre style="background:#f8f8f8;padding:12px;border-radius:4px;font-size:0.8rem;white-space:pre-wrap;max-height:300px;overflow:auto;">${snippet}</pre>
              <p style="color:#666;font-size:0.85rem;margin-top:12px;">Please review and manually record in the <a href="https://YOUR_DOMAIN/spaces/admin/accounting.html">accounting dashboard</a> if needed.</p>
            </div>
          `,
        }),
      });
      console.log("Unrecognized payment email forwarded to admin");
    } catch (err) {
      console.error("Failed to forward unrecognized payment email:", err);
    }
    return;
  }

  console.log(`Parsed Zelle payment: $${parsed.amount} from ${parsed.senderName}, conf#${parsed.confirmationNumber}`);

  // 2. Tier 1: Name match
  const nameMatch = await matchByName(supabase, parsed.senderName);

  if (nameMatch) {
    const application = await findDepositApplication(supabase, nameMatch.person_id);
    if (application) {
      console.log(`Tier 1 match: ${parsed.senderName} → ${nameMatch.name}, app=${application.id}`);
      await autoRecordDeposit(supabase, application, parsed, resendApiKey);
      return;
    }
    console.log(`Name matched ${nameMatch.name} but no pending deposit application found`);

    // Fallback: check for active assignment (likely rent payment)
    const { data: assignment } = await supabase
      .from("assignments")
      .select("id, rate_amount")
      .eq("person_id", nameMatch.person_id)
      .in("status", ["active", "pending_contract", "contract_sent"])
      .order("start_date", { ascending: false })
      .limit(1)
      .single();

    const category = assignment ? "rent" : "other";
    await supabase.from("ledger").insert({
      direction: "income",
      category,
      amount: parsed.amount,
      payment_method: "zelle",
      transaction_date: new Date().toISOString().split("T")[0],
      person_id: nameMatch.person_id,
      person_name: nameMatch.name,
      assignment_id: assignment?.id || null,
      confirmation_number: parsed.confirmationNumber || null,
      status: "completed",
      description: `Zelle payment from ${nameMatch.name} (auto-recorded, conf#${parsed.confirmationNumber || "N/A"})`,
      recorded_by: "system:zelle-email",
      is_test: false,
    });

    console.log(`Recorded Zelle payment as ${category}: $${parsed.amount} from ${nameMatch.name}`);
    await sendPaymentNotification(resendApiKey, "auto_recorded", {
      parsed,
      personName: nameMatch.name,
      applicationId: "",
      category,
    });
    return;
  }

  // 3. Tier 2: Amount match
  const amountMatches = await matchByAmount(supabase, parsed.amount);

  if (amountMatches.length === 1) {
    console.log(`Tier 2 match: amount $${parsed.amount} matches ${amountMatches[0].person.first_name} ${amountMatches[0].person.last_name}`);
    await createConfirmationRequest(supabase, resendApiKey, parsed, amountMatches[0], emailRecord.id);
    return;
  }

  if (amountMatches.length > 1) {
    console.log(`Tier 2: multiple amount matches (${amountMatches.length}), falling through to Tier 3`);
  }

  // 4. Tier 3: No match — notify admin
  console.log("Tier 3: no match found, notifying admin");

  // Build list of pending applications for reference
  const { data: pendingApps } = await supabase
    .from("rental_applications")
    .select("id, person:person_id(first_name, last_name), move_in_deposit_amount, security_deposit_amount, deposit_status")
    .in("deposit_status", ["pending", "requested", "partial"])
    .neq("is_archived", true)
    .neq("is_test", true);

  let pendingAppsHtml = "";
  if (pendingApps && pendingApps.length > 0) {
    pendingAppsHtml = pendingApps
      .map((a: any) => {
        const name = `${a.person.first_name} ${a.person.last_name}`;
        const total = (a.move_in_deposit_amount || 0) + (a.security_deposit_amount || 0);
        return `<li>${name} — $${total.toFixed(2)} (${a.deposit_status})</li>`;
      })
      .join("");
  }

  await sendPaymentNotification(resendApiKey, "no_match", {
    parsed,
    personName: "",
    applicationId: "",
    pendingApps: pendingAppsHtml,
  });
}

/**
 * Handle a parsed PayPal payment notification email.
 * Matches sender to person, records in ledger, and optionally
 * reconciles against pending deposit applications.
 */
async function handleParsedPayPalPayment(
  supabase: any,
  resendApiKey: string,
  paypal: PayPalPaymentEmail,
  emailRecord: any
): Promise<void> {
  // Dedup: if we have a transaction ID, check if already recorded
  if (paypal.transactionId) {
    const { data: existing } = await supabase
      .from("ledger")
      .select("id")
      .eq("paypal_transaction_id", paypal.transactionId)
      .single();

    if (existing) {
      console.log(`PayPal transaction ${paypal.transactionId} already recorded, skipping`);
      return;
    }
  }

  // Try to match sender to a person
  const nameMatch = await matchByName(supabase, paypal.senderName);

  if (nameMatch) {
    // Check if there's a pending deposit application
    const application = await findDepositApplication(supabase, nameMatch.person_id);
    if (application) {
      console.log(`PayPal payment matched to deposit application: ${nameMatch.name}, app=${application.id}`);
      // Auto-record as deposit (reuse Zelle deposit recording with PayPal method)
      await autoRecordPayPalDeposit(supabase, application, paypal, nameMatch, resendApiKey);
      return;
    }

    // No deposit application — check for active assignment (likely rent)
    const { data: assignment } = await supabase
      .from("assignments")
      .select("id, rate_amount")
      .eq("person_id", nameMatch.person_id)
      .in("status", ["active", "pending_contract", "contract_sent"])
      .order("start_date", { ascending: false })
      .limit(1)
      .single();

    // Record as rent or general payment
    const category = assignment ? "rent" : "other";

    await supabase.from("ledger").insert({
      direction: "income",
      category,
      amount: paypal.amount,
      payment_method: "paypal",
      transaction_date: new Date().toISOString().split("T")[0],
      person_id: nameMatch.person_id,
      person_name: nameMatch.name,
      assignment_id: assignment?.id || null,
      paypal_transaction_id: paypal.transactionId || null,
      status: "completed",
      description: `PayPal payment from ${nameMatch.name}`,
      notes: paypal.senderEmail ? `PayPal email: ${paypal.senderEmail}` : null,
      recorded_by: "system:paypal-email",
      is_test: false,
    });

    console.log(`Recorded PayPal payment: $${paypal.amount} from ${nameMatch.name} as ${category}`);

    // Notify admin of auto-recorded payment
    await sendPaymentNotification(resendApiKey, "auto_recorded_paypal", {
      parsed: { amount: paypal.amount, senderName: paypal.senderName, confirmationNumber: paypal.transactionId },
      personName: nameMatch.name,
      applicationId: "",
      category,
    });
    return;
  }

  // No name match — try amount matching (same as Zelle Tier 2)
  const amountMatches = await matchByAmount(supabase, paypal.amount);

  if (amountMatches.length === 1) {
    console.log(`PayPal amount match: $${paypal.amount} → ${amountMatches[0].person.first_name} ${amountMatches[0].person.last_name}`);
    // Use same confirmation flow as Zelle
    const zelleEquiv: ZellePayment = {
      amount: paypal.amount,
      senderName: paypal.senderName,
      confirmationNumber: paypal.transactionId,
      bank: "paypal",
    };
    await createConfirmationRequest(supabase, resendApiKey, zelleEquiv, amountMatches[0], emailRecord.id);
    return;
  }

  // No match — notify admin
  console.log("PayPal payment: no match found, notifying admin");
  await sendPaymentNotification(resendApiKey, "no_match", {
    parsed: { amount: paypal.amount, senderName: paypal.senderName, confirmationNumber: paypal.transactionId },
    personName: "",
    applicationId: "",
    pendingApps: "",
  });
}

/**
 * Auto-record a PayPal deposit payment (mirrors autoRecordDeposit for Zelle).
 */
async function autoRecordPayPalDeposit(
  supabase: any,
  application: any,
  paypal: PayPalPaymentEmail,
  nameMatch: { person_id: string; name: string },
  resendApiKey: string
): Promise<void> {
  const moveIn = application.move_in_deposit_amount || 0;
  const security = application.security_deposit_amount || 0;
  const totalDeposit = moveIn + security;
  const today = new Date().toISOString().split("T")[0];

  // Record move-in deposit
  if (moveIn > 0) {
    await supabase.from("rental_payments").insert({
      rental_application_id: application.id,
      payment_type: "move_in_deposit",
      amount: moveIn,
      payment_method: "paypal",
      transaction_date: today,
      transaction_id: paypal.transactionId || null,
      status: "paid",
      recorded_by: "system:paypal-email",
    });

    await supabase.from("ledger").insert({
      direction: "income",
      category: "move_in_deposit",
      amount: moveIn,
      payment_method: "paypal",
      transaction_date: today,
      person_id: nameMatch.person_id,
      person_name: nameMatch.name,
      rental_application_id: application.id,
      paypal_transaction_id: paypal.transactionId || null,
      status: "completed",
      description: `Move-in deposit from ${nameMatch.name} (PayPal)`,
      recorded_by: "system:paypal-email",
    });
  }

  // Record security deposit
  if (security > 0) {
    await supabase.from("rental_payments").insert({
      rental_application_id: application.id,
      payment_type: "security_deposit",
      amount: security,
      payment_method: "paypal",
      transaction_date: today,
      transaction_id: paypal.transactionId || null,
      status: "paid",
      recorded_by: "system:paypal-email",
    });

    await supabase.from("ledger").insert({
      direction: "income",
      category: "security_deposit",
      amount: security,
      payment_method: "paypal",
      transaction_date: today,
      person_id: nameMatch.person_id,
      person_name: nameMatch.name,
      rental_application_id: application.id,
      paypal_transaction_id: paypal.transactionId ? `${paypal.transactionId}-sec` : null,
      status: "completed",
      description: `Security deposit from ${nameMatch.name} (PayPal)`,
      recorded_by: "system:paypal-email",
    });
  }

  // Handle overpayment as rent credit
  if (paypal.amount > totalDeposit && totalDeposit > 0) {
    const overpayment = paypal.amount - totalDeposit;
    await supabase.from("ledger").insert({
      direction: "income",
      category: "rent",
      amount: overpayment,
      payment_method: "paypal",
      transaction_date: today,
      person_id: nameMatch.person_id,
      person_name: nameMatch.name,
      rental_application_id: application.id,
      paypal_transaction_id: paypal.transactionId ? `${paypal.transactionId}-over` : null,
      status: "completed",
      description: `Rent credit from overpayment by ${nameMatch.name} (PayPal)`,
      recorded_by: "system:paypal-email",
    });
  }

  // Update application deposit status
  await supabase
    .from("rental_applications")
    .update({ deposit_status: "paid", deposit_paid_at: new Date().toISOString() })
    .eq("id", application.id);

  // Notify admin
  await sendPaymentNotification(resendApiKey, "auto_recorded_paypal", {
    parsed: { amount: paypal.amount, senderName: paypal.senderName, confirmationNumber: paypal.transactionId },
    personName: nameMatch.name,
    applicationId: application.id,
    category: "deposit",
  });

  console.log(`Auto-recorded PayPal deposit: $${paypal.amount} from ${nameMatch.name} for app ${application.id}`);
}

/**
 * Handle replies to auto@ (bug reports, error digests, etc.)
 *
 * Bug report replies: tries to find the original bug report by subject,
 * then creates a new follow-up bug report referencing the original.
 * The bug fixer worker on DigitalOcean will pick it up.
 */
async function handleAutoReply(
  emailRecord: any,
  supabase: any,
  resendApiKey: string
): Promise<void> {
  const subject = emailRecord.subject || "";
  const body = emailRecord.body_text || emailRecord.body_html || "";
  const from = emailRecord.from_address || "";

  // Ignore emails FROM or TO auto@ or noreply@ (automated system emails looping back)
  const toAddr = emailRecord.to_address || "";
  // Extract email address from "Name <email>" format, normalize to lowercase
  const fromEmail = (from.match(/<(.+)>/)?.[1] || from).toLowerCase().trim();
  const toEmail = (toAddr.match(/<(.+)>/)?.[1] || toAddr).toLowerCase().trim();

  if (fromEmail.includes("auto@YOUR_DOMAIN") || fromEmail.includes("noreply@YOUR_DOMAIN") ||
      toEmail.includes("auto@YOUR_DOMAIN") || toEmail.includes("noreply@YOUR_DOMAIN")) {
    console.log("Ignoring automated email reply loop", { from: fromEmail, to: toEmail });
    return;
  }

  // Additional safety: ignore if body contains automated email template markers
  // Check for nested "YOUR REPORT:" which appears in forwarded/replied automated emails
  if (body && (body.includes("YOUR REPORT:") || body.includes("Your bug report has been automatically"))) {
    console.log("Ignoring automated bug notification email (body template detected)", { subject });
    return;
  }

  // Ignore replies to automated bug fix/update notifications (these are NOT user bug reports)
  // Matches: "Re: Bug by...", "Re: [Follow-up]", "Re: Bug Fixed", "Re: Bug Report Update", "Re: Screenshot of the Fix"
  // Also matches subjects WITHOUT "Re:" (forwards, loops): "Bug Fixed!", "[Follow-up]", "Bug Report Update"
  if (subject.match(/(?:Re:\s*)?(?:Bug by|Bug Fix|Bug Report|Screenshot of the Fix|\[Follow-up\])/i)) {
    console.log("Ignoring automated bug notification or reply", { subject });
    return;
  }

  // Check if this is a reply to a bug report email
  // Bug report subjects look like: "Re: Bug by John: Something is broken..."
  // or "Re: Screenshot of the Fix" etc.
  const bugReplyMatch = subject.match(/Re:\s*(?:Bug by .+?:\s*|Screenshot of the Fix)/i);

  if (bugReplyMatch) {
    console.log("Detected bug report reply, creating follow-up bug report");

    // Try to find the original bug report by matching the subject
    // Extract the original description from "Bug by Name: <description>"
    const descMatch = subject.match(/Bug by .+?:\s*(.+)/i);
    let originalBugId: string | null = null;

    if (descMatch) {
      const originalDesc = descMatch[1].trim();
      // Search for matching bug report
      const { data: matchingBugs } = await supabase
        .from("bug_reports")
        .select("id, page_url")
        .ilike("description", `%${originalDesc.substring(0, 40)}%`)
        .order("created_at", { ascending: false })
        .limit(1);

      if (matchingBugs && matchingBugs.length > 0) {
        originalBugId = matchingBugs[0].id;
        console.log(`Matched to original bug report: ${originalBugId}`);
      }
    }

    // Extract sender name from email "Name <email@domain>" format
    const nameMatch = from.match(/^([^<]+)/);
    const senderName = nameMatch ? nameMatch[1].trim() : from.split("@")[0];
    const senderEmail = from.match(/<(.+)>/)?.[1] || from;

    // Strip email reply chains — try to get just the new message
    let replyBody = body;
    // Remove common reply markers AND automated email content
    const replyMarkers = [
      /YOUR REPORT:/i,  // Strip automated bug report email content
      /On .+ wrote:/i,
      /-----Original Message-----/i,
      /From:.*\nSent:.*\nTo:/i,
      /_{5,}/,
    ];
    for (const marker of replyMarkers) {
      const idx = replyBody.search(marker);
      if (idx > 0) {
        replyBody = replyBody.substring(0, idx).trim();
        break;
      }
    }

    // Create a new follow-up bug report for the worker
    const { error: insertError } = await supabase
      .from("bug_reports")
      .insert({
        description: `[Follow-up${originalBugId ? ` to bug ${originalBugId}` : ""}] ${replyBody.substring(0, 2000)}`,
        reporter_name: senderName,
        reporter_email: senderEmail,
        page_url: originalBugId
          ? (await supabase.from("bug_reports").select("page_url").eq("id", originalBugId).single())?.data?.page_url
          : null,
        status: "pending",
      });

    if (insertError) {
      console.error("Failed to create follow-up bug report:", insertError);
    } else {
      console.log("Follow-up bug report created from email reply");
    }
  } else {
    // Not a bug report reply — forward to admin for manual review
    console.log("Non-bug auto@ email, forwarding to admin");
    await forwardEmail(
      resendApiKey,
      DEFAULT_FORWARD_TO,
      from,
      `[auto@ reply] ${subject}`,
      emailRecord.body_html || "",
      emailRecord.body_text || ""
    );
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type, svix-id, svix-timestamp, svix-signature",
      },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendApiKey = Deno.env.get("RESEND_API_KEY")!;
  const webhookSecret = Deno.env.get("RESEND_WEBHOOK_SECRET")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const rawBody = await req.text();

    // Verify webhook signature
    const svixId = req.headers.get("svix-id") || "";
    const svixTimestamp = req.headers.get("svix-timestamp") || "";
    const svixSignature = req.headers.get("svix-signature") || "";

    if (svixId && svixTimestamp && svixSignature) {
      const isValid = await verifyWebhookSignature(rawBody, svixId, svixTimestamp, svixSignature, webhookSecret);
      if (!isValid) {
        console.error("Invalid webhook signature — rejecting");
        return new Response(JSON.stringify({ error: "Invalid signature" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      console.log("Webhook signature verified");
    } else {
      console.warn("Missing SVIX headers — skipping signature check");
    }

    const webhook = JSON.parse(rawBody);

    // Only process email.received events
    if (webhook.type !== "email.received") {
      console.log("Ignoring event type:", webhook.type);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = webhook.data;
    const emailId = data.email_id;
    const from = data.from || "";
    const toList: string[] = data.to || [];
    const cc: string[] = data.cc || [];
    const subject = data.subject || "(no subject)";
    const attachments = data.attachments || [];

    console.log("Inbound email received:", { emailId, from, to: toList, subject });

    // Fetch full email body from Resend API
    let html = "";
    let text = "";
    const content = await fetchEmailContent(emailId, resendApiKey);
    if (content) {
      html = content.html;
      text = content.text;
    }

    // Load forwarding rules from database
    const forwardingRules = await loadForwardingRules(supabase);

    // ==============================================
    // LOOP GUARD: Reject emails from our own domain to auto@
    // This prevents feedback loops where Bug Scout notifications
    // to auto@ get re-processed as new bug reports endlessly.
    // ==============================================
    const fromLower = from.toLowerCase();
    const fromAddr = (fromLower.match(/<(.+)>/)?.[1] || fromLower).trim();
    if (fromAddr.endsWith("@YOUR_DOMAIN")) {
      const toAutoOrNoreply = toList.some(t => {
        const p = extractPrefix(t);
        return p === "auto" || p === "noreply" || p === "pai" || p === "ai-admin";
      });
      if (toAutoOrNoreply) {
        console.log(`LOOP GUARD: Blocking self-sent email from ${fromAddr} to ${toList.join(",")}, subject: ${subject}`);
        await supabase.from("inbound_emails").insert({
          resend_email_id: emailId,
          from_address: from,
          to_address: toList[0],
          subject,
          route_action: "blocked_loop",
          special_logic_type: "loop_guard",
          raw_payload: data,
        });
        return new Response(JSON.stringify({ ok: true, blocked: "loop_guard" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Process each recipient (there could be multiple to addresses)
    for (const toAddr of toList) {
      const prefix = extractPrefix(toAddr);
      const specialLogic = SPECIAL_PREFIXES[prefix] || null;
      const forwardTargets = forwardingRules[prefix] || (specialLogic ? [] : [DEFAULT_FORWARD_TO]);
      const action = specialLogic ? "special" : "forward";

      console.log(`Routing ${toAddr} (prefix=${prefix}): action=${action}, forward=${forwardTargets.join(",") || "none"}, special=${specialLogic || "none"}`);

      // Store in database
      const { data: record, error: insertError } = await supabase
        .from("inbound_emails")
        .insert({
          resend_email_id: emailId,
          from_address: from,
          to_address: toAddr,
          cc,
          subject,
          body_html: html,
          body_text: text,
          attachments: attachments.length > 0 ? attachments : null,
          route_action: action,
          forwarded_to: forwardTargets.length > 0 ? forwardTargets[0] : null,
          special_logic_type: specialLogic,
          raw_payload: data,
        })
        .select()
        .single();

      if (insertError) {
        console.error("Error storing inbound email:", insertError);
        continue;
      }

      // Forward to all configured targets
      if (forwardTargets.length > 0) {
        let anyForwarded = false;
        for (const target of forwardTargets) {
          const forwarded = await forwardEmail(resendApiKey, target, from, subject, html, text);
          if (forwarded) anyForwarded = true;
        }
        if (anyForwarded) {
          await supabase
            .from("inbound_emails")
            .update({ forwarded_at: new Date().toISOString() })
            .eq("id", record.id);
        }
      }

      // Special logic if applicable
      if (specialLogic) {
        await handleSpecialLogic(specialLogic, record, supabase, resendApiKey);
        await supabase
          .from("inbound_emails")
          .update({ processed_at: new Date().toISOString() })
          .eq("id", record.id);
      }

      // For emails going to DEFAULT_FORWARD_TO (unknown prefixes with no explicit rule),
      // run the universal classifier to enrich the record and potentially reroute
      if (!specialLogic && forwardTargets.length === 1 && forwardTargets[0] === DEFAULT_FORWARD_TO && !forwardingRules[prefix]) {
        try {
          const classification = await classifyEmail(
            subject,
            text || html,
            attachments.length > 0,
            from
          );

          // Store classification metadata
          await supabase
            .from("inbound_emails")
            .update({
              classification: {
                category: classification.category,
                confidence: classification.confidence,
                summary: classification.summary,
                consensus: classification.consensus,
                primary_model: classification.primaryModel,
                secondary_category: classification.secondaryCategory,
                secondary_model: classification.secondaryModel,
              },
              classification_consensus: classification.consensus,
              classification_action: classification.action,
              processed_at: new Date().toISOString(),
            })
            .eq("id", record.id);

          // Log costs
          await logClassificationCost(supabase, classification, record.id, from);

          // If classifier identified spam, mark it and don't forward
          if (classification.action === "drop_spam" && classification.consensus) {
            console.log(`Catch-all email classified as consensus spam, dropping: ${classification.summary}`);
            await supabase
              .from("inbound_emails")
              .update({ route_action: "spam_blocked" })
              .eq("id", record.id);
          }

          console.log(`Catch-all classified: ${classification.category} (${classification.action}), consensus=${classification.consensus}`);
        } catch (classifyErr) {
          console.error("Catch-all classification error:", classifyErr.message);
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Webhook error:", error.message);

    // Return 200 to prevent Resend retries
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});
