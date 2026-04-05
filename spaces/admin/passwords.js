/**
 * Password Vault - Admin-only credential storage with copy-to-clipboard
 */

import { supabase } from '../../shared/supabase.js';
import { initAdminPage, showToast } from '../../shared/admin-shell.js';
import { isDemoUser, redactString } from '../../shared/demo-redact.js';

// =============================================
// STATE
// =============================================

let authState = null;
let allEntries = [];
let allSpaces = [];
let spacesMap = {};
let activeCategory = 'all';
let searchQuery = '';
let editingEntryId = null;
let revealedPasswords = new Set();

const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'house', label: 'House' },
  { id: 'platform', label: 'Platform' },
  { id: 'social', label: 'Social' },
  { id: 'service', label: 'Service' },
  { id: 'email', label: 'Email' },
  { id: 'tools', label: 'Tools' },
  { id: 'commerce', label: 'Commerce' },
];

const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const EDIT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const SHARE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'passwords',
    requiredRole: 'admin',
    section: 'admin',
    onReady: async (state) => {
      renderFilters();
      await Promise.all([loadEntries(), loadSpaces()]);
      setupEventListeners();
    }
  });
});

// =============================================
// DATA
// =============================================

async function loadEntries() {
  try {
    const { data, error } = await supabase
      .from('password_vault')
      .select('*, space:space_id(id, name)')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) throw error;
    allEntries = data || [];
    renderGrid();
  } catch (err) {
    console.error('Error loading vault:', err);
    showToast('Failed to load passwords', 'error');
  }
}

async function loadSpaces() {
  try {
    const { data, error } = await supabase
      .from('spaces')
      .select('id, name')
      .eq('is_archived', false)
      .order('name');
    if (error) throw error;
    allSpaces = data || [];
    spacesMap = {};
    for (const s of allSpaces) spacesMap[s.id] = s.name;
    populateSpaceDropdown();
  } catch (err) {
    console.error('Error loading spaces:', err);
  }
}

function populateSpaceDropdown() {
  const sel = document.getElementById('entrySpace');
  sel.innerHTML = '<option value="">None</option>' +
    allSpaces.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
}

function getFilteredEntries() {
  let entries = allEntries;
  if (activeCategory !== 'all') {
    entries = entries.filter(e => e.category === activeCategory);
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    entries = entries.filter(e =>
      e.service.toLowerCase().includes(q) ||
      (e.username && e.username.toLowerCase().includes(q)) ||
      (e.notes && e.notes.toLowerCase().includes(q))
    );
  }
  return entries;
}

// =============================================
// RENDERING
// =============================================

function renderFilters() {
  const container = document.getElementById('vaultFilters');
  container.innerHTML = CATEGORIES.map(cat =>
    `<button class="vault-chip ${cat.id === activeCategory ? 'active' : ''}" data-cat="${cat.id}">${cat.label}</button>`
  ).join('');
}

