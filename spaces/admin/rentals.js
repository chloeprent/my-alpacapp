// Rentals Page - Admin Dashboard
// Manages rental applications, pipeline, calendar, deposits, and Airbnb sync

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../shared/supabase.js';
import { rentalService } from '../../shared/rental-service.js';
import { emailService } from '../../shared/email-service.js';
import { smsService } from '../../shared/sms-service.js';
import { leaseTemplateService } from '../../shared/lease-template-service.js';
import { pdfService } from '../../shared/pdf-service.js';
import { signwellService } from '../../shared/signwell-service.js';
import { identityService } from '../../shared/identity-service.js';
import {
  getAustinToday,
  getAustinTodayISO,
  parseAustinDate,
  formatDateAustin,
  getAustinMonthYear,
  getAustinWeekday,
  isSameAustinDay,
  formatDateTimeFull
} from '../../shared/timezone.js';
import {
  showToast,
  initAdminPage,
  setupLightbox
} from '../../shared/admin-shell.js';
import { isDemoUser, redactString } from '../../shared/demo-redact.js';
import { initTabList } from '../../shared/tab-utils.js';

// =============================================
// STATE
// =============================================

let authState = null;
let allSpaces = [];
let allApplications = [];
let allPeople = [];
let allPaymentMethods = [];
let calendarAssignments = [];
let currentApplicationId = null;
let currentAssignmentId = null;

// Calendar state
let calendarCurrentDate = getAustinToday();
let calendarMonthsDisplayed = 3;
let calendarHasMoreReservations = true;

// Lease generation state
let currentLeaseTemplate = null;
let currentAgreementData = null;
let currentLeasePageCount = null;
let currentSignaturePositions = null;

// Terms auto-save timeout
let termsAutoSaveTimeout = null;

// =============================================
// LABEL MAPPINGS
// =============================================

const ACCOMMODATION_LABELS = {
  'bed_shared_room': 'Shared Room',
  'private_room': 'Private Room',
  'private_suite': 'Private Suite',
  'rv_van': 'RV/Van',
  'tent_camping': 'Tent/Camping',
  'flexible': 'Flexible',
};

const VOLUNTEER_LABELS = {
  'yes_actively': 'Yes, actively',
  'yes_sometimes': 'Yes, sometimes',
  'maybe': 'Maybe',
  'no': 'Not at this time',
};

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'rentals',
    requiredRole: 'staff',
    section: 'staff',
    onReady: async (state) => {
      authState = state;
      setupLightbox();
      await loadRentals();
      setupEventListeners();

      // Check for hash parameter to open specific application
      checkHashForApplication();
    }
  });
});

function checkHashForApplication() {
  const hash = window.location.hash;
  if (hash.startsWith('#applicant=')) {
    const appId = hash.replace('#applicant=', '');
    if (appId) {
      openRentalDetail(appId);
    }
  }
}

// =============================================
// DATA LOADING
// =============================================

async function loadRentals() {
  await Promise.all([
    loadApplications(),
    loadPeople(),
    loadPaymentMethods(),
    loadCalendarData(),
    loadAirbnbRentals(),
  ]);
  populateRentalDropdowns();
  initCalendarControls();
  initAssignmentDetailModal();
  setupAirbnbSyncListeners();
}

async function loadApplications() {
  try {
    allApplications = await rentalService.getApplications();
    renderPipeline();
    renderDenied();
  } catch (error) {
    console.error('Error loading applications:', error);
  }
}

async function loadPeople() {
  try {
    const { data, error } = await supabase
      .from('people')
      .select('id, first_name, last_name, email, type')
      .order('first_name');
    if (error) throw error;
    allPeople = data || [];
  } catch (error) {
    console.error('Error loading people:', error);
  }
}

async function loadPaymentMethods() {
  try {
    allPaymentMethods = await rentalService.getPaymentMethods(false);
    renderPaymentMethods();
  } catch (error) {
    console.error('Error loading payment methods:', error);
  }
}

function populateRentalDropdowns() {
  // Populate space dropdown for new applications (no rate info - just space name)
  const spaceSelect = document.getElementById('newAppSpaceId');
  if (spaceSelect) {
    const dwellings = allSpaces.filter(s => s.can_be_dwelling);
    spaceSelect.innerHTML = '<option value="">Any / Flexible</option>' +
      dwellings.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  }

  // Populate space dropdown for terms
  const termSpaceSelect = document.getElementById('termSpace');
  if (termSpaceSelect) {
    const dwellings = allSpaces.filter(s => s.can_be_dwelling);
    termSpaceSelect.innerHTML = '<option value="">Select space...</option>' +
      dwellings.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  }
}

// =============================================
// PIPELINE RENDERING
// =============================================

function renderPipeline() {
  const stages = ['community_fit', 'applications', 'approved', 'contract', 'deposit', 'ready'];

  // Group applications by pipeline stage
  const grouped = {};
  stages.forEach(s => grouped[s] = []);

  allApplications.forEach(app => {
    const stage = rentalService.getPipelineStage(app);
    if (grouped[stage]) {
      grouped[stage].push(app);
    }
  });

  // Render each column
  stages.forEach(stage => {
    const container = document.getElementById(`${stage}Cards`);
    const countEl = document.getElementById(`${stage}Count`);
    const apps = grouped[stage] || [];

    if (countEl) countEl.textContent = apps.length;

    if (container) {
      if (apps.length === 0) {
        container.innerHTML = '<div class="pipeline-empty">No applications</div>';
      } else {
        container.innerHTML = apps.map(app => renderPipelineCard(app)).join('');

        // Add click handlers
        container.querySelectorAll('.pipeline-card').forEach(card => {
          card.addEventListener('click', () => openRentalDetail(card.dataset.id));
        });
      }
    }
  });
}

function renderPipelineCard(app) {
  const person = app.person || {};
  const space = app.approved_space || app.desired_space;
  const days = rentalService.daysSince(app.created_at || app.submitted_at);
  const isInquiry = app.application_status === 'inquiry';

  let subStatus = '';
  if (isInquiry && app.invited_to_apply_at) {
    subStatus = 'invited';
  } else if (app.deposit_status && app.deposit_status !== 'pending') {
    subStatus = app.deposit_status;
  } else if (app.agreement_status && app.agreement_status !== 'pending') {
    subStatus = app.agreement_status;
  }

  const testBadge = app.is_test ? '<span class="test-badge">TEST</span>' : '';

  const displayName = isInquiry
    ? (ACCOMMODATION_LABELS[person.preferred_accommodation] || person.preferred_accommodation || 'Flexible')
    : (space?.name || 'Flexible');

  // Identity verification badge
  const idStatus = app.identity_verification_status;
  const idBadge = idStatus === 'verified' ? '<span title="ID Verified" style="color: #27ae60; margin-left: 4px;">&#128737;</span>'
    : idStatus === 'flagged' ? '<span title="ID Flagged" style="color: #e67e22; margin-left: 4px;">&#128737;</span>'
    : idStatus === 'link_sent' ? '<span title="ID Pending" style="color: #999; margin-left: 4px;">&#128737;</span>'
    : '';

  const demo = isDemoUser();
  const cardName = demo
    ? `<span class="demo-redacted">${redactString(`${person.first_name || ''} ${person.last_name || ''}`, 'name')}</span>`
    : `${person.first_name || ''} ${person.last_name || ''}`;
  const rateDisplay = app.approved_rate
    ? (demo
      ? `<div class="rate demo-redacted">${redactString('$' + app.approved_rate, 'amount')}</div>`
      : `<div class="rate">$${app.approved_rate}/${app.approved_rate_term === 'weekly' ? 'wk' : app.approved_rate_term === 'nightly' ? 'night' : 'mo'}</div>`)
    : '';

  return `
    <div class="pipeline-card" data-id="${app.id}">
      <div class="card-header">
        <span class="applicant-name">${cardName}${idBadge}</span>
        ${testBadge}
        <span class="days-ago">${days}d</span>
      </div>
      <div class="card-body">
        <div class="space-name">${displayName}</div>
        ${rateDisplay}
      </div>
      ${subStatus ? `
        <div class="card-footer">
          <span class="sub-status">${subStatus}</span>
        </div>
      ` : ''}
    </div>
  `;
}

