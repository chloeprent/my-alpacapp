// Email service for sending notifications via Resend
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';
import { formatDateAustin } from './timezone.js';

const SEND_EMAIL_URL = `${SUPABASE_URL}/functions/v1/send-email`;

/**
 * Email types supported by the service
 */
export const EMAIL_TYPES = {
  // Rental notifications
  APPLICATION_SUBMITTED: 'application_submitted',
  APPLICATION_APPROVED: 'application_approved',
  APPLICATION_DENIED: 'application_denied',
  LEASE_GENERATED: 'lease_generated',
  LEASE_SENT: 'lease_sent',
  LEASE_SIGNED: 'lease_signed',
  DEPOSIT_REQUESTED: 'deposit_requested',
  DEPOSIT_RECEIVED: 'deposit_received',
  DEPOSITS_CONFIRMED: 'deposits_confirmed',
  MOVE_IN_CONFIRMED: 'move_in_confirmed',
  // Payment notifications
  PAYMENT_REMINDER: 'payment_reminder',
  PAYMENT_OVERDUE: 'payment_overdue',
  PAYMENT_RECEIVED: 'payment_received',
  // Invitations
  EVENT_INVITATION: 'event_invitation',
  GENERAL_INVITATION: 'general_invitation',
  STAFF_INVITATION: 'staff_invitation',
  PROSPECT_INVITATION: 'prospect_invitation',
  // Rental invite
  INVITE_TO_APPLY: 'invite_to_apply',
  // Identity verification
  DL_UPLOAD_LINK: 'dl_upload_link',
  DL_VERIFIED: 'dl_verified',
  DL_MISMATCH: 'dl_mismatch',
  // W-9 tax form
  W9_REQUEST: 'w9_request',
  // Payment statement
  PAYMENT_STATEMENT: 'payment_statement',
  // Work checkout summary
  WORK_CHECKOUT_SUMMARY: 'work_checkout_summary',
  // Associate payout
  ASSOCIATE_PAYOUT_SENT: 'associate_payout_sent',
  // Task assignment
  TASK_ASSIGNED: 'task_assigned',
  // Time entry edited
  TIME_ENTRY_EDITED: 'time_entry_edited',
  // Event notification (from event-notify trigger system)
  EVENT_NOTIFICATION: 'event_notification',
  // Space reservations
  RESERVATION_SUBMITTED: 'reservation_submitted',
  RESERVATION_APPROVED: 'reservation_approved',
  RESERVATION_DENIED: 'reservation_denied',
};

/**
 * Send an email using the Resend edge function
 * @param {string} type - Email type from EMAIL_TYPES
 * @param {string|string[]} to - Recipient email(s)
 * @param {object} data - Template data
 * @param {object} options - Optional overrides (subject, from, reply_to)
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
export async function sendEmail(type, to, data, options = {}) {
  try {
    const response = await fetch(SEND_EMAIL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        type,
        to,
        data,
        ...options,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Email send failed:', result);
      return { success: false, error: result.error || 'Failed to send email' };
    }

    return { success: true, id: result.id };
  } catch (error) {
    console.error('Email service error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Email service with convenience methods for each notification type
 */
