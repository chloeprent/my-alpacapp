// Events Page - Admin Dashboard
// Manages event requests, pipeline, calendar, and event agreements

import { supabase } from '../../shared/supabase.js';
import { eventService } from '../../shared/event-service.js';
import { eventTemplateService } from '../../shared/event-template-service.js';
import { pdfService } from '../../shared/pdf-service.js';
import { signwellService } from '../../shared/signwell-service.js';
import {
  getAustinToday,
  formatDateAustin,
  isSameAustinDay
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
let allEventRequests = [];
let allPeople = [];
let currentEventRequestId = null;
let eventCalendarCurrentDate = getAustinToday();

// Event template state
let currentEventTemplate = null;
let currentEventAgreementData = null;

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'events',
    requiredRole: 'staff',
    section: 'staff',
    onReady: async (state) => {
      authState = state;
      setupLightbox();
      await loadEvents();
      setupEventListeners();
    }
  });
});

// =============================================
// DATA LOADING
// =============================================

async function loadEvents() {
  try {
    // Load event requests
    allEventRequests = await eventService.getRequests();

    // Load people if not already loaded
    if (allPeople.length === 0) {
      const { data: people } = await supabase
        .from('people')
        .select('id, first_name, last_name, email, phone')
        .order('first_name');
      allPeople = people || [];
    }

    // Populate person dropdown
    const personSelect = document.getElementById('newEventPersonId');
    personSelect.innerHTML = '<option value="">Select a person...</option>' +
      allPeople.map(p => {
        const pName = isDemoUser() ? redactString(`${p.first_name} ${p.last_name}`, 'name') : `${p.first_name} ${p.last_name}`;
        return `<option value="${p.id}">${pName}</option>`;
      }).join('');

    renderEventPipeline();
    initEventCalendarControls();
    renderEventCalendar();
    loadWaiverSignatures();
  } catch (error) {
    console.error('Error loading events:', error);
    showToast('Error loading events', 'error');
  }
}

// =============================================
// PIPELINE RENDERING
// =============================================

function renderEventPipeline() {
  // Group requests by pipeline stage
  const stages = {
    requests: [],
    approved: [],
    contract: [],
    deposit: [],
    ready: [],
    denied: [],
    complete: [],
  };

  allEventRequests.forEach(req => {
    const stage = eventService.getPipelineStage(req);
    if (stages[stage]) {
      stages[stage].push(req);
    }
  });

  // Render each column
  ['requests', 'approved', 'contract', 'deposit', 'ready'].forEach(stage => {
    const container = document.getElementById(`event${stage.charAt(0).toUpperCase() + stage.slice(1)}Cards`);
    const countEl = document.getElementById(`event${stage.charAt(0).toUpperCase() + stage.slice(1)}Count`);

    if (container) {
      container.innerHTML = stages[stage].length === 0
        ? '<div class="pipeline-empty">No requests</div>'
        : stages[stage].map(req => renderEventCard(req)).join('');
    }
    if (countEl) {
      countEl.textContent = stages[stage].length;
    }
  });

  // Render denied section
  const deniedList = document.getElementById('eventDeniedList');
  const deniedCountEl = document.getElementById('eventDeniedCount');

  if (deniedList) {
    deniedList.innerHTML = stages.denied.length === 0
      ? '<p class="text-muted">No denied requests</p>'
      : stages.denied.map(req => renderEventCard(req, true)).join('');
  }
  if (deniedCountEl) {
    deniedCountEl.textContent = stages.denied.length;
  }
}

function renderEventCard(req, isCompact = false) {
  const person = req.person;
  const demo = isDemoUser();
  const rawClientName = person ? `${person.first_name || ''} ${person.last_name || ''}`.trim() : 'Unknown';
  const clientName = demo ? redactString(rawClientName, 'name') : rawClientName;
  const demoClass = demo ? ' demo-redacted' : '';

  const eventDate = req.event_date
    ? formatDateAustin(req.event_date, { month: 'short', day: 'numeric' })
    : '';

  const formatTime = (timeStr) => {
    if (!timeStr) return '';
    const [hours, minutes] = timeStr.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    return `${hour12}:${minutes} ${ampm}`;
  };

  const timeDisplay = req.event_start_time ? formatTime(req.event_start_time) : '';

  const rentalFee = parseFloat(req.rental_fee) || eventService.DEFAULT_FEES.RENTAL_FEE;
  const rawFeeDisplay = rentalFee === 0 ? 'Complementary' : `$${rentalFee}`;
  const feeDisplay = demo && rentalFee !== 0 ? redactString(rawFeeDisplay, 'amount') : rawFeeDisplay;

  const testBadge = req.is_test ? '<span class="test-badge">TEST</span>' : '';

  return `
    <div class="pipeline-card event-card" data-id="${req.id}" onclick="openEventDetail('${req.id}')">
      <div class="card-header">
        <div>
          <div class="event-name">${req.event_name || 'Unnamed Event'}</div>
          <div class="event-date">${eventDate} ${timeDisplay}</div>
        </div>
        ${testBadge}
      </div>
      <div class="card-body">
        <div class="client-name${demoClass}">${clientName}</div>
        ${req.organization_name ? `<div class="text-muted" style="font-size: 0.75rem;">${req.organization_name}</div>` : ''}
      </div>
      <div class="card-footer">
        <span class="guest-count">${req.approved_max_guests || req.expected_guests || '?'} guests</span>
        <span class="fee-display${demoClass}">${feeDisplay}</span>
      </div>
    </div>
  `;
}

