/**
 * Accounting Page - Transaction ledger and refunds
 */
import { initAdminPage, showToast } from '../../shared/admin-shell.js';
import { supabase } from '../../shared/supabase.js';
import {
  accountingService,
  CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
  DIRECTION,
  STATUS
} from '../../shared/accounting-service.js';
import { isDemoUser, redactString } from '../../shared/demo-redact.js';

// State
let transactions = [];
let summary = {};
let people = [];
let currentFilters = {};
let occupancyData = null; // { occupancyPct, occupiedUnits, availableUnits, totalUnits, revenuePct, currentRevenue, maxPotential, revenueGap }
let computeCosts = [];
let apiUsageData = null;
let initialized = false;

// Check if running in embed mode (inside iframe on manage.html)
const isEmbed = new URLSearchParams(window.location.search).has('embed');

// =============================================
// INITIALIZATION
// =============================================
initAdminPage({
  activeTab: 'accounting',
  requiredRole: 'admin',
  section: 'admin',
  onReady: async () => {
    if (initialized) return;
    initialized = true;

    // Hide header and tab nav in embed mode
    if (isEmbed) {
      const header = document.querySelector('header');
      if (header) header.style.display = 'none';
      const tabs = document.querySelector('.manage-tabs');
      if (tabs) tabs.style.display = 'none';
      // Reduce padding in embed mode
      const container = document.querySelector('.manage-container');
      if (container) container.style.padding = '1rem';
    }

    await loadPeople();
    setDefaultDateRange();
    setupEventListeners();
    await Promise.all([loadData(), loadOccupancy(), loadComputeCosts(), loadApiUsage()]);
  }
});

// =============================================
// DATE HELPERS
// =============================================
function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getFirstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function getFirstOfLastMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function getLastDayOfLastMonth() {
  const d = new Date();
  d.setDate(0);
  return d.toISOString().split('T')[0];
}

function getFirstOfQuarter() {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) * 3;
  return `${d.getFullYear()}-${String(q + 1).padStart(2, '0')}-01`;
}

function getFirstOfYear() {
  return `${new Date().getFullYear()}-01-01`;
}

function setDefaultDateRange() {
  document.getElementById('filterDateFrom').value = getFirstOfMonth();
  document.getElementById('filterDateTo').value = getToday();
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount || 0);
}

