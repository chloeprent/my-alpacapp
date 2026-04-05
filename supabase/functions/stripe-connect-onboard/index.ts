/**
 * Stripe Connect Onboarding Edge Function
 *
 * Creates Express Connected Accounts and generates Account Link URLs
 * for associates to complete Stripe onboarding (bank account setup).
 *
 * Actions:
 *   create_account      — Creates an Express Connect account, stores acct_xxx in associate_profiles
 *   create_account_link — Generates a hosted onboarding URL for the associate
 *
 * Deploy with: supabase functions deploy stripe-connect-onboard --no-verify-jwt
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

interface OnboardRequest {
  action: 'create_account' | 'create_account_link';
  associate_id: string;
}

function formEncode(obj: Record<string, string | number | boolean>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

async function stripePost(secretKey: string, endpoint: string, params: Record<string, string | number | boolean>): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.stripe.com/v1${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formEncode(params)
  });

  const text = await response.text();
  if (!response.ok) {
    const err = JSON.parse(text);
    throw new Error(err?.error?.message || text);
  }
  return JSON.parse(text);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify caller is authenticated
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: OnboardRequest = await req.json();
    const { action, associate_id } = body;

    if (!action || !associate_id) {
      return new Response(
        JSON.stringify({ success: false, error: 'action and associate_id are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Load Stripe config
    const { data: config, error: configError } = await supabase
      .from('stripe_config')
      .select('*')
      .single();

    if (configError || !config) {
      return new Response(
        JSON.stringify({ success: false, error: 'Stripe configuration not found' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!config.is_active) {
      return new Response(
        JSON.stringify({ success: false, error: 'Stripe is not active. Enable it in Settings.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!config.connect_enabled) {
      return new Response(
        JSON.stringify({ success: false, error: 'Stripe Connect is not enabled. Enable it in Settings.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const secretKey = config.test_mode ? config.sandbox_secret_key : config.secret_key;
    if (!secretKey) {
      return new Response(
        JSON.stringify({ success: false, error: `Missing ${config.test_mode ? 'sandbox' : 'production'} Stripe secret key` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Load associate profile
    const { data: associate, error: assocError } = await supabase
      .from('associate_profiles')
      .select('*, app_user:app_user_id(display_name, first_name, last_name, email)')
      .eq('id', associate_id)
      .single();

    if (assocError || !associate) {
      return new Response(
        JSON.stringify({ success: false, error: 'Associate not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const associateEmail = associate.app_user?.email || null;
    const associateName = associate.app_user?.display_name
      || `${associate.app_user?.first_name || ''} ${associate.app_user?.last_name || ''}`.trim()
      || 'Unknown';

    // ---- ACTION: create_account ----
    if (action === 'create_account') {
      // If they already have an account, return it
      if (associate.stripe_connect_account_id) {
        console.log(`Associate ${associate_id} already has Connect account: ${associate.stripe_connect_account_id}`);
        return new Response(
          JSON.stringify({
            success: true,
            account_id: associate.stripe_connect_account_id,
            already_existed: true,
            message: 'Connect account already exists'
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Create Express Connected Account
      const params: Record<string, string | number | boolean> = {
        type: 'express',
        country: 'US',
        'capabilities[transfers][requested]': 'true',
      };
      if (associateEmail) params.email = associateEmail;
      if (associateName !== 'Unknown') {
        params['business_profile[product_description]'] = `Associate at YOUR_PROPERTY_NAME`;
      }

      console.log('Creating Stripe Connect account for:', associateName);
      const account = await stripePost(secretKey, '/accounts', params);
      const accountId = account.id as string;

      // Store the account ID in associate_profiles
      const { error: updateError } = await supabase
        .from('associate_profiles')
        .update({
          stripe_connect_account_id: accountId,
          payment_method: 'stripe',
          updated_at: new Date().toISOString()
        })
        .eq('id', associate_id);

      if (updateError) {
        console.error('Error storing Connect account ID:', updateError);
      }

      // Log API usage
      await supabase.from('api_usage_log').insert({
        vendor: 'stripe',
        category: 'stripe_connect_onboard',
        endpoint: 'accounts.create',
        units: 1,
        unit_type: 'api_calls',
        estimated_cost_usd: 0,
        metadata: { account_id: accountId, associate_id, test_mode: config.test_mode },
        app_user_id: user.id
      });

      console.log('Created Connect account:', accountId);

      return new Response(
        JSON.stringify({
          success: true,
          account_id: accountId,
          message: `Created Stripe Connect account for ${associateName}`
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ---- ACTION: create_account_link ----
    if (action === 'create_account_link') {
      const connectAccountId = associate.stripe_connect_account_id;
      if (!connectAccountId) {
        return new Response(
          JSON.stringify({ success: false, error: 'No Connect account exists. Call create_account first.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const baseUrl = 'https://YOUR_DOMAIN/associates/worktracking.html';
      const returnUrl = `${baseUrl}?stripe_onboarding=complete`;
      const refreshUrl = `${baseUrl}?stripe_onboarding=refresh`;

      const accountLink = await stripePost(secretKey, '/account_links', {
        account: connectAccountId,
        type: 'account_onboarding',
        return_url: returnUrl,
        refresh_url: refreshUrl,
      });

      // Log API usage
      await supabase.from('api_usage_log').insert({
        vendor: 'stripe',
        category: 'stripe_connect_onboard',
        endpoint: 'account_links.create',
        units: 1,
        unit_type: 'api_calls',
        estimated_cost_usd: 0,
        metadata: { account_id: connectAccountId, associate_id, test_mode: config.test_mode },
        app_user_id: user.id
      });

      return new Response(
        JSON.stringify({
          success: true,
          url: accountLink.url as string,
          message: 'Redirect associate to this URL to complete Stripe onboarding'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Stripe Connect onboarding error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
