/**
 * Work Photo Reminder
 * Sends email reminders if an associate hasn't uploaded before/after photos.
 *
 * Modes:
 *   1. Single-entry: POST { time_entry_id } — checks one entry (called from client 15min after clock-in)
 *   2. Batch scan: POST {} — scans all recent entries (legacy/fallback)
 *
 * Deploy: supabase functions deploy work-photo-reminder
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) {
      console.log('RESEND_API_KEY not configured, skipping');
      return new Response(
        JSON.stringify({ error: 'RESEND_API_KEY not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse optional time_entry_id from body
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body is fine */ }
    const targetEntryId = body?.time_entry_id;

    let remindersSent = 0;
    let errors = 0;

    // --- Clock-in reminders (missing "before" photos) ---
    let query = supabase
      .from('time_entries')
      .select(`
        id,
        clock_in,
        space_id,
        associate:associate_id (
          id,
          app_user:app_user_id (
            id,
            email,
            first_name,
            display_name
          )
        ),
        space:space_id (
          name
        )
      `)
      .is('photo_reminder_clockin_sent_at', null);

    if (targetEntryId) {
      // Single-entry mode: check just this entry
      query = query.eq('id', targetEntryId);
    } else {
      // Batch mode: scan recent entries
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      query = query.lte('clock_in', fifteenMinAgo).gte('clock_in', twentyFourHoursAgo);
    }

    const { data: clockInEntries, error: clockInError } = await query;

    if (clockInError) {
      console.error('Error querying clock-in entries:', clockInError);
      throw clockInError;
    }

    if (clockInEntries && clockInEntries.length > 0) {
      // Get all time_entry IDs to check for existing "before" photos
      const entryIds = clockInEntries.map(e => e.id);
      const { data: beforePhotos } = await supabase
        .from('work_photos')
        .select('time_entry_id')
        .in('time_entry_id', entryIds)
        .eq('photo_type', 'before');

      const entriesWithBeforePhotos = new Set((beforePhotos || []).map(p => p.time_entry_id));

      for (const entry of clockInEntries) {
        if (entriesWithBeforePhotos.has(entry.id)) continue; // already has before photo

        const associate = entry.associate as any;
        const appUser = associate?.app_user;
        if (!appUser?.email) {
          console.log(`Skipping entry ${entry.id} - no email`);
          continue;
        }

        const firstName = appUser.first_name || appUser.display_name || 'there';
        const spaceName = (entry.space as any)?.name || '';

        try {
          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'Property Team <team@YOUR_DOMAIN>',
              to: [appUser.email, 'automation@YOUR_DOMAIN'],
              reply_to: 'team@YOUR_DOMAIN',
              subject: 'Reminder: Upload Before Photos for Your Work Session',
              html: buildHtml(firstName, 'clock_in', spaceName),
              text: buildText(firstName, 'clock_in', spaceName),
            }),
          });

          if (emailRes.ok) {
            console.log(`Clock-in reminder sent to ${appUser.email} for entry ${entry.id}`);
            remindersSent++;
            await supabase
              .from('time_entries')
              .update({ photo_reminder_clockin_sent_at: new Date().toISOString() })
              .eq('id', entry.id);
          } else {
            const err = await emailRes.json();
            console.error(`Failed to send clock-in reminder for ${entry.id}:`, err);
            errors++;
          }
        } catch (emailErr) {
          console.error(`Error sending clock-in reminder for ${entry.id}:`, emailErr);
          errors++;
        }
      }
    }

    // --- Clock-out reminders (missing "after" photos) ---
    let clockOutQuery = supabase
      .from('time_entries')
      .select(`
        id,
        clock_out,
        space_id,
        associate:associate_id (
          id,
          app_user:app_user_id (
            id,
            email,
            first_name,
            display_name
          )
        ),
        space:space_id (
          name
        )
      `)
      .is('photo_reminder_clockout_sent_at', null)
      .not('clock_out', 'is', null);

    if (targetEntryId) {
      // Single-entry mode: check just this entry (called from client after clock-out)
      clockOutQuery = clockOutQuery.eq('id', targetEntryId);
    } else {
      // Batch mode: scan recent entries
      const fifteenMinAgoOut = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const twentyFourHoursAgoOut = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      clockOutQuery = clockOutQuery.lte('clock_out', fifteenMinAgoOut).gte('clock_out', twentyFourHoursAgoOut);
    }

    {
    const { data: clockOutEntries, error: clockOutError } = await clockOutQuery;

    if (clockOutError) {
      console.error('Error querying clock-out entries:', clockOutError);
      throw clockOutError;
    }

    if (clockOutEntries && clockOutEntries.length > 0) {
      const entryIds = clockOutEntries.map(e => e.id);
      const { data: afterPhotos } = await supabase
        .from('work_photos')
        .select('time_entry_id')
        .in('time_entry_id', entryIds)
        .eq('photo_type', 'after');

      const entriesWithAfterPhotos = new Set((afterPhotos || []).map(p => p.time_entry_id));

      for (const entry of clockOutEntries) {
        if (entriesWithAfterPhotos.has(entry.id)) continue;

        const associate = entry.associate as any;
        const appUser = associate?.app_user;
        if (!appUser?.email) {
          console.log(`Skipping entry ${entry.id} - no email`);
          continue;
        }

        const firstName = appUser.first_name || appUser.display_name || 'there';
        const spaceName = (entry.space as any)?.name || '';

        try {
          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'Property Team <team@YOUR_DOMAIN>',
              to: [appUser.email, 'automation@YOUR_DOMAIN'],
              reply_to: 'team@YOUR_DOMAIN',
              subject: 'Reminder: Upload After Photos for Your Work Session',
              html: buildHtml(firstName, 'clock_out', spaceName),
              text: buildText(firstName, 'clock_out', spaceName),
            }),
          });

          if (emailRes.ok) {
            console.log(`Clock-out reminder sent to ${appUser.email} for entry ${entry.id}`);
            remindersSent++;
            await supabase
              .from('time_entries')
              .update({ photo_reminder_clockout_sent_at: new Date().toISOString() })
              .eq('id', entry.id);
          } else {
            const err = await emailRes.json();
            console.error(`Failed to send clock-out reminder for ${entry.id}:`, err);
            errors++;
          }
        } catch (emailErr) {
          console.error(`Error sending clock-out reminder for ${entry.id}:`, emailErr);
          errors++;
        }
      }
    }
    } // end clock-out reminders block

    // Log API usage
    if (remindersSent > 0) {
      await supabase.from('api_usage_log').insert({
        vendor: 'resend',
        category: 'email_tenant_notification',
        endpoint: 'send-email',
        units: remindersSent,
        unit_type: 'emails',
        estimated_cost_usd: remindersSent * 0.00028,
        metadata: { template: 'work_photo_reminder' },
      });
    }

    console.log(`Work photo reminders: ${remindersSent} sent, ${errors} errors`);

    return new Response(
      JSON.stringify({ success: true, remindersSent, errors }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Work photo reminder error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

const WORK_PAGE_URL = 'https://YOUR_DOMAIN/associates/worktracking.html';

function buildHtml(firstName: string, phase: 'clock_in' | 'clock_out', spaceName: string): string {
  const isClockIn = phase === 'clock_in';
  const photoType = isClockIn ? '"Before"' : '"After"';
  const suggestion = isClockIn
    ? 'a quick "before" photo of the space before you start working'
    : 'an "after" photo showing your completed work';
  const action = isClockIn ? 'clocked in' : 'clocked out';
  const atSpace = spaceName ? ` at <strong>${spaceName}</strong>` : '';

  return `
    <h2>Work Photo Reminder</h2>
    <p>Hi ${firstName},</p>
    <p>You recently ${action}${atSpace} but we noticed you haven't uploaded any ${photoType} photos yet.</p>
    <p>If relevant to your task, consider uploading ${suggestion}. Work photos help track progress and quality.</p>
    <div style="text-align: center; margin: 24px 0;">
      <a href="${WORK_PAGE_URL}" style="display: inline-block; background: #3d8b7a; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Upload Photos</a>
    </div>
    <p style="color: #666; font-size: 0.9em;">This is just a friendly nudge — no photos are required if they aren't relevant to the task.</p>
    <p>Thanks,<br>YOUR_PROPERTY_NAME</p>
  `;
}

function buildText(firstName: string, phase: 'clock_in' | 'clock_out', spaceName: string): string {
  const isClockIn = phase === 'clock_in';
  const photoType = isClockIn ? '"Before"' : '"After"';
  const suggestion = isClockIn
    ? 'a quick "before" photo of the space before you start working'
    : 'an "after" photo showing your completed work';
  const action = isClockIn ? 'clocked in' : 'clocked out';
  const atSpace = spaceName ? ` at ${spaceName}` : '';

  return `Work Photo Reminder

Hi ${firstName},

You recently ${action}${atSpace} but we noticed you haven't uploaded any ${photoType} photos yet.

If relevant to your task, consider uploading ${suggestion}. Work photos help track progress and quality.

Upload photos: ${WORK_PAGE_URL}

This is just a friendly nudge — no photos are required if they aren't relevant to the task.

Thanks,
YOUR_PROPERTY_NAME`;
}
