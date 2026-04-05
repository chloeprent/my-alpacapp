/**
 * Admin Hours Page - Manage associate time entries, rates, and payments
 */
import { initAdminPage, showToast } from '../../shared/admin-shell.js';
import { getAuthState } from '../../shared/auth.js';
import { supabase } from '../../shared/supabase.js';
import { hoursService, HoursService } from '../../shared/hours-service.js';
import { PAYMENT_METHOD_LABELS } from '../../shared/accounting-service.js';
import { payoutService } from '../../shared/payout-service.js';
import { identityService } from '../../shared/identity-service.js';
import { isDemoUser, redactString } from '../../shared/demo-redact.js';
import { AUSTIN_TIMEZONE } from '../../shared/timezone.js';

// State
let associates = [];
let entries = [];
let selectedIds = new Set();
let editingEntryId = null;
let workGroups = [];
let initialized = false;

// =============================================
// INITIALIZATION
// =============================================
initAdminPage({
  activeTab: 'hours',
  section: 'staff',
  onReady: async () => {
    if (initialized) return;
    initialized = true;
    setDefaultDates();
    setupEventListeners();
    await loadAll();
  }
});

// =============================================
// DATE HELPERS
// =============================================
function getToday() { return new Date().toISOString().split('T')[0]; }

function getMonday() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function getFirstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function getFirstOfLastMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function getLastDayOfLastMonth() {
  const d = new Date();
  d.setDate(0);
  return d.toISOString().split('T')[0];
}

function setDefaultDates() {
  document.getElementById('filterFrom').value = getFirstOfMonth();
  document.getElementById('filterTo').value = getToday();
  document.getElementById('entryDate').value = getToday();
}

// =============================================
// DATA LOADING
// =============================================
async function loadAll() {
  // Load associates first — work groups need the associates array for member dropdowns
  await loadAssociates();
  await Promise.all([loadEntries(), loadWorkGroups(), loadSpacesForEntryModal(), loadEditRequests()]);
}

async function loadAssociates() {
  try {
    associates = await hoursService.getAllAssociates();
    renderAssociateFilter();
    renderAssociateConfig();
    renderEntryAssociateSelect();
    await loadEligibleUsers();
  } catch (err) {
    console.error('Failed to load associates:', err);
    showToast('Failed to load associates', 'error');
    document.getElementById('associateConfig').innerHTML = '<div class="empty-state">Failed to load associates.</div>';
  }
}

async function loadEligibleUsers() {
  try {
    const eligible = await hoursService.getEligibleUsers();
    const sel = document.getElementById('addAssocUser');
    sel.innerHTML = '<option value="">Select a user...</option>';
    for (const u of eligible) {
      const fullName = `${u.first_name || ''} ${u.last_name || ''}`.trim();
      const name = fullName || u.display_name || u.email;
      const signedUp = u.auth_user_id ? '' : ' (invited, not signed up)';
      const role = u.role ? ` [${u.role}]` : '';
      sel.innerHTML += `<option value="${u.id}">${escapeHtml(name)}${role}${signedUp}</option>`;
    }
    // Hide the add button if no one left to add
    document.getElementById('btnShowAddAssoc').style.display = eligible.length ? '' : 'none';
  } catch (err) {
    console.error('Failed to load eligible users:', err);
  }
}

async function loadEntries() {
  try {
    const filters = getFilters();
    entries = await hoursService.getAllEntries(filters);
    selectedIds.clear();
    renderEntries();
    renderSummary();
    updateMarkPaidButton();
  } catch (err) {
    console.error('Failed to load entries:', err);
    showToast('Failed to load entries', 'error');
    document.getElementById('entriesBody').innerHTML = '<tr><td colspan="8" class="empty-state">Failed to load entries.</td></tr>';
  }
}

function getFilters() {
  const f = {};
  const assocId = document.getElementById('filterAssociate').value;
  if (assocId) f.associateId = assocId;
  const from = document.getElementById('filterFrom').value;
  if (from) f.dateFrom = from;
  const to = document.getElementById('filterTo').value;
  if (to) f.dateTo = to;
  const status = document.getElementById('filterStatus').value;
  if (status === 'paid') f.isPaid = true;
  else if (status === 'unpaid') f.isPaid = false;
  return f;
}

// =============================================
// RENDERING
// =============================================
function renderAssociateFilter() {
  const sel = document.getElementById('filterAssociate');
  const current = sel.value;
  sel.innerHTML = '<option value="">All Associates</option>';
  for (const a of associates) {
    const name = getAssocName(a);
    sel.innerHTML += `<option value="${a.id}">${name}</option>`;
  }
  sel.value = current;
}

function renderEntryAssociateSelect() {
  const sel = document.getElementById('entryAssociate');
  sel.innerHTML = '';
  for (const a of associates) {
    const name = getAssocName(a);
    sel.innerHTML += `<option value="${a.id}">${name}</option>`;
  }
}

let allSpaces = [];
async function loadSpacesForEntryModal() {
  try {
    const { data, error } = await supabase
      .from('spaces')
      .select('id, name')
      .eq('is_archived', false)
      .eq('is_micro', false)
      .order('name');
    if (error) throw error;
    allSpaces = data || [];
    const sel = document.getElementById('entrySpace');
    sel.innerHTML = '<option value="">Select space...</option>';
    for (const s of allSpaces) {
      sel.innerHTML += `<option value="${s.id}">${escapeHtml(s.name)}</option>`;
    }
  } catch (err) {
    console.error('Failed to load spaces for entry modal:', err);
  }
}

