/**
 * Error Report Edge Function
 *
 * Receives client-side error reports and:
 * 1. Stores them in the error_logs database for analysis
 * 2. Auto-creates bug_reports for actionable errors (with risk evaluation)
 * 3. Sends a daily digest email when triggered
 *
 * Risk levels:
 *   low    → Bug Scout auto-fixes (status='pending')
 *   medium → Bug Scout auto-fixes (status='pending') — but may touch more code
 *   high   → Requires admin approval (status='needs_approval')
 *
 * Deploy with: supabase functions deploy error-report
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Email configuration
const ADMIN_EMAIL = Deno.env.get('ADMIN_EMAIL') || 'automation@YOUR_DOMAIN';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const FROM_EMAIL = 'Property Automaton Errors <auto@YOUR_DOMAIN>';

// =============================================
// RISK EVALUATION CONFIG
// =============================================

// Errors that should NOT auto-create bug reports (noise, expected, transient)
const IGNORED_ERROR_CODES = [
  'ABORTED',           // User cancelled
  'TUS_UNAVAILABLE',   // Expected fallback
  'NETWORK_ERROR',     // Transient connectivity
  'TIMEOUT',           // Transient timeout
  'AUTH_SESSION_MISSING', // User not logged in (expected on public pages)
];

// Error categories that are never actionable as bugs
const IGNORED_CATEGORIES = [
  'info',  // Info-level logs are not bugs
];

// Pages/paths involving sensitive systems — high risk
const HIGH_RISK_PATHS = [
  '/spaces/admin/settings',   // System settings
  '/spaces/admin/users',      // User management
  '/spaces/admin/accounting', // Financial data
  '/associates/',             // Associate payments/hours
];

// Edge function / API error patterns — high risk (server-side issue)
const HIGH_RISK_CODES = [
  'EDGE_FUNCTION_ERROR',    // Server-side edge function failure
  'PAYMENT_ERROR',          // Payment processing failure
  'AUTH_ERROR',             // Authentication system failure
  'SIGNWELL_ERROR',         // E-signature failure
  'PAYOUT_ERROR',           // PayPal payout failure
];

// Codes that indicate UI/display bugs — low risk, safe to auto-fix
const LOW_RISK_CODES = [
  'UNCAUGHT_ERROR',         // JS runtime error in UI
  'UNHANDLED_REJECTION',    // Promise rejection in UI
  'RENDER_ERROR',           // UI rendering failure
  'LOAD_ERROR',             // Resource load failure
  'DOM_ERROR',              // DOM manipulation error
];

// =============================================
// INTERFACES
// =============================================

interface ErrorEntry {
  id: string;
  category: string;
  code: string;
  message: string;
  details: Record<string, unknown>;
  severity: 'critical' | 'error' | 'warning' | 'info';
  environment: {
    userAgent: string;
    url: string;
    timestamp: string;
    sessionId: string;
    [key: string]: unknown;
  };
  user: Record<string, unknown>;
  stack?: string;
}

interface ErrorReport {
  errors: ErrorEntry[];
  summary: {
    count: number;
    categories?: string[];
    severities?: Record<string, number>;
    isUnloadFlush?: boolean;
  };
}

// =============================================
// RISK EVALUATION
// =============================================

interface RiskAssessment {
  level: 'low' | 'medium' | 'high';
  reasons: string[];
}

function evaluateRisk(error: ErrorEntry): RiskAssessment {
  const reasons: string[] = [];
  let level: 'low' | 'medium' | 'high' = 'low';

  const pageUrl = error.environment?.url || '';
  const pagePath = new URL(pageUrl, 'https://YOUR_DOMAIN').pathname;

  // Check high-risk paths
  if (HIGH_RISK_PATHS.some(p => pagePath.startsWith(p))) {
    level = 'high';
    reasons.push(`Sensitive page: ${pagePath}`);
  }

  // Check high-risk error codes
  if (HIGH_RISK_CODES.includes(error.code)) {
    level = 'high';
    reasons.push(`High-risk error code: ${error.code}`);
  }

  // Critical severity bumps to at least medium
  if (error.severity === 'critical' && level === 'low') {
    level = 'medium';
    reasons.push('Critical severity');
  }

  // Edge function errors (detected by message pattern) are high risk
  if (error.message?.includes('edge function') || error.message?.includes('Edge Function')) {
    level = 'high';
    reasons.push('Edge function failure — may need server-side fix');
  }

  // Supabase/database errors are high risk
  if (error.message?.includes('supabase') || error.code?.includes('DB_') || error.code?.includes('SUPABASE_')) {
    level = 'high';
    reasons.push('Database/Supabase error — may need schema or RLS fix');
  }

  // Low-risk codes stay low (unless overridden above)
  if (LOW_RISK_CODES.includes(error.code) && level === 'low') {
    reasons.push(`UI error code: ${error.code} — safe for auto-fix`);
  }

  // If no specific reasons were found, default reasoning
  if (reasons.length === 0) {
    reasons.push('Standard client-side error');
  }

  return { level, reasons };
}

function shouldCreateBugReport(error: ErrorEntry): boolean {
  // Only create bugs for error and critical severity
  if (error.severity === 'info' || error.severity === 'warning') {
    return false;
  }

  // Skip ignored error codes
  if (IGNORED_ERROR_CODES.includes(error.code)) {
    return false;
  }

  // Skip ignored categories
  if (IGNORED_CATEGORIES.includes(error.category)) {
    return false;
  }

  // Must have a page URL so Bug Scout knows where to look
  if (!error.environment?.url) {
    return false;
  }

  return true;
}

/**
 * Generate a dedup signature for an error.
 * Same category + code + page path = same bug.
 */
