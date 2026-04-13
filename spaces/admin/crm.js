/**
 * Swoon CRM — Instagram Lead Pipeline Manager
 * Tracks contacts from first DM to paying client.
 */
import { supabase } from '../../shared/supabase.js';
import { initAdminPage, showToast } from '../../shared/admin-shell.js';
import { crmService } from '../../shared/crm-service.js';

// ── State ──
let authState = null;
let allContacts = [];
let initialized = false;
let currentDetailContact = null;

// Stage display config
const STAGES = {
  new_lead:          { label: 'New Lead',          emoji: '🆕', cards: 'cardsNewLead',     count: 'countNewLead' },
  lead_magnet_sent:  { label: 'Lead Magnet Sent',  emoji: '🧲', cards: 'cardsLeadMagnet',  count: 'countLeadMagnet' },
  in_conversation:   { label: 'In Conversation',   emoji: '💬', cards: 'cardsConversation', count: 'countConversation' },
  call_booked:       { label: 'Call Booked',        emoji: '📞', cards: 'cardsCallBooked',  count: 'countCallBooked' },
  client:            { label: 'Client',             emoji: '✅', cards: 'cardsClient',      count: 'countClient' },
  cold:              { label: 'Cold',               emoji: '❄️', cards: null,                count: 'countCold' },
};

const ACTIVITY_ICONS = {
  dm_received: '📩',
  dm_sent: '📤',
  lead_magnet: '🧲',
  keyword_trigger: '🔑',
  call_booked: '📞',
  call_completed: '✅',
  became_client: '🎉',
  follow_up: '👋',
  stage_change: '➡️',
  note: '📝',
  tidycal_booked: '📅',
  tidycal_cancelled: '❌',
  tidycal_rescheduled: '🔄',
  booking_link_sent: '🔗',
  follow_up_email: '📧',
  follow_up_dm: '💬',
};

// Default TidyCal booking link — update this to your actual link
const DEFAULT_BOOKING_LINK = 'https://tidycal.com/chloeprent/30-minute-meeting';

let allSequences = [];

// ══════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'crm',
    section: 'staff',
    requiredRole: 'staff',
    onReady: async (state) => {
      authState = state;
      if (initialized) return;
      initialized = true;

      await loadData();
      render();
      setupEventListeners();
    }
  });
});

async function loadData() {
  try {
    [allContacts, allSequences] = await Promise.all([
      crmService.getContacts(),
      crmService.getSequences(),
    ]);
  } catch (error) {
    console.error('Failed to load contacts:', error);
    showToast('Failed to load contacts: ' + error.message, 'error');
  }
}

// ══════════════════════════════════════════
// RENDERING
// ══════════════════════════════════════════

function render() {
  renderStats();
  renderPipeline();
  renderTable();
  renderFollowUps();
  renderUpcomingCalls();
}

function renderStats() {
  const stats = { total: allContacts.length, in_conversation: 0, call_booked: 0, client: 0 };
  for (const c of allContacts) {
    if (c.stage === 'in_conversation') stats.in_conversation++;
    if (c.stage === 'call_booked') stats.call_booked++;
    if (c.stage === 'client') stats.client++;
  }
  document.getElementById('statTotal').textContent = stats.total;
  document.getElementById('statConversation').textContent = stats.in_conversation;
  document.getElementById('statCallsBooked').textContent = stats.call_booked;
  document.getElementById('statClients').textContent = stats.client;
}