function renderSummary() {
  let totalMins = 0, totalAmt = 0, paidAmt = 0, unpaidAmt = 0;
  for (const e of entries) {
    const mins = parseFloat(e.duration_minutes) || 0;
    totalMins += mins;
    const amt = (mins / 60) * parseFloat(e.hourly_rate);
    totalAmt += amt;
    if (e.is_paid) paidAmt += amt;
    else unpaidAmt += amt;
  }
  document.getElementById('sumHours').textContent = HoursService.formatHoursDecimal(totalMins);
  document.getElementById('sumEarned').textContent = formatCurrencyDisplay(totalAmt);
  document.getElementById('sumPaid').textContent = formatCurrencyDisplay(paidAmt);
  document.getElementById('sumUnpaid').textContent = formatCurrencyDisplay(unpaidAmt);
}

function renderEntries() {
  const tbody = document.getElementById('entriesBody');
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No time entries found for this period.</td></tr>';
    return;
  }

  tbody.innerHTML = entries.map(e => {
    const assoc = e.associate;
    const name = assoc ? getAssocName(assoc) : '?';
    const date = new Date(e.clock_in).toLocaleDateString('en-CA', { timeZone: AUSTIN_TIMEZONE });
    const clockIn = HoursService.formatTime(e.clock_in);
    const clockOut = e.clock_out ? HoursService.formatTime(e.clock_out) : '<span class="badge active">Active</span>';
    const mins = parseFloat(e.duration_minutes) || 0;
    const hours = HoursService.formatDuration(mins);
    const rate = formatCurrencyDisplay(e.hourly_rate);
    const amount = formatCurrencyDisplay((mins / 60) * parseFloat(e.hourly_rate));
    const status = e.clock_out === null ? '' : (e.is_paid ? '<span class="badge paid">Paid</span>' : '<span class="badge unpaid">Unpaid</span>');
    const desc = e.description ? escapeHtml(e.description) : '<span style="color:var(--text-muted)">—</span>';
    const spaceName = e.space?.name || '';
    const manualTag = e.is_manual ? ' <span style="font-size:0.6rem;background:#eef2ff;color:#6366f1;padding:0.1rem 0.3rem;border-radius:3px;font-weight:700;">M</span>' : '';
    const checked = selectedIds.has(e.id) ? 'checked' : '';
    const canCheck = !isDemoUser() && e.clock_out;
    const gpsUrl = formatGpsUrl(e);

    // Build second row meta items
    const metaParts = [];
    if (status) metaParts.push(status);
    if (spaceName && gpsUrl) {
      metaParts.push(`<a class="loc-link" href="${gpsUrl}" target="_blank" rel="noopener" title="View location">${escapeHtml(spaceName)} ↗</a>`);
    } else if (spaceName) {
      metaParts.push(`<span style="color:#6b7280;">${escapeHtml(spaceName)}</span>`);
    } else if (gpsUrl) {
      metaParts.push(`<a class="loc-link" href="${gpsUrl}" target="_blank" rel="noopener">Unknown ↗</a>`);
    } else {
      metaParts.push(`<span style="color:#6b7280;">Unknown</span>`);
    }
    metaParts.push(`<button class="btn-small" data-edit="${e.id}" style="font-size:0.7rem;padding:0.2rem 0.4rem;">Edit</button>`);

    return `<tr class="entry-row1">
      <td class="cb" rowspan="2">${canCheck ? `<input type="checkbox" class="entry-cb" data-id="${e.id}" ${checked}>` : ''}</td>
      <td class="${isDemoUser() ? 'demo-redacted' : ''}">${escapeHtml(name)}${manualTag}</td>
      <td>${HoursService.formatDate(date)}</td>
      <td>${clockIn}</td>
      <td>${clockOut}</td>
      <td>${hours}</td>
      <td class="${isDemoUser() ? 'demo-redacted' : ''}">${rate}</td>
      <td class="${isDemoUser() ? 'demo-redacted' : ''}"><strong>${amount}</strong></td>
    </tr>
    <tr class="entry-row2">
      <td colspan="7"><div class="entry-meta">${metaParts.join('<span style="color:#d1d5db;">|</span>')} <span class="entry-desc">${desc}</span></div></td>
    </tr>`;
  }).join('');
}

