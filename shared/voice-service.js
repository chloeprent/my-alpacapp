// Voice calling service for AI voice assistant management (Vapi)
import { supabase } from './supabase.js';

/**
 * Voice service for managing assistants, calls, and config
 */
export const voiceService = {
  // ===== CONFIG =====

  /**
   * Get Vapi configuration
   */
  async getConfig() {
    const { data, error } = await supabase
      .from('vapi_config')
      .select('*')
      .eq('id', 1)
      .single();
    if (error) {
      console.error('Error loading vapi config:', error);
      return null;
    }
    return data;
  },

  /**
   * Update Vapi configuration
   */
  async updateConfig(updates) {
    const { error } = await supabase
      .from('vapi_config')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) throw error;
  },

  // ===== ASSISTANTS =====

  /**
   * List all voice assistants
   */
  async listAssistants() {
    const { data, error } = await supabase
      .from('voice_assistants')
      .select('*')
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    if (error) {
      console.error('Error loading voice assistants:', error);
      return [];
    }
    return data || [];
  },

  /**
   * Get a single voice assistant
   */
  async getAssistant(id) {
    const { data, error } = await supabase
      .from('voice_assistants')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Create a new voice assistant
   */
  async createAssistant(assistant) {
    const { data, error } = await supabase
      .from('voice_assistants')
      .insert(assistant)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Update a voice assistant
   */
  async updateAssistant(id, updates) {
    const { error } = await supabase
      .from('voice_assistants')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  },

  /**
   * Delete a voice assistant
   */
  async deleteAssistant(id) {
    const { error } = await supabase
      .from('voice_assistants')
      .delete()
      .eq('id', id);
    if (error) throw error;
  },

  /**
   * Set an assistant as the default (unsets all others)
   */
  async setDefault(id) {
    // Unset all defaults
    await supabase
      .from('voice_assistants')
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .neq('id', id);
    // Set the new default
    const { error } = await supabase
      .from('voice_assistants')
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  },

  // ===== CALLS =====

  /**
   * List recent voice calls
   */
  async listCalls({ limit = 50, offset = 0 } = {}) {
    const { data, error, count } = await supabase
      .from('voice_calls')
      .select('*, assistant:assistant_id(name), person:person_id(first_name, last_name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) {
      console.error('Error loading voice calls:', error);
      return { calls: [], count: 0 };
    }
    return { calls: data || [], count: count || 0 };
  },

  /**
   * Get a single call with full details
   */
  async getCall(id) {
    const { data, error } = await supabase
      .from('voice_calls')
      .select('*, assistant:assistant_id(name), person:person_id(first_name, last_name, phone)')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Get call stats (total calls, total duration, total cost)
   */
  async getStats() {
    const { data, error } = await supabase
      .from('voice_calls')
      .select('duration_seconds, cost_cents, status');
    if (error) {
      console.error('Error loading call stats:', error);
      return { totalCalls: 0, totalMinutes: 0, totalCostDollars: 0 };
    }

    const calls = data || [];
    const ended = calls.filter(c => c.status === 'ended');
    const totalSeconds = ended.reduce((sum, c) => sum + (c.duration_seconds || 0), 0);
    const totalCents = ended.reduce((sum, c) => sum + (parseFloat(c.cost_cents) || 0), 0);

    return {
      totalCalls: calls.length,
      totalMinutes: Math.round(totalSeconds / 60),
      totalCostDollars: (totalCents / 100).toFixed(2),
    };
  },
};

export default voiceService;