function renderGrid() {
  const entries = getFilteredEntries();
  const grid = document.getElementById('vaultGrid');
  const countEl = document.getElementById('vaultCount');

  countEl.textContent = `${entries.length} of ${allEntries.length}`;

  if (!entries.length) {
    grid.innerHTML = '<div class="vault-empty">No entries found.</div>';
    return;
  }

  const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
  const demo = isDemoUser();

  const headerRow = `
    <div class="vault-col-header">
      <span class="vault-col-label">Name</span>
      <span class="vault-col-label">Type</span>
      <span class="vault-col-label">Password</span>
      <span class="vault-col-label col-actions">Actions</span>
    </div>`;

  const rows = entries.map(e => {
    const isRevealed = !demo && revealedPasswords.has(e.id);
    const subtitleParts = [];
    if (e.username) subtitleParts.push(demo ? `<span class="demo-redacted">${redactString(e.username, 'password')}</span>` : escapeHtml(e.username));
    if (e.space && e.space.name) subtitleParts.push(escapeHtml(e.space.name));
    if (e.url) subtitleParts.push(demo ? `<span class="demo-redacted">${redactString('url', 'password')}</span>` : `<a href="${escapeAttr(e.url)}" target="_blank" rel="noopener">${prettifyUrl(e.url)}</a>`);
    if (e.notes) subtitleParts.push(`<span style="font-style:italic">${escapeHtml(e.notes)}</span>`);

    const pwDisplay = e.password
      ? (demo
        ? `<span class="demo-redacted">${redactString('', 'password')}</span>`
        : (isRevealed
          ? escapeHtml(e.password) + (isRoomDoor(e) ? (/fuego|spartan/i.test(e.service) ? ' <span style="color:#9a3412;font-weight:600;font-family:system-ui">#</span>' : ' <span style="color:#16a34a;font-family:system-ui">\u2713</span>') : '')
          : MASK))
      : '<span style="color:var(--text-muted);font-style:italic;font-family:inherit;font-size:0.78rem">\u2014</span>';

    const disableActions = demo || !e.password;

    return `
      <div class="vault-card" data-id="${e.id}">
        <div class="vault-card-name">
          <span class="vault-card-service">${escapeHtml(e.service)}</span>
          ${subtitleParts.length ? `<span class="vault-card-subtitle">${subtitleParts.join(' &middot; ')}</span>` : ''}
        </div>
        <span class="vault-card-category" data-cat="${e.category}">${e.category}</span>
        <span class="vault-pw-cell ${isRevealed ? '' : 'masked'}" id="pw-${e.id}">${pwDisplay}</span>
        <div class="vault-actions">
          <button class="vault-btn-icon" data-action="toggle-pw" data-id="${e.id}" title="${isRevealed ? 'Hide' : 'Reveal'}"${disableActions ? ' disabled style="opacity:0.3;cursor:default"' : ''}>${isRevealed ? EYE_OFF_SVG : EYE_SVG}</button>
          <button class="vault-btn-icon" data-action="copy-field" data-id="${e.id}" data-field="password" title="Copy password"${disableActions ? ' disabled style="opacity:0.3;cursor:default"' : ''}>${COPY_SVG}</button>
          <button class="vault-btn-icon" data-action="share" data-id="${e.id}" title="Copy all details"${demo ? ' disabled style="opacity:0.3;cursor:default"' : ''}>${SHARE_SVG}</button>
          <button class="vault-btn-icon" data-action="edit" data-id="${e.id}" title="Edit"${demo ? ' disabled style="opacity:0.3;cursor:default"' : ''}>${EDIT_SVG}</button>
        </div>
      </div>`;
  }).join('');

  grid.innerHTML = headerRow + rows;
}

// =============================================
// MODAL
// =============================================

function openModal(entryId = null) {
  editingEntryId = entryId;
  const modal = document.getElementById('entryModal');
  const title = document.getElementById('entryModalTitle');
  const deleteBtn = document.getElementById('deleteEntryBtn');
  const form = document.getElementById('entryForm');

  if (entryId) {
    title.textContent = 'Edit Entry';
    deleteBtn.style.display = 'block';
    const entry = allEntries.find(e => e.id === entryId);
    if (entry) {
      document.getElementById('entryId').value = entry.id;
      document.getElementById('entryService').value = entry.service;
      document.getElementById('entryCategory').value = entry.category;
      document.getElementById('entryUsername').value = entry.username || '';
      document.getElementById('entryPassword').value = entry.password || '';
      document.getElementById('entrySpace').value = entry.space_id || '';
      document.getElementById('entryUrl').value = entry.url || '';
      document.getElementById('entryNotes').value = entry.notes || '';
    }
  } else {
    title.textContent = 'Add Entry';
    deleteBtn.style.display = 'none';
    form.reset();
    document.getElementById('entryId').value = '';
    document.getElementById('entryCategory').value = 'service';
    document.getElementById('entrySpace').value = '';
  }

  modal.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('entryModal').classList.add('hidden');
  editingEntryId = null;
}

