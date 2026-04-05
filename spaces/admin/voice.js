import { initAdminPage, showToast } from '../../shared/admin-shell.js';
import { voiceService } from '../../shared/voice-service.js';
import { supabase, SUPABASE_URL } from '../../shared/supabase.js';
import { isDemoUser, redactString } from '../../shared/demo-redact.js';

let authState = null;
let allAssistants = [];
let allCalls = [];

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'voice',
    requiredRole: 'staff',
    section: 'staff',
    onReady: async (state) => {
      setupWebhookUrls();
      await Promise.all([loadConfig(), loadPaiConfig(), loadAssistants(), loadCalls(), loadStats()]);
      setupEventListeners();
    }
  });
});

// =============================================
// WEBHOOK URLs
// =============================================

function setupWebhookUrls() {
  const serverUrl = `${SUPABASE_URL}/functions/v1/vapi-server`;
  const webhookUrl = `${SUPABASE_URL}/functions/v1/vapi-webhook`;
  document.getElementById('serverUrlValue').textContent = serverUrl;
  document.getElementById('webhookUrlValue').textContent = webhookUrl;
}

// =============================================
// CONFIG
// =============================================

async function loadConfig() {
  const config = await voiceService.getConfig();
  if (!config) return;

  document.getElementById('vapiApiKey').value = isDemoUser() ? redactString(config.api_key, 'password') : (config.api_key || '');
  document.getElementById('vapiPhoneNumberId').value = isDemoUser() ? redactString(config.phone_number_id, 'password') : (config.phone_number_id || '');
  document.getElementById('voiceTestMode').checked = config.test_mode || false;
  document.getElementById('voiceActive').checked = config.is_active || false;

  updateModeBadge(config);
}

function updateModeBadge(config) {
  const badge = document.getElementById('voiceModeBadge');
  if (!config.is_active) {
    badge.textContent = 'Inactive';
    badge.className = 'settings-badge';
  } else if (config.test_mode) {
    badge.textContent = 'Test Mode';
    badge.className = 'settings-badge';
  } else {
    badge.textContent = 'Live';
    badge.className = 'settings-badge live';
  }
}

// =============================================
// STATS
// =============================================

async function loadStats() {
  const stats = await voiceService.getStats();
  document.getElementById('statTotalCalls').textContent = stats.totalCalls;
  document.getElementById('statTotalMinutes').textContent = stats.totalMinutes;
  document.getElementById('statTotalCost').textContent = isDemoUser() ? redactString(`$${stats.totalCostDollars}`, 'amount') : `$${stats.totalCostDollars}`;
  document.getElementById('statTotalCost').classList.toggle('demo-redacted', isDemoUser());
}

// =============================================
// ASSISTANTS
// =============================================

async function loadAssistants() {
  allAssistants = await voiceService.listAssistants();
  renderAssistants();
}

