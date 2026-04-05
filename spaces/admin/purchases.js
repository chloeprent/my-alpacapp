/**
 * Purchases & Receipts - Purchase tracking and vendor management
 */

import { supabase } from '../../shared/supabase.js';
import { initAdminPage, showToast, openLightbox } from '../../shared/admin-shell.js';

// =============================================
// STATE
// =============================================

let authState = null;
let purchases = [];
let vendors = [];
let currentFilter = { vendor: '', category: '', minDate: '', maxDate: '' };

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'purchases',
    requiredRole: 'staff',
    section: 'staff',
    onReady: async () => {
      setupEventListeners();
      await Promise.all([loadPurchases(), loadVendors()]);
    }
  });
});

// =============================================
// EVENT LISTENERS
// =============================================

function setupEventListeners() {
  document.getElementById('vendorFilter')?.addEventListener('input', applyFilters);
  document.getElementById('categoryFilter')?.addEventListener('change', applyFilters);
  document.getElementById('minDate')?.addEventListener('change', applyFilters);
  document.getElementById('maxDate')?.addEventListener('change', applyFilters);
  document.getElementById('resetFiltersBtn')?.addEventListener('click', resetFilters);
}

// =============================================
// DATA LOADING
// =============================================

async function loadPurchases() {
  try {
    const { data, error } = await supabase
      .from('purchases')
      .select('*')
      .order('purchase_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (error) throw error;
    purchases = data || [];
    renderPurchases();
    calculateStats();
  } catch (err) {
    console.error('Error loading purchases:', err);
    showToast('Failed to load purchases', 'error');
  }
}

async function loadVendors() {
  try {
    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .order('total_spent', { ascending: false, nullsFirst: false });

    if (error) throw error;
    vendors = data || [];
    renderVendors();
  } catch (err) {
    console.error('Error loading vendors:', err);
    showToast('Failed to load vendors', 'error');
  }
}

// =============================================
// FILTERING
// =============================================

function filterPurchases() {
  return purchases.filter((p) => {
    if (currentFilter.vendor && !p.vendor_name?.toLowerCase().includes(currentFilter.vendor.toLowerCase())) {
      return false;
    }
    if (currentFilter.category && p.category !== currentFilter.category) {
      return false;
    }
    if (currentFilter.minDate && p.purchase_date < currentFilter.minDate) {
      return false;
    }
    if (currentFilter.maxDate && p.purchase_date > currentFilter.maxDate) {
      return false;
    }
    return true;
  });
}

function applyFilters() {
  currentFilter.vendor = document.getElementById('vendorFilter')?.value || '';
  currentFilter.category = document.getElementById('categoryFilter')?.value || '';
  currentFilter.minDate = document.getElementById('minDate')?.value || '';
  currentFilter.maxDate = document.getElementById('maxDate')?.value || '';
  renderPurchases();
  calculateStats();
}

function resetFilters() {
  const vendorFilter = document.getElementById('vendorFilter');
  const categoryFilter = document.getElementById('categoryFilter');
  const minDate = document.getElementById('minDate');
  const maxDate = document.getElementById('maxDate');
  if (vendorFilter) vendorFilter.value = '';
  if (categoryFilter) categoryFilter.value = '';
  if (minDate) minDate.value = '';
  if (maxDate) maxDate.value = '';
  currentFilter = { vendor: '', category: '', minDate: '', maxDate: '' };
  renderPurchases();
  calculateStats();
}

// =============================================
// RENDERING
// =============================================

function renderPurchases() {
  const filtered = filterPurchases();
  const container = document.getElementById('purchasesGrid');
  if (!container) return;

  if (filtered.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 2rem;">No purchases found</p>';
    return;
  }

  container.innerHTML = filtered
    .map((p) => {
      const items = p.items ? (typeof p.items === 'string' ? JSON.parse(p.items) : p.items) : [];
      const hasItems = items && items.length > 0;

      return `
        <div class="purchase-card">
          <div>
            <div class="purchase-header">
              <a href="#vendor-${p.vendor_id || ''}" class="vendor-name" style="text-decoration: none; color: inherit; cursor: pointer;">${escapeHtml(p.vendor_name || 'Unknown')}</a>
              <div class="purchase-amount">$${(p.total_amount || 0).toFixed(2)}</div>
            </div>
            <div class="purchase-meta">
              ${p.purchase_date ? `<span>📅 ${new Date(p.purchase_date + 'T00:00:00').toLocaleDateString()}</span>` : ''}
              ${p.category ? `<span class="category-badge">${escapeHtml(p.category)}</span>` : ''}
              ${p.payment_method ? `<span>💳 ${escapeHtml(p.payment_method.replace(/_/g, ' '))}</span>` : ''}
            </div>
            ${hasItems ? `
              <div class="items-list">
                <h4>Items (${items.length}):</h4>
                ${items.slice(0, 5).map(item => `
                  <div class="item">
                    <span>${item.quantity ? `${item.quantity}x ` : ''}${escapeHtml(item.name || '')}</span>
                    <span>$${(item.price || 0).toFixed(2)}</span>
                  </div>
                `).join('')}
                ${items.length > 5 ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem;">+${items.length - 5} more items</div>` : ''}
              </div>
            ` : ''}
          </div>
          ${p.receipt_url ? `
            <div>
              <img src="${escapeHtml(p.receipt_url)}" alt="Receipt" class="receipt-thumbnail" data-receipt-url="${escapeHtml(p.receipt_url)}" />
            </div>
          ` : ''}
        </div>
      `;
    })
    .join('');

  // Attach receipt click handlers
  container.querySelectorAll('.receipt-thumbnail').forEach(img => {
    img.addEventListener('click', () => openLightbox(img.dataset.receiptUrl));
  });
}

function calculateStats() {
  const filtered = filterPurchases();
  const total = filtered.reduce((sum, p) => sum + parseFloat(p.total_amount || 0), 0);
  const count = filtered.length;
  const avgPurchase = count > 0 ? total / count : 0;

  const dates = filtered.map(p => p.purchase_date).filter(Boolean).sort();
  const dateRange = dates.length > 0
    ? `${new Date(dates[0] + 'T00:00:00').toLocaleDateString()} – ${new Date(dates[dates.length - 1] + 'T00:00:00').toLocaleDateString()}`
    : 'N/A';

  const totalEl = document.getElementById('totalSpent');
  const countEl = document.getElementById('purchaseCount');
  const avgEl = document.getElementById('avgPurchase');
  const rangeEl = document.getElementById('dateRange');
  if (totalEl) totalEl.textContent = `$${total.toFixed(2)}`;
  if (countEl) countEl.textContent = count;
  if (avgEl) avgEl.textContent = `$${avgPurchase.toFixed(2)}`;
  if (rangeEl) rangeEl.textContent = dateRange;
}

function renderVendors() {
  const container = document.getElementById('vendorsList');
  if (!container) return;

  if (vendors.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 2rem;">No vendors found</p>';
    return;
  }

  container.innerHTML = vendors
    .map((v) => `
      <div class="vendor-item" id="vendor-${v.id}">
        <div class="vendor-info">
          <h4>${escapeHtml(v.name || 'Unknown')}</h4>
          <div class="vendor-contact">
            ${v.phone ? `📞 ${escapeHtml(v.phone)}` : ''}
            ${v.email ? `${v.phone ? ' • ' : ''}📧 ${escapeHtml(v.email)}` : ''}
            ${v.category ? `${v.phone || v.email ? ' • ' : ''}${escapeHtml(v.category)}` : ''}
          </div>
          ${v.address ? `<div class="vendor-contact" style="margin-top: 0.25rem;">📍 ${escapeHtml(v.address)}</div>` : ''}
        </div>
        <div class="vendor-stats">
          <div class="vendor-total">$${(v.total_spent || 0).toFixed(2)}</div>
          <div style="color: var(--text-muted);">${v.purchase_count || 0} purchase${v.purchase_count === 1 ? '' : 's'}</div>
        </div>
      </div>
    `)
    .join('');
}

// =============================================
// HELPERS
// =============================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
