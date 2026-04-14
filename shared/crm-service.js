/**
 * Swoon CRM Service — Supabase queries for the CRM admin page.
 * Handles contacts, pipeline stages, activity logging, and stats.
 */
import { supabase } from './supabase.js';

class CRMService {

  // ══════════════════════════════════════════
  // CONTACTS — CRUD
  // ══════════════════════════════════════════

  /** Get all contacts, newest first */
  async getContacts() {
    const { data, error } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .order('last_activity_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  /** Get contacts filtered by pipeline stage */
  async getContactsByStage(stage) {
    const { data, error } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .eq('stage', stage)
      .order('last_activity_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  /** Create a new contact */
  async createContact(contact) {
    const { data, error } = await supabase
      .from('swoon_crm_contacts')
      .insert([contact])
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  /** Update a contact */
  async updateContact(id, updates) {
    updates.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('swoon_crm_contacts')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Map of stages → which sequence to auto-start
  static STAGE_SEQUENCES = {
    lead_magnet_sent: 'post_lead_magnet',
    in_conversation: 'post_conversation',
    call_booked: 'pre_call_reminder',
  };

  /** Move a contact to a new pipeline stage */
  async moveToStage(id, newStage) {
    const updates = {
      stage: newStage,
      last_activity_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Auto-set timestamps based on stage
    if (newStage === 'lead_magnet_sent') {
      updates.lead_magnet_sent = true;
      updates.lead_magnet_sent_at = new Date().toISOString();
    } else if (newStage === 'call_booked') {
      updates.call_booked_at = new Date().toISOString();
    } else if (newStage === 'client') {
      updates.became_client_at = new Date().toISOString();
    } else if (newStage === 'cold') {
      updates.is_warm = false;
    }

    const contact = await this.updateContact(id, updates);

    // Log the stage change
    await this.logActivity(id, 'stage_change', `Moved to ${newStage.replace(/_/g, ' ')}`);

    // Auto-start follow-up sequence if mapped and not already running
    const autoSeq = CRMService.STAGE_SEQUENCES[newStage];
    if (autoSeq && !contact.follow_up_sequence) {
      try {
        const updated = await this.startSequence(id, autoSeq);
        return updated;
      } catch (e) {
        console.warn('Auto-start sequence failed:', e);
      }
    }

    return contact;
  }

  /** Get contacts that should have a sequence but don't */
  async getContactsNeedingSequence() {
    const { data, error } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .in('stage', ['lead_magnet_sent', 'in_conversation'])
      .is('follow_up_sequence', null)
      .neq('stage', 'client')
      .neq('stage', 'cold')
      .order('last_activity_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  /** Bulk-start sequences for contacts that need them */
  async autoStartSequences() {
    const contacts = await this.getContactsNeedingSequence();
    let started = 0;
    for (const contact of contacts) {
      const seqName = CRMService.STAGE_SEQUENCES[contact.stage];
      if (seqName) {
        try {
          await this.startSequence(contact.id, seqName);
          started++;
        } catch (e) {
          console.warn(`Failed to auto-start for ${contact.full_name || contact.id}:`, e);
        }
      }
    }
    return started;
  }

  /** Delete a contact */
  async deleteContact(id) {
    const { error } = await supabase
      .from('swoon_crm_contacts')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }

  /** Search contacts by name or IG username */
  async searchContacts(query) {
    const { data, error } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .or(`ig_username.ilike.%${query}%,full_name.ilike.%${query}%,email.ilike.%${query}%`)
      .order('last_activity_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // ══════════════════════════════════════════
  // ACTIVITY LOG
  // ══════════════════════════════════════════

  /** Log an activity for a contact */
  async logActivity(contactId, activityType, description, metadata = {}) {
    const { data, error } = await supabase
      .from('swoon_crm_activity')
      .insert([{
        contact_id: contactId,
        activity_type: activityType,
        description,
        metadata,
      }])
      .select()
      .single();
    if (error) throw error;

    // Also update last_activity_at on the contact
    await supabase
      .from('swoon_crm_contacts')
      .update({ last_activity_at: new Date().toISOString() })
      .eq('id', contactId);

    return data;
  }

  /** Get activity log for a contact */
  async getActivity(contactId) {
    const { data, error } = await supabase
      .from('swoon_crm_activity')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // ══════════════════════════════════════════
  // STATS — Pipeline overview numbers
  // ══════════════════════════════════════════

  /** Get count of contacts per stage */
  async getPipelineStats() {
    const { data, error } = await supabase
      .from('swoon_crm_contacts')
      .select('stage');
    if (error) throw error;

    const stats = {
      new_lead: 0,
      lead_magnet_sent: 0,
      in_conversation: 0,
      call_booked: 0,
      client: 0,
      cold: 0,
      total: data.length,
    };

    for (const row of data) {
      if (stats[row.stage] !== undefined) stats[row.stage]++;
    }

    return stats;
  }

  /** Get contacts that need follow-up today or are overdue */
  async getFollowUps() {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .lte('next_follow_up', today)
      .neq('stage', 'client')
      .neq('stage', 'cold')
      .order('next_follow_up', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // ══════════════════════════════════════════
  // FOLLOW-UP SEQUENCES
  // ══════════════════════════════════════════

  /** Get all follow-up sequence templates */
  async getSequences() {
    const { data, error } = await supabase
      .from('swoon_follow_up_sequences')
      .select('*')
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    return data || [];
  }

  /** Get a specific sequence by name */
  async getSequence(name) {
    const { data, error } = await supabase
      .from('swoon_follow_up_sequences')
      .select('*')
      .eq('name', name)
      .single();
    if (error) throw error;
    return data;
  }

  /** Start a follow-up sequence for a contact */
  async startSequence(contactId, sequenceName) {
    const now = new Date().toISOString();
    const nextDate = new Date();

    // Get the sequence to find the first step's day offset
    const sequence = await this.getSequence(sequenceName);
    if (sequence?.steps?.length) {
      nextDate.setDate(nextDate.getDate() + (sequence.steps[0].day || 1));
    } else {
      nextDate.setDate(nextDate.getDate() + 1);
    }

    const contact = await this.updateContact(contactId, {
      follow_up_sequence: sequenceName,
      follow_up_step: 0,
      follow_up_started_at: now,
      follow_up_paused: false,
      next_follow_up: nextDate.toISOString().split('T')[0],
    });

    await this.logActivity(contactId, 'follow_up', `Started "${sequenceName.replace(/_/g, ' ')}" sequence`);
    return contact;
  }

  /** Advance to the next step in a follow-up sequence */
  async advanceSequence(contactId) {
    const { data: contact } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .eq('id', contactId)
      .single();
    if (!contact?.follow_up_sequence) return null;

    const sequence = await this.getSequence(contact.follow_up_sequence);
    if (!sequence) return null;

    const nextStep = (contact.follow_up_step || 0) + 1;
    const now = new Date().toISOString();

    if (nextStep >= sequence.steps.length) {
      // Sequence complete
      return this.updateContact(contactId, {
        follow_up_step: nextStep,
        follow_up_paused: true,
        last_follow_up_at: now,
        follow_up_count: (contact.follow_up_count || 0) + 1,
        next_follow_up: null,
      });
    }

    // Calculate next follow-up date from the step's day offset
    const nextDayOffset = sequence.steps[nextStep].day;
    const nextDate = new Date(contact.follow_up_started_at || now);
    nextDate.setDate(nextDate.getDate() + nextDayOffset);

    // If the next date is in the past, set it to tomorrow
    if (nextDate < new Date()) {
      nextDate.setTime(Date.now() + 86400000);
    }

    return this.updateContact(contactId, {
      follow_up_step: nextStep,
      last_follow_up_at: now,
      follow_up_count: (contact.follow_up_count || 0) + 1,
      next_follow_up: nextDate.toISOString().split('T')[0],
    });
  }

  /** Pause a follow-up sequence */
  async pauseSequence(contactId) {
    const contact = await this.updateContact(contactId, { follow_up_paused: true });
    await this.logActivity(contactId, 'follow_up', 'Follow-up sequence paused');
    return contact;
  }

  /** Resume a paused follow-up sequence */
  async resumeSequence(contactId) {
    const contact = await this.updateContact(contactId, { follow_up_paused: false });
    await this.logActivity(contactId, 'follow_up', 'Follow-up sequence resumed');
    return contact;
  }

  /** Get the current step template for a contact, with placeholders filled */
  async getCurrentStep(contact, bookingLink) {
    if (!contact.follow_up_sequence) return null;

    const sequence = await this.getSequence(contact.follow_up_sequence);
    if (!sequence) return null;

    const step = sequence.steps[contact.follow_up_step || 0];
    if (!step) return null;

    // Fill placeholders
    const name = contact.full_name || contact.ig_username || 'there';
    let message = step.template
      .replace(/\{name\}/g, name)
      .replace(/\{booking_link\}/g, bookingLink || '')
      .replace(/\{ig\}/g, contact.ig_username ? `@${contact.ig_username}` : '');

    return {
      ...step,
      message,
      subject: step.subject?.replace(/\{name\}/g, name),
      stepNumber: (contact.follow_up_step || 0) + 1,
      totalSteps: sequence.steps.length,
      sequenceName: sequence.name,
      sequenceDescription: sequence.description,
    };
  }

  /** Get contacts with active follow-up sequences that are due */
  async getDueFollowUps() {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .not('follow_up_sequence', 'is', null)
      .eq('follow_up_paused', false)
      .lte('next_follow_up', today)
      .neq('stage', 'client')
      .neq('stage', 'cold')
      .order('next_follow_up', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  /** Get contacts with upcoming calls (next 7 days) */
  async getUpcomingCalls() {
    const now = new Date().toISOString();
    const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString();
    const { data, error } = await supabase
      .from('swoon_crm_contacts')
      .select('*')
      .gte('call_scheduled_at', now)
      .lte('call_scheduled_at', weekFromNow)
      .order('call_scheduled_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  /** Log a booking link sent action */
  async logBookingLinkSent(contactId, bookingLink) {
    await this.logActivity(contactId, 'booking_link_sent', `Booking link shared: ${bookingLink}`);
    return this.updateContact(contactId, {
      tidycal_booking_url: bookingLink,
    });
  }

  /** Log a follow-up message sent (DM or email) */
  async logFollowUpSent(contactId, type, message) {
    const activityType = type === 'email' ? 'follow_up_email' : 'follow_up_dm';
    await this.logActivity(contactId, activityType, message);
    return this.advanceSequence(contactId);
  }
}

export const crmService = new CRMService();
