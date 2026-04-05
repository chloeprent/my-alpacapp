/**
 * SignWell Webhook Handler
 * Receives webhook notifications when documents are signed
 * Handles both rental lease agreements and event hosting agreements
 *
 * Deploy with: supabase functions deploy signwell-webhook
 * Webhook URL: YOUR_SUPABASE_URL/functions/v1/signwell-webhook
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SignWellWebhookPayload {
  event: string;
  document_id: string;
  document_name: string;
  status: string;
  completed_at?: string;
  recipients?: Array<{
    name: string;
    email: string;
    status: string;
    signed_at?: string;
  }>;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse webhook payload
    const payload: SignWellWebhookPayload = await req.json();
    console.log('SignWell webhook received:', payload);

    // Only handle document_completed events
    if (payload.event !== 'document_completed') {
      console.log(`Ignoring event: ${payload.event}`);
      return new Response(
        JSON.stringify({ message: 'Event ignored', event: payload.event }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const documentId = payload.document_id;

    // Try to find a rental application with this SignWell document ID
    const { data: rentalApp, error: rentalError } = await supabase
      .from('rental_applications')
      .select(`
        id,
        agreement_document_url,
        approved_rate,
        approved_rate_term,
        security_deposit_amount,
        reservation_deposit_amount,
        application_fee_paid,
        application_fee_amount,
        approved_move_in,
        waiver_template_id,
        approved_space:approved_space_id (
          id,
          name
        ),
        person:person_id (
          id,
          first_name,
          last_name,
          email
        )
      `)
      .eq('signwell_document_id', documentId)
      .single();

    // Try to find an event hosting request with this SignWell document ID
    const { data: eventRequest, error: eventError } = await supabase
      .from('event_hosting_requests')
      .select(`
        id,
        event_name,
        event_date,
        event_start_time,
        event_end_time,
        rental_fee,
        reservation_fee,
        cleaning_deposit,
        reservation_fee_paid,
        cleaning_deposit_paid,
        agreement_document_url,
        person:person_id (
          id,
          first_name,
          last_name,
          email
        )
      `)
      .eq('signwell_document_id', documentId)
      .single();

    // Determine which type of document this is
    const isRental = !rentalError && rentalApp;
    const isEvent = !eventError && eventRequest;

    if (!isRental && !isEvent) {
      console.error('No matching application/request found for document:', documentId);
      return new Response(
        JSON.stringify({ error: 'Document not found in system' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get SignWell config for API key
    const { data: config, error: configError } = await supabase
      .from('signwell_config')
      .select('api_key')
      .single();

    if (configError || !config?.api_key) {
      console.error('SignWell config not found');
      return new Response(
        JSON.stringify({ error: 'SignWell not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Download the signed PDF from SignWell
    const pdfResponse = await fetch(
      `https://www.signwell.com/api/v1/documents/${documentId}/completed_pdf`,
      {
        headers: {
          'X-Api-Key': config.api_key,
        },
      }
    );

    if (!pdfResponse.ok) {
      throw new Error(`Failed to download signed PDF: ${pdfResponse.status}`);
    }

    const pdfBlob = await pdfResponse.blob();
    const pdfBuffer = await pdfBlob.arrayBuffer();

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

    // Process based on document type
    if (isRental) {
      return await processRentalAgreement(
        supabase, rentalApp, pdfBuffer, paymentMethodsHtml, paymentMethodsText, documentId, payload
      );
    } else if (isEvent) {
      return await processEventAgreement(
        supabase, eventRequest, pdfBuffer, paymentMethodsHtml, paymentMethodsText, documentId
      );
    }

    // Should never reach here
    return new Response(
      JSON.stringify({ error: 'Unknown document type' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Webhook processing error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// Process rental lease agreement
async function processRentalAgreement(
  supabase: any,
  application: any,
  pdfBuffer: ArrayBuffer,
  paymentMethodsHtml: string,
  paymentMethodsText: string,
  documentId: string,
  payload?: SignWellWebhookPayload
) {
  const person = application.person as { id: string; first_name: string; last_name: string; email: string } | null;
  const tenantName = person
    ? `${person.first_name || ''} ${person.last_name || ''}`.trim().replace(/[^a-zA-Z0-9\s]/g, '').substring(0, 30)
    : 'Unknown';
  const dateStr = new Date().toISOString().split('T')[0];
  const storagePath = `signed-lease-${application.id}-${Date.now()}.pdf`;

  // Upload to Supabase storage
  const { error: uploadError } = await supabase.storage
    .from('lease-documents')
    .upload(`signed/${storagePath}`, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) {
    console.error('Error uploading signed PDF:', uploadError);
    throw uploadError;
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from('lease-documents')
    .getPublicUrl(`signed/${storagePath}`);

  const signedPdfUrl = urlData.publicUrl;

  // Update the rental application
  const { error: updateError } = await supabase
    .from('rental_applications')
    .update({
      agreement_status: 'signed',
      agreement_signed_at: new Date().toISOString(),
      signed_pdf_url: signedPdfUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', application.id);

  if (updateError) {
    console.error('Error updating application:', updateError);
    throw updateError;
  }

  console.log(`Rental document ${documentId} signed and processed successfully`);

  // Record waiver signature if a waiver was included in the lease
  if (application.waiver_template_id) {
    try {
      // Look up the waiver template version
      const { data: waiverTemplate } = await supabase
        .from('lease_templates')
        .select('id, version, type')
        .eq('id', application.waiver_template_id)
        .single();

      const tenantRecipient = payload?.recipients?.find((r: any) => r.email !== 'admin@YOUR_DOMAIN');
      const signerName = person ? `${person.first_name || ''} ${person.last_name || ''}`.trim() : 'Unknown';

      await supabase.from('waiver_signatures').insert({
        waiver_type: 'renter_waiver',
        template_version: waiverTemplate?.version || 1,
        signer_name: signerName,
        signer_email: person?.email || '',
        person_id: person?.id || null,
        rental_application_id: application.id,
        signwell_document_id: documentId,
        signed_pdf_url: signedPdfUrl,
        signed_at: tenantRecipient?.signed_at || new Date().toISOString(),
      });

      console.log(`Waiver signature recorded for rental application ${application.id}`);
    } catch (waiverErr) {
      // Don't fail the whole webhook if waiver recording fails
      console.error('Error recording waiver signature:', waiverErr);
    }
  }

  // Calculate amounts
  const reservationDeposit = application.reservation_deposit_amount || application.approved_rate || 0;
  const spaceName = (application.approved_space as { id: string; name: string } | null)?.name || 'your space';

  // Format move-in date
  let moveInDateFormatted = 'TBD';
  if (application.approved_move_in) {
    const moveInDate = new Date(application.approved_move_in + 'T12:00:00');
    moveInDateFormatted = moveInDate.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  }

  // Send email notification
  if (person?.email) {
    await sendRentalSignedEmail(
      person, spaceName, reservationDeposit, moveInDateFormatted,
      application.approved_rate, application.approved_rate_term,
      paymentMethodsHtml, paymentMethodsText
    );

    // Look up vehicles assigned to this person for the registration email
    let vehicleInfo = null;
    try {
      const { data: driverRecords } = await supabase
        .from('vehicle_drivers')
        .select('vehicle:vehicle_id (make, model, year, color, vin, name)')
        .eq('person_id', person.id);

      if (driverRecords && driverRecords.length > 0) {
        const v = driverRecords[0].vehicle as any;
        if (v) {
          vehicleInfo = {
            make: v.make || '',
            model: v.model || '',
            year: v.year || '',
            color: v.color || '',
            vin: v.vin || '',
            name: v.name || '',
          };
        }
      }
    } catch (vErr) {
      console.error('Error looking up vehicle for registration email:', vErr);
    }

    // Send vehicle registration email (separate email so it's not buried)
    await sendVehicleRegistrationEmail(person, vehicleInfo);
  }

  return new Response(
    JSON.stringify({
      success: true,
      type: 'rental',
      message: 'Rental lease signed and processed',
      applicationId: application.id,
      signedPdfUrl,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Process event hosting agreement
async function processEventAgreement(
  supabase: any,
  eventRequest: any,
  pdfBuffer: ArrayBuffer,
  paymentMethodsHtml: string,
  paymentMethodsText: string,
  documentId: string
) {
  const person = eventRequest.person as { id: string; first_name: string; last_name: string; email: string } | null;
  const hostName = person
    ? `${person.first_name || ''} ${person.last_name || ''}`.trim().replace(/[^a-zA-Z0-9\s]/g, '').substring(0, 30)
    : 'Unknown';
  const dateStr = new Date().toISOString().split('T')[0];
  const storagePath = `signed-event-${eventRequest.id}-${Date.now()}.pdf`;

  // Upload to Supabase storage
  const { error: uploadError } = await supabase.storage
    .from('lease-documents')
    .upload(`signed/${storagePath}`, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) {
    console.error('Error uploading signed event PDF:', uploadError);
    throw uploadError;
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from('lease-documents')
    .getPublicUrl(`signed/${storagePath}`);

  const signedPdfUrl = urlData.publicUrl;

  // Update the event hosting request
  const { error: updateError } = await supabase
    .from('event_hosting_requests')
    .update({
      agreement_status: 'signed',
      agreement_signed_at: new Date().toISOString(),
      signed_pdf_url: signedPdfUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', eventRequest.id);

  if (updateError) {
    console.error('Error updating event request:', updateError);
    throw updateError;
  }

  console.log(`Event document ${documentId} signed and processed successfully`);

  // Calculate fees due 7 days before event (cleaning deposit + rental fee)
  const rentalFee = eventRequest.rental_fee || 295;
  const cleaningDeposit = eventRequest.cleaning_deposit || 195;

  // Format event date
  let eventDateFormatted = 'TBD';
  let paymentDueDate = 'at least 7 days before your event';
  if (eventRequest.event_date) {
    const eventDate = new Date(eventRequest.event_date + 'T12:00:00');
    eventDateFormatted = eventDate.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });

    // Calculate payment due date (7 days before event)
    const dueDate = new Date(eventDate);
    dueDate.setDate(dueDate.getDate() - 7);
    paymentDueDate = dueDate.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  }

  // Format event time
  let eventTimeFormatted = '';
  if (eventRequest.event_start_time && eventRequest.event_end_time) {
    const formatTime = (t: string) => {
      const [h, m] = t.split(':');
      const hour = parseInt(h);
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const h12 = hour % 12 || 12;
      return `${h12}:${m} ${ampm}`;
    };
    eventTimeFormatted = `${formatTime(eventRequest.event_start_time)} - ${formatTime(eventRequest.event_end_time)}`;
  }

  // Send email notification
  if (person?.email) {
    await sendEventSignedEmail(
      person, eventRequest.event_name, eventDateFormatted, eventTimeFormatted,
      rentalFee, cleaningDeposit, paymentDueDate, paymentMethodsHtml, paymentMethodsText
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      type: 'event',
      message: 'Event agreement signed and processed',
      eventRequestId: eventRequest.id,
      signedPdfUrl,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Send rental lease signed email
async function sendRentalSignedEmail(
  person: { first_name: string; last_name: string; email: string },
  spaceName: string,
  reservationDeposit: number,
  moveInDate: string,
  monthlyRate: number,
  rateTerm: string,
  paymentMethodsHtml: string,
  paymentMethodsText: string
) {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  if (!RESEND_API_KEY) {
    console.log('RESEND_API_KEY not configured, skipping email');
    return;
  }

  try {
    const rateTermDisplay = rateTerm === 'weekly' ? 'week' : rateTerm === 'nightly' ? 'night' : 'month';

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
        subject: 'Lease Signed - Reservation Deposit Due - YOUR_PROPERTY_NAME',
        html: `
          <h2>Lease Signing Complete!</h2>
          <p>Hi ${person.first_name},</p>
          <p>Congratulations! Your lease agreement for <strong>${spaceName}</strong> has been successfully signed by both parties.</p>

          <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #3d8b7a;">Reservation Deposit Due</h3>
            <p>To secure your space, please submit your reservation deposit:</p>
            <table style="border-collapse: collapse; width: 100%; max-width: 400px;">
              <tr>
                <td style="padding: 8px 0;"><strong>Reservation Deposit:</strong></td>
                <td style="padding: 8px 0; text-align: right; font-size: 1.2em; font-weight: bold; color: #3d8b7a;">$${reservationDeposit}</td>
              </tr>
            </table>
            <p style="font-size: 0.9em; color: #666; margin-bottom: 0;">This amount will be credited toward your first month's rent.</p>
          </div>

          <h3>Payment Options</h3>
          <ul style="line-height: 1.8;">
            ${paymentMethodsHtml}
          </ul>
          <p><strong>Important:</strong> Please include your name and "Reservation Deposit" in the payment memo.</p>

          <div style="background: #e5f4f1; border-left: 4px solid #3d8b7a; padding: 15px; margin: 20px 0;">
            <strong>Move-in Date:</strong> ${moveInDate}<br>
            <strong>Monthly Rent:</strong> $${monthlyRate || 'TBD'}/${rateTermDisplay}
          </div>

          <div style="background: #f0f7ff; border-radius: 8px; padding: 20px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #3d8b7a;">Set Up Your Resident Profile</h3>
            <p>While you're here, take a minute to fill out your resident profile. This helps your housemates get to know you before you arrive!</p>
            <p style="margin-bottom: 0;"><a href="https://YOUR_DOMAIN/residents/profile.html" style="display: inline-block; background: #3d8b7a; color: #fff; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Complete Your Profile</a></p>
          </div>

          <p>Once we receive your reservation deposit, we'll send confirmation and prepare for your arrival.</p>
          <p>Questions? Reply to this email or contact us at team@YOUR_DOMAIN</p>
          <p>Best regards,<br>YOUR_PROPERTY_NAME</p>
        `,
        text: `Lease Signing Complete!

Hi ${person.first_name},

Congratulations! Your lease agreement for ${spaceName} has been successfully signed by both parties.

RESERVATION DEPOSIT DUE
-----------------------
Reservation Deposit: $${reservationDeposit}

This amount will be credited toward your first month's rent.

PAYMENT OPTIONS
---------------
${paymentMethodsText}

Important: Please include your name and "Reservation Deposit" in the payment memo.

Move-in Date: ${moveInDate}
Monthly Rent: $${monthlyRate || 'TBD'}/${rateTermDisplay}

SET UP YOUR RESIDENT PROFILE
-----------------------------
Take a minute to fill out your resident profile — it helps your housemates get to know you before you arrive!
https://YOUR_DOMAIN/residents/profile.html

Once we receive your reservation deposit, we'll send confirmation and prepare for your arrival.

Questions? Reply to this email or contact us at team@YOUR_DOMAIN

Best regards,
YOUR_PROPERTY_NAME`,
      }),
    });

    if (emailResponse.ok) {
      console.log('Rental signed + payment request email sent to', person.email);
    } else {
      const emailError = await emailResponse.json();
      console.error('Failed to send rental email:', emailError);
    }
  } catch (emailErr) {
    console.error('Error sending rental email:', emailErr);
  }
}

// Send event agreement signed email
async function sendEventSignedEmail(
  person: { first_name: string; last_name: string; email: string },
  eventName: string,
  eventDate: string,
  eventTime: string,
  rentalFee: number,
  cleaningDeposit: number,
  paymentDueDate: string,
  paymentMethodsHtml: string,
  paymentMethodsText: string
) {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  if (!RESEND_API_KEY) {
    console.log('RESEND_API_KEY not configured, skipping email');
    return;
  }

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
        subject: 'Event Agreement Signed - Outstanding Fees Due Before Event - YOUR_PROPERTY_NAME',
        html: `
          <h2>Event Agreement Signed!</h2>
          <p>Hi ${person.first_name},</p>
          <p>Congratulations! Your event agreement for <strong>${eventName}</strong> has been successfully signed by both parties.</p>

          <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #3d8b7a;">Outstanding Fees Due 7 Days Before Event</h3>
            <p>The following fees must be paid at least <strong>7 days before your event</strong>:</p>
            <table style="border-collapse: collapse; width: 100%; max-width: 400px;">
              <tr>
                <td style="padding: 8px 0;"><strong>Cleaning Deposit:</strong></td>
                <td style="padding: 8px 0; text-align: right; font-size: 1.1em; font-weight: bold; color: #3d8b7a;">$${cleaningDeposit}</td>
              </tr>
              <tr style="border-bottom: 1px solid #ddd;">
                <td style="padding: 8px 0;"><strong>Rental Fee:</strong></td>
                <td style="padding: 8px 0; text-align: right; font-size: 1.1em; font-weight: bold; color: #3d8b7a;">$${rentalFee}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0;"><strong>Total Due:</strong></td>
                <td style="padding: 8px 0; text-align: right; font-size: 1.3em; font-weight: bold; color: #3d8b7a;">$${cleaningDeposit + rentalFee}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0;"><strong>Due By:</strong></td>
                <td style="padding: 8px 0; text-align: right; color: #e07a5f; font-weight: bold;">${paymentDueDate}</td>
              </tr>
            </table>
            <p style="font-size: 0.9em; color: #666; margin-top: 10px; margin-bottom: 0;">The cleaning deposit is fully refundable after your event, provided the venue is cleaned per the agreement. We'll send a reminder 10 days before your event.</p>
          </div>

          <h3>Payment Options</h3>
          <ul style="line-height: 1.8;">
            ${paymentMethodsHtml}
          </ul>
          <p><strong>Important:</strong> Please include your name and "${eventName}" in the payment memo.</p>

          <div style="background: #e5f4f1; border-left: 4px solid #3d8b7a; padding: 15px; margin: 20px 0;">
            <strong>Event:</strong> ${eventName}<br>
            <strong>Date:</strong> ${eventDate}<br>
            ${eventTime ? `<strong>Time:</strong> ${eventTime}` : ''}
          </div>

          <p><strong>Remember:</strong></p>
          <ul>
            <li>Setup crew must arrive 90 minutes before your event</li>
            <li>Direct attendees to <a href="https://YOUR_DOMAIN/visiting">YOUR_DOMAIN/visiting</a> for directions (do NOT post the address publicly)</li>
            <li>Cleanup must be completed by 1:01pm the day after your event</li>
          </ul>

          <p>Once we receive the cleaning deposit and rental fee, your event is confirmed!</p>
          <p>Questions? Reply to this email or contact us at team@YOUR_DOMAIN</p>
          <p>Best regards,<br>YOUR_PROPERTY_NAME</p>
        `,
        text: `Event Agreement Signed!

Hi ${person.first_name},

Congratulations! Your event agreement for ${eventName} has been successfully signed by both parties.

OUTSTANDING FEES DUE 7 DAYS BEFORE EVENT
-----------------------------------------
Cleaning Deposit: $${cleaningDeposit}
Rental Fee: $${rentalFee}
Total Due: $${cleaningDeposit + rentalFee}
Due By: ${paymentDueDate}

The cleaning deposit is fully refundable after your event, provided the venue is cleaned per the agreement. We'll send a reminder 10 days before your event.

PAYMENT OPTIONS
---------------
${paymentMethodsText}

Important: Please include your name and "${eventName}" in the payment memo.

EVENT DETAILS
-------------
Event: ${eventName}
Date: ${eventDate}
${eventTime ? `Time: ${eventTime}` : ''}

REMINDERS
---------
- Setup crew must arrive 90 minutes before your event
- Direct attendees to YOUR_DOMAIN/visiting for directions (do NOT post the address publicly)
- Cleanup must be completed by 1:01pm the day after your event

Once we receive the cleaning deposit and rental fee, your event is confirmed!

Questions? Reply to this email or contact us at team@YOUR_DOMAIN

Best regards,
YOUR_PROPERTY_NAME`,
      }),
    });

    if (emailResponse.ok) {
      console.log('Event signed + payment request email sent to', person.email);
    } else {
      const emailError = await emailResponse.json();
      console.error('Failed to send event email:', emailError);
    }
  } catch (emailErr) {
    console.error('Error sending event email:', emailErr);
  }
}

// Send vehicle registration email after lease signing
async function sendVehicleRegistrationEmail(
  person: { first_name: string; last_name: string; email: string },
  vehicleInfo?: { make: string; model: string; year: string; color: string; vin: string; name: string } | null
) {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  if (!RESEND_API_KEY) {
    console.log('RESEND_API_KEY not configured, skipping vehicle registration email');
    return;
  }

  const profileUrl = 'https://YOUR_DOMAIN/residents/profile.html#vehicles';

  // Build vehicle info section if available
  const hasVehicle = vehicleInfo && (vehicleInfo.make || vehicleInfo.model);
  const vehicleLabel = hasVehicle
    ? `${vehicleInfo.year} ${vehicleInfo.make} ${vehicleInfo.model}`.trim()
    : '';

  const vehicleHtmlSection = hasVehicle ? `
          <div style="background: #fdf6ee; border-left: 4px solid #d4883a; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
            <h3 style="margin-top: 0; color: #d4883a;">Your Assigned Vehicle</h3>
            <table style="width: 100%; border-collapse: collapse;">
              ${vehicleInfo.name ? `<tr><td style="padding: 4px 12px 4px 0; color: #666;">Name</td><td style="padding: 4px 0; font-weight: 600;">${vehicleInfo.name}</td></tr>` : ''}
              <tr><td style="padding: 4px 12px 4px 0; color: #666;">Vehicle</td><td style="padding: 4px 0; font-weight: 600;">${vehicleLabel}</td></tr>
              ${vehicleInfo.color ? `<tr><td style="padding: 4px 12px 4px 0; color: #666;">Color</td><td style="padding: 4px 0;">${vehicleInfo.color}</td></tr>` : ''}
              ${vehicleInfo.vin ? `<tr><td style="padding: 4px 12px 4px 0; color: #666;">VIN</td><td style="padding: 4px 0; font-family: monospace;">${vehicleInfo.vin}</td></tr>` : ''}
            </table>
          </div>` : '';

  const vehicleTextSection = hasVehicle ? `
YOUR ASSIGNED VEHICLE
---------------------
${vehicleInfo.name ? `Name: ${vehicleInfo.name}\n` : ''}Vehicle: ${vehicleLabel}
${vehicleInfo.color ? `Color: ${vehicleInfo.color}\n` : ''}${vehicleInfo.vin ? `VIN: ${vehicleInfo.vin}\n` : ''}` : '';

  const subject = hasVehicle
    ? `Your Vehicle: ${vehicleLabel} - YOUR_PROPERTY_NAME`
    : 'Register Your Vehicle - YOUR_PROPERTY_NAME';

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
        subject,
        html: `
          <h2>${hasVehicle ? 'Your Vehicle Information' : 'Register Your Vehicle'}</h2>
          <p>Hi ${person.first_name},</p>
          ${hasVehicle
            ? `<p>Now that your agreement is signed, here are the details for your assigned vehicle.</p>`
            : `<p>Now that your lease is signed, please take a moment to register your vehicle so we can manage parking and identify cars on the property.</p>`
          }

          ${vehicleHtmlSection}

          <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #3d8b7a;">${hasVehicle ? 'Complete Your Vehicle Profile' : 'Add Your Vehicle'}</h3>
            <p>${hasVehicle
              ? 'Visit your profile to view your vehicle details and connect any additional features:'
              : 'Visit your profile to add your vehicle details (make, model, color, license plate):'
            }</p>
            <p style="text-align: center; margin: 20px 0;">
              <a href="${profileUrl}" style="display: inline-block; background: #3d8b7a; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 1.05em;">${hasVehicle ? 'View My Vehicle' : 'Register My Vehicle'}</a>
            </p>
          </div>

          <div style="background: #eef6ff; border-left: 4px solid #4a90d9; padding: 15px; margin: 20px 0;">
            <strong>🚗 Drive a Tesla?</strong><br>
            <p style="margin-bottom: 0;">If your vehicle is a Tesla, you can connect it to our smart charging system. This enables lock/unlock for charger rotation and lets you monitor your car's battery and charging status right from the resident dashboard. Just select "Tesla" as the make when registering, and you'll be guided through the quick connection process.</p>
          </div>

          <p>Questions? Reply to this email or contact us at team@YOUR_DOMAIN</p>
          <p>Best regards,<br>YOUR_PROPERTY_NAME</p>
        `,
        text: `${hasVehicle ? 'Your Vehicle Information' : 'Register Your Vehicle'}

Hi ${person.first_name},

${hasVehicle
  ? 'Now that your agreement is signed, here are the details for your assigned vehicle.'
  : 'Now that your lease is signed, please take a moment to register your vehicle so we can manage parking and identify cars on the property.'
}
${vehicleTextSection}
${hasVehicle ? 'COMPLETE YOUR VEHICLE PROFILE' : 'ADD YOUR VEHICLE'}
----------------
${hasVehicle
  ? 'Visit your profile to view your vehicle details and connect any additional features:'
  : 'Visit your profile to add your vehicle details (make, model, color, license plate):'
}

${profileUrl}

DRIVE A TESLA?
--------------
If your vehicle is a Tesla, you can connect it to our smart charging system. This enables lock/unlock for charger rotation and lets you monitor your car's battery and charging status right from the resident dashboard. Just select "Tesla" as the make when registering, and you'll be guided through the quick connection process.

Questions? Reply to this email or contact us at team@YOUR_DOMAIN

Best regards,
YOUR_PROPERTY_NAME`,
      }),
    });

    if (emailResponse.ok) {
      console.log('Vehicle registration email sent to', person.email);
    } else {
      const emailError = await emailResponse.json();
      console.error('Failed to send vehicle registration email:', emailError);
    }
  } catch (emailErr) {
    console.error('Error sending vehicle registration email:', emailErr);
  }
}
