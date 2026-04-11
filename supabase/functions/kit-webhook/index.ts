/**
 * Kit (ConvertKit) Webhook → Swoon CRM
 *
 * When someone subscribes via a Kit form (e.g. downloads the lead magnet),
 * Kit sends a webhook here. We match the subscriber by email and update
 * their CRM contact to mark the lead magnet as opened/downloaded.
 *
 * Kit webhook payload format:
 * { "subscriber": { "id": 123, "email_address": "...", "first_name": "...", ... } }
 *
 * Setup in Kit:
 *   Automations → Visual Automations → Add a webhook action
 *   URL: https://ohcdjvbveokyyilceenf.supabase.co/functions/v1/kit-webhook
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    const payload = await req.json();
    console.log('Kit webhook received:', JSON.stringify(payload));

    // Kit sends subscriber data in { subscriber: { ... } } format
    const sub = payload.subscriber || payload;

    const email = sub.email_address || sub.email || payload.email_address || payload.email || null;
    const firstName = sub.first_name || payload.first_name || null;
    const igUsername = sub.fields?.ig_username || sub.fields?.instagram || null;

    if (!email) {
      return new Response(JSON.stringify({
        error: 'No email found in Kit webhook payload',
        received_keys: Object.keys(payload),
      }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const now = new Date().toISOString();

    // Try to find the contact by email first, then by IG username
    let existing = null;

    const { data: byEmail } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .eq('email', email)
      .maybeSingle();
    existing = byEmail;

    if (!existing && igUsername) {
      const cleanIg = igUsername.replace(/^@/, '');
      const { data: byIg } = await supabase
        .from('swoon_crm_contacts')
        .select('*')
        .eq('ig_username', cleanIg)
        .maybeSingle();
      existing = byIg;
    }

    if (existing) {
      // ── Update existing contact: mark lead magnet as opened ──
      const updates: Record<string, unknown> = {
        lead_magnet_opened: true,
        lead_magnet_opened_at: now,
        last_activity_at: now,
        updated_at: now,
      };

      // Fill in email if we didn't have it
      if (!existing.email) updates.email = email;
      if (!existing.full_name && firstName) updates.full_name = firstName;

      await supabase
        .from('swoon_crm_contacts')
        .update(updates)
        .eq('id', existing.id);

      // Log the activity
      await supabase.from('swoon_crm_activity').insert({
        contact_id: existing.id,
        activity_type: 'lead_magnet_opened',
        description: `Lead magnet downloaded via Kit (${email})`,
        metadata: payload,
      });

      return new Response(JSON.stringify({
        success: true,
        action: 'updated',
        contact_id: existing.id,
        lead_magnet_opened: true,
      }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } else {
      // ── New contact from Kit (they found the form directly, not via ManyChat) ──
      const { data: newContact, error } = await supabase
        .from('swoon_crm_contacts')
        .insert({
          email,
          full_name: firstName || null,
          ig_username: igUsername ? igUsername.replace(/^@/, '') : null,
          stage: 'lead_magnet_sent',
          source: 'kit',
          lead_magnet_sent: true,
          lead_magnet_sent_at: now,
          lead_magnet_opened: true,
          lead_magnet_opened_at: now,
          first_contact_at: now,
          last_activity_at: now,
        })
        .select()
        .single();

      if (error) throw error;

      await supabase.from('swoon_crm_activity').insert({
        contact_id: newContact.id,
        activity_type: 'lead_magnet_opened',
        description: `New lead via Kit form — lead magnet downloaded (${email})`,
        metadata: payload,
      });

      return new Response(JSON.stringify({
        success: true,
        action: 'created',
        contact_id: newContact.id,
        lead_magnet_opened: true,
      }), {
        status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

  } catch (error) {
    console.error('Kit webhook error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
