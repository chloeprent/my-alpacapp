/**
 * Generate 1099-NEC Data Edge Function
 *
 * Admin-only endpoint that generates a CSV export of 1099-NEC data
 * for a given tax year. Decrypts TINs server-side for the export.
 *
 * Deploy with: supabase functions deploy generate-1099-data
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Decrypt a TIN using AES-256-GCM
 */
async function decryptTIN(encrypted: string, iv: string, hexKey: string): Promise<string> {
  const keyBytes = new Uint8Array(hexKey.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']
  );

  const ivBytes = Uint8Array.from(atob(iv), c => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes }, cryptoKey, ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Format a TIN for display: SSN as XXX-XX-XXXX, EIN as XX-XXXXXXX
 */
function formatTIN(digits: string, type: string): string {
  if (type === 'ssn') {
    return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  }
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const encryptionKey = Deno.env.get('W9_ENCRYPTION_KEY');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    if (!encryptionKey) {
      throw new Error('W9_ENCRYPTION_KEY not configured');
    }

    // ── Verify admin role via JWT ───────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: 'Authorization required' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid authentication' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check admin role
    const { data: appUser } = await supabase
      .from('app_users')
      .select('role')
      .eq('auth_user_id', user.id)
      .single();

    if (!appUser || !['admin', 'staff'].includes(appUser.role)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Admin access required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Parse request ───────────────────────────────────────────
    const body = await req.json();
    const taxYear = body.tax_year;

    if (!taxYear || typeof taxYear !== 'number' || taxYear < 2020 || taxYear > 2099) {
      return new Response(
        JSON.stringify({ success: false, error: 'Valid tax_year required (2020-2099)' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const dateFrom = `${taxYear}-01-01`;
    const dateTo = `${taxYear}-12-31`;

    console.log(`Generating 1099 data for tax year ${taxYear}`);

    // ── Query completed payouts for the tax year ────────────────
    const { data: payouts, error: payoutsError } = await supabase
      .from('payouts')
      .select('associate_id, amount, person_name, created_at')
      .eq('status', 'completed')
      .eq('is_test', false)
      .gte('created_at', `${dateFrom}T00:00:00Z`)
      .lte('created_at', `${dateTo}T23:59:59Z`);

    if (payoutsError) {
      console.error('Error querying payouts:', payoutsError);
      throw new Error('Failed to query payout data');
    }

    // Also query ledger for any manual payments
    const { data: ledgerEntries } = await supabase
      .from('ledger')
      .select('person_id, person_name, amount, payment_method')
      .eq('category', 'associate_payment')
      .eq('status', 'completed')
      .eq('is_test', false)
      .gte('transaction_date', dateFrom)
      .lte('transaction_date', dateTo);

    // ── Group by associate ──────────────────────────────────────
    const byAssociate: Record<string, { name: string; total: number; paymentMethod: string }> = {};

    for (const p of (payouts || [])) {
      const key = p.associate_id || 'unknown';
      if (!byAssociate[key]) {
        byAssociate[key] = { name: p.person_name || 'Unknown', total: 0, paymentMethod: 'paypal' };
      }
      byAssociate[key].total += parseFloat(p.amount) || 0;
    }

    // Merge ledger entries (avoid double-counting if linked to payouts)
    // Ledger entries may be redundant with payouts, but catches manual entries
    // For now, we rely on the payouts table as primary source

    // ── Get associate profiles + W-9 data ───────────────────────
    const associateIds = Object.keys(byAssociate).filter(k => k !== 'unknown');

    const { data: profiles } = await supabase
      .from('associate_profiles')
      .select('id, app_user_id, w9_status, w9_submission_id')
      .in('id', associateIds);

    const profileMap: Record<string, any> = {};
    for (const p of (profiles || [])) {
      profileMap[p.id] = p;
    }

    // Get W-9 submissions for those with w9_submission_id
    const w9Ids = (profiles || [])
      .filter(p => p.w9_submission_id)
      .map(p => p.w9_submission_id);

    let w9Map: Record<string, any> = {};
    if (w9Ids.length > 0) {
      const { data: w9s } = await supabase
        .from('w9_submissions')
        .select('*')
        .in('id', w9Ids);

      for (const w of (w9s || [])) {
        w9Map[w.id] = w;
      }
    }

    // ── Build CSV rows ──────────────────────────────────────────
    const csvHeaders = [
      'Legal Name', 'Business Name', 'TIN Type', 'TIN',
      'Address', 'City', 'State', 'ZIP',
      'Total Paid', '1099 Required', 'Payment Method', 'Notes',
    ];

    const csvRows: string[][] = [];

    for (const [assocId, data] of Object.entries(byAssociate)) {
      const profile = profileMap[assocId];
      const w9 = profile?.w9_submission_id ? w9Map[profile.w9_submission_id] : null;

      let tin = '';
      if (w9) {
        try {
          const decrypted = await decryptTIN(w9.tin_encrypted, w9.tin_iv, encryptionKey);
          tin = formatTIN(decrypted, w9.tin_type);
        } catch (e) {
          console.error(`Failed to decrypt TIN for associate ${assocId}:`, e);
          tin = `ERROR (last4: ${w9.tin_last_four})`;
        }
      }

      const needs1099 = data.total >= 600;
      const paypalNote = data.paymentMethod === 'paypal'
        ? 'PayPal may report via 1099-K'
        : '';

      csvRows.push([
        w9?.legal_name || data.name,
        w9?.business_name || '',
        w9 ? w9.tin_type.toUpperCase() : 'N/A',
        tin || 'W-9 NOT ON FILE',
        w9?.address_street || '',
        w9?.address_city || '',
        w9?.address_state || '',
        w9?.address_zip || '',
        data.total.toFixed(2),
        needs1099 ? 'YES' : 'NO',
        data.paymentMethod,
        paypalNote,
      ]);
    }

    // Sort by total paid descending
    csvRows.sort((a, b) => parseFloat(b[8]) - parseFloat(a[8]));

    // ── Generate CSV string ─────────────────────────────────────
    const escapeCSV = (val: string) => {
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    let csv = `# 1099-NEC Data Export - Tax Year ${taxYear}\n`;
    csv += `# Generated: ${new Date().toISOString()}\n`;
    csv += `# IMPORTANT: PayPal issues 1099-K for payments >$600 processed through their platform.\n`;
    csv += `# Since all payouts go through PayPal, these may already be reported to the IRS.\n`;
    csv += `# W-9 collection is still required for any $600+ contractor payments.\n`;
    csv += `# This file contains sensitive tax data (SSN/EIN). Handle securely.\n\n`;
    csv += csvHeaders.map(escapeCSV).join(',') + '\n';
    for (const row of csvRows) {
      csv += row.map(escapeCSV).join(',') + '\n';
    }

    console.log(`Generated 1099 CSV: ${csvRows.length} records for tax year ${taxYear}`);

    return new Response(csv, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="1099-NEC-${taxYear}.csv"`,
      },
    });

  } catch (error) {
    console.error('1099 data generation error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
