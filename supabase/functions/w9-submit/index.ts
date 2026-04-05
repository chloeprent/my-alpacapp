/**
 * W-9 Submission Edge Function
 *
 * Receives W-9 form data from the tokenized w9.html page,
 * encrypts the TIN (SSN/EIN) with AES-256-GCM, stores the record,
 * and updates associate_profiles.w9_status.
 *
 * Deploy with: supabase functions deploy w9-submit --no-verify-jwt
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface W9SubmitRequest {
  token: string;
  legal_name: string;
  business_name?: string;
  tax_classification: string;
  tax_classification_other?: string;
  exempt_payee_code?: string;
  fatca_exemption_code?: string;
  address_street: string;
  address_city: string;
  address_state: string;
  address_zip: string;
  tin_type: 'ssn' | 'ein';
  tin_value: string;
  certification_agreed: boolean;
}

const VALID_TAX_CLASSIFICATIONS = [
  'individual', 'c_corp', 's_corp', 'partnership',
  'trust_estate', 'llc_c', 'llc_s', 'llc_p', 'other',
];

/**
 * Encrypt a TIN using AES-256-GCM
 */
async function encryptTIN(tin: string, hexKey: string): Promise<{ encrypted: string; iv: string }> {
  const keyBytes = new Uint8Array(hexKey.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(tin);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, cryptoKey, encoded
  );

  return {
    encrypted: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    iv: btoa(String.fromCharCode(...iv)),
  };
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

    const body: W9SubmitRequest = await req.json();

    // ── Validate token ──────────────────────────────────────────
    const { data: tokenRecord, error: tokenError } = await supabase
      .from('upload_tokens')
      .select('*, app_user:app_user_id(id, first_name, last_name, email)')
      .eq('token', body.token)
      .eq('is_used', false)
      .single();

    if (tokenError || !tokenRecord) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid or already-used token' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ success: false, error: 'This link has expired. Please request a new one.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (tokenRecord.token_type !== 'w9_submission') {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid token type' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const appUserId = tokenRecord.app_user_id;
    if (!appUserId) {
      return new Response(
        JSON.stringify({ success: false, error: 'Token is not linked to an associate' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Validate W-9 fields ─────────────────────────────────────
    const errors: string[] = [];

    if (!body.legal_name?.trim()) errors.push('Legal name is required');
    if (!VALID_TAX_CLASSIFICATIONS.includes(body.tax_classification)) {
      errors.push('Invalid tax classification');
    }
    if (body.tax_classification === 'other' && !body.tax_classification_other?.trim()) {
      errors.push('Tax classification description required when "Other" is selected');
    }
    if (!body.address_street?.trim()) errors.push('Street address is required');
    if (!body.address_city?.trim()) errors.push('City is required');
    if (!body.address_state?.trim()) errors.push('State is required');
    if (!body.address_zip?.trim()) errors.push('ZIP code is required');
    if (!['ssn', 'ein'].includes(body.tin_type)) errors.push('TIN type must be SSN or EIN');

    // Validate TIN format (digits only, 9 digits)
    const tinDigits = (body.tin_value || '').replace(/\D/g, '');
    if (tinDigits.length !== 9) {
      errors.push('TIN must be exactly 9 digits');
    }

    if (!body.certification_agreed) {
      errors.push('You must agree to the certification');
    }

    if (errors.length > 0) {
      return new Response(
        JSON.stringify({ success: false, error: errors.join('; ') }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Encrypt TIN ─────────────────────────────────────────────
    const { encrypted, iv } = await encryptTIN(tinDigits, encryptionKey);
    const tinLastFour = tinDigits.slice(-4);

    console.log('Processing W-9 submission for app_user:', appUserId);

    // ── Supersede any previous W-9 ──────────────────────────────
    const { data: existingW9 } = await supabase
      .from('w9_submissions')
      .select('id')
      .eq('app_user_id', appUserId)
      .eq('status', 'submitted')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // ── Store W-9 record ────────────────────────────────────────
    // Get client IP from request headers
    const clientIp = req.headers.get('x-forwarded-for')
      || req.headers.get('x-real-ip')
      || 'unknown';

    const { data: w9, error: w9Error } = await supabase
      .from('w9_submissions')
      .insert({
        app_user_id: appUserId,
        legal_name: body.legal_name.trim(),
        business_name: body.business_name?.trim() || null,
        tax_classification: body.tax_classification,
        tax_classification_other: body.tax_classification_other?.trim() || null,
        exempt_payee_code: body.exempt_payee_code?.trim() || null,
        fatca_exemption_code: body.fatca_exemption_code?.trim() || null,
        address_street: body.address_street.trim(),
        address_city: body.address_city.trim(),
        address_state: body.address_state.trim(),
        address_zip: body.address_zip.trim(),
        tin_type: body.tin_type,
        tin_encrypted: encrypted,
        tin_last_four: tinLastFour,
        tin_iv: iv,
        certification_agreed: true,
        certification_timestamp: new Date().toISOString(),
        certification_ip: clientIp,
        upload_token_id: tokenRecord.id,
        status: 'submitted',
      })
      .select()
      .single();

    if (w9Error) {
      console.error('Error storing W-9:', w9Error);
      throw new Error('Failed to store W-9 submission');
    }

    // Supersede previous W-9 if exists
    if (existingW9) {
      await supabase
        .from('w9_submissions')
        .update({ status: 'superseded', superseded_by: w9.id, updated_at: new Date().toISOString() })
        .eq('id', existingW9.id);
    }

    // ── Mark token as used ──────────────────────────────────────
    await supabase
      .from('upload_tokens')
      .update({ is_used: true, used_at: new Date().toISOString() })
      .eq('id', tokenRecord.id);

    // ── Update associate profile ────────────────────────────────
    await supabase
      .from('associate_profiles')
      .update({
        w9_status: 'submitted',
        w9_submission_id: w9.id,
        updated_at: new Date().toISOString(),
      })
      .eq('app_user_id', appUserId);

    console.log('W-9 submission stored successfully:', w9.id);

    // ── Send admin notification email ───────────────────────────
    try {
      const personName = tokenRecord.app_user
        ? `${tokenRecord.app_user.first_name || ''} ${tokenRecord.app_user.last_name || ''}`.trim()
          || tokenRecord.app_user.email
        : 'Unknown';

      const ADMIN_EMAIL = Deno.env.get('ADMIN_EMAIL') || 'automation@YOUR_DOMAIN';
      await fetch(`${supabaseUrl}/functions/v1/send-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({
          type: 'general_admin',
          to: ADMIN_EMAIL,
          data: {
            subject: `W-9 Submitted: ${personName}`,
            message: `${personName} has submitted their W-9 form. Tax classification: ${body.tax_classification}. TIN type: ${body.tin_type.toUpperCase()} ending in ${tinLastFour}. View details in the admin worktracking page.`,
          },
        }),
      });
    } catch (emailErr) {
      console.error('Error sending W-9 notification email:', emailErr);
    }

    return new Response(
      JSON.stringify({
        success: true,
        w9_id: w9.id,
        tin_masked: `***-**-${tinLastFour}`,
        message: 'W-9 form submitted successfully.',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('W-9 submission error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
