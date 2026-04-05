import { supabase } from '../shared/supabase.js';
import { initResidentPage, showToast } from '../shared/resident-shell.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['active', 'pending_contract', 'contract_sent'];

document.addEventListener('DOMContentLoaded', async () => {
  await initResidentPage({
    activeTab: 'bookkeeping',
    requiredRole: 'resident',
    requiredPermission: 'view_profile',
    onReady: async (state) => {
      await loadBookkeeping(state.appUser);
    },
  });
});

async function loadBookkeeping(appUser) {
  console.log('[bookkeeping] Loading for appUser:', { id: appUser?.id, email: appUser?.email, person_id: appUser?.person_id, role: appUser?.role });

  const personId = await resolvePersonId(appUser);
  console.log('[bookkeeping] Resolved personId:', personId);

  if (!personId) {
    renderEmptyState('bookkeepingSummary', 'No linked person record found', 'Your user account is not linked to a person record in the system. An admin can link your account on the Users page.');
    renderEmptyState('paymentsList', 'No payments to show', 'Once your account is linked, your payment history will appear here.');
    renderEmptyState('ownedAssets', 'No ownership data', 'Space assignments and vehicle links will appear here once your account is linked.');
    renderEmptyState('rentalTerms', 'No rental terms', 'Your lease and rental details will appear here once your account is linked.');
    return;
  }

  // Load each data source independently so one failure doesn't block the rest
  const safeLoad = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[bookkeeping] Failed to load ${name}:`, err);
      return null; // null signals failure for this section
    }
  };

  const [applications, payments, assignments, vehicles] = await Promise.all([
    safeLoad('applications', () => loadApplications(personId)),
    safeLoad('payments', () => loadPayments(personId)),
    safeLoad('assignments', () => loadAssignments(personId)),
    safeLoad('vehicles', () => loadVehicles(personId)),
  ]);

  const failures = [];
  if (applications === null) failures.push('applications');
  if (payments === null) failures.push('payments');
  if (assignments === null) failures.push('assignments');
  if (vehicles === null) failures.push('vehicles');

  if (failures.length) {
    console.warn('[bookkeeping] Some sections failed to load:', failures);
    showToast(`Some bookkeeping data could not be loaded (${failures.join(', ')})`, 'error');
  }

  console.log('[bookkeeping] Data loaded:', {
    applications: applications?.length ?? 'FAILED',
    payments: payments?.length ?? 'FAILED',
    assignments: assignments?.length ?? 'FAILED',
    vehicles: vehicles?.length ?? 'FAILED',
  });

  renderSummary(payments || [], assignments || [], vehicles || []);
  renderPayments(payments || []);
  renderOwnedAssets(assignments || [], vehicles || []);
  renderRentalTerms(applications || [], assignments || []);
}

async function resolvePersonId(appUser) {
  if (appUser?.person_id) {
    console.log('[bookkeeping] Using appUser.person_id:', appUser.person_id);
    return appUser.person_id;
  }
  if (!appUser?.email) {
    console.warn('[bookkeeping] No person_id and no email on appUser — cannot resolve person');
    return null;
  }

  console.log('[bookkeeping] No person_id on appUser, looking up by email:', appUser.email);
  const { data, error } = await supabase
    .from('people')
    .select('id')
    .eq('email', appUser.email)
    .limit(1);

  if (error) {
    console.warn('[bookkeeping] Error looking up person by email:', error);
    return null;
  }
  if (!data?.length) {
    console.warn('[bookkeeping] No person record found for email:', appUser.email);
    return null;
  }
  console.log('[bookkeeping] Resolved person by email lookup:', data[0].id);
  return data[0].id;
}

async function loadApplications(personId) {
  const { data, error } = await supabase
    .from('rental_applications')
    .select(`
      id,
      created_at,
      application_status,
      agreement_status,
      agreement_document_url,
      approved_move_in,
      approved_lease_end,
      approved_rate,
      approved_rate_term,
      approved_space:approved_space_id(id, name, monthly_rate),
      desired_space:desired_space_id(id, name, monthly_rate)
    `)
    .eq('person_id', personId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function loadPayments(personId) {
  // rental_payments links via rental_application_id and assignment_id, not person_id
  // First resolve the person's application and assignment IDs
  const [appRes, assignRes] = await Promise.all([
    supabase.from('rental_applications').select('id').eq('person_id', personId),
    supabase.from('assignments').select('id').eq('person_id', personId),
  ]);

  if (appRes.error) throw appRes.error;
  if (assignRes.error) throw assignRes.error;

  const appIds = (appRes.data || []).map(a => a.id);
  const assignIds = (assignRes.data || []).map(a => a.id);

  if (!appIds.length && !assignIds.length) return [];

  // Build OR filter for payments linked to this person's applications or assignments
  const filters = [];
  if (appIds.length) filters.push(`rental_application_id.in.(${appIds.join(',')})`);
  if (assignIds.length) filters.push(`assignment_id.in.(${assignIds.join(',')})`);

  const { data, error } = await supabase
    .from('rental_payments')
    .select('*')
    .or(filters.join(','))
    .order('paid_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function loadAssignments(personId) {
  const { data, error } = await supabase
    .from('assignments')
    .select(`
      id,
      status,
      start_date,
      end_date,
      desired_departure_date,
      desired_departure_listed,
      monthly_rent,
      rate_amount,
      rate_term,
      assignment_spaces(space:space_id(id, name, type, monthly_rate))
    `)
    .eq('person_id', personId)
    .in('status', ACTIVE_ASSIGNMENT_STATUSES)
    .order('start_date', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function loadVehicles(personId) {
  if (!personId) return [];

  // Vehicles are linked to people via the vehicle_drivers junction table
  const { data, error } = await supabase
    .from('vehicle_drivers')
    .select('vehicle:vehicle_id(id, name, vehicle_make, vehicle_model, year, color, is_active, display_order)')
    .eq('person_id', personId);

  if (error) throw error;

  // Flatten join rows, keep only active vehicles, sort by display_order
  return (data || [])
    .map(d => d.vehicle)
    .filter(v => v && v.is_active)
    .sort((a, b) => (a.display_order ?? 999) - (b.display_order ?? 999));
}

function renderSummary(payments, assignments, vehicles) {
  const el = document.getElementById('bookkeepingSummary');
  if (!el) return;

  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount_paid || 0), 0);
  const rentedSpaces = new Set();
  for (const assignment of assignments) {
    for (const relation of assignment.assignment_spaces || []) {
      if (relation?.space?.id) rentedSpaces.add(relation.space.id);
    }
  }

  el.innerHTML = `
    <div class="bookkeeping-stat-card">
      <span class="bookkeeping-stat-label">Total Paid</span>
      <span class="bookkeeping-stat-value">${formatCurrency(totalPaid)}</span>
    </div>
    <div class="bookkeeping-stat-card">
      <span class="bookkeeping-stat-label">Payments Recorded</span>
      <span class="bookkeeping-stat-value">${payments.length}</span>
    </div>
    <div class="bookkeeping-stat-card">
      <span class="bookkeeping-stat-label">Spaces Assigned</span>
      <span class="bookkeeping-stat-value">${rentedSpaces.size}</span>
    </div>
    <div class="bookkeeping-stat-card">
      <span class="bookkeeping-stat-label">Owned Vehicles</span>
      <span class="bookkeeping-stat-value">${vehicles.length}</span>
    </div>
  `;
}

function renderPayments(payments) {
  const el = document.getElementById('paymentsList');
  if (!el) return;
  if (!payments.length) {
    renderNoData('paymentsList', 'No payments have been recorded yet. Payments will appear here as they are logged.');
    return;
  }

  el.innerHTML = `
    <div class="bookkeeping-table-wrap">
      <table class="bookkeeping-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Method</th>
            <th>Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${payments.map(payment => `
            <tr>
              <td>${formatDate(payment.paid_date || payment.created_at)}</td>
              <td>${toTitleCase(payment.payment_type)}</td>
              <td>${toTitleCase(payment.payment_method)}</td>
              <td>${formatCurrency(payment.amount_paid || payment.amount_due || 0)}</td>
              <td>${toTitleCase(payment.status || 'completed')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderOwnedAssets(assignments, vehicles) {
  const el = document.getElementById('ownedAssets');
  if (!el) return;

  const spaceCards = [];
  for (const assignment of assignments) {
    for (const relation of assignment.assignment_spaces || []) {
      if (!relation?.space) continue;
      spaceCards.push({
        name: relation.space.name,
        type: relation.space.type,
        assignmentStatus: assignment.status,
        monthlyRate: assignment.monthly_rent || assignment.rate_amount || relation.space.monthly_rate,
      });
    }
  }

  const ownedVehiclesHtml = vehicles.length
    ? vehicles.map(v => `
      <div class="bookkeeping-item-card">
        <div>
          <div class="bookkeeping-item-title">${escapeHtml(v.name || `${v.year || ''} ${v.vehicle_make || ''} ${v.vehicle_model || ''}`.trim() || 'Vehicle')}</div>
          <div class="bookkeeping-item-meta">${escapeHtml([v.year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')) || 'Vehicle'}</div>
        </div>
        <div class="bookkeeping-item-right">
          <span class="bookkeeping-chip">Driver</span>
        </div>
      </div>
    `).join('')
    : '<p style="color:var(--text-muted,#7d6f74);font-size:0.85rem;padding:0.5rem 0">No vehicles currently linked to your account.</p>';

  const rentedSpacesHtml = spaceCards.length
    ? spaceCards.map(space => `
      <div class="bookkeeping-item-card">
        <div>
          <div class="bookkeeping-item-title">${escapeHtml(space.name || 'Assigned space')}</div>
          <div class="bookkeeping-item-meta">${toTitleCase(space.type)} space</div>
        </div>
        <div class="bookkeeping-item-right">
          <span class="bookkeeping-chip">${toTitleCase(space.assignmentStatus)}</span>
          <span class="bookkeeping-item-meta">${formatCurrency(space.monthlyRate || 0)}/mo</span>
        </div>
      </div>
    `).join('')
    : '<p style="color:var(--text-muted,#7d6f74);font-size:0.85rem;padding:0.5rem 0">No current space assignments.</p>';

  el.innerHTML = `
    <div class="bookkeeping-subsection">
      <h3>Assigned Spaces</h3>
      ${rentedSpacesHtml}
    </div>
    <div class="bookkeeping-subsection">
      <h3>Owned Vehicles</h3>
      ${ownedVehiclesHtml}
    </div>
  `;
}

function renderRentalTerms(applications, assignments) {
  const el = document.getElementById('rentalTerms');
  if (!el) return;
  if (!applications.length && !assignments.length) {
    renderNoData('rentalTerms', 'No rental terms found. Active assignments and applications will appear here.');
    return;
  }

  const latestApp = applications[0] || null;
  const latestAssignment = assignments[0] || null;

  const agreementStatus = latestApp?.agreement_status || 'n/a';
  const agreementUrl = latestApp?.agreement_document_url || '';
  const rentAmount = latestApp?.approved_rate || latestAssignment?.monthly_rent || latestAssignment?.rate_amount || 0;
  const leaseStart = latestApp?.approved_move_in || latestAssignment?.start_date || null;
  const leaseEnd = latestApp?.approved_lease_end || latestAssignment?.end_date || latestAssignment?.desired_departure_date || null;
  const rateTerm = latestApp?.approved_rate_term || latestAssignment?.rate_term || 'month';
  const spaceName = latestApp?.approved_space?.name || latestApp?.desired_space?.name || getFirstAssignedSpaceName(latestAssignment);

  el.innerHTML = `
    <div class="bookkeeping-item-card">
      <div>
        <div class="bookkeeping-item-title">${escapeHtml(spaceName || 'Current rental')}</div>
        <div class="bookkeeping-item-meta">
          ${leaseStart ? `Start: ${formatDate(leaseStart)}` : 'Start date: N/A'}
          ${leaseEnd ? ` · End: ${formatDate(leaseEnd)}` : ''}
        </div>
      </div>
      <div class="bookkeeping-item-right">
        <span class="bookkeeping-chip">${toTitleCase(agreementStatus)}</span>
        <span class="bookkeeping-item-meta">${formatCurrency(rentAmount)} / ${escapeHtml(rateTerm)}</span>
      </div>
    </div>
    <div class="bookkeeping-term-list">
      <div class="bookkeeping-term-row"><span>Lease Term</span><strong>${leaseStart && leaseEnd ? `${formatDate(leaseStart)} - ${formatDate(leaseEnd)}` : 'N/A'}</strong></div>
      <div class="bookkeeping-term-row"><span>Rent</span><strong>${formatCurrency(rentAmount)} / ${escapeHtml(rateTerm)}</strong></div>
      <div class="bookkeeping-term-row"><span>Agreement Status</span><strong>${toTitleCase(agreementStatus)}</strong></div>
      <div class="bookkeeping-term-row"><span>Agreement Document</span><strong>${agreementUrl ? `<a href="${agreementUrl}" target="_blank" rel="noopener">Open</a>` : 'Not linked'}</strong></div>
    </div>
  `;
}

function getFirstAssignedSpaceName(assignment) {
  const space = assignment?.assignment_spaces?.[0]?.space;
  return space?.name || null;
}

function renderNoData(containerId, message) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<p style="color:var(--text-muted,#7d6f74);font-size:0.88rem;padding:0.5rem 0">${escapeHtml(message)}</p>`;
}

function renderEmptyState(containerId, title, subtitle) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `
    <div style="padding:1rem;border:1px dashed var(--border,#e6e2d9);border-radius:var(--radius,8px);text-align:center">
      <p style="font-weight:600;font-size:0.92rem;margin:0 0 0.25rem;color:var(--text,#2a1f23)">${escapeHtml(title)}</p>
      <p style="font-size:0.82rem;margin:0;color:var(--text-muted,#7d6f74)">${escapeHtml(subtitle)}</p>
    </div>
  `;
}

function toTitleCase(value) {
  const str = String(value || '').trim();
  if (!str) return 'N/A';
  return str
    .replace(/_/g, ' ')
    .split(' ')
    .map(part => part ? (part[0].toUpperCase() + part.slice(1).toLowerCase()) : '')
    .join(' ');
}

function formatDate(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleDateString();
}

function formatCurrency(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}