// =============================================
// EVENTS CALENDAR
// =============================================

function initEventCalendarControls() {
  document.getElementById('eventCalendarPrevMonth')?.addEventListener('click', () => {
    eventCalendarCurrentDate.setMonth(eventCalendarCurrentDate.getMonth() - 1);
    renderEventCalendar();
  });

  document.getElementById('eventCalendarNextMonth')?.addEventListener('click', () => {
    eventCalendarCurrentDate.setMonth(eventCalendarCurrentDate.getMonth() + 1);
    renderEventCalendar();
  });

  document.getElementById('eventCalendarToday')?.addEventListener('click', () => {
    eventCalendarCurrentDate = getAustinToday();
    renderEventCalendar();
  });

  // Event delegation for event chip tooltips and clicks
  const calendarContainer = document.getElementById('eventsCalendar');
  if (calendarContainer) {
    calendarContainer.addEventListener('mouseenter', (e) => {
      const chip = e.target.closest('.event-chip');
      if (chip) showEventCalendarTooltip(e, chip);
    }, true);

    calendarContainer.addEventListener('mouseleave', (e) => {
      const chip = e.target.closest('.event-chip');
      if (chip) hideEventCalendarTooltip();
    }, true);

    calendarContainer.addEventListener('click', (e) => {
      const chip = e.target.closest('.event-chip');
      if (chip && chip.dataset.id) {
        openEventDetail(chip.dataset.id);
      }
    });
  }
}

function renderEventCalendar() {
  const container = document.getElementById('eventsCalendar');
  if (!container) return;

  // Get date range for current month view
  const year = eventCalendarCurrentDate.getFullYear();
  const month = eventCalendarCurrentDate.getMonth();

  // Update month label
  const monthLabel = document.getElementById('eventCalendarMonthLabel');
  if (monthLabel) {
    monthLabel.textContent = formatDateAustin(eventCalendarCurrentDate, { month: 'long', year: 'numeric' });
  }

  // Get first day of month and calculate calendar grid
  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);
  const startDay = firstDayOfMonth.getDay(); // 0 = Sunday
  const daysInMonth = lastDayOfMonth.getDate();

  // Get days from previous month to fill first week
  const prevMonthLastDay = new Date(year, month, 0).getDate();
  const prevMonthDays = [];
  for (let i = startDay - 1; i >= 0; i--) {
    prevMonthDays.push({
      day: prevMonthLastDay - i,
      date: new Date(year, month - 1, prevMonthLastDay - i),
      isOtherMonth: true
    });
  }

  // Current month days
  const currentMonthDays = [];
  for (let i = 1; i <= daysInMonth; i++) {
    currentMonthDays.push({
      day: i,
      date: new Date(year, month, i),
      isOtherMonth: false
    });
  }

  // Get days from next month to fill last week
  const totalDaysSoFar = prevMonthDays.length + currentMonthDays.length;
  const nextMonthDays = [];
  const daysNeeded = (7 - (totalDaysSoFar % 7)) % 7;
  for (let i = 1; i <= daysNeeded; i++) {
    nextMonthDays.push({
      day: i,
      date: new Date(year, month + 1, i),
      isOtherMonth: true
    });
  }

  const allDays = [...prevMonthDays, ...currentMonthDays, ...nextMonthDays];
  const today = getAustinToday();

  // Group events by date (exclude test events)
  const eventsByDate = {};
  allEventRequests.forEach(req => {
    if (req.event_date && !req.is_test) {
      const dateKey = req.event_date.split('T')[0];
      if (!eventsByDate[dateKey]) {
        eventsByDate[dateKey] = [];
      }
      eventsByDate[dateKey].push(req);
    }
  });

  // Build HTML
  let html = '<div class="events-calendar-grid">';

  // Header row
  html += '<div class="events-calendar-header">';
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((day, index) => {
    const isWeekend = index === 0 || index === 6;
    html += `<div class="day-header ${isWeekend ? 'weekend' : ''}">${day}</div>`;
  });
  html += '</div>';

  // Calendar body
  html += '<div class="events-calendar-body">';
  allDays.forEach((dayInfo, index) => {
    const isWeekend = dayInfo.date.getDay() === 0 || dayInfo.date.getDay() === 6;
    const isToday = isSameAustinDay(dayInfo.date, today);
    const dateKey = dayInfo.date.toISOString().split('T')[0];
    const dayEvents = eventsByDate[dateKey] || [];

    let cellClasses = 'events-calendar-cell';
    if (dayInfo.isOtherMonth) cellClasses += ' other-month';
    if (isWeekend) cellClasses += ' weekend';
    if (isToday) cellClasses += ' today';

    html += `<div class="${cellClasses}">`;
    html += `<div class="cell-date">${dayInfo.day}</div>`;
    html += '<div class="cell-events">';

    dayEvents.forEach(event => {
      const status = event.request_status || 'submitted';
      const person = event.person;
      const rawCalClientName = person ? `${person.first_name || ''} ${person.last_name || ''}`.trim() : 'Unknown';
      const calClientName = isDemoUser() ? redactString(rawCalClientName, 'name') : rawCalClientName;
      const formatTime = (timeStr) => {
        if (!timeStr) return '';
        const [hours, minutes] = timeStr.split(':');
        const hour = parseInt(hours);
        const ampm = hour >= 12 ? 'PM' : 'AM';
        const hour12 = hour % 12 || 12;
        return `${hour12}:${minutes}${ampm}`;
      };
      const timeDisplay = event.event_start_time ? formatTime(event.event_start_time) : '';
      const rentalFee = parseFloat(event.rental_fee) || eventService.DEFAULT_FEES?.RENTAL_FEE || 0;
      const rawCalFee = rentalFee === 0 ? 'Complementary' : `$${rentalFee}`;
      const calFee = isDemoUser() && rentalFee !== 0 ? redactString(rawCalFee, 'amount') : rawCalFee;

      const tooltipData = JSON.stringify({
        name: event.event_name || 'Unnamed Event',
        client: calClientName,
        org: event.organization_name || '-',
        time: event.event_start_time ? `${formatTime(event.event_start_time)} - ${formatTime(event.event_end_time)}` : '-',
        guests: event.expected_guests || '?',
        fee: calFee,
        deposit: isDemoUser() && event.security_deposit ? redactString(`$${event.security_deposit}`, 'amount') : (event.security_deposit ? `$${event.security_deposit}` : 'N/A'),
        status: status.replace('_', ' ')
      }).replace(/"/g, '&quot;');

      html += `
        <div class="event-chip ${status}"
             data-id="${event.id}"
             data-tooltip='${tooltipData}'>
          ${timeDisplay ? `<span class="chip-time">${timeDisplay}</span> ` : ''}
          <span class="chip-name">${event.event_name || 'Event'}</span>
        </div>
      `;
    });

    html += '</div></div>';
  });

  html += '</div></div>';

  // Add tooltip element
  html += '<div id="eventCalendarTooltip" class="event-calendar-tooltip"></div>';

  container.innerHTML = html;
}

