// SMS service for sending notifications via Telnyx
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';

const SEND_SMS_URL = `${SUPABASE_URL}/functions/v1/send-sms`;

/**
 * SMS types supported by the service
 */
export const SMS_TYPES = {
  // Payment notifications
  PAYMENT_REMINDER: 'payment_reminder',
  PAYMENT_OVERDUE: 'payment_overdue',
  PAYMENT_RECEIVED: 'payment_received',
  // Deposit notifications
  DEPOSIT_REQUESTED: 'deposit_requested',
  DEPOSIT_RECEIVED: 'deposit_received',
  // Lease notifications
  LEASE_SENT: 'lease_sent',
  LEASE_SIGNED: 'lease_signed',
  MOVE_IN_CONFIRMED: 'move_in_confirmed',
  // Ad-hoc
  GENERAL: 'general',
  BULK_ANNOUNCEMENT: 'bulk_announcement',
};

/**
 * Format a phone number to E.164 format (+1XXXXXXXXXX)
 * Handles: (512) 555-1234, 555-555-5555, 5125551234, +15125551234, etc.
 * @param {string} phone - Raw phone number
 * @returns {string|null} E.164 formatted number or null if invalid
 */
export function formatPhoneE164(phone) {
  if (!phone) return null;

  // Strip all non-digit characters
  const digits = phone.replace(/\D/g, '');

  // 10 digits: US number without country code
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  // 11 digits starting with 1: US number with country code
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  // Already has + prefix and looks valid
  if (phone.startsWith('+') && digits.length >= 10) {
    return `+${digits}`;
  }

  // Invalid
  console.warn('Could not format phone to E.164:', phone);
  return null;
}

/**
 * Send an SMS using the send-sms edge function
 * @param {string} type - SMS type from SMS_TYPES
 * @param {string} to - Recipient phone number (any format, will be normalized)
 * @param {object} data - Template data
 * @param {object} options - Optional overrides (person_id)
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
export async function sendSMS(type, to, data, options = {}) {
  try {
    const formattedPhone = formatPhoneE164(to);
    if (!formattedPhone) {
      return { success: false, error: `Invalid phone number: ${to}` };
    }

    const response = await fetch(SEND_SMS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        type,
        to: formattedPhone,
        data,
        person_id: options.person_id || null,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('SMS send failed:', result);
      return { success: false, error: result.error || 'Failed to send SMS' };
    }

    return { success: true, id: result.id, test_mode: result.test_mode || false };
  } catch (error) {
    console.error('SMS service error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * SMS service with convenience methods for each notification type
 */
