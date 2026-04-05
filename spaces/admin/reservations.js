// Reservations Page - Admin Dashboard
// Manages space reservation requests from residents

import { reservationService } from '../../shared/reservation-service.js';
import {
  formatDateAustin
} from '../../shared/timezone.js';
import {
  showToast,
  initAdminPage
} from '../../shared/admin-shell.js';

// =============================================
// STATE
// =============================================

let authState = null;
let allReservations = [];
let activeFilter = 'pending'; // pending | upcoming | past
let conflictsCache = new Map(); // reservationId -> conflicts[]

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'reservations',
    requiredRole: 'staff',
    section: 'staff',
    onReady: async (state) => {
      authState = state;
      await loadReservations();
      setupEventListeners();
    }
  });
});

// =============================================
// DATA LOADING
// =============================================

async function loadReservations() {
  try {
    allReservations = await reservationService.getReservations();
    // Pre-fetch conflicts for pending reservations
    conflictsCache.clear();
    const pending = allReservations.filter(r => r.status === 'pending');
    await Promise.all(pending.map(async (r) => {
      try {
        const conflicts = await reservationService.getConflicts(r.space_id, r.start_at, r.end_at, r.id);
        if (conflicts.length > 0) {
          conflictsCache.set(r.id, conflicts);
        }
      } catch (_) { /* ignore conflict check failures */ }
    }));
    updateCounts();
    renderReservations();
  } catch (err) {
    console.error('Failed to load reservations:', err);
    showToast('Failed to load reservations', 'error');
  }
}

// =============================================
// FILTERING & COUNTS
// =============================================

function getFilteredReservations() {
  const now = new Date().toISOString();
  switch (activeFilter) {
    case 'pending':
      return allReservations.filter(r => r.status === 'pending');
    case 'upcoming':
      return allReservations.filter(r => r.status === 'approved' && r.start_at >= now);
    case 'past':
      return allReservations.filter(r => r.start_at < now || r.status === 'denied');
    default:
      return allReservations;
  }
}

function updateCounts() {
  const pendingCount = allReservations.filter(r => r.status === 'pending').length;

  // Header badge
  const headerBadge = document.getElementById('pendingCountBadge');
  if (headerBadge) {
    headerBadge.textContent = pendingCount;
    headerBadge.style.display = pendingCount > 0 ? '' : 'none';
  }

  // Tab badge
  const tabCount = document.getElementById('pendingTabCount');
  if (tabCount) {
    tabCount.textContent = pendingCount;
    tabCount.style.display = pendingCount > 0 ? '' : 'none';
  }
}

// =============================================
// RENDERING
// =============================================

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatReservationTime(startAt, endAt) {
  if (!startAt) return '';
  const dateOpts = { month: 'short', day: 'numeric', year: 'numeric' };
  const timeOpts = { hour: 'numeric', minute: '2-digit', hour12: true };

  const dateStr = formatDateAustin(startAt, dateOpts);
  const startTime = formatDateAustin(startAt, timeOpts);
  const endTime = endAt ? formatDateAustin(endAt, timeOpts) : '';

  return endTime ? `${dateStr} ${startTime} - ${endTime}` : `${dateStr} ${startTime}`;
}