function renderDenied() {
  const denied = allApplications.filter(app =>
    app.application_status === 'denied'
  );

  const container = document.getElementById('deniedList');
  const countEl = document.getElementById('deniedCount');

  if (countEl) countEl.textContent = denied.length;

  if (container) {
    if (denied.length === 0) {
      container.innerHTML = '<p class="text-muted">No denied applications.</p>';
    } else {
      container.innerHTML = denied.map(app => {
        const person = app.person || {};
        const deniedName = isDemoUser()
          ? `<span class="demo-redacted">${redactString(`${person.first_name || ''} ${person.last_name || ''}`, 'name')}</span>`
          : `${person.first_name || ''} ${person.last_name || ''}`;
        return `
          <div class="space-item" style="cursor: pointer;" onclick="window.openRentalDetail('${app.id}')">
            <div class="space-item-info">
              <div class="space-item-details">
                <h3>${deniedName}</h3>
                <small>denied - ${app.denial_reason || 'No reason given'}</small>
              </div>
            </div>
            <div class="space-item-meta">
              <span class="status-badge denied">denied</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }
}

function renderPaymentMethods() {
  const container = document.getElementById('paymentMethodsList');
  if (!container) return;

  if (allPaymentMethods.length === 0) {
    container.innerHTML = '<p class="text-muted">No payment methods configured.</p>';
    return;
  }

  container.innerHTML = allPaymentMethods.map(method => {
    const qrUrl = method.qr_code?.url;
    return `
      <div class="payment-method-card ${method.is_active ? '' : 'inactive'}" onclick="window.openPaymentMethodModal('${method.id}')">
        ${qrUrl
          ? `<div class="qr-code"><img src="${qrUrl}" alt="${method.name} QR"></div>`
          : `<div class="qr-placeholder">$</div>`
        }
        <div class="method-info">
          <div class="method-name">${method.name}</div>
          <div class="method-account">${method.account_identifier || '-'}</div>
          <div class="method-type">${method.method_type}</div>
        </div>
      </div>
    `;
  }).join('');
}

// =============================================
// RESERVATIONS CALENDAR
// =============================================

async function loadCalendarData() {
  try {
    // Load spaces if not already loaded (needed for assignments table and calendar)
    if (allSpaces.length === 0) {
      const { data: spacesData } = await supabase
        .from('spaces')
        .select('id, name, can_be_dwelling, monthly_rate, is_archived')
        .eq('is_archived', false);
      if (spacesData) {
        allSpaces = spacesData;
      }
    }

    // Load assignments with people and spaces
    const { data, error } = await supabase
      .from('assignments')
      .select(`
        *,
        person:person_id(id, first_name, last_name, email, phone),
        assignment_spaces(space_id)
      `)
      .in('status', ['active', 'pending_contract', 'contract_sent'])
      .order('start_date');

    if (error) throw error;
    calendarAssignments = data || [];
    renderAssignmentsTable();
    renderCalendar();
  } catch (error) {
    console.error('Error loading calendar data:', error);
    const container = document.getElementById('reservationsCalendar');
    if (container) {
      container.innerHTML = '<div class="calendar-loading" style="color: var(--danger);">Error loading calendar data</div>';
    }
  }
}

function initCalendarControls() {
  document.getElementById('calendarToday')?.addEventListener('click', () => {
    calendarCurrentDate = getAustinToday();
    calendarMonthsDisplayed = 3;
    renderCalendar();
    // Scroll to start
    const container = document.getElementById('reservationsCalendar');
    if (container) container.scrollLeft = 0;
  });

  // Event delegation for reservation bar tooltips and load more button
  const calendarContainer = document.getElementById('reservationsCalendar');
  if (calendarContainer) {
    calendarContainer.addEventListener('mouseenter', (e) => {
      const bar = e.target.closest('.reservation-bar');
      if (bar) showReservationTooltip(e, bar);
    }, true);

    calendarContainer.addEventListener('mouseleave', (e) => {
      const bar = e.target.closest('.reservation-bar');
      if (bar) hideReservationTooltip();
    }, true);

    calendarContainer.addEventListener('click', (e) => {
      if (e.target.closest('#loadMoreMonths')) {
        loadMoreCalendarMonths();
      }
    });
  }
}

function loadMoreCalendarMonths() {
  // Check if there are any reservations extending beyond current view
  const lastDay = new Date(calendarCurrentDate.getFullYear(), calendarCurrentDate.getMonth() + calendarMonthsDisplayed, 0);

  const hasReservationsBeyond = calendarAssignments.some(a => {
    const endDate = a.desired_departure_listed && a.desired_departure_date
      ? parseAustinDate(a.desired_departure_date)
      : (a.end_date ? parseAustinDate(a.end_date) : null);
    // Ongoing reservations or ones ending after our view
    return !endDate || endDate > lastDay;
  });

  if (hasReservationsBeyond) {
    calendarMonthsDisplayed += 3;
    renderCalendar();
    // Scroll to the end to see the new months
    setTimeout(() => {
      const container = document.getElementById('reservationsCalendar');
      if (container) {
        container.scrollLeft = container.scrollWidth;
      }
    }, 50);
  } else {
    calendarHasMoreReservations = false;
    renderCalendar();
  }
}

function renderAssignmentsTable() {
  const container = document.getElementById('assignmentsTableContainer');
  const countEl = document.getElementById('assignmentsCount');
  if (!container) return;

  if (calendarAssignments.length === 0) {
    container.innerHTML = '<div class="calendar-empty">No active or upcoming assignments</div>';
    if (countEl) countEl.textContent = '0';
    return;
  }

  // Sort assignments: active first, then by start date
  const sorted = [...calendarAssignments].sort((a, b) => {
    // Active first
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return 1;
    // Then by start date
    const aStart = a.start_date ? parseAustinDate(a.start_date) : new Date(0);
    const bStart = b.start_date ? parseAustinDate(b.start_date) : new Date(0);
    return aStart - bStart;
  });

  if (countEl) countEl.textContent = sorted.length;

  // Build table HTML with scroll wrapper for mobile
  let html = `
    <div class="table-scroll-wrapper">
    <table class="data-table assignments-table">
      <thead>
        <tr>
          <th>Tenant</th>
          <th>Space</th>
          <th>Start</th>
          <th>End</th>
          <th>Rate</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
  `;

  sorted.forEach(assignment => {
    const person = assignment.person || {};
    const rawTenantName = `${person.first_name || ''} ${person.last_name || ''}`.trim() || 'Unknown';
    const tenantName = isDemoUser() ? redactString(rawTenantName, 'name') : rawTenantName;
    const demoClass = isDemoUser() ? ' demo-redacted' : '';

    // Get space names
    const spaceIds = assignment.assignment_spaces?.map(as => as.space_id) || [];
    const spaceNames = spaceIds.map(id => {
      const space = allSpaces.find(s => s.id === id);
      return space ? space.name : 'Unknown';
    }).join(', ') || 'None';

    const startDate = assignment.start_date
      ? formatDateAustin(assignment.start_date, { month: 'short', day: 'numeric', year: 'numeric' })
      : '-';

    const effectiveEndDate = assignment.desired_departure_listed && assignment.desired_departure_date
      ? assignment.desired_departure_date
      : assignment.end_date;
    const endDate = effectiveEndDate
      ? formatDateAustin(effectiveEndDate, { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Ongoing';

    const rawRate = assignment.rate_amount
      ? `$${assignment.rate_amount}/${assignment.rate_term || 'mo'}`
      : (assignment.monthly_rent ? `$${assignment.monthly_rent}/mo` : '-');
    const rate = isDemoUser() && rawRate !== '-' ? redactString(rawRate, 'amount') : rawRate;

    const statusClass = assignment.status.replace(/_/g, '-');
    const statusLabel = assignment.status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    html += `
      <tr class="clickable-row" data-assignment-id="${assignment.id}">
        <td>
          <div class="tenant-cell">
            <strong class="${demoClass}">${tenantName}</strong>
            ${person.email ? `<div class="tenant-email${isDemoUser() ? ' demo-redacted' : ''}">${isDemoUser() ? redactString(person.email, 'email') : person.email}</div>` : ''}
          </div>
        </td>
        <td>${spaceNames}</td>
        <td>${startDate}</td>
        <td>${endDate}</td>
        <td class="${demoClass}">${rate}</td>
        <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
      </tr>
    `;
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;

  // Add click handlers for rows
  container.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', () => {
      const assignmentId = row.dataset.assignmentId;
      openAssignmentDetail(assignmentId);
    });
  });
}

async function openAssignmentDetail(assignmentId) {
  currentAssignmentId = assignmentId;
  const assignment = calendarAssignments.find(a => a.id === assignmentId);
  if (!assignment) return;

  const modal = document.getElementById('assignmentDetailModal');
  const person = assignment.person || {};

  // Set title
  const rawAssignTenantName = `${person.first_name || ''} ${person.last_name || ''}`.trim() || 'Unknown';
  const assignTenantName = isDemoUser() ? redactString(rawAssignTenantName, 'name') : rawAssignTenantName;
  const assignTitleEl = document.getElementById('assignmentDetailTitle');
  assignTitleEl.textContent = assignTenantName;
  assignTitleEl.classList.toggle('demo-redacted', isDemoUser());

  // Status badge
  const statusBadge = document.getElementById('assignmentDetailStatus');
  const statusLabel = assignment.status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  statusBadge.textContent = statusLabel;
  statusBadge.className = `status-badge ${assignment.status.replace(/_/g, '-')}`;

  // Tenant info (read-only)
  document.getElementById('assignmentTenantName').textContent = assignTenantName;
  document.getElementById('assignmentTenantName').classList.toggle('demo-redacted', isDemoUser());
  const tenantEmail = isDemoUser() ? redactString(person.email || '-', 'email') : (person.email || '-');
  document.getElementById('assignmentTenantEmail').textContent = tenantEmail;
  document.getElementById('assignmentTenantEmail').classList.toggle('demo-redacted', isDemoUser());
  document.getElementById('assignmentTenantPhone').textContent = person.phone || '-';

  // Populate space dropdown
  const spaceSelect = document.getElementById('assignmentSpace');
  spaceSelect.innerHTML = '<option value="">Select a space...</option>' +
    allSpaces.filter(s => !s.is_archived).map(s =>
      `<option value="${s.id}">${s.name}</option>`
    ).join('');

  // Set current space (first one if multiple)
  const currentSpaceId = assignment.assignment_spaces?.[0]?.space_id || '';
  spaceSelect.value = currentSpaceId;

  // Set status
  document.getElementById('assignmentStatus').value = assignment.status || 'active';

  // Dates
  document.getElementById('assignmentStartDate').value = assignment.start_date || '';
  document.getElementById('assignmentEndDate').value = assignment.end_date || '';

  // Financial
  document.getElementById('assignmentRateAmount').value = assignment.rate_amount || assignment.monthly_rent || '';
  document.getElementById('assignmentRateTerm').value = assignment.rate_term || 'monthly';
  document.getElementById('assignmentDepositAmount').value = assignment.deposit_amount || '';
  document.getElementById('assignmentNoticeDays').value = assignment.notice_days || '';
  document.getElementById('assignmentIsFree').checked = assignment.is_free || false;

  // Early departure
  document.getElementById('assignmentDesiredDeparture').value = assignment.desired_departure_date || '';
  document.getElementById('assignmentDepartureListed').checked = assignment.desired_departure_listed || false;

  // Notes
  document.getElementById('assignmentNotes').value = assignment.notes || '';

  // Show modal
  modal.classList.remove('hidden');
}

function closeAssignmentDetail() {
  document.getElementById('assignmentDetailModal').classList.add('hidden');
  currentAssignmentId = null;
}

async function saveAssignment() {
  if (!currentAssignmentId) return;

  const assignment = calendarAssignments.find(a => a.id === currentAssignmentId);
  if (!assignment) return;

  // Get form values
  const rateTermValue = document.getElementById('assignmentRateTerm').value;
  const rateAmount = parseFloat(document.getElementById('assignmentRateAmount').value);

  const updates = {
    status: document.getElementById('assignmentStatus').value,
    start_date: document.getElementById('assignmentStartDate').value || null,
    end_date: document.getElementById('assignmentEndDate').value || null,
    rate_amount: isNaN(rateAmount) ? null : rateAmount,
    deposit_amount: parseFloat(document.getElementById('assignmentDepositAmount').value) || null,
    notice_days: parseInt(document.getElementById('assignmentNoticeDays').value) || null,
    is_free: document.getElementById('assignmentIsFree').checked,
    desired_departure_date: document.getElementById('assignmentDesiredDeparture').value || null,
    desired_departure_listed: document.getElementById('assignmentDepartureListed').checked,
    notes: document.getElementById('assignmentNotes').value || null
  };

  // Only include rate_term if it has a valid value (not empty string)
  if (rateTermValue && ['hourly', 'daily', 'weekly', 'monthly', 'flat'].includes(rateTermValue)) {
    updates.rate_term = rateTermValue;
  }

  console.log('Saving assignment with updates:', updates);

  try {
    const { error } = await supabase
      .from('assignments')
      .update(updates)
      .eq('id', currentAssignmentId);

    if (error) {
      console.error('Supabase error:', error);
      throw error;
    }

    // Update space if changed
    const newSpaceId = document.getElementById('assignmentSpace').value;
    const currentSpaceId = assignment.assignment_spaces?.[0]?.space_id;

    if (newSpaceId && newSpaceId !== currentSpaceId) {
      // Delete old assignment_spaces
      await supabase
        .from('assignment_spaces')
        .delete()
        .eq('assignment_id', currentAssignmentId);

      // Insert new one
      await supabase
        .from('assignment_spaces')
        .insert({ assignment_id: currentAssignmentId, space_id: newSpaceId });
    }

    showToast('Assignment updated', 'success');
    closeAssignmentDetail();

    // Reload data
    await loadCalendarData();
  } catch (error) {
    console.error('Error saving assignment:', error);
    showToast('Failed to save assignment', 'error');
  }
}

function initAssignmentDetailModal() {
  document.getElementById('closeAssignmentDetail')?.addEventListener('click', closeAssignmentDetail);
  document.getElementById('closeAssignmentDetailBtn')?.addEventListener('click', closeAssignmentDetail);
  document.getElementById('saveAssignmentBtn')?.addEventListener('click', saveAssignment);

  // Close on backdrop click
  document.getElementById('assignmentDetailModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'assignmentDetailModal') {
      closeAssignmentDetail();
    }
  });
}

function renderCalendar() {
  const container = document.getElementById('reservationsCalendar');
  if (!container) return;

  // Get dwelling spaces only
  const dwellingSpaces = allSpaces.filter(s => s.can_be_dwelling && !s.is_archived);

  if (dwellingSpaces.length === 0) {
    container.innerHTML = '<div class="calendar-empty">No dwelling spaces configured</div>';
    return;
  }

  // Get date range for multiple months
  const year = calendarCurrentDate.getFullYear();
  const month = calendarCurrentDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + calendarMonthsDisplayed, 0);

  // Update month range label
  const monthRangeLabel = document.getElementById('calendarMonthRange');
  if (monthRangeLabel) {
    const startMonth = formatDateAustin(firstDay, { month: 'short', year: 'numeric' });
    const endMonth = formatDateAustin(lastDay, { month: 'short', year: 'numeric' });
    monthRangeLabel.textContent = `${startMonth} - ${endMonth}`;
  }

  // Generate array of days for all months
  const days = [];
  for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
  }

  const today = getAustinToday();

  // Check if there are reservations extending beyond current view
  const hasReservationsBeyond = calendarAssignments.some(a => {
    const endDate = a.desired_departure_listed && a.desired_departure_date
      ? parseAustinDate(a.desired_departure_date)
      : (a.end_date ? parseAustinDate(a.end_date) : null);
    return !endDate || endDate > lastDay;
  });

  // Build HTML
  let html = '<div class="calendar-timeline-wrapper">';
  html += '<div class="calendar-timeline">';

  // Header row with days - add month separators
  html += '<div class="calendar-header">';
  html += '<div class="calendar-space-label">Space</div>';
  html += '<div class="calendar-days">';

  let currentMonthYear = '';
  days.forEach((day, idx) => {
    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
    const isToday = isSameAustinDay(day, today);
    const monthYear = getAustinMonthYear(day);
    const isFirstOfMonth = day.getDate() === 1;
    const showMonthLabel = monthYear !== currentMonthYear;
    if (showMonthLabel) currentMonthYear = monthYear;

    html += `
      <div class="calendar-day ${isWeekend ? 'weekend' : ''} ${isToday ? 'today' : ''} ${isFirstOfMonth ? 'first-of-month' : ''}">
        ${showMonthLabel ? `<div class="month-label">${monthYear}</div>` : ''}
        <div class="day-num">${day.getDate()}</div>
        <div class="day-name">${getAustinWeekday(day, 'short').slice(0, 2)}</div>
      </div>
    `;
  });

  html += '</div></div>';

  // Rows for each space
  dwellingSpaces.forEach(space => {
    html += '<div class="calendar-row">';
    html += `
      <div class="calendar-space-name">
        <span>${space.name}</span>
        ${space.monthly_rate ? `<span class="space-rate">$${space.monthly_rate}/mo</span>` : ''}
      </div>
    `;
    html += '<div class="calendar-cells">';

    // Add cells for each day
    days.forEach(day => {
      const isWeekend = day.getDay() === 0 || day.getDay() === 6;
      const isToday = isSameAustinDay(day, today);
      const isFirstOfMonth = day.getDate() === 1;
      html += `<div class="calendar-cell ${isWeekend ? 'weekend' : ''} ${isToday ? 'today' : ''} ${isFirstOfMonth ? 'first-of-month' : ''}" data-date="${day.toISOString().split('T')[0]}"></div>`;
    });

    // Add reservation bars for this space (inside calendar-cells)
    const spaceAssignments = calendarAssignments.filter(a =>
      a.assignment_spaces?.some(as => as.space_id === space.id)
    );

    spaceAssignments.forEach(assignment => {
      const startDate = assignment.start_date ? parseAustinDate(assignment.start_date) : null;
      const endDate = assignment.desired_departure_listed && assignment.desired_departure_date
        ? parseAustinDate(assignment.desired_departure_date)
        : (assignment.end_date ? parseAustinDate(assignment.end_date) : null);

      if (!startDate) return;

      // Clamp dates to visible range
      const visibleStart = new Date(Math.max(startDate.getTime(), firstDay.getTime()));
      const visibleEnd = endDate
        ? new Date(Math.min(endDate.getTime(), lastDay.getTime()))
        : lastDay;

      // Skip if entirely outside visible range
      if (startDate > lastDay || (endDate && endDate < firstDay)) return;

      // Calculate position using pixel width (30px per day)
      const dayWidthPx = 30;
      const startOffset = Math.max(0, (visibleStart - firstDay) / (24 * 60 * 60 * 1000));
      const endOffset = (visibleEnd - firstDay) / (24 * 60 * 60 * 1000) + 1;
      const widthPx = (endOffset - startOffset) * dayWidthPx;
      const leftPx = startOffset * dayWidthPx;

      const person = assignment.person || {};
      const isAirbnb = assignment.airbnb_uid != null;
      let tenantName = `${person.first_name || ''} ${person.last_name || ''}`.trim() || 'Unknown';

      // For Airbnb bookings, show "Airbnb Guest" and extract info from notes if available
      if (isAirbnb && tenantName === 'Airbnb Guest') {
        // Try to extract guest info from notes (e.g., "Imported from Airbnb: Reserved - John Smith")
        const notes = assignment.notes || '';
        const airbnbMatch = notes.match(/Imported from Airbnb: (.+)/);
        if (airbnbMatch && airbnbMatch[1] && airbnbMatch[1] !== 'Airbnb (Not available)') {
          tenantName = airbnbMatch[1];
        } else {
          tenantName = 'Airbnb Guest';
        }
      }

      if (isDemoUser()) tenantName = redactString(tenantName, 'name');

      const rawCalRate = assignment.rate_amount
        ? `$${assignment.rate_amount}/${assignment.rate_term || 'mo'}`
        : (assignment.monthly_rent ? `$${assignment.monthly_rent}/mo` : '');
      const rate = isDemoUser() && rawCalRate ? redactString(rawCalRate, 'amount') : rawCalRate;

      const tooltipData = JSON.stringify({
        tenant: tenantName,
        email: isDemoUser() ? redactString(person.email || '-', 'email') : (person.email || '-'),
        phone: person.phone || '-',
        start: formatDateAustin(startDate, { month: 'short', day: 'numeric', year: 'numeric' }),
        end: endDate ? formatDateAustin(endDate, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Ongoing',
        rate: rate || 'N/A',
        deposit: isDemoUser() && assignment.deposit_amount ? redactString(`$${assignment.deposit_amount}`, 'amount') : (assignment.deposit_amount ? `$${assignment.deposit_amount}` : 'N/A'),
        status: assignment.status
      }).replace(/"/g, '&quot;');

      html += `
        <div class="reservation-bar ${assignment.status}"
             style="left: ${leftPx}px; width: ${Math.max(widthPx - 4, 20)}px;"
             data-tooltip='${tooltipData}'>
          <div class="bar-content">
            <span class="tenant-name">${tenantName}</span>
            ${rate ? `<span class="bar-details">${rate}</span>` : ''}
          </div>
        </div>
      `;
    });

    html += '</div>'; // close calendar-cells
    html += '</div>'; // close calendar-row
  });

  html += '</div>'; // close calendar-timeline

  // Add load more button at the right edge (inside wrapper)
  if (hasReservationsBeyond) {
    html += `
      <div class="load-more-column">
        <button id="loadMoreMonths" class="load-more-btn" title="Load 3 more months">
          <span class="load-more-icon">+3</span>
          <span class="load-more-text">months</span>
        </button>
      </div>
    `;
  } else if (calendarMonthsDisplayed > 3) {
    html += `
      <div class="load-more-column no-more">
        <span class="no-more-message">No more reservations</span>
      </div>
    `;
  }

  html += '</div>'; // close calendar-timeline-wrapper

  // Add tooltip element
  html += '<div id="reservationTooltip" class="reservation-tooltip"></div>';

  container.innerHTML = html;
}

function showReservationTooltip(event, element) {
  const tooltip = document.getElementById('reservationTooltip');
  if (!tooltip) return;

  try {
    const data = JSON.parse(element.dataset.tooltip);
    tooltip.innerHTML = `
      <div class="tooltip-header">${data.tenant}</div>
      <div class="tooltip-row"><span class="tooltip-label">Email:</span><span class="tooltip-value">${data.email}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Phone:</span><span class="tooltip-value">${data.phone}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Dates:</span><span class="tooltip-value">${data.start} - ${data.end}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Rate:</span><span class="tooltip-value">${data.rate}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Deposit:</span><span class="tooltip-value">${data.deposit}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Status:</span><span class="tooltip-value">${data.status}</span></div>
    `;

    const rect = element.getBoundingClientRect();
    tooltip.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
    tooltip.style.top = `${rect.bottom + 8}px`;
    tooltip.classList.add('visible');
  } catch (e) {
    console.error('Error parsing tooltip data:', e);
  }
}

function hideReservationTooltip() {
  const tooltip = document.getElementById('reservationTooltip');
  if (tooltip) tooltip.classList.remove('visible');
}

// =============================================
// RENTAL DETAIL PAGE
// =============================================

function showApplicantDetailPage() {
  // Hide all sibling sections in the rentals panel
  const panel = document.querySelector('.manage-panel');
  if (panel) {
    Array.from(panel.children).forEach(child => {
      if (child.id !== 'applicantDetailPage') {
        child.dataset.wasHidden = child.classList.contains('hidden') ? '1' : '';
        child.classList.add('hidden');
      }
    });
  }
  document.getElementById('applicantDetailPage').classList.remove('hidden');
}

function hideApplicantDetailPage() {
  document.getElementById('applicantDetailPage').classList.add('hidden');
  // Restore all sibling sections
  const panel = document.querySelector('.manage-panel');
  if (panel) {
    Array.from(panel.children).forEach(child => {
      if (child.id !== 'applicantDetailPage') {
        if (child.dataset.wasHidden !== '1') {
          child.classList.remove('hidden');
        }
        delete child.dataset.wasHidden;
      }
    });
  }
  currentApplicationId = null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

async function openRentalDetail(applicationId, activeTab = 'applicant') {
  currentApplicationId = applicationId;
  const app = allApplications.find(a => a.id === applicationId);
  if (!app) return;

  const person = app.person || {};
  const desiredSpace = app.desired_space;
  const approvedSpace = app.approved_space;

  // Update header
  const rawFullName = `${person.first_name || ''} ${person.last_name || ''}`.trim() || '-';
  const fullName = isDemoUser() ? redactString(rawFullName, 'name') : rawFullName;
  const detailTitleEl = document.getElementById('detailTitle');
  detailTitleEl.textContent = fullName;
  detailTitleEl.classList.toggle('demo-redacted', isDemoUser());
  const statusBadge = document.getElementById('detailStatus');
  statusBadge.textContent = app.application_status;
  statusBadge.className = `status-badge ${app.application_status}`;

  // Test badge
  const testBadge = document.getElementById('detailTestBadge');
  if (testBadge) testBadge.style.display = app.is_test ? 'inline-block' : 'none';

  // Header meta
  const detailEmail = isDemoUser() ? redactString(person.email || '-', 'email') : (person.email || '-');
  document.getElementById('detailEmail').textContent = detailEmail;
  document.getElementById('detailEmail').classList.toggle('demo-redacted', isDemoUser());
  document.getElementById('detailPhone').textContent = person.phone || '-';
  document.getElementById('detailSubmittedAt').textContent =
    'Submitted: ' + rentalService.formatDate(app.submitted_at || app.created_at);

  // Photo
  const photoGroup = document.getElementById('detailPhotoGroup');
  if (person.photo_url) {
    photoGroup.style.display = '';
    document.getElementById('detailPhoto').src = person.photo_url;
  } else {
    photoGroup.style.display = 'none';
  }

  // ===== APPLICANT TAB =====
  // Contact Info
  document.getElementById('detailApplicantName').textContent = fullName;
  document.getElementById('detailApplicantName').classList.toggle('demo-redacted', isDemoUser());
  const applicantEmail = isDemoUser() ? redactString(person.email || '-', 'email') : (person.email || '-');
  document.getElementById('detailApplicantEmail').textContent = applicantEmail;
  document.getElementById('detailApplicantEmail').classList.toggle('demo-redacted', isDemoUser());
  document.getElementById('detailApplicantPhone').textContent = person.phone || '-';
  document.getElementById('detailApplicantDOB').textContent =
    person.date_of_birth || '-';

  // Community Fit
  document.getElementById('detailPreferredAccomm').textContent =
    ACCOMMODATION_LABELS[person.preferred_accommodation] || person.preferred_accommodation || '-';
  document.getElementById('detailDesiredTimeframe').textContent = person.desired_timeframe || '-';
  document.getElementById('detailVolunteerInterest').textContent =
    VOLUNTEER_LABELS[person.volunteer_interest] || person.volunteer_interest || '-';
  document.getElementById('detailReferralSource').textContent = person.referral_source || '-';
  document.getElementById('detailColivingExp').textContent = person.coliving_experience || '-';
  document.getElementById('detailLifeFocus').textContent = person.life_focus || '-';
  document.getElementById('detailVisitingGuide').textContent = person.visiting_guide_response || '-';

  // Desired Housing
  document.getElementById('detailDesiredSpace').textContent = desiredSpace?.name || 'Flexible';
  document.getElementById('detailDesiredMoveIn').textContent =
    app.desired_move_in ? rentalService.formatDate(app.desired_move_in) : '-';
  document.getElementById('detailDesiredTerm').textContent = app.desired_term || '-';

  // Financial
  document.getElementById('detailEmploymentStatus').textContent = person.employment_status || '-';
  document.getElementById('detailEmployer').textContent = person.employer || '-';
  document.getElementById('detailMonthlyIncome').textContent =
    person.monthly_income ? rentalService.formatCurrency(person.monthly_income) : '-';
  document.getElementById('detailDepositReturnMethod').textContent = person.deposit_return_method || '-';

  // Household
  document.getElementById('detailPartnerEmail').textContent = person.partner_email || '-';
  document.getElementById('detailKidsAges').textContent = person.kids_ages || '-';

  // Property Details
  document.getElementById('detailVehicles').textContent = person.vehicles || '-';
  document.getElementById('detailPets').textContent = person.pets || '-';
  document.getElementById('detailAllergies').textContent = person.allergies || '-';

  // Social Profiles
  document.getElementById('detailInstagram').textContent = person.instagram || '-';
  document.getElementById('detailFacebook').textContent = person.facebook || '-';
  document.getElementById('detailXHandle').textContent = person.x_handle || '-';
  document.getElementById('detailMyspace').textContent = person.myspace || '-';

  // Previous Residence (fetch from DB)
  try {
    const { data: prevResidences } = await supabase
      .from('previous_residences')
      .select('*')
      .eq('person_id', person.id)
      .limit(1);
    const prev = prevResidences?.[0];
    document.getElementById('detailPrevAddress').textContent = prev?.address || '-';
    document.getElementById('detailPrevStartDate').textContent =
      prev?.start_date ? rentalService.formatDate(prev.start_date) : '-';
    document.getElementById('detailPrevEndDate').textContent =
      prev?.end_date ? rentalService.formatDate(prev.end_date) : '-';
    document.getElementById('detailLandlordName').textContent = prev?.landlord_name || '-';
    document.getElementById('detailLandlordContact').textContent = prev?.landlord_contact || '-';
    document.getElementById('detailReasonForLeaving').textContent = prev?.reason_for_leaving || '-';
    document.getElementById('detailPriorEvictions').textContent =
      prev ? (person.prior_evictions ? 'Yes' : 'No') : '-';
  } catch (e) {
    console.error('Error loading previous residence:', e);
  }

  // ===== TERMS TAB =====
  document.getElementById('termSpace').value = app.approved_space_id || app.desired_space_id || '';
  document.getElementById('termRate').value = app.approved_rate ?? approvedSpace?.monthly_rate ?? desiredSpace?.monthly_rate ?? '';
  document.getElementById('termRateTerm').value = app.approved_rate_term || 'monthly';
  document.getElementById('termMoveIn').value = app.approved_move_in || app.desired_move_in || '';
  document.getElementById('termLeaseEnd').value = app.approved_lease_end || '';
  document.getElementById('termNoticePeriod').value = app.notice_period || '30_days';
  document.getElementById('termSecurityDeposit').value = app.security_deposit_amount || 0;
  const defaultReservationDeposit = app.approved_rate ?? approvedSpace?.monthly_rate ?? desiredSpace?.monthly_rate ?? 0;
  document.getElementById('termReservationDeposit').value = app.reservation_deposit_amount ?? defaultReservationDeposit;
  document.getElementById('termAdditionalTerms').value = app.additional_terms || '';
  document.getElementById('termCheckInTime').value = app.check_in_time || '';
  document.getElementById('termCheckOutTime').value = app.check_out_time || '';
  document.getElementById('termRequireLease').checked = app.require_lease !== false;

  // ===== DOCUMENTS TAB =====
  const statusDisplay = document.getElementById('agreementStatusDisplay');
  const agStatusVal = app.agreement_status || 'pending';
  switch (agStatusVal) {
    case 'pending':
      statusDisplay.innerHTML = 'Not started';
      statusDisplay.className = 'status-badge';
      break;
    case 'generated': {
      const genDate = app.agreement_generated_at
        ? ` <span class="text-muted" style="font-size:0.8rem;margin-left:0.5rem;">${formatDateAustin(app.agreement_generated_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</span>`
        : '';
      statusDisplay.innerHTML = `PDF Generated${genDate}`;
      statusDisplay.className = 'status-badge warning';
      break;
    }
    case 'sent': {
      const sentDate = app.agreement_sent_at
        ? ` <span class="text-muted" style="font-size:0.8rem;margin-left:0.5rem;">Sent ${formatDateAustin(app.agreement_sent_at, { month: 'short', day: 'numeric' })} — awaiting signature</span>`
        : '';
      statusDisplay.innerHTML = `Sent for Signature${sentDate}`;
      statusDisplay.className = 'status-badge active';
      break;
    }
    case 'signed': {
      const signedDate = app.agreement_signed_at
        ? ` <span class="text-muted" style="font-size:0.8rem;margin-left:0.5rem;">${formatDateAustin(app.agreement_signed_at, { month: 'short', day: 'numeric' })}</span>`
        : '';
      statusDisplay.innerHTML = `Signed ✓${signedDate}`;
      statusDisplay.className = 'status-badge complete';
      break;
    }
    default:
      statusDisplay.textContent = agStatusVal;
      statusDisplay.className = 'status-badge';
  }
  document.getElementById('agreementDocUrl').value = app.agreement_document_url || '';
  await updateDocumentsTabState(app);
  await updateIdentityVerificationUI(app);

  // ===== DEPOSITS TAB =====
  renderPaymentSummary(app);

  const moveInAmtEl = document.getElementById('moveInDepositAmount');
  const moveInAmtRaw = rentalService.formatCurrency(app.move_in_deposit_amount || app.approved_rate || 0);
  moveInAmtEl.textContent = isDemoUser() ? redactString(moveInAmtRaw, 'amount') : moveInAmtRaw;
  moveInAmtEl.classList.toggle('demo-redacted', isDemoUser());
  document.getElementById('moveInDepositStatus').textContent =
    app.move_in_deposit_paid ? 'Paid' : 'Pending';
  document.getElementById('moveInDepositStatus').className =
    `deposit-status ${app.move_in_deposit_paid ? 'paid' : ''}`;

  const secDepAmtEl = document.getElementById('securityDepositAmount');
  const secDepAmtRaw = rentalService.formatCurrency(app.security_deposit_amount || 0);
  secDepAmtEl.textContent = isDemoUser() ? redactString(secDepAmtRaw, 'amount') : secDepAmtRaw;
  secDepAmtEl.classList.toggle('demo-redacted', isDemoUser());
  document.getElementById('securityDepositStatus').textContent =
    app.security_deposit_paid ? 'Paid' : (app.security_deposit_amount > 0 ? 'Pending' : 'N/A');
  document.getElementById('securityDepositStatus').className =
    `deposit-status ${app.security_deposit_paid ? 'paid' : ''}`;

  if (app.approved_move_in && app.approved_rate) {
    const rateTerm = app.approved_rate_term || 'monthly';
    const prorationEl = document.getElementById('prorationDetails');

    if (rateTerm === 'nightly') {
      // Nightly rate: just multiply rate × nights
      const moveIn = new Date(app.approved_move_in + 'T00:00:00');
      const moveOut = app.approved_lease_end ? new Date(app.approved_lease_end + 'T00:00:00') : null;
      const nights = moveOut ? Math.round((moveOut - moveIn) / (1000 * 60 * 60 * 24)) : null;
      const totalStay = nights ? app.approved_rate * nights : null;

      prorationEl.innerHTML = `
        <p>Check-in: <strong>${rentalService.formatDate(app.approved_move_in)}</strong></p>
        ${moveOut ? `<p>Check-out: <strong>${rentalService.formatDate(app.approved_lease_end)}</strong></p>` : ''}
        ${nights ? `<p>Nights: <strong>${nights}</strong></p>` : ''}
        <p>Nightly rate: ${rentalService.formatCurrency(app.approved_rate)}</p>
        ${totalStay ? `<p>Total stay cost: <strong class="highlight">${rentalService.formatCurrency(totalStay)}</strong></p>` : ''}
      `;
    } else {
      // Monthly rate: prorate for partial months
      const proration = rentalService.calculateProration(app.approved_move_in, app.approved_rate);
      const application = rentalService.calculateDepositApplication(
        app.approved_move_in, app.approved_rate, app.security_deposit_amount || 0
      );
      prorationEl.innerHTML = `
        <p>Move-in: <strong>${rentalService.formatDate(app.approved_move_in)}</strong> (day ${proration.dayOfMonth} of ${proration.daysInMonth})</p>
        <p>Days remaining: <strong>${proration.daysRemaining}</strong></p>
        <p>First month (prorated): <strong class="highlight">${rentalService.formatCurrency(proration.proratedAmount)}</strong></p>
        <p>Move-in deposit: ${rentalService.formatCurrency(application.moveInDeposit)}</p>
        ${application.towardsSecurity > 0 ? `<p>Applied to security: ${rentalService.formatCurrency(application.towardsSecurity)}</p>` : ''}
        ${application.securityRemaining > 0 ? `<p>Additional security due: <strong class="highlight">${rentalService.formatCurrency(application.securityRemaining)}</strong></p>` : ''}
      `;
    }
  } else {
    document.getElementById('prorationDetails').innerHTML = '<p class="text-muted">Set move-in date and rate to calculate proration.</p>';
  }

  // Deposit request info
  const depositRequestedInfo = document.getElementById('depositRequestedInfo');
  if (app.deposit_requested_at) {
    const moveIn = app.move_in_deposit_amount || app.approved_rate || 0;
    const sec = app.security_deposit_amount || 0;
    const dt = new Date(app.deposit_requested_at);
    const dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    depositRequestedInfo.innerHTML = `<span style="color: #666; font-size: 0.85rem;">Deposit request sent <strong>${dateStr} ${timeStr}</strong> — Move-in: $${moveIn}, Security: $${sec}, Total: $${moveIn + sec}</span>`;
  } else {
    depositRequestedInfo.innerHTML = '<span style="color: #999; font-size: 0.85rem;">Deposit request not yet sent</span>';
  }

  // ===== RENT TAB =====
  document.getElementById('rentMonthlyAmount').textContent =
    rentalService.formatCurrency(app.approved_rate);
  loadRentHistory(app.assignment_id);

  // Status tracker, action pane, and action buttons
  updateRentalStatusTracker(app);
  updateActionPane(app);
  updateRentalActions(app);

  // Re-evaluate action buttons and action pane when terms fields change
  ['termSpace', 'termRate', 'termMoveIn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.onchange = el.oninput = () => {
        updateRentalActions(app);
        updateActionPane(app);
      };
    }
  });

  // Show the detail page (hide pipeline)
  showApplicantDetailPage();
  history.replaceState(null, '', window.location.pathname + window.location.search + '#applicant=' + applicationId);

  // Stage-aware default tab (only when no explicit tab was requested)
  if (activeTab === 'applicant') {
    const stage = rentalService.getPipelineStage(app);
    if (stage === 'applications' && app.application_status === 'under_review') activeTab = 'terms';
    else if (stage === 'approved' || stage === 'contract') activeTab = 'documents';
    else if (stage === 'deposit') activeTab = 'deposits';
  }

  // Set active tab
  switchDetailTab(activeTab);

  // Scroll to top of page
  window.scrollTo(0, 0);
}

function getActiveDetailTab() {
  const active = document.querySelector('#applicantDetailPage .detail-tab.active');
  return active ? active.dataset.detailTab : 'applicant';
}

function switchDetailTab(tabName) {
  const page = document.getElementById('applicantDetailPage');
  if (!page) return;
  page.querySelectorAll('.detail-tab').forEach(t => {
    const isTarget = t.dataset.detailTab === tabName;
    t.classList.toggle('active', isTarget);
    t.setAttribute('aria-selected', String(isTarget));
    t.setAttribute('tabindex', isTarget ? '0' : '-1');
  });
  page.querySelectorAll('.detail-tab-content').forEach(c => {
    c.classList.toggle('active', c.id === tabName + 'Tab');
  });
}

// =============================================
// ACTION PANE - Wizard-like stage guidance
// =============================================

function updateActionPane(app) {
  const stage = rentalService.getPipelineStage(app);
  const pane = document.getElementById('actionPane');
  if (!pane) return;

  renderActionPaneProgress(stage);

  const guidance = document.getElementById('actionPaneGuidance');
  const actions = document.getElementById('actionPaneActions');

  switch (stage) {
    case 'community_fit':
      renderCommunityFitPane(app, guidance, actions);
      break;
    case 'applications':
      renderApplicationsPane(app, guidance, actions);
      break;
    case 'approved':
      renderApprovedPane(app, guidance, actions);
      break;
    case 'contract':
      renderContractPane(app, guidance, actions);
      break;
    case 'deposit':
      renderDepositPane(app, guidance, actions);
      break;
    case 'ready':
      renderReadyPane(app, guidance, actions);
      break;
    default:
      guidance.innerHTML = '';
      actions.innerHTML = '';
  }
}

function renderActionPaneProgress(currentStage) {
  const stages = [
    { key: 'community_fit', label: 'Community Fit' },
    { key: 'applications', label: 'Application' },
    { key: 'approved', label: 'Approved' },
    { key: 'contract', label: 'Contract' },
    { key: 'deposit', label: 'Deposit' },
    { key: 'ready', label: 'Ready' },
  ];

  const container = document.getElementById('actionPaneProgress');
  if (!container) return;
  const currentIndex = stages.findIndex(s => s.key === currentStage);

  container.innerHTML = stages.map((s, i) => {
    const state = i < currentIndex ? 'complete' : i === currentIndex ? 'active' : 'pending';
    const dot = state === 'complete' ? '&#10003;' : (i + 1);
    return `
      <div class="action-step ${state}">
        <div class="action-step-dot">${dot}</div>
        <div class="action-step-label">${s.label}</div>
      </div>
      ${i < stages.length - 1 ? `<div class="action-step-connector ${i < currentIndex ? 'complete' : ''}"></div>` : ''}
    `;
  }).join('');
}

function renderCommunityFitPane(app, guidance, actions) {
  const person = app.person || {};
  const accomm = ACCOMMODATION_LABELS[person.preferred_accommodation] || person.preferred_accommodation || 'Flexible';
  const referral = person.referral_source || 'Not specified';

  guidance.innerHTML = `
    <div class="action-pane-instruction">
      <strong>Review this person's community fit responses, then decide.</strong>
    </div>
    <div class="action-pane-context">
      Accommodation: <strong>${accomm}</strong> &middot; Referral: <strong>${referral}</strong>
    </div>
  `;

  if (app.invited_to_apply_at) {
    actions.innerHTML = `
      <span class="action-pane-waiting"><span class="waiting-dot"></span> Invited ${rentalService.formatDate(app.invited_to_apply_at)}</span>
      <button class="btn-secondary" onclick="inviteToApplyAction()">Re-send Link</button>
      <button class="btn-secondary" onclick="denyApplication()">Deny</button>
    `;
  } else {
    actions.innerHTML = `
      <button class="btn-primary action-pane-cta" onclick="inviteToApplyAction()">Invite to Apply</button>
      <button class="btn-secondary" onclick="denyApplication()">Deny</button>
    `;
  }
}

function renderApplicationsPane(app, guidance, actions) {
  if (app.application_status === 'submitted') {
    guidance.innerHTML = `
      <div class="action-pane-instruction">
        <strong>New application received.</strong> Start your review to evaluate this applicant.
      </div>
    `;
    actions.innerHTML = `
      <button class="btn-primary action-pane-cta" onclick="startReviewApplication()">Start Review</button>
      <button class="btn-secondary" onclick="denyApplication()">Deny</button>
    `;
  } else {
    // under_review — show terms checklist
    const hasSpace = !!(document.getElementById('termSpace')?.value || app.approved_space_id);
    const rateEl = document.getElementById('termRate')?.value;
    const rateVal = (rateEl !== '' && rateEl != null) ? rateEl : app.approved_rate;
    const hasRate = !!(rateVal !== '' && rateVal != null && parseFloat(rateVal) >= 0);
    const hasMoveIn = !!(document.getElementById('termMoveIn')?.value || app.approved_move_in);
    const allFilled = hasSpace && hasRate && hasMoveIn;

    const spaceName = app.approved_space?.name || app.desired_space?.name || '';
    const rateDisplay = hasRate ? rentalService.formatCurrency(parseFloat(rateVal)) + '/' + (app.approved_rate_term || 'mo') : '';
    const moveInDisplay = hasMoveIn ? rentalService.formatDate(document.getElementById('termMoveIn')?.value || app.approved_move_in) : '';

    guidance.innerHTML = `
      <div class="action-pane-instruction">
        <strong>Set the rental terms, then approve.</strong>
      </div>
      <div class="action-pane-checklist">
        <div class="checklist-row ${hasSpace ? 'done' : 'missing'}">
          ${hasSpace ? '&#10003;' : '&#9675;'} Space assigned${hasSpace && spaceName ? `<span class="checklist-value">${spaceName}</span>` : ''}
        </div>
        <div class="checklist-row ${hasRate ? 'done' : 'missing'}">
          ${hasRate ? '&#10003;' : '&#9675;'} Rate set${hasRate ? `<span class="checklist-value">${rateDisplay}</span>` : ''}
        </div>
        <div class="checklist-row ${hasMoveIn ? 'done' : 'missing'}">
          ${hasMoveIn ? '&#10003;' : '&#9675;'} Move-in date${hasMoveIn ? `<span class="checklist-value">${moveInDisplay}</span>` : ''}
        </div>
      </div>
      ${!allFilled ? '<div class="action-pane-hint">Fill in the Terms tab below to continue.</div>' : ''}
    `;

    actions.innerHTML = allFilled
      ? `<button class="btn-primary action-pane-cta" onclick="approveApplication()">Approve Application</button>
         <button class="btn-secondary" onclick="denyApplication()">Deny</button>`
      : `<button class="btn-primary action-pane-cta" disabled>Approve Application</button>
         <button class="btn-secondary" onclick="switchDetailTab('terms')">Go to Terms</button>
         <button class="btn-secondary" onclick="denyApplication()">Deny</button>`;
  }
}

function renderApprovedPane(app, guidance, actions) {
  const spaceName = app.approved_space?.name || 'Not set';
  const rate = app.approved_rate != null ? rentalService.formatCurrency(app.approved_rate) + '/' + (app.approved_rate_term || 'mo') : 'Not set';
  const moveIn = app.approved_move_in ? rentalService.formatDate(app.approved_move_in) : 'Not set';
  const requireLease = app.require_lease !== false;

  if (requireLease) {
    guidance.innerHTML = `
      <div class="action-pane-instruction">
        <strong>Generate the rental agreement for signing.</strong>
      </div>
      <div class="action-pane-context">
        Space: <strong>${spaceName}</strong> &middot; Rate: <strong>${rate}</strong> &middot; Move-in: <strong>${moveIn}</strong>
      </div>
    `;
    actions.innerHTML = `
      <button class="btn-primary action-pane-cta" onclick="generateAgreement()">Generate Agreement</button>
      <button class="btn-secondary" onclick="switchDetailTab('terms')">Edit Terms</button>
    `;
  } else {
    guidance.innerHTML = `
      <div class="action-pane-instruction">
        <strong>Lease not required. Request deposits to continue.</strong>
      </div>
      <div class="action-pane-context">
        Space: <strong>${spaceName}</strong> &middot; Rate: <strong>${rate}</strong> &middot; Move-in: <strong>${moveIn}</strong>
      </div>
    `;
    actions.innerHTML = `
      <button class="btn-primary action-pane-cta" onclick="switchDetailTab('deposits')">Request Deposits</button>
      <button class="btn-secondary" onclick="switchDetailTab('terms')">Edit Terms</button>
    `;
  }
}

function renderContractPane(app, guidance, actions) {
  const agStatus = app.agreement_status || 'pending';

  if (agStatus === 'generated') {
    guidance.innerHTML = `
      <div class="action-pane-instruction">
        <strong>The agreement PDF is ready.</strong> Send it for e-signature.
      </div>
    `;
    actions.innerHTML = `
      <button class="btn-primary action-pane-cta" onclick="sendForSignatureAction()">Send for Signature</button>
    `;
  } else if (agStatus === 'sent') {
    const sentDate = app.agreement_sent_at ? rentalService.formatDate(app.agreement_sent_at) : '';
    guidance.innerHTML = `
      <div class="action-pane-instruction">
        <strong>Waiting for the applicant to sign.</strong>
      </div>
      ${sentDate ? `<div class="action-pane-context">Sent on <strong>${sentDate}</strong></div>` : ''}
    `;
    actions.innerHTML = `
      <span class="action-pane-waiting"><span class="waiting-dot"></span> Awaiting signature</span>
      <button class="btn-secondary" onclick="checkSignatureStatusAction()">Check Status</button>
      <button class="btn-secondary" onclick="resendSignatureAction()">Resend Request</button>
    `;
  } else if (agStatus === 'signed') {
    const signedDate = app.agreement_signed_at ? rentalService.formatDate(app.agreement_signed_at) : '';
    guidance.innerHTML = `
      <div class="action-pane-instruction">
        <strong>Agreement signed!</strong> Collect deposits to continue.
      </div>
      ${signedDate ? `<div class="action-pane-context">Signed on <strong>${signedDate}</strong></div>` : ''}
    `;
    actions.innerHTML = `
      <button class="btn-secondary" onclick="switchDetailTab('deposits')">View Deposits</button>
    `;
  }
}

function renderDepositPane(app, guidance, actions) {
  const moveInAmt = app.move_in_deposit_amount || app.approved_rate || 0;
  const secAmt = app.security_deposit_amount || 0;
  const moveInPaid = !!app.move_in_deposit_paid;
  const secPaid = !!app.security_deposit_paid;
  const depStatus = app.deposit_status || 'pending';

  const checklist = [];
  checklist.push(`
    <div class="checklist-row ${moveInPaid ? 'done' : 'missing'}">
      ${moveInPaid ? '&#10003;' : '&#9675;'} Move-in deposit<span class="checklist-value">${rentalService.formatCurrency(moveInAmt)}</span>
    </div>
  `);
  if (secAmt > 0) {
    checklist.push(`
      <div class="checklist-row ${secPaid ? 'done' : 'missing'}">
        ${secPaid ? '&#10003;' : '&#9675;'} Security deposit<span class="checklist-value">${rentalService.formatCurrency(secAmt)}</span>
      </div>
    `);
  }

  const allReceived = moveInPaid && (secAmt === 0 || secPaid);

  guidance.innerHTML = `
    <div class="action-pane-instruction">
      <strong>${allReceived ? 'All deposits received.' : 'Collect deposits before move-in.'}</strong>
      ${allReceived ? ' Confirm to proceed.' : ''}
    </div>
    <div class="action-pane-checklist">
      ${checklist.join('')}
    </div>
  `;

  if (allReceived || depStatus === 'received') {
    actions.innerHTML = `
      <button class="btn-primary action-pane-cta" onclick="confirmDeposit()">Confirm Deposit</button>
    `;
  } else {
    actions.innerHTML = `
      <button class="btn-primary action-pane-cta" onclick="switchDetailTab('deposits')">Record Payment</button>
      ${!app.deposit_requested_at ? '<button class="btn-secondary" onclick="switchDetailTab(\'deposits\')">Send Deposit Request</button>' : ''}
    `;
  }
}

function renderReadyPane(app, guidance, actions) {
  const spaceName = app.approved_space?.name || '';
  const moveIn = app.approved_move_in ? rentalService.formatDate(app.approved_move_in) : '';
  const agSigned = app.agreement_status === 'signed';
  const leaseNotRequired = app.require_lease === false;
  const depConfirmed = app.deposit_status === 'confirmed';

  const agreementRow = leaseNotRequired
    ? '<div class="checklist-row done">&#10003; Lease not required (VIP/comp)</div>'
    : '<div class="checklist-row done">&#10003; Agreement signed</div>';

  guidance.innerHTML = `
    <div class="action-pane-instruction">
      <strong>Everything's in order. Confirm move-in to create the assignment.</strong>
    </div>
    <div class="action-pane-checklist">
      ${agreementRow}
      <div class="checklist-row done">&#10003; Deposits confirmed</div>
      ${spaceName ? `<div class="checklist-row done">&#10003; Space: <span class="checklist-value">${spaceName}</span></div>` : ''}
      ${moveIn ? `<div class="checklist-row done">&#10003; Move-in: <span class="checklist-value">${moveIn}</span></div>` : ''}
    </div>
  `;

  if (agSigned || leaseNotRequired) {
    actions.innerHTML = `
      <button class="btn-primary action-pane-cta" onclick="confirmMoveIn()">Confirm Move-in</button>
    `;
  } else {
    actions.innerHTML = `
      <button class="btn-primary action-pane-cta" disabled title="Agreement must be signed first">Confirm Move-in</button>
      <button class="btn-secondary" onclick="switchDetailTab('documents')">View Agreement</button>
    `;
  }
}

function updateRentalStatusTracker(app) {
  // Terms step
  const termsStep = document.getElementById('detailTrackerTerms');
  const termsDetail = document.getElementById('detailTrackerTermsDetail');
  if (!termsStep) return;
  const hasTerms = app.approved_space_id && app.approved_rate && app.approved_move_in;
  termsStep.className = 'tracker-step ' + (hasTerms ? 'complete' : (app.application_status === 'approved' || app.application_status === 'under_review' ? 'active' : 'pending'));
  termsDetail.textContent = hasTerms ? 'Filled' : 'Incomplete';

  // Agreement step
  const agreementStep = document.getElementById('detailTrackerAgreement');
  const agreementDetail = document.getElementById('detailTrackerAgreementDetail');
  const agStatus = app.agreement_status || 'pending';
  if (app.require_lease === false) {
    agreementStep.className = 'tracker-step complete';
    agreementDetail.textContent = 'Not required (VIP)';
  } else {
    const agLabels = { pending: 'Not started', generated: 'PDF generated', sent: 'Sent for signature', signed: 'Signed ✓' };
    agreementStep.className = 'tracker-step ' + (agStatus === 'signed' ? 'complete' : (agStatus !== 'pending' ? 'active' : 'pending'));
    agreementDetail.textContent = agLabels[agStatus] || agStatus;
  }

  // Deposit step — calculate total due for display
  const depositStep = document.getElementById('detailTrackerDeposit');
  const depositDetail = document.getElementById('detailTrackerDepositDetail');
  const depStatus = app.deposit_status || 'pending';
  const moveInAmt = app.move_in_deposit_amount || app.approved_rate || 0;
  const secAmt = app.security_deposit_amount || 0;
  const appFeeCredit = (app.application_fee_paid && app.application_fee_amount > 0) ? app.application_fee_amount : 0;
  const totalDueForTracker = Math.max(0, (moveInAmt + secAmt) - appFeeCredit);
  const amountStr = totalDueForTracker > 0 ? ` — ${rentalService.formatCurrency(totalDueForTracker)} due` : '';
  const depLabels = {
    pending: `Not started${amountStr}`,
    requested: `Requested${amountStr}`,
    partial: `Partial${amountStr}`,
    received: 'Received',
    confirmed: 'Confirmed ✓',
  };
  depositStep.className = 'tracker-step ' + (depStatus === 'confirmed' ? 'complete' : (depStatus !== 'pending' ? 'active' : 'pending'));
  depositDetail.textContent = depLabels[depStatus] || depStatus;

  // Move-in step
  const moveInStep = document.getElementById('detailTrackerMoveIn');
  const moveInDetail = document.getElementById('detailTrackerMoveInDetail');
  if (app.move_in_confirmed_at) {
    moveInStep.className = 'tracker-step complete';
    moveInDetail.textContent = 'Confirmed ✓';
  } else if (depStatus === 'confirmed' && (agStatus === 'signed' || app.require_lease === false)) {
    moveInStep.className = 'tracker-step active';
    moveInDetail.textContent = 'Ready';
  } else {
    moveInStep.className = 'tracker-step pending';
    const blockers = [];
    if (app.require_lease !== false && agStatus !== 'signed') blockers.push('agreement');
    if (depStatus !== 'confirmed') {
      blockers.push(totalDueForTracker > 0
        ? `${rentalService.formatCurrency(totalDueForTracker)} deposit`
        : 'deposit');
    }
    moveInDetail.textContent = blockers.length ? 'Needs ' + blockers.join(' & ') : '—';
  }

  // Update tab badges
  const page = document.getElementById('applicantDetailPage');
  const docsTab = page?.querySelector('.detail-tab[data-detail-tab="documents"]');
  const depsTab = page?.querySelector('.detail-tab[data-detail-tab="deposits"]');
  if (docsTab) {
    if (agStatus === 'signed') {
      docsTab.innerHTML = 'Documents <span class="tab-badge complete">✓</span>';
    } else if (agStatus === 'sent') {
      docsTab.innerHTML = 'Documents <span class="tab-badge active">⏳</span>';
    } else if (agStatus === 'generated') {
      docsTab.innerHTML = 'Documents <span class="tab-badge warning">!</span>';
    } else {
      docsTab.innerHTML = 'Documents';
    }
  }
  if (depsTab) {
    if (depStatus === 'confirmed') {
      depsTab.innerHTML = 'Deposits <span class="tab-badge complete">✓</span>';
    } else if (depStatus !== 'pending') {
      depsTab.innerHTML = 'Deposits <span class="tab-badge active">⏳</span>';
    } else {
      depsTab.innerHTML = 'Deposits';
    }
  }
}

function rentalTermsFilled() {
  const spaceId = document.getElementById('termSpace')?.value;
  const rate = document.getElementById('termRate')?.value;
  const moveIn = document.getElementById('termMoveIn')?.value;
  return !!(spaceId && rate !== '' && parseFloat(rate) >= 0 && moveIn);
}

function updateRentalActions(app) {
  const container = document.getElementById('rentalActions');
  if (!container) return;

  let buttons = [];
  const stage = rentalService.getPipelineStage(app);

  switch (stage) {
    case 'community_fit':
      if (app.invited_to_apply_at) {
        buttons.push('<span class="tracker-inline-status" style="font-size: 0.75rem;">Invited ' + rentalService.formatDate(app.invited_to_apply_at) + '</span>');
        buttons.push('<button class="btn-secondary" onclick="inviteToApplyAction()">Re-send Link</button>');
      } else {
        buttons.push('<button class="btn-primary" onclick="inviteToApplyAction()">Invite to Apply</button>');
      }
      buttons.push('<button class="btn-secondary" onclick="denyApplication()">Deny</button>');
      break;

    case 'applications':
      if (app.application_status === 'submitted') {
        buttons.push('<button class="btn-primary" onclick="startReviewApplication()">Start Review</button>');
      }
      buttons.push('<button class="btn-secondary" onclick="denyApplication()">Deny</button>');
      break;

    case 'approved':
      buttons.push('<button class="btn-primary" onclick="generateAgreement()">Generate Rental Agreement</button>');
      buttons.push('<button class="btn-secondary" onclick="editTerms()">Edit Terms</button>');
      break;

    case 'contract':
      if (app.agreement_status === 'generated') {
        buttons.push('<button class="btn-primary" onclick="sendForSignatureAction()">Send for Signature</button>');
      } else if (app.agreement_status === 'sent') {
        buttons.push('<button class="btn-primary" onclick="resendSignatureAction()">Resend Signing Request</button>');
        buttons.push('<button class="btn-secondary" onclick="checkSignatureStatusAction()">Check Status</button>');
      } else if (app.agreement_status === 'signed') {
        buttons.push('<span class="tracker-inline-status complete">✓ Agreement Signed</span>');
      }
      break;

    case 'deposit':
      if (app.deposit_status !== 'confirmed') {
        buttons.push('<button class="btn-primary" onclick="confirmDeposit()">Confirm Deposit</button>');
      }
      break;

    case 'ready':
      if (app.require_lease === false || app.agreement_status === 'signed') {
        buttons.push('<button class="btn-primary" onclick="confirmMoveIn()">Confirm Move-in</button>');
      } else {
        buttons.push('<button class="btn-secondary" onclick="switchDetailTab(\'documents\')"><span style="color:var(--danger-color);">&#9679;</span> Agreement not signed</button>');
        buttons.push('<button class="btn-primary" disabled title="Agreement must be signed first" style="opacity:0.5;cursor:not-allowed;">Confirm Move-in</button>');
      }
      break;
  }

  // Add approve button if under review
  if (app.application_status === 'under_review') {
    const termsFilled = rentalTermsFilled();
    if (termsFilled) {
      buttons.unshift('<button class="btn-primary" onclick="approveApplication()">Approve</button>');
    } else {
      buttons.unshift('<button class="btn-primary" disabled title="Fill in required terms first" style="opacity:0.5;cursor:not-allowed;">Approve</button>');
      buttons.unshift('<button class="btn-secondary" onclick="switchDetailTab(\'terms\')"><span style="color:var(--danger-color);">&#9679;</span> Fill Details</button>');
    }
  }

  // Add test toggle and archive buttons (always available)
  const testLabel = app.is_test ? 'Remove Test Flag' : 'Mark as Test';
  buttons.push(`<button class="btn-secondary btn-small" onclick="toggleTestFlag()" style="margin-left: auto;">${testLabel}</button>`);
  buttons.push('<button class="btn-danger btn-small" onclick="archiveApplication()">Archive</button>');

  container.innerHTML = buttons.join('');
}

function closeRentalDetail() {
  hideApplicantDetailPage();
}

// =============================================
// RENTAL ACTIONS
// =============================================

/**
 * Disable all action pane buttons and footer buttons during async operations.
 * Returns a restore function to re-enable them (or pass a label to show on the clicked CTA).
 */
function setActionPaneLoading(loadingLabel) {
  const actionPane = document.getElementById('actionPaneActions');
  const footer = document.getElementById('rentalActions');
  const allBtns = [
    ...(actionPane ? actionPane.querySelectorAll('button') : []),
    ...(footer ? footer.querySelectorAll('button') : []),
  ];
  const originals = allBtns.map(b => ({ el: b, text: b.textContent, disabled: b.disabled }));

  allBtns.forEach(b => {
    b.disabled = true;
    b.style.opacity = '0.6';
    b.style.cursor = 'wait';
  });

  // If a loading label was provided, set it on the primary CTA
  if (loadingLabel && actionPane) {
    const cta = actionPane.querySelector('.action-pane-cta') || actionPane.querySelector('.btn-primary');
    if (cta) cta.textContent = loadingLabel;
  }

  return function restore() {
    originals.forEach(({ el, text, disabled }) => {
      el.disabled = disabled;
      el.textContent = text;
      el.style.opacity = '';
      el.style.cursor = '';
    });
  };
}

window.openRentalDetail = openRentalDetail;

window.inviteToApplyAction = async function() {
  if (!currentApplicationId) return;
  const restore = setActionPaneLoading('Inviting...');
  try {
    const result = await rentalService.inviteToApply(currentApplicationId);
    // Send invite email
    const app = allApplications.find(a => a.id === currentApplicationId);
    if (app) {
      await emailService.sendInviteToApply(app, result.continueUrl);
    }
    await navigator.clipboard.writeText(result.continueUrl);
    showToast('Invitation email sent and link copied to clipboard!', 'success');
    await loadApplications();
    openRentalDetail(currentApplicationId, getActiveDetailTab());
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
    restore();
  }
};

window.archiveApplication = async function() {
  if (!currentApplicationId) return;
  if (!confirm('Archive this application? It will be hidden from the pipeline.')) return;
  const restore = setActionPaneLoading('Archiving...');
  try {
    await rentalService.archiveApplication(currentApplicationId);
    closeRentalDetail();
    await loadApplications();
    showToast('Application archived', 'success');
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
    restore();
  }
};

window.toggleTestFlag = async function() {
  if (!currentApplicationId) return;
  try {
    const app = allApplications.find(a => a.id === currentApplicationId);
    const newTestValue = !app?.is_test;
    await rentalService.toggleTestFlag(currentApplicationId, newTestValue);
    await loadApplications();
    openRentalDetail(currentApplicationId, getActiveDetailTab());
    showToast(newTestValue ? 'Marked as test' : 'Unmarked as test', 'success');
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
};

window.startReviewApplication = async function() {
  if (!currentApplicationId) return;
  const restore = setActionPaneLoading('Starting Review...');
  try {
    await rentalService.startReview(currentApplicationId);
    await loadApplications();
    openRentalDetail(currentApplicationId, getActiveDetailTab());
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
    restore();
  }
};

window.approveApplication = async function() {
  if (!currentApplicationId) return;

  const spaceId = document.getElementById('termSpace').value;
  const rate = parseFloat(document.getElementById('termRate').value);
  const rateTerm = document.getElementById('termRateTerm').value;
  const moveInDate = document.getElementById('termMoveIn').value;
  const leaseEndDate = document.getElementById('termLeaseEnd').value || null;
  const noticePeriod = document.getElementById('termNoticePeriod').value;
  const securityDeposit = parseFloat(document.getElementById('termSecurityDeposit').value) || 0;
  const additionalTerms = document.getElementById('termAdditionalTerms').value.trim() || null;

  if (!spaceId || (isNaN(rate) || rate < 0) || !moveInDate) {
    showToast('Please fill in Space, Rate, and Move-in Date on the Terms tab', 'warning');
    switchDetailTab('terms');
    return;
  }

  const restore = setActionPaneLoading('Approving...');
  try {
    await rentalService.approveApplication(currentApplicationId, {
      spaceId,
      rate,
      rateTerm,
      moveInDate,
      leaseEndDate,
      noticePeriod,
      securityDepositAmount: securityDeposit,
      additionalTerms,
    });
    await loadApplications();

    // Send approval email
    const app = allApplications.find(a => a.id === currentApplicationId);
    if (app?.person?.email) {
      const space = allSpaces.find(s => s.id === spaceId);
      // Get space photo for email
      const spacePhoto = space?.media_spaces
        ?.sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99))
        ?.[0]?.media?.url || null;
      const requireLease = document.getElementById('termRequireLease')?.checked !== false;
      const emailResult = await emailService.sendApplicationApproved({
        person: app.person,
        space: { name: space?.name },
        approved_rate: rate,
        approved_move_in_date: moveInDate,
        approved_end_date: leaseEndDate,
        require_lease: requireLease,
        security_deposit_amount: securityDeposit,
        space_image_url: spacePhoto,
      });
      if (emailResult.success) {
        showToast('Application approved & email sent', 'success');
      } else {
        showToast('Application approved (email failed to send)', 'warning');
      }
    } else {
      showToast('Application approved (no email on file)', 'success');
    }

    openRentalDetail(currentApplicationId, getActiveDetailTab());
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
    restore();
  }
};

window.denyApplication = async function() {
  if (!currentApplicationId) return;
  const app = allApplications.find(a => a.id === currentApplicationId);
  const reason = prompt('Reason for denial (optional):');
  if (reason === null) return; // user cancelled prompt
  const restore = setActionPaneLoading('Denying...');
  try {
    await rentalService.denyApplication(currentApplicationId, reason);
    await loadApplications();

    // Send denial email
    if (app?.person?.email) {
      const emailResult = await emailService.sendApplicationDenied(app, reason);
      if (emailResult.success) {
        showToast('Application denied & email sent', 'success');
      } else {
        showToast('Application denied (email failed to send)', 'warning');
      }
    } else {
      showToast('Application denied (no email on file)', 'success');
    }

    closeRentalDetail();
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
    restore();
  }
};

window.generateAgreement = async function() {
  const restore = setActionPaneLoading('Generating...');
  try {
    await generateLeasePdf();
    switchDetailTab('documents');
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
    restore();
  }
};

window.editTerms = function() {
  switchDetailTab('terms');
};

// Save terms without changing status
window.saveTerms = async function() {
  if (!currentApplicationId) return;

  const statusEl = document.getElementById('termsSaveStatus');
  const saveBtn = document.getElementById('saveTermsBtn');

  try {
    statusEl.textContent = 'Saving...';
    statusEl.className = 'save-status saving';
    saveBtn.disabled = true;

    const terms = getTermsFormData();
    await rentalService.saveTerms(currentApplicationId, terms);

    statusEl.textContent = 'Saved';
    statusEl.className = 'save-status saved';

    // Clear the "Saved" message after 3 seconds
    setTimeout(() => {
      if (statusEl.textContent === 'Saved') {
        statusEl.textContent = '';
      }
    }, 3000);

  } catch (error) {
    statusEl.textContent = 'Error saving';
    statusEl.className = 'save-status error';
    console.error('Error saving terms:', error);
  } finally {
    saveBtn.disabled = false;
  }
};

// Helper to collect form data
function getTermsFormData() {
  return {
    spaceId: document.getElementById('termSpace').value || null,
    rate: document.getElementById('termRate').value !== '' ? parseFloat(document.getElementById('termRate').value) : null,
    rateTerm: document.getElementById('termRateTerm').value || 'monthly',
    moveInDate: document.getElementById('termMoveIn').value || null,
    leaseEndDate: document.getElementById('termLeaseEnd').value || null,
    noticePeriod: document.getElementById('termNoticePeriod').value || '30_days',
    securityDepositAmount: parseFloat(document.getElementById('termSecurityDeposit').value) || 0,
    reservationDepositAmount: parseFloat(document.getElementById('termReservationDeposit').value) || 0,
    additionalTerms: document.getElementById('termAdditionalTerms').value.trim() || null,
    requireLease: document.getElementById('termRequireLease').checked,
    checkInTime: document.getElementById('termCheckInTime').value || null,
    checkOutTime: document.getElementById('termCheckOutTime').value || null,
  };
}

// Debounced auto-save for terms
function scheduleTermsAutoSave() {
  if (!currentApplicationId) return;

  const statusEl = document.getElementById('termsSaveStatus');
  statusEl.textContent = 'Unsaved changes...';
  statusEl.className = 'save-status';

  clearTimeout(termsAutoSaveTimeout);
  termsAutoSaveTimeout = setTimeout(() => {
    saveTerms();
  }, 1500); // Auto-save after 1.5 seconds of inactivity
}

// Setup terms form event listeners for auto-save
function setupTermsAutoSave() {
  const formFields = [
    'termSpace', 'termRate', 'termRateTerm', 'termMoveIn',
    'termLeaseEnd', 'termNoticePeriod', 'termSecurityDeposit', 'termReservationDeposit', 'termAdditionalTerms',
    'termCheckInTime', 'termCheckOutTime', 'termRequireLease'
  ];

  formFields.forEach(fieldId => {
    const el = document.getElementById(fieldId);
    if (el) {
      el.addEventListener('change', scheduleTermsAutoSave);
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.addEventListener('input', scheduleTermsAutoSave);
      }
    }
  });

  // Save button click
  document.getElementById('saveTermsBtn')?.addEventListener('click', () => {
    clearTimeout(termsAutoSaveTimeout);
    saveTerms();
  });
}

window.markAgreementSent = async function() {
  if (!currentApplicationId) return;
  try {
    await rentalService.updateAgreementStatus(currentApplicationId, 'sent');
    await loadApplications();
    openRentalDetail(currentApplicationId, getActiveDetailTab());
    showToast('Agreement marked as sent', 'success');
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
};

window.markAgreementSigned = async function() {
  if (!currentApplicationId) return;
  try {
    await rentalService.updateAgreementStatus(currentApplicationId, 'signed');
    await loadApplications();

    // Send lease signed email
    const app = allApplications.find(a => a.id === currentApplicationId);
    if (app?.person?.email) {
      const emailResult = await emailService.sendLeaseSigned(app);
      if (emailResult.success) {
        showToast('Agreement marked as signed & email sent', 'success');
      } else {
        showToast('Agreement marked as signed (email failed to send)', 'warning');
      }
    } else {
      showToast('Agreement marked as signed', 'success');
    }

    openRentalDetail(currentApplicationId, getActiveDetailTab());
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
};

window.sendForSignatureAction = async function() {
  const restore = setActionPaneLoading('Sending...');
  switchDetailTab('documents');
  setTimeout(() => {
    const btn = document.getElementById('sendForSignatureBtn');
    if (btn && !btn.disabled) {
      btn.click();
    } else {
      restore();
    }
  }, 100);
};

/**
 * Re-create SignWell document when old one no longer exists (404).
 * If no PDF exists, auto-generates one from the template first.
 * Creates a new document, updates the DB, and refreshes the UI.
 */
async function recreateSignwellDocument(app) {
  if (!app.person?.email) {
    showToast('Applicant has no email address on file', 'error');
    return false;
  }

  let pdfUrl = app.agreement_document_url;

  // If no PDF URL, regenerate from template
  let pageCount = currentLeasePageCount || app.lease_page_count;
  if (!pdfUrl) {
    showToast('Regenerating lease PDF...', 'info');
    const template = await leaseTemplateService.getActiveTemplate();
    const agreementData = await rentalService.getAgreementData(app.id);
    if (!template || !agreementData) {
      showToast('Cannot regenerate PDF — no template or terms data. Fill in Terms first.', 'error');
      return false;
    }
    const parsedContent = leaseTemplateService.parseTemplate(template.content, agreementData);
    const result = await pdfService.generateAndUploadLeasePdf(
      parsedContent, app.id, { tenantName: agreementData.tenantName }
    );
    await rentalService.updateAgreementStatus(app.id, 'generated', result.url);
    pdfUrl = result.url;
    pageCount = result.pageCount;
    currentLeasePageCount = pageCount;
    currentSignaturePositions = result.signaturePositions || null;
  }

  showToast('Creating new signature request...', 'info');
  const recipientName = `${app.person.first_name} ${app.person.last_name}`;
  await signwellService.sendForSignature(app.id, pdfUrl, app.person.email, recipientName, pageCount, {
    signaturePositions: currentSignaturePositions,
  });
  await loadApplications();
  openRentalDetail(currentApplicationId, getActiveDetailTab());
  showToast('New signature request sent to tenant', 'success');
  return true;
}

window.resendSignatureAction = async function() {
  if (!currentApplicationId) return;
  const app = allApplications.find(a => a.id === currentApplicationId);
  if (!app?.signwell_document_id) {
    showToast('No SignWell document found — use Manual Document Entry to update status', 'error');
    return;
  }
  const btn = document.querySelector('[onclick="resendSignatureAction()"]');
  if (btn) { btn.textContent = 'Sending...'; btn.disabled = true; }
  try {
    await signwellService.sendReminder(app.signwell_document_id);
    showToast('Signing reminder sent to tenant', 'success');
    if (btn) { btn.textContent = 'Sent ✓'; setTimeout(() => { btn.textContent = 'Resend Request'; btn.disabled = false; }, 3000); }
  } catch (error) {
    if (error.status === 404) {
      try {
        await recreateSignwellDocument(app);
      } catch (e) {
        showToast('Error re-creating document: ' + e.message, 'error');
        if (btn) { btn.textContent = 'Resend Request'; btn.disabled = false; }
      }
    } else {
      showToast('Error: ' + error.message, 'error');
      if (btn) { btn.textContent = 'Resend Request'; btn.disabled = false; }
    }
  }
};

window.checkSignatureStatusAction = async function() {
  if (!currentApplicationId) return;
  const app = allApplications.find(a => a.id === currentApplicationId);
  if (!app?.signwell_document_id) {
    showToast('No SignWell document found', 'error');
    return;
  }
  const btn = document.querySelector('[onclick="checkSignatureStatusAction()"]');
  if (btn) { btn.textContent = 'Checking...'; btn.disabled = true; }
  try {
    const status = await signwellService.getDocumentStatus(app.signwell_document_id);
    const recipientStatus = status.recipients?.[0]?.status || 'unknown';
    if (status.completed && !app.signed_pdf_url) {
      showToast('Document is signed! Refreshing...', 'success');
      await rentalService.updateAgreementStatus(currentApplicationId, 'signed');
      await loadApplications();
      openRentalDetail(currentApplicationId, getActiveDetailTab());
    } else {
      showToast(`SignWell status: ${recipientStatus}`, 'info');
    }
  } catch (error) {
    console.error('Error checking status:', error);
    if (error.status === 404) {
      try {
        await recreateSignwellDocument(app);
      } catch (e) {
        showToast('Error re-creating document: ' + e.message, 'error');
      }
    } else {
      showToast('Error: ' + error.message, 'error');
    }
  } finally {
    if (btn) { btn.textContent = 'Check Status'; btn.disabled = false; }
  }
};

window.confirmDeposit = async function() {
  if (!currentApplicationId) return;
  // Prevent double-click — find and disable the clicked button
  const btns = document.querySelectorAll('[onclick="confirmDeposit()"]');
  btns.forEach(b => { b.disabled = true; b.textContent = 'Confirming...'; });
  try {
    await rentalService.confirmDeposit(currentApplicationId);
    await loadApplications();

    // Send deposits confirmed email
    const app = allApplications.find(a => a.id === currentApplicationId);
    if (app?.person?.email) {
      const emailResult = await emailService.sendDepositsConfirmed(app);
      if (emailResult.success) {
        showToast('Deposit confirmed & email sent', 'success');
      } else {
        showToast('Deposit confirmed (email failed to send)', 'warning');
      }
    } else {
      showToast('Deposit confirmed (no email on file)', 'success');
    }

    openRentalDetail(currentApplicationId, getActiveDetailTab());
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
    btns.forEach(b => { b.disabled = false; b.textContent = 'Confirm Deposit'; });
  }
};

window.confirmMoveIn = async function() {
  if (!currentApplicationId) return;
  if (!confirm('Confirm move-in? This will create an active assignment.')) return;
  const app = allApplications.find(a => a.id === currentApplicationId);
  const restore = setActionPaneLoading('Confirming...');
  try {
    await rentalService.confirmMoveIn(currentApplicationId);
    await loadApplications();

    // Send move-in confirmed email
    if (app?.person?.email) {
      const space = allSpaces.find(s => s.id === app.approved_space_id);
      const emailResult = await emailService.sendMoveInConfirmed({
        person: app.person,
        space: { name: space?.name },
        approved_move_in_date: app.approved_move_in,
        approved_lease_end: app.approved_lease_end,
        approved_rate: app.approved_rate,
        check_in_time: app.check_in_time,
        check_out_time: app.check_out_time,
      });
      if (emailResult.success) {
        showToast('Move-in confirmed & welcome email sent', 'success');
      } else {
        showToast('Move-in confirmed (email failed to send)', 'warning');
      }
    } else {
      showToast('Move-in confirmed! Assignment created.', 'success');
    }

    closeRentalDetail();
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
    restore();
  }
};

// =============================================
// CREATE APPLICATION
// =============================================

async function handleCreateApplication(e) {
  e.preventDefault();
  const firstName = document.getElementById('newAppFirstName').value.trim();
  const lastName = document.getElementById('newAppLastName').value.trim();
  const email = document.getElementById('newAppEmail').value.trim();
  const spaceId = document.getElementById('newAppSpaceId').value || null;

  if (!firstName || !email) {
    showToast('First name and email are required', 'warning');
    return;
  }

  try {
    // Check if person already exists by email
    let personId;
    const existing = allPeople.find(p => p.email && p.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      personId = existing.id;
    } else {
      // Create new person
      const { data: newPerson, error: personError } = await supabase
        .from('people')
        .insert({ first_name: firstName, last_name: lastName || null, email, type: 'prospect' })
        .select('id')
        .single();
      if (personError) throw personError;
      personId = newPerson.id;
      // Refresh people list so future lookups find them
      await loadPeople();
    }

    await rentalService.createApplication(personId, {
      desired_space_id: spaceId,
    });
    await loadApplications();
    document.getElementById('newAppFirstName').value = '';
    document.getElementById('newAppLastName').value = '';
    document.getElementById('newAppEmail').value = '';
    document.getElementById('newAppSpaceId').value = '';
    showToast('Application created', 'success');
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

// =============================================
// PAYMENT METHODS
// =============================================

window.openPaymentMethodModal = function(methodId = null) {
  const modal = document.getElementById('paymentMethodModal');
  const title = document.getElementById('paymentMethodModalTitle');
  const deleteBtn = document.getElementById('deletePaymentMethodBtn');

  if (methodId) {
    const method = allPaymentMethods.find(m => m.id === methodId);
    if (!method) return;

    title.textContent = 'Edit Payment Method';
    document.getElementById('paymentMethodId').value = method.id;
    document.getElementById('paymentMethodName').value = method.name || '';
    document.getElementById('paymentMethodType').value = method.method_type || 'venmo';
    document.getElementById('paymentMethodIdentifier').value = method.account_identifier || '';
    document.getElementById('paymentMethodInstructions').value = method.instructions || '';
    document.getElementById('paymentMethodActive').checked = method.is_active !== false;
    deleteBtn.style.display = 'block';
  } else {
    title.textContent = 'Add Payment Method';
    document.getElementById('paymentMethodForm').reset();
    document.getElementById('paymentMethodId').value = '';
    document.getElementById('paymentMethodActive').checked = true;
    deleteBtn.style.display = 'none';
  }

  modal.classList.remove('hidden');
};

async function savePaymentMethod() {
  const id = document.getElementById('paymentMethodId').value || null;
  const data = {
    id,
    name: document.getElementById('paymentMethodName').value.trim(),
    method_type: document.getElementById('paymentMethodType').value,
    account_identifier: document.getElementById('paymentMethodIdentifier').value.trim() || null,
    instructions: document.getElementById('paymentMethodInstructions').value.trim() || null,
    is_active: document.getElementById('paymentMethodActive').checked,
  };

  if (!data.name) {
    showToast('Name is required', 'warning');
    return;
  }

  try {
    await rentalService.savePaymentMethod(data);
    await loadPaymentMethods();
    closePaymentMethodModal();
    showToast('Payment method saved', 'success');
  } catch (error) {
    console.error('Error saving payment method:', error);
    showToast('Error: ' + error.message, 'error');
  }
}

async function deletePaymentMethod() {
  const id = document.getElementById('paymentMethodId').value;
  if (!id) return;
  if (!confirm('Delete this payment method?')) return;

  try {
    await rentalService.deletePaymentMethod(id);
    await loadPaymentMethods();
    closePaymentMethodModal();
    showToast('Payment method deleted', 'success');
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

function closePaymentMethodModal() {
  document.getElementById('paymentMethodModal').classList.add('hidden');
}

// =============================================
// DEPOSIT RECORDING
// =============================================

window.openRecordDepositModal = function(type) {
  const app = allApplications.find(a => a.id === currentApplicationId);
  if (!app) return;

  const amount = type === 'move_in' ? app.move_in_deposit_amount : app.security_deposit_amount;
  const method = type === 'move_in' ? app.move_in_deposit_method : app.security_deposit_method;
  const transactionId = type === 'move_in' ? app.move_in_deposit_transaction_id : app.security_deposit_transaction_id;

  document.getElementById('depositType').value = type;
  document.getElementById('depositAmount').value = amount || 0;
  document.getElementById('depositMethod').value = method || '';
  document.getElementById('depositTransactionId').value = transactionId || '';
  document.getElementById('recordDepositTitle').textContent =
    type === 'move_in' ? 'Record Move-in Deposit' : 'Record Security Deposit';

  // Reset button state
  const confirmBtn = document.getElementById('confirmRecordDepositBtn');
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Record Payment';

  document.getElementById('recordDepositModal').classList.remove('hidden');
};

async function confirmRecordDeposit() {
  const confirmBtn = document.getElementById('confirmRecordDepositBtn');

  // Prevent multiple clicks
  if (confirmBtn.disabled) {
    return;
  }

  const type = document.getElementById('depositType').value;
  const amount = parseFloat(document.getElementById('depositAmount').value);
  const method = document.getElementById('depositMethod').value;
  const transactionId = document.getElementById('depositTransactionId').value.trim() || null;

  if (!amount || amount <= 0) {
    showToast('Please enter a valid amount', 'warning');
    return;
  }

  if (!method) {
    showToast('Please select a payment method', 'warning');
    return;
  }

  const originalText = confirmBtn.textContent;

  // Disable button and show loading state
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Processing...';

  try {
    if (type === 'move_in') {
      await rentalService.recordMoveInDeposit(currentApplicationId, { amount, method, transactionId });
    } else {
      await rentalService.recordSecurityDeposit(currentApplicationId, { amount, method, transactionId });
    }

    // Refresh only the current application instead of reloading all applications
    const updatedApp = await rentalService.getApplication(currentApplicationId);
    const index = allApplications.findIndex(a => a.id === currentApplicationId);
    if (index !== -1) {
      allApplications[index] = updatedApp;
    }

    closeRecordDepositModal();
    openRentalDetail(currentApplicationId, getActiveDetailTab());
    showToast('Deposit recorded', 'success');
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
    // Re-enable button on error
    confirmBtn.disabled = false;
    confirmBtn.textContent = originalText;
  }
}

function closeRecordDepositModal() {
  document.getElementById('recordDepositModal').classList.add('hidden');
  // Reset button state for next use
  const confirmBtn = document.getElementById('confirmRecordDepositBtn');
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Record Payment';
}

// =============================================
// RENT PAYMENT RECORDING
// =============================================

function openRecordRentModal() {
  const app = allApplications.find(a => a.id === currentApplicationId);
  if (!app) return;

  if (!app.assignment_id) {
    showToast('No active assignment found. Tenant must be moved in first.', 'warning');
    return;
  }

  // Pre-fill amount with monthly rate
  document.getElementById('rentPaymentAmount').value = app.approved_rate || '';

  // Default period to current month
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  document.getElementById('rentPaymentPeriodStart').value = firstOfMonth.toISOString().split('T')[0];
  document.getElementById('rentPaymentPeriodEnd').value = lastOfMonth.toISOString().split('T')[0];

  // Clear other fields
  document.getElementById('rentPaymentMethod').value = '';
  document.getElementById('rentPaymentTransactionId').value = '';
  document.getElementById('rentPaymentNotes').value = '';

  document.getElementById('recordRentModal').classList.remove('hidden');
}

async function confirmRecordRent() {
  const app = allApplications.find(a => a.id === currentApplicationId);
  if (!app || !app.assignment_id) return;

  const amount = parseFloat(document.getElementById('rentPaymentAmount').value);
  const method = document.getElementById('rentPaymentMethod').value;
  const periodStart = document.getElementById('rentPaymentPeriodStart').value;
  const periodEnd = document.getElementById('rentPaymentPeriodEnd').value;
  const transactionId = document.getElementById('rentPaymentTransactionId').value.trim() || null;
  const notes = document.getElementById('rentPaymentNotes').value.trim() || null;

  if (!amount || amount <= 0) {
    showToast('Please enter a valid amount', 'warning');
    return;
  }
  if (!method) {
    showToast('Please select a payment method', 'warning');
    return;
  }
  if (!periodStart || !periodEnd) {
    showToast('Please set the payment period', 'warning');
    return;
  }

  try {
    await rentalService.recordRentPayment(app.assignment_id, {
      amount,
      periodStart,
      periodEnd,
      method,
      transactionId,
      notes,
    });
    closeRecordRentModal();
    await loadRentHistory(app.assignment_id);
    showToast('Rent payment recorded', 'success');
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

function closeRecordRentModal() {
  document.getElementById('recordRentModal').classList.add('hidden');
}

async function loadRentHistory(assignmentId) {
  const tbody = document.getElementById('rentHistoryBody');
  if (!assignmentId) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted">No active assignment</td></tr>';
    return;
  }

  try {
    const payments = await rentalService.getRentHistory(assignmentId);
    if (!payments.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-muted">No payments recorded</td></tr>';
      return;
    }

    tbody.innerHTML = payments.map(p => {
      const period = p.period_start
        ? `${rentalService.formatDate(p.period_start)} – ${rentalService.formatDate(p.period_end)}`
        : '-';
      const amount = rentalService.formatCurrency(p.amount_due);
      const paid = p.paid_date ? rentalService.formatDate(p.paid_date) : '-';
      const method = p.payment_method || '-';
      return `<tr><td>${period}</td><td>${amount}</td><td>${paid}</td><td>${method}</td></tr>`;
    }).join('');
  } catch (error) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted">Error loading payments</td></tr>';
  }
}

// =============================================
// PAYMENT SUMMARY
// =============================================

function renderPaymentSummary(app) {
  const card = document.getElementById('paymentSummaryCard');
  const content = document.getElementById('paymentSummaryContent');
  if (!card || !content) return;

  const securityDeposit = app.security_deposit_amount || 0;
  const appFeeCredit = (app.application_fee_paid && app.application_fee_amount > 0) ? app.application_fee_amount : 0;

  // Move-in reservation deposit = up to one month's rent (non-refundable, applied to first month)
  const moveInDeposit = app.move_in_deposit_amount || app.approved_rate || 0;
  const subtotal = moveInDeposit + securityDeposit;
  const totalDue = Math.max(0, subtotal - appFeeCredit);

  if (!moveInDeposit && !securityDeposit) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');

  let rows = '';
  rows += `<div class="summary-row"><span>Move-in reservation deposit:</span><span>${rentalService.formatCurrency(moveInDeposit)}</span></div>`;
  rows += `<div class="summary-note">Non-refundable. Applied to first month's rent.</div>`;
  if (securityDeposit > 0) {
    rows += `<div class="summary-row"><span>Security deposit (refundable):</span><span>+ ${rentalService.formatCurrency(securityDeposit)}</span></div>`;
  }
  rows += `<div class="summary-divider"></div>`;
  rows += `<div class="summary-row"><span>Subtotal:</span><span>${rentalService.formatCurrency(subtotal)}</span></div>`;

  if (appFeeCredit > 0) {
    rows += `<div class="summary-row credit"><span>Application fee credit:</span><span>- ${rentalService.formatCurrency(appFeeCredit)}</span></div>`;
    rows += `<div class="summary-divider"></div>`;
  }

  rows += `<div class="summary-row total"><span>TOTAL DUE BEFORE MOVE-IN:</span><span>${rentalService.formatCurrency(totalDue)}</span></div>`;

  // Checklist
  rows += `<div class="summary-checklist">`;
  if (appFeeCredit > 0) {
    rows += `<div class="checklist-item done">&#9745; Application fee (${rentalService.formatCurrency(appFeeCredit)}) — PAID</div>`;
  }

  const allDepositsPaid = app.move_in_deposit_paid && (app.security_deposit_paid || securityDeposit === 0);
  if (allDepositsPaid) {
    rows += `<div class="checklist-item done">&#9745; Move-in balance (${rentalService.formatCurrency(totalDue)}) — PAID</div>`;
  } else if (app.move_in_deposit_paid && securityDeposit > 0 && !app.security_deposit_paid) {
    rows += `<div class="checklist-item done">&#9745; Reservation deposit (${rentalService.formatCurrency(moveInDeposit)}) — PAID</div>`;
    rows += `<div class="checklist-item pending">&#9744; Security deposit (${rentalService.formatCurrency(securityDeposit)}) — DUE</div>`;
  } else {
    rows += `<div class="checklist-item pending">&#9744; Remaining balance (${rentalService.formatCurrency(totalDue)}) — DUE</div>`;
  }
  rows += `</div>`;

  content.innerHTML = rows;
}

// =============================================
// LEASE AGREEMENT GENERATION
// =============================================

/**
 * Generate a display filename for lease documents
 * Format: "Property Rental Agreement [Name] [Date].pdf"
 */
function getLeaseDisplayFilename(app, isSigned = false) {
  const name = app.person
    ? `${app.person.first_name || ''} ${app.person.last_name || ''}`.trim()
    : 'Unknown';
  const cleanName = name.replace(/[^a-zA-Z0-9\s]/g, '').substring(0, 30);
  const dateField = isSigned ? app.agreement_signed_at : app.agreement_generated_at;
  // Use the date field if provided, otherwise use today in Austin timezone
  const dateStr = dateField
    ? formatDateAustin(dateField, { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-')
    : getAustinTodayISO();
  const prefix = isSigned ? 'Property Rental Agreement (Signed)' : 'Property Rental Agreement';
  return `${prefix} ${cleanName} ${dateStr}.pdf`;
}

async function updateDocumentsTabState(app) {
  const generateSection = document.getElementById('generateSection');
  const pdfSection = document.getElementById('pdfSection');
  const signatureSection = document.getElementById('signatureSection');
  const noTemplateWarning = document.getElementById('noTemplateWarning');
  const leasePreview = document.getElementById('leasePreview');

  // Reset visibility — hide generate section by default (Action Pane CTA handles initial generation)
  generateSection.style.display = 'none';
  pdfSection.style.display = 'none';
  signatureSection.style.display = 'none';
  noTemplateWarning.style.display = 'none';
  leasePreview.innerHTML = '';

  // Update generate button text based on whether PDF already exists
  const generateBtn = document.getElementById('generatePdfBtn');
  if (generateBtn) {
    generateBtn.textContent = app.agreement_document_url
      ? 'Regenerate Signable Agreement PDF'
      : 'Generate Signable Agreement PDF';
  }

  // Load template and agreement data
  try {
    currentLeaseTemplate = await leaseTemplateService.getActiveTemplate();
    currentAgreementData = await rentalService.getAgreementData(app.id);

    if (!currentLeaseTemplate) {
      generateSection.style.display = 'block';
      noTemplateWarning.style.display = 'block';
      return;
    }
  } catch (e) {
    console.error('Error loading template/data:', e);
    leasePreview.innerHTML = '<p class="text-muted">Unable to load agreement data</p>';
    return;
  }

  // Show appropriate section based on agreement status
  const status = app.agreement_status || 'pending';

  if (status === 'signed' && app.signed_pdf_url) {
    // Show signed document - also show the unsigned PDF for reference
    if (app.agreement_document_url) {
      pdfSection.style.display = 'block';
      document.getElementById('pdfDownloadLink').href = app.agreement_document_url;
      document.getElementById('pdfFilename').textContent = getLeaseDisplayFilename(app, false);
      if (app.agreement_generated_at) {
        document.getElementById('pdfGeneratedAt').textContent =
          `Generated ${formatDateAustin(app.agreement_generated_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;
      }
    }
    signatureSection.style.display = 'block';
    document.getElementById('signatureStatusText').textContent = 'Agreement signed!';
    document.getElementById('signedPdfSection').style.display = 'block';
    document.getElementById('signedPdfLink').href = app.signed_pdf_url;
    document.getElementById('signedPdfFilename').textContent = getLeaseDisplayFilename(app, true);
  } else if (status === 'sent' && app.signwell_document_id) {
    // Show signature pending status with the unsigned PDF link
    generateSection.style.display = 'none';
    pdfSection.style.display = 'block';
    signatureSection.style.display = 'block';
    const sentDateStr = app.agreement_sent_at
      ? ` on ${formatDateAustin(app.agreement_sent_at, { month: 'short', day: 'numeric' })}`
      : '';
    document.getElementById('signatureStatusText').textContent = `Sent for signature${sentDateStr} — awaiting tenant signature`;
    if (app.agreement_document_url) {
      document.getElementById('pdfDownloadLink').href = app.agreement_document_url;
      document.getElementById('pdfFilename').textContent = getLeaseDisplayFilename(app, false);
      if (app.agreement_generated_at) {
        document.getElementById('pdfGeneratedAt').textContent =
          `Generated ${formatDateAustin(app.agreement_generated_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;
      }
    }
  } else if ((status === 'generated' || app.agreement_document_url) && app.agreement_document_url) {
    // Show generated PDF alongside generate section (so user can regenerate with new terms)
    generateSection.style.display = 'block';
    pdfSection.style.display = 'block';
    document.getElementById('pdfDownloadLink').href = app.agreement_document_url;
    document.getElementById('pdfFilename').textContent = getLeaseDisplayFilename(app, false);
    if (app.agreement_generated_at) {
      document.getElementById('pdfGeneratedAt').textContent =
        `Generated ${formatDateAustin(app.agreement_generated_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;
    }
  }
  // Otherwise show generate section (default)
}

// =============================================
// IDENTITY VERIFICATION
// =============================================

async function updateIdentityVerificationUI(app) {
  const container = document.getElementById('identityVerificationContent');
  if (!container) return;

  const status = app.identity_verification_status || 'pending';

  if (status === 'pending') {
    container.innerHTML = `
      <p class="text-muted" style="margin-bottom: 0.75rem;">No verification requested yet.</p>
      <button type="button" id="requestIdVerificationBtn" class="btn-small btn-primary">Request ID Verification</button>
    `;
    document.getElementById('requestIdVerificationBtn')?.addEventListener('click', () => requestIdVerification(app));
    return;
  }

  if (status === 'link_sent') {
    // Check if token exists and show link info
    let tokenInfo = '';
    try {
      const token = await identityService.getUploadToken(app.id);
      if (token) {
        const uploadUrl = `https://USERNAME.github.io/REPO/spaces/verify.html?token=${token.token}`;
        const expiresDate = new Date(token.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        tokenInfo = `
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.5rem;">
            Link expires ${expiresDate}
          </p>
          <div style="margin-top: 0.75rem;">
            <button type="button" id="copyIdLinkBtn" class="btn-small" data-url="${uploadUrl}">Copy Link</button>
            <button type="button" id="resendIdEmailBtn" class="btn-small">Resend Email</button>
          </div>
        `;
      }
    } catch (e) {
      console.error('Error loading token:', e);
    }

    container.innerHTML = `
      <span class="status-badge" style="background: #fef9e7; color: #b7950b; padding: 4px 10px; border-radius: 4px; font-size: 0.85rem;">Link Sent</span>
      <p class="text-muted" style="margin-top: 0.5rem;">Waiting for applicant to upload their ID.</p>
      ${tokenInfo}
    `;

    document.getElementById('copyIdLinkBtn')?.addEventListener('click', (e) => {
      const url = e.target.dataset.url;
      navigator.clipboard.writeText(url).then(() => showToast('Link copied!', 'success'));
    });
    document.getElementById('resendIdEmailBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('resendIdEmailBtn');
      if (btn.disabled) return;
      const originalText = btn.textContent;
      btn.textContent = 'Sending...';
      btn.disabled = true;
      try {
        await resendIdEmail(app);
        // 30s cooldown
        let seconds = 30;
        btn.textContent = `Sent (${seconds}s)`;
        const timer = setInterval(() => {
          seconds--;
          if (seconds <= 0) {
            clearInterval(timer);
            btn.textContent = originalText;
            btn.disabled = false;
          } else {
            btn.textContent = `Sent (${seconds}s)`;
          }
        }, 1000);
      } catch (e) {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    });
    return;
  }

  // For verified/flagged statuses, load the verification record
  try {
    const verification = await identityService.getVerification(app.id);
    if (!verification) {
      container.innerHTML = '<p class="text-muted">Verification record not found.</p>';
      return;
    }

    if (status === 'verified' || verification.verification_status === 'auto_approved' || verification.verification_status === 'manually_approved') {
      const reviewInfo = verification.verification_status === 'manually_approved' && verification.reviewed_by
        ? `<p style="font-size: 0.85rem; color: var(--text-muted);">Approved by ${verification.reviewed_by} on ${new Date(verification.reviewed_at).toLocaleDateString()}</p>`
        : '';
      container.innerHTML = `
        <span class="status-badge" style="background: #e8f5e9; color: #27ae60; padding: 4px 10px; border-radius: 4px; font-size: 0.85rem;">Verified</span>
        <div style="margin-top: 0.75rem; display: flex; gap: 1rem; align-items: flex-start;">
          ${verification.document_url ? `<a href="${verification.document_url}" target="_blank"><img src="${verification.document_url}" style="width: 80px; height: 50px; object-fit: cover; border-radius: 4px; border: 1px solid #ddd;" alt="ID"></a>` : ''}
          <div>
            <p style="margin: 0;"><strong>Name on ID:</strong> ${verification.extracted_full_name || 'N/A'}</p>
            <p style="margin: 0.25rem 0 0; font-size: 0.85rem; color: var(--text-muted);">Match score: ${verification.name_match_score}% - ${verification.name_match_details || ''}</p>
            ${verification.extracted_state ? `<p style="margin: 0.25rem 0 0; font-size: 0.85rem; color: var(--text-muted);">State: ${verification.extracted_state}</p>` : ''}
            ${reviewInfo}
          </div>
        </div>
      `;
    } else if (status === 'flagged' || verification.verification_status === 'flagged') {
      const person = app.person || {};
      const appName = `${person.first_name || ''} ${person.last_name || ''}`.trim();
      container.innerHTML = `
        <span class="status-badge" style="background: #fef9e7; color: #e67e22; padding: 4px 10px; border-radius: 4px; font-size: 0.85rem;">Flagged for Review</span>
        <div style="margin-top: 0.75rem; display: flex; gap: 1rem; align-items: flex-start;">
          ${verification.document_url ? `<a href="${verification.document_url}" target="_blank"><img src="${verification.document_url}" style="width: 80px; height: 50px; object-fit: cover; border-radius: 4px; border: 1px solid #ddd;" alt="ID"></a>` : ''}
          <div>
            <p style="margin: 0;"><strong>Application Name:</strong> ${appName}</p>
            <p style="margin: 0.25rem 0 0;"><strong>Name on ID:</strong> ${verification.extracted_full_name || 'Could not extract'}</p>
            <p style="margin: 0.25rem 0 0; font-size: 0.85rem; color: var(--text-muted);">Match score: ${verification.name_match_score}% - ${verification.name_match_details || ''}</p>
            ${verification.is_expired_dl ? '<p style="margin: 0.25rem 0 0; font-size: 0.85rem; color: #c0392b;"><strong>ID appears to be expired</strong></p>' : ''}
          </div>
        </div>
        <div style="margin-top: 1rem;">
          <button type="button" id="approveIdBtn" class="btn-small btn-primary">Approve</button>
          <button type="button" id="rejectIdBtn" class="btn-small" style="color: #c0392b;">Reject</button>
        </div>
      `;
      document.getElementById('approveIdBtn')?.addEventListener('click', () => approveIdVerification(verification.id, app));
      document.getElementById('rejectIdBtn')?.addEventListener('click', () => rejectIdVerification(verification.id, app));
    } else if (verification.verification_status === 'manually_rejected') {
      container.innerHTML = `
        <span class="status-badge" style="background: #fde8e8; color: #c0392b; padding: 4px 10px; border-radius: 4px; font-size: 0.85rem;">Rejected</span>
        ${verification.review_notes ? `<p style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--text-muted);">Notes: ${verification.review_notes}</p>` : ''}
        <div style="margin-top: 0.75rem;">
          <button type="button" id="requestIdVerificationBtn" class="btn-small btn-primary">Request New Verification</button>
        </div>
      `;
      document.getElementById('requestIdVerificationBtn')?.addEventListener('click', () => requestIdVerification(app));
    }
  } catch (e) {
    console.error('Error loading verification:', e);
    container.innerHTML = '<p class="text-muted">Error loading verification data.</p>';
  }
}

async function requestIdVerification(app) {
  if (!app.person_id) {
    showToast('No person linked to this application', 'error');
    return;
  }

  try {
    const { uploadUrl } = await identityService.requestVerification(app.id, app.person_id);
    const person = app.person || {};

    // Send email with the link
    if (person.email) {
      await emailService.sendDLUploadLink(person, uploadUrl);
      showToast('ID verification link sent!', 'success');
    } else {
      // No email - copy the link
      await navigator.clipboard.writeText(uploadUrl);
      showToast('No email on file. Link copied to clipboard.', 'warning');
    }

    // Refresh the UI
    app.identity_verification_status = 'link_sent';
    await updateIdentityVerificationUI(app);
  } catch (e) {
    console.error('Error requesting verification:', e);
    showToast('Failed to request verification', 'error');
  }
}

async function resendIdEmail(app) {
  try {
    const token = await identityService.getUploadToken(app.id);
    if (!token || token.is_used) {
      // Generate new token
      await requestIdVerification(app);
      return;
    }

    if (new Date(token.expires_at) < new Date()) {
      // Token expired, generate new one
      await requestIdVerification(app);
      return;
    }

    const uploadUrl = `https://USERNAME.github.io/REPO/spaces/verify.html?token=${token.token}`;
    const person = app.person || {};

    if (person.email) {
      await emailService.sendDLUploadLink(person, uploadUrl);
      showToast('Verification email resent!', 'success');
    } else {
      await navigator.clipboard.writeText(uploadUrl);
      showToast('No email on file. Link copied to clipboard.', 'warning');
    }
  } catch (e) {
    console.error('Error resending email:', e);
    showToast('Failed to resend email', 'error');
  }
}

async function approveIdVerification(verificationId, app) {
  try {
    await identityService.approveVerification(verificationId, 'admin');
    showToast('Identity approved!', 'success');
    app.identity_verification_status = 'verified';
    await updateIdentityVerificationUI(app);
  } catch (e) {
    console.error('Error approving verification:', e);
    showToast('Failed to approve', 'error');
  }
}

async function rejectIdVerification(verificationId, app) {
  const notes = prompt('Rejection notes (optional):');
  try {
    await identityService.rejectVerification(verificationId, 'admin', notes);
    showToast('Identity rejected', 'warning');
    app.identity_verification_status = 'pending';
    await updateIdentityVerificationUI(app);
  } catch (e) {
    console.error('Error rejecting verification:', e);
    showToast('Failed to reject', 'error');
  }
}

async function previewLease() {
  if (!currentApplicationId) return;
  const leasePreviewContainer = document.getElementById('leasePreviewContainer');
  const leasePreview = document.getElementById('leasePreview');

  try {
    // Always refresh template and data to get latest terms
    currentLeaseTemplate = await leaseTemplateService.getActiveTemplate();
    currentAgreementData = await rentalService.getAgreementData(currentApplicationId);

    if (!currentLeaseTemplate || !currentAgreementData) {
      showToast('No template or data available. Make sure Terms are filled in.', 'warning');
      return;
    }

    const parsedContent = leaseTemplateService.parseTemplate(
      currentLeaseTemplate.content,
      currentAgreementData
    );
    // Convert markdown to simple HTML for preview
    leasePreview.innerHTML = markdownToHtml(parsedContent);
    leasePreviewContainer.style.display = 'block';
    showToast('Preview loaded with current terms', 'success');
  } catch (e) {
    console.error('Error previewing lease:', e);
    showToast('Error generating preview: ' + e.message, 'error');
  }
}

function markdownToHtml(markdown) {
  // Simple markdown to HTML conversion for preview
  let html = markdown
    // Headers
    .replace(/^### (.*$)/gm, '<h4>$1</h4>')
    .replace(/^## (.*$)/gm, '<h3>$1</h3>')
    .replace(/^# (.*$)/gm, '<h2>$1</h2>')
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr>')
    // Line breaks
    .replace(/\n/g, '<br>');

  return html;
}

async function generateLeasePdf() {
  if (!currentApplicationId) return;
  const btn = document.getElementById('generatePdfBtn');
  const originalText = btn.textContent;
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    // Always refresh template and data to get latest terms
    currentLeaseTemplate = await leaseTemplateService.getActiveTemplate();
    currentAgreementData = await rentalService.getAgreementData(currentApplicationId);

    if (!currentLeaseTemplate || !currentAgreementData) {
      showToast('No template or data available', 'warning');
      return;
    }

    // Parse template with application data
    let parsedContent = leaseTemplateService.parseTemplate(
      currentLeaseTemplate.content,
      currentAgreementData
    );

    // Generate lease-only PDF first to determine its page count (for SignWell field placement)
    const leaseOnlyResult = await pdfService.generateLeasePdf(parsedContent, 'temp.pdf');
    const leaseOnlyPageCount = leaseOnlyResult.pageCount;
    let hasWaiver = false;
    let waiverTemplateId = null;

    // Auto-append active renter waiver (if one exists)
    try {
      const waiverTemplate = await leaseTemplateService.getActiveTemplate('renter_waiver');
      if (waiverTemplate) {
        const parsedWaiver = leaseTemplateService.parseTemplate(
          waiverTemplate.content,
          currentAgreementData
        );
        // Append waiver after the lease with a page break separator
        parsedContent += '\n\n---\n\n' + parsedWaiver;
        hasWaiver = true;
        waiverTemplateId = waiverTemplate.id;
      }
    } catch (e) {
      console.warn('No active renter waiver template found, generating lease without waiver:', e.message);
    }

    // Generate and upload the combined PDF (lease + waiver)
    const { url, filename, pageCount, leaseOnlyPageCount: storedLeasePages, signaturePositions } = await pdfService.generateAndUploadLeasePdf(
      parsedContent,
      currentApplicationId,
      {
        tenantName: currentAgreementData.tenantName,
        leaseOnlyPageCount: hasWaiver ? leaseOnlyPageCount : undefined,
      }
    );
    currentLeasePageCount = pageCount;
    currentSignaturePositions = signaturePositions || null;

    // Update application with PDF URL and page counts
    await rentalService.updateAgreementStatus(currentApplicationId, 'generated', url);
    // Store both total page count and lease-only page count for SignWell signature placement
    const updateData = { lease_page_count: pageCount };
    if (hasWaiver) {
      updateData.lease_only_page_count = leaseOnlyPageCount;
      updateData.waiver_template_id = waiverTemplateId;
    }
    await supabase.from('rental_applications').update(updateData).eq('id', currentApplicationId);

    // Reload applications and refresh UI
    await loadApplications();
    await openRentalDetail(currentApplicationId, getActiveDetailTab());

    showToast('Lease agreement PDF generated!', 'success');
  } catch (e) {
    console.error('Error generating PDF:', e);
    showToast('Error generating PDF: ' + e.message, 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function sendForSignature() {
  if (!currentApplicationId) return;

  const app = allApplications.find(a => a.id === currentApplicationId);
  if (!app) {
    showToast('Application not found', 'error');
    return;
  }

  if (!app.agreement_document_url) {
    showToast('Please generate a lease agreement PDF first', 'warning');
    return;
  }

  if (!app.person?.email) {
    showToast('Applicant has no email address on file', 'error');
    return;
  }

  const btn = document.getElementById('sendForSignatureBtn');
  const originalText = btn.textContent;

  try {
    btn.textContent = 'Sending...';
    btn.disabled = true;

    // Send document to SignWell for signing
    const recipientName = `${app.person.first_name} ${app.person.last_name}`;
    const totalPageCount = currentLeasePageCount || app.lease_page_count;
    const leaseOnlyPages = app.lease_only_page_count || totalPageCount;
    const hasWaiver = leaseOnlyPages < totalPageCount;
    const document = await signwellService.sendForSignature(
      currentApplicationId,
      app.agreement_document_url,
      app.person.email,
      recipientName,
      totalPageCount,
      {
        leaseSignaturePage: leaseOnlyPages,
        waiverSignaturePage: hasWaiver ? totalPageCount : null,
        signaturePositions: currentSignaturePositions,
      }
    );

    // Also send a notification email via Resend
    const emailResult = await emailService.sendLeaseSent({ person: app.person });

    // Automatically send deposit request email with payment instructions
    // Include ID verification link if not yet verified
    let idUploadUrl = null;
    if (app.identity_verification_status !== 'verified') {
      try {
        const { uploadUrl } = await identityService.requestVerification(
          currentApplicationId, app.person_id, authState?.user?.email
        );
        idUploadUrl = uploadUrl;
      } catch (e) {
        console.warn('Could not generate ID upload link:', e);
      }
    }
    const depositApp = {
      person: app.person,
      move_in_deposit: app.move_in_deposit_amount || app.approved_rate || 0,
      security_deposit: app.security_deposit_amount || 0,
      identity_verification_status: app.identity_verification_status,
      id_upload_url: idUploadUrl,
    };
    const depositEmailResult = await emailService.sendDepositRequested(depositApp);

    // Mark deposit as requested in the database
    if (depositEmailResult.success) {
      await supabase.from('rental_applications').update({
        deposit_requested_at: new Date().toISOString()
      }).eq('id', currentApplicationId);
    }

    await loadApplications();
    openRentalDetail(currentApplicationId, getActiveDetailTab());

    if (emailResult.success && depositEmailResult.success) {
      showToast('Lease sent for signature, notification & deposit request emails sent', 'success');
    } else if (emailResult.success) {
      showToast('Lease sent for signature & notification sent (deposit email failed)', 'warning');
    } else {
      showToast('Lease sent for signature (some notification emails failed)', 'warning');
    }
  } catch (error) {
    console.error('Error sending for signature:', error);
    showToast('Error: ' + error.message, 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// =============================================
// DEPOSIT REQUEST
// =============================================

async function sendDepositRequestEmail() {
  if (!currentApplicationId) return;
  const app = allApplications.find(a => a.id === currentApplicationId);
  if (!app) return;

  if (!app.person?.email) {
    showToast('Applicant has no email address on file', 'error');
    return;
  }

  const btn = document.getElementById('sendDepositRequestBtn');
  const originalText = btn.textContent;

  try {
    btn.textContent = 'Sending...';
    btn.disabled = true;

    // Include ID verification link if not yet verified
    let idUploadUrl = null;
    if (app.identity_verification_status !== 'verified') {
      try {
        const { uploadUrl } = await identityService.requestVerification(
          currentApplicationId, app.person_id, authState?.user?.email
        );
        idUploadUrl = uploadUrl;
      } catch (e) {
        console.warn('Could not generate ID upload link:', e);
      }
    }
    const depositApp = {
      person: app.person,
      move_in_deposit: app.move_in_deposit_amount || app.approved_rate || 0,
      security_deposit: app.security_deposit_amount || 0,
      identity_verification_status: app.identity_verification_status,
      id_upload_url: idUploadUrl,
    };
    const result = await emailService.sendDepositRequested(depositApp);

    if (result.success) {
      await supabase.from('rental_applications').update({
        deposit_requested_at: new Date().toISOString()
      }).eq('id', currentApplicationId);

      await loadApplications();
      openRentalDetail(currentApplicationId, getActiveDetailTab());
      showToast('Deposit request email sent', 'success');
    } else {
      showToast('Failed to send deposit request email', 'error');
    }
  } catch (error) {
    console.error('Error sending deposit request:', error);
    showToast('Error: ' + error.message, 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

function copyPaymentInstructions() {
  if (!currentApplicationId) return;
  const app = allApplications.find(a => a.id === currentApplicationId);
  if (!app) return;

  const moveIn = app.move_in_deposit_amount || app.approved_rate || 0;
  const sec = app.security_deposit_amount || 0;
  const total = moveIn + sec;

  const text = `Deposit Payment Instructions - YOUR_PROPERTY_NAME\n\nMove-in Reservation Deposit: $${moveIn}\nSecurity Deposit: $${sec}\nTotal Due: $${total}\n\nPayment Methods:\n• Venmo: @PropertyPlayhouse\n• Zelle: admin@YOUR_DOMAIN\n\nPlease include your name in the payment memo.`;

  navigator.clipboard.writeText(text).then(() => {
    showToast('Payment instructions copied to clipboard', 'success');
  }).catch(() => {
    showToast('Failed to copy to clipboard', 'error');
  });
}

// =============================================
// AIRBNB SYNC
// =============================================

async function loadAirbnbRentals() {
  try {
    const today = getAustinToday();
    const todayStr = getAustinTodayISO();

    // Load all spaces with Airbnb iCal URLs
    const { data: airbnbSpaces, error: spacesError } = await supabase
      .from('spaces')
      .select('id, name, airbnb_ical_url, airbnb_blocked_dates')
      .not('airbnb_ical_url', 'is', null)
      .eq('is_archived', false)
      .order('name');

    if (spacesError) throw spacesError;

    // Load all active/future assignments for these spaces
    const { data: assignments, error: assignmentsError } = await supabase
      .from('assignments')
      .select(`
        id, start_date, end_date, status, airbnb_uid, notes,
        person:person_id(first_name, last_name),
        assignment_spaces(space_id)
      `)
      .in('status', ['active', 'prospect', 'pending_contract', 'contract_sent'])
      .gte('end_date', todayStr)
      .order('start_date', { ascending: true });

    if (assignmentsError) throw assignmentsError;

    const linkedSpacesList = document.getElementById('linkedSpacesList');

    if (airbnbSpaces && airbnbSpaces.length > 0) {
      const fmtDateLocal = (d) => {
        const day = d.getDate();
        const month = d.toLocaleString('en-US', { month: 'short' });
        const year = String(d.getFullYear()).slice(-2);
        return `${day}-${month}-${year}`;
      };

      // Build table rows - one row per space
      const tableRows = airbnbSpaces.map(space => {
        // Get assignments for this space
        const spaceAssignments = (assignments || []).filter(a =>
          a.assignment_spaces?.some(as => as.space_id === space.id)
        );

        // Get blocked dates from Airbnb
        const blockedRanges = space.airbnb_blocked_dates || [];

        // Combine assignments and blocked dates into occupied ranges
        const occupiedRanges = [
          ...spaceAssignments.map(a => {
            const personName = a.person && a.person.first_name !== 'Airbnb'
              ? `${a.person.first_name} ${a.person.last_name || ''}`.trim()
              : null;

            let displayName;
            if (a.airbnb_uid) {
              displayName = personName
                || (a.notes?.match(/Imported from Airbnb: (.+)/)?.[1])
                || 'Airbnb Guest';
            } else {
              displayName = personName || 'Unknown';
            }

            return {
              start: parseAustinDate(a.start_date),
              end: parseAustinDate(a.end_date),
              type: a.airbnb_uid ? 'airbnb' : 'tenant',
              name: isDemoUser() ? redactString(displayName, 'name') : displayName
            };
          }),
          ...blockedRanges.map(r => ({
            start: parseAustinDate(r.start),
            end: parseAustinDate(r.end),
            type: 'blocked',
            name: 'Blocked'
          }))
        ].filter(r => r.end >= today).sort((a, b) => a.start - b.start);

        // Find current Airbnb guest
        const currentAirbnb = occupiedRanges.find(r => r.start <= today && r.end >= today && r.type === 'airbnb');
        // Find current direct guest (tenant or blocked)
        const currentDirect = occupiedRanges.find(r => r.start <= today && r.end >= today && (r.type === 'tenant' || r.type === 'blocked'));

        // Render cell content
        const renderCell = (occupant) => {
          if (!occupant) {
            return '<span class="empty">-</span>';
          }
          const endDate = fmtDateLocal(occupant.end);
          if (occupant.type === 'blocked') {
            return `<div class="guest-name blocked">Blocked</div><div class="guest-dates">until ${endDate}</div>`;
          }
          return `<div class="guest-name ${occupant.type}">${occupant.name}</div><div class="guest-dates">until ${endDate}</div>`;
        };

        return `
          <tr>
            <td class="space-name">${space.name}</td>
            <td class="occupancy-cell">${renderCell(currentAirbnb)}</td>
            <td class="occupancy-cell">${renderCell(currentDirect)}</td>
          </tr>
        `;
      }).join('');

      linkedSpacesList.innerHTML = `
        <table class="occupancy-table">
          <thead>
            <tr>
              <th>Space</th>
              <th class="col-airbnb">Airbnb</th>
              <th class="col-direct">Direct</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      `;
    } else {
      linkedSpacesList.innerHTML = '<p class="text-muted">No spaces linked to Airbnb. Add Airbnb iCal URLs in space settings.</p>';
    }
  } catch (error) {
    console.error('Error loading Airbnb rentals:', error);
  }
}

function setupAirbnbSyncListeners() {
  const syncBtn = document.getElementById('syncAirbnbBtn');
  if (syncBtn && !syncBtn.dataset.initialized) {
    syncBtn.dataset.initialized = 'true';
    syncBtn.addEventListener('click', triggerAirbnbSync);
  }
}

async function triggerAirbnbSync() {
  const syncBtn = document.getElementById('syncAirbnbBtn');
  const resultsDiv = document.getElementById('airbnbSyncResults');
  const resultsContent = document.getElementById('syncResultsContent');

  syncBtn.disabled = true;
  syncBtn.textContent = 'Syncing...';

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/airbnb-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });

    const result = await response.json();

    if (result.success) {
      // Update last sync time
      document.getElementById('lastSyncTime').textContent = formatDateTimeFull(new Date(), true);

      // Build blocked dates display
      let blockedDatesHtml = '';
      if (result.results && result.results.length > 0) {
        const spacesWithBlocks = result.results.filter(r => r.blockedRanges && r.blockedRanges.length > 0);
        if (spacesWithBlocks.length > 0) {
          blockedDatesHtml = `
            <p style="margin-top: 1rem;"><strong>Blocked Dates (owner blocks in Airbnb):</strong></p>
            <div style="font-size: 0.875rem; color: var(--text-muted);">
              ${spacesWithBlocks.map(space => {
                const ranges = space.blockedRanges.map(r => {
                  const start = formatDateAustin(r.start, { month: 'short', day: 'numeric' });
                  const end = formatDateAustin(r.end, { month: 'short', day: 'numeric' });
                  return `${start} - ${end}`;
                }).join(', ');
                return `<p><strong>${space.spaceName}:</strong> ${ranges}</p>`;
              }).join('')}
            </div>
          `;
        }
      }

      // Show results
      resultsDiv.classList.remove('hidden');
      resultsContent.innerHTML = `
        <p><strong>Summary:</strong></p>
        <ul>
          <li>Spaces processed: ${result.summary.spacesProcessed}</li>
          <li>Bookings created: ${result.summary.totalCreated}</li>
          <li>Bookings updated: ${result.summary.totalUpdated}</li>
          <li>Skipped (unchanged/past/blocked): ${result.summary.totalSkipped}</li>
          ${result.summary.totalErrors > 0 ? `<li style="color: var(--error);">Errors: ${result.summary.totalErrors}</li>` : ''}
        </ul>
        ${blockedDatesHtml}
      `;

      showToast(`Sync complete: ${result.summary.totalCreated} new bookings imported`, 'success');

      // Reload the Airbnb rentals list to show updated data
      await loadAirbnbRentals();
    } else {
      throw new Error(result.error || 'Sync failed');
    }
  } catch (error) {
    console.error('Airbnb sync error:', error);
    showToast(`Sync failed: ${error.message}`, 'error');
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync Now';
  }
}

// =============================================
// EVENT LISTENERS
// =============================================

function setupEventListeners() {
  // Create application form
  document.getElementById('createApplicationForm')?.addEventListener('submit', handleCreateApplication);

  // Back button
  document.getElementById('detailBackBtn')?.addEventListener('click', closeRentalDetail);

  // Detail tab navigation (ARIA + keyboard nav via tab-utils; clicks handled by switchDetailTab)
  const detailTabsContainer = document.querySelector('#applicantDetailPage .detail-tabs');
  if (detailTabsContainer) {
    initTabList(detailTabsContainer, {
      tabSelector: '.detail-tab',
      panelForTab: (tab) => document.getElementById(tab.dataset.detailTab + 'Tab'),
      handleClicks: false,
      fade: true,
    });
    // Keep existing click handlers for switchDetailTab (used by inline onclick= too)
    detailTabsContainer.querySelectorAll('.detail-tab').forEach(tab => {
      tab.addEventListener('click', () => switchDetailTab(tab.dataset.detailTab));
    });
  }

  // Terms auto-save
  setupTermsAutoSave();

  // Documents tab buttons
  document.getElementById('previewLeaseBtn')?.addEventListener('click', previewLease);
  document.getElementById('generatePdfBtn')?.addEventListener('click', generateLeasePdf);
  document.getElementById('sendForSignatureBtn')?.addEventListener('click', sendForSignature);

  // Signature tracking buttons
  document.getElementById('checkSignatureStatusBtn')?.addEventListener('click', async () => {
    const app = allApplications.find(a => a.id === currentApplicationId);
    if (!app?.signwell_document_id) {
      showToast('No SignWell document found', 'error');
      return;
    }
    const btn = document.getElementById('checkSignatureStatusBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Checking...';
    btn.disabled = true;
    try {
      const status = await signwellService.getDocumentStatus(app.signwell_document_id);
      const recipientStatus = status.recipients?.[0]?.status || 'unknown';
      if (status.completed) {
        showToast('Document is signed! Refreshing...', 'success');
        await rentalService.updateAgreementStatus(currentApplicationId, 'signed');
        await loadApplications();
        openRentalDetail(currentApplicationId, 'documents');
      } else {
        document.getElementById('signatureStatusText').textContent =
          `Awaiting signature (status: ${recipientStatus})`;
        showToast(`Status: ${recipientStatus}`, 'info');
      }
    } catch (error) {
      console.error('Error checking signature status:', error);
      if (error.status === 404) {
        try {
          await recreateSignwellDocument(app);
          return; // UI already refreshed by recreateSignwellDocument
        } catch (e) {
          showToast('Error re-creating document: ' + e.message, 'error');
        }
      } else {
        showToast('Error: ' + error.message, 'error');
      }
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });

  document.getElementById('resendSignatureBtn')?.addEventListener('click', async () => {
    const app = allApplications.find(a => a.id === currentApplicationId);
    if (!app?.signwell_document_id) {
      showToast('No SignWell document found', 'error');
      return;
    }
    const btn = document.getElementById('resendSignatureBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Sending...';
    btn.disabled = true;
    try {
      await signwellService.sendReminder(app.signwell_document_id);
      showToast('Signing reminder sent to tenant', 'success');
      // 30s cooldown to prevent spamming the tenant
      let seconds = 30;
      btn.textContent = `Sent (${seconds}s)`;
      const timer = setInterval(() => {
        seconds--;
        if (seconds <= 0) {
          clearInterval(timer);
          btn.textContent = originalText;
          btn.disabled = false;
        } else {
          btn.textContent = `Sent (${seconds}s)`;
        }
      }, 1000);
    } catch (error) {
      console.error('Error sending reminder:', error);
      if (error.status === 404) {
        try {
          await recreateSignwellDocument(app);
        } catch (e) {
          showToast('Error re-creating document: ' + e.message, 'error');
        }
      } else {
        showToast('Error: ' + error.message, 'error');
      }
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });

  // Manual document entry buttons (inside collapsible section)
  document.getElementById('markAgreementGenerated')?.addEventListener('click', async () => {
    if (!currentApplicationId) return;
    const url = document.getElementById('agreementDocUrl')?.value || null;
    try {
      await rentalService.updateAgreementStatus(currentApplicationId, 'generated', url);
      await loadApplications();
      openRentalDetail(currentApplicationId, 'documents');
      showToast('Agreement marked as generated', 'success');
    } catch (error) {
      showToast('Error: ' + error.message, 'error');
    }
  });

  document.getElementById('markAgreementSent')?.addEventListener('click', async () => {
    if (!currentApplicationId) return;
    try {
      await rentalService.updateAgreementStatus(currentApplicationId, 'sent');
      await loadApplications();
      openRentalDetail(currentApplicationId, 'documents');
      showToast('Agreement marked as sent (manual)', 'success');
    } catch (error) {
      showToast('Error: ' + error.message, 'error');
    }
  });

  document.getElementById('markAgreementSigned')?.addEventListener('click', async () => {
    if (!currentApplicationId) return;
    try {
      await rentalService.updateAgreementStatus(currentApplicationId, 'signed');
      await loadApplications();
      openRentalDetail(currentApplicationId, 'documents');
      showToast('Agreement marked as signed (manual)', 'success');
    } catch (error) {
      showToast('Error: ' + error.message, 'error');
    }
  });

  // Deposit modals
  document.getElementById('recordMoveInDepositBtn')?.addEventListener('click', () => window.openRecordDepositModal('move_in'));
  document.getElementById('recordSecurityDepositBtn')?.addEventListener('click', () => window.openRecordDepositModal('security'));
  document.getElementById('confirmRecordDepositBtn')?.addEventListener('click', confirmRecordDeposit);
  document.getElementById('closeRecordDepositModal')?.addEventListener('click', closeRecordDepositModal);
  document.getElementById('cancelRecordDepositBtn')?.addEventListener('click', closeRecordDepositModal);
  document.getElementById('recordDepositModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'recordDepositModal') closeRecordDepositModal();
  });
  document.getElementById('recordDepositForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
  });

  // Deposit request section buttons
  document.getElementById('sendDepositRequestBtn')?.addEventListener('click', sendDepositRequestEmail);
  document.getElementById('copyDepositRequestBtn')?.addEventListener('click', copyPaymentInstructions);
  document.getElementById('confirmDepositBtn')?.addEventListener('click', () => window.confirmDeposit());

  // Rent modals
  document.getElementById('openRecordRentBtn')?.addEventListener('click', openRecordRentModal);
  document.getElementById('confirmRecordRentBtn')?.addEventListener('click', confirmRecordRent);
  document.getElementById('closeRecordRentBtn')?.addEventListener('click', closeRecordRentModal);
  document.getElementById('recordRentModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'recordRentModal') closeRecordRentModal();
  });

  // Payment method modal
  document.getElementById('addPaymentMethodBtn')?.addEventListener('click', () => window.openPaymentMethodModal());
  document.getElementById('savePaymentMethodBtn')?.addEventListener('click', savePaymentMethod);
  document.getElementById('deletePaymentMethodBtn')?.addEventListener('click', deletePaymentMethod);
  document.getElementById('closePaymentMethodBtn')?.addEventListener('click', closePaymentMethodModal);
  document.getElementById('paymentMethodModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'paymentMethodModal') closePaymentMethodModal();
  });

  // SMS compose modal (if it exists on this page)
  const composeSmsModal = document.getElementById('composeSmsModal');
  if (composeSmsModal) {
    document.getElementById('closeSmsModalBtn')?.addEventListener('click', () => {
      composeSmsModal.classList.add('hidden');
    });
    document.getElementById('cancelSmsBtn')?.addEventListener('click', () => {
      composeSmsModal.classList.add('hidden');
    });
    composeSmsModal.addEventListener('click', (e) => {
      if (e.target.id === 'composeSmsModal') composeSmsModal.classList.add('hidden');
    });
  }
}

// Make switchDetailTab available globally for onclick handlers
window.switchDetailTab = switchDetailTab;
