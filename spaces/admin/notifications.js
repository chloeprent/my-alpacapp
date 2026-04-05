/**
 * Notifications - Manage event notification subscriptions
 */

import { supabase } from '../../shared/supabase.js';
import { initAdminPage, showToast } from '../../shared/admin-shell.js';

let authState = null;
let subscriptions = [];
let editingId = null;

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'notifications',
    requiredRole: 'admin',
    section: 'admin',
    onReady: async () => {
      await loadSubscriptions();
      setupEventListeners();
    }
  });
});

// =============================================
// DATA LOADING
// =============================================

async function loadSubscriptions() {
  const { data, error } = await supabase
    .from('notification_subscriptions')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    showToast('Failed to load subscriptions', 'error');
    console.error(error);
    return;
  }

  subscriptions = data || [];
  renderSubscriptions();
}

// =============================================
// RENDERING
// =============================================

function renderSubscriptions() {
  const container = document.getElementById('subscriptionsList');

  if (subscriptions.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:40px 20px; color:var(--text-muted);">
        <p>No notification subscriptions yet.</p>
        <p style="font-size:0.85rem;">Click "+ Add Subscription" to create one.</p>
      </div>`;
    return;
  }

  container.innerHTML = subscriptions.map(sub => {
    const filterDisplay = sub.filters && Object.keys(sub.filters).length > 0
      ? Object.entries(sub.filters).map(([k, v]) => `<span style="background:var(--bg-muted);padding:2px 8px;border-radius:4px;font-size:0.8rem;font-family:monospace;">${k}=${String(v).slice(0, 12)}...</span>`).join(' ')
      : '<span style="color:var(--text-muted);font-size:0.85rem;">No filters (all records)</span>';

    const watchDisplay = sub.watch_columns && sub.watch_columns.length > 0
      ? sub.watch_columns.map(c => `<code style="background:var(--bg-muted);padding:1px 6px;border-radius:3px;font-size:0.8rem;">${c}</code>`).join(', ')
      : '';

    const statusBadge = sub.is_active
      ? '<span style="background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:10px;font-size:0.75rem;font-weight:600;">Active</span>'
      : '<span style="background:#fce4ec;color:#c62828;padding:2px 8px;border-radius:10px;font-size:0.75rem;font-weight:600;">Paused</span>';

    return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px;background:var(--bg-card, #fff);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <strong style="font-size:0.95rem;">${sub.label || sub.event}</strong>
              ${statusBadge}
            </div>
            <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:4px;">
              <strong>Event:</strong> <code style="background:var(--bg-muted);padding:1px 6px;border-radius:3px;">${sub.event}</code>
            </div>
            <div style="font-size:0.85rem;margin-bottom:4px;">
              <strong>Filters:</strong> ${filterDisplay}
            </div>
            ${watchDisplay ? `<div style="font-size:0.85rem;margin-bottom:4px;"><strong>Watch:</strong> ${watchDisplay}</div>` : ''}
            <div style="font-size:0.85rem;">
              <strong>Notify:</strong> ${sub.notify_emails.map(e => `<span style="color:var(--accent);">${e}</span>`).join(', ')}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button class="btn-small btn-secondary" onclick="window._editSub('${sub.id}')">Edit</button>
            <button class="btn-small" style="color:var(--text-muted);border:1px solid var(--border);background:transparent;cursor:pointer;" onclick="window._toggleSub('${sub.id}', ${!sub.is_active})">${sub.is_active ? 'Pause' : 'Enable'}</button>
            <button class="btn-small" style="color:#c62828;border:1px solid #fce4ec;background:transparent;cursor:pointer;" onclick="window._deleteSub('${sub.id}')">Delete</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// =============================================
// CRUD OPERATIONS
// =============================================

window._editSub = function(id) {
  const sub = subscriptions.find(s => s.id === id);
  if (!sub) return;
  editingId = id;
  openModal(sub);
};

window._toggleSub = async function(id, newState) {
  const { error } = await supabase
    .from('notification_subscriptions')
    .update({ is_active: newState, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    showToast('Failed to update subscription', 'error');
    return;
  }
  showToast(newState ? 'Subscription enabled' : 'Subscription paused');
  await loadSubscriptions();
};

window._deleteSub = async function(id) {
  if (!confirm('Delete this notification subscription?')) return;

  const { error } = await supabase
    .from('notification_subscriptions')
    .delete()
    .eq('id', id);

  if (error) {
    showToast('Failed to delete subscription', 'error');
    return;
  }
  showToast('Subscription deleted');
  await loadSubscriptions();
};

function openModal(sub = null) {
  const modal = document.getElementById('subscriptionModal');
  const title = document.getElementById('subscriptionModalTitle');

  title.textContent = sub ? 'Edit Subscription' : 'Add Subscription';

  document.getElementById('subLabel').value = sub?.label || '';
  document.getElementById('subEvent').value = sub?.event || '';

  const filters = sub?.filters || {};
  const filterEntries = Object.entries(filters);
  document.getElementById('subFilterKey').value = filterEntries[0]?.[0] || '';
  document.getElementById('subFilterValue').value = filterEntries[0]?.[1] || '';

  document.getElementById('subEmails').value = (sub?.notify_emails || []).join(', ');
  document.getElementById('subWatchCols').value = (sub?.watch_columns || []).join(', ');
  document.getElementById('subActive').checked = sub?.is_active ?? true;

  modal.classList.remove('hidden');
}

function closeModal() {
  editingId = null;
  document.getElementById('subscriptionModal').classList.add('hidden');
}

async function saveSubscription() {
  const event = document.getElementById('subEvent').value.trim();
  const emailsRaw = document.getElementById('subEmails').value.trim();
  const label = document.getElementById('subLabel').value.trim();
  const filterKey = document.getElementById('subFilterKey').value.trim();
  const filterValue = document.getElementById('subFilterValue').value.trim();
  const watchColsRaw = document.getElementById('subWatchCols').value.trim();
  const isActive = document.getElementById('subActive').checked;

  if (!event) { showToast('Event is required', 'error'); return; }
  if (!emailsRaw) { showToast('At least one email is required', 'error'); return; }

  const notifyEmails = emailsRaw.split(',').map(e => e.trim()).filter(Boolean);
  const filters = filterKey && filterValue ? { [filterKey]: filterValue } : {};
  const watchColumns = watchColsRaw ? watchColsRaw.split(',').map(c => c.trim()).filter(Boolean) : null;

  const record = {
    event,
    filters,
    notify_emails: notifyEmails,
    label: label || null,
    watch_columns: watchColumns,
    is_active: isActive,
    updated_at: new Date().toISOString(),
  };

  let error;
  if (editingId) {
    ({ error } = await supabase
      .from('notification_subscriptions')
      .update(record)
      .eq('id', editingId));
  } else {
    ({ error } = await supabase
      .from('notification_subscriptions')
      .insert(record));
  }

  if (error) {
    showToast('Failed to save: ' + error.message, 'error');
    return;
  }

  showToast(editingId ? 'Subscription updated' : 'Subscription created');
  closeModal();
  await loadSubscriptions();
}

// =============================================
// EVENT LISTENERS
// =============================================

function setupEventListeners() {
  document.getElementById('addSubscriptionBtn').addEventListener('click', () => {
    editingId = null;
    openModal();
  });
  document.getElementById('closeSubscriptionModal').addEventListener('click', closeModal);
  document.getElementById('cancelSubscriptionBtn').addEventListener('click', closeModal);
  document.getElementById('saveSubscriptionBtn').addEventListener('click', saveSubscription);
}
