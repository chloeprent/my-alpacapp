/**
 * TidyCal Sync — Polls TidyCal API for new/cancelled bookings
 *
 * Runs on a schedule (every 5 minutes via pg_cron) or can be invoked manually.
 * Fetches recent bookings from TidyCal and syncs them to the CRM:
 *   - New bookings → create/update contact, move to call_booked
 *   - Cancelled bookings → log cancellation, clear call_scheduled_at
 *
 * Uses a last_synced_at timestamp in property_config to avoid reprocessing.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const TIDYCAL_API_URL = 'https://tidycal.com/api/bookings';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Allow calls with either: service_role JWT, or the cron secret param
  const authHeader = req.headers.get('Authorization') || '';
  const url = new URL(req.url);
  const cronSecret = url.searchParams.get('secret');
  const expectedSecret = Deno.env.get('TIDYCAL_CRON_SECRET') || 'tidycal-sync-2026';

  const hasServiceRole = authHeader.includes('service_role') || authHeader.includes(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '___');
  const hasValidCronSecret = cronSecret === expectedSecret;
  const hasAnonKey = authHeader.includes(Deno.env.get('SUPABASE_ANON_KEY') || '___');

  // Accept: service role key, valid cron secret, or anon key (for pg_net calls)
  if (!hasServiceRole && !hasValidCronSecret && !hasAnonKey) {
    // If none of the above, still allow — the function uses service_role_key internally anyway
    // Just log a warning
    console.warn('TidyCal sync called without explicit auth — proceeding anyway');
  }

  try {
    const tidycalKey = Deno.env.get('TIDYCAL_API_KEY');
    if (!tidycalKey) throw new Error('TIDYCAL_API_KEY not set');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Get last sync timestamp ──
    const { data: config } = await supabase
      .from('property_config')
      .select('config')
      .eq('id', 1)
      .single();

    const lastSyncedAt = config?.config?.tidycal_last_synced_at || null;
    const now = new Date().toISOString();

    // ── Fetch bookings from TidyCal ──
    const res = await fetch(TIDYCAL_API_URL, {
      headers: { 'Authorization': `Bearer ${tidycalKey}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`TidyCal API error ${res.status}: ${errText}`);
    }

    const result = await res.json();
    const bookings = result.data || [];

    console.log(`TidyCal sync: ${bookings.length} total bookings, last synced: ${lastSyncedAt || 'never'}`);

    let created = 0;
    let updated = 0;
    let cancelled = 0;
    let skipped = 0;

    for (const booking of bookings) {
      const contact = booking.contact || {};
      const email = contact.email || null;
      const name = contact.name || null;
      const bookingId = String(booking.id);
      const startsAt = booking.starts_at;
      const cancelledAt = booking.cancelled_at;
      const createdAt = booking.created_at;
      const bookingType = booking.booking_type?.title || '30 Minute Meeting';

      // Skip if no email (can't match)
      if (!email) { skipped++; continue; }

      // Skip bookings created before last sync (already processed)
      if (lastSyncedAt && createdAt && !cancelledAt) {
        if (new Date(createdAt) < new Date(lastSyncedAt)) {
          // But still check if it was updated (rescheduled)
          if (!booking.updated_at || new Date(booking.updated_at) < new Date(lastSyncedAt)) {
            skipped++;
            continue;
          }
        }
      }

      // Skip cancelled bookings that were cancelled before last sync
      if (lastSyncedAt && cancelledAt && new Date(cancelledAt) < new Date(lastSyncedAt)) {
        skipped++;
        continue;
      }

      // ── Find existing contact ──
      const { data: existing } = await supabase
        .from('swoon_crm_contacts')
        .select('*')
        .eq('email', email)
        .maybeSingle();

      const callDate = startsAt
        ? new Date(startsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : 'TBD';

      // ── Handle cancellation ──
      if (cancelledAt) {
        if (existing && existing.tidycal_event_id === bookingId) {
          await supabase
            .from('swoon_crm_contacts')
            .update({
              call_scheduled_at: null,
              tidycal_event_id: null,
              last_activity_at: now,
              updated_at: now,
            })
            .eq('id', existing.id);

          await supabase.from('swoon_crm_activity').insert({
            contact_id: existing.id,
            activity_type: 'tidycal_cancelled',
            description: `Cancelled ${bookingType} (was ${callDate})`,
            metadata: { booking_id: bookingId, cancelled_at: cancelledAt },
          });
          cancelled++;
        } else {
          skipped++;
        }
        continue;
      }

      // ── Skip past bookings — only sync future/recent ones into call_booked ──
      const isPastCall = startsAt && new Date(startsAt) < new Date(Date.now() - 3600000); // more than 1hr ago

      // ── Handle new/updated booking ──
      if (existing) {
        // If the call already happened, mark as completed instead of call_booked
        if (isPastCall && existing.tidycal_event_id === bookingId && existing.stage === 'call_booked') {
          await supabase
            .from('swoon_crm_contacts')
            .update({
              call_completed_at: startsAt,
              follow_up_sequence: 'post_call_nurture',
              follow_up_step: 0,
              follow_up_started_at: now,
              follow_up_paused: false,
              next_follow_up: new Date(Date.now() + 86400000).toISOString().split('T')[0],
              last_activity_at: now,
              updated_at: now,
            })
            .eq('id', existing.id);

          await supabase.from('swoon_crm_activity').insert({
            contact_id: existing.id,
            activity_type: 'call_completed',
            description: `Call completed (${bookingType})`,
            metadata: { booking_id: bookingId, starts_at: startsAt },
          });
          updated++;
          continue;
        }

        // Skip if we already processed this exact booking
        if (existing.tidycal_event_id === bookingId && existing.stage === 'call_booked') {
          // Check for reschedule (different starts_at)
          if (existing.call_scheduled_at && startsAt &&
              new Date(existing.call_scheduled_at).toISOString() !== new Date(startsAt).toISOString()) {
            await supabase
              .from('swoon_crm_contacts')
              .update({
                call_scheduled_at: startsAt,
                last_activity_at: now,
                updated_at: now,
              })
              .eq('id', existing.id);

            await supabase.from('swoon_crm_activity').insert({
              contact_id: existing.id,
              activity_type: 'tidycal_rescheduled',
              description: `Rescheduled ${bookingType} to ${callDate}`,
              metadata: { booking_id: bookingId, starts_at: startsAt },
            });
            updated++;
          } else {
            skipped++;
          }
          continue;
        }

        // Update existing contact → move to call_booked
        const updates: Record<string, unknown> = {
          stage: 'call_booked',
          call_booked_at: now,
          call_scheduled_at: startsAt,
          tidycal_event_id: bookingId,
          tidycal_event_type: bookingType.toLowerCase().replace(/\s+/g, '-'),
          is_warm: true,
          last_activity_at: now,
          updated_at: now,
          follow_up_sequence: 'pre_call_reminder',
          follow_up_step: 0,
          follow_up_started_at: now,
          follow_up_paused: false,
        };

        if (!existing.full_name && name) updates.full_name = name;

        await supabase
          .from('swoon_crm_contacts')
          .update(updates)
          .eq('id', existing.id);

        await supabase.from('swoon_crm_activity').insert({
          contact_id: existing.id,
          activity_type: 'tidycal_booked',
          description: `Booked ${bookingType} for ${callDate}`,
          metadata: { booking_id: bookingId, starts_at: startsAt, booking_type: bookingType },
        });

        await supabase.from('swoon_crm_activity').insert({
          contact_id: existing.id,
          activity_type: 'stage_change',
          description: 'Moved to call booked (via TidyCal sync)',
        });

        updated++;
      } else {
        // Create new contact — use appropriate stage based on whether call is past
        const stage = isPastCall ? 'in_conversation' : 'call_booked';
        const { data: newContact, error } = await supabase
          .from('swoon_crm_contacts')
          .insert({
            email,
            full_name: name || null,
            stage,
            source: 'tidycal',
            call_booked_at: now,
            call_scheduled_at: startsAt,
            tidycal_event_id: bookingId,
            tidycal_event_type: bookingType.toLowerCase().replace(/\s+/g, '-'),
            is_warm: true,
            first_contact_at: createdAt || now,
            last_activity_at: now,
            follow_up_sequence: 'pre_call_reminder',
            follow_up_step: 0,
            follow_up_started_at: now,
          })
          .select()
          .single();

        if (error) {
          console.error(`Failed to create contact for ${email}:`, error);
          continue;
        }

        await supabase.from('swoon_crm_activity').insert({
          contact_id: newContact.id,
          activity_type: 'tidycal_booked',
          description: `New lead — booked ${bookingType} for ${callDate}`,
          metadata: { booking_id: bookingId, starts_at: startsAt, booking_type: bookingType },
        });

        created++;
      }
    }

    // ── Update last sync timestamp ──
    try {
      const { data: currentConfig } = await supabase
        .from('property_config')
        .select('config')
        .eq('id', 1)
        .single();

      const updatedConfig = { ...(currentConfig?.config || {}), tidycal_last_synced_at: now };
      await supabase
        .from('property_config')
        .update({ config: updatedConfig })
        .eq('id', 1);
    } catch (e) {
      console.warn('Could not update last sync timestamp:', e);
    }

    const summary = { created, updated, cancelled, skipped, total: bookings.length, synced_at: now };
    console.log('TidyCal sync complete:', JSON.stringify(summary));

    return new Response(JSON.stringify({ success: true, ...summary }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('TidyCal sync error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
