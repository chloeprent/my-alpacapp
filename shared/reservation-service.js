/**
 * Reservation Service - Lightweight space booking for existing residents
 *
 * Handles:
 * - Creating space reservations (resident-initiated)
 * - Admin approval/denial
 * - Conflict detection
 * - Listing reservations by status
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';

const RESERVATION_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
};

// =============================================
// QUERIES
// =============================================

/**
 * Get all reservations with person and space details
 */
async function getReservations({ status, spaceId, upcoming } = {}) {
  let query = supabase
    .from('space_reservations')
    .select('*, person:people(id, first_name, last_name, email, phone), space:spaces(id, name, thumbnail_url)')
    .order('start_at', { ascending: true });

  if (status) query = query.eq('status', status);
  if (spaceId) query = query.eq('space_id', spaceId);
  if (upcoming) query = query.gte('start_at', new Date().toISOString());

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Get a single reservation by ID
 */
async function getReservation(id) {
  const { data, error } = await supabase
    .from('space_reservations')
    .select('*, person:people(id, first_name, last_name, email, phone), space:spaces(id, name, thumbnail_url)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Check if a person is a current resident (has active assignment)
 */
async function isCurrentResident(personId) {
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('assignments')
    .select('id, space_id')
    .eq('person_id', personId)
    .eq('status', 'active')
    .lte('start_date', today)
    .or(`end_date.is.null,end_date.gte.${today}`)
    .limit(1);
  if (error) throw error;
  return data && data.length > 0;
}

/**
 * Find person by email
 */
async function findPersonByEmail(email) {
  const { data, error } = await supabase
    .from('people')
    .select('id, first_name, last_name, email, phone')
    .eq('email', email.toLowerCase().trim())
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

/**
 * Get bookable spaces (event spaces + amenities, not archived)
 */
async function getBookableSpaces() {
  const { data, error } = await supabase
    .from('spaces')
    .select('id, name, thumbnail_url, can_be_event')
    .eq('is_archived', false)
    .or('can_be_event.eq.true')
    .order('name');
  if (error) throw error;
  return data || [];
}

/**
 * Check for conflicting approved reservations
 */
async function getConflicts(spaceId, startAt, endAt, excludeId = null) {
  let query = supabase
    .from('space_reservations')
    .select('id, title, start_at, end_at, person:people(first_name, last_name)')
    .eq('space_id', spaceId)
    .eq('status', RESERVATION_STATUS.APPROVED)
    .lt('start_at', endAt)
    .gt('end_at', startAt);

  if (excludeId) query = query.neq('id', excludeId);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// =============================================
// MUTATIONS
// =============================================

/**
 * Create a new reservation (resident submits request)
 */
async function createReservation({ personId, spaceId, title, startAt, endAt, notes }) {
  if (!personId || !spaceId || !title || !startAt || !endAt) {
    throw new Error('Missing required fields: personId, spaceId, title, startAt, endAt');
  }

  // Verify person is a current resident
  const resident = await isCurrentResident(personId);
  if (!resident) {
    throw new Error('Only current residents can make space reservations');
  }

  const { data, error } = await supabase
    .from('space_reservations')
    .insert({
      person_id: personId,
      space_id: spaceId,
      title,
      start_at: startAt,
      end_at: endAt,
      notes: notes || null,
      status: RESERVATION_STATUS.PENDING,
    })
    .select('*, person:people(id, first_name, last_name, email), space:spaces(id, name)')
    .single();

  if (error) throw error;
  return data;
}

/**
 * Approve a reservation
 */
async function approveReservation(reservationId, adminNotes = null) {
  const { data, error } = await supabase
    .from('space_reservations')
    .update({
      status: RESERVATION_STATUS.APPROVED,
      admin_notes: adminNotes,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', reservationId)
    .select('*, person:people(id, first_name, last_name, email), space:spaces(id, name)')
    .single();

  if (error) throw error;
  return data;
}

/**
 * Deny a reservation
 */
async function denyReservation(reservationId, adminNotes = null) {
  const { data, error } = await supabase
    .from('space_reservations')
    .update({
      status: RESERVATION_STATUS.DENIED,
      admin_notes: adminNotes,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', reservationId)
    .select('*, person:people(id, first_name, last_name, email), space:spaces(id, name)')
    .single();

  if (error) throw error;
  return data;
}

// =============================================
// EXPORT
// =============================================

export const reservationService = {
  RESERVATION_STATUS,
  getReservations,
  getReservation,
  isCurrentResident,
  findPersonByEmail,
  getBookableSpaces,
  getConflicts,
  createReservation,
  approveReservation,
  denyReservation,
};
