/**
 * SMS Messages - Full message list and filtering
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../shared/supabase.js';
import { initAdminPage, showToast } from '../../shared/admin-shell.js';
import { isDemoUser, redactString } from '../../shared/demo-redact.js';

// =============================================
// STATE
// =============================================

let authState = null;
let allMessages = [];
let allPeople = [];

const SEND_SMS_URL = `${SUPABASE_URL}/functions/v1/send-sms`;
const SEND_WHATSAPP_URL = `${SUPABASE_URL}/functions/v1/send-whatsapp`;

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'sms',
    requiredRole: 'staff',
    section: 'staff',
    onReady: async (state) => {
      await loadAllData();
      setupEventListeners();
    }
  });
});

// =============================================
// DATA LOADING
// =============================================

async function loadAllData() {
  await Promise.all([
    loadMessages(),
    loadPeople()
  ]);
  renderMessages();
}

async function loadMessages() {
  try {
    const { data: messages, error } = await supabase
      .from('sms_messages')
      .select(`*, person:person_id(id, first_name, last_name, phone)`)
      .order('created_at', { ascending: false });

    if (error) throw error;
    allMessages = messages || [];
  } catch (error) {
    console.error('Error loading messages:', error);
    showToast('Failed to load messages', 'error');
  }
}

async function loadPeople() {
  try {
    const { data: people, error } = await supabase
      .from('people')
      .select('id, first_name, last_name')
      .order('first_name', { ascending: true });

    if (error) throw error;
    allPeople = people || [];

    // Populate filter dropdown
    const filterPerson = document.getElementById('filterPerson');
    filterPerson.innerHTML = '<option value="">All People</option>' +
      allPeople.map(p => {
        const rawName = `${p.first_name || ''} ${p.last_name || ''}`.trim();
        const name = isDemoUser() ? redactString(rawName, 'name') : rawName;
        return `<option value="${p.id}">${name}</option>`;
      }).join('');
  } catch (error) {
    console.error('Error loading people:', error);
  }
}

// =============================================
// RENDERING
// =============================================

function renderMessages() {
  const container = document.getElementById('messagesList');

  // Get filter values
  const channelFilter = document.getElementById('filterChannel').value;
  const directionFilter = document.getElementById('filterDirection').value;
  const personFilter = document.getElementById('filterPerson').value;
  const searchFilter = document.getElementById('filterSearch').value.toLowerCase();

  // Filter messages
  let filteredMessages = allMessages;

  if (channelFilter) {
    filteredMessages = filteredMessages.filter(m => (m.channel || 'sms') === channelFilter);
  }

  if (directionFilter) {
    filteredMessages = filteredMessages.filter(m => m.direction === directionFilter);
  }

  if (personFilter) {
    filteredMessages = filteredMessages.filter(m => m.person_id === personFilter);
  }

  if (searchFilter) {
    filteredMessages = filteredMessages.filter(m =>
      m.body?.toLowerCase().includes(searchFilter)
    );
  }

  if (filteredMessages.length === 0) {
    container.innerHTML = '<p class="text-muted" style="padding: 2rem; text-align: center;">No messages found.</p>';
    return;
  }

  // Group messages by date
  const messagesByDate = {};
  filteredMessages.forEach(msg => {
    const date = new Date(msg.created_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    if (!messagesByDate[date]) messagesByDate[date] = [];
    messagesByDate[date].push(msg);
  });

  container.innerHTML = Object.entries(messagesByDate).map(([date, messages]) => {
    const messagesHtml = messages.map(msg => {
      const rawSmsSender = msg.person
        ? `${msg.person.first_name || ''} ${msg.person.last_name || ''}`.trim()
        : msg.from_number || msg.to_number || 'Unknown';
      const senderName = isDemoUser() ? redactString(rawSmsSender, 'name') : rawSmsSender;
      const time = new Date(msg.created_at).toLocaleString('en-US', {
        hour: 'numeric',
        minute: '2-digit'
      });
      const isInbound = msg.direction === 'inbound';
      const directionIcon = isInbound
        ? '<svg width="14" height="14" style="color: #3b82f6;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>'
        : '<svg width="14" height="14" style="color: #10b981;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';

      const isWhatsApp = (msg.channel || 'sms') === 'whatsapp';
      const channelBadge = isWhatsApp
        ? '<span style="font-size: 0.65rem; background: #dcfce7; color: #166534; padding: 0.125rem 0.375rem; border-radius: 4px; margin-left: 0.5rem;">WA</span>'
        : '<span style="font-size: 0.65rem; background: #dbeafe; color: #1e40af; padding: 0.125rem 0.375rem; border-radius: 4px; margin-left: 0.5rem;">SMS</span>';

      const statusBadge = msg.status === 'test'
        ? '<span style="font-size: 0.7rem; background: #fef3c7; color: #92400e; padding: 0.125rem 0.375rem; border-radius: 4px; margin-left: 0.5rem;">TEST</span>'
        : '';

      const clickHandler = msg.person_id
        ? `onclick="window.openComposeSmsModal('${msg.person_id}')"`
        : '';

      return `
        <div style="padding: 1rem; border-bottom: 1px solid var(--border-color); cursor: ${msg.person_id ? 'pointer' : 'default'}; transition: background 0.15s;" ${clickHandler} onmouseenter="this.style.background='#fafafa'" onmouseleave="this.style.background='transparent'">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              ${directionIcon}
              <strong style="font-size: 0.9rem;${isDemoUser() ? ' font-family: ui-monospace, monospace;' : ''}">${senderName}</strong>
              ${channelBadge}${statusBadge}
            </div>
            <span class="text-muted" style="font-size: 0.75rem;">${time}</span>
          </div>
          <div style="font-size: 0.9rem; color: var(--text-color); margin-left: 1.75rem;">${escapeHtml(msg.body || '')}</div>
          ${msg.from_number !== msg.person?.phone && msg.from_number ?
            `<div style="font-size: 0.75rem; color: var(--text-muted); margin-left: 1.75rem; margin-top: 0.25rem;">From: ${msg.from_number}</div>` : ''}
          ${msg.to_number && !isInbound ?
            `<div style="font-size: 0.75rem; color: var(--text-muted); margin-left: 1.75rem; margin-top: 0.25rem;">To: ${msg.to_number}</div>` : ''}
        </div>
      `;
    }).join('');

    return `
      <div>
        <div style="padding: 0.75rem 1rem; background: #f9fafb; border-bottom: 1px solid var(--border-color); font-weight: 600; font-size: 0.85rem; color: var(--text-muted);">
          ${date}
        </div>
        ${messagesHtml}
      </div>
    `;
  }).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =============================================
// EVENT LISTENERS
// =============================================

function setupEventListeners() {
  // Filters
  document.getElementById('filterChannel')?.addEventListener('change', renderMessages);
  document.getElementById('filterDirection')?.addEventListener('change', renderMessages);
  document.getElementById('filterPerson')?.addEventListener('change', renderMessages);
  document.getElementById('filterSearch')?.addEventListener('input', renderMessages);

  // Compose button
  document.getElementById('composeMessageBtn')?.addEventListener('click', () => openComposeSmsModal());

  // Modal controls
  document.getElementById('closeComposeSmsModal')?.addEventListener('click', closeComposeSmsModal);
  document.getElementById('cancelComposeSmsBtn')?.addEventListener('click', closeComposeSmsModal);
  document.getElementById('sendSmsBtn')?.addEventListener('click', handleSendSms);

  // Recipient selection
  document.getElementById('smsRecipientSelect')?.addEventListener('change', async (e) => {
    const personId = e.target.value;
    if (personId) {
      await loadSmsConversation(personId);
    } else {
      document.getElementById('smsConversationSection').classList.add('hidden');
    }
  });

  // Character counter
  document.getElementById('smsComposeBody')?.addEventListener('input', (e) => {
    const length = e.target.value.length;
    document.getElementById('smsCharCount').textContent = length;
    const segments = Math.ceil(length / 160) || 0;
    document.getElementById('smsSegmentCount').textContent = segments;
  });
}

// =============================================
// SMS MODAL
// =============================================

async function openComposeSmsModal(presetPersonId = null) {
  const modal = document.getElementById('composeSmsModal');
  const select = document.getElementById('smsRecipientSelect');
  const bodyInput = document.getElementById('smsComposeBody');

  // Reset
  bodyInput.value = '';
  document.getElementById('smsCharCount').textContent = '0';
  document.getElementById('smsSegmentCount').textContent = '0';
  document.getElementById('smsConversationSection').classList.add('hidden');

  // Populate recipients (get active tenants)
  const tenants = await getActiveTenants();
  select.innerHTML = '<option value="">Select a tenant...</option>' +
    tenants.map(t => {
      const phone = t.phone ? ` (${t.phone})` : ' (no phone)';
      return `<option value="${t.id}" ${!t.phone ? 'disabled' : ''} ${t.id === presetPersonId ? 'selected' : ''}>${t.first_name || ''} ${t.last_name || ''}${phone}</option>`;
    }).join('');

  modal.classList.remove('hidden');

  // If preset, load conversation
  if (presetPersonId) {
    await loadSmsConversation(presetPersonId);
  }
}

function closeComposeSmsModal() {
  document.getElementById('composeSmsModal').classList.add('hidden');
}

async function getActiveTenants() {
  const { data: assignments, error } = await supabase
    .from('assignments')
    .select(`
      id,
      person:person_id(id, first_name, last_name, phone, email)
    `)
    .eq('status', 'active')
    .eq('type', 'dwelling');

  if (error) {
    console.error('Error loading active tenants:', error);
    return [];
  }

  // Deduplicate by person_id
  const seen = new Set();
  return (assignments || [])
    .filter(a => a.person && !seen.has(a.person.id) && seen.add(a.person.id))
    .map(a => a.person);
}

async function loadSmsConversation(personId) {
  const section = document.getElementById('smsConversationSection');
  const thread = document.getElementById('smsConversationThread');

  const { data: messages, error } = await supabase
    .from('sms_messages')
    .select('*')
    .eq('person_id', personId)
    .order('created_at', { ascending: true });

  if (error || !messages || messages.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  thread.innerHTML = messages.map(msg => {
    const isOutbound = msg.direction === 'outbound';
    const isWA = (msg.channel || 'sms') === 'whatsapp';
    const time = new Date(msg.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const statusBadge = msg.status === 'test' ? ' <span style="color: #f59e0b; font-size: 0.7rem;">[TEST]</span>' : '';
    const chBadge = isWA ? ' <span style="color: #166534; font-size: 0.65rem;">WA</span>' : '';
    return `
      <div style="margin-bottom: 0.5rem; text-align: ${isOutbound ? 'right' : 'left'};">
        <div style="display: inline-block; max-width: 80%; padding: 0.5rem 0.75rem; border-radius: 12px; font-size: 0.85rem; background: ${isOutbound ? (isWA ? '#d1fae5' : '#dcf8c6') : '#f0f0f0'}; text-align: left;">
          ${escapeHtml(msg.body)}
        </div>
        <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">${time}${chBadge}${statusBadge}</div>
      </div>
    `;
  }).join('');

  // Scroll to bottom
  thread.scrollTop = thread.scrollHeight;
}

async function handleSendSms() {
  const select = document.getElementById('smsRecipientSelect');
  const bodyInput = document.getElementById('smsComposeBody');
  const sendBtn = document.getElementById('sendSmsBtn');
  const channelSelect = document.getElementById('composeChannelSelect');
  const personId = select.value;
  const messageBody = bodyInput.value.trim();
  const channel = channelSelect?.value || 'sms';

  if (!personId) return showToast('Select a recipient', 'error');
  if (!messageBody) return showToast('Enter a message', 'error');

  // Get person phone
  const { data: person, error: personError } = await supabase
    .from('people')
    .select('id, first_name, last_name, phone')
    .eq('id', personId)
    .single();

  if (personError || !person?.phone) {
    return showToast('Recipient has no phone number', 'error');
  }

  const formattedPhone = formatPhoneE164(person.phone);
  if (!formattedPhone) return showToast('Invalid phone number format', 'error');

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending...';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const authHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
    };
    const payload = {
      type: 'general',
      to: formattedPhone,
      data: { message: messageBody },
      person_id: personId,
    };

    const sendPromises = [];
    const channelsSent = [];

    // Send via SMS if channel is 'sms' or 'both'
    if (channel === 'sms' || channel === 'both') {
      sendPromises.push(
        fetch(SEND_SMS_URL, { method: 'POST', headers: authHeaders, body: JSON.stringify(payload) })
          .then(r => r.json().then(d => ({ ok: r.ok, data: d, channel: 'SMS' })))
      );
      channelsSent.push('SMS');
    }

    // Send via WhatsApp if channel is 'whatsapp' or 'both'
    if (channel === 'whatsapp' || channel === 'both') {
      sendPromises.push(
        fetch(SEND_WHATSAPP_URL, { method: 'POST', headers: authHeaders, body: JSON.stringify(payload) })
          .then(r => r.json().then(d => ({ ok: r.ok, data: d, channel: 'WhatsApp' })))
      );
      channelsSent.push('WhatsApp');
    }

    const results = await Promise.all(sendPromises);
    const failures = results.filter(r => !r.ok);
    const successes = results.filter(r => r.ok);

    if (failures.length > 0 && successes.length === 0) {
      throw new Error(failures.map(f => `${f.channel}: ${f.data.error}`).join('; '));
    }

    const testMode = successes.some(r => r.data.test_mode);
    const channelLabel = channelsSent.join(' & ');
    showToast(`${channelLabel} sent to ${person.first_name}${testMode ? ' (test mode)' : ''}${failures.length > 0 ? ` (${failures[0].channel} failed)` : ''}`, 'success');

    bodyInput.value = '';
    document.getElementById('smsCharCount').textContent = '0';
    document.getElementById('smsSegmentCount').textContent = '0';

    // Refresh conversation and message list
    await loadSmsConversation(personId);
    await loadMessages();
    renderMessages();
  } catch (error) {
    console.error('Error sending message:', error);
    showToast(`Failed to send: ${error.message}`, 'error');
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send Message';
  }
}

function formatPhoneE164(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (phone.startsWith('+') && digits.length >= 10) return `+${digits}`;
  return null;
}

// Make openComposeSmsModal available globally for inline onclick handlers
window.openComposeSmsModal = openComposeSmsModal;