function showEventCalendarTooltip(event, element) {
  const tooltip = document.getElementById('eventCalendarTooltip');
  if (!tooltip) return;

  try {
    const data = JSON.parse(element.dataset.tooltip);
    tooltip.innerHTML = `
      <div class="tooltip-header">${data.name}</div>
      <div class="tooltip-row"><span class="tooltip-label">Client:</span><span class="tooltip-value">${data.client}</span></div>
      ${data.org !== '-' ? `<div class="tooltip-row"><span class="tooltip-label">Org:</span><span class="tooltip-value">${data.org}</span></div>` : ''}
      <div class="tooltip-row"><span class="tooltip-label">Time:</span><span class="tooltip-value">${data.time}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Guests:</span><span class="tooltip-value">${data.guests}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Fee:</span><span class="tooltip-value">${data.fee}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Deposit:</span><span class="tooltip-value">${data.deposit}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Status:</span><span class="tooltip-value">${data.status}</span></div>
    `;

    const rect = element.getBoundingClientRect();
    tooltip.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
    tooltip.style.top = `${rect.bottom + 8}px`;
    tooltip.classList.add('visible');
  } catch (e) {
    console.error('Error parsing event tooltip data:', e);
  }
}

function hideEventCalendarTooltip() {
  const tooltip = document.getElementById('eventCalendarTooltip');
  if (tooltip) tooltip.classList.remove('visible');
}

// =============================================
// EVENT DETAIL MODAL
// =============================================

