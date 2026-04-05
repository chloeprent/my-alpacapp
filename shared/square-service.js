/**
 * Square Payment Service
 * Handles Square Web Payments SDK integration for:
 * - Rental application fees
 * - Event cleaning deposits
 * - Event reservation deposits
 */

import { supabase } from './supabase.js';

// Fee types
export const FEE_TYPES = {
  RENTAL_APPLICATION: 'rental_application',
  EVENT_CLEANING_DEPOSIT: 'event_cleaning_deposit',
  EVENT_RESERVATION_DEPOSIT: 'event_reservation_deposit'
};

class SquareService {
  constructor() {
    this.config = null;
    this.payments = null;
    this.card = null;
    this.initialized = false;
  }

  /**
   * Load Square configuration from database
   */
  async loadConfig() {
    if (this.config) return this.config;

    const { data, error } = await supabase
      .from('square_config')
      .select('*')
      .single();

    if (error) {
      console.error('Failed to load Square config:', error);
      throw new Error('Square configuration not found');
    }

    this.config = data;
    return this.config;
  }

  /**
   * Get the appropriate app ID and access token based on test mode
   */
  getCredentials() {
    if (!this.config) throw new Error('Config not loaded');

    if (this.config.test_mode) {
      return {
        appId: this.config.sandbox_app_id,
        locationId: this.config.sandbox_location_id,
        accessToken: this.config.sandbox_access_token
      };
    }
    return {
      appId: this.config.production_app_id,
      locationId: this.config.production_location_id,
      accessToken: this.config.production_access_token
    };
  }

  /**
   * Load the Square Web Payments SDK
   */
  async loadSDK() {
    if (window.Square) return window.Square;

    await this.loadConfig();
    const isTest = this.config.test_mode;
    const sdkUrl = isTest
      ? 'https://sandbox.web.squarecdn.com/v1/square.js'
      : 'https://web.squarecdn.com/v1/square.js';
    console.log(`[Square] Loading SDK in ${isTest ? 'SANDBOX' : 'PRODUCTION'} mode`);

    return new Promise((resolve, reject) => {
      // Check if already loading
      if (document.querySelector(`script[src="${sdkUrl}"]`)) {
        const checkInterval = setInterval(() => {
          if (window.Square) {
            clearInterval(checkInterval);
            resolve(window.Square);
          }
        }, 100);
        return;
      }

      const script = document.createElement('script');
      script.src = sdkUrl;
      script.onload = () => resolve(window.Square);
      script.onerror = () => reject(new Error('Failed to load Square SDK'));
      document.head.appendChild(script);
    });
  }

  /**
   * Initialize the Square Payments object
   */
  async initialize() {
    if (this.initialized) return;

    const Square = await this.loadSDK();
    const { appId, locationId } = this.getCredentials();

    this.payments = Square.payments(appId, locationId);
    this.initialized = true;
  }

  /**
   * Attach a card payment form to a container element
   * @param {string} containerId - ID of the container element
   * @returns {Object} - The card instance
   */
  async attachCard(containerId) {
    await this.initialize();

    // Destroy existing card if any
    if (this.card) {
      await this.card.destroy();
    }

    this.card = await this.payments.card();
    await this.card.attach(`#${containerId}`);

    return this.card;
  }

  /**
   * Get fee settings for a specific fee type
   * @param {string} feeType - One of FEE_TYPES
   */
  async getFeeSettings(feeType) {
    const { data, error } = await supabase
      .from('fee_settings')
      .select('*')
      .eq('fee_type', feeType)
      .eq('is_active', true)
      .single();

    if (error) {
      console.error('Failed to load fee settings:', error);
      return null;
    }
    return data;
  }

  /**
   * Validate a fee code and get the price
   * @param {string} code - The discount code
   * @param {string} feeType - One of FEE_TYPES
   * @returns {Object} - { valid: boolean, price: number, message: string }
   */
  async validateFeeCode(code, feeType) {
    if (!code || !code.trim()) {
      // No code - return default price
      const settings = await this.getFeeSettings(feeType);
      return {
        valid: true,
        price: settings?.default_amount || 0,
        isDefault: true,
        message: null
      };
    }

    const { data, error } = await supabase
      .from('fee_codes')
      .select('*')
      .eq('code', code.trim().toUpperCase())
      .eq('fee_type', feeType)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return {
        valid: false,
        price: null,
        message: 'Invalid code'
      };
    }

