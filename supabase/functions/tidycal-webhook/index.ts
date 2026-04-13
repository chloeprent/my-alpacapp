/**
 * TidyCal Webhook → Swoon CRM
 *
 * When someone books a discovery call through TidyCal, this webhook:
 * 1. Matches the booker by email (or creates a new contact)
 * 2. Moves them to "call_booked" stage
 * 3. Logs the booking in the activity timeline
 * 4. Starts the pre-call reminder sequence
 *
 * TidyCal webhook payload (booking.created):
 * {
 *   "id": 12345,
 *   "name": "Jane Doe",
 *   "email": "jane@example.com",
 *   "starts_at": "2026-04-15T14:00:00.000Z",
 *   "ends_at": "2026-04-15T14:30:00.000Z",
 *   "cancelled": false,
 *   "booking_type": { "title": "Discovery Call" },
 *   "questions_and_answers": [...],
 *   ...
 * }
 *
 * Setup in TidyCal:
 *   Settings → Integrations → Webhooks → Add Webhook
 *   URL: https://ohcdjvbveokyyilceenf.supabase.co/functions/v1/tidycal-webhook
 *   Events: booking.created, booking.cancelled, booking.rescheduled
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

  try {
    const text = await req.text();
    console.log('TidyCal webhook raw body:', text);

    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('TidyCal webhook parsed:', JSON.stringify(payload));

    // TidyCal sends the booking data either at the root or nested under "data"
    const booking = payload.data || payload;
    const event = payload.event || 'booking.created';

    const email = booking.email || booking.attendee_email || null;
    const name = booking.name || booking.attendee_name || null;
    const startsAt = booking.starts_at || booking.start_time || null;
    const endsAt = booking.ends_at || booking.end_time || null;
    const bookingId = String(booking.id || '');
    const bookingType = booking.booking_type?.title || booking.event_type || '30 Minute Meeting';
    const cancelled = booking.cancelled || event === 'booking.cancelled';
    const rescheduled = event === 'booking.rescheduled';

    // Extract IG username from custom questions if provided
    let igUsername: string | null = null;
    if (booking.questions_and_answers) {
      for (const qa of booking.questions_and_answers) {
        const q = (qa.question || '').toLowerCase();
        if (q.includes('instagram') || q.includes('ig')) {
          igUsername = (qa.answer || '').replace(/^@/, '').trim() || null;
          break;
        }
      }
    }

    if (!email) {
      return new Response(JSON.stringify({
        success: true,
        note: 'No email in payload — skipped',
        received_keys: Object.keys(booking),
      }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const now = new Date().toISOString();

    // ── Find existing contact by email or IG ──
    let existing = null;

    const { data: byEmail } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .eq('email', email)
      .maybeSingle();
    existing = byEmail;

    if (!existing && igUsername) {
      const { data: byIg } = await supabase
        .from('swoon_crm_contacts')
        .select('*')
        .eq('ig_username', igUsername)
        .maybeSingle();
      existing = byIg;
    }

    // ── Handle cancellation ──
    if (cancelled) {
      if (existing) {
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
          description: `Cancelled ${bookingType} (was ${startsAt ? new Date(startsAt).toLocaleDateString() : 'unknown date'})`,
          metadata: { booking_id: bookingId, event, ...booking },
        });
      }

      return new Response(JSON.stringify({
        success: true,
        action: 'cancelled',
        contact_id: existing?.id || null,
      }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Handle reschedule ──
    if (rescheduled && existing) {
      await supabase
        .from('swoon_crm_contacts')
        .update({
          call_scheduled_at: startsAt,
          tidycal_event_id: bookingId,
          last_activity_at: now,
          updated_at: now,
        })
        .eq('id', existing.id);

      await supabase.from('swoon_crm_activity').insert({
        contact_id: existing.id,
        activity_type: 'tidycal_rescheduled',
        description: `Rescheduled ${bookingType} to ${startsAt ? new Date(startsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'TBD'}`,
        metadata: { booking_id: bookingId, event, starts_at: startsAt, ends_at: endsAt },
      });

      return new Response(JSON.stringify({
        success: true,
        action: 'rescheduled',
        contact_id: existing.id,
      }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Handle new booking ──
    const callDate = startsAt
      ? new Date(startsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : 'TBD';

    if (existing) {
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
        // Start pre-call reminder sequence
        follow_up_sequence: 'pre_call_reminder',
        follow_up_step: 0,
        follow_up_started_at: now,
        follow_up_paused: false,
      };

      if (!existing.email) updates.email = email;
      if (!existing.full_name && name) updates.full_name = name;
      if (!existing.ig_username && igUsername) updates.ig_username = igUsername;

      await supabase
        .from('swoon_crm_contacts')
        .update(updates)
        .eq('id', existing.id);

      await supabase.from('swoon_crm_activity').insert({
        contact_id: existing.id,
        activity_type: 'tidycal_booked',
        description: `Booked ${bookingType} for ${callDate}`,
        metadata: { booking_id: bookingId, starts_at: startsAt, ends_at: endsAt, booking_type: bookingType },
      });

      // Also log the stage change
      await supabase.from('swoon_crm_activity').insert({
        contact_id: existing.id,
        activity_type: 'stage_change',
        description: 'Moved to call booked (via TidyCal)',
      });

      return new Response(JSON.stringify({
        success: true,
        action: 'updated',
        contact_id: existing.id,
        stage: 'call_booked',
        call_date: callDate,
      }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } else {
      // Create new contact from TidyCal booking
      const { data: newContact, error } = await supabase
        .from('swoon_crm_contacts')
        .insert({
          email,
          full_name: name || null,
          ig_username: igUsername,
          stage: 'call_booked',
          source: 'tidycal',
          call_booked_at: now,
          call_scheduled_at: startsAt,
          tidycal_event_id: bookingId,
          tidycal_event_type: bookingType.toLowerCase().replace(/\s+/g, '-'),
          is_warm: true,
          first_contact_at: now,
          last_activity_at: now,
          follow_up_sequence: 'pre_call_reminder',
          follow_up_step: 0,
          follow_up_started_at: now,
        })
        .select()
        .single();

      if (error) throw error;

      await supabase.from('swoon_crm_activity').insert({
        contact_id: newContact.id,
        activity_type: 'tidycal_booked',
        description: `New lead — booked ${bookingType} for ${callDate}`,
        metadata: { booking_id: bookingId, starts_at: startsAt, ends_at: endsAt, booking_type: bookingType },
      });

      return new Response(JSON.stringify({
        success: true,
        action: 'created',
        contact_id: newContact.id,
        stage: 'call_booked',
        call_date: callDate,
      }), {
        status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

  } catch (error) {
    console.error('TidyCal webhook error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