function renderPipeline() {
  const searchQuery = (document.getElementById('crmSearch')?.value || '').toLowerCase();
  const filterStage = document.getElementById('crmFilterStage')?.value || '';

  // Clear all pipeline columns
  for (const [stage, config] of Object.entries(STAGES)) {
    if (config.cards) document.getElementById(config.cards).innerHTML = '';
  }
  document.getElementById('coldList').innerHTML = '';

  // Counts per stage
  const counts = {};
  for (const stage of Object.keys(STAGES)) counts[stage] = 0;

  for (const contact of allContacts) {
    // Apply search filter
    if (searchQuery) {
      const searchable = `${contact.ig_username || ''} ${contact.full_name || ''} ${contact.email || ''}`.toLowerCase();
      if (!searchable.includes(searchQuery)) continue;
    }
    // Apply stage filter
    if (filterStage && contact.stage !== filterStage) continue;

    counts[contact.stage] = (counts[contact.stage] || 0) + 1;

    if (contact.stage === 'cold') {
      document.getElementById('coldList').innerHTML += renderColdItem(contact);
    } else if (STAGES[contact.stage]?.cards) {
      document.getElementById(STAGES[contact.stage].cards).innerHTML += renderCard(contact);
    }
  }

  // Update counts
  for (const [stage, config] of Object.entries(STAGES)) {
    const el = document.getElementById(config.count);
    if (el) el.textContent = counts[stage] || 0;
  }
}

function renderCard(contact) {
  const name = contact.full_name || contact.ig_username || 'Unknown';
  const ig = contact.ig_username ? `@${contact.ig_username.replace(/^@/, '')}` : '';
  const today = new Date().toISOString().split('T')[0];
  const isOverdue = contact.next_follow_up && contact.next_follow_up < today;
  const hasFollowUp = contact.next_follow_up && !isOverdue;
  const timeAgo = formatTimeAgo(contact.last_activity_at);
  const keyword = contact.keyword_used ? `<span class="crm-card-keyword">${contact.keyword_used}</span>` : '';

  // Show call date for call_booked contacts
  let callInfo = '';
  if (contact.call_scheduled_at) {
    const callDate = new Date(contact.call_scheduled_at);
    const isToday = callDate.toISOString().split('T')[0] === today;
    const label = isToday ? 'Today' : callDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = callDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    callInfo = `<div class="crm-card-call ${isToday ? 'today' : ''}">📞 ${label} ${time}</div>`;
  }

  // Show sequence indicator
  let seqBadge = '';
  if (contact.follow_up_sequence && !contact.follow_up_paused) {
    seqBadge = `<span class="crm-card-keyword" style="background:#e8f5e9; color:#2e7d32;">seq ${contact.follow_up_step + 1}</span>`;
  }

  return `
    <div class="crm-card ${isOverdue ? 'overdue' : ''} ${hasFollowUp ? 'has-follow-up' : ''}"
         data-contact-id="${contact.id}" onclick="window.crmOpenDetail(${contact.id})">
      <div class="crm-card-name">${name}</div>
      ${ig ? `<div class="crm-card-ig">${ig}</div>` : ''}
      ${callInfo}
      <div class="crm-card-meta">
        <span>${timeAgo}</span>
        ${keyword}${seqBadge}
      </div>
    </div>
  `;
}

function renderColdItem(contact) {
  const name = contact.full_name || contact.ig_username || 'Unknown';
  const ig = contact.ig_username ? ` (@${contact.ig_username.replace(/^@/, '')})` : '';
  const timeAgo = formatTimeAgo(contact.last_activity_at);

  return `
    <div class="crm-cold-item" onclick="window.crmOpenDetail(${contact.id})">
      <span>${name}${ig}</span>
      <span class="text-muted">${timeAgo}</span>
    </div>
  `;
}

function renderTable() {
  const tbody = document.getElementById('contactsTableBody');
  const searchQuery = (document.getElementById('crmSearch')?.value || '').toLowerCase();
  const filterStage = document.getElementById('crmFilterStage')?.value || '';

  let filtered = allContacts;
  if (searchQuery) {
    filtered = filtered.filter(c => {
      const s = `${c.ig_username || ''} ${c.full_name || ''} ${c.email || ''}`.toLowerCase();
      return s.includes(searchQuery);
    });
  }
  if (filterStage) {
    filtered = filtered.filter(c => c.stage === filterStage);
  }

  document.getElementById('contactListCount').textContent = filtered.length;

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:#999; padding:1.5rem;">No contacts found</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(c => {
    const name = c.full_name || c.ig_username || 'Unknown';
    const ig = c.ig_username ? `@${c.ig_username.replace(/^@/, '')}` : '-';
    const stageConfig = STAGES[c.stage] || {};
    const magnet = c.lead_magnet_sent ? '✅' : '—';
    const timeAgo = formatTimeAgo(c.last_activity_at);
    const followUp = c.next_follow_up || '—';

    return `
      <tr style="cursor:pointer;" onclick="window.crmOpenDetail(${c.id})">
        <td><strong>${name}</strong><br><span class="text-muted" style="font-size:0.75rem;">${ig}</span></td>
        <td><span class="stage-badge ${c.stage}">${stageConfig.emoji || ''} ${stageConfig.label || c.stage}</span></td>
        <td>${c.source || '-'}</td>
        <td style="text-align:center;">${magnet}</td>
        <td>${timeAgo}</td>
        <td>${followUp}</td>
        <td><button class="btn-small" onclick="event.stopPropagation(); window.crmEditContact(${c.id})">Edit</button></td>
      </tr>
    `;
  }).join('');
}