function formatCurrencyDisplay(amount) {
  if (isDemoUser()) return redactString(formatCurrency(amount), 'amount');
  return formatCurrency(amount);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// =============================================
// DATA LOADING
// =============================================
async function loadPeople() {
  try {
    people = await accountingService.getPeople();
    populatePersonDropdown();
  } catch (err) {
    console.error('Failed to load people:', err);
  }
}

function populatePersonDropdown() {
  const select = document.getElementById('txPerson');
  select.innerHTML = '<option value="">-- Select Person --</option>';
  for (const p of people) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.first_name} ${p.last_name}`;
    select.appendChild(opt);
  }
}

function getFilters() {
  const filters = {};
  const dateFrom = document.getElementById('filterDateFrom').value;
  const dateTo = document.getElementById('filterDateTo').value;
  const direction = document.getElementById('filterDirection').value;
  const category = document.getElementById('filterCategory').value;
  const method = document.getElementById('filterMethod').value;
  const search = document.getElementById('filterSearch').value.trim();

  if (dateFrom) filters.dateFrom = dateFrom;
  if (dateTo) filters.dateTo = dateTo;
  if (direction) filters.direction = direction;
  if (category) filters.category = category;
  if (method) filters.paymentMethod = method;
  if (search) filters.search = search;

  const showTest = document.getElementById('filterShowTest')?.checked;
  if (showTest) filters.includeTest = true;

  return filters;
}

async function loadData() {
  try {
    currentFilters = getFilters();
    const [txResult, summaryResult] = await Promise.all([
      accountingService.getTransactions(currentFilters),
      accountingService.getSummary(currentFilters.dateFrom, currentFilters.dateTo)
    ]);

    transactions = txResult.data;
    summary = summaryResult;

    renderMonthColumns();
    renderTransactions();
  } catch (err) {
    console.error('Failed to load data:', err);
    showToast('Failed to load accounting data', 'error');
  }
}

// =============================================
// RENDERING
// =============================================
function renderMonthColumns() {
  const container = document.getElementById('monthColumnsContainer');
  const months = summary.byMonth || [];

  if (months.length === 0) {
    container.innerHTML = '<div class="empty-state">No data for the selected period.</div>';
    return;
  }

  // Current month string for highlighting
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Read rolling window size from dropdown (default 3)
  const windowSelect = document.getElementById('monthWindowSelect');
  const windowSize = windowSelect ? parseInt(windowSelect.value, 10) : 3;

  // Compute rolling window (current month + (windowSize-1) prior months)
  const windowStart = new Date(now.getFullYear(), now.getMonth() - (windowSize - 1), 1);
  const windowStartStr = `${windowStart.getFullYear()}-${String(windowStart.getMonth() + 1).padStart(2, '0')}`;

  const windowMonths = months.filter(m => m.month >= windowStartStr);
  const windowMonthCount = windowMonths.length || 1;

  const windowData = {
    month: `${windowSize}MO`,
    rent: windowMonths.reduce((s, m) => s + m.rent, 0),
    deposits: windowMonths.reduce((s, m) => s + m.deposits, 0),
    fees: windowMonths.reduce((s, m) => s + m.fees, 0),
    refunds: windowMonths.reduce((s, m) => s + m.refunds, 0),
    income: windowMonths.reduce((s, m) => s + m.income, 0),
    expenses: windowMonths.reduce((s, m) => s + m.expenses, 0),
    net: windowMonths.reduce((s, m) => s + m.net, 0),
    pending: windowMonths.reduce((s, m) => s + (m.pending || 0), 0),
  };

  // Average occupancy across months in the window
  // For now we only have a current snapshot, so average = current
  // As we accumulate history this will become a real average
  const windowOccupancy = occupancyData ? {
    occupancyPct: occupancyData.occupancyPct,
    occupiedUnits: occupancyData.occupiedUnits,
    availableUnits: occupancyData.availableUnits,
    totalUnits: occupancyData.totalUnits,
    revenuePct: occupancyData.revenuePct,
    currentRevenue: occupancyData.currentRevenue,
    maxPotential: occupancyData.maxPotential,
    revenueGap: occupancyData.revenueGap,
    monthCount: windowMonthCount,
  } : null;

  // Build the summary column with the selected window label
  const summaryCol = buildMonthColumn(windowData, false, true, windowOccupancy, windowSize);

  // Build each month column
  const monthCols = months.map(m => buildMonthColumn(m, m.month === currentMonth, false, null, 0)).join('');

  container.innerHTML = `
    <div class="month-columns-grid">
      ${summaryCol}
      ${monthCols}
    </div>
  `;
}

function buildMonthColumn(m, isCurrent, isSummary, occOverride, windowSize) {
  const headerLabel = isSummary ? `${windowSize} Months` : formatMonthLabelShort(m.month);
  const colClass = isSummary ? 'month-column totals-col' : (isCurrent ? 'month-column current' : 'month-column');

  const netClass = (m.net >= 0) ? 'positive' : 'negative';

  // Occupancy: show on current month (snapshot) and summary column (avg)
  const showOccupancy = (isCurrent && occupancyData) || (isSummary && occOverride);
  const occData = isSummary ? occOverride : occupancyData;
  const occLabel = isSummary ? 'Avg' : null;
  const occSection = showOccupancy ? buildOccupancySection(occData, occLabel) : '';

  return `
    <div class="${colClass}">
      <div class="month-col-header">${headerLabel}</div>
      <div class="month-col-body">
        <div class="month-row rent">
          <span class="month-row-label"><span class="month-row-dot rent"></span>Rent</span>
          <span class="month-row-value">${formatCurrency(m.rent)}</span>
        </div>
        <div class="month-row deposits">
          <span class="month-row-label"><span class="month-row-dot deposits"></span>Deposits</span>
          <span class="month-row-value">${formatCurrency(m.deposits)}</span>
        </div>
        <div class="month-row fees">
          <span class="month-row-label"><span class="month-row-dot fees"></span>Fees</span>
          <span class="month-row-value">${formatCurrency(m.fees)}</span>
        </div>
        <div class="month-row refunds">
          <span class="month-row-label"><span class="month-row-dot refunds"></span>Refunds</span>
          <span class="month-row-value ${isDemoUser() ? 'demo-redacted' : ''}">${m.refunds > 0 ? '-' : ''}${formatCurrencyDisplay(m.refunds)}</span>
        </div>
        <div class="month-row separator"></div>
        <div class="month-row total-received">
          <span class="month-row-label">Total In</span>
          <span class="month-row-value ${isDemoUser() ? 'demo-redacted' : ''}">${formatCurrencyDisplay(m.income)}</span>
        </div>
        <div class="month-row total-refunded">
          <span class="month-row-label">Total Out</span>
          <span class="month-row-value ${isDemoUser() ? 'demo-redacted' : ''}">${m.expenses > 0 ? '-' : ''}${formatCurrencyDisplay(m.expenses)}</span>
        </div>
        <div class="month-row separator"></div>
        <div class="month-row net">
          <span class="month-row-label">Net</span>
          <span class="month-row-value ${netClass} ${isDemoUser() ? 'demo-redacted' : ''}">${formatCurrencyDisplay(m.net)}</span>
        </div>
        <div class="month-row pending">
          <span class="month-row-label"><span class="month-row-dot pending"></span>Pending</span>
          <span class="month-row-value ${isDemoUser() ? 'demo-redacted' : ''}">${formatCurrencyDisplay(m.pending || 0)}</span>
        </div>
        ${occSection}
      </div>
    </div>
  `;
}

function buildOccupancySection(o, label) {
  if (!o) return '';
  const circumference = 2 * Math.PI * 22; // ~138.2 for r=22 (smaller donut)
  const unitArcLen = (o.occupancyPct / 100) * circumference;
  const revArcLen = (o.revenuePct / 100) * circumference;

  const occTitle = label ? `Occupancy (${label})` : 'Occupancy';
  const revTitle = label ? `Revenue (${label})` : 'Revenue';

  return `
    <div class="month-row separator"></div>
    <div class="month-col-section-label">
      <span>${occTitle}</span>
      <svg viewBox="0 0 52 52" class="month-donut-svg">
        <circle cx="26" cy="26" r="22" fill="none" stroke="var(--border)" stroke-width="5" />
        <circle cx="26" cy="26" r="22" fill="none" stroke="#22c55e" stroke-width="5"
          stroke-dasharray="${unitArcLen} ${circumference}" stroke-dashoffset="${circumference * 0.25}" stroke-linecap="round" />
        <text x="26" y="28" text-anchor="middle" class="month-donut-pct">${o.occupancyPct}%</text>
      </svg>
    </div>
    <div class="month-row occ-row-total">
      <span class="month-row-label"><span class="month-row-dot occ-total"></span>Total Units</span>
      <span class="month-row-value">${o.totalUnits}</span>
    </div>
    <div class="month-row occ-row-occupied">
      <span class="month-row-label"><span class="month-row-dot occ-occupied"></span>Occupied</span>
      <span class="month-row-value">${o.occupiedUnits}</span>
    </div>
    <div class="month-row separator"></div>
    <div class="month-row occ-result">
      <span class="month-row-label">Available</span>
      <span class="month-row-value">${o.availableUnits}</span>
    </div>
    <div class="month-row separator"></div>
    <div class="month-col-section-label">
      <span>${revTitle}</span>
      <svg viewBox="0 0 52 52" class="month-donut-svg">
        <circle cx="26" cy="26" r="22" fill="none" stroke="var(--border)" stroke-width="5" />
        <circle cx="26" cy="26" r="22" fill="none" stroke="#3b82f6" stroke-width="5"
          stroke-dasharray="${revArcLen} ${circumference}" stroke-dashoffset="${circumference * 0.25}" stroke-linecap="round" />
        <text x="26" y="28" text-anchor="middle" class="month-donut-pct">${o.revenuePct}%</text>
      </svg>
    </div>
    <div class="month-row rev-potential">
      <span class="month-row-label"><span class="month-row-dot rev-pot"></span>Potential</span>
      <span class="month-row-value">${formatCurrency(o.maxPotential)}</span>
    </div>
    <div class="month-row rev-current">
      <span class="month-row-label"><span class="month-row-dot rev-cur"></span>Current</span>
      <span class="month-row-value">${formatCurrency(o.currentRevenue)}</span>
    </div>
    <div class="month-row separator"></div>
    <div class="month-row rev-result">
      <span class="month-row-label">Gap</span>
      <span class="month-row-value">${formatCurrency(o.revenueGap)}</span>
    </div>
  `;
}

function formatMonthLabelShort(monthStr) {
  const [year, month] = monthStr.split('-');
  const date = new Date(parseInt(year), parseInt(month) - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function renderTransactions() {
  const container = document.getElementById('transactionsTableContainer');
  document.getElementById('transactionCount').textContent = transactions.length;

  if (transactions.length === 0) {
    container.innerHTML = '<div class="empty-state">No transactions found for the selected filters.</div>';
    return;
  }

  const html = `
    <table class="transactions-table">
      <thead>
        <tr>
          <th style="width:90px">Date</th>
          <th style="width:30px"></th>
          <th style="width:130px">Category</th>
          <th class="col-description">Description</th>
          <th style="text-align: right; width:90px">Amount</th>
          <th class="col-method" style="width:70px">Method</th>
          <th class="col-status" style="width:90px">Status</th>
          <th style="width:90px">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${transactions.map(tx => renderTransactionRow(tx)).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = html;

  // Attach action button handlers
  container.querySelectorAll('.tx-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      const id = e.target.dataset.id;
      if (action === 'refund') openRefundModal(id);
      else if (action === 'void') handleVoid(id);
    });
  });
}

