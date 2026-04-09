/**
 * ManyChat Webhook → Swoon CRM
 *
 * When someone DMs a keyword on Instagram and ManyChat triggers,
 * this webhook auto-creates (or updates) a contact in the CRM.
 *
 * ManyChat sends a POST with subscriber data when an automation runs.
 * Set this URL as an "External Request" action in your ManyChat flow.
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

    // ManyChat sends subscriber data in various formats depending on the action.
    // We'll handle the most common fields:
    const subscriberId = payload.id || payload.subscriber_id || payload.manychat_id || null;
    const igUsername = payload.ig_username || payload.instagram_username || payload.username || null;
    const fullName = payload.full_name || payload.name || payload.first_name
      ? `${payload.first_name || ''} ${payload.last_name || ''}`.trim()
      : null;
    const email = payload.email || null;
    const phone = payload.phone || null;
    const keyword = payload.keyword || payload.trigger_keyword || payload.last_input_text || null;

    // Determine what happened
    const isLeadMagnet = payload.lead_magnet_sent === true
      || payload.tag === 'lead_magnet'
      || (payload.tags && payload.tags.includes('lead_magnet'));

    if (!subscriberId && !igUsername) {
      return new Response(JSON.stringify({ error: 'No subscriber ID or IG username provided' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Connect to Supabase with service role (bypasses RLS)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Check if contact already exists (by manychat_id or ig_username)
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
      const stage = isLeadMagnet ? 'lead_magnet_sent' : 'new_lead';

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
          lead_magnet_sent: isLeadMagnet,
          lead_magnet_sent_at: isLeadMagnet ? now : null,
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