window.openEventDetail = async function(requestId) {
  currentEventRequestId = requestId;
  const req = allEventRequests.find(r => r.id === requestId);
  if (!req) return;

  const person = req.person;
  const demo = isDemoUser();
  const rawDetailClientName = person ? `${person.first_name || ''} ${person.last_name || ''}`.trim() : 'Unknown';
  const detailClientName = demo ? redactString(rawDetailClientName, 'name') : rawDetailClientName;

  // Show modal
  document.getElementById('eventDetailModal').classList.remove('hidden');

  // Set header info
  document.getElementById('eventDetailTitle').textContent = req.event_name || 'Event Details';
  document.getElementById('eventDetailStatus').textContent = req.request_status || 'submitted';
  document.getElementById('eventDetailStatus').className = 'status-badge ' + (req.request_status || 'submitted');
  document.getElementById('eventDetailTestBadge').style.display = req.is_test ? 'inline-block' : 'none';

  // Event Info tab
  document.getElementById('eventInfoName').textContent = req.event_name || '-';
  const clientEl = document.getElementById('eventInfoClient');
  clientEl.textContent = detailClientName;
  clientEl.classList.toggle('demo-redacted', demo);
  const eventEmail = demo ? redactString(person?.email || '-', 'email') : (person?.email || '-');
  document.getElementById('eventInfoEmail').textContent = eventEmail;
  document.getElementById('eventInfoEmail').classList.toggle('demo-redacted', demo);
  document.getElementById('eventInfoPhone').textContent = person?.phone || '-';
  document.getElementById('eventInfoOrg').textContent = req.organization_name || '-';
  document.getElementById('eventInfoDate').textContent = req.event_date
    ? formatDateAustin(req.event_date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : '-';

  const formatTime = (timeStr) => {
    if (!timeStr) return '';
    const [hours, minutes] = timeStr.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    return `${hour12}:${minutes} ${ampm}`;
  };
  document.getElementById('eventInfoTime').textContent =
    req.event_start_time ? `${formatTime(req.event_start_time)} - ${formatTime(req.event_end_time || '')}` : '-';
  document.getElementById('eventInfoGuests').textContent = req.expected_guests || '-';
  document.getElementById('eventInfoType').textContent = req.event_type || '-';
  document.getElementById('eventInfoSubmitted').textContent = req.submitted_at
    ? formatDateAustin(req.submitted_at, { month: 'short', day: 'numeric', year: 'numeric' })
    : '-';
  document.getElementById('eventInfoDescription').textContent = req.event_description || 'No description provided';
  document.getElementById('eventInfoSpecialRequests').textContent = req.special_requests || 'None';

  // Terms tab
  document.getElementById('eventTermMaxGuests').value = req.approved_max_guests || req.expected_guests || 25;
  document.getElementById('eventTermRentalFee').value = req.rental_fee ?? eventService.DEFAULT_FEES.RENTAL_FEE;
  document.getElementById('eventTermReservationFee').value = req.reservation_fee ?? eventService.DEFAULT_FEES.RESERVATION_FEE;
  document.getElementById('eventTermCleaningDeposit').value = req.cleaning_deposit ?? eventService.DEFAULT_FEES.CLEANING_DEPOSIT;
  document.getElementById('eventTermAdditionalTerms').value = req.additional_terms || '';

  // Documents tab
  document.getElementById('eventAgreementStatusDisplay').textContent = req.agreement_status || 'Pending';
  await updateEventDocumentsTabState(req);

  // Deposits tab
  updateEventDepositsTab(req);

  // Action buttons
  updateEventDetailActions(req);

  // Re-evaluate action buttons when terms fields change
  let lastTermsFilled = eventTermsFilled();
  ['eventTermMaxGuests', 'eventTermRentalFee'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        const nowFilled = eventTermsFilled();
        if (nowFilled !== lastTermsFilled) {
          lastTermsFilled = nowFilled;
          updateEventDetailActions(req);
        }
      });
    }
  });

  // Reset to first tab
  document.querySelectorAll('.event-detail-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.event-detail-tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('.event-detail-tab[data-event-tab="eventInfo"]').classList.add('active');
  document.getElementById('eventInfoTab').classList.add('active');

  // Load template for documents tab
  try {
    currentEventTemplate = await eventTemplateService.getActiveTemplate();
    currentEventAgreementData = await eventService.getAgreementData(req.id);
  } catch (e) {
    console.error('Error loading event template/data:', e);
  }
};

function closeEventDetail() {
  document.getElementById('eventDetailModal').classList.add('hidden');
  currentEventRequestId = null;
  currentEventTemplate = null;
  currentEventAgreementData = null;
}

