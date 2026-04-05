/**
 * Event Service - Workflow management for event hosting requests
 *
 * Handles:
 * - Event request lifecycle (submit, review, approve, deny, delay)
 * - Event agreement generation and tracking
 * - Deposit tracking (reservation deposit, cleaning deposit, rental fee)
 * - Payment tracking
 */

import { supabase } from './supabase.js';
import { formatLongDate } from './timezone.js';

// =============================================
// STATUS CONSTANTS
// =============================================

const REQUEST_STATUS = {
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under_review',
  APPROVED: 'approved',
  DENIED: 'denied',
  WITHDRAWN: 'withdrawn',
};

const AGREEMENT_STATUS = {
  PENDING: 'pending',
  GENERATED: 'generated',
  SENT: 'sent',
  SIGNED: 'signed',
};

const DEPOSIT_STATUS = {
  PENDING: 'pending',
  REQUESTED: 'requested',
  PARTIAL: 'partial',
  RECEIVED: 'received',
  CONFIRMED: 'confirmed',
  REFUNDED: 'refunded',
};

const PAYMENT_TYPE = {
  RESERVATION_DEPOSIT: 'reservation_deposit',
  CLEANING_DEPOSIT: 'cleaning_deposit',
  RENTAL_FEE: 'rental_fee',
  DAMAGE_DEDUCTION: 'damage_deduction',
  REFUND: 'refund',
};

const PAYMENT_METHOD = {
  VENMO: 'venmo',
  ZELLE: 'zelle',
  PAYPAL: 'paypal',
  BANK_ACH: 'bank_ach',
  CASH: 'cash',
  CHECK: 'check',
};

const EVENT_TYPE = {
  PARTY: 'party',
  WORKSHOP: 'workshop',
  RETREAT: 'retreat',
  CEREMONY: 'ceremony',
  MEETING: 'meeting',
  PHOTOSHOOT: 'photoshoot',
  OTHER: 'other',
};

// Default fee amounts
const DEFAULT_FEES = {
  RENTAL_FEE: 295,
  RESERVATION_DEPOSIT: 95,
  CLEANING_DEPOSIT: 195,
};

// =============================================
// EVENT REQUEST MANAGEMENT
// =============================================

/**
 * Get all event hosting requests with related data
 */