export const emailService = {
  // ===== RENTAL NOTIFICATIONS =====

  /**
   * Send application submitted confirmation
   * @param {object} application - Rental application with person data
   * @param {string} spaceName - Optional space name
   */
  async sendApplicationSubmitted(application, spaceName = null) {
    const person = application.person || application;
    return sendEmail(EMAIL_TYPES.APPLICATION_SUBMITTED, person.email, {
      first_name: person.first_name,
      space_name: spaceName,
    });
  },

  /**
   * Send application approved notification
   * @param {object} application - Rental application with person and terms
   */
  async sendApplicationApproved(application) {
    const person = application.person;
    return sendEmail(EMAIL_TYPES.APPLICATION_APPROVED, person.email, {
      first_name: person.first_name,
      space_name: application.space?.name || application.desired_space,
      monthly_rate: application.approved_rate,
      move_in_date: formatDate(application.approved_move_in_date),
      lease_end_date: application.approved_end_date ? formatDate(application.approved_end_date) : null,
      require_lease: application.require_lease,
      security_deposit_amount: application.security_deposit_amount || 0,
      space_image_url: application.space_image_url || null,
    });
  },

  /**
   * Send application denied notification
   * @param {object} application - Rental application with person
   * @param {string} reason - Optional denial reason
   */
  async sendApplicationDenied(application, reason = null) {
    const person = application.person;
    return sendEmail(EMAIL_TYPES.APPLICATION_DENIED, person.email, {
      first_name: person.first_name,
      reason,
    });
  },

  /**
   * Send lease generated notification
   * @param {object} application - Rental application with person
   */
  async sendLeaseGenerated(application) {
    const person = application.person;
    return sendEmail(EMAIL_TYPES.LEASE_GENERATED, person.email, {
      first_name: person.first_name,
    });
  },

  /**
   * Send lease sent for signature notification
   * @param {object} application - Rental application with person
   */
  async sendLeaseSent(application) {
    const person = application.person;
    return sendEmail(EMAIL_TYPES.LEASE_SENT, person.email, {
      first_name: person.first_name,
    });
  },

  /**
   * Send lease signed confirmation
   * @param {object} application - Rental application with person and deposit info
   */
  async sendLeaseSigned(application) {
    const person = application.person;
    return sendEmail(EMAIL_TYPES.LEASE_SIGNED, person.email, {
      first_name: person.first_name,
      move_in_deposit: application.move_in_deposit || application.approved_rate,
      security_deposit: application.security_deposit,
      monthly_rate: application.approved_rate,
    });
  },

  /**
   * Send deposit request
   * @param {object} application - Rental application with person and deposit info
   * @param {string} dueDate - Optional due date
   */
  async sendDepositRequested(application, dueDate = null) {
    const person = application.person;
    const moveInDeposit = application.move_in_deposit || application.approved_rate || 0;
    const securityDeposit = application.security_deposit || 0;
    const totalDue = moveInDeposit + securityDeposit;
    const needsId = application.identity_verification_status !== 'verified';

    return sendEmail(EMAIL_TYPES.DEPOSIT_REQUESTED, person.email, {
      first_name: person.first_name,
      move_in_deposit: moveInDeposit,
      security_deposit: securityDeposit,
      total_due: totalDue,
      due_date: dueDate ? formatDate(dueDate) : null,
      needs_id_verification: needsId,
      id_upload_url: application.id_upload_url || null,
    });
  },

  /**
   * Send deposit received confirmation
   * @param {object} application - Rental application with person
   * @param {number} amount - Amount received
   * @param {number} remainingBalance - Remaining balance
   */
  async sendDepositReceived(application, amount, remainingBalance = 0) {
    const person = application.person;
    return sendEmail(EMAIL_TYPES.DEPOSIT_RECEIVED, person.email, {
      first_name: person.first_name,
      amount,
      remaining_balance: remainingBalance,
    });
  },

  /**
   * Send deposits confirmed notification
   * @param {object} application - Rental application with person
   */
  async sendDepositsConfirmed(application) {
    const person = application.person;
    return sendEmail(EMAIL_TYPES.DEPOSITS_CONFIRMED, person.email, {
      first_name: person.first_name,
      move_in_date: formatDate(application.approved_move_in_date),
    });
  },

  /**
   * Send move-in confirmed welcome email
   * @param {object} application - Rental application with full details
   */
  async sendMoveInConfirmed(application) {
    const person = application.person;
    // Determine if this is a monthly tenancy (>30 days or open-ended)
    const moveIn = application.approved_move_in_date ? new Date(application.approved_move_in_date) : null;
    const leaseEnd = application.approved_lease_end ? new Date(application.approved_lease_end) : null;
    const stayDays = (moveIn && leaseEnd) ? Math.round((leaseEnd - moveIn) / (1000 * 60 * 60 * 24)) : null;
    const isMonthly = stayDays === null || stayDays > 30;

    return sendEmail(EMAIL_TYPES.MOVE_IN_CONFIRMED, person.email, {
      first_name: person.first_name,
      space_name: application.space?.name || application.desired_space,
      space_id: application.space?.id || null,
      space_image_url: application.space_image_url || null,
      move_in_date: formatDate(application.approved_move_in_date),
      lease_end_date: application.approved_lease_end ? formatDate(application.approved_lease_end) : null,
      monthly_rate: application.approved_rate,
      rent_due_day: '1st',
      is_monthly: isMonthly,
      check_in_time: application.check_in_time || null,
      check_out_time: application.check_out_time || null,
    });
  },

  // ===== PAYMENT NOTIFICATIONS =====

  /**
   * Send payment reminder
   * @param {object} tenant - Person object with email and name
   * @param {number} amount - Amount due
   * @param {string} dueDate - Due date
   * @param {string} period - Payment period (e.g., "February 2025 rent")
   */
  async sendPaymentReminder(tenant, amount, dueDate, period = null) {
    return sendEmail(EMAIL_TYPES.PAYMENT_REMINDER, tenant.email, {
      first_name: tenant.first_name,
      amount,
      due_date: formatDate(dueDate),
      period,
    });
  },

  /**
   * Send payment overdue notice
   * @param {object} tenant - Person object with email and name
   * @param {number} amount - Amount due
   * @param {string} dueDate - Original due date
   * @param {number} daysOverdue - Days past due
   * @param {number} lateFee - Optional late fee
   */
  async sendPaymentOverdue(tenant, amount, dueDate, daysOverdue, lateFee = null) {
    const totalDue = lateFee ? amount + lateFee : amount;
    return sendEmail(EMAIL_TYPES.PAYMENT_OVERDUE, tenant.email, {
      first_name: tenant.first_name,
      amount,
      due_date: formatDate(dueDate),
      days_overdue: daysOverdue,
      late_fee: lateFee,
      total_due: totalDue,
    });
  },

  /**
   * Send payment received confirmation
   * @param {object} tenant - Person object with email and name
   * @param {number} amount - Amount received
   * @param {string} period - Payment period (e.g., "February 2025 rent")
   */
  async sendPaymentReceived(tenant, amount, period = null) {
    return sendEmail(EMAIL_TYPES.PAYMENT_RECEIVED, tenant.email, {
      first_name: tenant.first_name,
      amount,
      period,
    });
  },

  /**
   * Send payment statement with full ledger summary
   * @param {string} email - Recipient email
   * @param {object} data - Statement data
   * @param {string} data.first_name - Tenant first name
   * @param {string} data.space_name - Space name
   * @param {Array} data.line_items - [{date, description, amount, status}]
   * @param {number} data.balance_due - Outstanding balance
   * @param {string} data.overdue_since - Date balance became overdue
   * @param {number} data.upcoming_amount - Next payment amount
   * @param {string} data.upcoming_date - Next payment due date
   */
  async sendPaymentStatement(email, data) {
    return sendEmail(EMAIL_TYPES.PAYMENT_STATEMENT, email, data);
  },

  // ===== INVITATIONS =====

  /**
   * Send event invitation
   * @param {object} recipient - Person with email and name
   * @param {object} event - Event details
   */
  async sendEventInvitation(recipient, event) {
    return sendEmail(EMAIL_TYPES.EVENT_INVITATION, recipient.email, {
      first_name: recipient.first_name,
      event_name: event.name,
      event_date: formatDate(event.date),
      event_time: event.time,
      location: event.location,
      description: event.description,
      rsvp_link: event.rsvp_link,
    });
  },

  /**
   * Send general invitation
   * @param {object} recipient - Person with email and name
   * @param {object} invitation - Invitation details (subject, message, action_url, action_text)
   */
  async sendGeneralInvitation(recipient, invitation) {
    return sendEmail(EMAIL_TYPES.GENERAL_INVITATION, recipient.email, {
      first_name: recipient.first_name,
      subject: invitation.subject,
      message: invitation.message,
      message_text: invitation.message_text || stripHtml(invitation.message),
      action_url: invitation.action_url,
      action_text: invitation.action_text,
    }, {
      subject: invitation.subject,
    });
  },

  /**
   * Send staff/admin invitation email
   * @param {string} email - Email address to invite
   * @param {string} role - Role being assigned ('admin' or 'staff')
   * @param {string} loginUrl - URL for the invitee to sign in
   * @param {string} [name] - Invitee's first name or display name (optional)
   */
  async sendStaffInvitation(email, role, loginUrl, name) {
    return sendEmail(EMAIL_TYPES.STAFF_INVITATION, email, {
      email,
      role,
      login_url: loginUrl,
      name: name || '',
    });
  },

  /**
   * Send prospect invitation email with access link (no login required)
   * @param {string} email - Recipient email
   * @param {string} firstName - Prospect's first name (optional)
   * @param {string} accessUrl - The access link URL
   */
  async sendProspectInvitation(email, firstName, accessUrl) {
    return sendEmail(EMAIL_TYPES.PROSPECT_INVITATION, email, {
      first_name: firstName || '',
      access_url: accessUrl,
    });
  },

  /**
   * Send invite-to-apply email with link to complete application
   * @param {object} application - Rental application with person data
   * @param {string} continueUrl - URL for the applicant to continue their application
   */
  async sendInviteToApply(application, continueUrl) {
    const person = application.person || application;
    return sendEmail(EMAIL_TYPES.INVITE_TO_APPLY, person.email, {
      first_name: person.first_name,
      continue_url: continueUrl,
    });
  },

  // ===== IDENTITY VERIFICATION =====

  /**
   * Send DL upload link to applicant
   * @param {object} person - Person with email and first_name
   * @param {string} uploadUrl - The unique upload URL
   */
  async sendDLUploadLink(person, uploadUrl) {
    return sendEmail(EMAIL_TYPES.DL_UPLOAD_LINK, person.email, {
      first_name: person.first_name,
      upload_url: uploadUrl,
    });
  },

  // ===== WORK TRACKING =====

  /**
   * Send work checkout summary email to associate + admin
   * @param {object} data - Checkout summary data
   * @param {string} data.associate_email - Associate's email address
   * @param {string} data.first_name - Associate first name
   * @param {string} data.date - Formatted date string
   * @param {string} data.clock_in_time - Clock in time
   * @param {string} data.clock_out_time - Clock out time
   * @param {string} data.duration - Formatted duration
   * @param {string} data.space_name - Space/location name
   * @param {string} data.description - Work description
   * @param {number} data.hourly_rate - Rate
   * @param {string} data.earnings - Formatted earnings
   * @param {Array} data.photos - Array of {url, type, caption}
   */
  async sendWorkCheckoutSummary(data) {
    const recipients = [data.associate_email, 'alpacaplayhouse@gmail.com', 'alpacaautomatic@gmail.com'].filter(Boolean);
    return sendEmail(EMAIL_TYPES.WORK_CHECKOUT_SUMMARY, recipients, data);
  },

  // ===== ASSOCIATE PAYOUTS =====

  /**
   * Send payout notification to associate
   * @param {string} email - Associate email
   * @param {object} data - Payout data
   * @param {string} data.first_name - Associate first name
   * @param {string} data.amount - Formatted amount (e.g. "251.50")
   * @param {string} data.payment_method - Method (e.g. "Stripe", "PayPal")
   * @param {string} data.payout_date - Formatted date
   * @param {string} [data.period] - Pay period description
   * @param {string} [data.hours] - Total hours
   * @param {string} [data.hourly_rate] - Hourly rate
   * @param {string} [data.notes] - Additional notes
   */
  async sendPayoutNotification(email, data) {
    return sendEmail(EMAIL_TYPES.ASSOCIATE_PAYOUT_SENT, email, data);
  },

  // ===== TASK ASSIGNMENT =====

  /**
   * Send task assignment notification with prioritized todo list
   * @param {string} email - Associate email
   * @param {object} data - Task and todo list data
   * @param {string} data.first_name - Associate first name
   * @param {string} data.task_title - Assigned task title
   * @param {string} [data.task_notes] - Task notes/description
   * @param {number} [data.task_priority] - Priority (1-4)
   * @param {string} [data.task_location] - Space/location name
   * @param {Array} data.todo_list - [{title, priority, location, is_new}]
   */
  async sendTaskAssigned(email, data) {
    const recipients = [email, 'alpacaplayhouse@gmail.com'].filter(Boolean);
    return sendEmail(EMAIL_TYPES.TASK_ASSIGNED, recipients, data);
  },

  // ===== TIME ENTRY EDIT NOTIFICATIONS =====

  /**
   * Send notification when an associate edits a past time entry
   * @param {object} data
   * @param {string} data.associate_email - Associate's email
   * @param {string} data.first_name - Associate first name
   * @param {string} data.entry_date - Date of the entry (formatted)
   * @param {string} data.old_clock_in - Original clock in time
   * @param {string} data.old_clock_out - Original clock out time
   * @param {string} data.old_duration - Original duration (formatted)
   * @param {string} data.new_clock_in - New clock in time
   * @param {string} data.new_clock_out - New clock out time
   * @param {string} data.new_duration - New duration (formatted)
   * @param {string} [data.description] - Work description
   * @param {string} [data.space_name] - Space/location name
   */
  async sendTimeEntryEdited(data) {
    const recipients = [data.associate_email, 'alpacaplayhouse@gmail.com'].filter(Boolean);
    return sendEmail(EMAIL_TYPES.TIME_ENTRY_EDITED, recipients, data);
  },

  /**
   * Send bulk emails to multiple recipients
   * @param {string} type - Email type
   * @param {Array} recipients - Array of {email, ...data} objects
   * @param {object} sharedData - Data shared across all emails
   * @returns {Promise<{sent: number, failed: number, errors: Array}>}
   */
  async sendBulk(type, recipients, sharedData = {}) {
    const results = { sent: 0, failed: 0, errors: [] };

    for (const recipient of recipients) {
      const { email, ...recipientData } = recipient;
      const result = await sendEmail(type, email, { ...sharedData, ...recipientData });

      if (result.success) {
        results.sent++;
      } else {
        results.failed++;
        results.errors.push({ email, error: result.error });
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return results;
  },

  // ===== SPACE RESERVATION NOTIFICATIONS =====

  /**
   * Notify admin that a resident submitted a reservation request
   * @param {object} reservation - With person and space joins
   */
  async sendReservationSubmitted(reservation) {
    const person = reservation.person;
    const space = reservation.space;
    const startAt = new Date(reservation.start_at);
    const endAt = new Date(reservation.end_at);
    const dateStr = formatDate(reservation.start_at);
    const timeRange = `${startAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })} - ${endAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })}`;

    return sendEmail(EMAIL_TYPES.RESERVATION_SUBMITTED, 'team@alpacaplayhouse.com', {
      resident_name: `${person.first_name} ${person.last_name}`,
      resident_email: person.email,
      space_name: space?.name || 'Unknown space',
      date: dateStr,
      time_range: timeRange,
      title: reservation.title,
      notes: reservation.notes || 'None',
    }, {
      subject: `Space Reservation Request: ${reservation.title} — ${person.first_name} ${person.last_name}`,
    });
  },

  /**
   * Notify resident their reservation was approved
   * @param {object} reservation - With person and space joins
   */
  async sendReservationApproved(reservation) {
    const person = reservation.person;
    const space = reservation.space;
    const startAt = new Date(reservation.start_at);
    const endAt = new Date(reservation.end_at);
    const dateStr = formatDate(reservation.start_at);
    const timeRange = `${startAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })} - ${endAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })}`;

    return sendEmail(EMAIL_TYPES.RESERVATION_APPROVED, person.email, {
      first_name: person.first_name,
      space_name: space?.name || 'Unknown space',
      date: dateStr,
      time_range: timeRange,
      title: reservation.title,
      admin_notes: reservation.admin_notes || null,
    }, {
      subject: `Reservation Approved: ${reservation.title} on ${dateStr}`,
    });
  },

  /**
   * Notify resident their reservation was denied
   * @param {object} reservation - With person and space joins
   */
  async sendReservationDenied(reservation) {
    const person = reservation.person;
    const dateStr = formatDate(reservation.start_at);

    return sendEmail(EMAIL_TYPES.RESERVATION_DENIED, person.email, {
      first_name: person.first_name,
      space_name: reservation.space?.name || 'Unknown space',
      date: dateStr,
      title: reservation.title,
      admin_notes: reservation.admin_notes || 'No reason provided.',
    }, {
      subject: `Reservation Update: ${reservation.title}`,
    });
  },
};

// Helper functions
function formatDate(dateStr) {
  if (!dateStr) return null;
  return formatDateAustin(dateStr, {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').trim();
}

export default emailService;
