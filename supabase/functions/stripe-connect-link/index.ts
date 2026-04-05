/**
 * Stripe Connect Link Generator
 *
 * Token-based endpoint that generates a fresh Stripe Connect onboarding link
 * and redirects the user. Links expire in ~5 min, so this lets associates
 * click anytime to get a new one.
 *
 * Usage: GET /stripe-connect-link?token=<upload_token>
 *
 * Deploy with: supabase functions deploy stripe-connect-link --no-verify-jwt
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function errorPage(title: string, message: string): Response {
  return new Response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; border-radius: 12px; padding: 32px; max-width: 400px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  h1 { color: #c62828; font-size: 20px; }
  p { color: #666; line-height: 1.6; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`,
    { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function formEncode(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return errorPage('Missing Token', 'No token was provided. Please use the link from your email.');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Validate token
    const { data: tokenRecord, error: tokenError } = await supabase
      .from('upload_tokens')
      .select('*')
      .eq('token', token)
      .eq('token_type', 'stripe_connect_onboard')
      .single();

    if (tokenError || !tokenRecord) {
      return errorPage('Invalid Link', 'This link is not valid. Please contact the YOUR_PROPERTY_NAME team for a new one.');
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return errorPage('Link Expired', 'This link has expired. Please contact the YOUR_PROPERTY_NAME team for a new one.');
    }

    // Get the associate profile via app_user_id
    const { data: associate, error: assocError } = await supabase
      .from('associate_profiles')
      .select('id, stripe_connect_account_id')
      .eq('app_user_id', tokenRecord.app_user_id)
      .single();

    if (assocError || !associate) {
      return errorPage('Account Not Found', 'Could not find your associate account. Please contact the team.');
    }

    if (!associate.stripe_connect_account_id) {
      return errorPage('Setup Incomplete', 'Your Stripe account has not been created yet. Please contact the team.');
    }

    // Load Stripe config
    const { data: config } = await supabase
      .from('stripe_config')
      .select('secret_key, sandbox_secret_key, test_mode, is_active, connect_enabled')
      .single();

    if (!config?.is_active || !config?.connect_enabled) {
      return errorPage('Payments Unavailable', 'The payment system is currently unavailable. Please try again later.');
    }

    const secretKey = config.test_mode ? config.sandbox_secret_key : config.secret_key;
    if (!secretKey) {
      return errorPage('Configuration Error', 'Payment system is not fully configured. Please contact the team.');
    }

    // Generate fresh account link
    const baseUrl = 'https://YOUR_DOMAIN/associates/worktracking.html';
    const response = await fetch('https://api.stripe.com/v1/account_links', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formEncode({
        account: associate.stripe_connect_account_id,
        type: 'account_onboarding',
        return_url: `${baseUrl}?stripe_onboarding=complete`,
        refresh_url: `${baseUrl}?stripe_onboarding=refresh`,
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error('Stripe error:', result);
      return errorPage('Setup Error', result?.error?.message || 'Could not generate setup link. Please contact the team.');
    }

    // Log API usage
    await supabase.from('api_usage_log').insert({
      vendor: 'stripe',
      category: 'stripe_connect_onboard',
      endpoint: 'account_links.create',
      units: 1,
      unit_type: 'api_calls',
      estimated_cost_usd: 0,
      metadata: {
        account_id: associate.stripe_connect_account_id,
        associate_id: associate.id,
        test_mode: config.test_mode,
        source: 'token_link',
      },
    });

    // Redirect to Stripe onboarding
    return new Response(null, {
      status: 302,
      headers: { Location: result.url },
    });

  } catch (error) {
    console.error('stripe-connect-link error:', error);
    return errorPage('Something Went Wrong', 'An unexpected error occurred. Please try again or contact the team.');
  }
});
