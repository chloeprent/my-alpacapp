/**
 * Event Staff Notification Handler
 * Called after event staff are submitted on the agreement page.
 * 1. Sends admin notification that staff were submitted
 * 2. Sends each staff member a confirmation email with event details
 *
 * Deploy: supabase functions deploy event-staff-notify --no-verify-jwt
 */

import { corsHeadersOpen } from "../_shared/api-helpers.ts";

interface StaffMember {
  role: string;
  name: string;
  email: string;
  arrival: string;
  required: string;
}

interface NotifyPayload {
  event_request_id: string;
  host_name: string;
  host_email: string;
  event_name: string;
  event_date: string;
  event_time: string;
  event_location: string;
  staff: StaffMember[];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeadersOpen });
  }

  try {
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY not configured');
    }

    const payload: NotifyPayload = await req.json();
    console.log('Event staff notify received:', JSON.stringify(payload));

    const {
      event_request_id,
      host_name,
      host_email,
      event_name,
      event_date,
      event_time,
      event_location,
      staff,
    } = payload;

    const ADMIN_EMAIL = 'alpacaplayhouse@gmail.com';
    const results: string[] = [];

    // 1. Send admin notification
    const staffTableRows = staff
      .map(s => `<tr>
        <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">${s.role}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${s.name}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${s.email || 'N/A'}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${s.arrival || 'N/A'}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${s.required}</td>
      </tr>`)
      .join('\n');

    const staffTextRows = staff
      .map(s => `  ${s.role}: ${s.name} (${s.email || 'no email'}) - arriving ${s.arrival || 'TBD'} - required ${s.required}`)
      .join('\n');

    const adminRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Alpaca Team <team@alpacaplayhouse.com>',
        to: [ADMIN_EMAIL],
        subject: `Staff Submitted for ${event_name} by ${host_name}`,
        html: `
          <h2>Event Staff Submitted</h2>
          <p><strong>${host_name}</strong> (${host_email}) has submitted their staff assignments for the event.</p>
          <div style="background: #e8f5e9; border-left: 4px solid #4caf50; padding: 15px; margin: 20px 0;">
            <strong>Event:</strong> ${event_name}<br>
            <strong>Date:</strong> ${event_date}<br>
            <strong>Time:</strong> ${event_time}<br>
            <strong>Location:</strong> ${event_location}
          </div>
          <h3>Staff Assignments</h3>
          <table style="width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #ddd;">
            <thead>
              <tr style="background: #1a1a2e; color: #fff;">
                <th style="padding: 10px; text-align: left;">Role</th>
                <th style="padding: 10px; text-align: left;">Name</th>
                <th style="padding: 10px; text-align: left;">Email</th>
                <th style="padding: 10px; text-align: left;">Arrival</th>
                <th style="padding: 10px; text-align: left;">Required</th>
              </tr>
            </thead>
            <tbody>${staffTableRows}</tbody>
          </table>
          <p style="margin-top: 16px;"><a href="https://alpacaplayhouse.com/admin/events.html">View in Admin</a></p>
          <div style="text-align: center; padding: 16px;"><img src="https://alpacaplayhouse.com/assets/branding/alpaca-head-white-transparent.png" alt="" style="height: 40px; margin: 0 8px;" /><img src="https://alpacaplayhouse.com/assets/Alpaca%20Playhouse%20Highlights/Alpaca.jpg" alt="" style="height: 80px; border-radius: 8px; margin: 0 8px;" /></div>
        `,
        text: `Event Staff Submitted\n\n${host_name} (${host_email}) has submitted staff for:\n\nEvent: ${event_name}\nDate: ${event_date}\nTime: ${event_time}\nLocation: ${event_location}\n\nStaff:\n${staffTextRows}`,
      }),
    });

    if (adminRes.ok) {
      results.push('Admin notification sent');
      console.log('Admin staff notification sent');
    } else {
      const err = await adminRes.json();
      console.error('Admin email failed:', err);
      results.push('Admin notification failed');
    }

    // 2. Send each staff member a confirmation email
    for (const member of staff) {
      if (!member.email) {
        results.push(`${member.role}: no email, skipped`);
        continue;
      }

      const firstName = member.name.split(/\s+/)[0] || member.name;

      const staffRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Alpaca Team <team@alpacaplayhouse.com>',
          to: [member.email],
          reply_to: 'team@alpacaplayhouse.com',
          subject: `You're signed up to staff: ${event_name} - ${event_date}`,
          html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <div style="background: #1a1a2e; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
    <img src="https://alpacaplayhouse.com/assets/branding/alpaca-head-white-transparent.png" alt="Alpaca Playhouse" style="height: 50px;" />
    <h1 style="color: #fff; margin: 12px 0 0; font-size: 20px;">Event Staff Assignment</h1>
  </div>

  <div style="padding: 24px; background: #f9f9f9;">
    <p>Hi ${firstName},</p>
    <p>You've been signed up by <strong>${host_name}</strong> to help staff an event at Alpaca Playhouse. Here are the details:</p>

    <div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 16px 0;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #666; width: 120px;">Event</td>
          <td style="padding: 8px 0; font-weight: bold;">${event_name}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666;">Date</td>
          <td style="padding: 8px 0; font-weight: bold;">${event_date}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666;">Your Role</td>
          <td style="padding: 8px 0; font-weight: bold; color: #4a6cf7;">${member.role}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666;">Your Hours</td>
          <td style="padding: 8px 0; font-weight: bold;">${member.required}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666;">Location</td>
          <td style="padding: 8px 0; font-weight: bold;">${event_location}</td>
        </tr>
      </table>
    </div>

    <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 16px; margin: 16px 0;">
      <p style="margin: 0; font-weight: bold; color: #856404;">Important: Please reply to this email with "Yes" to confirm you will be able to arrive on time and staff this event.</p>
    </div>

    <p style="color: #666; font-size: 0.9em;">If you have any questions about your role or the event, please reply to this email and we'll get back to you promptly.</p>

    <p>Thank you for helping make this event a success!</p>
    <p>Best,<br/><strong>Alpaca Playhouse</strong></p>
  </div>

  <div style="text-align: center; padding: 16px;">
    <img src="https://alpacaplayhouse.com/assets/branding/alpaca-head-white-transparent.png" alt="" style="height: 35px; margin: 0 8px;" />
    <img src="https://alpacaplayhouse.com/assets/Alpaca%20Playhouse%20Highlights/Alpaca.jpg" alt="" style="height: 60px; border-radius: 8px; margin: 0 8px;" />
  </div>
</div>`,
          text: `Hi ${firstName},

You've been signed up by ${host_name} to help staff an event at Alpaca Playhouse.

EVENT DETAILS
-------------
Event: ${event_name}
Date: ${event_date}
Your Role: ${member.role}
Your Hours: ${member.required}
Location: ${event_location}

IMPORTANT: Please reply to this email with "Yes" to confirm you will be able to arrive on time and staff this event.

If you have any questions about your role or the event, please reply to this email.

Thank you for helping make this event a success!

Best,
Alpaca Playhouse`,
        }),
      });

      if (staffRes.ok) {
        results.push(`${member.role} (${member.email}): sent`);
        console.log(`Staff email sent to ${member.email} for role ${member.role}`);
      } else {
        const err = await staffRes.json();
        console.error(`Staff email failed for ${member.email}:`, err);
        results.push(`${member.role} (${member.email}): failed`);
      }
    }

    return new Response(
      JSON.stringify({ success: true, results }),
      { headers: { ...corsHeadersOpen, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Event staff notify error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeadersOpen, 'Content-Type': 'application/json' } }
    );
  }
});
