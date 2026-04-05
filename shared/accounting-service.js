/**
 * Accounting Service
 * Unified ledger for all financial activity - income, expenses, refunds.
 * Supports QuickBooks reconciliation and Square refunds.
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';

export const DIRECTION = {
  INCOME: 'income',
  EXPENSE: 'expense'
};

export const CATEGORY = {
  APPLICATION_FEE: 'application_fee',
  RENT: 'rent',
  PRORATED_RENT: 'prorated_rent',
  SECURITY_DEPOSIT: 'security_deposit',
  MOVE_IN_DEPOSIT: 'move_in_deposit',
  RESERVATION_DEPOSIT: 'reservation_deposit',
  EVENT_RENTAL_FEE: 'event_rental_fee',
  EVENT_RESERVATION_DEPOSIT: 'event_reservation_deposit',
  EVENT_CLEANING_DEPOSIT: 'event_cleaning_deposit',
  REFUND: 'refund',
  DAMAGE_DEDUCTION: 'damage_deduction',
  LATE_FEE: 'late_fee',
  ASSOCIATE_PAYMENT: 'associate_payment',
  OTHER: 'other'
};

export const CATEGORY_LABELS = {
  application_fee: 'Application Fee',
  rent: 'Rent',
  prorated_rent: 'Prorated Rent',
  security_deposit: 'Security Deposit',
  move_in_deposit: 'Move-in Deposit',
  reservation_deposit: 'Reservation Deposit',
  event_rental_fee: 'Event Rental Fee',
  event_reservation_deposit: 'Event Reservation Deposit',
  event_cleaning_deposit: 'Event Cleaning Deposit',
  refund: 'Refund',
  damage_deduction: 'Damage Deduction',
  late_fee: 'Late Fee',
  associate_payment: 'Associate Payment',
  merchandise: 'Merchandise/Supplies',
  other: 'Other'
};

export const PAYMENT_METHODS = {
  SQUARE: 'square',
  VENMO: 'venmo',
  ZELLE: 'zelle',
  PAYPAL: 'paypal',
  CASHAPP: 'cashapp',
  BANK_ACH: 'bank_ach',
  CASH: 'cash',
  CHECK: 'check',
  STRIPE: 'stripe',
  OTHER: 'other'
};

export const PAYMENT_METHOD_LABELS = {
  square: 'Square',
  venmo: 'Venmo',
  zelle: 'Zelle',
  paypal: 'PayPal',
  cashapp: 'Cash App',
  bank_ach: 'Bank/ACH',
  cash: 'Cash',
  check: 'Check',
  stripe: 'Stripe',
  other: 'Other'
};

export const STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  VOIDED: 'voided'
};

class AccountingService {

  /**
   * Get transactions with filters and pagination
   */
  async getTransactions(filters = {}) {
    let query = supabase
      .from('ledger')
      .select('*, person:person_id(id, first_name, last_name)', { count: 'exact' });

    if (filters.dateFrom) {
      query = query.gte('transaction_date', filters.dateFrom);
    }
    if (filters.dateTo) {
      query = query.lte('transaction_date', filters.dateTo);
    }
    if (filters.direction) {
      query = query.eq('direction', filters.direction);
    }
    if (filters.category) {
      if (Array.isArray(filters.category)) {
        query = query.in('category', filters.category);
      } else {
        query = query.eq('category', filters.category);
      }
    }
    if (filters.paymentMethod) {
      query = query.eq('payment_method', filters.paymentMethod);
    }
    if (filters.status) {
      query = query.eq('status', filters.status);
    }
    if (filters.isReconciled !== undefined && filters.isReconciled !== null) {
      query = query.eq('is_reconciled', filters.isReconciled);
    }
    if (filters.personId) {
      query = query.eq('person_id', filters.personId);
    }
    if (filters.search) {
      query = query.or(`description.ilike.%${filters.search}%,person_name.ilike.%${filters.search}%,notes.ilike.%${filters.search}%,qb_reference.ilike.%${filters.search}%`);
    }

    // Exclude voided by default unless explicitly included
    if (!filters.includeVoided) {
      query = query.neq('status', 'voided');
    }

    // Exclude test/sandbox transactions by default
    if (!filters.includeTest) {
      query = query.eq('is_test', false);
    }

    query = query.order('transaction_date', { ascending: false })
                 .order('created_at', { ascending: false });

    if (filters.limit) {
      query = query.limit(filters.limit);
    }
    if (filters.offset) {
      query = query.range(filters.offset, filters.offset + (filters.limit || 50) - 1);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('Failed to fetch transactions:', error);
      throw error;
    }

    return { data: data || [], count };
  }

  /**
   * Get a single transaction by ID
   */
  async getTransaction(id) {
    const { data, error } = await supabase
      .from('ledger')
      .select('*, person:person_id(id, first_name, last_name)')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Create a new ledger entry
   */
  async createTransaction(data) {
    const record = {
      direction: data.direction,
      category: data.category,
      amount: data.amount,
      payment_method: data.paymentMethod || data.payment_method,
      transaction_date: data.transactionDate || data.transaction_date || new Date().toISOString().split('T')[0],
      person_id: data.personId || data.person_id || null,
      person_name: data.personName || data.person_name || null,
      description: data.description || null,
      notes: data.notes || null,
      status: data.status || 'completed',
      recorded_by: data.recordedBy || data.recorded_by || 'admin',
      // Source links
      rental_application_id: data.rentalApplicationId || data.rental_application_id || null,
      assignment_id: data.assignmentId || data.assignment_id || null,
      event_request_id: data.eventRequestId || data.event_request_id || null,
      square_payment_id: data.squarePaymentId || data.square_payment_id || null,
      paypal_payment_id: data.paypalPaymentId || data.paypal_payment_id || null,
      paypal_transaction_id: data.paypalTransactionId || data.paypal_transaction_id || null,
      rental_payment_id: data.rentalPaymentId || data.rental_payment_id || null,
      event_payment_id: data.eventPaymentId || data.event_payment_id || null,
      source_payment_id: data.sourcePaymentId || data.source_payment_id || null,
      refund_of_ledger_id: data.refundOfLedgerId || data.refund_of_ledger_id || null,
      period_start: data.periodStart || data.period_start || null,
      period_end: data.periodEnd || data.period_end || null,
    };

    const { data: result, error } = await supabase
      .from('ledger')
      .insert(record)
      .select()
      .single();

    if (error) {
      console.error('Failed to create transaction:', error);
      throw error;
    }

    return result;
  }

  /**
   * Update a transaction (notes, reconciliation, description only)
   */
  async updateTransaction(id, updates) {
    const allowed = {};
    if (updates.notes !== undefined) allowed.notes = updates.notes;
    if (updates.description !== undefined) allowed.description = updates.description;
    if (updates.qb_reference !== undefined) allowed.qb_reference = updates.qb_reference;
    if (updates.reconciliation_notes !== undefined) allowed.reconciliation_notes = updates.reconciliation_notes;
    allowed.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('ledger')
      .update(allowed)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Void a transaction (soft delete)
   */
  async voidTransaction(id, reason) {
    const { data, error } = await supabase
      .from('ledger')
      .update({
        status: 'voided',
        notes: reason ? `VOIDED: ${reason}` : 'VOIDED',
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Mark a transaction as reconciled
   */
  async reconcileTransaction(id, qbReference, notes) {
    const { data, error } = await supabase
      .from('ledger')
      .update({
        is_reconciled: true,
        reconciled_at: new Date().toISOString(),
        reconciled_by: 'admin',
        qb_reference: qbReference || null,
        reconciliation_notes: notes || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Bulk reconcile multiple transactions
   */
  async bulkReconcile(ids, qbReference) {
    const { data, error } = await supabase
      .from('ledger')
      .update({
        is_reconciled: true,
        reconciled_at: new Date().toISOString(),
        reconciled_by: 'admin',
        qb_reference: qbReference || null,
        updated_at: new Date().toISOString()
      })
      .in('id', ids)
      .select();

    if (error) throw error;
    return data;
  }

  /**
   * Un-reconcile a transaction
   */
  async unreconcile(id) {
    const { data, error } = await supabase
      .from('ledger')
      .update({
        is_reconciled: false,
        reconciled_at: null,
        reconciled_by: null,
        qb_reference: null,
        reconciliation_notes: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Categories that represent recurring income (rent) - use accrual basis (period_start)
   */
  static RENT_CATEGORIES = ['rent', 'prorated_rent'];

  /**
   * Categories that represent deposits (refundable, held in trust)
   */
  static DEPOSIT_CATEGORIES = ['security_deposit', 'move_in_deposit', 'reservation_deposit', 'event_cleaning_deposit', 'event_reservation_deposit'];

  /**
   * Categories that represent one-time fees (earned on receipt)
   */
  static FEE_CATEGORIES = ['application_fee', 'event_rental_fee', 'late_fee', 'damage_deduction', 'other'];

  /**
   * Get the accrual month for a transaction.
   * - Rent/prorated rent: use period_start if available (accrual), else transaction_date
   * - Everything else: use transaction_date (cash basis)
   */
  static getAccrualMonth(tx) {
    if (AccountingService.RENT_CATEGORIES.includes(tx.category) && tx.period_start) {
      return tx.period_start.substring(0, 7);
    }
    return tx.transaction_date.substring(0, 7);
  }

  /**
   * Classify a category into a group: 'rent', 'deposits', 'fees', 'refunds'
   */
  static getCategoryGroup(category) {
    if (AccountingService.RENT_CATEGORIES.includes(category)) return 'rent';
    if (AccountingService.DEPOSIT_CATEGORIES.includes(category)) return 'deposits';
    if (category === 'refund') return 'refunds';
    return 'fees';
  }

  /**
   * Get summary aggregations for a date range (accrual basis for rent)
   */
  async getSummary(dateFrom, dateTo) {
    const filters = { includeVoided: false };
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;

    const { data } = await this.getTransactions({ ...filters, limit: 10000 });

    // Top-level totals
    let totalIncome = 0;
    let totalExpenses = 0;
    let pendingIncome = 0;

    // Separated totals by category group
    let rentIncome = 0;
    let depositsHeld = 0;
    let feesIncome = 0;
    let refundsOut = 0;

    const byCategory = {};
    const byMonth = {};
    const byPaymentMethod = {};

    for (const tx of data) {
      const amt = parseFloat(tx.amount) || 0;
      const group = AccountingService.getCategoryGroup(tx.category);

      if (tx.status === 'completed') {
        if (tx.direction === 'income') {
          totalIncome += amt;
          if (group === 'rent') rentIncome += amt;
          else if (group === 'deposits') depositsHeld += amt;
          else if (group === 'fees') feesIncome += amt;
        } else {
          totalExpenses += amt;
          if (group === 'refunds' || tx.category === 'refund') refundsOut += amt;
        }
      } else if (tx.status === 'pending' && tx.direction === 'income') {
        pendingIncome += amt;
      }

      // By category
      if (!byCategory[tx.category]) {
        byCategory[tx.category] = { income: 0, expenses: 0 };
      }
      if (tx.direction === 'income') {
        byCategory[tx.category].income += amt;
      } else {
        byCategory[tx.category].expenses += amt;
      }

      // By month - use accrual month for rent, transaction_date for everything else
      const month = AccountingService.getAccrualMonth(tx);
      if (!byMonth[month]) {
        byMonth[month] = { month, income: 0, expenses: 0, net: 0, rent: 0, deposits: 0, fees: 0, refunds: 0, pending: 0 };
      }
      if (tx.status === 'completed') {
        if (tx.direction === 'income') {
          byMonth[month].income += amt;
          if (group === 'rent') byMonth[month].rent += amt;
          else if (group === 'deposits') byMonth[month].deposits += amt;
          else byMonth[month].fees += amt;
        } else {
          byMonth[month].expenses += amt;
          byMonth[month].refunds += amt;
        }
        byMonth[month].net = byMonth[month].income - byMonth[month].expenses;
      } else if (tx.status === 'pending' && tx.direction === 'income') {
        byMonth[month].pending += amt;
      }

      // By payment method
      const method = tx.payment_method || 'unknown';
      if (!byPaymentMethod[method]) byPaymentMethod[method] = 0;
      byPaymentMethod[method] += amt;
    }

    return {
      totalIncome,
      totalExpenses,
      netIncome: totalIncome - totalExpenses,
      pendingIncome,
      // Separated income
      rentIncome,
      depositsHeld,
      feesIncome,
      refundsOut,
      byCategory,
      byMonth: Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month)),
      byPaymentMethod
    };
  }

  /**
   * Initiate a Square refund via edge function
   */
  async initiateRefund(squarePaymentId, amountCents, reason, originalLedgerId, paymentRecordId) {
    const { data, error } = await supabase.functions.invoke('refund-square-payment', {
      body: {
        square_payment_id: squarePaymentId,
        amount_cents: amountCents,
        reason: reason || '',
        ledger_id: originalLedgerId || null,
        payment_record_id: paymentRecordId || null
      }
    });

    if (error) {
      console.error('Refund failed:', error);
      throw error;
    }

    if (!data.success) {
      throw new Error(data.error || 'Refund failed');
    }

    return data;
  }

  /**
   * Get refunds linked to an original transaction
   */
  async getRefundsForTransaction(ledgerId) {
    const { data, error } = await supabase
      .from('ledger')
      .select('*')
      .eq('refund_of_ledger_id', ledgerId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Get total refunded amount for a transaction
   */
  async getRefundedAmount(ledgerId) {
    const refunds = await this.getRefundsForTransaction(ledgerId);
    return refunds
      .filter(r => r.status === 'completed')
      .reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
  }

  /**
   * Export transactions as CSV string
   */
  async exportCSV(filters = {}) {
    const { data } = await this.getTransactions({ ...filters, limit: 50000 });

    const headers = [
      'Date', 'Type', 'Category', 'Description', 'Amount',
      'Payment Method', 'Person', 'Status', 'Reconciled',
      'QB Reference', 'Notes'
    ];

    const rows = data.map(tx => {
      const sign = tx.direction === 'expense' ? '-' : '';
      return [
        tx.transaction_date,
        tx.direction,
        CATEGORY_LABELS[tx.category] || tx.category,
        (tx.description || '').replace(/"/g, '""'),
        `${sign}${tx.amount}`,
        PAYMENT_METHOD_LABELS[tx.payment_method] || tx.payment_method || '',
        tx.person_name || (tx.person ? `${tx.person.first_name} ${tx.person.last_name}` : ''),
        tx.status,
        tx.is_reconciled ? 'Yes' : 'No',
        (tx.qb_reference || '').replace(/"/g, '""'),
        (tx.notes || '').replace(/"/g, '""')
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    return csvContent;
  }

  /**
   * Download CSV as file
   */
  async downloadCSV(filters = {}, filename) {
    const csv = await this.exportCSV(filters);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || `ledger-export-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Get all people for the person dropdown
   */
  async getPeople() {
    const { data, error } = await supabase
      .from('people')
      .select('id, first_name, last_name')
      .order('last_name')
      .order('first_name');

    if (error) throw error;
    return data || [];
  }
}

export const accountingService = new AccountingService();