function renderFollowUps() {
  const today = new Date().toISOString().split('T')[0];
  const due = allContacts.filter(c =>
    c.next_follow_up && c.next_follow_up <= today && c.stage !== 'client' && c.stage !== 'cold'
  );

  const alertEl = document.getElementById('followUpAlert');
  const listEl = document.getElementById('followUpList');
  const countEl = document.getElementById('followUpCount');

  if (!due.length) {
    alertEl.classList.add('hidden');
    return;
  }

  alertEl.classList.remove('hidden');
  countEl.textContent = due.length;
  listEl.innerHTML = due.map(c => {
    const name = c.full_name || c.ig_username || 'Unknown';
    const stageConfig = STAGES[c.stage] || {};
    return `
      <div class="crm-follow-up-item" onclick="window.crmOpenDetail(${c.id})">
        <span>${stageConfig.emoji || ''} ${name}</span>
        <span class="text-muted">${c.next_follow_up}</span>
      </div>
    `;
  }).join('');
}

function renderUpcomingCalls() {
  const now = new Date();
  const weekFromNow = new Date(Date.now() + 7 * 86400000);
  const upcoming = allContacts.filter(c =>
    c.call_scheduled_at && new Date(c.call_scheduled_at) >= now && new Date(c.call_scheduled_at) <= weekFromNow
  ).sort((a, b) => new Date(a.call_scheduled_at) - new Date(b.call_scheduled_at));

  const alertEl = document.getElementById('upcomingCallsAlert');
  const listEl = document.getElementById('upcomingCallsList');
  const countEl = document.getElementById('upcomingCallsCount');

  if (!upcoming.length) {
    alertEl.classList.add('hidden');
    return;
  }

  alertEl.classList.remove('hidden');
  countEl.textContent = upcoming.length;
  listEl.innerHTML = upcoming.map(c => {
    const name = c.full_name || c.ig_username || 'Unknown';
    const callDate = new Date(c.call_scheduled_at);
    const today = new Date().toISOString().split('T')[0];
    const isToday = callDate.toISOString().split('T')[0] === today;
    const dayLabel = isToday ? 'Today' : callDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const time = callDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `
      <div class="crm-follow-up-item" onclick="window.crmOpenDetail(${c.id})">
        <span>${isToday ? '🔴' : '📞'} ${name}</span>
        <span class="text-muted">${dayLabel} ${time}</span>
      </div>
    `;
  }).join('');
}

// ══════════════════════════════════════════
// CONTACT MODAL (Add / Edit)
// ══════════════════════════════════════════

function openContactModal(contact = null) {
  const modal = document.getElementById('contactModal');
  const title = document.getElementById('contactModalTitle');

  // Reset form
  document.getElementById('contactForm').reset();
  document.getElementById('contactId').value = '';

  if (contact) {
    title.textContent = 'Edit Contact';
    document.getElementById('contactId').value = contact.id;
    document.getElementById('contactIg').value = contact.ig_username || '';
    document.getElementById('contactName').value = contact.full_name || '';
    document.getElementById('contactEmail').value = contact.email || '';
    document.getElementById('contactPhone').value = contact.phone || '';
    document.getElementById('contactStage').value = contact.stage || 'new_lead';
    document.getElementById('contactSource').value = contact.source || 'instagram';
    document.getElementById('contactKeyword').value = contact.keyword_used || '';
    document.getElementById('contactFollowUp').value = contact.next_follow_up || '';
    document.getElementById('contactNotes').value = contact.notes || '';
  } else {
    title.textContent = 'Add Contact';
  }

  modal.classList.remove('hidden');
}