function renderAssistants() {
  const container = document.getElementById('assistantsList');

  if (allAssistants.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: var(--text-muted);">
        <p>No voice assistants configured yet.</p>
        <p style="font-size: 0.85rem;">Create one to start handling inbound calls with AI.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = allAssistants.map(a => `
    <div class="voice-assistant-card ${a.is_default ? 'is-default' : ''} ${!a.is_active ? 'is-inactive' : ''}" data-id="${a.id}">
      <div class="voice-assistant-header">
        <div class="voice-assistant-name">
          ${a.name}
          ${a.is_default ? '<span class="settings-badge live">Default</span>' : ''}
          ${!a.is_active ? '<span class="settings-badge">Inactive</span>' : ''}
        </div>
        <div class="voice-assistant-actions">
          ${!a.is_default && a.is_active ? `<button class="btn-small" onclick="window._setDefault('${a.id}')">Set Default</button>` : ''}
          <button class="btn-small" onclick="window._editAssistant('${a.id}')">Edit</button>
        </div>
      </div>
      <div class="voice-assistant-details">
        <span>${a.model_name}</span>
        <span>${a.voice_provider}/${a.voice_id}</span>
        <span>Temp: ${a.temperature}</span>
        <span>Max: ${Math.round(a.max_duration_seconds / 60)}min</span>
      </div>
      <div class="voice-assistant-prompt">${escapeHtml(a.system_prompt).substring(0, 200)}${a.system_prompt.length > 200 ? '...' : ''}</div>
    </div>
  `).join('');
}

function openAssistantModal(id = null) {
  const modal = document.getElementById('assistantModal');
  const title = document.getElementById('assistantModalTitle');
  const deleteBtn = document.getElementById('deleteAssistantBtn');

  if (id) {
    const a = allAssistants.find(x => x.id === id);
    if (!a) return;
    title.textContent = 'Edit Voice Assistant';
    deleteBtn.style.display = 'block';
    document.getElementById('assistantId').value = a.id;
    document.getElementById('assistantName').value = a.name;
    document.getElementById('assistantFirstMessage').value = a.first_message || '';
    document.getElementById('assistantPrompt').value = a.system_prompt;
    document.getElementById('assistantModelProvider').value = a.model_provider || 'google';
    document.getElementById('assistantModelName').value = a.model_name || 'gemini-2.0-flash';
    document.getElementById('assistantVoiceProvider').value = a.voice_provider || '11labs';
    document.getElementById('assistantVoiceId').value = a.voice_id || 'sarah';
    document.getElementById('assistantTemperature').value = a.temperature || 0.7;
    document.getElementById('assistantMaxDuration').value = a.max_duration_seconds || 600;
    document.getElementById('assistantActive').checked = a.is_active;
  } else {
    title.textContent = 'New Voice Assistant';
    deleteBtn.style.display = 'none';
    document.getElementById('assistantForm').reset();
    document.getElementById('assistantId').value = '';
    document.getElementById('assistantActive').checked = true;
    document.getElementById('assistantTemperature').value = '0.7';
    document.getElementById('assistantMaxDuration').value = '600';
    document.getElementById('assistantFirstMessage').value = 'Hello! Thanks for calling. How can I help you today?';
  }

  modal.classList.remove('hidden');
}

function closeAssistantModal() {
  document.getElementById('assistantModal').classList.add('hidden');
}

async function saveAssistant() {
  const id = document.getElementById('assistantId').value;
  const data = {
    name: document.getElementById('assistantName').value.trim(),
    first_message: document.getElementById('assistantFirstMessage').value.trim(),
    system_prompt: document.getElementById('assistantPrompt').value.trim(),
    model_provider: document.getElementById('assistantModelProvider').value,
    model_name: document.getElementById('assistantModelName').value,
    voice_provider: document.getElementById('assistantVoiceProvider').value,
    voice_id: document.getElementById('assistantVoiceId').value.trim(),
    temperature: parseFloat(document.getElementById('assistantTemperature').value) || 0.7,
    max_duration_seconds: parseInt(document.getElementById('assistantMaxDuration').value) || 600,
    is_active: document.getElementById('assistantActive').checked,
  };

  if (!data.name) {
    showToast('Please enter a name', 'warning');
    return;
  }
  if (!data.system_prompt) {
    showToast('Please enter a system prompt', 'warning');
    return;
  }

  try {
    if (id) {
      await voiceService.updateAssistant(id, data);
      showToast('Assistant updated', 'success');
    } else {
      // If this is the first assistant, make it the default
      if (allAssistants.length === 0) {
        data.is_default = true;
      }
      await voiceService.createAssistant(data);
      showToast('Assistant created', 'success');
    }
    closeAssistantModal();
    await loadAssistants();
  } catch (error) {
    showToast(`Failed to save: ${error.message}`, 'error');
  }
}

async function deleteAssistant() {
  const id = document.getElementById('assistantId').value;
  if (!id) return;

  const a = allAssistants.find(x => x.id === id);
  if (!confirm(`Delete assistant "${a?.name}"? This cannot be undone.`)) return;

  try {
    await voiceService.deleteAssistant(id);
    showToast('Assistant deleted', 'success');
    closeAssistantModal();
    await loadAssistants();
  } catch (error) {
    showToast(`Failed to delete: ${error.message}`, 'error');
  }
}

async function setDefault(id) {
  try {
    await voiceService.setDefault(id);
    showToast('Default assistant updated', 'success');
    await loadAssistants();
  } catch (error) {
    showToast(`Failed to set default: ${error.message}`, 'error');
  }
}

// =============================================
// CALLS
// =============================================

async function loadCalls() {
  const { calls, count } = await voiceService.listCalls({ limit: 50 });
  allCalls = calls;
  renderCalls();
}

function renderCalls() {
  const container = document.getElementById('callsList');

  if (allCalls.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: var(--text-muted);">
        <p>No calls yet.</p>
        <p style="font-size: 0.85rem;">Calls will appear here once someone dials your Vapi number.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <table class="voice-calls-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Caller</th>
          <th>Duration</th>
          <th>Status</th>
          <th>Cost</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${allCalls.map(c => {
          const demo = isDemoUser();
          const demoClass = demo ? ' demo-redacted' : '';
          const date = new Date(c.created_at);
          const timeStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
            ' ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          const rawCallerName = c.person
            ? `${c.person.first_name || ''} ${c.person.last_name || ''}`.trim()
            : null;
          const callerName = demo && rawCallerName ? redactString(rawCallerName, 'name') : rawCallerName;
          const callerDisplay = callerName || c.caller_phone || 'Unknown';
          const duration = c.duration_seconds != null
            ? `${Math.floor(c.duration_seconds / 60)}:${String(c.duration_seconds % 60).padStart(2, '0')}`
            : '--';
          const rawCost = c.cost_cents != null ? `$${(c.cost_cents / 100).toFixed(2)}` : '--';
          const cost = demo && c.cost_cents != null ? redactString(rawCost, 'amount') : rawCost;
          const statusClass = c.status === 'ended' ? 'ended' : c.status === 'in-progress' ? 'active' : 'other';

          return `
            <tr class="voice-call-row" onclick="window._viewCall('${c.id}')">
              <td>${timeStr}</td>
              <td>
                <div class="${demoClass}">${escapeHtml(callerDisplay)}</div>
                ${callerName && c.caller_phone ? `<div class="text-muted" style="font-size:0.75rem;">${c.caller_phone}</div>` : ''}
              </td>
              <td>${duration}</td>
              <td><span class="voice-status voice-status--${statusClass}">${c.status}</span></td>
              <td class="${demoClass}">${cost}</td>
              <td>${c.summary ? '<span title="Has summary" style="cursor:help;">📋</span>' : ''}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function viewCall(id) {
  const call = allCalls.find(c => c.id === id);
  if (!call) return;

  const body = document.getElementById('callDetailBody');
  const rawDetailCallerName = call.person
    ? `${call.person.first_name || ''} ${call.person.last_name || ''}`.trim()
    : null;
  const callerName = isDemoUser() && rawDetailCallerName ? redactString(rawDetailCallerName, 'name') : rawDetailCallerName;

  let transcriptHtml = '';
  if (call.transcript && Array.isArray(call.transcript)) {
    transcriptHtml = `
      <div class="form-group">
        <label>Transcript</label>
        <div class="voice-transcript">
          ${call.transcript.map(t => `
            <div class="voice-transcript-msg voice-transcript-msg--${t.role === 'assistant' || t.role === 'bot' ? 'ai' : 'user'}">
              <strong>${t.role === 'assistant' || t.role === 'bot' ? 'AI' : 'Caller'}:</strong>
              ${escapeHtml(t.message || t.content || t.text || '')}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  const startTime = call.started_at ? new Date(call.started_at).toLocaleString() : '--';
  const endTime = call.ended_at ? new Date(call.ended_at).toLocaleString() : '--';
  const duration = call.duration_seconds != null
    ? `${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s`
    : '--';

  body.innerHTML = `
    <div class="voice-call-detail-grid">
      <div><strong>Caller:</strong> ${escapeHtml(callerName || call.caller_phone || 'Unknown')}</div>
      <div><strong>Phone:</strong> ${call.caller_phone || '--'}</div>
      <div><strong>Started:</strong> ${startTime}</div>
      <div><strong>Ended:</strong> ${endTime}</div>
      <div><strong>Duration:</strong> ${duration}</div>
      <div><strong>Status:</strong> ${call.status}</div>
      <div><strong>Ended Reason:</strong> ${call.ended_reason || '--'}</div>
      <div><strong>Cost:</strong> ${isDemoUser() && call.cost_cents != null ? `<span class="demo-redacted">${redactString(`$${(call.cost_cents / 100).toFixed(2)}`, 'amount')}</span>` : (call.cost_cents != null ? `$${(call.cost_cents / 100).toFixed(2)}` : '--')}</div>
      <div><strong>Assistant:</strong> ${call.assistant?.name || '--'}</div>
    </div>
    ${call.summary ? `
      <div class="form-group" style="margin-top: 1rem;">
        <label>Summary</label>
        <div class="voice-call-summary">${escapeHtml(call.summary)}</div>
      </div>
    ` : ''}
    ${transcriptHtml}
    ${call.recording_url ? `
      <div class="form-group" style="margin-top: 1rem;">
        <label>Recording</label>
        <audio controls src="${call.recording_url}" style="width: 100%;"></audio>
      </div>
    ` : ''}
  `;

  document.getElementById('callDetailModal').classList.remove('hidden');
}

// =============================================
// PAI CORE PROMPT CONFIG
// =============================================

async function loadPaiConfig() {
  const { data, error } = await supabase
    .from('pai_config')
    .select('identity, property_info, amenities, chat_addendum, email_addendum, discord_addendum, api_addendum, ai-admin_addendum')
    .eq('id', 1)
    .single();

  if (error || !data) {
    console.warn('No pai_config found, textareas will be empty');
    return;
  }

  document.getElementById('paiIdentity').value = data.identity || '';
  document.getElementById('paiPropertyInfo').value = data.property_info || '';
  document.getElementById('paiAmenities').value = data.amenities || '';
  document.getElementById('paiChatAddendum').value = data.chat_addendum || '';
  document.getElementById('paiEmailAddendum').value = data.email_addendum || '';
  document.getElementById('paiDiscordAddendum').value = data.discord_addendum || '';
  document.getElementById('paiApiAddendum').value = data.api_addendum || '';
  document.getElementById('paiAI AdminAddendum').value = data.ai-admin_addendum || '';
}

async function savePaiConfig() {
  const updates = {
    identity: document.getElementById('paiIdentity').value.trim(),
    property_info: document.getElementById('paiPropertyInfo').value.trim(),
    amenities: document.getElementById('paiAmenities').value.trim(),
    chat_addendum: document.getElementById('paiChatAddendum').value.trim(),
    email_addendum: document.getElementById('paiEmailAddendum').value.trim(),
    discord_addendum: document.getElementById('paiDiscordAddendum').value.trim(),
    api_addendum: document.getElementById('paiApiAddendum').value.trim(),
    ai-admin_addendum: document.getElementById('paiAI AdminAddendum').value.trim(),
  };

  const { error } = await supabase
    .from('pai_config')
    .update(updates)
    .eq('id', 1);

  if (error) {
    showToast(`Failed to save: ${error.message}`, 'error');
  } else {
    showToast('PAI core prompt saved', 'success');
  }
}

// =============================================
// EVENT LISTENERS
// =============================================

function setupEventListeners() {
  // PAI Core Prompt
  document.getElementById('savePaiConfigBtn')?.addEventListener('click', savePaiConfig);

  // Assistant CRUD
  document.getElementById('addAssistantBtn')?.addEventListener('click', () => openAssistantModal());
  document.getElementById('closeAssistantModal')?.addEventListener('click', closeAssistantModal);
  document.getElementById('cancelAssistantBtn')?.addEventListener('click', closeAssistantModal);
  document.getElementById('saveAssistantBtn')?.addEventListener('click', saveAssistant);
  document.getElementById('deleteAssistantBtn')?.addEventListener('click', deleteAssistant);

  // Call detail modal
  document.getElementById('closeCallDetailModal')?.addEventListener('click', () => {
    document.getElementById('callDetailModal').classList.add('hidden');
  });
  document.getElementById('closeCallDetailBtn')?.addEventListener('click', () => {
    document.getElementById('callDetailModal').classList.add('hidden');
  });

  // Refresh calls
  document.getElementById('refreshCallsBtn')?.addEventListener('click', async () => {
    await Promise.all([loadCalls(), loadStats()]);
    showToast('Refreshed', 'info');
  });

  // Config: API key
  document.getElementById('saveApiKeyBtn')?.addEventListener('click', async () => {
    const apiKey = document.getElementById('vapiApiKey').value.trim();
    try {
      await voiceService.updateConfig({ api_key: apiKey || null });
      showToast('API key saved', 'success');
    } catch (e) {
      showToast('Failed to save API key', 'error');
    }
  });

  document.getElementById('toggleApiKeyBtn')?.addEventListener('click', () => {
    const input = document.getElementById('vapiApiKey');
    const btn = document.getElementById('toggleApiKeyBtn');
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = 'Hide';
    } else {
      input.type = 'password';
      btn.textContent = 'Show';
    }
  });

  // Config: Phone number ID
  document.getElementById('savePhoneIdBtn')?.addEventListener('click', async () => {
    const phoneId = document.getElementById('vapiPhoneNumberId').value.trim();
    try {
      await voiceService.updateConfig({ phone_number_id: phoneId || null });
      showToast('Phone number ID saved', 'success');
    } catch (e) {
      showToast('Failed to save phone number ID', 'error');
    }
  });

  // Config: Test mode toggle
  document.getElementById('voiceTestMode')?.addEventListener('change', async (e) => {
    const testMode = e.target.checked;
    try {
      await voiceService.updateConfig({ test_mode: testMode });
      const config = await voiceService.getConfig();
      updateModeBadge(config);
      showToast(`Voice ${testMode ? 'test' : 'live'} mode enabled`, 'success');
    } catch (error) {
      showToast('Failed to update mode', 'error');
      e.target.checked = !testMode;
    }
  });

  // Config: Active toggle
  document.getElementById('voiceActive')?.addEventListener('change', async (e) => {
    const isActive = e.target.checked;
    try {
      await voiceService.updateConfig({ is_active: isActive });
      const config = await voiceService.getConfig();
      updateModeBadge(config);
      showToast(`Voice system ${isActive ? 'activated' : 'deactivated'}`, 'success');
    } catch (error) {
      showToast('Failed to update', 'error');
      e.target.checked = !isActive;
    }
  });

  // Close modals on backdrop click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });

  // Escape key closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }
  });
}

// =============================================
// GLOBAL HANDLERS (for inline onclick)
// =============================================

window._editAssistant = openAssistantModal;
window._setDefault = setDefault;
window._viewCall = viewCall;

// =============================================
// UTILS
// =============================================

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