export const smsService = {
  // ===== PAYMENT NOTIFICATIONS =====

  /**
   * Send payment reminder SMS
   * @param {object} tenant - Person object with phone and name
   * @param {number} amount - Amount due
   * @param {string} dueDate - Due date
   * @param {string} period - Payment period (e.g., "February 2025 rent")
   */
  async sendPaymentReminder(tenant, amount, dueDate, period = null) {
    if (!tenant.phone) return { success: false, error: 'No phone number' };
    return sendSMS(SMS_TYPES.PAYMENT_REMINDER, tenant.phone, {
      first_name: tenant.first_name,
      amount,
      due_date: dueDate,
      period,
    }, { person_id: tenant.id });
  },

  /**
   * Send payment overdue SMS
   * @param {object} tenant - Person object with phone and name
   * @param {number} amount - Amount due
   * @param {string} dueDate - Original due date
   * @param {number} daysOverdue - Days past due
   * @param {number} lateFee - Optional late fee
   */
  async sendPaymentOverdue(tenant, amount, dueDate, daysOverdue, lateFee = null) {
    if (!tenant.phone) return { success: false, error: 'No phone number' };
    const totalDue = lateFee ? amount + lateFee : amount;
    return sendSMS(SMS_TYPES.PAYMENT_OVERDUE, tenant.phone, {
      first_name: tenant.first_name,
      amount,
      due_date: dueDate,
      days_overdue: daysOverdue,
      late_fee: lateFee,
      total_due: totalDue,
    }, { person_id: tenant.id });
  },

  /**
   * Send payment received SMS
   * @param {object} tenant - Person object with phone and name
   * @param {number} amount - Amount received
   * @param {string} period - Payment period
   */
  async sendPaymentReceived(tenant, amount, period = null) {
    if (!tenant.phone) return { success: false, error: 'No phone number' };
    return sendSMS(SMS_TYPES.PAYMENT_RECEIVED, tenant.phone, {
      first_name: tenant.first_name,
      amount,
      period,
    }, { person_id: tenant.id });
  },

  // ===== DEPOSIT NOTIFICATIONS =====

  /**
   * Send deposit request SMS
   * @param {object} application - Rental application with person and deposit info
   * @param {string} dueDate - Optional due date
   */
  async sendDepositRequested(application, dueDate = null) {
    const person = application.person;
    if (!person?.phone) return { success: false, error: 'No phone number' };
    const moveInDeposit = application.move_in_deposit || application.approved_rate || 0;
    const securityDeposit = application.security_deposit || 0;
    const totalDue = moveInDeposit + securityDeposit;

    return sendSMS(SMS_TYPES.DEPOSIT_REQUESTED, person.phone, {
      first_name: person.first_name,
      move_in_deposit: moveInDeposit,
      security_deposit: securityDeposit,
      total_due: totalDue,
      due_date: dueDate,
    }, { person_id: person.id });
  },

  /**
   * Send deposit received SMS
   * @param {object} application - Rental application with person
   * @param {number} amount - Amount received
   * @param {number} remainingBalance - Remaining balance
   */
  async sendDepositReceived(application, amount, remainingBalance = 0) {
    const person = application.person;
    if (!person?.phone) return { success: false, error: 'No phone number' };
    return sendSMS(SMS_TYPES.DEPOSIT_RECEIVED, person.phone, {
      first_name: person.first_name,
      amount,
      remaining_balance: remainingBalance,
    }, { person_id: person.id });
  },

  // ===== LEASE NOTIFICATIONS =====

  /**
   * Send lease sent for signature SMS
   * @param {object} application - Rental application with person
   */
  async sendLeaseSent(application) {
    const person = application.person;
    if (!person?.phone) return { success: false, error: 'No phone number' };
    return sendSMS(SMS_TYPES.LEASE_SENT, person.phone, {
      first_name: person.first_name,
    }, { person_id: person.id });
  },

  /**
   * Send lease signed SMS
   * @param {object} application - Rental application with person
   */
  async sendLeaseSigned(application) {
    const person = application.person;
    if (!person?.phone) return { success: false, error: 'No phone number' };
    return sendSMS(SMS_TYPES.LEASE_SIGNED, person.phone, {
      first_name: person.first_name,
    }, { person_id: person.id });
  },

  /**
   * Send move-in confirmed SMS
   * @param {object} application - Rental application with full details
   */
  async sendMoveInConfirmed(application) {
    const person = application.person;
    if (!person?.phone) return { success: false, error: 'No phone number' };
    return sendSMS(SMS_TYPES.MOVE_IN_CONFIRMED, person.phone, {
      first_name: person.first_name,
      space_name: application.space?.name || application.desired_space,
      move_in_date: application.approved_move_in_date,
      monthly_rate: application.approved_rate,
    }, { person_id: person.id });
  },

  // ===== AD-HOC MESSAGING =====

  /**
   * Send a custom SMS message
   * @param {object} tenant - Person object with phone and name
   * @param {string} message - Message text
   */
  async sendGeneral(tenant, message) {
    if (!tenant.phone) return { success: false, error: 'No phone number' };
    return sendSMS(SMS_TYPES.GENERAL, tenant.phone, {
      message,
    }, { person_id: tenant.id });
  },

  /**
   * Send bulk SMS to multiple recipients
   * @param {string} type - SMS type
   * @param {Array} recipients - Array of {phone, id, ...data} objects
   * @param {object} sharedData - Data shared across all messages
   * @returns {Promise<{sent: number, failed: number, errors: Array}>}
   */
  async sendBulk(type, recipients, sharedData = {}) {
    const results = { sent: 0, failed: 0, errors: [] };

    for (const recipient of recipients) {
      const { phone, id, ...recipientData } = recipient;
      if (!phone) {
        results.failed++;
        results.errors.push({ id, error: 'No phone number' });
        continue;
      }

      const result = await sendSMS(type, phone, { ...sharedData, ...recipientData }, { person_id: id });

      if (result.success) {
        results.sent++;
      } else {
        results.failed++;
        results.errors.push({ phone, error: result.error });
      }

      // Rate limiting delay between messages
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return results;
  },

  // ===== CONVERSATION HISTORY =====

  /**
   * Get SMS conversation for a person
   * @param {string} personId - Person UUID
   * @returns {Promise<Array>} Messages sorted by created_at
   */
  async getConversation(personId) {
    const { data, error } = await supabase
      .from('sms_messages')
      .select('*')
      .eq('person_id', personId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching SMS conversation:', error);
      return [];
    }
    return data || [];
  },

  /**
   * Get recent inbound SMS messages
   * @param {number} limit - Max messages to return
   * @returns {Promise<Array>} Recent inbound messages with person info
   */
  async getRecentInbound(limit = 50) {
    const { data, error } = await supabase
      .from('sms_messages')
      .select(`
        *,
        person:person_id(id, first_name, last_name, phone)
      `)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching inbound SMS:', error);
      return [];
    }
    return data || [];
  },
};

export default smsService;