function renderAssociateConfig() {
  const container = document.getElementById('associateConfig');
  if (!associates.length) {
    container.innerHTML = '<div class="empty-state">No associates set up yet. Click "+ Add Associate" above to add users for time tracking.</div>';
    return;
  }

  container.innerHTML = associates.map(a => {
    const name = getAssocName(a);
    const role = a.app_user?.role || 'unknown';
    const method = a.payment_method ? (PAYMENT_METHOD_LABELS[a.payment_method] || a.payment_method) : 'Not set';
    const handle = a.payment_handle || '';
    const rate = parseFloat(a.hourly_rate) || 0;
    const idStatus = a.identity_verification_status || 'pending';
    const idBadge = renderIdBadge(idStatus);
    const idActions = renderIdActions(a, idStatus);

    const rateDisplay = isDemoUser() ? redactString('$' + rate.toFixed(2), 'amount') : ('$' + rate.toFixed(2));
    return `<div class="assoc-card" data-profile-id="${a.id}">
      <h4 class="${isDemoUser() ? 'demo-redacted' : ''}">
        ${escapeHtml(name)}
        <span class="role-tag ${role}">${role}</span>
      </h4>
      <p class="detail${isDemoUser() ? ' demo-redacted' : ''}">${isDemoUser() ? redactString(a.app_user?.email || '', 'email') : escapeHtml(a.app_user?.email || '')}</p>
      <p class="detail">Payment: ${escapeHtml(method)}${handle ? ' — ' + escapeHtml(handle) : ''}</p>
      <div class="detail" style="margin-top:0.25rem;">ID: ${idBadge} ${idActions}</div>
      <div class="rate-highlight ${isDemoUser() ? 'demo-redacted' : ''}">
        <span class="rate-value">${rateDisplay}</span>
        <span class="rate-unit">/ hour</span>
      </div>
      <div class="rate-row">
        <label style="font-size:0.75rem;font-weight:600;white-space:nowrap;">Set rate:</label>
        <input type="number" step="0.50" min="0" value="${rate}" class="rate-input" data-id="${a.id}">
        <button class="save-btn" data-save-rate="${a.id}">Save</button>
      </div>
    </div>`;
  }).join('');
}

// =============================================
// ID VERIFICATION HELPERS
// =============================================
function renderIdBadge(status) {
  const map = {
    pending: '<span class="badge" style="background:#f3f4f6;color:#6b7280;">Not verified</span>',
    link_sent: '<span class="badge" style="background:#fef3c7;color:#92400e;">Link sent</span>',
    verified: '<span class="badge" style="background:#d1fae5;color:#065f46;">Verified</span>',
    flagged: '<span class="badge" style="background:#fee2e2;color:#991b1b;">Flagged</span>',
    rejected: '<span class="badge" style="background:#fee2e2;color:#991b1b;">Rejected</span>',
  };
  return map[status] || map.pending;
}

function renderIdActions(assoc, status) {
  const appUserId = assoc.app_user_id;
  if (status === 'verified') return '';
  if (status === 'flagged') {
    return `<button class="btn-small" onclick="handleRequestIdVerification('${appUserId}')" style="font-size:0.65rem;margin-left:0.25rem;">Resend Link</button>`
      + `<button class="btn-small" onclick="handleApproveId('${appUserId}')" style="font-size:0.65rem;margin-left:0.25rem;background:#059669;color:#fff;">Approve</button>`
      + `<button class="btn-small" onclick="handleRejectId('${appUserId}')" style="font-size:0.65rem;margin-left:0.25rem;background:#dc2626;color:#fff;">Reject</button>`;
  }
  return `<button class="btn-small" onclick="handleRequestIdVerification('${appUserId}')" style="font-size:0.65rem;margin-left:0.25rem;">Request ID</button>`;
}

window.handleRequestIdVerification = async function(appUserId) {
  try {
    const { token, uploadUrl } = await identityService.requestAssociateVerification(appUserId, 'admin');
    await navigator.clipboard.writeText(uploadUrl);
    showToast('ID verification link copied to clipboard!', 'success');
    await loadAssociates();
  } catch (err) {
    showToast('Failed to request verification: ' + err.message, 'error');
  }
};

window.handleApproveId = async function(appUserId) {
  try {
    const verification = await identityService.getAssociateVerification(appUserId);
    if (!verification) { showToast('No verification found', 'error'); return; }
    await identityService.approveAssociateVerification(verification.id, appUserId, 'admin');
    showToast('Identity approved!', 'success');
    await loadAssociates();
  } catch (err) {
    showToast('Failed to approve: ' + err.message, 'error');
  }
};

window.handleRejectId = async function(appUserId) {
  try {
    const verification = await identityService.getAssociateVerification(appUserId);
    if (!verification) { showToast('No verification found', 'error'); return; }
    await identityService.rejectAssociateVerification(verification.id, appUserId, 'admin');
    showToast('Identity rejected', 'success');
    await loadAssociates();
  } catch (err) {
    showToast('Failed to reject: ' + err.message, 'error');
  }
};

