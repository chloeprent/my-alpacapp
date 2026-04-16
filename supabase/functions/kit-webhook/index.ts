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

  // Accept both GET and POST — Kit may use either
  try {
    let payload: any = {};

    if (req.method === 'POST') {
      const text = await req.text();
      console.log('Kit webhook raw body:', text);
      try {
        payload = JSON.parse(text);
      } catch {
        // Try URL-encoded form data
        const params = new URLSearchParams(text);
        for (const [key, value] of params) {
          payload[key] = value;
        }
      }
    } else if (req.method === 'GET') {
      const url = new URL(req.url);
      for (const [key, value] of url.searchParams) {
        payload[key] = value;
      }
      console.log('Kit webhook GET params:', JSON.stringify(payload));
    }

    console.log('Kit webhook parsed payload:', JSON.stringify(payload));

    // Kit sends data in several formats:
    // { subscriber: { email_address, first_name, ... } }
    // { subscribers: [{ id, email, first_name, ... }] }  (action_node format)
    // or flat: { email_address, first_name, ... }
    let sub = payload.subscriber || payload;

    // Handle the subscribers array format (Kit action_node events)
    if (payload.subscribers && Array.isArray(payload.subscribers) && payload.subscribers.length > 0) {
      sub = payload.subscribers[0];
    }

    const email = sub.email_address || sub.email || payload.email_address || payload.email || null;
    const firstName = sub.first_name || sub.name || payload.first_name || payload.name || null;
    const igUsername = sub.fields?.ig_username || sub.fields?.instagram
      || payload.ig_username || payload.instagram || null;

    // If no email, log the full payload to Supabase for debugging
    if (!email) {
      const supabaseDebug = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );
      await supabaseDebug.from('swoon_crm_activity').insert({
        contact_id: null,
        activity_type: 'kit_debug',
        description: `Kit webhook received but no email found. Keys: ${Object.keys(payload).join(', ')}`,
        metadata: payload,
      });

      return new Response(JSON.stringify({
        success: true,
        note: 'Logged payload for debugging — no email found',
        received_keys: Object.keys(payload),
        sub_keys: Object.keys(sub),
      }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const now = new Date().toISOString();

    // Try to find the contact by IG handle first (catches ManyChat-originated
    // rows that don't have an email yet — the common case when someone DMs a
    // trigger word on Instagram and then fills out the Kit opt-in form).
    // Fall back to email lookup if no IG match.
    let existing = null;

    if (igUsername) {
      const cleanIg = igUsername.replace(/^@/, '');
      const { data: byIg } = await supabase
        .from('swoon_crm_contacts')
        .select('*')
        .eq('ig_username', cleanIg)
        .maybeSingle();
      existing = byIg;
    }

    if (!existing) {
      const { data: byEmail } = await supabase
        .from('swoon_crm_contacts')
        .select('*')
        .eq('email', email)
        .maybeSingle();
      existing = byEmail;
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