function renderTransactionRow(tx) {
  const dirIcon = tx.direction === 'income' ? '+' : '-';
  const amountClass = tx.direction === 'income' ? 'amount-income' : 'amount-expense';
  const prefix = tx.direction === 'expense' ? '-' : '';
  const personNameRaw = tx.person_name || (tx.person ? `${tx.person.first_name} ${tx.person.last_name}` : '');
  const personName = isDemoUser() ? redactString(personNameRaw || '—', 'name') : (personNameRaw || '—');
  const description = tx.description || '';
  const displayDesc = personName ? `${personName}${description ? ' — ' + description : ''}` : description || '—';

  const canRefund = tx.direction === 'income' && tx.payment_method === 'square' && tx.status === 'completed' && tx.square_payment_id && !isDemoUser();

  const rowClass = tx.status === 'voided' ? 'voided' : (tx.is_test ? 'test-row' : '');
  const testBadge = tx.is_test ? ' <span class="test-badge">sandbox</span>' : '';

  const amountDisplay = isDemoUser() ? redactString(prefix + formatCurrency(tx.amount), 'amount') : (prefix + formatCurrency(tx.amount));

  return `
    <tr class="${rowClass}">
      <td style="white-space: nowrap;">${formatDate(tx.transaction_date)}</td>
      <td><span class="direction-badge ${tx.direction}">${dirIcon}</span></td>
      <td><span class="category-badge">${CATEGORY_LABELS[tx.category] || tx.category}</span>${testBadge}</td>
      <td class="col-description ${isDemoUser() ? 'demo-redacted' : ''}" title="${escapeHtml(displayDesc)}">${escapeHtml(displayDesc)}</td>
      <td style="text-align: right;" class="${amountClass} ${isDemoUser() ? 'demo-redacted' : ''}">${amountDisplay}</td>
      <td class="col-method"><span class="method-badge">${PAYMENT_METHOD_LABELS[tx.payment_method] || tx.payment_method || '—'}</span></td>
      <td class="col-status"><span class="tx-status-badge ${tx.status}">${tx.status}</span></td>
      <td>
        <div class="tx-actions">
          ${canRefund ? `<button class="tx-action-btn refund" data-action="refund" data-id="${tx.id}">Refund</button>` : ''}
          ${tx.status !== 'voided' ? `<button class="tx-action-btn" data-action="void" data-id="${tx.id}">Void</button>` : ''}
        </div>
      </td>
    </tr>
  `;
}


function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// =============================================
// EVENT LISTENERS
// =============================================
function setupEventListeners() {
  // Filters
  document.getElementById('filterDateFrom').addEventListener('change', loadData);
  document.getElementById('filterDateTo').addEventListener('change', loadData);
  document.getElementById('filterDirection').addEventListener('change', loadData);
  document.getElementById('filterCategory').addEventListener('change', loadData);
  document.getElementById('filterMethod').addEventListener('change', loadData);
  document.getElementById('filterShowTest').addEventListener('change', loadData);

  let searchTimeout;
  document.getElementById('filterSearch').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(loadData, 300);
  });

  // Month window dropdown for summary column
  document.getElementById('monthWindowSelect').addEventListener('change', renderMonthColumns);

  // Preset buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyPreset(btn.dataset.preset);
    });
  });

  // Add Transaction
  document.getElementById('txCategory').addEventListener('change', togglePeriodFields);
  document.getElementById('addTransactionBtn').addEventListener('click', openTransactionModal);
  document.getElementById('closeTransactionModal').addEventListener('click', closeTransactionModal);
  document.getElementById('cancelTransactionBtn').addEventListener('click', closeTransactionModal);
  document.getElementById('saveTransactionBtn').addEventListener('click', saveTransaction);

  // Export CSV
  document.getElementById('exportCsvBtn').addEventListener('click', handleExportCSV);

  // Refund Modal
  document.getElementById('closeRefundModal').addEventListener('click', closeRefundModal);
  document.getElementById('cancelRefundBtn').addEventListener('click', closeRefundModal);
  document.getElementById('processRefundBtn').addEventListener('click', handleProcessRefund);

  // API Usage month selector
  populateMonthSelector();

  // Compute Cost Modal
  document.getElementById('addComputeCostBtn').addEventListener('click', openComputeCostModal);
  document.getElementById('closeComputeCostModal').addEventListener('click', closeComputeCostModal);
  document.getElementById('cancelComputeCostBtn').addEventListener('click', closeComputeCostModal);
  document.getElementById('saveComputeCostBtn').addEventListener('click', saveComputeCost);

  // Close modals on overlay click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  });
}

