/**
 * Dual-Model Email Classifier
 *
 * Classifies inbound emails using TWO independent AI models and requires
 * consensus for high-confidence classification. If models disagree, the
 * email is flagged for human review.
 *
 * Models:
 *   1. Gemini 2.5 Flash (primary) — fast, cheap, good at structured output
 *   2. OpenRouter (secondary) — open-source model for consensus verification
 *
 * Categories:
 *   - spam: Unsolicited marketing, phishing, scams, newsletters
 *   - payment_confirmation: Payment received notifications from banks/services
 *   - receipt: Purchase receipts, invoices, order confirmations
 *   - user_manual: Product manuals, guides, documentation
 *   - guestbook: Guestbook entries, visitor messages
 *   - query: Questions about property, amenities, policies
 *   - complaint: Complaints, negative feedback, issues
 *   - notification: Automated system notifications (shipping, subscriptions, etc.)
 *   - document: Documents sent for reference/storage
 *   - command: Smart home commands (lights, music, thermostat)
 *   - personal: Personal correspondence to a specific person
 *   - other: Anything that doesn't fit above categories
 */


// =============================================
// TYPES
// =============================================

export type EmailCategory =
  | "spam"
  | "payment_confirmation"
  | "receipt"
  | "user_manual"
  | "guestbook"
  | "query"
  | "complaint"
  | "notification"
  | "document"
  | "command"
  | "personal"
  | "other";

export interface ClassificationResult {
  /** Primary classification */
  category: EmailCategory;
  /** Confidence 0-1 */
  confidence: number;
  /** One-line summary */
  summary: string;
  /** Whether both models agreed */
  consensus: boolean;
  /** Model that provided the primary classification */
  primaryModel: string;
  /** Secondary model classification (for logging) */
  secondaryCategory?: EmailCategory;
  secondaryModel?: string;
  /** Recommended action */
  action: EmailAction;
}

export type EmailAction =
  | "forward_admin"      // Forward to admin for manual review
  | "forward_person"     // Forward to a specific person
  | "auto_reply"         // PAI can auto-reply
  | "process_receipt"    // Process as receipt/purchase
  | "process_payment"    // Process as payment confirmation
  | "process_guestbook"  // Add to guestbook
  | "process_document"   // Upload to document storage
  | "process_command"    // Execute smart home command
  | "drop_spam"          // Silently drop
  | "flag_review";       // Needs human review (no consensus)

const VALID_CATEGORIES: EmailCategory[] = [
  "spam", "payment_confirmation", "receipt", "user_manual", "guestbook",
  "query", "complaint", "notification", "document", "command", "personal", "other",
];

/** Map classification to recommended action */
const CATEGORY_ACTIONS: Record<EmailCategory, EmailAction> = {
  spam: "drop_spam",
  payment_confirmation: "process_payment",
  receipt: "process_receipt",
  user_manual: "process_document",
  guestbook: "process_guestbook",
  query: "auto_reply",
  complaint: "forward_admin",
  notification: "forward_admin",
  document: "process_document",
  command: "process_command",
  personal: "forward_person",
  other: "forward_admin",
};

// =============================================
// CLASSIFICATION PROMPT
// =============================================

