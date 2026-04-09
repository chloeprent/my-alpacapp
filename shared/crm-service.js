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

    return contact;
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
}

export const crmService = new CRMService();