// =============================================
// EVENT LISTENERS
// =============================================
function setupEventListeners() {
  // Filters
  document.getElementById('filterAssociate').addEventListener('change', loadEntries);
  document.getElementById('filterFrom').addEventListener('change', loadEntries);
  document.getElementById('filterTo').addEventListener('change', loadEntries);
  document.getElementById('filterStatus').addEventListener('change', loadEntries);

  // Presets
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.preset;
      const from = document.getElementById('filterFrom');
      const to = document.getElementById('filterTo');
      if (p === 'week') { from.value = getMonday(); to.value = getToday(); }
      else if (p === 'month') { from.value = getFirstOfMonth(); to.value = getToday(); }
      else if (p === 'last-month') { from.value = getFirstOfLastMonth(); to.value = getLastDayOfLastMonth(); }
      else if (p === 'all') { from.value = ''; to.value = ''; }
      loadEntries();
    });
  });

  // Select all checkbox
  document.getElementById('selectAll').addEventListener('change', (e) => {
    const checked = e.target.checked;
    document.querySelectorAll('.entry-cb').forEach(cb => {
      cb.checked = checked;
      if (checked) selectedIds.add(cb.dataset.id);
      else selectedIds.delete(cb.dataset.id);
    });
    updateMarkPaidButton();
  });

  // Individual checkboxes (delegated)
  document.getElementById('entriesBody').addEventListener('change', (e) => {
    if (e.target.classList.contains('entry-cb')) {
      if (e.target.checked) selectedIds.add(e.target.dataset.id);
      else selectedIds.delete(e.target.dataset.id);
      updateMarkPaidButton();
    }
  });

  // Edit entry button (delegated)
  document.getElementById('entriesBody').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) openEditEntry(editBtn.dataset.edit);
  });

  // Recalc
  document.getElementById('btnRecalc').addEventListener('click', recalcSelected);

  // Mark paid
  document.getElementById('btnMarkPaid').addEventListener('click', openPaidModal);
  document.getElementById('paidCancel').addEventListener('click', () => document.getElementById('paidModal').classList.remove('open'));
  document.getElementById('paidConfirm').addEventListener('click', confirmMarkPaid);

  // Add entry
  document.getElementById('btnAddEntry').addEventListener('click', openAddEntry);
  document.getElementById('entryCancel').addEventListener('click', () => document.getElementById('addEntryModal').classList.remove('open'));
  document.getElementById('entryConfirm').addEventListener('click', confirmSaveEntry);

  // Add Associate
  document.getElementById('btnShowAddAssoc').addEventListener('click', () => {
    const form = document.getElementById('addAssocForm');
    form.style.display = form.style.display === 'none' ? '' : 'none';
  });
  document.getElementById('btnDoAddAssoc').addEventListener('click', async () => {
    const userId = document.getElementById('addAssocUser').value;
    const rate = parseFloat(document.getElementById('addAssocRate').value) || 0;
    if (!userId) { showToast('Please select a user', 'warning'); return; }
    const btn = document.getElementById('btnDoAddAssoc');
    btn.disabled = true;
    try {
      await hoursService.createProfile(userId, { hourlyRate: rate });
      showToast('Associate added!', 'success');
      document.getElementById('addAssocForm').style.display = 'none';
      document.getElementById('addAssocRate').value = '0';
      await loadAssociates();
      await loadEntries(); // refresh entries table too
    } catch (err) {
      showToast('Failed to add associate: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Work Groups
  document.getElementById('btnShowAddGroup').addEventListener('click', () => {
    const form = document.getElementById('addGroupForm');
    form.style.display = form.style.display === 'none' ? '' : 'none';
  });

  document.getElementById('btnDoAddGroup').addEventListener('click', async () => {
    const name = document.getElementById('addGroupName').value.trim();
    if (!name) { showToast('Please enter a group name', 'warning'); return; }
    try {
      await hoursService.createWorkGroup(name);
      showToast('Work group created!', 'success');
      document.getElementById('addGroupName').value = '';
      document.getElementById('addGroupForm').style.display = 'none';
      await loadWorkGroups();
    } catch (err) {
      showToast('Failed to create group: ' + err.message, 'error');
    }
  });

  // Work group delegated events (add member, remove member, delete group)
  document.getElementById('workGroupGrid').addEventListener('click', async (e) => {
    // Add member
    const addBtn = e.target.closest('[data-wg-add]');
    if (addBtn) {
      const groupId = addBtn.dataset.wgAdd;
      const select = document.querySelector(`.wg-member-select[data-group="${groupId}"]`);
      const assocId = select?.value;
      if (!assocId) { showToast('Please select a member', 'warning'); return; }
      try {
        await hoursService.addGroupMember(groupId, assocId);
        showToast('Member added!', 'success');
        await loadWorkGroups();
      } catch (err) {
        showToast('Failed to add member: ' + err.message, 'error');
      }
      return;
    }

    // Remove member
    const removeBtn = e.target.closest('[data-wg-remove]');
    if (removeBtn) {
      const groupId = removeBtn.dataset.wgRemove;
      const assocId = removeBtn.dataset.assoc;
      try {
        await hoursService.removeGroupMember(groupId, assocId);
        showToast('Member removed', 'success');
        await loadWorkGroups();
      } catch (err) {
        showToast('Failed to remove member: ' + err.message, 'error');
      }
      return;
    }

    // Delete group
    const deleteBtn = e.target.closest('[data-wg-delete]');
    if (deleteBtn) {
      if (!confirm('Delete this work group? Members will be removed.')) return;
      try {
        await hoursService.deleteWorkGroup(deleteBtn.dataset.wgDelete);
        showToast('Work group deleted', 'success');
        await loadWorkGroups();
      } catch (err) {
        showToast('Failed to delete group: ' + err.message, 'error');
      }
    }
  });

  // Save rate buttons (delegated)
  document.getElementById('associateConfig').addEventListener('click', async (e) => {
    const saveBtn = e.target.closest('[data-save-rate]');
    if (!saveBtn) return;
    const profileId = saveBtn.dataset.saveRate;
    const input = document.querySelector(`.rate-input[data-id="${profileId}"]`);
    const rate = parseFloat(input.value);
    if (isNaN(rate) || rate < 0) { showToast('Invalid rate', 'error'); return; }
    try {
      await hoursService.updateProfile(profileId, { hourly_rate: rate });
      showToast('Rate updated', 'success');
      await loadAssociates();
    } catch (err) {
      showToast('Failed to update rate: ' + err.message, 'error');
    }
  });
}

function updateMarkPaidButton() {
  const btn = document.getElementById('btnMarkPaid');
  const recalcBtn = document.getElementById('btnRecalc');
  const unpaidSelected = entries.filter(e => selectedIds.has(e.id) && !e.is_paid);
  btn.disabled = unpaidSelected.length === 0;
  recalcBtn.disabled = selectedIds.size === 0;
  btn.textContent = unpaidSelected.length > 0
    ? `Mark ${unpaidSelected.length} as Paid`
    : 'Mark Selected as Paid';
  recalcBtn.textContent = 'Recalc';
}

// =============================================
// RECALC RATES
// =============================================
async function recalcSelected() {
  if (selectedIds.size === 0) return;
  const btn = document.getElementById('btnRecalc');
  btn.disabled = true;
  btn.textContent = 'Recalculating...';

  try {
    const selectedEntries = entries.filter(e => selectedIds.has(e.id));
    let updated = 0;
    let skipped = 0;

    for (const entry of selectedEntries) {
      const assoc = associates.find(a => a.id === entry.associate_id);
      if (!assoc) { skipped++; continue; }
      const currentRate = parseFloat(assoc.hourly_rate) || 0;
      const entryRate = parseFloat(entry.hourly_rate) || 0;
      if (currentRate === entryRate) { skipped++; continue; }

      await hoursService.updateEntry(entry.id, { hourly_rate: currentRate });
      updated++;
    }

    if (updated > 0) {
      showToast(`Recalculated ${updated} ${updated === 1 ? 'entry' : 'entries'}${skipped ? ` (${skipped} unchanged)` : ''}`, 'success');
    } else {
      showToast('All selected entries already match current rates', 'info');
    }
    await loadEntries();
    btn.textContent = 'Recalced';
    setTimeout(() => { btn.textContent = 'Recalc'; }, 2000);
  } catch (err) {
    showToast('Failed to recalculate: ' + err.message, 'error');
    btn.textContent = 'Recalc';
  } finally {
    btn.disabled = false;
    updateMarkPaidButton();
  }
}

// =============================================
// MARK PAID FLOW
// =============================================
function openPaidModal() {
  // Only mark unpaid entries
  const selectedEntries = entries.filter(e => selectedIds.has(e.id) && !e.is_paid);
  if (selectedEntries.length === 0) return;
  // Compute summary of selected entries
  let totalMins = 0, totalAmt = 0;
  for (const e of selectedEntries) {
    const mins = parseFloat(e.duration_minutes) || 0;
    totalMins += mins;
    totalAmt += (mins / 60) * parseFloat(e.hourly_rate);
  }

  // Check ID verification status for all associates with selected entries
  const assocIds = new Set(selectedEntries.map(e => e.associate_id));
  const unverifiedAssocs = [];
  for (const assocId of assocIds) {
    const assoc = associates.find(a => a.id === assocId);
    if (assoc && assoc.identity_verification_status !== 'verified') {
      unverifiedAssocs.push(getAssocName(assoc));
    }
  }
  if (unverifiedAssocs.length > 0) {
    showToast(`Cannot pay — ID not verified: ${unverifiedAssocs.join(', ')}. Request ID verification first.`, 'error', 6000);
    return;
  }

  // Pre-select payment method from associate's preference if all same associate
  if (assocIds.size === 1) {
    const assoc = associates.find(a => a.id === [...assocIds][0]);
    if (assoc?.payment_method) {
      document.getElementById('paidMethod').value = assoc.payment_method;
    }
  }

  document.getElementById('paidModalSummary').textContent =
    `${selectedIds.size} entries — ${HoursService.formatDuration(totalMins)} — ${HoursService.formatCurrency(totalAmt)}`;
  document.getElementById('paidNotes').value = '';
  updatePaypalPayoutInfo();
  document.getElementById('paidModal').classList.add('open');

  // Listen for payment method changes to toggle PayPal info
  document.getElementById('paidMethod').addEventListener('change', updatePaypalPayoutInfo);
}

/**
 * Show/hide PayPal and Stripe payout info boxes based on selected method
 */
function updatePaypalPayoutInfo() {
  const method = document.getElementById('paidMethod').value;
  const paypalInfo = document.getElementById('paypalPayoutInfo');
  const stripeInfo = document.getElementById('stripePayoutInfo');
  const confirmBtn = document.getElementById('paidConfirm');

  // Hide both by default
  paypalInfo.style.display = 'none';
  if (stripeInfo) stripeInfo.style.display = 'none';
  confirmBtn.textContent = 'Confirm Payment';

  if (method === 'paypal') {
    // Find associate's PayPal email
    const selectedEntries = entries.filter(e => selectedIds.has(e.id));
    const assocIds = new Set(selectedEntries.map(e => e.associate_id));

    if (assocIds.size === 1) {
      const assoc = associates.find(a => a.id === [...assocIds][0]);
      const handle = assoc?.payment_handle;
      if (handle) {
        document.getElementById('paypalRecipientInfo').textContent = `Sends instantly to ${handle}`;
      } else {
        document.getElementById('paypalRecipientInfo').innerHTML =
          '<span style="color:var(--error,#ef4444);">No PayPal email configured for this associate. Set it in their profile first.</span>';
      }
    } else {
      document.getElementById('paypalRecipientInfo').textContent =
        'Multiple associates selected — PayPal payouts will be sent to each associate\'s configured email.';
    }
    paypalInfo.style.display = 'block';
    confirmBtn.textContent = 'Send via PayPal';
  } else if (method === 'stripe') {
    const selectedEntries = entries.filter(e => selectedIds.has(e.id));
    const assocIds = new Set(selectedEntries.map(e => e.associate_id));

    if (stripeInfo) {
      if (assocIds.size === 1) {
        const assoc = associates.find(a => a.id === [...assocIds][0]);
        const connectId = assoc?.stripe_connect_account_id;
        if (connectId) {
          document.getElementById('stripeRecipientInfo').textContent = `Connected (${connectId.slice(0, 12)}...) — instant to Stripe, 1-2 days to bank`;
        } else {
          document.getElementById('stripeRecipientInfo').innerHTML =
            '<span style="color:var(--error,#ef4444);">No Stripe Connect account linked for this associate. They need to complete Stripe onboarding first.</span>';
        }
      } else {
        document.getElementById('stripeRecipientInfo').textContent =
          'Multiple associates selected — Stripe payouts will be sent to each associate\'s connected account.';
      }
      stripeInfo.style.display = 'block';
    }
    confirmBtn.textContent = 'Send via Stripe';
  }
}

async function confirmMarkPaid() {
  const method = document.getElementById('paidMethod').value;
  const notes = document.getElementById('paidNotes').value.trim();
  const btn = document.getElementById('paidConfirm');
  btn.disabled = true;

  // If PayPal selected, send real payout via PayPal Payouts API
  if (method === 'paypal') {
    btn.textContent = 'Sending via PayPal...';
    try {
      // Group entries by associate for multi-associate payouts
      const selectedEntries = entries.filter(e => selectedIds.has(e.id));
      const byAssociate = {};
      for (const entry of selectedEntries) {
        if (!byAssociate[entry.associate_id]) {
          byAssociate[entry.associate_id] = { entries: [], totalMins: 0, totalAmt: 0 };
        }
        const mins = parseFloat(entry.duration_minutes) || 0;
        byAssociate[entry.associate_id].entries.push(entry);
        byAssociate[entry.associate_id].totalMins += mins;
        byAssociate[entry.associate_id].totalAmt += (mins / 60) * parseFloat(entry.hourly_rate);
      }

      let successCount = 0;
      let failCount = 0;

      for (const [assocId, data] of Object.entries(byAssociate)) {
        const amount = Math.round(data.totalAmt * 100) / 100;
        const entryIds = data.entries.map(e => e.id);

        const result = await payoutService.sendPayPalPayout(assocId, amount, entryIds, notes);

        if (result.success) {
          // Mark entries as paid in hours service (creates ledger entry too)
          await hoursService.markPaid(entryIds, { paymentMethod: 'paypal', notes: `PayPal payout${result.test_mode ? ' [TEST]' : ''}: ${result.message || ''}` });
          successCount++;
          showToast(result.message || `Sent $${amount.toFixed(2)} via PayPal`, 'success');
        } else {
          failCount++;
          showToast(`PayPal payout failed: ${result.error}`, 'error');
        }
      }

      if (successCount > 0) {
        document.getElementById('paidModal').classList.remove('open');
        await loadEntries();
      }
    } catch (err) {
      showToast('PayPal payout failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send via PayPal';
    }
    return;
  }

  // If Stripe selected, send real payout via Stripe Connect ACH
  if (method === 'stripe') {
    btn.textContent = 'Sending via Stripe...';
    try {
      // Group entries by associate for multi-associate payouts
      const selectedEntries = entries.filter(e => selectedIds.has(e.id));
      const byAssociate = {};
      for (const entry of selectedEntries) {
        if (!byAssociate[entry.associate_id]) {
          byAssociate[entry.associate_id] = { entries: [], totalMins: 0, totalAmt: 0 };
        }
        const mins = parseFloat(entry.duration_minutes) || 0;
        byAssociate[entry.associate_id].entries.push(entry);
        byAssociate[entry.associate_id].totalMins += mins;
        byAssociate[entry.associate_id].totalAmt += (mins / 60) * parseFloat(entry.hourly_rate);
      }

      let successCount = 0;
      let failCount = 0;

      for (const [assocId, data] of Object.entries(byAssociate)) {
        const amount = Math.round(data.totalAmt * 100) / 100;
        const entryIds = data.entries.map(e => e.id);

        const result = await payoutService.sendStripePayout(assocId, amount, entryIds, notes);

        if (result.success) {
          // Mark entries as paid in hours service (creates ledger entry too)
          await hoursService.markPaid(entryIds, { paymentMethod: 'stripe', notes: `Stripe payout${result.test_mode ? ' [TEST]' : ''}: ${result.message || ''}` });
          successCount++;
          showToast(result.message || `Sent $${amount.toFixed(2)} via Stripe`, 'success');
        } else {
          failCount++;
          showToast(`Stripe payout failed: ${result.error}`, 'error');
        }
      }

      if (successCount > 0) {
        document.getElementById('paidModal').classList.remove('open');
        await loadEntries();
      }
    } catch (err) {
      showToast('Stripe payout failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send via Stripe';
    }
    return;
  }

  // Non-PayPal/non-Stripe: standard mark-as-paid flow (manual recording)
  btn.textContent = 'Processing...';
  try {
    const result = await hoursService.markPaid([...selectedIds], { paymentMethod: method, notes });
    showToast(`Marked ${result.entriesUpdated} entries as paid — ${HoursService.formatCurrency(result.totalAmount)}`, 'success');
    document.getElementById('paidModal').classList.remove('open');
    await loadEntries();
  } catch (err) {
    showToast('Failed to mark paid: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm Payment';
  }
}

// =============================================
// ADD / EDIT ENTRY
// =============================================
function openAddEntry() {
  editingEntryId = null;
  document.getElementById('addEntryTitle').textContent = 'Add Manual Entry';
  document.getElementById('entryDate').value = getToday();
  document.getElementById('entryClockIn').value = '';
  document.getElementById('entryClockOut').value = '';
  document.getElementById('entryDescription').value = '';
  document.getElementById('entrySpace').value = '';
  // Pre-select current filter associate
  const filterAssoc = document.getElementById('filterAssociate').value;
  if (filterAssoc) document.getElementById('entryAssociate').value = filterAssoc;
  document.getElementById('addEntryModal').classList.add('open');
}

function openEditEntry(entryId) {
  const entry = entries.find(e => e.id === entryId);
  if (!entry) return;
  editingEntryId = entryId;
  document.getElementById('addEntryTitle').textContent = 'Edit Entry';
  document.getElementById('entryDate').value = new Date(entry.clock_in).toLocaleDateString('en-CA', { timeZone: AUSTIN_TIMEZONE });
  document.getElementById('entryClockIn').value = new Date(entry.clock_in).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: AUSTIN_TIMEZONE });
  document.getElementById('entryClockOut').value = entry.clock_out ? new Date(entry.clock_out).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: AUSTIN_TIMEZONE }) : '';
  document.getElementById('entryDescription').value = entry.description || '';
  document.getElementById('entryAssociate').value = entry.associate_id;
  document.getElementById('entrySpace').value = entry.space?.id || '';
  document.getElementById('addEntryModal').classList.add('open');
}

async function confirmSaveEntry() {
  const assocId = document.getElementById('entryAssociate').value;
  const spaceId = document.getElementById('entrySpace').value;
  const date = document.getElementById('entryDate').value;
  const clockInTime = document.getElementById('entryClockIn').value;
  const clockOutTime = document.getElementById('entryClockOut').value;
  const description = document.getElementById('entryDescription').value.trim();

  if (!assocId || !date || !clockInTime) {
    showToast('Associate, date, and clock-in time are required', 'warning');
    return;
  }
  if (!spaceId) {
    showToast('Please select a space', 'warning');
    return;
  }

  const clockIn = `${date}T${clockInTime}:00`;
  const clockOut = clockOutTime ? `${date}T${clockOutTime}:00` : null;

  // Handle overnight: if clock out is before clock in, assume next day
  let clockOutAdjusted = clockOut;
  if (clockOut && clockOut < clockIn) {
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    clockOutAdjusted = `${nextDay.toISOString().split('T')[0]}T${clockOutTime}:00`;
  }

  const btn = document.getElementById('entryConfirm');
  btn.disabled = true;

  try {
    if (editingEntryId) {
      await hoursService.updateEntry(editingEntryId, {
        clock_in: clockIn,
        clock_out: clockOutAdjusted,
        description,
        space_id: spaceId
      });
      showToast('Entry updated', 'success');
    } else {
      await hoursService.createManualEntry(assocId, {
        clockIn,
        clockOut: clockOutAdjusted,
        description,
        spaceId
      });
      showToast('Entry added', 'success');
    }
    document.getElementById('addEntryModal').classList.remove('open');
    await loadEntries();
  } catch (err) {
    showToast('Failed to save entry: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// =============================================
// WORK GROUPS
// =============================================
async function loadWorkGroups() {
  try {
    workGroups = await hoursService.getWorkGroups();
    renderWorkGroups();
  } catch (err) {
    console.error('Failed to load work groups:', err);
  }
}

function renderWorkGroups() {
  const container = document.getElementById('workGroupGrid');
  if (!workGroups.length) {
    container.innerHTML = '<div class="empty-state">No work groups yet. Create one to let associates see each other\'s schedules.</div>';
    return;
  }

  container.innerHTML = workGroups.map(g => {
    const members = g.members || [];
    const memberChips = members.map(m => {
      const name = getAssocName(m.associate || {});
      return `<span class="wg-chip">
        ${escapeHtml(name)}
        <button class="wg-remove" data-wg-remove="${g.id}" data-assoc="${m.associate_id}" title="Remove">&times;</button>
      </span>`;
    }).join('');

    // Build dropdown of associates not already in this group
    const memberIds = new Set(members.map(m => m.associate_id));
    const available = associates.filter(a => !memberIds.has(a.id));
    const options = available.map(a => {
      const name = getAssocName(a);
      return `<option value="${a.id}">${escapeHtml(name)}</option>`;
    }).join('');

    return `<div class="wg-card" data-group-id="${g.id}">
      <h4>${escapeHtml(g.name)}</h4>
      ${g.description ? `<p class="wg-desc">${escapeHtml(g.description)}</p>` : ''}
      <div class="wg-members">${memberChips || '<span style="color:var(--text-muted);font-size:0.8rem;">No members yet</span>'}</div>
      ${available.length ? `<div class="wg-add-row">
        <select class="wg-member-select" data-group="${g.id}">
          <option value="">Add member...</option>
          ${options}
        </select>
        <button class="wg-add-btn" data-wg-add="${g.id}">Add</button>
      </div>` : ''}
      <button class="wg-delete" data-wg-delete="${g.id}">Delete Group</button>
    </div>`;
  }).join('');
}

// =============================================
// HELPERS
// =============================================
function getAssocName(assocOrProfile) {
  const u = assocOrProfile.app_user || assocOrProfile;
  const fullName = `${u?.first_name || ''} ${u?.last_name || ''}`.trim();
  const raw = fullName || u?.display_name || u?.email || '?';
  return isDemoUser() ? redactString(raw, 'name') : raw;
}

function formatCurrencyDisplay(amt) {
  const s = HoursService.formatCurrency(amt);
  return isDemoUser() ? redactString(s, 'amount') : s;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatGpsUrl(entry) {
  const lat = entry.clock_in_lat || entry.clock_out_lat;
  const lng = entry.clock_in_lng || entry.clock_out_lng;
  if (!lat || !lng) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

// =============================================
// EDIT REQUESTS (Admin Approval)
// =============================================
async function loadEditRequests() {
  try {
    const requests = await hoursService.getEditRequests('pending');
    const section = document.getElementById('editRequestsSection');
    const body = document.getElementById('editRequestsBody');
    const countBadge = document.getElementById('editRequestCount');

    if (!requests.length) {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';
    countBadge.textContent = `${requests.length} pending`;

    body.innerHTML = requests.map(r => {
      const name = getRequesterName(r);
      const requestedAt = new Date(r.requested_at).toLocaleString('en-US', { timeZone: AUSTIN_TIMEZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const oldCi = new Date(r.original_clock_in).toLocaleString('en-US', { timeZone: AUSTIN_TIMEZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const oldCo = new Date(r.original_clock_out).toLocaleString('en-US', { timeZone: AUSTIN_TIMEZONE, hour: 'numeric', minute: '2-digit' });
      const newCi = new Date(r.proposed_clock_in).toLocaleString('en-US', { timeZone: AUSTIN_TIMEZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const newCo = new Date(r.proposed_clock_out).toLocaleString('en-US', { timeZone: AUSTIN_TIMEZONE, hour: 'numeric', minute: '2-digit' });
      const oldMins = parseFloat(r.original_duration_minutes) || 0;
      const newMins = Math.round((new Date(r.proposed_clock_out) - new Date(r.proposed_clock_in)) / 60000);
      const addedHrs = ((newMins - oldMins) / 60).toFixed(1);

      return `<div class="edit-request-card">
        <div class="erc-header">
          <span class="erc-name">${escapeHtml(name)}</span>
          <span class="erc-date">Requested ${requestedAt}</span>
        </div>
        <div class="erc-diff">
          <div>
            <div class="erc-label">Original</div>
            <div class="erc-old">${oldCi} — ${oldCo} (${HoursService.formatDuration(oldMins)})</div>
          </div>
          <div>
            <div class="erc-label">Proposed</div>
            <div class="erc-new">${newCi} — ${newCo} (${HoursService.formatDuration(newMins)})</div>
          </div>
        </div>
        <div style="font-size:0.8rem;color:#d97706;margin-bottom:0.75rem;font-weight:600;">+${addedHrs} hours added</div>
        <div class="erc-actions">
          <button class="btn-approve" onclick="window._reviewEditRequest('${r.id}', 'approved')">Approve</button>
          <button class="btn-deny" onclick="window._reviewEditRequest('${r.id}', 'denied')">Deny</button>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    console.error('Failed to load edit requests:', err);
  }
}

function getRequesterName(request) {
  const r = request.requester;
  if (!r) return 'Unknown';
  const full = `${r.first_name || ''} ${r.last_name || ''}`.trim();
  return full || r.display_name || r.email || 'Unknown';
}

window._reviewEditRequest = async function(requestId, decision) {
  const auth = getAuthState();
  if (!auth?.appUser?.id) return;

  const btn = event.target;
  btn.disabled = true;
  btn.textContent = decision === 'approved' ? 'Approving...' : 'Denying...';

  try {
    await hoursService.reviewEditRequest(requestId, auth.appUser.id, decision);
    showToast(`Edit request ${decision}`, decision === 'approved' ? 'success' : 'info');
    await Promise.all([loadEditRequests(), loadEntries()]);
  } catch (err) {
    showToast('Failed to review request: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = decision === 'approved' ? 'Approve' : 'Deny';
  }
};
