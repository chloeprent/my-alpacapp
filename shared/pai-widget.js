/**
 * PAI (Prompt Property Intelligence) - Floating chat widget for resident pages
 * Allows residents to control smart home devices and ask property questions
 * via natural language, powered by Gemini AI with function calling.
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';

const PAI_URL = `${SUPABASE_URL}/functions/v1/property-ai`;
const MAX_HISTORY = 24;

let conversationHistory = [];
let isOpen = false;
let isProcessing = false;
let widgetInjected = false;
/** Cached token and expiry (seconds) to avoid getSession on every message */
let cachedToken = null;
let cachedTokenExpiresAt = 0;

// =============================================
// Initialization
// =============================================

export function initPaiWidget() {
  if (widgetInjected) return;
  widgetInjected = true;

  injectHTML();
  setupEventListeners();
}

// =============================================
// HTML Injection
// =============================================

function injectHTML() {
  const widget = document.createElement('div');
  widget.id = 'paiWidget';
  widget.innerHTML = `
    <button id="paiBubble" class="pai-bubble" title="Ask PAI" aria-label="Open AI assistant">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    </button>

    <div id="paiPanel" class="pai-panel hidden">
      <div class="pai-panel__header">
        <div class="pai-panel__title">
          <img src="YOUR_SUPABASE_URL/storage/v1/object/public/housephotos/logos/logo-black-transparent.png"
               alt="" class="pai-panel__avatar">
          <span>PAI</span>
          <span class="pai-panel__subtitle">Prompt Property Intelligence</span>
        </div>
        <button id="paiClose" class="pai-panel__close" aria-label="Close">&times;</button>
      </div>
      <div class="pai-panel__messages" id="paiMessages">
        <div class="pai-message pai-message--ai">
          <div class="pai-message__text">Hey! I'm PAI, your spirit guardian and smart home assistant. I can control lights, music, thermostats, and vehicles.</div>
        </div>
      </div>
      <div class="pai-panel__input">
        <input type="text" id="paiInput" placeholder="Ask PAI anything..."
               autocomplete="off" maxlength="500">
        <button id="paiSend" class="pai-panel__send" disabled aria-label="Send">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(widget);
}

// =============================================
// Event Listeners
// =============================================

function setupEventListeners() {
  const bubble = document.getElementById('paiBubble');
  const panel = document.getElementById('paiPanel');
  const closeBtn = document.getElementById('paiClose');
  const input = document.getElementById('paiInput');
  const sendBtn = document.getElementById('paiSend');

  bubble.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('hidden', !isOpen);
    bubble.classList.toggle('pai-bubble--active', isOpen);
    if (isOpen) input.focus();
  });

  closeBtn.addEventListener('click', () => {
    isOpen = false;
    panel.classList.add('hidden');
    bubble.classList.remove('pai-bubble--active');
  });

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

  // Escape to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      isOpen = false;
      panel.classList.add('hidden');
      bubble.classList.remove('pai-bubble--active');
    }
  });
}

// =============================================
// Message Handling
// =============================================

async function sendMessage() {
  const input = document.getElementById('paiInput');
  const sendBtn = document.getElementById('paiSend');
  const message = input.value.trim();
  if (!message || isProcessing) return;

  // Add user message to UI
  appendMessage('user', message);
  conversationHistory.push({ role: 'user', text: message });
  input.value = '';
  sendBtn.disabled = true;

  // Show typing indicator
  isProcessing = true;
  const typingEl = showTypingIndicator();

  try {
    // Use cached token if still valid (≥60s until expiry); otherwise get/refresh session
    const now = Math.floor(Date.now() / 1000);
    let token = cachedToken;
    if (!token || !cachedTokenExpiresAt || cachedTokenExpiresAt - now < 60) {
      let { data: { session } } = await supabase.auth.getSession();
      if (session?.expires_at && session.expires_at - now < 60) {
        const { data } = await supabase.auth.refreshSession();
        session = data?.session;
      }
      token = session?.access_token;
      cachedToken = token || null;
      cachedTokenExpiresAt = session?.expires_at || 0;
    }
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

// =============================================
// UI Helpers
// =============================================

function appendMessage(role, text, actions, isError = false) {
  const container = document.getElementById('paiMessages');
  const div = document.createElement('div');
  div.className = `pai-message pai-message--${role === 'user' ? 'user' : 'ai'}${isError ? ' pai-message--error' : ''}`;

  let html = `<div class="pai-message__text">${escapeHtml(text)}</div>`;

  if (actions?.length) {
    html += '<div class="pai-message__actions">';
    for (const a of actions) {
      const icon = getActionIcon(a.type);
      html += `<span class="pai-action-badge">${icon} ${escapeHtml(a.target)}</span>`;
    }
    html += '</div>';
  }

  div.innerHTML = html;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showTypingIndicator() {
  const container = document.getElementById('paiMessages');
  const div = document.createElement('div');
  div.className = 'pai-message pai-message--ai pai-typing';
  div.innerHTML = '<div class="pai-typing-dots"><span></span><span></span><span></span></div>';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
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

export default { initPaiWidget };