function applyPreset(preset) {
  const dateFrom = document.getElementById('filterDateFrom');
  const dateTo = document.getElementById('filterDateTo');

  switch (preset) {
    case 'month':
      dateFrom.value = getFirstOfMonth();
      dateTo.value = getToday();
      break;
    case 'last-month':
      dateFrom.value = getFirstOfLastMonth();
      dateTo.value = getLastDayOfLastMonth();
      break;
    case 'quarter':
      dateFrom.value = getFirstOfQuarter();
      dateTo.value = getToday();
      break;
    case 'ytd':
      dateFrom.value = getFirstOfYear();
      dateTo.value = getToday();
      break;
    case 'all':
      dateFrom.value = '';
      dateTo.value = '';
      break;
  }

  loadData();
}

// =============================================
// RECORD TRANSACTION
// =============================================
const RENT_CATEGORIES = ['rent', 'prorated_rent'];

function togglePeriodFields() {
  const category = document.getElementById('txCategory').value;
  const periodFields = document.getElementById('periodFields');
  if (RENT_CATEGORIES.includes(category)) {
    periodFields.style.display = '';
  } else {
    periodFields.style.display = 'none';
  }
}

function openTransactionModal() {
  document.getElementById('transactionModalTitle').textContent = 'Record Payment';
  document.getElementById('txId').value = '';
  document.getElementById('txDirection').value = 'income';
  document.getElementById('txCategory').value = 'rent';
  document.getElementById('txAmount').value = '';
  document.getElementById('txMethod').value = 'zelle';
  document.getElementById('txDate').value = getToday();
  document.getElementById('txPerson').value = '';
  document.getElementById('txPeriodStart').value = '';
  document.getElementById('txPeriodEnd').value = '';
  document.getElementById('txDescription').value = '';
  document.getElementById('txNotes').value = '';
  togglePeriodFields();
  document.getElementById('transactionModal').classList.remove('hidden');
}

function closeTransactionModal() {
  document.getElementById('transactionModal').classList.add('hidden');
}

async function saveTransaction() {
  const direction = document.getElementById('txDirection').value;
  const category = document.getElementById('txCategory').value;
  const amount = parseFloat(document.getElementById('txAmount').value);
  const paymentMethod = document.getElementById('txMethod').value;
  const transactionDate = document.getElementById('txDate').value;
  const personId = document.getElementById('txPerson').value || null;
  const periodStart = document.getElementById('txPeriodStart').value || null;
  const periodEnd = document.getElementById('txPeriodEnd').value || null;
  const description = document.getElementById('txDescription').value;
  const notes = document.getElementById('txNotes').value;

  if (!amount || amount <= 0) {
    showToast('Please enter a valid amount', 'error');
    return;
  }

  if (!transactionDate) {
    showToast('Please select a date', 'error');
    return;
  }

  // Get person name if selected
  let personName = null;
  if (personId) {
    const person = people.find(p => p.id === personId);
    if (person) personName = `${person.first_name} ${person.last_name}`;
  }

  try {
    await accountingService.createTransaction({
      direction,
      category,
      amount,
      paymentMethod,
      transactionDate,
      personId,
      personName,
      periodStart,
      periodEnd,
      description,
      notes,
      recordedBy: 'admin'
    });

    showToast('Transaction recorded', 'success');
    closeTransactionModal();
    await loadData();
  } catch (err) {
    console.error('Failed to save transaction:', err);
    showToast('Failed to save transaction', 'error');
  }
}

// =============================================
// REFUND
// =============================================
async function openRefundModal(ledgerId) {
  const tx = transactions.find(t => t.id === ledgerId);
  if (!tx) return;

  // Get already refunded amount
  let refundedAmount = 0;
  try {
    refundedAmount = await accountingService.getRefundedAmount(ledgerId);
  } catch (err) {
    console.error('Failed to get refunded amount:', err);
  }

  const originalAmount = parseFloat(tx.amount) || 0;
  const refundable = originalAmount - refundedAmount;

  document.getElementById('refundOriginalAmount').textContent = formatCurrency(originalAmount);
  document.getElementById('refundAlreadyRefunded').textContent = formatCurrency(refundedAmount);
  document.getElementById('refundRefundable').textContent = formatCurrency(refundable);
  document.getElementById('refundAmount').value = refundable.toFixed(2);
  document.getElementById('refundAmount').max = refundable;
  document.getElementById('refundReason').value = '';
  document.getElementById('refundLedgerId').value = ledgerId;

  // Get the Square payment ID from square_payments table via the FK
  if (tx.square_payment_id) {
    // Need to get the actual Square payment ID string (from Square API)
    try {
      const { data: spRecord } = await supabase
        .from('square_payments')
        .select('id, square_payment_id')
        .eq('id', tx.square_payment_id)
        .single();

      if (spRecord) {
        document.getElementById('refundSquarePaymentId').value = spRecord.square_payment_id || '';
        document.getElementById('refundPaymentRecordId').value = spRecord.id;
      }
    } catch (err) {
      console.error('Failed to look up Square payment:', err);
    }
  }

  document.getElementById('refundModal').classList.remove('hidden');
}

function closeRefundModal() {
  document.getElementById('refundModal').classList.add('hidden');
}

