/**
 * Rental Service - Workflow management for rental applications
 *
 * Handles:
 * - Application lifecycle (submit, review, approve, deny, delay)
 * - Rental agreement generation and tracking
 * - Deposit tracking (move-in and security)
 * - Rent payment tracking
 * - Payment methods management
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';
import { formatDateAustin, getAustinToday, AUSTIN_TIMEZONE } from './timezone.js';
import { getAuthState } from './auth.js';

/**
 * Get activity tracking fields for any rental_applications update.
 * Stamps last_activity_at + last_activity_by (first name of current user).
 */
function activityStamp() {
  const state = getAuthState();
  const name = state.appUser?.first_name || state.appUser?.display_name || null;
  return {
    last_activity_at: new Date().toISOString(),
    last_activity_by: name,
  };
}

// Trigger iCal regeneration to sync with Airbnb
async function triggerIcalRegeneration() {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/regenerate-ical`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    const result = await response.json();
    if (result.success) {
      console.log('[iCal] Regenerated:', result.updated?.length || 0, 'files');
    } else {
      console.warn('[iCal] Regeneration failed:', result.error);
    }
  } catch (err) {
    console.warn('[iCal] Regeneration error:', err.message);
  }
}

// =============================================
// STATUS CONSTANTS
// =============================================

const APPLICATION_STATUS = {
  INQUIRY: 'inquiry',
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
};

const PAYMENT_TYPE = {
  MOVE_IN_DEPOSIT: 'move_in_deposit',
  SECURITY_DEPOSIT: 'security_deposit',
  RENT: 'rent',
  PRORATED_RENT: 'prorated_rent',
};

const PAYMENT_METHOD = {
  VENMO: 'venmo',
  ZELLE: 'zelle',
  PAYPAL: 'paypal',
  BANK_ACH: 'bank_ach',
  CASH: 'cash',
  CHECK: 'check',
};

// =============================================
// APPLICATION MANAGEMENT
// =============================================

/**
 * Get all rental applications with related data
 */
async function getApplications(filters = {}) {
  let query = supabase
    .from('rental_applications')
    .select(`
      *,
      person:person_id(id, first_name, last_name, email, phone, type, preferred_accommodation, coliving_experience, life_focus, visiting_guide_response, desired_timeframe, volunteer_interest, photo_url),
      desired_space:desired_space_id(id, name, monthly_rate),
      approved_space:approved_space_id(id, name, monthly_rate),
      assignment:assignment_id(id, status)
    `)
    .order('created_at', { ascending: false });

  // Filter archived applications (default: exclude archived)
  if (filters.includeArchived !== true) {
    query = query.or('is_archived.is.null,is_archived.eq.false');
  }

  // Apply filters
  if (filters.application_status) {
    if (Array.isArray(filters.application_status)) {
      query = query.in('application_status', filters.application_status);
    } else {
      query = query.eq('application_status', filters.application_status);
    }
  }

  if (filters.agreement_status) {
    query = query.eq('agreement_status', filters.agreement_status);
  }

  if (filters.deposit_status) {
    query = query.eq('deposit_status', filters.deposit_status);
  }

  if (filters.space_id) {
    query = query.or(`desired_space_id.eq.${filters.space_id},approved_space_id.eq.${filters.space_id}`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching applications:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get a single application by ID
 */
async function getApplication(applicationId) {
  if (!applicationId) throw new Error('Application ID is required');

  const { data, error } = await supabase
    .from('rental_applications')
    .select(`
      *,
      person:person_id(id, first_name, last_name, email, phone, type, preferred_accommodation, coliving_experience, life_focus, visiting_guide_response, desired_timeframe, volunteer_interest, photo_url),
      desired_space:desired_space_id(id, name, monthly_rate, location),
      approved_space:approved_space_id(id, name, monthly_rate, location),
      assignment:assignment_id(id, status, start_date, end_date)
    `)
    .eq('id', applicationId)
    .single();

  if (error) {
    console.error('Error fetching application:', error);
    throw error;
  }

  return data;
}

/**
 * Determine pipeline stage for an application
 */
function getPipelineStage(application) {
  // Completed - has assignment
  if (application.move_in_confirmed_at) return 'complete';

  // Ready for move-in
  if (application.deposit_status === DEPOSIT_STATUS.CONFIRMED) return 'ready';

  // Deposit stage
  if ([DEPOSIT_STATUS.REQUESTED, DEPOSIT_STATUS.PARTIAL, DEPOSIT_STATUS.RECEIVED].includes(application.deposit_status)) {
    return 'deposit';
  }

  // Contract stage (skip if lease not required)
  if (application.require_lease !== false &&
      [AGREEMENT_STATUS.GENERATED, AGREEMENT_STATUS.SENT, AGREEMENT_STATUS.SIGNED].includes(application.agreement_status)) {
    return 'contract';
  }

  // Approved - ready for contract
  if (application.application_status === APPLICATION_STATUS.APPROVED) return 'approved';

  // Denied (separate handling)
  if (application.application_status === APPLICATION_STATUS.DENIED) return 'denied';

  // Inquiry - community fit stage (before applications)
  if (application.application_status === APPLICATION_STATUS.INQUIRY) return 'community_fit';

  // Default - in applications column
  return 'applications';
}

/**
 * Create a new rental application
 * If desired_space_id and desired_move_in are provided, creates a provisional
 * "prospect" assignment to block the dates on Airbnb.
 */
async function createApplication(personId, options = {}) {
  const {
    desired_space_id = null,
    desired_move_in = null,
    desired_term = null,
  } = options;

  const { data, error } = await supabase
    .from('rental_applications')
    .insert({
      person_id: personId,
      desired_space_id,
      desired_move_in,
      desired_term,
      application_status: APPLICATION_STATUS.SUBMITTED,
      ...activityStamp(),
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating application:', error);
    throw error;
  }

  // Update person status
  await supabase
    .from('people')
    .update({ application_status: 'applicant' })
    .eq('id', personId);

  // Create provisional "prospect" assignment if space and move-in date provided
  // This blocks the dates on Airbnb while the application is being processed
  if (desired_space_id && desired_move_in) {
    try {
      // Calculate provisional end date based on desired_term (default 6 months)
      let provisionalEndDate = null;
      if (desired_term) {
        const moveIn = new Date(desired_move_in);
        const termMonths = parseInt(desired_term) || 6;
        moveIn.setMonth(moveIn.getMonth() + termMonths);
        provisionalEndDate = moveIn.toISOString().split('T')[0];
      }

      const { data: assignment, error: assignmentError } = await supabase
        .from('assignments')
        .insert({
          person_id: personId,
          type: 'dwelling',
          status: 'prospect',
          start_date: desired_move_in,
          end_date: provisionalEndDate,
          rental_application_id: data.id,
          notes: 'Provisional assignment - pending application review',
        })
        .select()
        .single();

      if (assignmentError) {
        console.error('Error creating provisional assignment:', assignmentError);
      } else {
        // Link assignment to space
        await supabase.from('assignment_spaces').insert({
          assignment_id: assignment.id,
          space_id: desired_space_id,
        });

        // Update application with assignment reference
        await supabase
          .from('rental_applications')
          .update({ assignment_id: assignment.id })
          .eq('id', data.id);

        // Trigger iCal regeneration to block dates on Airbnb
        triggerIcalRegeneration();
      }
    } catch (err) {
      console.error('Error creating provisional assignment:', err);
      // Don't fail the application creation if assignment fails
    }
  }

  return data;
}

/**
 * Start reviewing an application
 */
async function startReview(applicationId, reviewedBy = null) {
  const { data, error } = await supabase
    .from('rental_applications')
    .update({
      application_status: APPLICATION_STATUS.UNDER_REVIEW,
      reviewed_by: reviewedBy,
      updated_at: new Date().toISOString(),
      ...activityStamp(),
    })
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Approve application with terms
 */
async function approveApplication(applicationId, terms) {
  const {
    spaceId,
    rate,
    rateTerm = 'monthly',
    moveInDate,
    leaseEndDate = null,
    securityDepositAmount = 0,
    reservationDepositAmount = null, // Defaults to rate if null
    noticePeriod = '30_days',
    additionalTerms = null,
  } = terms;

  // Move-in deposit is always 1 period's rent
  const moveInDepositAmount = rate;
  // Reservation deposit defaults to 1 month's rent if not specified
  const finalReservationDeposit = reservationDepositAmount ?? rate;

  const { data, error } = await supabase
    .from('rental_applications')
    .update({
      application_status: APPLICATION_STATUS.APPROVED,
      approved_space_id: spaceId,
      approved_rate: rate,
      approved_rate_term: rateTerm,
      approved_move_in: moveInDate,
      approved_lease_end: leaseEndDate,
      notice_period: noticePeriod,
      move_in_deposit_amount: moveInDepositAmount,
      security_deposit_amount: securityDepositAmount,
      reservation_deposit_amount: finalReservationDeposit,
      additional_terms: additionalTerms,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...activityStamp(),
    })
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;

  // Update person status
  const app = await getApplication(applicationId);
  if (app?.person_id) {
    await supabase
      .from('people')
      .update({ application_status: 'approved' })
      .eq('id', app.person_id);
  }

  // Trigger iCal regeneration to block dates on Airbnb
  triggerIcalRegeneration();

  return data;
}

/**
 * Save terms without changing application status
 * Used for auto-save and explicit save on Terms tab
 */
async function saveTerms(applicationId, terms) {
  const {
    spaceId,
    rate,
    rateTerm = 'monthly',
    moveInDate,
    leaseEndDate = null,
    securityDepositAmount = 0,
    reservationDepositAmount = null,
    noticePeriod = '30_days',
    additionalTerms = null,
    requireLease,
    checkInTime,
    checkOutTime,
  } = terms;

  // Move-in deposit is always 1 period's rent
  const moveInDepositAmount = rate || 0;

  const updateData = {
    updated_at: new Date().toISOString(),
    ...activityStamp(),
  };

  // Only update fields that have values (use != null to allow 0)
  if (spaceId) updateData.approved_space_id = spaceId;
  if (rate != null && rate !== '') updateData.approved_rate = rate;
  if (rateTerm) updateData.approved_rate_term = rateTerm;
  if (moveInDate) updateData.approved_move_in = moveInDate;
  if (leaseEndDate !== undefined) updateData.approved_lease_end = leaseEndDate;
  if (noticePeriod) updateData.notice_period = noticePeriod;
  if (rate != null && rate !== '') updateData.move_in_deposit_amount = moveInDepositAmount;
  if (securityDepositAmount !== undefined) updateData.security_deposit_amount = securityDepositAmount;
  // Reservation deposit: save explicitly set value, or default to rate if rate is set
  if (reservationDepositAmount !== undefined) {
    updateData.reservation_deposit_amount = reservationDepositAmount ?? (rate || 0);
  } else if (rate != null && rate !== '') {
    updateData.reservation_deposit_amount = rate;
  }
  if (additionalTerms !== undefined) updateData.additional_terms = additionalTerms;
  if (requireLease !== undefined) updateData.require_lease = requireLease;
  if (checkInTime !== undefined) updateData.check_in_time = checkInTime || null;
  if (checkOutTime !== undefined) updateData.check_out_time = checkOutTime || null;

  const { data, error } = await supabase
    .from('rental_applications')
    .update(updateData)
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Deny application
 */
async function denyApplication(applicationId, reason = null) {
  // Get application first to check for prospect assignment
  const existingApp = await getApplication(applicationId);

  const { data, error } = await supabase
    .from('rental_applications')
    .update({
      application_status: APPLICATION_STATUS.DENIED,
      denial_reason: reason,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...activityStamp(),
      assignment_id: null, // Clear the assignment reference
    })
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;

  // Update person status
  if (existingApp?.person_id) {
    await supabase
      .from('people')
      .update({ application_status: 'denied' })
      .eq('id', existingApp.person_id);
  }

  // Delete the prospect assignment if it exists (to unblock dates on Airbnb)
  if (existingApp?.assignment_id && existingApp?.assignment?.status === 'prospect') {
    // First delete assignment_spaces links
    await supabase
      .from('assignment_spaces')
      .delete()
      .eq('assignment_id', existingApp.assignment_id);

    // Then delete the assignment
    await supabase
      .from('assignments')
      .delete()
      .eq('id', existingApp.assignment_id);
  }

  // Trigger iCal regeneration to unblock dates on Airbnb
  triggerIcalRegeneration();

  return data;
}


/**
 * Archive an application (soft delete)
 */
async function archiveApplication(applicationId) {
  const { data, error } = await supabase
    .from('rental_applications')
    .update({
      is_archived: true,
      updated_at: new Date().toISOString(),
      ...activityStamp(),
    })
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Unarchive an application
 */
async function unarchiveApplication(applicationId) {
  const { data, error } = await supabase
    .from('rental_applications')
    .update({
      is_archived: false,
      updated_at: new Date().toISOString(),
      ...activityStamp(),
    })
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Toggle test flag on an application
 */
async function toggleTestFlag(applicationId, isTest) {
  const { data, error } = await supabase
    .from('rental_applications')
    .update({
      is_test: isTest,
      updated_at: new Date().toISOString(),
      ...activityStamp(),
    })
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// =============================================
// RENTAL AGREEMENT WORKFLOW
// =============================================

/**
 * Update agreement status
 */
async function updateAgreementStatus(applicationId, status, documentUrl = null) {
  const updates = {
    agreement_status: status,
    updated_at: new Date().toISOString(),
    ...activityStamp(),
  };

  if (status === AGREEMENT_STATUS.GENERATED) {
    updates.agreement_generated_at = new Date().toISOString();
    if (documentUrl) updates.agreement_document_url = documentUrl;
  } else if (status === AGREEMENT_STATUS.SENT) {
    updates.agreement_sent_at = new Date().toISOString();
  } else if (status === AGREEMENT_STATUS.SIGNED) {
    updates.agreement_signed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('rental_applications')
    .update(updates)
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get data formatted for rental agreement generation
 */
async function getAgreementData(applicationId) {
  const app = await getApplication(applicationId);
  if (!app) throw new Error('Application not found');

  const person = app.person;
  const space = app.approved_space || app.desired_space;

  // Format dates in Austin timezone
  const formatLeaseDate = (dateStr) => {
    if (!dateStr) return null;
    return formatDateAustin(dateStr, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  // Format signing date (e.g., "23 day of Oct 2025") in Austin timezone
  const signingDate = getAustinToday();
  const signingDay = signingDate.toLocaleDateString('en-US', { day: 'numeric', timeZone: AUSTIN_TIMEZONE });
  const signingMonth = signingDate.toLocaleDateString('en-US', { month: 'short', timeZone: AUSTIN_TIMEZONE });
  const signingYear = signingDate.toLocaleDateString('en-US', { year: 'numeric', timeZone: AUSTIN_TIMEZONE });
  const signingFormatted = `${signingDay} day of ${signingMonth} ${signingYear}`;

  // Format notice period for display
  const noticePeriodDisplay = {
    'none': 'Fixed-length lease (no early termination)',
    '1_day': '1 day notice required',
    '1_week': '1 week notice required',
    '30_days': '30 days notice required',
    '60_days': '60 days notice required',
  }[app.notice_period] || '30 days notice required';

  // Build the lease term block based on notice period type
  const leaseStartFormatted = formatLeaseDate(app.approved_move_in);
  const leaseEndFormatted = formatLeaseDate(app.approved_lease_end) || 'Open-ended';
  const noticePeriodLabel = {
    '1_day': '1 day',
    '1_week': '1 week',
    '30_days': '30 days',
    '60_days': '60 days',
  }[app.notice_period];

  let leaseTermBlock;
  if (app.notice_period === 'none') {
    // Fixed-length lease
    leaseTermBlock = `This Lease shall commence on: **${leaseStartFormatted}**\n\nand continue until: **${leaseEndFormatted}**\n\nThis is a fixed-length lease. No early termination is permitted by either party except as otherwise provided in this agreement.`;
  } else {
    // Continuous/rolling lease with notice period
    leaseTermBlock = `This Lease shall commence on: **${leaseStartFormatted}**\n\nand continue on a month-to-month basis until terminated by either party with at least **${noticePeriodLabel}** written notice, which may be given on any date.`;
  }

  // Format rate term for display
  const rateTermDisplay = {
    'monthly': 'month',
    'weekly': 'week',
    'nightly': 'night',
  }[app.approved_rate_term] || 'month';

  // Calculate credits toward first month
  const applicationFeePaid = app.application_fee_paid && app.application_fee_amount > 0
    ? app.application_fee_amount
    : 0;
  const reservationDepositAmount = app.reservation_deposit_amount || 0;
  const moveInAmount = app.move_in_deposit_amount || 0;

  // Total credits = application fee + reservation deposit
  const totalCredits = applicationFeePaid + reservationDepositAmount;
  const firstMonthDue = Math.max(0, moveInAmount - totalCredits);

  // Generate credit text descriptions
  let applicationFeeCredit = '';
  if (applicationFeePaid > 0) {
    applicationFeeCredit = `Application fee of $${applicationFeePaid} has been received and will be credited toward the first month's rent.`;
  }

  let reservationDepositCredit = '';
  if (reservationDepositAmount > 0) {
    reservationDepositCredit = `Reservation deposit of $${reservationDepositAmount} will be credited toward the first month's rent.`;
  }

  let totalCreditsText = '';
  if (totalCredits > 0) {
    const parts = [];
    if (applicationFeePaid > 0) parts.push(`application fee ($${applicationFeePaid})`);
    if (reservationDepositAmount > 0) parts.push(`reservation deposit ($${reservationDepositAmount})`);
    totalCreditsText = `Total credits of $${totalCredits} (${parts.join(' + ')}) will be applied to first month's rent.`;
  }

  return {
    // Tenant info
    tenantName: `${person?.first_name || ''} ${person?.last_name || ''}`.trim() || 'Unknown',
    tenantEmail: person?.email || '',
    tenantPhone: person?.phone || '',

    // Dates
    signingDate: signingFormatted,
    leaseStartDate: formatLeaseDate(app.approved_move_in),
    leaseEndDate: formatLeaseDate(app.approved_lease_end) || 'Open-ended',

    // Space
    dwellingDescription: space?.name || 'TBD',
    dwellingLocation: space?.location || '',

    // Financial (use != null to allow $0 rates)
    rate: app.approved_rate != null ? `$${app.approved_rate}` : 'TBD',
    rateTerm: rateTermDisplay,
    rateDisplay: app.approved_rate != null ? `$${app.approved_rate}/${rateTermDisplay}` : 'TBD',
    securityDeposit: app.security_deposit_amount != null ? `$${app.security_deposit_amount}` : '$0',
    moveInDeposit: app.move_in_deposit_amount != null ? `$${app.move_in_deposit_amount}` : 'TBD',
    reservationDeposit: reservationDepositAmount > 0 ? `$${reservationDepositAmount}` : '$0',

    // Credits toward first month
    applicationFeePaid: applicationFeePaid > 0 ? `$${applicationFeePaid}` : '$0',
    applicationFeeCredit: applicationFeeCredit,
    reservationDepositCredit: reservationDepositCredit,
    totalCredits: totalCredits > 0 ? `$${totalCredits}` : '$0',
    totalCreditsText: totalCreditsText,
    firstMonthDue: `$${firstMonthDue}`,

    // Notice period
    noticePeriod: app.notice_period || '30_days',
    noticePeriodDisplay: noticePeriodDisplay,
    leaseTermBlock: leaseTermBlock,

    // Additional terms
    additionalTerms: app.additional_terms || null,

    // Raw values for calculations
    raw: {
      rate: app.approved_rate,
      rateTerm: app.approved_rate_term,
      securityDepositAmount: app.security_deposit_amount,
      moveInDepositAmount: app.move_in_deposit_amount,
      reservationDepositAmount: reservationDepositAmount,
      applicationFeePaid: applicationFeePaid,
      totalCredits: totalCredits,
      firstMonthDue: firstMonthDue,
      moveInDate: app.approved_move_in,
      leaseEndDate: app.approved_lease_end,
      noticePeriod: app.notice_period,
      additionalTerms: app.additional_terms,
    },
  };
}