    // Check expiration
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return {
        valid: false,
        price: null,
        message: 'Code has expired'
      };
    }

    // Check usage limit
    if (data.usage_limit !== null && data.times_used >= data.usage_limit) {
      return {
        valid: false,
        price: null,
        message: 'Code has reached its usage limit'
      };
    }

    return {
      valid: true,
      price: data.price,
      codeId: data.id,
      isDefault: false,
      message: data.price === 0 ? 'Fee waived!' : `Price: $${data.price.toFixed(2)}`
    };
  }

  /**
   * Get the price for a fee type, applying a code if provided
   * @param {string} feeType - One of FEE_TYPES
   * @param {string} code - Optional discount code
   */
  async getPrice(feeType, code = null) {
    const validation = await this.validateFeeCode(code, feeType);
    if (!validation.valid) {
      // If code is invalid, return default
      const settings = await this.getFeeSettings(feeType);
      return {
        amount: settings?.default_amount || 0,
        codeApplied: false,
        error: validation.message
      };
    }
    return {
      amount: validation.price,
      codeApplied: !validation.isDefault,
      codeId: validation.codeId
    };
  }

  /**
   * Tokenize the card and process payment
   * @param {Object} options - Payment options
   * @param {string} options.feeType - Type of fee
   * @param {string} options.referenceType - 'rental_application' or 'event_booking'
   * @param {string} options.referenceId - ID of the related record
   * @param {string} options.code - Optional fee code
   * @param {string} options.buyerEmail - Buyer's email for receipt
   */
  async processPayment({ feeType, referenceType, referenceId, code, buyerEmail }) {
    if (!this.card) {
      throw new Error('Card not attached. Call attachCard() first.');
    }

    // Get the price
    const priceInfo = await this.getPrice(feeType, code);
    const amount = priceInfo.amount;

    // If amount is 0, no payment needed
    if (amount === 0) {
      // Record the "payment" as completed with $0
      const { data: paymentRecord, error: recordError } = await supabase
        .from('square_payments')
        .insert({
          payment_type: feeType,
          reference_type: referenceType,
          reference_id: referenceId,
          amount: 0,
          fee_code_used: code?.toUpperCase() || null,
          original_amount: (await this.getFeeSettings(feeType))?.default_amount || 0,
          status: 'completed'
        })
        .select()
        .single();

      if (recordError) {
        console.error('Failed to record $0 payment:', recordError);
      }

      // Dual-write to ledger
      if (paymentRecord) {
        const categoryMap = {
          rental_application: 'application_fee',
          event_cleaning_deposit: 'event_cleaning_deposit',
          event_reservation_deposit: 'event_reservation_deposit',
        };
        await supabase.from('ledger').insert({
          direction: 'income',
          category: categoryMap[feeType] || 'other',
          amount: 0,
          payment_method: 'square',
          transaction_date: new Date().toISOString().split('T')[0],
          square_payment_id: paymentRecord.id,
          rental_application_id: referenceType === 'rental_application' ? referenceId : null,
          event_request_id: referenceType === 'event_hosting_request' ? referenceId : null,
          status: 'completed',
          description: `${feeType.replace(/_/g, ' ')} (fee waived)`,
          recorded_by: 'system:square-service',
          is_test: !!this.config?.test_mode,
        });
      }

      // Increment code usage if applicable
      if (priceInfo.codeId) {
        await this.incrementCodeUsage(priceInfo.codeId);
      }

      return {
        success: true,
        amount: 0,
        paymentId: paymentRecord?.id,
        message: 'Fee waived - no payment required'
      };
    }

    // Tokenize the card
    const tokenResult = await this.card.tokenize();

    if (tokenResult.status !== 'OK') {
      const rawMsg = tokenResult.errors?.[0]?.message || 'Card tokenization failed';
      // Detect sandbox-mode errors shown to real users and provide a friendly message
      if (rawMsg.toLowerCase().includes('sandbox') || rawMsg.toLowerCase().includes('test number')) {
        console.error('[Square] Sandbox error in production context:', rawMsg, { testMode: this.config?.test_mode });
        throw new Error('Payment processing error. Please refresh the page and try again. If the problem persists, contact us.');
      }
      throw new Error(rawMsg);
    }

    // Get default amount for record
    const defaultAmount = (await this.getFeeSettings(feeType))?.default_amount || amount;

    // Create pending payment record
    const { data: paymentRecord, error: insertError } = await supabase
      .from('square_payments')
      .insert({
        payment_type: feeType,
        reference_type: referenceType,
        reference_id: referenceId,
        amount: amount,
        fee_code_used: code?.toUpperCase() || null,
        original_amount: defaultAmount,
        status: 'pending'
      })
      .select()
      .single();

    if (insertError) {
      throw new Error('Failed to create payment record');
    }

    try {
      // Call the Edge Function to process payment
      const { data: result, error: processError } = await supabase.functions.invoke('process-square-payment', {
        body: {
          sourceId: tokenResult.token,
          amount: Math.round(amount * 100), // Convert to cents
          paymentRecordId: paymentRecord.id,
          buyerEmail: buyerEmail,
          note: `${feeType.replace(/_/g, ' ')} - Ref: ${referenceId}`
        }
      });

      if (processError || !result.success) {
        // Update payment record with failure
        await supabase
          .from('square_payments')
          .update({
            status: 'failed',
            error_message: processError?.message || result?.error || 'Payment processing failed',
            updated_at: new Date().toISOString()
          })
          .eq('id', paymentRecord.id);

        throw new Error(processError?.message || result?.error || 'Payment processing failed');
      }

      // Update payment record with success
      await supabase
        .from('square_payments')
        .update({
          status: 'completed',
          square_payment_id: result.paymentId,
          square_order_id: result.orderId,
          square_receipt_url: result.receiptUrl,
          updated_at: new Date().toISOString()
        })
        .eq('id', paymentRecord.id);

      // Dual-write to ledger
      const categoryMap = {
        rental_application: 'application_fee',
        event_cleaning_deposit: 'event_cleaning_deposit',
        event_reservation_deposit: 'event_reservation_deposit',
      };
      await supabase.from('ledger').insert({
        direction: 'income',
        category: categoryMap[feeType] || 'other',
        amount: amount,
        payment_method: 'square',
        transaction_date: new Date().toISOString().split('T')[0],
        square_payment_id: paymentRecord.id,
        rental_application_id: referenceType === 'rental_application' ? referenceId : null,
        event_request_id: referenceType === 'event_hosting_request' ? referenceId : null,
        status: 'completed',
        description: `Square payment: ${feeType.replace(/_/g, ' ')}`,
        recorded_by: 'system:square-service',
        is_test: !!this.config?.test_mode,
      });

      // Increment code usage if applicable
      if (priceInfo.codeId) {
        await this.incrementCodeUsage(priceInfo.codeId);
      }

      return {
        success: true,
        amount: amount,
        paymentId: paymentRecord.id,
        squarePaymentId: result.paymentId,
        receiptUrl: result.receiptUrl,
        message: 'Payment successful'
      };

    } catch (error) {
      // Update payment record with failure
      await supabase
        .from('square_payments')
        .update({
          status: 'failed',
          error_message: error.message,
          updated_at: new Date().toISOString()
        })
        .eq('id', paymentRecord.id);

      throw error;
    }
  }

  /**
   * Increment the usage count for a fee code
   */
  async incrementCodeUsage(codeId) {
    await supabase.rpc('increment_fee_code_usage', { code_id: codeId });
  }

  /**
   * Check if a payment exists for a reference
   */
  async getPaymentForReference(referenceType, referenceId, paymentType = null) {
    let query = supabase
      .from('square_payments')
      .select('*')
      .eq('reference_type', referenceType)
      .eq('reference_id', referenceId)
      .eq('status', 'completed');

    if (paymentType) {
      query = query.eq('payment_type', paymentType);
    }

    const { data, error } = await query;
    return data || [];
  }

  /**
   * Destroy the card element (cleanup)
   */
  async destroy() {
    if (this.card) {
      await this.card.destroy();
      this.card = null;
    }
  }
}

// Export singleton instance
export const squareService = new SquareService();
export default squareService;
