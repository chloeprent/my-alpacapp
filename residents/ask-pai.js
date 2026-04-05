/**
 * Ask PAI — Full-page chat experience
 * Input form at top, conversation history scrolling below.
 */

import { initResidentPage } from '../shared/resident-shell.js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../shared/supabase.js';

const PAI_URL = `${SUPABASE_URL}/functions/v1/property-ai`;
const MAX_HISTORY = 24;

let conversationHistory = [];
let isProcessing = false;
let cachedToken = null;
let cachedTokenExpiresAt = 0;

document.addEventListener('DOMContentLoaded', async () => {
  await initResidentPage({
    activeTab: 'askpai',
    requiredRole: 'resident',
    requiredPermission: 'view_profile',
    onReady: () => {
      // Hide the floating PAI bubble on this page — we have the full-page version
      const paiWidget = document.getElementById('paiWidget');
      if (paiWidget) paiWidget.style.display = 'none';

      setupChat();
    },
  });
});

function setupChat() {
  const input = document.getElementById('askpaiInput');
  const sendBtn = document.getElementById('askpaiSend');

  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim() || isProcessing;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !sendBtn.disabled) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  // Auto-focus the input
  input.focus();
}

async function sendMessage() {
  const input = document.getElementById('askpaiInput');
  const sendBtn = document.getElementById('askpaiSend');
  const message = input.value.trim();
  if (!message || isProcessing) return;

  // Clear the welcome message on first send
  const welcome = document.querySelector('.askpai-welcome');
  if (welcome) welcome.remove();

  // Add user message
  appendMessage('user', message);
  conversationHistory.push({ role: 'user', text: message });
  input.value = '';
  sendBtn.disabled = true;

  // Show typing indicator
  isProcessing = true;
  const typingEl = showTypingIndicator();

  try {
    const token = await getToken();
    if (!token) throw new Error('Not authenticated');

    const response = await fetch(PAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        message,
        conversationHistory: conversationHistory.slice(-MAX_HISTORY),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.message || 'Request failed');
    }

    appendMessage('ai', data.reply, data.actions_taken);
    conversationHistory.push({ role: 'model', text: data.reply });

    // Notify the page that PAI took actions so it can refresh UI state
    if (data.actions_taken?.length) {
      window.dispatchEvent(new CustomEvent('pai-actions', {
        detail: { actions: data.actions_taken },
      }));
    }
  } catch (err) {
    console.error('PAI error:', err);
    appendMessage('ai', `Sorry, something went wrong: ${err.message}`, null, true);
  } finally {
    isProcessing = false;
    typingEl?.remove();
    input.focus();
  }
}

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenExpiresAt && cachedTokenExpiresAt - now >= 60) {
    return cachedToken;
  }

  let { data: { session } } = await supabase.auth.getSession();
  if (session?.expires_at && session.expires_at - now < 60) {
    const { data } = await supabase.auth.refreshSession();
    session = data?.session;
  }
  cachedToken = session?.access_token || null;
  cachedTokenExpiresAt = session?.expires_at || 0;
  return cachedToken;
}

// =============================================
// UI Helpers
// =============================================

function appendMessage(role, text, actions, isError = false) {
  const container = document.getElementById('askpaiHistory');
  const div = document.createElement('div');
  const isUser = role === 'user';
  div.className = `askpai-msg ${isUser ? 'askpai-msg--user' : 'askpai-msg--ai'}${isError ? ' askpai-msg--error' : ''}`;

  let html = '';

  if (!isUser) {
    html += `<img src="YOUR_SUPABASE_URL/storage/v1/object/public/housephotos/logos/logo-black-transparent.png"
                  alt="PAI" class="askpai-msg-avatar">`;
  }

  html += '<div class="askpai-msg-content">';

  if (!isUser) {
    html += '<div class="askpai-msg-name">PAI</div>';
  }

  html += `<div class="askpai-msg-text">${escapeHtml(text)}</div>`;

  if (actions?.length) {
    html += '<div class="askpai-msg-actions">';
    for (const a of actions) {
      const icon = getActionIcon(a.type);
      html += `<span class="askpai-action-badge">${icon} ${escapeHtml(a.target)}</span>`;
    }
    html += '</div>';
  }

  html += '</div>';
  div.innerHTML = html;
  container.appendChild(div);

  // Scroll to the latest message
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function showTypingIndicator() {
  const container = document.getElementById('askpaiHistory');
  const div = document.createElement('div');
  div.className = 'askpai-msg askpai-msg--ai askpai-typing';
  div.innerHTML = `
    <img src="YOUR_SUPABASE_URL/storage/v1/object/public/housephotos/logos/logo-black-transparent.png"
         alt="PAI" class="askpai-msg-avatar">
    <div class="askpai-msg-content">
      <div class="askpai-msg-name">PAI</div>
      <div class="pai-typing-dots"><span></span><span></span><span></span></div>
    </div>
  `;
  container.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getActionIcon(type) {
  const icons = {
    control_lights: '\u{1F4A1}',
    control_sonos: '\u{1F3B5}',
    control_thermostat: '\u{1F321}',
    control_vehicle: '\u{1F697}',
    get_device_status: '\u{1F4CA}',
  };
  return icons[type] || '\u{2699}';
}