// =============================================
// DEPOSIT TRACKING
// =============================================

/**
 * Request deposit from applicant
 */
async function requestDeposit(applicationId) {
  const { data, error } = await supabase
    .from('rental_applications')
    .update({
      deposit_status: DEPOSIT_STATUS.REQUESTED,
      deposit_requested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...activityStamp(),
    })
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Record move-in deposit payment
 */
async function recordMoveInDeposit(applicationId, details = {}) {
  const { paidAt = new Date().toISOString(), method = null, transactionId = null, amount = null } = details;

  // Get application to get the amount
  const app = await getApplication(applicationId);
  if (!app) throw new Error('Application not found');

  // Use provided amount or fall back to stored amount
  const depositAmount = amount !== null ? amount : app.move_in_deposit_amount;

  // Update application with the new amount if provided
  const updateData = {
    move_in_deposit_paid: true,
    move_in_deposit_paid_at: paidAt,
    move_in_deposit_method: method,
    move_in_deposit_transaction_id: transactionId,
    updated_at: new Date().toISOString(),
    ...activityStamp(),
  };

  // Update the stored amount if a new amount was provided
  if (amount !== null) {
    updateData.move_in_deposit_amount = amount;
  }

  const { data, error } = await supabase
    .from('rental_applications')
    .update(updateData)
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;

  // Create payment record
  const { data: rpData, error: rpError } = await supabase.from('rental_payments').insert({
    rental_application_id: applicationId,
    payment_type: PAYMENT_TYPE.MOVE_IN_DEPOSIT,
    amount_due: depositAmount,
    amount_paid: depositAmount,
    paid_date: paidAt,
    payment_method: method,
    transaction_id: transactionId,
  }).select().single();

  if (rpError) throw rpError;

  // Dual-write to ledger
  const personName = app.person ? `${app.person.first_name} ${app.person.last_name}` : null;
  await supabase.from('ledger').insert({
    direction: 'income',
    category: 'move_in_deposit',
    amount: depositAmount,
    payment_method: method || 'other',
    transaction_date: paidAt ? paidAt.split('T')[0] : new Date().toISOString().split('T')[0],
    person_id: app.person_id,
    person_name: personName,
    rental_application_id: applicationId,
    rental_payment_id: rpData?.id || null,
    status: 'completed',
    description: 'Move-in deposit',
    recorded_by: 'system:rental-service',
  });

  // Update overall deposit status
  await updateOverallDepositStatus(applicationId);

  return data;
}

/**
 * Record security deposit payment
 */
async function recordSecurityDeposit(applicationId, details = {}) {
  const { paidAt = new Date().toISOString(), method = null, transactionId = null, amount = null } = details;

  // Get application to get the amount
  const app = await getApplication(applicationId);
  if (!app) throw new Error('Application not found');

  // Use provided amount or fall back to stored amount
  const depositAmount = amount !== null ? amount : app.security_deposit_amount;

  // Update application with the new amount if provided
  const updateData = {
    security_deposit_paid: true,
    security_deposit_paid_at: paidAt,
    security_deposit_method: method,
    security_deposit_transaction_id: transactionId,
    updated_at: new Date().toISOString(),
    ...activityStamp(),
  };

  // Update the stored amount if a new amount was provided
  if (amount !== null) {
    updateData.security_deposit_amount = amount;
  }

  const { data, error } = await supabase
    .from('rental_applications')
    .update(updateData)
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;

  // Create payment record (only if security deposit > 0)
  if (depositAmount > 0) {
    const { data: rpData, error: rpError } = await supabase.from('rental_payments').insert({
      rental_application_id: applicationId,
      payment_type: PAYMENT_TYPE.SECURITY_DEPOSIT,
      amount_due: depositAmount,
      amount_paid: depositAmount,
      paid_date: paidAt,
      payment_method: method,
      transaction_id: transactionId,
    }).select().single();

    if (rpError) throw rpError;

    // Dual-write to ledger
    const personName = app.person ? `${app.person.first_name} ${app.person.last_name}` : null;
    await supabase.from('ledger').insert({
      direction: 'income',
      category: 'security_deposit',
      amount: depositAmount,
      payment_method: method || 'other',
      transaction_date: paidAt ? paidAt.split('T')[0] : new Date().toISOString().split('T')[0],
      person_id: app.person_id,
      person_name: personName,
      rental_application_id: applicationId,
      rental_payment_id: rpData?.id || null,
      status: 'completed',
      description: 'Security deposit',
      recorded_by: 'system:rental-service',
    });
  }

  // Update overall deposit status
  await updateOverallDepositStatus(applicationId);

  return data;
}

/**
 * Update overall deposit status based on individual deposits
 */
async function updateOverallDepositStatus(applicationId) {
  const app = await getApplication(applicationId);
  if (!app) return;

  let newStatus = DEPOSIT_STATUS.REQUESTED;

  const moveInPaid = app.move_in_deposit_paid;
  const securityPaid = app.security_deposit_paid || app.security_deposit_amount === 0;

  if (moveInPaid && securityPaid) {
    newStatus = DEPOSIT_STATUS.RECEIVED;
  } else if (moveInPaid || securityPaid) {
    newStatus = DEPOSIT_STATUS.PARTIAL;
  }

  await supabase
    .from('rental_applications')
    .update({
      deposit_status: newStatus,
      updated_at: new Date().toISOString(),
      ...activityStamp(),
    })
    .eq('id', applicationId);
}

/**
 * Confirm deposit (funds cleared, ready for move-in)
 * Validates that at least one deposit ledger entry exists before confirming.
 */
async function confirmDeposit(applicationId) {
  // Fetch application to get person_id and assignment_id
  const { data: app, error: appError } = await supabase
    .from('rental_applications')
    .select('person_id, assignment_id')
    .eq('id', applicationId)
    .single();

  if (appError) throw appError;

  // Verify a deposit payment exists in the ledger
  const { data: depositEntries } = await supabase
    .from('ledger')
    .select('id')
    .in('category', ['security_deposit', 'move_in_deposit'])
    .eq('status', 'completed')
    .eq('is_test', false)
    .or(`assignment_id.eq.${app.assignment_id},person_id.eq.${app.person_id}`)
    .limit(1);

  if (!depositEntries || depositEntries.length === 0) {
    throw new Error('Cannot confirm deposit: no deposit payment found in ledger. Record the deposit payment first.');
  }

  const { data, error } = await supabase
    .from('rental_applications')
    .update({
      deposit_status: DEPOSIT_STATUS.CONFIRMED,
      deposit_confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...activityStamp(),
    })
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// =============================================
// PRORATION CALCULATIONS
// =============================================

/**
 * Calculate prorated rent for a partial month
 */
function calculateProration(moveInDate, monthlyRent) {
  const moveIn = new Date(moveInDate);
  const year = moveIn.getFullYear();
  const month = moveIn.getMonth();

  // Days in the month
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Days remaining (including move-in day)
  const dayOfMonth = moveIn.getDate();
  const daysRemaining = daysInMonth - dayOfMonth + 1;

  // Calculate prorated amount
  const dailyRate = monthlyRent / daysInMonth;
  const proratedAmount = Math.round(dailyRate * daysRemaining * 100) / 100;

  return {
    daysInMonth,
    dayOfMonth,
    daysRemaining,
    dailyRate: Math.round(dailyRate * 100) / 100,
    proratedAmount,
    isFullMonth: dayOfMonth === 1,
  };
}

/**
 * Calculate how move-in deposit is applied
 */
function calculateDepositApplication(moveInDate, monthlyRent, securityDeposit) {
  const proration = calculateProration(moveInDate, monthlyRent);

  // Move-in deposit = 1 month rent
  const moveInDeposit = monthlyRent;

  // First month cost (prorated if not starting on 1st)
  const firstMonthCost = proration.proratedAmount;

  // Remainder after paying first month
  const remainder = moveInDeposit - firstMonthCost;

  // How much goes to security deposit
  const towardsSecurity = Math.min(remainder, securityDeposit);

  // How much goes toward next month (if any)
  const towardsNextMonth = remainder - towardsSecurity;

  // Remaining security deposit due
  const securityRemaining = securityDeposit - towardsSecurity;

  return {
    moveInDeposit,
    firstMonthCost,
    proration,
    towardsSecurity,
    towardsNextMonth,
    securityRemaining,
    totalDueAtMoveIn: moveInDeposit + securityRemaining,
  };
}

// =============================================
// RENT TRACKING
// =============================================

/**
 * Record a rent payment
 */
async function recordRentPayment(assignmentId, details) {
  const {
    amount,
    periodStart,
    periodEnd,
    method = null,
    transactionId = null,
    isProrated = false,
    prorateDays = null,
    notes = null,
  } = details;

  const { data, error } = await supabase
    .from('rental_payments')
    .insert({
      assignment_id: assignmentId,
      payment_type: isProrated ? PAYMENT_TYPE.PRORATED_RENT : PAYMENT_TYPE.RENT,
      amount_due: amount,
      amount_paid: amount,
      paid_date: new Date().toISOString(),
      payment_method: method,
      transaction_id: transactionId,
      period_start: periodStart,
      period_end: periodEnd,
      is_prorated: isProrated,
      prorate_days: prorateDays,
      notes,
    })
    .select()
    .single();

  if (error) throw error;

  // Dual-write to ledger
  // Get person from assignment
  const { data: assignment } = await supabase
    .from('assignments')
    .select('person_id, person:person_id(first_name, last_name)')
    .eq('id', assignmentId)
    .single();

  const personName = assignment?.person ? `${assignment.person.first_name} ${assignment.person.last_name}` : null;
  await supabase.from('ledger').insert({
    direction: 'income',
    category: isProrated ? 'prorated_rent' : 'rent',
    amount: amount,
    payment_method: method || 'other',
    transaction_date: new Date().toISOString().split('T')[0],
    period_start: periodStart || null,
    period_end: periodEnd || null,
    person_id: assignment?.person_id || null,
    person_name: personName,
    assignment_id: assignmentId,
    rental_payment_id: data.id,
    status: 'completed',
    description: isProrated ? `Prorated rent (${prorateDays} days)` : `Rent ${periodStart || ''} - ${periodEnd || ''}`.trim(),
    notes: notes || null,
    recorded_by: 'system:rental-service',
  });

  return data;
}

/**
 * Get rent payment history for an assignment
 */
async function getRentHistory(assignmentId) {
  const { data, error } = await supabase
    .from('rental_payments')
    .select('*')
    .eq('assignment_id', assignmentId)
    .in('payment_type', [PAYMENT_TYPE.RENT, PAYMENT_TYPE.PRORATED_RENT])
    .order('period_start', { ascending: false });

  if (error) throw error;
  return data || [];
}

/**
 * Get all payments for an application
 */
async function getApplicationPayments(applicationId) {
  const { data, error } = await supabase
    .from('rental_payments')
    .select('*')
    .eq('rental_application_id', applicationId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

// =============================================
// MOVE-IN CONFIRMATION
// =============================================

/**
 * Confirm move-in and create/upgrade assignment
 */
async function confirmMoveIn(applicationId) {
  // Get the application
  const app = await getApplication(applicationId);
  if (!app) throw new Error('Application not found');

  // Validate requirements
  if (app.deposit_status !== DEPOSIT_STATUS.CONFIRMED) {
    throw new Error('Deposit must be confirmed before move-in');
  }

  if (app.require_lease !== false && app.agreement_status !== AGREEMENT_STATUS.SIGNED) {
    throw new Error('Rental agreement must be signed before move-in');
  }

  let assignment;

  // Check if there's already a prospect assignment to upgrade
  if (app.assignment_id && app.assignment?.status === 'prospect') {
    // Upgrade existing prospect assignment to active
    const { data: updatedAssignment, error: updateAssignmentError } = await supabase
      .from('assignments')
      .update({
        status: 'active',
        start_date: app.approved_move_in,
        end_date: app.approved_lease_end,
        rate_amount: app.approved_rate,
        rate_term: app.approved_rate_term,
        deposit_amount: app.security_deposit_amount,
        monthly_rent: app.approved_rate,
        notes: null, // Clear the provisional note
      })
      .eq('id', app.assignment_id)
      .select()
      .single();

    if (updateAssignmentError) throw updateAssignmentError;
    assignment = updatedAssignment;

    // Update assignment_spaces if space changed (approved_space might differ from desired_space)
    if (app.approved_space_id && app.approved_space_id !== app.desired_space_id) {
      // Delete old space link
      await supabase
        .from('assignment_spaces')
        .delete()
        .eq('assignment_id', assignment.id);

      // Create new space link
      await supabase.from('assignment_spaces').insert({
        assignment_id: assignment.id,
        space_id: app.approved_space_id,
      });
    }
  } else {
    // Create new assignment
    const { data: newAssignment, error: assignmentError } = await supabase
      .from('assignments')
      .insert({
        person_id: app.person_id,
        type: 'dwelling',
        status: 'active',
        start_date: app.approved_move_in,
        end_date: app.approved_lease_end,
        rate_amount: app.approved_rate,
        rate_term: app.approved_rate_term,
        deposit_amount: app.security_deposit_amount,
        monthly_rent: app.approved_rate,
        rental_application_id: applicationId,
      })
      .select()
      .single();

    if (assignmentError) throw assignmentError;
    assignment = newAssignment;

    // Link assignment to space
    await supabase.from('assignment_spaces').insert({
      assignment_id: assignment.id,
      space_id: app.approved_space_id,
    });
  }

  // Update the application
  const { data: updatedApp, error: updateError } = await supabase
    .from('rental_applications')
    .update({
      assignment_id: assignment.id,
      move_in_confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...activityStamp(),
    })
    .eq('id', applicationId)
    .select()
    .single();

  if (updateError) throw updateError;

  // Update person status to tenant
  await supabase
    .from('people')
    .update({ application_status: 'tenant' })
    .eq('id', app.person_id);

  // Move deposit payment records to assignment
  await supabase
    .from('rental_payments')
    .update({ assignment_id: assignment.id })
    .eq('rental_application_id', applicationId);

  // Trigger iCal regeneration to update Airbnb
  triggerIcalRegeneration();

  return { application: updatedApp, assignment };
}

// =============================================
// PAYMENT METHODS
// =============================================

/**
 * Get all payment methods
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
  if (error) throw error;
  return data || [];
}

/**
 * Get a single payment method
 */
async function getPaymentMethod(methodId) {
  const { data, error } = await supabase
    .from('payment_methods')
    .select(`
      *,
      qr_code:qr_code_media_id(id, url)
    `)
    .eq('id', methodId)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Save payment method (create or update)
 */
async function savePaymentMethod(paymentMethod) {
  const { id, qr_code, ...data } = paymentMethod;

  data.updated_at = new Date().toISOString();

  if (id) {
    // Update existing
    const { data: result, error } = await supabase
      .from('payment_methods')
      .update(data)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return result;
  } else {
    // Create new
    const { data: result, error } = await supabase
      .from('payment_methods')
      .insert(data)
      .select()
      .single();

    if (error) throw error;
    return result;
  }
}

/**
 * Delete payment method
 */
async function deletePaymentMethod(methodId) {
  const { error } = await supabase
    .from('payment_methods')
    .delete()
    .eq('id', methodId);

  if (error) throw error;
  return true;
}

/**
 * Generate deposit request message for clipboard
 */
async function generateDepositRequestMessage(applicationId) {
  const app = await getApplication(applicationId);
  if (!app) throw new Error('Application not found');

  const methods = await getPaymentMethods(true);

  const totalDeposit = (app.move_in_deposit_amount || 0) + (app.security_deposit_amount || 0);

  let message = `Hi ${app.person?.first_name || 'there'},\n\n`;
  message += `To secure your space at ${app.approved_space?.name || 'AlpacApps'}, please send the following:\n\n`;
  message += `Move-in Deposit: $${app.move_in_deposit_amount || 0}\n`;

  if (app.security_deposit_amount > 0) {
    message += `Security Deposit: $${app.security_deposit_amount}\n`;
  }

  message += `Total Due: $${totalDeposit}\n\n`;
  message += `Payment Options:\n`;

  for (const method of methods) {
    if (method.method_type === 'venmo' && method.account_identifier) {
      message += `- Venmo: ${method.account_identifier}\n`;
    } else if (method.method_type === 'zelle' && method.account_identifier) {
      message += `- Zelle: ${method.account_identifier}\n`;
    } else if (method.method_type === 'paypal' && method.account_identifier) {
      message += `- PayPal: ${method.account_identifier}\n`;
    }
  }

  message += `\nPayment link: alpacaplayhouse.com/pay\n\n`;
  message += `Please include your name and "Deposit" in the payment note.\n\n`;
  message += `Let me know once you've sent the payment!\n`;

  return message;
}

// =============================================
// UTILITY FUNCTIONS
// =============================================

/**
 * Format currency
 */
function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '$0';
  return '$' + Number(amount).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/**
 * Format date for display in Austin timezone
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  return formatDateAustin(dateStr, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Calculate days since a date (using Austin timezone for "now")
 */
function daysSince(dateStr) {
  if (!dateStr) return 0;
  const date = new Date(dateStr);
  const now = getAustinToday();
  const diffTime = Math.abs(now - date);
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

// =============================================
// COMMUNITY FIT / INQUIRY
// =============================================

/**
 * Invite an inquiry applicant to complete the full application.
 * Sets invited_to_apply_at timestamp and returns the continue URL.
 */
async function inviteToApply(applicationId) {
  const app = await getApplication(applicationId);
  if (!app) throw new Error('Application not found');

  const { data, error } = await supabase
    .from('rental_applications')
    .update({
      invited_to_apply_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...activityStamp(),
    })
    .eq('id', applicationId)
    .select()
    .single();

  if (error) throw error;

  const continueUrl = `https://rsonnad.github.io/alpacapps/spaces/apply/?continue=${applicationId}`;

  return {
    application: data,
    continueUrl,
  };
}

// =============================================
// EXPORTS
// =============================================

export const rentalService = {
  // Constants
  APPLICATION_STATUS,
  AGREEMENT_STATUS,
  DEPOSIT_STATUS,
  PAYMENT_TYPE,
  PAYMENT_METHOD,

  // Applications
  getApplications,
  getApplication,
  getPipelineStage,
  createApplication,
  startReview,
  approveApplication,
  saveTerms,
  denyApplication,
  archiveApplication,
  unarchiveApplication,
  toggleTestFlag,
  inviteToApply,

  // Rental agreement
  updateAgreementStatus,
  getAgreementData,

  // Deposits
  requestDeposit,
  recordMoveInDeposit,
  recordSecurityDeposit,
  confirmDeposit,

  // Proration
  calculateProration,
  calculateDepositApplication,

  // Rent
  recordRentPayment,
  getRentHistory,
  getApplicationPayments,

  // Move-in
  confirmMoveIn,

  // Payment methods
  getPaymentMethods,
  getPaymentMethod,
  savePaymentMethod,
  deletePaymentMethod,
  generateDepositRequestMessage,

  // Utils
  formatCurrency,
  formatDate,
  daysSince,
};

// Also export for window access in non-module scripts
if (typeof window !== 'undefined') {
  window.rentalService = rentalService;
}