async function updateEventDocumentsTabState(req) {
  const generateSection = document.getElementById('eventGenerateSection');
  const pdfSection = document.getElementById('eventPdfSection');
  const signatureSection = document.getElementById('eventSignatureSection');
  const noTemplateWarning = document.getElementById('noEventTemplateWarning');

  // Reset visibility
  generateSection.style.display = 'block';
  pdfSection.style.display = 'none';
  signatureSection.style.display = 'none';
  noTemplateWarning.style.display = 'none';

  // Clear preview
  document.getElementById('eventLeasePreviewContainer').style.display = 'none';
  document.getElementById('eventLeasePreview').innerHTML = '';

  const status = req.agreement_status || 'pending';

  if (status === 'signed' && req.signed_pdf_url) {
    if (req.agreement_document_url) {
      pdfSection.style.display = 'block';
      document.getElementById('eventPdfDownloadLink').href = req.agreement_document_url;
      document.getElementById('eventPdfFilename').textContent = `Event-Agreement-${req.event_name?.substring(0, 20) || 'event'}.pdf`;
    }
    signatureSection.style.display = 'block';
    document.getElementById('eventSignatureStatusText').textContent = 'Agreement signed!';
    document.getElementById('eventSignedPdfSection').style.display = 'block';
    document.getElementById('eventSignedPdfLink').href = req.signed_pdf_url;
  } else if (status === 'sent' && req.signwell_document_id) {
    generateSection.style.display = 'none';
    pdfSection.style.display = 'block';
    signatureSection.style.display = 'block';
    document.getElementById('eventSignatureStatusText').textContent = 'Awaiting client signature...';
    if (req.agreement_document_url) {
      document.getElementById('eventPdfDownloadLink').href = req.agreement_document_url;
      document.getElementById('eventPdfFilename').textContent = `Event-Agreement-${req.event_name?.substring(0, 20) || 'event'}.pdf`;
    }
  } else if (status === 'generated' && req.agreement_document_url) {
    generateSection.style.display = 'block';
    pdfSection.style.display = 'block';
    document.getElementById('eventPdfDownloadLink').href = req.agreement_document_url;
    document.getElementById('eventPdfFilename').textContent = `Event-Agreement-${req.event_name?.substring(0, 20) || 'event'}.pdf`;
    if (req.agreement_generated_at) {
      document.getElementById('eventPdfGeneratedAt').textContent =
        `Generated ${formatDateAustin(req.agreement_generated_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;
    }
  }
}

function updateEventDepositsTab(req) {
  const rentalFee = parseFloat(req.rental_fee) || eventService.DEFAULT_FEES.RENTAL_FEE;
  const reservationFee = parseFloat(req.reservation_fee) || eventService.DEFAULT_FEES.RESERVATION_FEE;
  const cleaningDeposit = parseFloat(req.cleaning_deposit) || eventService.DEFAULT_FEES.CLEANING_DEPOSIT;
  const demo = isDemoUser();

  // Update amounts (redact for demo)
  const resAmtEl = document.getElementById('eventReservationDepositAmount');
  resAmtEl.textContent = demo ? redactString(`$${reservationFee}`, 'amount') : `$${reservationFee}`;
  resAmtEl.classList.toggle('demo-redacted', demo);
  const cleanAmtEl = document.getElementById('eventCleaningDepositAmount');
  cleanAmtEl.textContent = demo ? redactString(`$${cleaningDeposit}`, 'amount') : `$${cleaningDeposit}`;
  cleanAmtEl.classList.toggle('demo-redacted', demo);
  const rentalAmtEl = document.getElementById('eventRentalFeeAmount');
  rentalAmtEl.textContent = demo ? redactString(`$${rentalFee}`, 'amount') : `$${rentalFee}`;
  rentalAmtEl.classList.toggle('demo-redacted', demo);

  // Update statuses
  document.getElementById('eventReservationDepositStatus').textContent =
    req.reservation_fee_paid ? 'Paid' : 'Pending';
  document.getElementById('eventCleaningDepositStatus').textContent =
    req.cleaning_deposit_paid ? 'Paid' : 'Pending';
  document.getElementById('eventRentalFeeStatus').textContent =
    req.rental_fee_paid ? 'Paid' : 'Pending';

  // Show reservation deposit credit section if paid via Square
  const reservationSection = document.getElementById('eventReservationFeeSection');
  if (req.deposit_status === 'paid' && req.reservation_deposit_amount > 0) {
    reservationSection.classList.remove('hidden');
    const paidAmount = parseFloat(req.reservation_deposit_amount);
    document.getElementById('eventReservationFeeAmount').textContent = `$${paidAmount}`;
    document.getElementById('eventRentalFeeTotal').textContent = `$${rentalFee}`;
    document.getElementById('eventRentalFeeDue').textContent = `$${Math.max(0, rentalFee - paidAmount)}`;

    if (req.reservation_deposit_code) {
      document.getElementById('eventReservationFeeCode').classList.remove('hidden');
      document.getElementById('eventReservationFeeCodeValue').textContent = req.reservation_deposit_code;
    } else {
      document.getElementById('eventReservationFeeCode').classList.add('hidden');
    }
  } else {
    reservationSection.classList.add('hidden');
  }
}

function eventTermsFilled() {
  const maxGuests = document.getElementById('eventTermMaxGuests')?.value;
  const rentalFee = document.getElementById('eventTermRentalFee')?.value;
  return !!(maxGuests && parseInt(maxGuests) > 0 && rentalFee && parseFloat(rentalFee) >= 0);
}

function updateEventDetailActions(req) {
  const container = document.getElementById('eventDetailActions');
  const buttons = [];
  const stage = eventService.getPipelineStage(req);

  switch (stage) {
    case 'requests': {
      const termsFilled = eventTermsFilled();
      if (termsFilled) {
        buttons.push('<button class="btn-primary" onclick="approveEventRequest()">Approve</button>');
      } else {
        buttons.push('<button class="btn-secondary" onclick="switchToEventTab(\'eventTerms\')"><span style="color:var(--danger-color);">&#9679;</span> Fill Details</button>');
        buttons.push('<button class="btn-primary" disabled title="Fill in required terms first" style="opacity:0.5;cursor:not-allowed;">Approve</button>');
      }
      buttons.push('<button class="btn-secondary" onclick="denyEventRequest()">Deny</button>');
      break;
    }

    case 'approved':
      buttons.push('<button class="btn-primary" onclick="switchToEventTab(\'eventDocuments\')">Generate Agreement</button>');
      break;

    case 'contract':
      if (req.agreement_status === 'generated') {
        buttons.push('<button class="btn-primary" onclick="sendEventForSignature()">Send for Signature</button>');
      }
      break;

    case 'deposit':
      buttons.push('<button class="btn-primary" onclick="confirmEventDeposit()">Confirm Deposits</button>');
      break;

    case 'ready':
      buttons.push('<button class="btn-primary" onclick="markEventCompleted()">Mark Complete</button>');
      break;
  }

  // Add test toggle and archive buttons (always available)
  const testLabel = req.is_test ? 'Remove Test Flag' : 'Mark as Test';
  buttons.push(`<button class="btn-secondary btn-small" onclick="toggleEventTestFlag()" style="margin-left: auto;">${testLabel}</button>`);
  buttons.push('<button class="btn-secondary btn-small" onclick="archiveEventRequest()">Archive</button>');

  container.innerHTML = buttons.join('');
}

function switchToEventTab(tabName) {
  document.querySelectorAll('.event-detail-tab').forEach(t => {
    const isTarget = t.dataset.eventTab === tabName;
    t.classList.toggle('active', isTarget);
    t.setAttribute('aria-selected', String(isTarget));
    t.setAttribute('tabindex', isTarget ? '0' : '-1');
  });
  document.querySelectorAll('.event-detail-tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`${tabName}Tab`)?.classList.add('active');
}

// =============================================
// EVENT ACTIONS
// =============================================

window.switchToEventTab = switchToEventTab;

window.approveEventRequest = async function() {
  const req = allEventRequests.find(r => r.id === currentEventRequestId);
  if (!req) return;

  try {
    await eventService.approveRequest(currentEventRequestId, {
      approved_max_guests: parseInt(document.getElementById('eventTermMaxGuests').value) || req.expected_guests,
      rental_fee: parseFloat(document.getElementById('eventTermRentalFee').value),
      reservation_fee: parseFloat(document.getElementById('eventTermReservationFee').value),
      cleaning_deposit: parseFloat(document.getElementById('eventTermCleaningDeposit').value),
      additional_terms: document.getElementById('eventTermAdditionalTerms').value
    });

    allEventRequests = await eventService.getRequests();
    renderEventPipeline();
    closeEventDetail();
    showToast('Event request approved', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
};

window.denyEventRequest = async function() {
  const reason = prompt('Enter denial reason:');
  if (!reason) return;

  try {
    await eventService.denyRequest(currentEventRequestId, reason);
    allEventRequests = await eventService.getRequests();
    renderEventPipeline();
    closeEventDetail();
    showToast('Event request denied', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
};

window.archiveEventRequest = async function() {
  if (!confirm('Archive this event request?')) return;

  try {
    await eventService.archiveRequest(currentEventRequestId);
    allEventRequests = await eventService.getRequests();
    renderEventPipeline();
    closeEventDetail();
    showToast('Event request archived', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
};

window.confirmEventDeposit = async function() {
  try {
    await eventService.confirmDeposit(currentEventRequestId);
    allEventRequests = await eventService.getRequests();
    renderEventPipeline();
    closeEventDetail();
    showToast('Deposits confirmed', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
};

window.markEventCompleted = async function() {
  try {
    await eventService.markEventCompleted(currentEventRequestId);
    allEventRequests = await eventService.getRequests();
    renderEventPipeline();
    closeEventDetail();
    showToast('Event marked as completed', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
};

async function saveEventTerms() {
  const statusEl = document.getElementById('eventTermsSaveStatus');
  statusEl.textContent = 'Saving...';

  try {
    await eventService.saveTerms(currentEventRequestId, {
      approved_max_guests: parseInt(document.getElementById('eventTermMaxGuests').value),
      rental_fee: parseFloat(document.getElementById('eventTermRentalFee').value),
      reservation_fee: parseFloat(document.getElementById('eventTermReservationFee').value),
      cleaning_deposit: parseFloat(document.getElementById('eventTermCleaningDeposit').value),
      additional_terms: document.getElementById('eventTermAdditionalTerms').value
    });

    allEventRequests = await eventService.getRequests();
    renderEventPipeline();
    statusEl.textContent = 'Saved!';
    setTimeout(() => statusEl.textContent = '', 2000);
  } catch (e) {
    console.error('Error saving event terms:', e);
    statusEl.textContent = 'Error saving';
    showToast('Error saving terms: ' + e.message, 'error');
  }
}

// =============================================
// DOCUMENT GENERATION
// =============================================

async function previewEventAgreement() {
  const req = allEventRequests.find(r => r.id === currentEventRequestId);
  if (!req) return;

  try {
    currentEventTemplate = await eventTemplateService.getActiveTemplate();
    currentEventAgreementData = await eventService.getAgreementData(currentEventRequestId);

    if (!currentEventTemplate || !currentEventAgreementData) {
      showToast('No template or data available. Make sure Terms are filled in.', 'warning');
      return;
    }

    const parsedContent = eventTemplateService.parseTemplate(
      currentEventTemplate.content,
      currentEventAgreementData
    );

    // Convert markdown to HTML (simple version)
    const htmlContent = parsedContent
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/^- (.*$)/gim, '<li>$1</li>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    document.getElementById('eventLeasePreviewContainer').style.display = 'block';
    document.getElementById('eventLeasePreview').innerHTML = `<div class="markdown-preview"><p>${htmlContent}</p></div>`;
    showToast('Preview loaded', 'success');
  } catch (e) {
    console.error('Error previewing event agreement:', e);
    showToast('Error loading preview: ' + e.message, 'error');
  }
}

async function generateEventPdf() {
  const req = allEventRequests.find(r => r.id === currentEventRequestId);
  if (!req) return;

  try {
    currentEventTemplate = await eventTemplateService.getActiveTemplate();
    currentEventAgreementData = await eventService.getAgreementData(currentEventRequestId);

    if (!currentEventTemplate || !currentEventAgreementData) {
      showToast('No template or data available', 'warning');
      return;
    }

    const parsedContent = eventTemplateService.parseTemplate(
      currentEventTemplate.content,
      currentEventAgreementData
    );

    showToast('Generating PDF...', 'info');

    // Generate PDF
    const filename = `event-agreement-${req.id}-${Date.now()}.pdf`;
    const { blob } = await pdfService.generateLeasePdf(parsedContent, filename);

    // Upload to Supabase storage
    const url = await pdfService.uploadPdfToStorage(blob, filename);

    // Update event request
    await eventService.updateAgreementStatus(currentEventRequestId, 'generated', url);

    // Reload events
    allEventRequests = await eventService.getRequests();
    renderEventPipeline();

    // Refresh the modal
    const updatedReq = allEventRequests.find(r => r.id === currentEventRequestId);
    if (updatedReq) {
      await updateEventDocumentsTabState(updatedReq);
      updateEventDetailActions(updatedReq);
    }

    showToast('PDF generated successfully!', 'success');
  } catch (e) {
    console.error('Error generating event PDF:', e);
    showToast('Error generating PDF: ' + e.message, 'error');
  }
}

async function sendEventForSignature() {
  const req = allEventRequests.find(r => r.id === currentEventRequestId);
  if (!req) return;

  if (!req.agreement_document_url) {
    showToast('Please generate a PDF first', 'warning');
    return;
  }

  if (!req.person?.email) {
    showToast('Client has no email address on file', 'error');
    return;
  }

  const btn = document.getElementById('sendEventForSignatureBtn');
  const originalText = btn.textContent;

  try {
    btn.textContent = 'Sending...';
    btn.disabled = true;

    const recipientName = `${req.person.first_name} ${req.person.last_name}`;
    await signwellService.sendForSignature(
      currentEventRequestId,
      req.agreement_document_url,
      req.person.email,
      recipientName,
      'event'
    );

    allEventRequests = await eventService.getRequests();
    renderEventPipeline();

    const updatedReq = allEventRequests.find(r => r.id === currentEventRequestId);
    if (updatedReq) {
      await updateEventDocumentsTabState(updatedReq);
      updateEventDetailActions(updatedReq);
    }

    showToast('Agreement sent for signature', 'success');
  } catch (error) {
    console.error('Error sending for signature:', error);
    showToast('Error: ' + error.message, 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// =============================================
// DEPOSIT RECORDING
// =============================================

function openEventRecordDepositModal(type) {
  const req = allEventRequests.find(r => r.id === currentEventRequestId);
  if (!req) return;

  const titles = {
    event_reservation: 'Record Reservation Deposit',
    event_cleaning: 'Record Cleaning Deposit',
    event_rental_fee: 'Record Rental Fee',
  };
  const amounts = {
    event_reservation: parseFloat(req.reservation_fee) || eventService.DEFAULT_FEES.RESERVATION_FEE,
    event_cleaning: parseFloat(req.cleaning_deposit) || eventService.DEFAULT_FEES.CLEANING_DEPOSIT,
    event_rental_fee: parseFloat(req.rental_fee) || eventService.DEFAULT_FEES.RENTAL_FEE,
  };

  document.getElementById('depositType').value = type;
  document.getElementById('depositAmount').value = `$${amounts[type]}`;
  document.getElementById('depositMethod').value = '';
  document.getElementById('depositTransactionId').value = '';
  document.getElementById('recordDepositTitle').textContent = titles[type] || 'Record Payment';

  document.getElementById('recordDepositModal').classList.remove('hidden');
}

async function confirmRecordDeposit() {
  const type = document.getElementById('depositType').value;
  const method = document.getElementById('depositMethod').value;
  const transactionId = document.getElementById('depositTransactionId').value.trim() || null;

  if (!method) {
    showToast('Please select a payment method', 'warning');
    return;
  }

  try {
    const details = { method, transaction_id: transactionId };
    if (type === 'event_reservation') {
      await eventService.recordReservationFee(currentEventRequestId, details);
    } else if (type === 'event_cleaning') {
      await eventService.recordCleaningDeposit(currentEventRequestId, details);
    } else if (type === 'event_rental_fee') {
      await eventService.recordRentalFee(currentEventRequestId, details);
    }

    allEventRequests = await eventService.getRequests();
    renderEventPipeline();
    closeRecordDepositModal();

    const updatedReq = allEventRequests.find(r => r.id === currentEventRequestId);
    if (updatedReq) updateEventDepositsTab(updatedReq);

    showToast('Payment recorded', 'success');
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

function closeRecordDepositModal() {
  document.getElementById('recordDepositModal').classList.add('hidden');
}

// =============================================
// CREATE EVENT REQUEST
// =============================================

async function handleCreateEventRequest(e) {
  e.preventDefault();

  const personId = document.getElementById('newEventPersonId').value;
  const eventData = {
    organization_name: document.getElementById('newEventOrgName').value || null,
    has_hosted_before: document.getElementById('newEventHostedBefore').checked,
    event_name: document.getElementById('newEventName').value,
    event_description: document.getElementById('newEventDescription').value || null,
    event_type: document.getElementById('newEventType').value,
    event_date: document.getElementById('newEventDate').value,
    event_start_time: document.getElementById('newEventStartTime').value,
    event_end_time: document.getElementById('newEventEndTime').value,
    expected_guests: parseInt(document.getElementById('newEventGuests').value) || 25,
  };

  try {
    await eventService.createRequest(personId, eventData);
    showToast('Event request created', 'success');
    e.target.reset();

    // Reload events
    allEventRequests = await eventService.getRequests();
    renderEventPipeline();
  } catch (error) {
    console.error('Error creating event request:', error);
    showToast('Error creating event request', 'error');
  }
}

// =============================================
// EVENT LISTENERS
// =============================================

function setupEventListeners() {
  // Create event request form
  document.getElementById('createEventRequestForm')?.addEventListener('submit', handleCreateEventRequest);

  // Event detail modal close
  document.getElementById('closeEventDetail')?.addEventListener('click', closeEventDetail);
  document.getElementById('eventDetailModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'eventDetailModal') closeEventDetail();
  });

  // Event detail tab navigation (ARIA + keyboard nav via tab-utils; clicks handled by switchToEventTab)
  const eventDetailTabsContainer = document.querySelector('.detail-tabs');
  if (eventDetailTabsContainer) {
    initTabList(eventDetailTabsContainer, {
      tabSelector: '.event-detail-tab',
      panelForTab: (tab) => document.getElementById(tab.dataset.eventTab + 'Tab'),
      handleClicks: false,
      fade: true,
    });
    eventDetailTabsContainer.querySelectorAll('.event-detail-tab').forEach(tab => {
      tab.addEventListener('click', () => switchToEventTab(tab.dataset.eventTab));
    });
  }

  // Save terms button
  document.getElementById('saveEventTermsBtn')?.addEventListener('click', saveEventTerms);

  // Documents tab buttons
  document.getElementById('previewEventLeaseBtn')?.addEventListener('click', previewEventAgreement);
  document.getElementById('generateEventPdfBtn')?.addEventListener('click', generateEventPdf);
  document.getElementById('sendEventForSignatureBtn')?.addEventListener('click', sendEventForSignature);

  // Deposit recording buttons
  document.getElementById('recordEventReservationBtn')?.addEventListener('click', () => openEventRecordDepositModal('event_reservation'));
  document.getElementById('recordEventCleaningBtn')?.addEventListener('click', () => openEventRecordDepositModal('event_cleaning'));
  document.getElementById('recordEventRentalFeeBtn')?.addEventListener('click', () => openEventRecordDepositModal('event_rental_fee'));

  // Record deposit modal
  document.getElementById('confirmRecordDepositBtn')?.addEventListener('click', confirmRecordDeposit);
  document.getElementById('closeRecordDepositBtn')?.addEventListener('click', closeRecordDepositModal);
  document.getElementById('closeRecordDepositModal')?.addEventListener('click', closeRecordDepositModal);
  document.getElementById('recordDepositModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'recordDepositModal') closeRecordDepositModal();
  });
}

window.sendEventForSignature = sendEventForSignature;

window.toggleEventTestFlag = async function() {
  if (!currentEventRequestId) return;
  try {
    const req = allEventRequests.find(r => r.id === currentEventRequestId);
    const newTestValue = !req?.is_test;
    await eventService.toggleTestFlag(currentEventRequestId, newTestValue);
    allEventRequests = await eventService.getRequests();
    renderEventPipeline();
    renderEventCalendar();
    // Refresh the modal
    const updatedReq = allEventRequests.find(r => r.id === currentEventRequestId);
    if (updatedReq) {
      document.getElementById('eventDetailTestBadge').style.display = updatedReq.is_test ? 'inline-block' : 'none';
      updateEventDetailActions(updatedReq);
    }
    showToast(newTestValue ? 'Marked as test' : 'Unmarked as test', 'success');
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
};

// =============================================
// SIGNED WAIVERS
// =============================================

let allWaiverSignatures = [];

async function loadWaiverSignatures() {
  try {
    const { data, error } = await supabase
      .from('waiver_signatures')
      .select('id, waiver_type, signer_name, signer_email, signer_phone, signed_at, event_request_id')
      .order('signed_at', { ascending: false });

    if (error) throw error;
    allWaiverSignatures = data || [];
    renderWaiverTable(allWaiverSignatures);
  } catch (err) {
    console.error('Error loading waivers:', err);
    const tbody = document.getElementById('waiverTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#c0392b; padding:1rem;">Error loading waivers</td></tr>';
  }
}

function renderWaiverTable(waivers) {
  const tbody = document.getElementById('waiverTableBody');
  const countEl = document.getElementById('waiverCount');
  if (!tbody) return;

  if (countEl) countEl.textContent = waivers.length;

  if (waivers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#999; padding:1.5rem;">No signed waivers yet</td></tr>';
    return;
  }

  tbody.innerHTML = waivers.map(w => {
    const name = isDemoUser() ? redactString(w.signer_name, 'name') : w.signer_name;
    const email = isDemoUser() ? redactString(w.signer_email || '', 'email') : (w.signer_email || '—');
    const phone = isDemoUser() ? redactString(w.signer_phone || '', 'phone') : (w.signer_phone || '—');
    const signed = w.signed_at ? formatDateAustin(w.signed_at) : '—';
    return `<tr>
      <td><strong>${name}</strong></td>
      <td>${email}</td>
      <td>${phone}</td>
      <td>${signed}</td>
    </tr>`;
  }).join('');
}

// Waiver search
const waiverSearchInput = document.getElementById('waiverSearch');
if (waiverSearchInput) {
  waiverSearchInput.addEventListener('input', () => {
    const q = waiverSearchInput.value.trim().toLowerCase();
    if (!q) {
      renderWaiverTable(allWaiverSignatures);
      return;
    }
    const filtered = allWaiverSignatures.filter(w =>
      (w.signer_name || '').toLowerCase().includes(q) ||
      (w.signer_email || '').toLowerCase().includes(q) ||
      (w.signer_phone || '').toLowerCase().includes(q)
    );
    renderWaiverTable(filtered);
  });
}