async function handleProcessRefund() {
  const ledgerId = document.getElementById('refundLedgerId').value;
  const squarePaymentId = document.getElementById('refundSquarePaymentId').value;
  const paymentRecordId = document.getElementById('refundPaymentRecordId').value;
  const amount = parseFloat(document.getElementById('refundAmount').value);
  const reason = document.getElementById('refundReason').value;

  if (!squarePaymentId) {
    showToast('No Square payment ID found — cannot process automated refund', 'error');
    return;
  }

  if (!amount || amount <= 0) {
    showToast('Please enter a valid refund amount', 'error');
    return;
  }

  const amountCents = Math.round(amount * 100);
  const btn = document.getElementById('processRefundBtn');
  btn.disabled = true;
  btn.textContent = 'Processing...';

  try {
    await accountingService.initiateRefund(squarePaymentId, amountCents, reason, ledgerId, paymentRecordId);
    showToast(`Refund of ${formatCurrency(amount)} processed successfully`, 'success');
    closeRefundModal();
    await loadData();
  } catch (err) {
    console.error('Refund failed:', err);
    showToast(`Refund failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Process Refund';
  }
}

// =============================================
// VOID
// =============================================
async function handleVoid(id) {
  if (!confirm('Are you sure you want to void this transaction? This cannot be undone.')) return;

  try {
    await accountingService.voidTransaction(id, 'Voided by admin');
    showToast('Transaction voided', 'success');
    await loadData();
  } catch (err) {
    console.error('Void failed:', err);
    showToast('Failed to void transaction', 'error');
  }
}

// =============================================
// EXPORT
// =============================================
async function handleExportCSV() {
  try {
    const filters = getFilters();
    await accountingService.downloadCSV(filters);
    showToast('CSV downloaded', 'success');
  } catch (err) {
    console.error('Export failed:', err);
    showToast('Failed to export CSV', 'error');
  }
}

// =============================================
// OCCUPANCY & REVENUE POTENTIAL
// =============================================
async function loadOccupancy() {
  try {
    // Load dwelling spaces
    const { data: spaces } = await supabase
      .from('spaces')
      .select('id, name, monthly_rate, weekly_rate, nightly_rate, parent_id, can_be_dwelling, is_archived')
      .eq('can_be_dwelling', true)
      .eq('is_archived', false)
      .order('monthly_rate', { ascending: false, nullsFirst: false });

    // Load active assignments with spaces
    const { data: assignments } = await supabase
      .from('assignments')
      .select('id, status, start_date, end_date, rate_amount, rate_term, is_free, desired_departure_date, desired_departure_listed, person:person_id(first_name, last_name), assignment_spaces(space_id)')
      .in('status', ['active', 'pending_contract', 'contract_sent']);

    if (!spaces || !assignments) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Determine occupancy for each space
    const spaceData = spaces.map(space => {
      const spaceAssignments = (assignments || []).filter(a =>
        a.assignment_spaces?.some(as => as.space_id === space.id)
      );

      const currentAssignment = spaceAssignments.find(a => {
        if (a.status !== 'active') return false;
        const effectiveEnd = (a.desired_departure_listed && a.desired_departure_date) || a.end_date;
        if (!effectiveEnd) return true; // indefinite
        return new Date(effectiveEnd + 'T00:00:00') >= today;
      });

      // Normalize rate to monthly for comparison
      let actualMonthly = 0;
      if (currentAssignment) {
        if (currentAssignment.is_free) {
          actualMonthly = 0;
        } else if (currentAssignment.rate_term === 'weekly') {
          actualMonthly = (parseFloat(currentAssignment.rate_amount) || 0) * 4.33;
        } else if (currentAssignment.rate_term === 'monthly') {
          actualMonthly = parseFloat(currentAssignment.rate_amount) || 0;
        } else {
          // flat or other - use rate_amount as monthly approximation
          actualMonthly = parseFloat(currentAssignment.rate_amount) || 0;
        }
      }

      return {
        id: space.id,
        name: space.name,
        monthlyRate: parseFloat(space.monthly_rate) || 0,
        weeklyRate: parseFloat(space.weekly_rate) || 0,
        parentId: space.parent_id,
        isOccupied: !!currentAssignment,
        isFree: currentAssignment?.is_free || false,
        actualMonthly: Math.round(actualMonthly * 100) / 100,
        occupantName: currentAssignment?.person
          ? `${currentAssignment.person.first_name} ${currentAssignment.person.last_name}`
          : null,
        rateTerm: currentAssignment?.rate_term || null,
      };
    });

    // Parent-child propagation (same logic as consumer view)
    // Pass 1: Parent → child
    for (const space of spaceData) {
      if (space.parentId && !space.isOccupied) {
        const parent = spaceData.find(s => s.id === space.parentId);
        if (parent && parent.isOccupied) {
          space.isOccupied = true;
          space.occupantName = parent.occupantName;
          space.actualMonthly = 0; // Revenue counted on parent
          space.isChildOfOccupied = true;
        }
      }
    }

    // Pass 2: Child → parent
    for (const space of spaceData) {
      if (!space.isOccupied) {
        const children = spaceData.filter(s => s.parentId === space.id);
        const occupiedChildren = children.filter(c => c.isOccupied);
        if (occupiedChildren.length > 0) {
          space.isOccupied = true;
          space.isParentOfOccupied = true;
          space.actualMonthly = 0; // Revenue counted on children
        }
      }
    }

    // Filter to only "leaf" or independently rentable units for counting
    // Exclude spaces that are only occupied because they are parents of occupied children
    // (the children are the actual rentable units)
    const countableSpaces = spaceData.filter(s => {
      // If this space has children that are also dwellings, don't count this as a separate unit
      const hasChildDwellings = spaceData.some(c => c.parentId === s.id);
      return !hasChildDwellings;
    });

    renderOccupancy(countableSpaces, spaceData);
  } catch (err) {
    console.error('Failed to load occupancy:', err);
  }
}

function renderOccupancy(countableSpaces, allSpaces) {
  const totalUnits = countableSpaces.length;
  const occupiedUnits = countableSpaces.filter(s => s.isOccupied).length;
  const availableUnits = totalUnits - occupiedUnits;
  const occupancyPct = totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 100) : 0;

  // Revenue calculation
  const maxPotential = countableSpaces.reduce((sum, s) => sum + s.monthlyRate, 0);
  const currentRevenue = countableSpaces
    .filter(s => s.isOccupied && !s.isChildOfOccupied)
    .reduce((sum, s) => sum + s.actualMonthly, 0);
  const revenueGap = maxPotential - currentRevenue;
  const revenuePct = maxPotential > 0 ? Math.round((currentRevenue / maxPotential) * 100) : 0;

  // Store globally for month columns to use
  occupancyData = {
    occupancyPct,
    occupiedUnits,
    availableUnits,
    totalUnits,
    revenuePct,
    currentRevenue,
    maxPotential,
    revenueGap,
  };

  // Re-render month columns now that occupancy data is available
  renderMonthColumns();

  // Render unit breakdown
  renderUnitBreakdown(allSpaces);
}

function renderUnitBreakdown(spaces) {
  const container = document.getElementById('unitBreakdown');

  // Sort: occupied first, then by rate descending
  const sorted = [...spaces].sort((a, b) => {
    if (a.isOccupied !== b.isOccupied) return a.isOccupied ? -1 : 1;
    return (b.monthlyRate || 0) - (a.monthlyRate || 0);
  });

  const maxRate = Math.max(...spaces.map(s => s.monthlyRate || 0), 1);

  const rows = sorted.map(space => {
    const barWidth = space.monthlyRate > 0 ? Math.max(5, (space.monthlyRate / maxRate) * 100) : 5;
    const barClass = space.isOccupied ? 'occupied' : 'vacant';

    let statusTag;
    if (space.isFree) {
      statusTag = '<span class="unit-status-tag free">Free</span>';
    } else if (space.isOccupied) {
      statusTag = '<span class="unit-status-tag occupied">Occupied</span>';
    } else {
      statusTag = '<span class="unit-status-tag vacant">Vacant</span>';
    }

    const rateDisplay = space.isOccupied && !space.isChildOfOccupied && !space.isParentOfOccupied
      ? formatCurrency(space.actualMonthly) + '/mo'
      : space.monthlyRate > 0
        ? formatCurrency(space.monthlyRate) + '/mo'
        : '—';

    return `
      <div class="unit-row">
        <span class="unit-name" title="${escapeHtml(space.name)}">${escapeHtml(space.name)}</span>
        <div class="unit-bar-container">
          <div class="unit-bar ${barClass}" style="width: ${barWidth}%"></div>
        </div>
        <span class="unit-rate">${rateDisplay}</span>
        ${statusTag}
      </div>
    `;
  }).join('');

  container.innerHTML = rows || '<div class="empty-state">No dwelling spaces found</div>';
}

// =============================================
// API USAGE
// =============================================

// Vendor config: limits, pricing, display
const API_VENDORS = {
  resend: {
    label: 'Resend',
    color: '#000',
    metrics: [
      { key: 'outbound', label: 'Outbound Emails', dailyLimit: 100, limitNote: '100/day free tier' },
      { key: 'inbound', label: 'Inbound Emails' },
    ],
    costPer: 0.00028,
    costUnit: 'email',
  },
  telnyx: {
    label: 'Telnyx',
    color: '#00c08b',
    metrics: [
      { key: 'outbound', label: 'Outbound SMS', costPer: 0.004 },
      { key: 'inbound', label: 'Inbound SMS', costPer: 0.001 },
    ],
    costUnit: 'segment',
  },
  signwell: {
    label: 'SignWell',
    color: '#6366f1',
    metrics: [
      { key: 'documents', label: 'Documents', monthlyLimit: 25, limitNote: '25/month free' },
    ],
    costPer: 0,
    costUnit: 'doc',
  },
  gemini: {
    label: 'Gemini',
    color: '#4285f4',
    metrics: [
      { key: 'image_gen', label: 'Image Gen' },
      { key: 'pai_chat', label: 'PAI Chat' },
      { key: 'other', label: 'Other' },
    ],
    costUnit: 'request',
  },
  vapi: {
    label: 'Vapi',
    color: '#5b21b6',
    metrics: [
      { key: 'calls', label: 'Voice Calls' },
      { key: 'minutes', label: 'Minutes', isFloat: true },
    ],
    costUnit: 'call',
  },
  anthropic: {
    label: 'Anthropic',
    color: '#d97706',
    metrics: [
      { key: 'requests', label: 'API Calls' },
    ],
    costUnit: 'request',
  },
};

function getMonthOptions() {
  const now = new Date();
  const options = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    options.push({ val, label, isCurrent: i === 0 });
  }
  return options;
}

function populateMonthSelector() {
  const select = document.getElementById('apiUsageMonthSelect');
  const options = getMonthOptions();
  select.innerHTML = options.map(o =>
    `<option value="${o.val}"${o.isCurrent ? ' selected' : ''}>${o.label}</option>`
  ).join('');
  select.addEventListener('change', loadApiUsage);
}

async function loadApiUsage() {
  const container = document.getElementById('apiUsageContainer');
  const totalEl = document.getElementById('apiUsageTotalCost');

  // Get selected month
  const select = document.getElementById('apiUsageMonthSelect');
  if (!select.options.length) populateMonthSelector();
  const selectedMonth = select.value;
  const [year, month] = selectedMonth.split('-').map(Number);
  const monthStart = `${selectedMonth}-01T00:00:00`;
  const nextMonth = new Date(year, month, 1);
  const monthEnd = nextMonth.toISOString();

  try {
    // Fetch all data sources in parallel
    const [
      apiLogResult,
      smsResult,
      inboundEmailResult,
      imageGenResult,
      voiceCallResult,
      signwellDocsResult,
    ] = await Promise.all([
      // api_usage_log (new table — may have data going forward)
      supabase.from('api_usage_log')
        .select('vendor, category, units, unit_type, estimated_cost_usd, created_at')
        .gte('created_at', monthStart)
        .lt('created_at', monthEnd),
      // SMS messages (existing data)
      supabase.from('sms_messages')
        .select('direction, created_at')
        .gte('created_at', monthStart)
        .lt('created_at', monthEnd),
      // Inbound emails (existing data)
      supabase.from('inbound_emails')
        .select('route_action, created_at')
        .gte('created_at', monthStart)
        .lt('created_at', monthEnd),
      // Image gen jobs (existing data)
      supabase.from('image_gen_jobs')
        .select('status, estimated_cost_usd, created_at')
        .eq('status', 'completed')
        .gte('created_at', monthStart)
        .lt('created_at', monthEnd),
      // Voice calls (existing data)
      supabase.from('voice_calls')
        .select('duration_seconds, cost_usd, created_at')
        .gte('created_at', monthStart)
        .lt('created_at', monthEnd),
      // SignWell documents (from rental_applications — source of truth)
      supabase.from('rental_applications')
        .select('signwell_document_id, created_at')
        .not('signwell_document_id', 'is', null)
        .gte('created_at', monthStart)
        .lt('created_at', monthEnd),
    ]);

    const apiLog = apiLogResult.data || [];
    const smsMessages = smsResult.data || [];
    const inboundEmails = inboundEmailResult.data || [];
    const imageGenJobs = imageGenResult.data || [];
    const voiceCalls = voiceCallResult.data || [];
    const signwellDocs = signwellDocsResult.data || [];

    // Count outbound emails from api_usage_log (new logging)
    const emailsFromLog = apiLog.filter(r => r.vendor === 'resend');
    const emailOutboundCount = emailsFromLog.reduce((s, r) => s + (parseFloat(r.units) || 0), 0);

    // Count outbound emails for today (for daily limit)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const emailsTodayFromLog = emailsFromLog.filter(r => new Date(r.created_at) >= todayStart);
    const emailTodayCount = emailsTodayFromLog.reduce((s, r) => s + (parseFloat(r.units) || 0), 0);

    // SMS from existing sms_messages table
    const smsOutbound = smsMessages.filter(m => m.direction === 'outbound').length;
    const smsInbound = smsMessages.filter(m => m.direction === 'inbound').length;

    // Also check api_usage_log for SMS (future data)
    const smsFromLog = apiLog.filter(r => r.vendor === 'telnyx');
    // Use whichever is higher (avoid double-counting)
    const smsOutboundFinal = Math.max(smsOutbound, smsFromLog.filter(r => r.category?.includes('outbound') || !r.category?.includes('inbound')).length);
    const smsInboundFinal = Math.max(smsInbound, smsFromLog.filter(r => r.category?.includes('inbound')).length);

    // Inbound emails count
    const inboundEmailCount = inboundEmails.length;

    // Image gen from image_gen_jobs
    const imageGenCount = imageGenJobs.length;
    const imageGenCost = imageGenJobs.reduce((s, j) => s + (parseFloat(j.estimated_cost_usd) || 0), 0);

    // Gemini from api_usage_log (PAI chat, payment matching, etc.)
    const geminiFromLog = apiLog.filter(r => r.vendor === 'gemini');
    const geminiPaiCount = geminiFromLog.filter(r => r.category?.includes('pai')).length;
    const geminiOtherCount = geminiFromLog.filter(r => !r.category?.includes('pai') && !r.category?.includes('image')).length;
    const geminiCost = geminiFromLog.reduce((s, r) => s + (parseFloat(r.estimated_cost_usd) || 0), 0);

    // Voice calls
    const voiceCallCount = voiceCalls.length;
    const voiceMinutes = voiceCalls.reduce((s, c) => s + ((c.duration_seconds || 0) / 60), 0);
    const voiceCost = voiceCalls.reduce((s, c) => s + (parseFloat(c.cost_usd) || 0), 0);

    // Anthropic from api_usage_log
    const anthropicFromLog = apiLog.filter(r => r.vendor === 'anthropic');
    const anthropicCount = anthropicFromLog.length;
    const anthropicCost = anthropicFromLog.reduce((s, r) => s + (parseFloat(r.estimated_cost_usd) || 0), 0);

    // SignWell — count from rental_applications (source of truth)
    const signwellCount = signwellDocs.length;

    // Build vendor data
    const vendorData = [
      {
        id: 'resend',
        label: 'Resend',
        color: '#000',
        totalCost: emailOutboundCount * 0.00028,
        rows: [
          { label: 'Outbound Emails', count: emailOutboundCount, dailyLimit: 100, dailyCount: emailTodayCount, limitNote: '100/day free tier' },
          { label: 'Inbound Emails', count: inboundEmailCount },
        ],
      },
      {
        id: 'telnyx',
        label: 'Telnyx',
        color: '#00c08b',
        totalCost: (smsOutboundFinal * 0.004) + (smsInboundFinal * 0.001),
        rows: [
          { label: 'Outbound SMS', count: smsOutboundFinal, costEach: '$0.004' },
          { label: 'Inbound SMS', count: smsInboundFinal, costEach: '$0.001' },
        ],
      },
      {
        id: 'signwell',
        label: 'SignWell',
        color: '#6366f1',
        totalCost: 0,
        rows: [
          { label: 'Documents', count: signwellCount, monthlyLimit: 25, limitNote: '25/month free' },
        ],
      },
      {
        id: 'gemini',
        label: 'Gemini',
        color: '#4285f4',
        totalCost: imageGenCost + geminiCost,
        rows: [
          { label: 'Image Gen', count: imageGenCount },
          { label: 'PAI Chat', count: geminiPaiCount },
          ...(geminiOtherCount > 0 ? [{ label: 'Other', count: geminiOtherCount }] : []),
        ],
      },
      {
        id: 'vapi',
        label: 'Vapi',
        color: '#5b21b6',
        totalCost: voiceCost,
        rows: [
          { label: 'Calls', count: voiceCallCount },
          { label: 'Minutes', count: voiceMinutes, isFloat: true },
        ],
      },
      {
        id: 'anthropic',
        label: 'Anthropic',
        color: '#d97706',
        totalCost: anthropicCost,
        rows: [
          { label: 'API Calls', count: anthropicCount },
        ],
      },
    ];

    // Filter out vendors with zero activity (but keep limit-sensitive ones always)
    const alwaysShow = ['resend', 'telnyx', 'signwell'];
    const filtered = vendorData.filter(v =>
      alwaysShow.includes(v.id) ||
      v.rows.some(r => r.count > 0) ||
      v.totalCost > 0
    );

    const grandTotal = filtered.reduce((s, v) => s + v.totalCost, 0);
    totalEl.textContent = '$' + grandTotal.toFixed(2);

    apiUsageData = filtered;
    renderApiUsage(filtered);
  } catch (err) {
    console.error('Failed to load API usage:', err);
    container.innerHTML = '<div class="empty-state">Failed to load API usage data.</div>';
  }
}

function renderApiUsage(vendors) {
  const container = document.getElementById('apiUsageContainer');

  if (!vendors || vendors.length === 0) {
    container.innerHTML = '<div class="empty-state">No API usage data yet.</div>';
    return;
  }

  const cards = vendors.map(v => {
    const costDisplay = v.totalCost > 0 ? '$' + v.totalCost.toFixed(4) : 'Free';
    const costClass = v.totalCost > 0 ? '' : ' api-usage-card-cost-free';

    const rows = v.rows.map(r => {
      const countDisplay = r.isFloat ? r.count.toFixed(1) : Math.round(r.count);

      // Build bar if there's a limit
      let barHtml = '';
      if (r.dailyLimit) {
        const pct = Math.min(100, (r.dailyCount / r.dailyLimit) * 100);
        const barClass = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'safe';
        barHtml = `
          <div class="api-usage-bar">
            <div class="api-usage-bar-fill ${barClass}" style="width: ${pct}%"></div>
          </div>
          <div class="api-usage-row-top">
            <span class="api-usage-row-label">Today: ${Math.round(r.dailyCount)} / ${r.dailyLimit}</span>
            <span class="api-usage-row-value" style="font-size: 0.65rem; color: var(--text-muted);">${r.limitNote || ''}</span>
          </div>
        `;
      } else if (r.monthlyLimit) {
        const pct = Math.min(100, (r.count / r.monthlyLimit) * 100);
        const barClass = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'safe';
        barHtml = `
          <div class="api-usage-bar">
            <div class="api-usage-bar-fill ${barClass}" style="width: ${pct}%"></div>
          </div>
          <div class="api-usage-row-top">
            <span class="api-usage-row-label">${Math.round(r.count)} / ${r.monthlyLimit} used</span>
            <span class="api-usage-row-value" style="font-size: 0.65rem; color: var(--text-muted);">${r.limitNote || ''}</span>
          </div>
        `;
      }

      return `
        <div class="api-usage-row">
          <div class="api-usage-row-top">
            <span class="api-usage-row-label">${escapeHtml(r.label)}</span>
            <span class="api-usage-row-value">${countDisplay}${r.costEach ? ` × ${r.costEach}` : ''}</span>
          </div>
          ${barHtml}
        </div>
      `;
    }).join('');

    return `
      <div class="api-usage-card">
        <div class="api-usage-card-header">
          <span class="api-usage-card-vendor" style="color: ${v.color};">${escapeHtml(v.label)}</span>
          <span class="api-usage-card-cost${costClass}">${costDisplay}</span>
        </div>
        <div class="api-usage-card-rows">
          ${rows}
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `<div class="api-usage-grid">${cards}</div>`;
}

// =============================================
// COMPUTE COSTS
// =============================================
const SERVICE_LABELS = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  digitalocean: 'DigitalOcean',
  supabase: 'Supabase',
  telnyx: 'Telnyx',
  resend: 'Resend',
  signwell: 'SignWell',
  vapi: 'Vapi',
  other: 'Other',
};

const SERVICE_COLORS = {
  gemini: '#4285f4',
  openai: '#10a37f',
  anthropic: '#d97706',
  digitalocean: '#0080ff',
  supabase: '#3ecf8e',
  telnyx: '#00c08b',
  resend: '#000',
  signwell: '#6366f1',
  vapi: '#5b21b6',
  other: '#6b7280',
};

async function loadComputeCosts() {
  try {
    const { data, error } = await supabase
      .from('compute_costs')
      .select('*')
      .order('date', { ascending: false });

    if (error) throw error;
    computeCosts = data || [];
    renderComputeCosts();
  } catch (err) {
    console.error('Failed to load compute costs:', err);
    document.getElementById('computeCostsContainer').innerHTML =
      '<div class="empty-state">Failed to load compute costs.</div>';
  }
}

function renderComputeCosts() {
  const container = document.getElementById('computeCostsContainer');
  const totalEl = document.getElementById('computeCostTotal');

  if (computeCosts.length === 0) {
    container.innerHTML = '<div class="empty-state">No compute cost entries yet.</div>';
    totalEl.textContent = '$0.00';
    return;
  }

  const total = computeCosts.reduce((sum, c) => sum + parseFloat(c.cost_usd || 0), 0);
  totalEl.textContent = '$' + total.toFixed(2);

  const rows = computeCosts.map(c => {
    const color = SERVICE_COLORS[c.service] || SERVICE_COLORS.other;
    const label = SERVICE_LABELS[c.service] || c.service;
    const cost = parseFloat(c.cost_usd || 0);
    const costDisplay = cost === 0 ? 'Free' : '$' + cost.toFixed(4);
    const costClass = cost === 0 ? 'cc-cost-free' : '';

    return `
      <tr>
        <td style="white-space: nowrap;">${formatDate(c.date)}</td>
        <td><span class="cc-service-badge" style="background: ${color}15; color: ${color}; border: 1px solid ${color}40;">${escapeHtml(label)}</span></td>
        <td>${escapeHtml(c.description)}</td>
        <td class="cc-cost ${costClass}" style="text-align: right; white-space: nowrap;">${costDisplay}</td>
        <td class="cc-notes-cell">${c.notes ? `<span class="cc-notes" title="${escapeHtml(c.notes)}">${escapeHtml(c.notes)}</span>` : ''}</td>
        <td>
          <button class="tx-action-btn cc-delete-btn" data-id="${c.id}" title="Delete">×</button>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="cc-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Service</th>
          <th>Description</th>
          <th style="text-align: right;">Cost</th>
          <th>Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // Attach delete handlers
  container.querySelectorAll('.cc-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteComputeCost(btn.dataset.id));
  });
}

function openComputeCostModal() {
  document.getElementById('computeCostModalTitle').textContent = 'Add Compute Cost';
  document.getElementById('ccId').value = '';
  document.getElementById('ccDate').value = getToday();
  document.getElementById('ccService').value = 'gemini';
  document.getElementById('ccDescription').value = '';
  document.getElementById('ccCost').value = '';
  document.getElementById('ccNotes').value = '';
  document.getElementById('computeCostModal').classList.remove('hidden');
}

function closeComputeCostModal() {
  document.getElementById('computeCostModal').classList.add('hidden');
}

async function saveComputeCost() {
  const date = document.getElementById('ccDate').value;
  const service = document.getElementById('ccService').value;
  const description = document.getElementById('ccDescription').value.trim();
  const cost = parseFloat(document.getElementById('ccCost').value) || 0;
  const notes = document.getElementById('ccNotes').value.trim();

  if (!date || !description) {
    showToast('Date and description are required', 'error');
    return;
  }

  try {
    const { error } = await supabase.from('compute_costs').insert({
      date,
      service,
      description,
      cost_usd: cost,
      notes: notes || null,
    });

    if (error) throw error;

    showToast('Compute cost entry added', 'success');
    closeComputeCostModal();
    await loadComputeCosts();
  } catch (err) {
    console.error('Failed to save compute cost:', err);
    showToast('Failed to save entry', 'error');
  }
}

async function deleteComputeCost(id) {
  if (!confirm('Delete this compute cost entry?')) return;

  try {
    const { error } = await supabase.from('compute_costs').delete().eq('id', id);
    if (error) throw error;

    showToast('Entry deleted', 'success');
    await loadComputeCosts();
  } catch (err) {
    console.error('Failed to delete compute cost:', err);
    showToast('Failed to delete entry', 'error');
  }
}