async function getRequests(filters = {}) {
  let query = supabase
    .from('event_hosting_requests')
    .select(`
      *,
      person:person_id(id, first_name, last_name, email, phone, type),
      requested_spaces:event_request_spaces(
        space_type,
        space:space_id(id, name, type)
      )
    `)
    .order('submitted_at', { ascending: false });

  // Filter archived requests (default: exclude archived)
  if (filters.includeArchived !== true) {
    query = query.or('is_archived.is.null,is_archived.eq.false');
  }

  // Apply filters
  if (filters.request_status) {
    if (Array.isArray(filters.request_status)) {
      query = query.in('request_status', filters.request_status);
    } else {
      query = query.eq('request_status', filters.request_status);
    }
  }

  if (filters.agreement_status) {
    query = query.eq('agreement_status', filters.agreement_status);
  }

  if (filters.deposit_status) {
    query = query.eq('deposit_status', filters.deposit_status);
  }

  if (filters.event_date_from) {
    query = query.gte('event_date', filters.event_date_from);
  }

  if (filters.event_date_to) {
    query = query.lte('event_date', filters.event_date_to);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching event requests:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get a single event request by ID
 */
async function getRequest(requestId) {
  const { data, error } = await supabase
    .from('event_hosting_requests')
    .select(`
      *,
      person:person_id(id, first_name, last_name, email, phone, type),
      requested_spaces:event_request_spaces(
        space_type,
        space:space_id(id, name, type, location)
      )
    `)
    .eq('id', requestId)
    .single();

  if (error) {
    console.error('Error fetching event request:', error);
    throw error;
  }

  return data;
}

/**
 * Determine pipeline stage for an event request
 */
function getPipelineStage(request) {
  // Completed - event has happened and deposits handled
  if (request.event_completed_at) return 'complete';

  // Ready for event
  if (request.deposit_status === DEPOSIT_STATUS.CONFIRMED) return 'ready';

  // Deposit stage
  if ([DEPOSIT_STATUS.REQUESTED, DEPOSIT_STATUS.PARTIAL, DEPOSIT_STATUS.RECEIVED].includes(request.deposit_status)) {
    return 'deposit';
  }

  // Contract stage
  if ([AGREEMENT_STATUS.GENERATED, AGREEMENT_STATUS.SENT, AGREEMENT_STATUS.SIGNED].includes(request.agreement_status)) {
    return 'contract';
  }

  // Approved - ready for contract
  if (request.request_status === REQUEST_STATUS.APPROVED) return 'approved';

  // Denied (separate handling)
  if (request.request_status === REQUEST_STATUS.DENIED) return 'denied';

  // Default - in requests column
  return 'requests';
}

/**
 * Create a new event hosting request
 */
async function createRequest(personId, eventData) {
  const {
    organization_name = null,
    has_hosted_before = false,
    event_name,
    event_description = null,
    event_type = null,
    event_date,
    event_start_time,
    event_end_time,
    expected_guests,
    is_ticketed = false,
    marketing_materials_link = null,
    special_requests = null,
    setup_staff_name = null,
    setup_staff_phone = null,
    cleanup_staff_name = null,
    cleanup_staff_phone = null,
    parking_manager_name = null,
    parking_manager_phone = null,
    requested_space_ids = [],
    // Acknowledgments
    ack_no_address_posting = false,
    ack_parking_management = false,
    ack_noise_curfew = false,
    ack_no_alcohol_inside = false,
    ack_no_meat_inside = false,
    ack_no_rvs = false,
    ack_no_animals_inside = false,
    ack_cleaning_responsibility = false,
    ack_linens_furniture = false,
    ack_propane_reimbursement = false,
  } = eventData;

  // Create the event request
  const { data: request, error } = await supabase
    .from('event_hosting_requests')
    .insert({
      person_id: personId,
      organization_name,
      has_hosted_before,
      event_name,
      event_description,
      event_type,
      event_date,
      event_start_time,
      event_end_time,
      expected_guests,
      is_ticketed,
      marketing_materials_link,
      special_requests,
      setup_staff_name,
      setup_staff_phone,
      cleanup_staff_name,
      cleanup_staff_phone,
      parking_manager_name,
      parking_manager_phone,
      ack_no_address_posting,
      ack_parking_management,
      ack_noise_curfew,
      ack_no_alcohol_inside,
      ack_no_meat_inside,
      ack_no_rvs,
      ack_no_animals_inside,
      ack_cleaning_responsibility,
      ack_linens_furniture,
      ack_propane_reimbursement,
      request_status: REQUEST_STATUS.SUBMITTED,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating event request:', error);
    throw error;
  }

  // Add requested spaces
  if (requested_space_ids.length > 0) {
    const spaceLinks = requested_space_ids.map(spaceId => ({
      event_request_id: request.id,
      space_id: spaceId,
      space_type: 'requested',
    }));

    const { error: spaceError } = await supabase
      .from('event_request_spaces')
      .insert(spaceLinks);

    if (spaceError) {
      console.error('Error linking spaces to request:', spaceError);
    }
  }

  return request;
}

/**
 * Start reviewing an event request
 */
async function startReview(requestId, reviewedBy = null) {
  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      request_status: REQUEST_STATUS.UNDER_REVIEW,
      reviewed_by: reviewedBy,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Approve event request with terms
 */
async function approveRequest(requestId, terms) {
  const {
    approved_max_guests,
    rental_fee = DEFAULT_FEES.RENTAL_FEE,
    reservation_fee = DEFAULT_FEES.RESERVATION_DEPOSIT,
    cleaning_deposit = DEFAULT_FEES.CLEANING_DEPOSIT,
    additional_terms = null,
    approved_space_ids = [],
    excluded_space_ids = [],
  } = terms;

  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      request_status: REQUEST_STATUS.APPROVED,
      approved_max_guests,
      rental_fee,
      reservation_fee,
      cleaning_deposit,
      additional_terms,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;

  // Update approved/excluded spaces
  // First remove existing approved/excluded entries
  await supabase
    .from('event_request_spaces')
    .delete()
    .eq('event_request_id', requestId)
    .in('space_type', ['approved', 'excluded']);

  // Add approved spaces
  if (approved_space_ids.length > 0) {
    const approvedLinks = approved_space_ids.map(spaceId => ({
      event_request_id: requestId,
      space_id: spaceId,
      space_type: 'approved',
    }));

    await supabase.from('event_request_spaces').insert(approvedLinks);
  }

  // Add excluded spaces
  if (excluded_space_ids.length > 0) {
    const excludedLinks = excluded_space_ids.map(spaceId => ({
      event_request_id: requestId,
      space_id: spaceId,
      space_type: 'excluded',
    }));

    await supabase.from('event_request_spaces').insert(excludedLinks);
  }

  return data;
}

/**
 * Save terms without changing request status (auto-save)
 */
async function saveTerms(requestId, terms) {
  const {
    approved_max_guests,
    rental_fee,
    reservation_fee,
    cleaning_deposit,
    additional_terms,
    approved_space_ids,
    excluded_space_ids,
  } = terms;

  const updateData = {
    updated_at: new Date().toISOString(),
  };

  if (approved_max_guests !== undefined) updateData.approved_max_guests = approved_max_guests;
  if (rental_fee !== undefined) updateData.rental_fee = rental_fee;
  if (reservation_fee !== undefined) updateData.reservation_fee = reservation_fee;
  if (cleaning_deposit !== undefined) updateData.cleaning_deposit = cleaning_deposit;
  if (additional_terms !== undefined) updateData.additional_terms = additional_terms;

  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update(updateData)
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;

  // Update spaces if provided
  if (approved_space_ids !== undefined || excluded_space_ids !== undefined) {
    // Remove existing approved/excluded
    await supabase
      .from('event_request_spaces')
      .delete()
      .eq('event_request_id', requestId)
      .in('space_type', ['approved', 'excluded']);

    if (approved_space_ids && approved_space_ids.length > 0) {
      const approvedLinks = approved_space_ids.map(spaceId => ({
        event_request_id: requestId,
        space_id: spaceId,
        space_type: 'approved',
      }));
      await supabase.from('event_request_spaces').insert(approvedLinks);
    }

    if (excluded_space_ids && excluded_space_ids.length > 0) {
      const excludedLinks = excluded_space_ids.map(spaceId => ({
        event_request_id: requestId,
        space_id: spaceId,
        space_type: 'excluded',
      }));
      await supabase.from('event_request_spaces').insert(excludedLinks);
    }
  }

  return data;
}

/**
 * Deny event request
 */
async function denyRequest(requestId, reason) {
  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      request_status: REQUEST_STATUS.DENIED,
      denial_reason: reason,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}


/**
 * Archive an event request
 */
async function archiveRequest(requestId) {
  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      is_archived: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Unarchive an event request
 */
async function unarchiveRequest(requestId) {
  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      is_archived: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Toggle test flag
 */
async function toggleTestFlag(requestId, isTest) {
  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      is_test: isTest,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// =============================================
// AGREEMENT WORKFLOW
// =============================================

/**
 * Update agreement status
 */
async function updateAgreementStatus(requestId, status, documentUrl = null) {
  const updateData = {
    agreement_status: status,
    updated_at: new Date().toISOString(),
  };

  if (status === AGREEMENT_STATUS.GENERATED) {
    updateData.agreement_generated_at = new Date().toISOString();
    if (documentUrl) updateData.agreement_document_url = documentUrl;
  } else if (status === AGREEMENT_STATUS.SENT) {
    updateData.agreement_sent_at = new Date().toISOString();
  } else if (status === AGREEMENT_STATUS.SIGNED) {
    updateData.agreement_signed_at = new Date().toISOString();
    if (documentUrl) updateData.signed_pdf_url = documentUrl;
  }

  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update(updateData)
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get agreement data formatted for template parsing
 */
async function getAgreementData(requestId) {
  const request = await getRequest(requestId);
  if (!request) throw new Error('Event request not found');

  const person = request.person;

  // Format client name
  const clientName = person
    ? `${person.first_name || ''} ${person.last_name || ''}`.trim()
    : 'Unknown';

  // Format date in Austin timezone
  const eventDate = request.event_date
    ? formatLongDate(request.event_date)
    : '';

  // Format times
  const formatTime = (timeStr) => {
    if (!timeStr) return '';
    const [hours, minutes] = timeStr.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    return `${hour12}:${minutes} ${ampm}`;
  };

  // Get spaces by type
  const requestedSpaces = request.requested_spaces || [];
  const approvedSpaces = requestedSpaces
    .filter(s => s.space_type === 'approved')
    .map(s => s.space?.name)
    .filter(Boolean);
  const excludedSpaces = requestedSpaces
    .filter(s => s.space_type === 'excluded')
    .map(s => s.space?.name)
    .filter(Boolean);

  // Format spaces as bullet lists
  const formatSpaceList = (spaces) => {
    if (!spaces || spaces.length === 0) return 'None specified';
    return spaces.map(s => `- ${s}`).join('\n');
  };

  // Calculate total due and reservation credit
  const rentalFee = parseFloat(request.rental_fee) || 0;
  const reservationFee = parseFloat(request.reservation_fee) || 0;
  const cleaningDeposit = parseFloat(request.cleaning_deposit) || 0;

  // Check for reservation deposit paid through Square
  const reservationDepositPaid = request.deposit_status === 'paid' && request.reservation_deposit_amount > 0
    ? parseFloat(request.reservation_deposit_amount)
    : 0;

  // Calculate rental fee due after credit
  const rentalFeeDue = Math.max(0, rentalFee - reservationDepositPaid);
  const totalDue = rentalFeeDue + cleaningDeposit;

  // Generate reservation deposit credit text
  let reservationFeeCredit = '';
  if (reservationDepositPaid > 0) {
    reservationFeeCredit = `Reservation deposit of $${reservationDepositPaid} has been received and will be credited toward the rental fee.`;
  }

  // Format currency
  const formatCurrency = (amount) => {
    if (amount === 0) return '$0 (complementary)';
    return `$${amount.toFixed(2).replace(/\.00$/, '')}`;
  };

  // Format agreement date
  const agreementDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return {
    // Client info
    clientName,
    clientEmail: person?.email || '',
    clientPhone: person?.phone || '',

    // Event details
    eventDate,
    eventStartTime: formatTime(request.event_start_time),
    eventEndTime: formatTime(request.event_end_time),
    maxGuests: request.approved_max_guests || request.expected_guests || '',

    // Financial
    rentalFee: formatCurrency(rentalFee),
    reservationFee: formatCurrency(reservationFee),
    cleaningDeposit: formatCurrency(cleaningDeposit),
    totalDue: formatCurrency(totalDue),
    reservationFeePaid: reservationDepositPaid > 0 ? formatCurrency(reservationDepositPaid) : '$0',
    reservationFeeCredit: reservationFeeCredit,
    rentalFeeDue: formatCurrency(rentalFeeDue),

    // Spaces
    includedSpaces: formatSpaceList(approvedSpaces),
    excludedSpaces: formatSpaceList(excludedSpaces),

    // Meta
    agreementDate,
    additionalTerms: request.additional_terms || '',

    // Raw values for calculations
    raw: {
      rentalFee,
      reservationFee,
      cleaningDeposit,
      totalDue,
      reservationDepositPaid,
      rentalFeeDue,
      eventDate: request.event_date,
      maxGuests: request.approved_max_guests || request.expected_guests,
    },
  };
}

// =============================================
// DEPOSIT TRACKING
// =============================================

/**
 * Request deposits from client
 */
async function requestDeposit(requestId) {
  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      deposit_status: DEPOSIT_STATUS.REQUESTED,
      deposit_requested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Record reservation deposit payment
 */
async function recordReservationFee(requestId, details = {}) {
  const { method = null, transaction_id = null, notes = null } = details;

  const request = await getRequest(requestId);

  // Update the request
  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      reservation_fee_paid: true,
      reservation_fee_paid_at: new Date().toISOString(),
      reservation_fee_method: method,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;

  // Create payment record
  const { data: epData } = await supabase.from('event_payments').insert({
    event_request_id: requestId,
    payment_type: PAYMENT_TYPE.RESERVATION_DEPOSIT,
    amount_due: request.reservation_fee || DEFAULT_FEES.RESERVATION_DEPOSIT,
    amount_paid: request.reservation_fee || DEFAULT_FEES.RESERVATION_DEPOSIT,
    paid_date: new Date().toISOString().split('T')[0],
    payment_method: method,
    transaction_id,
    notes,
  }).select().single();

  // Dual-write to ledger
  const resAmt = request.reservation_fee || DEFAULT_FEES.RESERVATION_DEPOSIT;
  const personName = request.person ? `${request.person.first_name} ${request.person.last_name}` : null;
  await supabase.from('ledger').insert({
    direction: 'income',
    category: 'event_reservation_deposit',
    amount: resAmt,
    payment_method: method || 'other',
    transaction_date: new Date().toISOString().split('T')[0],
    person_id: request.person_id || null,
    person_name: personName,
    event_request_id: requestId,
    event_payment_id: epData?.id || null,
    status: 'completed',
    description: 'Event reservation deposit',
    recorded_by: 'system:event-service',
    is_test: !!request.is_test,
  });

  // Update overall deposit status
  await updateOverallDepositStatus(requestId);

  return data;
}

/**
 * Record cleaning deposit payment
 */
async function recordCleaningDeposit(requestId, details = {}) {
  const { method = null, transaction_id = null, notes = null } = details;

  const request = await getRequest(requestId);

  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      cleaning_deposit_paid: true,
      cleaning_deposit_paid_at: new Date().toISOString(),
      cleaning_deposit_method: method,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;

  // Create payment record
  const { data: epData2 } = await supabase.from('event_payments').insert({
    event_request_id: requestId,
    payment_type: PAYMENT_TYPE.CLEANING_DEPOSIT,
    amount_due: request.cleaning_deposit || DEFAULT_FEES.CLEANING_DEPOSIT,
    amount_paid: request.cleaning_deposit || DEFAULT_FEES.CLEANING_DEPOSIT,
    paid_date: new Date().toISOString().split('T')[0],
    payment_method: method,
    transaction_id,
    notes,
  }).select().single();

  // Dual-write to ledger
  const cleanAmt = request.cleaning_deposit || DEFAULT_FEES.CLEANING_DEPOSIT;
  const cleanPersonName = request.person ? `${request.person.first_name} ${request.person.last_name}` : null;
  await supabase.from('ledger').insert({
    direction: 'income',
    category: 'event_cleaning_deposit',
    amount: cleanAmt,
    payment_method: method || 'other',
    transaction_date: new Date().toISOString().split('T')[0],
    person_id: request.person_id || null,
    person_name: cleanPersonName,
    event_request_id: requestId,
    event_payment_id: epData2?.id || null,
    status: 'completed',
    description: 'Event cleaning deposit',
    recorded_by: 'system:event-service',
    is_test: !!request.is_test,
  });

  await updateOverallDepositStatus(requestId);

  return data;
}

/**
 * Record rental fee payment
 */
async function recordRentalFee(requestId, details = {}) {
  const { method = null, transaction_id = null, notes = null } = details;

  const request = await getRequest(requestId);

  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      rental_fee_paid: true,
      rental_fee_paid_at: new Date().toISOString(),
      rental_fee_method: method,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;

  // Create payment record
  const { data: epData3 } = await supabase.from('event_payments').insert({
    event_request_id: requestId,
    payment_type: PAYMENT_TYPE.RENTAL_FEE,
    amount_due: request.rental_fee || DEFAULT_FEES.RENTAL_FEE,
    amount_paid: request.rental_fee || DEFAULT_FEES.RENTAL_FEE,
    paid_date: new Date().toISOString().split('T')[0],
    payment_method: method,
    transaction_id,
    notes,
  }).select().single();

  // Dual-write to ledger
  const rentalAmt = request.rental_fee || DEFAULT_FEES.RENTAL_FEE;
  const rentalPersonName = request.person ? `${request.person.first_name} ${request.person.last_name}` : null;
  await supabase.from('ledger').insert({
    direction: 'income',
    category: 'event_rental_fee',
    amount: rentalAmt,
    payment_method: method || 'other',
    transaction_date: new Date().toISOString().split('T')[0],
    person_id: request.person_id || null,
    person_name: rentalPersonName,
    event_request_id: requestId,
    event_payment_id: epData3?.id || null,
    status: 'completed',
    description: 'Event rental fee',
    recorded_by: 'system:event-service',
    is_test: !!request.is_test,
  });

  await updateOverallDepositStatus(requestId);

  return data;
}

/**
 * Update overall deposit status based on individual payments
 */
async function updateOverallDepositStatus(requestId) {
  const request = await getRequest(requestId);

  const reservationPaid = request.reservation_fee_paid;
  const cleaningPaid = request.cleaning_deposit_paid;
  const rentalPaid = request.rental_fee_paid;

  let newStatus = DEPOSIT_STATUS.PENDING;

  if (reservationPaid && cleaningPaid && rentalPaid) {
    newStatus = DEPOSIT_STATUS.RECEIVED;
  } else if (reservationPaid || cleaningPaid || rentalPaid) {
    newStatus = DEPOSIT_STATUS.PARTIAL;
  } else if (request.deposit_requested_at) {
    newStatus = DEPOSIT_STATUS.REQUESTED;
  }

  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      deposit_status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Confirm deposits (funds cleared)
 */
async function confirmDeposit(requestId) {
  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      deposit_status: DEPOSIT_STATUS.CONFIRMED,
      deposit_confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Process deposit refund after event
 */
async function processRefund(requestId, details = {}) {
  const { refund_amount, deductions = [], notes = null } = details;

  const request = await getRequest(requestId);

  // Record any deductions
  for (const deduction of deductions) {
    await supabase.from('event_payments').insert({
      event_request_id: requestId,
      payment_type: PAYMENT_TYPE.DAMAGE_DEDUCTION,
      amount_due: 0,
      amount_paid: -deduction.amount,
      paid_date: new Date().toISOString().split('T')[0],
      notes: deduction.reason,
    });
  }

  // Record refund
  if (refund_amount > 0) {
    await supabase.from('event_payments').insert({
      event_request_id: requestId,
      payment_type: PAYMENT_TYPE.REFUND,
      amount_due: 0,
      amount_paid: -refund_amount,
      paid_date: new Date().toISOString().split('T')[0],
      notes,
    });
  }

  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      deposit_status: DEPOSIT_STATUS.REFUNDED,
      deposit_refunded_at: new Date().toISOString(),
      deposit_refund_amount: refund_amount,
      deposit_refund_notes: notes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// =============================================
// EVENT COMPLETION
// =============================================

/**
 * Mark event as completed
 */
async function markEventCompleted(requestId) {
  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      event_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Mark cleaning as verified
 */
async function verifyCleaningPhotos(requestId) {
  const { data, error } = await supabase
    .from('event_hosting_requests')
    .update({
      cleaning_verified_at: new Date().toISOString(),
      cleaning_photos_submitted: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// =============================================
// PAYMENT METHODS (reuse from rental service)
// =============================================

/**
 * Get payment methods
 */
async function getPaymentMethods(activeOnly = true) {
  let query = supabase
    .from('payment_methods')
    .select(`
      *,
      qr_code:qr_code_media_id(id, url)
    `)
    .order('display_order');

  if (activeOnly) {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching payment methods:', error);
    throw error;
  }

  return data || [];
}

/**
 * Generate deposit request message for client
 */
async function generateDepositRequestMessage(requestId) {
  const request = await getRequest(requestId);
  if (!request) throw new Error('Event request not found');

  const person = request.person;
  const clientName = person ? person.first_name : 'there';

  const rentalFee = parseFloat(request.rental_fee) || 0;
  const reservationFee = parseFloat(request.reservation_fee) || 0;
  const cleaningDeposit = parseFloat(request.cleaning_deposit) || 0;
  const totalDue = rentalFee + reservationFee + cleaningDeposit;

  const eventDate = request.event_date
    ? new Date(request.event_date).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : 'your event date';

  const message = `Hi ${clientName}!

Your event hosting request for ${eventDate} has been approved!

Payment Details:
- Rental Fee: $${rentalFee}
- Reservation Deposit (refundable): $${reservationFee}
- Cleaning/Damage Deposit (refundable): $${cleaningDeposit}
- Total Due: $${totalDue}

The reservation deposit and cleaning deposit are refundable after your event, provided there is no damage and cleaning is completed per the agreement.

Please send payment via Venmo, Zelle, or PayPal. Include your name and "Event ${request.event_date}" in the memo.

Thank you!
YOUR_PROPERTY_NAME`;

  return message;
}

// =============================================
// EXPORTS
// =============================================

export const eventService = {
  // Constants
  REQUEST_STATUS,
  AGREEMENT_STATUS,
  DEPOSIT_STATUS,
  PAYMENT_TYPE,
  PAYMENT_METHOD,
  EVENT_TYPE,
  DEFAULT_FEES,

  // Request management
  getRequests,
  getRequest,
  getPipelineStage,
  createRequest,
  startReview,
  approveRequest,
  saveTerms,
  denyRequest,
  archiveRequest,
  unarchiveRequest,
  toggleTestFlag,

  // Agreement workflow
  updateAgreementStatus,
  getAgreementData,

  // Deposit tracking
  requestDeposit,
  recordReservationFee,
  recordCleaningDeposit,
  recordRentalFee,
  updateOverallDepositStatus,
  confirmDeposit,
  processRefund,

  // Event completion
  markEventCompleted,
  verifyCleaningPhotos,

  // Payment methods
  getPaymentMethods,
  generateDepositRequestMessage,
};