async function saveEntry() {
  const service = document.getElementById('entryService').value.trim();
  if (!service) {
    showToast('Service name is required', 'warning');
    return;
  }

  const spaceVal = document.getElementById('entrySpace').value;
  const data = {
    service,
    category: document.getElementById('entryCategory').value,
    username: document.getElementById('entryUsername').value.trim() || null,
    password: document.getElementById('entryPassword').value.trim() || null,
    space_id: spaceVal || null,
    url: document.getElementById('entryUrl').value.trim() || null,
    notes: document.getElementById('entryNotes').value.trim() || null,
    updated_at: new Date().toISOString(),
  };

  try {
    if (editingEntryId) {
      const { error } = await supabase
        .from('password_vault')
        .update(data)
        .eq('id', editingEntryId);
      if (error) throw error;
      showToast('Entry updated', 'success');
    } else {
      data.display_order = allEntries.length;
      const { error } = await supabase
        .from('password_vault')
        .insert(data);
      if (error) throw error;
      showToast('Entry added', 'success');
    }
    closeModal();
    await loadEntries();
  } catch (err) {
    console.error('Error saving entry:', err);
    showToast('Failed to save entry', 'error');
  }
}

async function deleteEntry() {
  if (!editingEntryId) return;
  if (!confirm('Delete this credential entry?')) return;

  try {
    const { error } = await supabase
      .from('password_vault')
      .delete()
      .eq('id', editingEntryId);

    if (error) throw error;
    showToast('Entry deleted', 'success');
    closeModal();
    await loadEntries();
  } catch (err) {
    console.error('Error deleting entry:', err);
    showToast('Failed to delete entry', 'error');
  }
}

// =============================================
// CLIPBOARD
// =============================================

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'success', 2000);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('Copied to clipboard', 'success', 2000);
  }
}

// =============================================
// EVENT LISTENERS
// =============================================

function setupEventListeners() {
  document.getElementById('vaultSearch').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    if (searchQuery) {
      activeCategory = 'all';
      renderFilters();
    }
    renderGrid();
  });

  document.getElementById('vaultFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('.vault-chip');
    if (!chip) return;
    activeCategory = chip.dataset.cat;
    renderFilters();
    renderGrid();
  });

  document.getElementById('vaultGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    if (action === 'copy-field') {
      // Look up value from JS state, never from DOM
      const entry = allEntries.find(en => en.id === btn.dataset.id);
      if (entry) {
        const val = btn.dataset.field === 'password' ? entry.password : entry.username;
        if (val) copyToClipboard(val);
      }
    } else if (action === 'share') {
      const entry = allEntries.find(en => en.id === btn.dataset.id);
      if (entry) {
        const text = buildShareText(entry);
        copyToClipboard(text);
        showToast('Full details copied', 'success', 2000);
      }
    } else if (action === 'toggle-pw') {
      const id = btn.dataset.id;
      if (revealedPasswords.has(id)) {
        revealedPasswords.delete(id);
      } else {
        revealedPasswords.add(id);
      }
      renderGrid();
    } else if (action === 'edit') {
      openModal(btn.dataset.id);
    }
  });

  document.getElementById('addEntryBtn').addEventListener('click', () => openModal());
  document.getElementById('closeEntryModal').addEventListener('click', closeModal);
  document.getElementById('cancelEntryBtn').addEventListener('click', closeModal);
  document.getElementById('saveEntryBtn').addEventListener('click', saveEntry);
  document.getElementById('deleteEntryBtn').addEventListener('click', deleteEntry);

  document.getElementById('entryModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

// =============================================
// HELPERS
// =============================================

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isRoomDoor(entry) {
  if (entry.category !== 'house' || !entry.space_id) return false;
  const s = entry.service.toLowerCase();
  return /master|skyloft|peque|spartan|fuego/i.test(s);
}

function buildShareText(entry) {
  const lines = [entry.service];
  if (entry.space && entry.space.name) lines.push(`Location: ${entry.space.name}`);
  if (entry.username) lines.push(`User: ${entry.username}`);
  if (entry.password) lines.push(`Password: ${entry.password}`);
  if (entry.url) lines.push(`URL: ${entry.url}`);
  if (entry.notes) lines.push(`Notes: ${entry.notes}`);
  return lines.join('\n');
}

function prettifyUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
}
