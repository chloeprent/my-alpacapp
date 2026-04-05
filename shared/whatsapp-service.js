// WhatsApp service for sending notifications via WhatsApp Cloud API
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';

const SEND_WHATSAPP_URL = `${SUPABASE_URL}/functions/v1/send-whatsapp`;

/**
 * WhatsApp message types (same as SMS_TYPES for consistency)
 */
export const WA_TYPES = {
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
 * Reuses same logic as sms-service.js
 */
function formatPhoneE164(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (phone.startsWith('+') && digits.length >= 10) return `+${digits}`;
  console.warn('Could not format phone to E.164:', phone);
  return null;
}

/**
 * Send a WhatsApp message using the send-whatsapp edge function
 * @param {string} type - Message type from WA_TYPES
 * @param {string} to - Recipient phone number (any format, will be normalized)
 * @param {object} data - Template data
 * @param {object} options - Optional overrides (person_id)
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
export async function sendWhatsApp(type, to, data, options = {}) {
  try {
    const formattedPhone = formatPhoneE164(to);
    if (!formattedPhone) {
      return { success: false, error: `Invalid phone number: ${to}` };
    }

    const response = await fetch(SEND_WHATSAPP_URL, {
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
      console.error('WhatsApp send failed:', result);
      return { success: false, error: result.error || 'Failed to send WhatsApp message' };
    }

    return { success: true, id: result.id, test_mode: result.test_mode || false };
  } catch (error) {
    console.error('WhatsApp service error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * WhatsApp service with convenience methods for each notification type
 */
export const whatsappService = {
  // ===== PAYMENT NOTIFICATIONS =====

  async sendPaymentReminder(tenant, amount, dueDate, period = null) {
    if (!tenant.phone) return { success: false, error: 'No phone number' };
    return sendWhatsApp(WA_TYPES.PAYMENT_REMINDER, tenant.phone, {
      first_name: tenant.first_name,
      amount,
      due_date: dueDate,
      period,
    }, { person_id: tenant.id });
  },

  async sendPaymentOverdue(tenant, amount, dueDate, daysOverdue, lateFee = null) {
    if (!tenant.phone) return { success: false, error: 'No phone number' };
    const totalDue = lateFee ? amount + lateFee : amount;
    return sendWhatsApp(WA_TYPES.PAYMENT_OVERDUE, tenant.phone, {
      first_name: tenant.first_name,
      amount,
      due_date: dueDate,
      days_overdue: daysOverdue,
      late_fee: lateFee,
      total_due: totalDue,
    }, { person_id: tenant.id });
  },

  async sendPaymentReceived(tenant, amount, period = null) {
    if (!tenant.phone) return { success: false, error: 'No phone number' };
    return sendWhatsApp(WA_TYPES.PAYMENT_RECEIVED, tenant.phone, {
      first_name: tenant.first_name,
      amount,
      period,
    }, { person_id: tenant.id });
  },

  // ===== DEPOSIT NOTIFICATIONS =====

  async sendDepositRequested(application, dueDate = null) {
    const person = application.person;
    if (!person?.phone) return { success: false, error: 'No phone number' };
    const moveInDeposit = application.move_in_deposit || application.approved_rate || 0;
    const securityDeposit = application.security_deposit || 0;
    const totalDue = moveInDeposit + securityDeposit;
    return sendWhatsApp(WA_TYPES.DEPOSIT_REQUESTED, person.phone, {
      first_name: person.first_name,
      move_in_deposit: moveInDeposit,
      security_deposit: securityDeposit,
      total_due: totalDue,
      due_date: dueDate,
    }, { person_id: person.id });
  },

  async sendDepositReceived(application, amount, remainingBalance = 0) {
    const person = application.person;
    if (!person?.phone) return { success: false, error: 'No phone number' };
    return sendWhatsApp(WA_TYPES.DEPOSIT_RECEIVED, person.phone, {
      first_name: person.first_name,
      amount,
      remaining_balance: remainingBalance,
    }, { person_id: person.id });
  },

  // ===== LEASE NOTIFICATIONS =====

  async sendLeaseSent(application) {
    const person = application.person;
    if (!person?.phone) return { success: false, error: 'No phone number' };
    return sendWhatsApp(WA_TYPES.LEASE_SENT, person.phone, {
      first_name: person.first_name,
    }, { person_id: person.id });
  },

  async sendLeaseSigned(application) {
    const person = application.person;
    if (!person?.phone) return { success: false, error: 'No phone number' };
    return sendWhatsApp(WA_TYPES.LEASE_SIGNED, person.phone, {
      first_name: person.first_name,
    }, { person_id: person.id });
  },

  async sendMoveInConfirmed(application) {
    const person = application.person;
    if (!person?.phone) return { success: false, error: 'No phone number' };
    return sendWhatsApp(WA_TYPES.MOVE_IN_CONFIRMED, person.phone, {
      first_name: person.first_name,
      space_name: application.space?.name || application.desired_space,
      move_in_date: application.approved_move_in_date,
      monthly_rate: application.approved_rate,
    }, { person_id: person.id });
  },

  // ===== AD-HOC MESSAGING =====

  async sendGeneral(tenant, message) {
    if (!tenant.phone) return { success: false, error: 'No phone number' };
    return sendWhatsApp(WA_TYPES.GENERAL, tenant.phone, {
      message,
    }, { person_id: tenant.id });
  },

  async sendBulk(type, recipients, sharedData = {}) {
    const results = { sent: 0, failed: 0, errors: [] };

    for (const recipient of recipients) {
      const { phone, id, ...recipientData } = recipient;
      if (!phone) {
        results.failed++;
        results.errors.push({ id, error: 'No phone number' });
        continue;
      }

      const result = await sendWhatsApp(type, phone, { ...sharedData, ...recipientData }, { person_id: id });

      if (result.success) {
        results.sent++;
      } else {
        results.failed++;
        results.errors.push({ phone, error: result.error });
      }

      // Rate limiting delay between messages (WhatsApp has stricter limits)
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return results;
  },

  // ===== CONVERSATION HISTORY =====

  async getConversation(personId) {
    const { data, error } = await supabase
      .from('sms_messages')
      .select('*')
      .eq('person_id', personId)
      .eq('channel', 'whatsapp')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching WhatsApp conversation:', error);
      return [];
    }
    return data || [];
  },

  async getRecentInbound(limit = 50) {
    const { data, error } = await supabase
      .from('sms_messages')
      .select(`
        *,
        person:person_id(id, first_name, last_name, phone)
      `)
      .eq('direction', 'inbound')
      .eq('channel', 'whatsapp')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching inbound WhatsApp messages:', error);
      return [];
    }
    return data || [];
  },
};

export default whatsappService;