function buildClassificationPrompt(
  subject: string,
  bodyText: string,
  hasAttachments: boolean,
  fromAddress: string
): string {
  return `You are an email classifier for YOUR_PROPERTY_NAME, a residential co-living property in Your City, Texas.

Classify this email into exactly ONE category:

- "spam" — Unsolicited marketing, phishing, scams, newsletters not signed up for, SEO pitches, link spam, crypto spam, adult content, automated bot messages, cold outreach from vendors/agencies. When in doubt between spam and other, lean toward spam.
- "payment_confirmation" — Notifications that a payment was received (Zelle, Venmo, bank transfer, Stripe). From banks, payment services, or financial institutions confirming money was deposited/received.
- "receipt" — Purchase receipts, invoices, order confirmations from businesses (Amazon, Home Depot, etc.). Keywords: receipt, invoice, order, purchase, total, subtotal.
- "user_manual" — Product manuals, setup guides, care instructions, appliance documentation.
- "guestbook" — Guest messages, visitor feedback, "thank you for having us", "we loved staying here".
- "query" — A real person asking about the property, amenities, policies, availability, move-in, tours, etc.
- "complaint" — Negative feedback, issues with the property, maintenance requests, dissatisfaction.
- "notification" — Automated system notifications: shipping updates, subscription renewals, account alerts, calendar reminders, software alerts. NOT payment confirmations.
- "document" — A real person sending a document (lease, ID, form) for storage/reference.
- "command" — Smart home commands: lights, music, thermostat, locks, speakers.
- "personal" — Personal correspondence addressed to a specific person at the property (not a role/service address).
- "other" — Legitimate email that doesn't fit any above category.

Email details:
- From: ${fromAddress}
- Subject: ${subject}
- Has attachments: ${hasAttachments}
- Body (first 1500 chars): ${bodyText.substring(0, 1500)}

Respond with ONLY a JSON object:
{"category": "one_of_the_categories", "confidence": 0.0-1.0, "summary": "brief one-line summary"}`;
}

// =============================================
// GEMINI CLASSIFIER
// =============================================

interface ModelResult {
  category: EmailCategory;
  confidence: number;
  summary: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
}