function renderReservations() {
  const container = document.getElementById('reservationsList');
  const emptyState = document.getElementById('emptyState');
  if (!container) return;

  const filtered = getFilteredReservations();

  if (filtered.length === 0) {
    container.innerHTML = '';
    emptyState?.classList.remove('hidden');
    return;
  }

  emptyState?.classList.add('hidden');

  container.innerHTML = filtered.map(r => {
    const personName = r.person
      ? `${escapeHtml(r.person.first_name || '')} ${escapeHtml(r.person.last_name || '')}`.trim()
      : 'Unknown';
    const spaceName = r.space ? escapeHtml(r.space.name) : 'Unknown Space';
    const thumbUrl = r.space?.thumbnail_url || '';
    const dateStr = formatReservationTime(r.start_at, r.end_at);
    const conflicts = conflictsCache.get(r.id) || [];

    let statusClass = '';
    if (r.status === 'pending') statusClass = 'status-pill--pending';
    else if (r.status === 'approved') statusClass = 'status-pill--approved';
    else if (r.status === 'denied') statusClass = 'status-pill--denied';

    let actionsHtml = '';
    if (r.status === 'pending') {
      actionsHtml = `
        <div class="reservation-card__actions">
          <button class="btn-approve" data-action="approve" data-id="${r.id}">Approve</button>
          <button class="btn-deny" data-action="deny-toggle" data-id="${r.id}">Deny</button>
        </div>
        <div class="deny-form" id="deny-form-${r.id}">
          <input type="text" placeholder="Reason for denial (optional)" id="deny-notes-${r.id}">
          <div class="deny-form__buttons">
            <button class="btn-deny-confirm" data-action="deny-confirm" data-id="${r.id}">Confirm Deny</button>
            <button class="btn-deny-cancel" data-action="deny-cancel" data-id="${r.id}">Cancel</button>
          </div>
        </div>`;
    }

    let conflictsHtml = '';
    if (r.status === 'pending' && conflicts.length > 0) {
      const items = conflicts.map(c => {
        const cPerson = c.person ? `${c.person.first_name || ''} ${c.person.last_name || ''}`.trim() : '';
        const cTime = formatReservationTime(c.start_at, c.end_at);
        return `<li>${escapeHtml(c.title || 'Untitled')}${cPerson ? ` (${escapeHtml(cPerson)})` : ''} &mdash; ${cTime}</li>`;
      }).join('');
      conflictsHtml = `
        <div class="conflict-warning">
          <strong>Scheduling Conflict</strong>
          <ul>${items}</ul>
        </div>`;
    }

    let notesHtml = '';
    if (r.notes) {
      notesHtml = `<div class="reservation-card__notes">${escapeHtml(r.notes)}</div>`;
    }

    let adminNotesHtml = '';
    if (r.admin_notes) {
      adminNotesHtml = `<div class="reservation-card__admin-notes">Admin: ${escapeHtml(r.admin_notes)}</div>`;
    }

    return `
      <div class="reservation-card" data-reservation-id="${r.id}">
        <div class="reservation-card__top">
          ${thumbUrl ? `<img class="reservation-card__thumb" src="${escapeHtml(thumbUrl)}" alt="">` : '<div class="reservation-card__thumb"></div>'}
          <div class="reservation-card__info">
            <div class="reservation-card__space">${spaceName}</div>
            <div class="reservation-card__title">${escapeHtml(r.title || 'Untitled Reservation')}</div>
            <div class="reservation-card__person">${personName}</div>
            <div class="reservation-card__datetime">${dateStr}</div>
            ${notesHtml}
            ${adminNotesHtml}
          </div>
          <span class="status-pill ${statusClass}">${escapeHtml(r.status)}</span>
        </div>
        ${conflictsHtml}
        ${actionsHtml}
      </div>`;
  }).join('');
}

// =============================================
// ACTIONS
// =============================================

async function handleApprove(id) {
  try {
    await reservationService.approveReservation(id);
    showToast('Reservation approved', 'success');
    await loadReservations();
  } catch (err) {
    console.error('Failed to approve reservation:', err);
    showToast('Failed to approve reservation', 'error');
  }
}

async function handleDeny(id) {
  const notesInput = document.getElementById(`deny-notes-${id}`);
  const notes = notesInput ? notesInput.value.trim() : '';
  try {
    await reservationService.denyReservation(id, notes || null);
    showToast('Reservation denied', 'success');
    await loadReservations();
  } catch (err) {
    console.error('Failed to deny reservation:', err);
    showToast('Failed to deny reservation', 'error');
  }
}

// =============================================
// EVENT LISTENERS
// =============================================

function setupEventListeners() {
  // Filter tabs
  const filterTabs = document.getElementById('filterTabs');
  if (filterTabs) {
    filterTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.filter-tab');
      if (!tab) return;
      const filter = tab.dataset.filter;
      if (!filter || filter === activeFilter) return;

      activeFilter = filter;
      filterTabs.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderReservations();
    });
  }

  // Reservation actions (delegated)
  const list = document.getElementById('reservationsList');
  if (list) {
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      const id = btn.dataset.id;

      switch (action) {
        case 'approve':
          handleApprove(id);
          break;
        case 'deny-toggle': {
          const form = document.getElementById(`deny-form-${id}`);
          if (form) form.classList.toggle('expanded');
          break;
        }
        case 'deny-confirm':
          handleDeny(id);
          break;
        case 'deny-cancel': {
          const form = document.getElementById(`deny-form-${id}`);
          if (form) form.classList.remove('expanded');
          break;
        }
      }
    });
  }
}