async function saveContact() {
  const id = document.getElementById('contactId').value;
  const data = {
    ig_username: document.getElementById('contactIg').value.trim() || null,
    full_name: document.getElementById('contactName').value.trim() || null,
    email: document.getElementById('contactEmail').value.trim() || null,
    phone: document.getElementById('contactPhone').value.trim() || null,
    stage: document.getElementById('contactStage').value,
    source: document.getElementById('contactSource').value,
    keyword_used: document.getElementById('contactKeyword').value.trim() || null,
    next_follow_up: document.getElementById('contactFollowUp').value || null,
    notes: document.getElementById('contactNotes').value.trim() || null,
  };

  try {
    if (id) {
      const updated = await crmService.updateContact(parseInt(id), data);
      const idx = allContacts.findIndex(c => c.id === parseInt(id));
      if (idx !== -1) allContacts[idx] = updated;
      showToast('Contact updated', 'success');
    } else {
      const created = await crmService.createContact(data);
      allContacts.unshift(created);
      await crmService.logActivity(created.id, 'note', 'Contact added to CRM');
      showToast('Contact added!', 'success');
    }

    document.getElementById('contactModal').classList.add('hidden');
    render();
  } catch (error) {
    showToast('Error saving: ' + error.message, 'error');
  }
}

// ══════════════════════════════════════════
// DETAIL MODAL
// ══════════════════════════════════════════

