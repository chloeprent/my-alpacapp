/**
 * Event Payment Reminder
 * Sends email reminders 10 days before events with outstanding fees
 * (cleaning deposit and/or rental fee)
 *
 * Trigger: Called daily via pg_cron or external cron
 * Deploy: supabase functions deploy event-payment-reminder
 * Manual trigger: curl -X POST YOUR_SUPABASE_URL/functions/v1/event-payment-reminder -H "Authorization: Bearer <anon_key>"
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Calculate the target date: 10 days from now
    const today = new Date();
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() + 10);
    const targetDateStr = targetDate.toISOString().split('T')[0];

    console.log(`Checking for events on ${targetDateStr} (10 days from today)`);

    // Find event hosting requests with events 10 days from now
    // that have outstanding cleaning deposit or rental fee
    const { data: upcomingEvents, error: eventsError } = await supabase
      .from('event_hosting_requests')
      .select(`
        id,
        event_name,
        event_date,
        event_start_time,
        event_end_time,
        rental_fee,
        cleaning_deposit,
        rental_fee_paid,
        cleaning_deposit_paid,
        reservation_fee_paid,
        agreement_status,
        request_status,
        person:person_id (
          id,
          first_name,
          last_name,
          email
        )
      `)
      .eq('event_date', targetDateStr)
      .eq('request_status', 'approved')
      .or('is_archived.is.null,is_archived.eq.false');

    if (eventsError) {
      console.error('Error querying events:', eventsError);
      throw eventsError;
    }

    if (!upcomingEvents || upcomingEvents.length === 0) {
      console.log('No events found 10 days from now');
      return new Response(
        JSON.stringify({ message: 'No events to remind', date: targetDateStr }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get payment methods for the email
    const { data: paymentMethods } = await supabase
      .from('payment_methods')
      .select('name, method_type, account_identifier, instructions')
      .eq('is_active', true)
      .order('display_order');

    // Build payment methods HTML/text
    let paymentMethodsHtml = '';
    let paymentMethodsText = '';
    if (paymentMethods && paymentMethods.length > 0) {
      paymentMethodsHtml = paymentMethods.map(pm => {
        let line = `<li><strong>${pm.name}</strong>`;
        if (pm.account_identifier) line += `: ${pm.account_identifier}`;
        if (pm.instructions) line += `<br><span style="color: #666; font-size: 0.9em;">${pm.instructions}</span>`;
        line += '</li>';
        return line;
      }).join('\n');

      paymentMethodsText = paymentMethods.map(pm => {
        let line = `- ${pm.name}`;
        if (pm.account_identifier) line += `: ${pm.account_identifier}`;
        if (pm.instructions) line += ` (${pm.instructions})`;
        return line;
      }).join('\n');
    }

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) {
      console.log('RESEND_API_KEY not configured, skipping emails');
      return new Response(
        JSON.stringify({ error: 'RESEND_API_KEY not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let remindersSent = 0;
    let errors = 0;

    for (const event of upcomingEvents) {
      const person = event.person as { id: string; first_name: string; last_name: string; email: string } | null;

      if (!person?.email) {
        console.log(`Skipping event ${event.id} - no email address`);
        continue;
      }

      // Check what's outstanding
      const cleaningDepositDue = !event.cleaning_deposit_paid;
      const rentalFeeDue = !event.rental_fee_paid;

      if (!cleaningDepositDue && !rentalFeeDue) {
        console.log(`Skipping event ${event.id} - all fees paid`);
        continue;
      }

      const rentalFee = event.rental_fee || 295;
      const cleaningDeposit = event.cleaning_deposit || 195;

      // Calculate what's owed
      let outstandingItems: { label: string; amount: number }[] = [];
      if (cleaningDepositDue) {
        outstandingItems.push({ label: 'Cleaning Deposit', amount: cleaningDeposit });
      }
      if (rentalFeeDue) {
        outstandingItems.push({ label: 'Rental Fee', amount: rentalFee });
      }

      const totalOutstanding = outstandingItems.reduce((sum, item) => sum + item.amount, 0);

      // Format event date
      const eventDate = new Date(event.event_date + 'T12:00:00');
      const eventDateFormatted = eventDate.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      });

      // Payment due date (7 days before event = 3 days from now)
      const dueDate = new Date(eventDate);
      dueDate.setDate(dueDate.getDate() - 7);
      const paymentDueDate = dueDate.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      });

      // Format event time
      let eventTimeFormatted = '';
      if (event.event_start_time && event.event_end_time) {
        const formatTime = (t: string) => {
          const [h, m] = t.split(':');
          const hour = parseInt(h);
          const ampm = hour >= 12 ? 'PM' : 'AM';
          const h12 = hour % 12 || 12;
          return `${h12}:${m} ${ampm}`;
        };
        eventTimeFormatted = `${formatTime(event.event_start_time)} - ${formatTime(event.event_end_time)}`;
      }

      // Build outstanding items HTML
      const itemsHtml = outstandingItems.map(item =>
        `<tr>
          <td style="padding: 8px 0;"><strong>${item.label}:</strong></td>
          <td style="padding: 8px 0; text-align: right; font-size: 1.1em; font-weight: bold; color: #3d8b7a;">$${item.amount}</td>
        </tr>`
      ).join('\n');

      const itemsText = outstandingItems.map(item =>
        `${item.label}: $${item.amount}`
      ).join('\n');

      try {
        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Property Team <team@YOUR_DOMAIN>',
            to: [person.email],
            reply_to: 'team@YOUR_DOMAIN',
            subject: `Payment Reminder: ${event.event_name} - Fees Due in 3 Days`,
            html: `
              <h2>Payment Reminder - Your Event is Coming Up!</h2>
              <p>Hi ${person.first_name},</p>
              <p>This is a friendly reminder that your event <strong>${event.event_name}</strong> is <strong>10 days away</strong>! We're excited to host you.</p>

              <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <h3 style="margin-top: 0; color: #856404;">Outstanding Fees - Due in 3 Days</h3>
                <p>The following fees must be received by <strong>${paymentDueDate}</strong> (7 days before your event):</p>
                <table style="border-collapse: collapse; width: 100%; max-width: 400px;">
                  ${itemsHtml}
                  <tr style="border-top: 2px solid #ddd;">
                    <td style="padding: 8px 0;"><strong>Total Due:</strong></td>
                    <td style="padding: 8px 0; text-align: right; font-size: 1.3em; font-weight: bold; color: #3d8b7a;">$${totalOutstanding}</td>
                  </tr>
                </table>
                ${cleaningDepositDue ? '<p style="font-size: 0.9em; color: #666; margin-top: 10px; margin-bottom: 0;">The cleaning deposit is fully refundable after your event, provided the venue is cleaned per the agreement.</p>' : ''}
              </div>

              <h3>Payment Options</h3>
              <ul style="line-height: 1.8;">
                ${paymentMethodsHtml}
              </ul>
              <p><strong>Important:</strong> Please include your name and "${event.event_name}" in the payment memo.</p>

              <div style="background: #e5f4f1; border-left: 4px solid #3d8b7a; padding: 15px; margin: 20px 0;">
                <strong>Event:</strong> ${event.event_name}<br>
                <strong>Date:</strong> ${eventDateFormatted}<br>
                ${eventTimeFormatted ? `<strong>Time:</strong> ${eventTimeFormatted}` : ''}
              </div>

              <p><strong>Quick Reminders:</strong></p>
              <ul>
                <li>Setup crew must arrive 90 minutes before your event</li>
                <li>Direct attendees to <a href="https://YOUR_DOMAIN/visiting">YOUR_DOMAIN/visiting</a> for directions (do NOT post the address publicly)</li>
                <li>Cleanup must be completed by 1:01pm the day after your event</li>
              </ul>

              <p>Questions? Reply to this email or contact us at team@YOUR_DOMAIN</p>
              <p>Best regards,<br>YOUR_PROPERTY_NAME</p>
            `,
            text: `Payment Reminder - Your Event is Coming Up!

Hi ${person.first_name},

This is a friendly reminder that your event ${event.event_name} is 10 days away! We're excited to host you.

OUTSTANDING FEES - DUE IN 3 DAYS
---------------------------------
${itemsText}
Total Due: $${totalOutstanding}
Due By: ${paymentDueDate}

${cleaningDepositDue ? 'The cleaning deposit is fully refundable after your event, provided the venue is cleaned per the agreement.\n' : ''}
PAYMENT OPTIONS
---------------
${paymentMethodsText}

Important: Please include your name and "${event.event_name}" in the payment memo.

EVENT DETAILS
-------------
Event: ${event.event_name}
Date: ${eventDateFormatted}
${eventTimeFormatted ? `Time: ${eventTimeFormatted}` : ''}

QUICK REMINDERS
---------------
- Setup crew must arrive 90 minutes before your event
- Direct attendees to YOUR_DOMAIN/visiting for directions (do NOT post the address publicly)
- Cleanup must be completed by 1:01pm the day after your event

Questions? Reply to this email or contact us at team@YOUR_DOMAIN

Best regards,
YOUR_PROPERTY_NAME`,
          }),
        });

        if (emailResponse.ok) {
          console.log(`Reminder sent to ${person.email} for event ${event.event_name}`);
          remindersSent++;

          // Record that reminder was sent
          await supabase
            .from('event_hosting_requests')
            .update({
              payment_reminder_sent_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', event.id);
        } else {
          const emailError = await emailResponse.json();
          console.error(`Failed to send reminder for event ${event.id}:`, emailError);
          errors++;
        }
      } catch (emailErr) {
        console.error(`Error sending reminder for event ${event.id}:`, emailErr);
        errors++;
      }
    }

    console.log(`Reminders complete: ${remindersSent} sent, ${errors} errors`);

    return new Response(
      JSON.stringify({
        success: true,
        date: targetDateStr,
        eventsFound: upcomingEvents.length,
        remindersSent,
        errors,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Reminder processing error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
