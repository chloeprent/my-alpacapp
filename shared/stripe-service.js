/**
 * Stripe Service
 * Inbound: PaymentIntent creation (ACH/card via Stripe.js).
 * Config and test connection for admin Settings.
 * Outbound payouts to workers are in payout-service.js (sendStripePayout).
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';

const PROCESS_STRIPE_PAYMENT_URL = `${SUPABASE_URL}/functions/v1/process-stripe-payment`;

class StripeService {
  constructor() {
    this.config = null;
  }

  /**
   * Load Stripe configuration from database
   */
  async loadConfig() {
    if (this.config) return this.config;
    const { data, error } = await supabase
      .from('stripe_config')
      .select('*')
      .single();
    if (error) {
      console.error('Failed to load Stripe config:', error);
      throw new Error('Stripe configuration not found');
    }
    this.config = data;
    return this.config;
  }

  /**
   * Get publishable key for current test_mode (for Stripe.js)
   */
  getPublishableKey() {
    if (!this.config) throw new Error('Config not loaded. Call loadConfig() first.');
    return this.config.test_mode
      ? this.config.sandbox_publishable_key
      : this.config.publishable_key;
  }

  /**
   * Load Stripe.js script dynamically
   */
  async loadStripeJS() {
    if (window.Stripe) return window.Stripe;
    await this.loadConfig();
    const pk = this.getPublishableKey();
    if (!pk) throw new Error('Stripe publishable key not configured');
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="https://js.stripe.com/v3/"]')) {
        const check = setInterval(() => {
          if (window.Stripe) {
            clearInterval(check);
            resolve(window.Stripe);
          }
        }, 100);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.onload = () => resolve(window.Stripe);
      script.onerror = () => reject(new Error('Failed to load Stripe.js'));
      document.head.appendChild(script);
    });
  }

  /**
   * Create a PaymentIntent (inbound payment). Call this before showing the Payment Element.
   * @param {number} amountCents - Amount in cents (min 50)
   * @param {Object} options - payment_type, reference_type, reference_id, description?, person_id?, person_name?, buyer_email?
   * @returns {Promise<{ clientSecret: string, paymentRecordId: string, paymentIntentId: string }>}
   */
  async createPaymentIntent(amountCents, options = {}) {
    const {
      payment_type,
      reference_type,
      reference_id,
      description,
      person_id,
      person_name,
      buyer_email
    } = options;

    if (!payment_type || !reference_type || !reference_id) {
      throw new Error('payment_type, reference_type, and reference_id are required');
    }
    if (amountCents < 50) throw new Error('Minimum amount is 50 cents');

    const { data: { session } } = await supabase.auth.getSession();
    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY
    };
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const response = await fetch(PROCESS_STRIPE_PAYMENT_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        amount: amountCents,
        description: description || null,
        payment_type,
        reference_type,
        reference_id,
        person_id: person_id || null,
        person_name: person_name || null,
        buyer_email: buyer_email || null
      })
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to create payment intent');
    }
    return {
      clientSecret: data.clientSecret,
      paymentRecordId: data.paymentRecordId,
      paymentIntentId: data.paymentIntentId
    };
  }

  /**
   * Test Stripe connection (Settings page). Creates a minimal PaymentIntent to verify secret key.
   */
  async testConnection() {
    try {
      const result = await this.createPaymentIntent(50, {
        payment_type: 'other',
        reference_type: 'test',
        reference_id: crypto.randomUUID(),
        description: 'Connection test'
      });
      return {
        success: true,
        message: `Connected. Mode: ${this.config?.test_mode ? 'Test' : 'Live'}.`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Connection test failed'
      };
    }
  }
}

// ---- Config (for Settings page) ----

export async function getStripeConfig() {
  const { data, error } = await supabase
    .from('stripe_config')
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateStripeConfig(updates) {
  const { data, error } = await supabase
    .from('stripe_config')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---- Singleton ----

export const stripeService = new StripeService();
