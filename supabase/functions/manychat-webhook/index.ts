/**
 * ManyChat Webhook → Swoon CRM
 *
 * When someone DMs a keyword on Instagram and ManyChat triggers,
 * this webhook auto-creates (or updates) a contact in the CRM.
 *
 * ManyChat sends a POST with subscriber data when an automation runs.
 * Set this URL as an "External Request" action in your ManyChat flow.
 * Use "+ Add Full Contact Data" in the body to send all subscriber info.
 *
 * Endpoint: https://ohcdjvbveokyyilceenf.supabase.co/functions/v1/manychat-webhook
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-ManyChat-Token',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    // Parse the incoming ManyChat payload
    const payload = await req.json();

    // Log the raw payload for debugging
    console.log('ManyChat webhook received:', JSON.stringify(payload));

    // ManyChat "Full Contact Data" format nests subscriber info differently.
    // It can send: { id, key, name, first_name, last_name, ig_username, ... }
    // Or nested: { subscriber: { id, ... } }
    // Or custom body: { ig_username, first_name, ... }
    // We handle ALL formats:

    const sub = payload.subscriber || payload;

    // Extract subscriber ID — try every possible field name
    const subscriberId = sub.id || sub.subscriber_id || sub.manychat_id
      || sub.user_id || payload.id || payload.subscriber_id || null;

    // Extract IG username — try every possible field name
    let igUsername = sub.ig_username || sub.instagram_username || sub.username
      || payload.ig_username || payload.username || null;

    // Clean up: skip empty strings
    if (igUsername === '' || igUsername === 'undefined' || igUsername === 'null') {
      igUsername = null;
    }

    // Extract name
    let fullName = sub.full_name || sub.name || payload.full_name || payload.name || null;
    if (!fullName) {
      const first = sub.first_name || payload.first_name || '';
      const last = sub.last_name || payload.last_name || '';
      if (first || last) {
        fullName = `${first} ${last}`.trim();
      }
    }
    if (!fullName || fullName === '' || fullName === 'undefined'
      || fullName.includes('{{') || fullName.includes('}}')) fullName = null;

    // Extract email and phone
    let email = sub.email || payload.email || null;
    if (email === '' || email === 'undefined') email = null;

    let phone = sub.phone || payload.phone || null;
    if (phone === '' || phone === 'undefined') phone = null;

    // Extract keyword
    const keyword = sub.keyword || payload.keyword || sub.trigger_keyword
      || payload.trigger_keyword || sub.last_input_text || payload.last_input_text || null;

    // Determine if lead magnet was sent
    const isLeadMagnet = payload.lead_magnet_sent === true
      || sub.lead_magnet_sent === true
      || payload.tag === 'lead_magnet'
      || (payload.tags && payload.tags.includes('lead_magnet'))
      || (sub.tags && Array.isArray(sub.tags) && sub.tags.some((t: any) =>
          (typeof t === 'string' ? t : t.name || '').toLowerCase().includes('lead_magnet')
        ));

    console.log('Parsed:', { subscriberId, igUsername, fullName, email, phone, keyword, isLeadMagnet });

    // We need at least SOMETHING to identify this person
    if (!subscriberId && !igUsername && !email && !fullName) {
      return new Response(JSON.stringify({
        error: 'No identifying info found in payload',
        received_keys: Object.keys(payload),
        hint: 'Use "+ Add Full Contact Data" in ManyChat body editor',
      }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Connect to Supabase with service role (bypasses RLS)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Check if contact already exists (by manychat_id, ig_username, or email)
    let existing = null;
    if (subscriberId) {
      const { data } = await supabase
        .from('swoon_crm_contacts')
        .select('*')
        .eq('manychat_id', String(subscriberId))
        .maybeSingle();
      existing = data;
    }
    if (!existing && igUsername) {
      const cleanIg = igUsername.replace(/^@/, '');
      const { data } = await supabase
        .from('swoon_crm_contacts')
        .select('*')
        .eq('ig_username', cleanIg)
        .maybeSingle();
      existing = data;
    }
    if (!existing && email) {
      const { data } = await supabase
        .from('swoon_crm_contacts')
        .select('*')
        .eq('email', email)
        .maybeSingle();
      existing = data;
    }

    const now = new Date().toISOString();

    if (existing) {
      // ── Update existing contact ──
      const updates: Record<string, unknown> = {
        last_activity_at: now,
        updated_at: now,
      };

      // Fill in any missing fields
      if (!existing.full_name && fullName) updates.full_name = fullName;
      if (!existing.email && email) updates.email = email;
      if (!existing.phone && phone) updates.phone = phone;
      if (!existing.manychat_id && subscriberId) updates.manychat_id = String(subscriberId);
      if (!existing.ig_username && igUsername) updates.ig_username = igUsername.replace(/^@/, '');
      if (keyword && !existing.keyword_used) updates.keyword_used = keyword;

      // If lead magnet was just sent, update stage
      if (isLeadMagnet && !existing.lead_magnet_sent) {
        updates.lead_magnet_sent = true;
        updates.lead_magnet_sent_at = now;
        if (existing.stage === 'new_lead') {
          updates.stage = 'lead_magnet_sent';
        }
      }

      await supabase
        .from('swoon_crm_contacts')
        .update(updates)
        .eq('id', existing.id);

      // Log the activity
      await supabase.from('swoon_crm_activity').insert({
        contact_id: existing.id,
        activity_type: isLeadMagnet ? 'lead_magnet' : 'keyword_trigger',
        description: isLeadMagnet
          ? `Lead magnet delivered via ManyChat`
          : `Keyword "${keyword || 'unknown'}" triggered in ManyChat`,
        metadata: payload,
      });

      return new Response(JSON.stringify({
        success: true,
        action: 'updated',
        contact_id: existing.id,
      }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } else {
      // ── Create new contact ──
      // ManyChat contacts always get the lead magnet link via the automation,
      // so default to 'lead_magnet_sent' (not 'new_lead')
      const stage = 'lead_magnet_sent';

      const { data: newContact, error } = await supabase
        .from('swoon_crm_contacts')
        .insert({
          ig_username: igUsername ? igUsername.replace(/^@/, '') : null,
          full_name: fullName,
          email,
          phone,
          stage,
          source: 'manychat',
          manychat_id: subscriberId ? String(subscriberId) : null,
          keyword_used: keyword,
          lead_magnet_sent: true,
          lead_magnet_sent_at: now,
          first_contact_at: now,
          last_activity_at: now,
        })
        .select()
        .single();

      if (error) throw error;

      // Log the activity
      await supabase.from('swoon_crm_activity').insert({
        contact_id: newContact.id,
        activity_type: isLeadMagnet ? 'lead_magnet' : 'keyword_trigger',
        description: isLeadMagnet
          ? `New lead via ManyChat — lead magnet delivered (keyword: "${keyword || 'unknown'}")`
          : `New lead via ManyChat — keyword "${keyword || 'unknown'}" triggered`,
        metadata: payload,
      });

      return new Response(JSON.stringify({
        success: true,
        action: 'created',
        contact_id: newContact.id,
      }), {
        status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

  } catch (error) {
    console.error('ManyChat webhook error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