async function openDetail(contactId) {
  const contact = allContacts.find(c => c.id === contactId);
  if (!contact) return;

  currentDetailContact = contact;
  const modal = document.getElementById('detailModal');
  const stageConfig = STAGES[contact.stage] || {};

  // Title
  document.getElementById('detailTitle').textContent =
    `${stageConfig.emoji || ''} ${contact.full_name || contact.ig_username || 'Unknown'}`;

  // Info grid
  const igLink = contact.ig_username
    ? `<a href="https://instagram.com/${contact.ig_username.replace(/^@/, '')}" target="_blank" style="color: var(--accent);">@${contact.ig_username.replace(/^@/, '')}</a>`
    : '—';

  document.getElementById('detailInfo').innerHTML = `
    <div class="crm-detail-field"><label>Instagram</label><p>${igLink}</p></div>
    <div class="crm-detail-field"><label>Name</label><p>${contact.full_name || '—'}</p></div>
    <div class="crm-detail-field"><label>Email</label><p>${contact.email || '—'}</p></div>
    <div class="crm-detail-field"><label>Phone</label><p>${contact.phone || '—'}</p></div>
    <div class="crm-detail-field"><label>Stage</label><p><span class="stage-badge ${contact.stage}">${stageConfig.label}</span></p></div>
    <div class="crm-detail-field"><label>Source</label><p>${contact.source || '—'}</p></div>
    <div class="crm-detail-field"><label>Keyword</label><p>${contact.keyword_used || '—'}</p></div>
    <div class="crm-detail-field"><label>Lead Magnet</label><p>${contact.lead_magnet_sent ? '✅ Sent' : '—'}</p></div>
    <div class="crm-detail-field"><label>First Contact</label><p>${formatDate(contact.first_contact_at)}</p></div>
    <div class="crm-detail-field"><label>Next Follow-up</label><p>${contact.next_follow_up || '—'}</p></div>
    ${contact.call_scheduled_at ? `<div class="crm-detail-field"><label>Call Scheduled</label><p>📞 ${formatDate(contact.call_scheduled_at)}</p></div>` : ''}
    ${contact.follow_up_sequence ? `<div class="crm-detail-field"><label>Sequence</label><p>${contact.follow_up_sequence.replace(/_/g, ' ')} (step ${(contact.follow_up_step || 0) + 1}) ${contact.follow_up_paused ? '⏸️' : '▶️'}</p></div>` : ''}
    ${contact.notes ? `<div class="crm-detail-field" style="grid-column: 1/-1;"><label>Notes</label><p>${contact.notes}</p></div>` : ''}
  `;

  // Stage action buttons
  const actions = document.getElementById('detailStageActions');
  actions.innerHTML = '<span style="font-size:0.75rem; color:var(--text-muted); margin-right:0.5rem;">Move to:</span>' +
    Object.entries(STAGES).map(([stage, config]) => {
      const isActive = contact.stage === stage;
      return `<button class="crm-stage-btn ${isActive ? 'active' : ''}"
                onclick="window.crmMoveStage(${contact.id}, '${stage}')"
                ${isActive ? 'disabled' : ''}>
                ${config.emoji} ${config.label}
              </button>`;
    }).join('');

  // ── Booking & Follow-up section ──
  renderDetailBooking(contact);

  // Load activity
  try {
    const activities = await crmService.getActivity(contactId);
    const logEl = document.getElementById('activityLog');

    if (!activities.length) {
      logEl.innerHTML = '<p class="text-muted" style="font-size:0.85rem;">No activity yet</p>';
    } else {
      logEl.innerHTML = activities.map(a => {
        const icon = ACTIVITY_ICONS[a.activity_type] || '📌';
        return `
          <div class="crm-activity-item">
            <span class="crm-activity-icon">${icon}</span>
            <div class="crm-activity-content">
              <p>${a.description || a.activity_type}</p>
              <span class="crm-activity-time">${formatDate(a.created_at)}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    document.getElementById('activityLog').innerHTML = '<p class="text-muted">Failed to load activity</p>';
  }

  modal.classList.remove('hidden');
}

async function renderDetailBooking(contact) {
  // Booking link input
  const linkInput = document.getElementById('bookingLinkInput');
  linkInput.value = contact.tidycal_booking_url || DEFAULT_BOOKING_LINK;

  // Populate sequence selector
  const seqSelect = document.getElementById('sequenceSelect');
  seqSelect.innerHTML = '<option value="">Start a follow-up sequence...</option>' +
    allSequences.map(s =>
      `<option value="${s.name}" ${contact.follow_up_sequence === s.name ? 'selected' : ''}>${s.description || s.name.replace(/_/g, ' ')}</option>`
    ).join('');

  // Show pause/resume buttons based on state
  const pauseBtn = document.getElementById('pauseSequenceBtn');
  const resumeBtn = document.getElementById('resumeSequenceBtn');
  const startBtn = document.getElementById('startSequenceBtn');

  if (contact.follow_up_sequence && !contact.follow_up_paused) {
    pauseBtn.classList.remove('hidden');
    resumeBtn.classList.add('hidden');
    startBtn.classList.add('hidden');
  } else if (contact.follow_up_sequence && contact.follow_up_paused) {
    pauseBtn.classList.add('hidden');
    resumeBtn.classList.remove('hidden');
    startBtn.classList.add('hidden');
  } else {
    pauseBtn.classList.add('hidden');
    resumeBtn.classList.add('hidden');
    startBtn.classList.remove('hidden');
  }

  // Current step preview
  const stepPreview = document.getElementById('currentStepPreview');
  if (contact.follow_up_sequence && !contact.follow_up_paused) {
    try {
      const step = await crmService.getCurrentStep(contact, linkInput.value);
      if (step) {
        document.getElementById('stepLabel').textContent = `Step ${step.stepNumber}/${step.totalSteps}`;
        document.getElementById('stepSequenceName').textContent = step.sequenceDescription || step.sequenceName.replace(/_/g, ' ');
        document.getElementById('stepMessage').textContent = step.message;
        stepPreview.classList.remove('hidden');
      } else {
        stepPreview.classList.add('hidden');
      }
    } catch {
      stepPreview.classList.add('hidden');
    }
  } else {
    stepPreview.classList.add('hidden');
  }

  // Call info
  const callSection = document.getElementById('callInfoSection');
  if (contact.call_scheduled_at) {
    const callDate = new Date(contact.call_scheduled_at);
    const now = new Date();
    const isPast = callDate < now;
    const label = isPast ? 'Call was' : 'Call scheduled';
    const dateStr = callDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const timeStr = callDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    document.getElementById('callBadge').innerHTML = `${isPast ? '✅' : '📞'} ${label}: ${dateStr} at ${timeStr}`;
    callSection.classList.remove('hidden');
  } else {
    callSection.classList.add('hidden');
  }
}

async function sendBookingLink() {
  if (!currentDetailContact) return;
  const link = document.getElementById('bookingLinkInput').value.trim();
  if (!link) { showToast('Enter a booking link first', 'error'); return; }

  try {
    // Copy to clipboard
    await navigator.clipboard.writeText(link);
    // Log it in CRM
    await crmService.logBookingLinkSent(currentDetailContact.id, link);
    const idx = allContacts.findIndex(c => c.id === currentDetailContact.id);
    if (idx !== -1) allContacts[idx].tidycal_booking_url = link;
    showToast('Booking link copied & logged!', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function startSequence() {
  if (!currentDetailContact) return;
  const seqName = document.getElementById('sequenceSelect').value;
  if (!seqName) { showToast('Select a sequence first', 'error'); return; }

  try {
    const updated = await crmService.startSequence(currentDetailContact.id, seqName);
    const idx = allContacts.findIndex(c => c.id === currentDetailContact.id);
    if (idx !== -1) allContacts[idx] = updated;
    showToast('Follow-up sequence started!', 'success');
    render();
    await openDetail(currentDetailContact.id);
  } catch (err) {
    showToast('Failed to start sequence: ' + err.message, 'error');
  }
}

async function pauseSequence() {
  if (!currentDetailContact) return;
  try {
    const updated = await crmService.pauseSequence(currentDetailContact.id);
    const idx = allContacts.findIndex(c => c.id === currentDetailContact.id);
    if (idx !== -1) allContacts[idx] = updated;
    showToast('Sequence paused', 'success');
    render();
    await openDetail(currentDetailContact.id);
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function resumeSequence() {
  if (!currentDetailContact) return;
  try {
    const updated = await crmService.resumeSequence(currentDetailContact.id);
    const idx = allContacts.findIndex(c => c.id === currentDetailContact.id);
    if (idx !== -1) allContacts[idx] = updated;
    showToast('Sequence resumed', 'success');
    render();
    await openDetail(currentDetailContact.id);
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function markStepSent() {
  if (!currentDetailContact) return;
  const step = await crmService.getCurrentStep(currentDetailContact, document.getElementById('bookingLinkInput').value);
  if (!step) return;

  try {
    const updated = await crmService.logFollowUpSent(
      currentDetailContact.id,
      step.type,
      `[${step.sequenceName} step ${step.stepNumber}] ${step.message.substring(0, 100)}...`
    );
    const idx = allContacts.findIndex(c => c.id === currentDetailContact.id);
    if (idx !== -1) allContacts[idx] = updated;
    showToast(`Step ${step.stepNumber} marked as sent!`, 'success');
    render();
    await openDetail(currentDetailContact.id);
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function copyStepMessage() {
  const msg = document.getElementById('stepMessage')?.textContent;
  if (!msg) return;
  try {
    await navigator.clipboard.writeText(msg);
    showToast('Message copied!', 'success');
  } catch {
    showToast('Failed to copy', 'error');
  }
}

async function skipStep() {
  if (!currentDetailContact) return;
  try {
    const updated = await crmService.advanceSequence(currentDetailContact.id);
    const idx = allContacts.findIndex(c => c.id === currentDetailContact.id);
    if (idx !== -1 && updated) allContacts[idx] = updated;
    showToast('Step skipped', 'success');
    render();
    await openDetail(currentDetailContact.id);
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function addActivityNote() {
  if (!currentDetailContact) return;
  const input = document.getElementById('newActivityNote');
  const note = input.value.trim();
  if (!note) return;

  try {
    await crmService.logActivity(currentDetailContact.id, 'note', note);
    input.value = '';
    showToast('Note added', 'success');
    // Refresh detail
    await openDetail(currentDetailContact.id);
  } catch (err) {
    showToast('Failed to add note: ' + err.message, 'error');
  }
}

async function moveStage(contactId, newStage) {
  try {
    const updated = await crmService.moveToStage(contactId, newStage);
    const idx = allContacts.findIndex(c => c.id === contactId);
    if (idx !== -1) allContacts[idx] = updated;

    const stageConfig = STAGES[newStage] || {};
    showToast(`Moved to ${stageConfig.emoji} ${stageConfig.label}`, 'success');

    render();
    // Refresh the detail modal if it's open
    if (currentDetailContact?.id === contactId) {
      await openDetail(contactId);
    }
  } catch (err) {
    showToast('Failed to move: ' + err.message, 'error');
  }
}

async function deleteContact() {
  if (!currentDetailContact) return;
  if (!confirm(`Delete ${currentDetailContact.full_name || currentDetailContact.ig_username || 'this contact'}? This cannot be undone.`)) return;

  try {
    await crmService.deleteContact(currentDetailContact.id);
    allContacts = allContacts.filter(c => c.id !== currentDetailContact.id);
    document.getElementById('detailModal').classList.add('hidden');
    currentDetailContact = null;
    render();
    showToast('Contact deleted', 'success');
  } catch (err) {
    showToast('Failed to delete: ' + err.message, 'error');
  }
}

// ══════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════

function setupEventListeners() {
  // Add contact button
  document.getElementById('addContactBtn')?.addEventListener('click', () => openContactModal());

  // Save contact
  document.getElementById('saveContactBtn')?.addEventListener('click', saveContact);

  // Cancel / close modals
  document.getElementById('cancelContactBtn')?.addEventListener('click', () => {
    document.getElementById('contactModal').classList.add('hidden');
  });
  document.getElementById('closeContactModal')?.addEventListener('click', () => {
    document.getElementById('contactModal').classList.add('hidden');
  });
  document.getElementById('closeDetailModal')?.addEventListener('click', () => {
    document.getElementById('detailModal').classList.add('hidden');
  });

  // Booking & follow-up actions
  document.getElementById('sendBookingLinkBtn')?.addEventListener('click', sendBookingLink);
  document.getElementById('startSequenceBtn')?.addEventListener('click', startSequence);
  document.getElementById('pauseSequenceBtn')?.addEventListener('click', pauseSequence);
  document.getElementById('resumeSequenceBtn')?.addEventListener('click', resumeSequence);
  document.getElementById('markSentBtn')?.addEventListener('click', markStepSent);
  document.getElementById('copyMessageBtn')?.addEventListener('click', copyStepMessage);
  document.getElementById('skipStepBtn')?.addEventListener('click', skipStep);

  // Detail modal actions
  document.getElementById('editFromDetailBtn')?.addEventListener('click', () => {
    if (!currentDetailContact) return;
    document.getElementById('detailModal').classList.add('hidden');
    openContactModal(currentDetailContact);
  });
  document.getElementById('deleteContactBtn')?.addEventListener('click', deleteContact);
  document.getElementById('addActivityNoteBtn')?.addEventListener('click', addActivityNote);

  // Enter key on activity note
  document.getElementById('newActivityNote')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addActivityNote(); }
  });

  // Search & filter (debounced)
  let searchTimeout;
  document.getElementById('crmSearch')?.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(render, 250);
  });
  document.getElementById('crmFilterStage')?.addEventListener('change', render);
}

// ══════════════════════════════════════════
// GLOBAL FUNCTIONS (called from HTML onclick)
// ══════════════════════════════════════════

window.crmOpenDetail = (id) => openDetail(id);
window.crmEditContact = (id) => {
  const contact = allContacts.find(c => c.id === id);
  if (contact) openContactModal(contact);
};
window.crmMoveStage = (id, stage) => moveStage(id, stage);

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════

function formatTimeAgo(dateStr) {
  if (!dateStr) return '—';
  const now = new Date();
  const date = new Date(dateStr);
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}
