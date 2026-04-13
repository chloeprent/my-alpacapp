/**
 * CRM Cleanup — One-time data fix
 * Moves past calls from call_booked to in_conversation and deduplicates contacts.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const now = new Date().toISOString();
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    let fixed = 0;
    let deduped = 0;

    // ── Step 1: Move past calls from call_booked to in_conversation ──
    const { data: pastCalls } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .eq('stage', 'call_booked')
      .lt('call_scheduled_at', oneHourAgo);

    if (pastCalls) {
      for (const c of pastCalls) {
        await supabase
          .from('swoon_crm_contacts')
          .update({
            stage: 'in_conversation',
            call_completed_at: c.call_scheduled_at,
            follow_up_sequence: 'post_call_nurture',
            follow_up_step: 0,
            follow_up_started_at: now,
            follow_up_paused: false,
            updated_at: now,
          })
          .eq('id', c.id);

        await supabase.from('swoon_crm_activity').insert({
          contact_id: c.id,
          activity_type: 'call_completed',
          description: `Call completed (moved from call_booked)`,
        });
        fixed++;
      }
    }

    // ── Step 2: Dedup by email ──
    const { data: allContacts } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .not('email', 'is', null)
      .order('created_at', { ascending: true });

    if (allContacts) {
      const emailMap = new Map<string, any[]>();
      for (const c of allContacts) {
        const key = c.email.toLowerCase().trim();
        if (!emailMap.has(key)) emailMap.set(key, []);
        emailMap.get(key)!.push(c);
      }

      for (const [, dupes] of emailMap) {
        if (dupes.length < 2) continue;

        const primary = dupes[0];
        for (const dupe of dupes.slice(1)) {
          const updates: Record<string, unknown> = {};
          if (!primary.ig_username && dupe.ig_username) updates.ig_username = dupe.ig_username;
          if (!primary.full_name && dupe.full_name) updates.full_name = dupe.full_name;
          if (!primary.phone && dupe.phone) updates.phone = dupe.phone;
          if (!primary.tidycal_event_id && dupe.tidycal_event_id) updates.tidycal_event_id = dupe.tidycal_event_id;
          if (!primary.call_scheduled_at && dupe.call_scheduled_at) updates.call_scheduled_at = dupe.call_scheduled_at;
          if (!primary.call_booked_at && dupe.call_booked_at) updates.call_booked_at = dupe.call_booked_at;
          if (!primary.keyword_used && dupe.keyword_used) updates.keyword_used = dupe.keyword_used;
          if (!primary.manychat_id && dupe.manychat_id) updates.manychat_id = dupe.manychat_id;

          const stageOrder = ['new_lead', 'lead_magnet_sent', 'in_conversation', 'call_booked', 'client'];
          if (stageOrder.indexOf(dupe.stage) > stageOrder.indexOf(primary.stage)) {
            updates.stage = dupe.stage;
          }

          if (Object.keys(updates).length) {
            updates.updated_at = now;
            await supabase.from('swoon_crm_contacts').update(updates).eq('id', primary.id);
          }

          await supabase.from('swoon_crm_activity').update({ contact_id: primary.id }).eq('contact_id', dupe.id);
          await supabase.from('swoon_crm_contacts').delete().eq('id', dupe.id);
          deduped++;
          console.log(`Merged: ${dupe.email} (id ${dupe.id} → ${primary.id})`);
        }
      }
    }

    // ── Step 3: Dedup by name (for contacts without email) ──
    const { data: namedContacts } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .not('full_name', 'is', null)
      .order('created_at', { ascending: true });

    if (namedContacts) {
      const nameMap = new Map<string, any[]>();
      for (const c of namedContacts) {
        const key = c.full_name.toLowerCase().trim();
        if (!nameMap.has(key)) nameMap.set(key, []);
        nameMap.get(key)!.push(c);
      }

      for (const [, dupes] of nameMap) {
        if (dupes.length < 2) continue;

        const primary = dupes[0];
        for (const dupe of dupes.slice(1)) {
          // Only merge if they look like the same person (same name, no conflicting email)
          if (primary.email && dupe.email && primary.email.toLowerCase() !== dupe.email.toLowerCase()) continue;

          const updates: Record<string, unknown> = {};
          if (!primary.email && dupe.email) updates.email = dupe.email;
          if (!primary.ig_username && dupe.ig_username) updates.ig_username = dupe.ig_username;
          if (!primary.phone && dupe.phone) updates.phone = dupe.phone;
          if (!primary.tidycal_event_id && dupe.tidycal_event_id) updates.tidycal_event_id = dupe.tidycal_event_id;
          if (!primary.call_scheduled_at && dupe.call_scheduled_at) updates.call_scheduled_at = dupe.call_scheduled_at;
          if (!primary.call_booked_at && dupe.call_booked_at) updates.call_booked_at = dupe.call_booked_at;

          const stageOrder = ['new_lead', 'lead_magnet_sent', 'in_conversation', 'call_booked', 'client'];
          if (stageOrder.indexOf(dupe.stage) > stageOrder.indexOf(primary.stage)) {
            updates.stage = dupe.stage;
          }

          if (Object.keys(updates).length) {
            updates.updated_at = now;
            await supabase.from('swoon_crm_contacts').update(updates).eq('id', primary.id);
          }

          await supabase.from('swoon_crm_activity').update({ contact_id: primary.id }).eq('contact_id', dupe.id);
          await supabase.from('swoon_crm_contacts').delete().eq('id', dupe.id);
          deduped++;
          console.log(`Merged by name: ${dupe.full_name} (id ${dupe.id} → ${primary.id})`);
        }
      }
    }

    return new Response(JSON.stringify({ success: true, fixed, deduped }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('CRM cleanup error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