function getErrorSignature(error: ErrorEntry): string {
  const pageUrl = error.environment?.url || '';
  let pagePath = '';
  try {
    pagePath = new URL(pageUrl, 'https://YOUR_DOMAIN').pathname;
  } catch {
    pagePath = pageUrl;
  }
  return `${error.category}:${error.code}:${pagePath}`;
}

// =============================================
// HANDLERS
// =============================================

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // Check if this is a digest request
    if (body.action === 'send_digest') {
      return await handleDigestRequest();
    }

    // Otherwise handle as error report
    return await handleErrorReport(body as ErrorReport);
  } catch (err) {
    console.error('Error processing request:', err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

async function handleErrorReport(report: ErrorReport) {
  const { errors, summary } = report;

  if (!errors || errors.length === 0) {
    return new Response(
      JSON.stringify({ success: true, message: 'No errors to process' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log(`Processing ${errors.length} errors`);

  // Initialize Supabase client
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Store errors in database
  const errorRecords = errors.map((e) => ({
    error_id: e.id,
    category: e.category,
    code: e.code,
    message: e.message,
    severity: e.severity,
    details: e.details,
    environment: e.environment,
    user_context: e.user,
    stack_trace: e.stack,
    session_id: e.environment?.sessionId,
    page_url: e.environment?.url,
    user_agent: e.environment?.userAgent,
    created_at: e.environment?.timestamp || new Date().toISOString(),
  }));

  const { error: insertError } = await supabase
    .from('error_logs')
    .insert(errorRecords);

  if (insertError) {
    console.error('Failed to store errors:', insertError);
  } else {
    console.log(`Stored ${errors.length} errors in database`);
  }

  // =============================================
  // AUTO-CREATE BUG REPORTS
  // =============================================

  let bugsCreated = 0;
  let bugsUpdated = 0;

  // Deduplicate errors in this batch by signature
  const uniqueErrors = new Map<string, ErrorEntry>();
  for (const error of errors) {
    if (shouldCreateBugReport(error)) {
      const sig = getErrorSignature(error);
      // Keep the first occurrence per signature in this batch
      if (!uniqueErrors.has(sig)) {
        uniqueErrors.set(sig, error);
      }
    }
  }

  for (const [signature, error] of uniqueErrors) {
    try {
      // Check if a bug report already exists for this error signature
      const { data: existingBug } = await supabase
        .from('bug_reports')
        .select('id, status, error_count')
        .eq('source_error_signature', signature)
        .eq('source', 'auto_error')
        .in('status', ['pending', 'processing', 'needs_approval'])
        .single();

      if (existingBug) {
        // Increment error count on existing unfixed bug (shows it's recurring)
        await supabase
          .from('bug_reports')
          .update({ error_count: (existingBug.error_count || 1) + 1 })
          .eq('id', existingBug.id);
        bugsUpdated++;
        console.log(`Updated existing bug ${existingBug.id} for signature ${signature} (count: ${(existingBug.error_count || 1) + 1})`);
        continue;
      }

      // Also skip if this error was already fixed recently (within 24h)
      // This prevents re-filing a bug that was just fixed
      const { data: recentlyFixed } = await supabase
        .from('bug_reports')
        .select('id')
        .eq('source_error_signature', signature)
        .eq('source', 'auto_error')
        .eq('status', 'fixed')
        .gte('processed_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(1);

      if (recentlyFixed && recentlyFixed.length > 0) {
        console.log(`Skipping bug creation for ${signature} — recently fixed`);
        continue;
      }

      // Evaluate risk
      const risk = evaluateRisk(error);
      const isHighRisk = risk.level === 'high';

      // Build bug report description
      const pageUrl = error.environment?.url || 'Unknown page';
      const description = [
        `**Auto-detected error** (${error.severity})`,
        '',
        `**Error:** ${error.code} — ${error.message}`,
        '',
        `**Page:** ${pageUrl}`,
        error.stack ? `\n**Stack:**\n\`\`\`\n${error.stack}\n\`\`\`` : '',
        error.details ? `\n**Details:** ${JSON.stringify(error.details).substring(0, 500)}` : '',
        '',
        `**Risk:** ${risk.level} — ${risk.reasons.join('; ')}`,
      ].filter(Boolean).join('\n');

      // Create the bug report
      const bugStatus = isHighRisk ? 'needs_approval' : 'pending';
      const { error: bugError } = await supabase
        .from('bug_reports')
        .insert({
          reporter_name: 'Property Error Monitor',
          reporter_email: 'automation@YOUR_DOMAIN',
          description,
          page_url: pageUrl,
          error_message: `${error.code}: ${error.message}`.substring(0, 500),
          status: bugStatus,
          source: 'auto_error',
          source_error_signature: signature,
          error_count: 1,
          risk_level: risk.level,
          auto_fix_approved: isHighRisk ? null : true,
          user_agent: error.environment?.userAgent,
          browser_name: error.user?.browser || null,
          viewport_size: error.environment?.viewportSize || null,
        });

      if (bugError) {
        console.error(`Failed to create bug report for ${signature}:`, bugError);
      } else {
        bugsCreated++;
        console.log(`Created ${bugStatus} bug report for ${signature} (risk: ${risk.level})`);
      }
    } catch (err) {
      console.error(`Error processing bug report for ${signature}:`, err);
    }
  }

  console.log(`Bug reports: ${bugsCreated} created, ${bugsUpdated} updated`);

  return new Response(
    JSON.stringify({
      success: true,
      stored: errors.length,
      bugs_created: bugsCreated,
      bugs_updated: bugsUpdated,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

async function handleDigestRequest() {
  console.log('Processing daily digest request');

  // Initialize Supabase client
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Check when we last sent a digest
  const { data: lastDigest } = await supabase
    .from('error_digest_log')
    .select('sent_at')
    .order('sent_at', { ascending: false })
    .limit(1)
    .single();

  const lastSentAt = lastDigest?.sent_at ? new Date(lastDigest.sent_at) : null;
  const now = new Date();

  // Only send once per day (24 hours)
  if (lastSentAt && (now.getTime() - lastSentAt.getTime()) < 24 * 60 * 60 * 1000) {
    console.log('Digest already sent within last 24 hours, skipping');
    return new Response(
      JSON.stringify({ success: true, skipped: true, reason: 'Already sent today' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Get errors since last digest (or last 24 hours if no previous digest)
  const sinceDate = lastSentAt || new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const { data: errors, error: fetchError } = await supabase
    .from('error_logs')
    .select('*')
    .gte('created_at', sinceDate.toISOString())
    .order('created_at', { ascending: false });

  if (fetchError) {
    console.error('Failed to fetch errors:', fetchError);
    return new Response(
      JSON.stringify({ success: false, error: 'Failed to fetch errors' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Also check for pending approval bugs
  const { data: pendingApproval } = await supabase
    .from('bug_reports')
    .select('id, description, risk_level, error_count, page_url')
    .eq('status', 'needs_approval')
    .eq('source', 'auto_error');

  if (!errors || errors.length === 0) {
    console.log('No errors to report');

    // Still log that we checked
    await supabase.from('error_digest_log').insert({
      sent_at: now.toISOString(),
      error_count: 0,
      email_sent: false,
    });

    // But still send email if there are pending approvals
    if (!pendingApproval || pendingApproval.length === 0) {
      return new Response(
        JSON.stringify({ success: true, errorCount: 0, emailSent: false }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  const errorCount = errors?.length || 0;

  // Group errors by category and code
  const grouped = (errors || []).reduce((acc, e) => {
    const key = `${e.category}:${e.code}`;
    if (!acc[key]) {
      acc[key] = { count: 0, message: e.message, severity: e.severity, examples: [] };
    }
    acc[key].count++;
    if (acc[key].examples.length < 3) {
      acc[key].examples.push({
        url: e.page_url,
        timestamp: e.created_at,
        details: e.details,
      });
    }
    return acc;
  }, {} as Record<string, { count: number; message: string; severity: string; examples: any[] }>);

  // Count by severity
  const severityCounts = (errors || []).reduce((acc, e) => {
    acc[e.severity] = (acc[e.severity] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Build email content
  const errorList = Object.entries(grouped)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key, val]) => {
      const exampleList = val.examples
        .map(ex => `    - ${ex.url} (${new Date(ex.timestamp).toLocaleString()})`)
        .join('\n');
      return `[${val.severity.toUpperCase()}] ${key}: ${val.message}
  Count: ${val.count}
  Examples:
${exampleList}`;
    })
    .join('\n\n');

  // Build pending approval section
  let approvalSection = '';
  if (pendingApproval && pendingApproval.length > 0) {
    const approvalList = pendingApproval.map(bug =>
      `  - [${bug.risk_level?.toUpperCase()}] ${bug.page_url} (seen ${bug.error_count}x)\n    ${bug.description?.split('\n')[2] || 'No details'}`
    ).join('\n');
    approvalSection = `
HIGH-RISK BUGS AWAITING APPROVAL (${pendingApproval.length}):
----------------------------------------------
${approvalList}

To approve: Update bug_reports.status from 'needs_approval' to 'pending' in Supabase.
To reject: Update bug_reports.status to 'skipped'.
`;
  }

  const emailBody = `
YOUR_APP_NAME Daily Error Digest
============================
Period: ${sinceDate.toLocaleString()} to ${now.toLocaleString()}
Total Errors: ${errorCount}

Severity Breakdown:
- Critical: ${severityCounts.critical || 0}
- Error: ${severityCounts.error || 0}
- Warning: ${severityCounts.warning || 0}
- Info: ${severityCounts.info || 0}
${approvalSection}
Error Details:
--------------
${errorList || '(no errors)'}

---
View the error_logs table in Supabase for full details.
  `.trim();

  let emailSent = false;

  if (RESEND_API_KEY) {
    try {
      const subject = pendingApproval && pendingApproval.length > 0
        ? `[YOUR_APP_NAME] Error Digest: ${errorCount} error(s), ${pendingApproval.length} awaiting approval`
        : `[YOUR_APP_NAME] Daily Error Digest: ${errorCount} error(s)`;

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: ADMIN_EMAIL,
          subject,
          text: emailBody,
        }),
      });

      if (response.ok) {
        emailSent = true;
        console.log('Digest email sent successfully');
      } else {
        const errorText = await response.text();
        console.error('Failed to send email:', errorText);
      }
    } catch (err) {
      console.error('Email send error:', err);
    }
  } else {
    console.log('RESEND_API_KEY not configured, skipping email');
  }

  // Log that we sent (or attempted to send) digest
  await supabase.from('error_digest_log').insert({
    sent_at: now.toISOString(),
    error_count: errorCount,
    email_sent: emailSent,
  });

  return new Response(
    JSON.stringify({
      success: true,
      errorCount,
      emailSent,
      pendingApproval: pendingApproval?.length || 0,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}