async function classifyWithGemini(
  subject: string,
  bodyText: string,
  hasAttachments: boolean,
  fromAddress: string
): Promise<ModelResult | null> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    console.warn("GEMINI_API_KEY not set, skipping Gemini classification");
    return null;
  }

  const prompt = buildClassificationPrompt(subject, bodyText, hasAttachments, fromAddress);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`,
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
      return null;
    }

    const result = await res.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const usage = result.usageMetadata;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      category: VALID_CATEGORIES.includes(parsed.category) ? parsed.category : "other",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      summary: parsed.summary || "",
      model: "gemini-2.5-flash",
      tokensIn: usage?.promptTokenCount,
      tokensOut: usage?.candidatesTokenCount,
    };
  } catch (err) {
    console.error("Gemini classification error:", err.message);
    return null;
  }
}

// =============================================
// OPENROUTER CLASSIFIER
// =============================================

async function classifyWithOpenRouter(
  subject: string,
  bodyText: string,
  hasAttachments: boolean,
  fromAddress: string
): Promise<ModelResult | null> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    console.warn("OPENROUTER_API_KEY not set, skipping OpenRouter classification");
    return null;
  }

  const prompt = buildClassificationPrompt(subject, bodyText, hasAttachments, fromAddress);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://YOUR_DOMAIN",
        "X-Title": "YOUR_APP_NAME Email Classifier",
      },
      body: JSON.stringify({
        model: "meta-llama/llama-4-maverick",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 200,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`OpenRouter classification failed: ${res.status} ${errText}`);
      return null;
    }

    const result = await res.json();
    const text = result.choices?.[0]?.message?.content || "";
    const usage = result.usage;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      category: VALID_CATEGORIES.includes(parsed.category) ? parsed.category : "other",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      summary: parsed.summary || "",
      model: "llama-4-maverick",
      tokensIn: usage?.prompt_tokens,
      tokensOut: usage?.completion_tokens,
    };
  } catch (err) {
    console.error("OpenRouter classification error:", err.message);
    return null;
  }
}

// =============================================
// CONSENSUS LOGIC
// =============================================

/**
 * Classify an email using dual-model consensus.
 *
 * Both models run in parallel. If they agree on the category, we use that
 * classification with high confidence. If they disagree, we flag for human
 * review (action = "flag_review") unless one model has very high confidence.
 */
export async function classifyEmail(
  subject: string,
  bodyText: string,
  hasAttachments: boolean,
  fromAddress: string
): Promise<ClassificationResult> {
  // Run both models in parallel
  const [geminiResult, openRouterResult] = await Promise.all([
    classifyWithGemini(subject, bodyText, hasAttachments, fromAddress),
    classifyWithOpenRouter(subject, bodyText, hasAttachments, fromAddress),
  ]);

  // If both models failed, use heuristic fallback
  if (!geminiResult && !openRouterResult) {
    console.warn("Both classification models failed, using heuristic fallback");
    return heuristicClassify(subject, bodyText, hasAttachments, fromAddress);
  }

  // If only one model succeeded, use it but with reduced confidence
  if (!geminiResult || !openRouterResult) {
    const result = geminiResult || openRouterResult!;
    return {
      category: result.category,
      confidence: result.confidence * 0.8, // Reduced confidence without consensus
      summary: result.summary,
      consensus: false,
      primaryModel: result.model,
      action: CATEGORY_ACTIONS[result.category],
    };
  }

  // Both models succeeded — check consensus
  const agree = geminiResult.category === openRouterResult.category;

  if (agree) {
    // Consensus: use the classification with boosted confidence
    const avgConfidence = (geminiResult.confidence + openRouterResult.confidence) / 2;
    return {
      category: geminiResult.category,
      confidence: Math.min(avgConfidence * 1.1, 1.0), // Small boost for agreement
      summary: geminiResult.summary,
      consensus: true,
      primaryModel: geminiResult.model,
      secondaryCategory: openRouterResult.category,
      secondaryModel: openRouterResult.model,
      action: CATEGORY_ACTIONS[geminiResult.category],
    };
  }

  // Disagreement: use the model with higher confidence, but flag for review
  // unless the primary model has very high confidence (>0.9)
  const primary = geminiResult.confidence >= openRouterResult.confidence
    ? geminiResult
    : openRouterResult;
  const secondary = primary === geminiResult ? openRouterResult : geminiResult;

  // If primary confidence is very high and secondary agrees on at least the action type,
  // don't force a review
  const primaryAction = CATEGORY_ACTIONS[primary.category];
  const secondaryAction = CATEGORY_ACTIONS[secondary.category];
  const actionsCompatible = primaryAction === secondaryAction;

  if (primary.confidence >= 0.9 || actionsCompatible) {
    return {
      category: primary.category,
      confidence: primary.confidence * 0.9, // Slight penalty for disagreement
      summary: primary.summary,
      consensus: false,
      primaryModel: primary.model,
      secondaryCategory: secondary.category,
      secondaryModel: secondary.model,
      action: primaryAction,
    };
  }

  // Real disagreement with low confidence — flag for human review
  return {
    category: primary.category,
    confidence: primary.confidence * 0.7,
    summary: `[DISPUTED] ${primary.model}: ${primary.category} (${primary.confidence.toFixed(2)}) vs ${secondary.model}: ${secondary.category} (${secondary.confidence.toFixed(2)})`,
    consensus: false,
    primaryModel: primary.model,
    secondaryCategory: secondary.category,
    secondaryModel: secondary.model,
    action: "flag_review",
  };
}

// =============================================
// HEURISTIC FALLBACK
// =============================================

function heuristicClassify(
  subject: string,
  bodyText: string,
  hasAttachments: boolean,
  fromAddress: string
): ClassificationResult {
  const combined = `${subject} ${bodyText}`.toLowerCase();

  // Check for payment confirmations
  if (
    combined.includes("zelle") ||
    combined.includes("payment received") ||
    combined.includes("deposited") ||
    combined.includes("venmo")
  ) {
    return {
      category: "payment_confirmation",
      confidence: 0.6,
      summary: "Heuristic: payment keywords detected",
      consensus: false,
      primaryModel: "heuristic",
      action: "process_payment",
    };
  }

  // Check for receipts
  if (
    combined.includes("receipt") ||
    combined.includes("invoice") ||
    combined.includes("order confirmation") ||
    combined.includes("your order")
  ) {
    return {
      category: "receipt",
      confidence: 0.6,
      summary: "Heuristic: receipt keywords detected",
      consensus: false,
      primaryModel: "heuristic",
      action: "process_receipt",
    };
  }

  // Check for questions
  if (combined.includes("?") || combined.includes("how do") || combined.includes("can i")) {
    return {
      category: "query",
      confidence: 0.5,
      summary: "Heuristic: question mark or question phrases detected",
      consensus: false,
      primaryModel: "heuristic",
      action: "auto_reply",
    };
  }

  // Default: forward to admin
  return {
    category: "other",
    confidence: 0.3,
    summary: "Heuristic fallback: no clear category",
    consensus: false,
    primaryModel: "heuristic",
    action: "forward_admin",
  };
}

// =============================================
// REPLY METADATA EXTRACTION
// =============================================

/**
 * Metadata embedded in outbound emails by send-email function.
 * Extracted from `<!--[ALPACAPPS_META:{...}:ALPACAPPS_META]-->` comments.
 */
export interface OutboundEmailMeta {
  /** Unique email ID */
  eid: string;
  /** Email template type (e.g. "payment_reminder", "lease_signed") */
  type: string;
  /** Original recipients */
  to: string[];
  /** Sender address */
  from: string;
  /** Reply-to address */
  reply_to?: string;
  /** Timestamp of original send */
  ts: string;
  /** Space name if applicable */
  space?: string;
  /** Person ID if applicable */
  pid?: string;
  /** Assignment ID if applicable */
  aid?: string;
}

/**
 * Extract YOUR_APP_NAME metadata from an email body (HTML).
 * Returns null if no metadata found (not a reply to our email).
 */
export function extractReplyMetadata(htmlBody: string): OutboundEmailMeta | null {
  const match = htmlBody.match(/<!--\[ALPACAPPS_META:(.*?):ALPACAPPS_META\]-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as OutboundEmailMeta;
  } catch {
    return null;
  }
}

/**
 * Check if an email is a reply to one of our outbound emails.
 * Checks both the HTML body for metadata and the subject for "Re:" patterns.
 */
export function isReplyToOurEmail(
  subject: string,
  htmlBody: string
): { isReply: boolean; meta: OutboundEmailMeta | null } {
  const meta = extractReplyMetadata(htmlBody);
  if (meta) return { isReply: true, meta };

  // Fallback: check subject for "Re:" pattern matching our known subjects
  const isSubjectReply = /^re:\s/i.test(subject);
  return { isReply: isSubjectReply, meta: null };
}

// =============================================
// COST TRACKING
// =============================================

/**
 * Log classification costs to api_usage_log.
 */
export async function logClassificationCost(
  supabase: any,
  result: ClassificationResult,
  emailId: string,
  fromAddress: string,
  geminiResult?: ModelResult | null,
  openRouterResult?: ModelResult | null
): Promise<void> {
  const logs: any[] = [];

  if (geminiResult) {
    logs.push({
      vendor: "gemini",
      category: "email_classification",
      endpoint: "generateContent",
      units: 1,
      unit_type: "api_calls",
      estimated_cost_usd: 0.00015, // ~200 input tokens + ~50 output on 2.5 Flash
      metadata: {
        model: geminiResult.model,
        email_from: fromAddress,
        classification: geminiResult.category,
        confidence: geminiResult.confidence,
        tokens_in: geminiResult.tokensIn,
        tokens_out: geminiResult.tokensOut,
        inbound_email_id: emailId,
      },
    });
  }

  if (openRouterResult) {
    logs.push({
      vendor: "openrouter",
      category: "email_classification",
      endpoint: "chat/completions",
      units: 1,
      unit_type: "api_calls",
      estimated_cost_usd: 0.0002, // Llama 4 Maverick is ~$0.20/M tokens
      metadata: {
        model: openRouterResult.model,
        email_from: fromAddress,
        classification: openRouterResult.category,
        confidence: openRouterResult.confidence,
        tokens_in: openRouterResult.tokensIn,
        tokens_out: openRouterResult.tokensOut,
        inbound_email_id: emailId,
        consensus: result.consensus,
      },
    });
  }

  if (logs.length > 0) {
    await supabase.from("api_usage_log").insert(logs);
  }
}
