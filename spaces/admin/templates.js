/**
 * Templates - Document & Email Template Management
 * Two-panel layout: sidebar navigation + editor panel
 */

import { supabase } from '../../shared/supabase.js';
import { initAdminPage, showToast } from '../../shared/admin-shell.js';
import { leaseTemplateService } from '../../shared/lease-template-service.js';
import { eventTemplateService } from '../../shared/event-template-service.js';
import { worktradeTemplateService } from '../../shared/worktrade-template-service.js';
import { emailTemplateService, renderTemplate } from '../../shared/email-template-service.js';
import { formatDateAustin } from '../../shared/timezone.js';

// =============================================
// STATE
// =============================================

let authState = null;
let activeSection = null; // 'lease' | 'event' | 'worktrade' | 'renter_waiver' | 'event_waiver' | 'vehicle_rental' | email template_key
let emailTemplateList = [];
let currentEmailTemplateKey = null;
let emailHtmlSource = ''; // source-of-truth for the current email HTML
let emailHtmlPreviousSource = ''; // for undo after AI edit
let emailEditorMode = 'visual'; // 'visual' | 'source'

const SENDER_LABELS = {
  team: 'Team',
  auto: 'Automaton',
  noreply: 'No-Reply',
  payments: 'Payments',
};

const SECTION_IDS = {
  lease: 'leaseTemplateSection',
  event: 'eventTemplateSection',
  worktrade: 'worktradeTemplateSection',
  renter_waiver: 'renterWaiverTemplateSection',
  event_waiver: 'eventWaiverTemplateSection',
  vehicle_rental: 'vehicleRentalTemplateSection',
};

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'templates',
    requiredRole: 'admin',
    section: 'admin',
    onReady: async (state) => {
      await loadTemplatesPanel();
      await loadEmailNav();
      setupEventListeners();
      setupMobileSidebar();
    }
  });
});

// =============================================
// DATA LOADING
// =============================================

async function loadTemplatesPanel() {
  // Load lease placeholder reference
  const placeholders = leaseTemplateService.getAvailablePlaceholders();
  const placeholderList = document.getElementById('placeholderList');
  if (placeholderList) {
    placeholderList.innerHTML = Object.entries(placeholders)
      .map(([key, desc]) => `
        <div class="placeholder-item">
          <code>{{${key}}}</code>
          <span class="placeholder-desc">${desc}</span>
        </div>
      `).join('');
  }

  // Load active lease template
  try {
    const template = await leaseTemplateService.getActiveTemplate();
    if (template) {
      document.getElementById('templateName').value = template.name;
      document.getElementById('templateContent').value = template.content;
    } else {
      document.getElementById('templateContent').value = leaseTemplateService.getDefaultTemplate();
    }
  } catch (e) {
    console.error('Error loading lease template:', e);
  }

  await loadTemplateHistory();
  await loadSignwellConfig();

  // Load event placeholder reference
  const eventPlaceholders = eventTemplateService.getAvailablePlaceholders();
  const eventPlaceholderList = document.getElementById('eventPlaceholderList');
  if (eventPlaceholderList) {
    eventPlaceholderList.innerHTML = Object.entries(eventPlaceholders)
      .map(([key, desc]) => `
        <div class="placeholder-item">
          <code>{{${key}}}</code>
          <span class="placeholder-desc">${desc}</span>
        </div>
      `).join('');
  }

  // Load active event template
  try {
    const eventTemplate = await eventTemplateService.getActiveTemplate();
    if (eventTemplate) {
      document.getElementById('eventTemplateName').value = eventTemplate.name;
      document.getElementById('eventTemplateContent').value = eventTemplate.content;
    } else {
      document.getElementById('eventTemplateContent').value = eventTemplateService.getDefaultTemplate();
    }
  } catch (e) {
    console.error('Error loading event template:', e);
  }

  await loadEventTemplateHistory();

  // Load worktrade placeholder reference
  const worktradePlaceholders = worktradeTemplateService.getAvailablePlaceholders();
  const worktradePlaceholderList = document.getElementById('worktradePlaceholderList');
  if (worktradePlaceholderList) {
    worktradePlaceholderList.innerHTML = Object.entries(worktradePlaceholders)
      .map(([key, desc]) => `
        <div class="placeholder-item">
          <code>{{${key}}}</code>
          <span class="placeholder-desc">${desc}</span>
        </div>
      `).join('');
  }

  // Load active worktrade template
  try {
    const worktradeTemplate = await worktradeTemplateService.getActiveTemplate();
    if (worktradeTemplate) {
      document.getElementById('worktradeTemplateName').value = worktradeTemplate.name;
      document.getElementById('worktradeTemplateContent').value = worktradeTemplate.content;
    } else {
      document.getElementById('worktradeTemplateContent').value = worktradeTemplateService.getDefaultTemplate();
    }
  } catch (e) {
    console.error('Error loading worktrade template:', e);
  }

  await loadWorktradeTemplateHistory();

  // Load renter waiver placeholder reference
  const renterWaiverPlaceholders = leaseTemplateService.getAvailablePlaceholders('renter_waiver');
  const renterWaiverPlaceholderList = document.getElementById('renterWaiverPlaceholderList');
  if (renterWaiverPlaceholderList) {
    renterWaiverPlaceholderList.innerHTML = Object.entries(renterWaiverPlaceholders)
      .map(([key, desc]) => `
        <div class="placeholder-item">
          <code>{{${key}}}</code>
          <span class="placeholder-desc">${desc}</span>
        </div>
      `).join('');
  }

  // Load active renter waiver template
  try {
    const renterWaiverTemplate = await leaseTemplateService.getActiveTemplate('renter_waiver');
    if (renterWaiverTemplate) {
      document.getElementById('renterWaiverTemplateName').value = renterWaiverTemplate.name;
      document.getElementById('renterWaiverTemplateContent').value = renterWaiverTemplate.content;
    } else {
      document.getElementById('renterWaiverTemplateContent').value = leaseTemplateService.getDefaultTemplate('renter_waiver');
    }
  } catch (e) {
    console.error('Error loading renter waiver template:', e);
    document.getElementById('renterWaiverTemplateContent').value = leaseTemplateService.getDefaultTemplate('renter_waiver');
  }

  await loadRenterWaiverTemplateHistory();

  // Load event waiver placeholder reference
  const eventWaiverPlaceholders = leaseTemplateService.getAvailablePlaceholders('event_waiver');
  const eventWaiverPlaceholderList = document.getElementById('eventWaiverPlaceholderList');
  if (eventWaiverPlaceholderList) {
    eventWaiverPlaceholderList.innerHTML = Object.entries(eventWaiverPlaceholders)
      .map(([key, desc]) => `
        <div class="placeholder-item">
          <code>{{${key}}}</code>
          <span class="placeholder-desc">${desc}</span>
        </div>
      `).join('');
  }

  // Load active event waiver template
  try {
    const eventWaiverTemplate = await leaseTemplateService.getActiveTemplate('event_waiver');
    if (eventWaiverTemplate) {
      document.getElementById('eventWaiverTemplateName').value = eventWaiverTemplate.name;
      document.getElementById('eventWaiverTemplateContent').value = eventWaiverTemplate.content;
    } else {
      document.getElementById('eventWaiverTemplateContent').value = leaseTemplateService.getDefaultTemplate('event_waiver');
    }
  } catch (e) {
    console.error('Error loading event waiver template:', e);
    document.getElementById('eventWaiverTemplateContent').value = leaseTemplateService.getDefaultTemplate('event_waiver');
  }

  await loadEventWaiverTemplateHistory();

  // Load vehicle rental placeholder reference
  const vehicleRentalPlaceholders = leaseTemplateService.getAvailablePlaceholders('vehicle_rental');
  const vehicleRentalPlaceholderList = document.getElementById('vehicleRentalPlaceholderList');
  if (vehicleRentalPlaceholderList) {
    vehicleRentalPlaceholderList.innerHTML = Object.entries(vehicleRentalPlaceholders)
      .map(([key, desc]) => `
        <div class="placeholder-item">
          <code>{{${key}}}</code>
          <span class="placeholder-desc">${desc}</span>
        </div>
      `).join('');
  }

  // Load active vehicle rental template
  try {
    const vehicleRentalTemplate = await leaseTemplateService.getActiveTemplate('vehicle_rental');
    if (vehicleRentalTemplate) {
      document.getElementById('vehicleRentalTemplateName').value = vehicleRentalTemplate.name;
      document.getElementById('vehicleRentalTemplateContent').value = vehicleRentalTemplate.content;
    } else {
      document.getElementById('vehicleRentalTemplateContent').value = leaseTemplateService.getDefaultTemplate('vehicle_rental');
    }
  } catch (e) {
    console.error('Error loading vehicle rental template:', e);
    document.getElementById('vehicleRentalTemplateContent').value = leaseTemplateService.getDefaultTemplate('vehicle_rental');
  }

  await loadVehicleRentalTemplateHistory();
}

// =============================================
// EMAIL NAV — populate sidebar with grouped email templates
// =============================================

async function loadEmailNav() {
  try {
    emailTemplateList = await emailTemplateService.getAllTemplates();
    renderEmailNav(emailTemplateList);
    // Update welcome stats
    renderWelcomeStats();
  } catch (e) {
    console.error('Error loading email templates for nav:', e);
  }
}

function renderEmailNav(templates) {
  const container = document.getElementById('emailNavItems');
  const countBadge = document.getElementById('emailTemplateCount');
  if (!container) return;

  countBadge.textContent = templates.length;

  // Group by category
  const categories = emailTemplateService.getCategories();
  const catMap = Object.fromEntries(categories.map(c => [c.key, c]));
  const grouped = {};

  for (const t of templates) {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  }

  // Render category groups
  let html = '';
  for (const cat of categories) {
    const items = grouped[cat.key] || [];
    if (items.length === 0) continue;

    // Check localStorage for collapsed state
    const isCollapsed = localStorage.getItem(`tmpl_cat_${cat.key}`) === '1';

    html += `<div class="tmpl-nav-category" data-category="${cat.key}">`;
    html += `<div class="tmpl-nav-category-header" data-cat="${cat.key}">
      <span class="cat-arrow ${isCollapsed ? 'collapsed' : ''}">&#9660;</span>
      <span class="cat-dot" style="background:${cat.color}"></span>
      <span>${cat.label}</span>
      <span class="cat-count">${items.length}</span>
    </div>`;
    html += `<div class="tmpl-nav-category-items ${isCollapsed ? 'collapsed' : ''}" data-cat-items="${cat.key}" style="${isCollapsed ? 'max-height:0' : `max-height:${items.length * 40}px`}">`;

    for (const t of items) {
      const keyLabel = t.template_key.replace(/_/g, ' ');
      html += `<button class="tmpl-nav-item email-item" data-type="email" data-key="${t.template_key}" title="${t.description || keyLabel}">
        <span class="tmpl-nav-icon" style="background:${cat.color}"></span>
        <span class="tmpl-nav-text">${keyLabel}</span>
      </button>`;
    }

    html += `</div></div>`;
  }

  container.innerHTML = html;

  // Add category toggle handlers
  container.querySelectorAll('.tmpl-nav-category-header').forEach(header => {
    header.addEventListener('click', () => {
      const catKey = header.dataset.cat;
      const items = container.querySelector(`[data-cat-items="${catKey}"]`);
      const arrow = header.querySelector('.cat-arrow');
      const isNowCollapsed = !items.classList.contains('collapsed');

      if (isNowCollapsed) {
        items.classList.add('collapsed');
        arrow.classList.add('collapsed');
        localStorage.setItem(`tmpl_cat_${catKey}`, '1');
      } else {
        items.classList.remove('collapsed');
        arrow.classList.remove('collapsed');
        localStorage.removeItem(`tmpl_cat_${catKey}`);
        // Set a proper max-height for the animation
        const childCount = items.querySelectorAll('.tmpl-nav-item').length;
        items.style.maxHeight = `${childCount * 40}px`;
      }
    });
  });

  // Add click handlers on email nav items
  container.querySelectorAll('.tmpl-nav-item.email-item').forEach(btn => {
    btn.addEventListener('click', () => {
      selectTemplate('email', btn.dataset.key);
    });
  });
}

function renderWelcomeStats() {
  const statsEl = document.getElementById('tmplWelcomeStats');
  if (!statsEl) return;

  statsEl.innerHTML = `
    <div class="tmpl-welcome-stat">
      <span class="stat-num">6</span>
      <span class="stat-label">Documents</span>
    </div>
    <div class="tmpl-welcome-stat">
      <span class="stat-num">${emailTemplateList.length}</span>
      <span class="stat-label">Email Templates</span>
    </div>
  `;
}

// =============================================
// NAVIGATION — select a template
// =============================================

function selectTemplate(type, key) {
  // Hide all sections
  document.getElementById('tmplWelcome').style.display = 'none';
  document.getElementById('leaseTemplateSection').style.display = 'none';
  document.getElementById('eventTemplateSection').style.display = 'none';
  document.getElementById('worktradeTemplateSection').style.display = 'none';
  document.getElementById('renterWaiverTemplateSection').style.display = 'none';
  document.getElementById('eventWaiverTemplateSection').style.display = 'none';
  document.getElementById('vehicleRentalTemplateSection').style.display = 'none';
  document.getElementById('emailEditorView').style.display = 'none';

  // Clear all active states in sidebar
  document.querySelectorAll('.tmpl-nav-item').forEach(item => item.classList.remove('active'));

  // Set active state on clicked item
  const navItem = document.querySelector(`.tmpl-nav-item[data-key="${key}"]`);
  if (navItem) navItem.classList.add('active');

  // Show appropriate section
  if (type === 'email') {
    editEmailTemplate(key);
    activeSection = key;
  } else {
    const sectionId = SECTION_IDS[type];
    if (sectionId) {
      document.getElementById(sectionId).style.display = 'block';
      activeSection = type;
    }
  }

  // Close mobile sidebar
  closeMobileSidebar();
}

// =============================================
// SEARCH
// =============================================

function setupSearch() {
  const searchInput = document.getElementById('tmplSearch');
  if (!searchInput) return;

  searchInput.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase().trim();
    filterSidebar(query);
  });
}

function filterSidebar(query) {
  // Filter document template items
  document.querySelectorAll('.tmpl-nav-item[data-type="lease"], .tmpl-nav-item[data-type="event"], .tmpl-nav-item[data-type="worktrade"], .tmpl-nav-item[data-type="renter_waiver"], .tmpl-nav-item[data-type="event_waiver"], .tmpl-nav-item[data-type="vehicle_rental"]').forEach(item => {
    const text = item.querySelector('.tmpl-nav-text').textContent.toLowerCase();
    item.style.display = text.includes(query) || !query ? '' : 'none';
  });

  // Filter email nav items
  document.querySelectorAll('.tmpl-nav-item.email-item').forEach(item => {
    const text = item.querySelector('.tmpl-nav-text').textContent.toLowerCase();
    const title = (item.getAttribute('title') || '').toLowerCase();
    const match = text.includes(query) || title.includes(query) || !query;
    item.style.display = match ? '' : 'none';
  });

  // Show/hide category headers based on visible children
  document.querySelectorAll('.tmpl-nav-category').forEach(cat => {
    const visibleItems = cat.querySelectorAll('.tmpl-nav-item.email-item:not([style*="display: none"])');
    cat.style.display = visibleItems.length > 0 || !query ? '' : 'none';

    // Auto-expand categories with search results
    if (query && visibleItems.length > 0) {
      const items = cat.querySelector('.tmpl-nav-category-items');
      const arrow = cat.querySelector('.cat-arrow');
      if (items && items.classList.contains('collapsed')) {
        items.classList.remove('collapsed');
        arrow.classList.remove('collapsed');
        items.style.maxHeight = `${visibleItems.length * 40}px`;
      }
    }
  });

  // Show/hide the Documents group label
  const docGroup = document.querySelector('.tmpl-nav-group');
  if (docGroup) {
    const visibleDocs = docGroup.querySelectorAll('.tmpl-nav-item:not([style*="display: none"])');
    const groupLabel = docGroup.querySelector('.tmpl-nav-group-label');
    if (groupLabel) groupLabel.style.display = visibleDocs.length > 0 || !query ? '' : 'none';
  }
}

// =============================================
// MOBILE SIDEBAR
// =============================================

function setupMobileSidebar() {
  // Add mobile toggle button and backdrop
  const toggle = document.createElement('button');
  toggle.className = 'tmpl-mobile-toggle';
  toggle.id = 'tmplMobileToggle';
  toggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="17" y2="6"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="14" x2="17" y2="14"/></svg>';
  toggle.title = 'Show template list';
  document.body.appendChild(toggle);

  const backdrop = document.createElement('div');
  backdrop.className = 'tmpl-sidebar-backdrop';
  backdrop.id = 'tmplSidebarBackdrop';
  document.body.appendChild(backdrop);

  toggle.addEventListener('click', () => {
    document.getElementById('tmplSidebar').classList.add('open');
    backdrop.classList.add('open');
  });

  backdrop.addEventListener('click', closeMobileSidebar);
}

function closeMobileSidebar() {
  document.getElementById('tmplSidebar')?.classList.remove('open');
  document.getElementById('tmplSidebarBackdrop')?.classList.remove('open');
}

// =============================================
// EVENT LISTENERS
// =============================================

function setupEventListeners() {
  // Document template nav items
  document.querySelectorAll('.tmpl-nav-item[data-type="lease"], .tmpl-nav-item[data-type="event"], .tmpl-nav-item[data-type="worktrade"], .tmpl-nav-item[data-type="renter_waiver"], .tmpl-nav-item[data-type="event_waiver"], .tmpl-nav-item[data-type="vehicle_rental"]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectTemplate(btn.dataset.type, btn.dataset.key);
    });
  });

  // Lease template buttons
  document.getElementById('loadDefaultTemplateBtn')?.addEventListener('click', loadDefaultTemplate);
  document.getElementById('saveTemplateBtn')?.addEventListener('click', saveTemplate);
  document.getElementById('saveSignwellConfigBtn')?.addEventListener('click', saveSignwellConfig);

  // Event template buttons
  document.getElementById('loadDefaultEventTemplateBtn')?.addEventListener('click', loadDefaultEventTemplate);
  document.getElementById('saveEventTemplateBtn')?.addEventListener('click', saveEventTemplate);

  // Work trade template buttons
  document.getElementById('loadDefaultWorktradeTemplateBtn')?.addEventListener('click', loadDefaultWorktradeTemplate);
  document.getElementById('saveWorktradeTemplateBtn')?.addEventListener('click', saveWorktradeTemplate);

  // Renter waiver template buttons
  document.getElementById('loadDefaultRenterWaiverBtn')?.addEventListener('click', loadDefaultRenterWaiver);
  document.getElementById('saveRenterWaiverBtn')?.addEventListener('click', saveRenterWaiverTemplate);

  // Event/Guest waiver template buttons
  document.getElementById('loadDefaultEventWaiverBtn')?.addEventListener('click', loadDefaultEventWaiver);
  document.getElementById('saveEventWaiverBtn')?.addEventListener('click', saveEventWaiverTemplate);

  // Vehicle rental template buttons
  document.getElementById('loadDefaultVehicleRentalBtn')?.addEventListener('click', loadDefaultVehicleRental);
  document.getElementById('saveVehicleRentalBtn')?.addEventListener('click', saveVehicleRentalTemplate);

  // Email template buttons
  document.getElementById('emailPreviewBtn')?.addEventListener('click', emailPreviewTemplate);
  document.getElementById('emailSaveBtn')?.addEventListener('click', emailSaveTemplate);
  document.getElementById('emailPreviewCloseBtn')?.addEventListener('click', () => {
    document.getElementById('emailPreviewModal').style.display = 'none';
  });

  // Email editor mode toggle
  document.querySelectorAll('.email-editor-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleEmailEditorMode(btn.dataset.mode));
  });

  // AI edit
  document.getElementById('aiEditApply')?.addEventListener('click', aiEditTemplate);
  document.getElementById('aiEditUndo')?.addEventListener('click', aiUndoEdit);
  // Enter key on prompt
  document.getElementById('aiEditPrompt')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') aiEditTemplate();
  });

  // Search
  setupSearch();
}

// =============================================
// LEASE TEMPLATE FUNCTIONS
// =============================================

async function loadTemplateHistory() {
  try {
    const templates = await leaseTemplateService.getAllTemplates();
    const tbody = document.getElementById('templateHistoryBody');
    if (!tbody) return;

    if (templates.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted">No templates saved yet</td></tr>';
      return;
    }

    tbody.innerHTML = templates.map(t => `
      <tr>
        <td>${t.name}</td>
        <td>v${t.version}</td>
        <td>${formatDateAustin(t.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
        <td>${t.is_active ? '<span class="status-badge active">Active</span>' : ''}</td>
        <td>
          <button class="btn-small" data-action="load-template" data-id="${t.id}">Load</button>
          ${!t.is_active ? `<button class="btn-small" data-action="set-active-template" data-id="${t.id}">Set Active</button>` : ''}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-action="load-template"]').forEach(btn => {
      btn.addEventListener('click', () => loadTemplate(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="set-active-template"]').forEach(btn => {
      btn.addEventListener('click', () => setActiveTemplate(btn.dataset.id));
    });
  } catch (e) {
    console.error('Error loading template history:', e);
  }
}

async function loadTemplate(templateId) {
  try {
    const { data, error } = await supabase
      .from('lease_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (error) throw error;

    document.getElementById('templateName').value = data.name;
    document.getElementById('templateContent').value = data.content;
    showToast('Template loaded', 'success');
  } catch (e) {
    showToast('Error loading template: ' + e.message, 'error');
  }
}

async function setActiveTemplate(templateId) {
  try {
    await leaseTemplateService.setActiveTemplate(templateId);
    await loadTemplateHistory();
    showToast('Template set as active', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function saveTemplate() {
  const name = document.getElementById('templateName').value.trim();
  const content = document.getElementById('templateContent').value;
  const makeActive = document.getElementById('templateMakeActive').checked;

  if (!name) {
    showToast('Please enter a template name', 'warning');
    return;
  }

  if (!content.trim()) {
    showToast('Template content cannot be empty', 'warning');
    return;
  }

  const validation = leaseTemplateService.validateTemplate(content);
  const validationDiv = document.getElementById('templateValidation');

  if (!validation.isValid) {
    validationDiv.innerHTML = `
      <div class="validation-error">
        <strong>Validation Errors:</strong>
        <ul>${validation.errors.map(e => `<li>${e}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
    return;
  }

  if (validation.warnings.length > 0) {
    validationDiv.innerHTML = `
      <div class="validation-warning">
        <strong>Warnings:</strong>
        <ul>${validation.warnings.map(w => `<li>${w}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
  } else {
    validationDiv.style.display = 'none';
  }

  try {
    await leaseTemplateService.saveTemplate(content, name, makeActive);
    await loadTemplateHistory();
    showToast('Template saved successfully!', 'success');
  } catch (e) {
    showToast('Error saving template: ' + e.message, 'error');
  }
}

function loadDefaultTemplate() {
  document.getElementById('templateContent').value = leaseTemplateService.getDefaultTemplate();
  document.getElementById('templateName').value = 'Standard Lease Agreement';
  showToast('Default template loaded', 'info');
}

// =============================================
// EVENT TEMPLATE FUNCTIONS
// =============================================

async function loadEventTemplateHistory() {
  try {
    const templates = await eventTemplateService.getAllTemplates();
    const tbody = document.getElementById('eventTemplateHistoryBody');
    if (!tbody) return;

    if (templates.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted">No templates saved yet</td></tr>';
      return;
    }

    tbody.innerHTML = templates.map(t => `
      <tr>
        <td>${t.name}</td>
        <td>v${t.version}</td>
        <td>${formatDateAustin(t.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
        <td>${t.is_active ? '<span class="status-badge active">Active</span>' : ''}</td>
        <td>
          <button class="btn-small" data-action="load-event-template" data-id="${t.id}">Load</button>
          ${!t.is_active ? `<button class="btn-small" data-action="set-active-event-template" data-id="${t.id}">Set Active</button>` : ''}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-action="load-event-template"]').forEach(btn => {
      btn.addEventListener('click', () => loadEventTemplate(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="set-active-event-template"]').forEach(btn => {
      btn.addEventListener('click', () => setActiveEventTemplate(btn.dataset.id));
    });
  } catch (e) {
    console.error('Error loading event template history:', e);
  }
}

async function loadEventTemplate(templateId) {
  try {
    const { data, error } = await supabase
      .from('event_agreement_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (error) throw error;

    document.getElementById('eventTemplateName').value = data.name;
    document.getElementById('eventTemplateContent').value = data.content;
    showToast('Event template loaded', 'success');
  } catch (e) {
    showToast('Error loading event template: ' + e.message, 'error');
  }
}

async function setActiveEventTemplate(templateId) {
  try {
    await eventTemplateService.setActiveTemplate(templateId);
    await loadEventTemplateHistory();
    showToast('Event template set as active', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function saveEventTemplate() {
  const name = document.getElementById('eventTemplateName').value.trim();
  const content = document.getElementById('eventTemplateContent').value;
  const makeActive = document.getElementById('eventTemplateMakeActive').checked;

  if (!name) {
    showToast('Please enter a template name', 'warning');
    return;
  }

  if (!content.trim()) {
    showToast('Template content cannot be empty', 'warning');
    return;
  }

  const validation = eventTemplateService.validateTemplate(content);
  const validationDiv = document.getElementById('eventTemplateValidation');

  if (!validation.isValid) {
    validationDiv.innerHTML = `
      <div class="validation-error">
        <strong>Validation Errors:</strong>
        <ul>${validation.errors.map(e => `<li>${e}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
    return;
  }

  if (validation.warnings.length > 0) {
    validationDiv.innerHTML = `
      <div class="validation-warning">
        <strong>Warnings:</strong>
        <ul>${validation.warnings.map(w => `<li>${w}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
  } else {
    validationDiv.style.display = 'none';
  }

  try {
    await eventTemplateService.saveTemplate(content, name, makeActive);
    await loadEventTemplateHistory();
    showToast('Event template saved successfully!', 'success');
  } catch (e) {
    showToast('Error saving event template: ' + e.message, 'error');
  }
}

function loadDefaultEventTemplate() {
  document.getElementById('eventTemplateContent').value = eventTemplateService.getDefaultTemplate();
  document.getElementById('eventTemplateName').value = 'Standard Event Agreement';
  showToast('Default event template loaded', 'info');
}

// =============================================
// WORKTRADE TEMPLATE FUNCTIONS
// =============================================

async function loadWorktradeTemplateHistory() {
  try {
    const templates = await worktradeTemplateService.getAllTemplates();
    const tbody = document.getElementById('worktradeTemplateHistoryBody');
    if (!tbody) return;

    if (templates.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted">No templates saved yet</td></tr>';
      return;
    }

    tbody.innerHTML = templates.map(t => `
      <tr>
        <td>${t.name}</td>
        <td>v${t.version}</td>
        <td>${formatDateAustin(t.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
        <td>${t.is_active ? '<span class="status-badge active">Active</span>' : ''}</td>
        <td>
          <button class="btn-small" data-action="load-worktrade-template" data-id="${t.id}">Load</button>
          ${!t.is_active ? `<button class="btn-small" data-action="set-active-worktrade-template" data-id="${t.id}">Set Active</button>` : ''}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-action="load-worktrade-template"]').forEach(btn => {
      btn.addEventListener('click', () => loadWorktradeTemplate(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="set-active-worktrade-template"]').forEach(btn => {
      btn.addEventListener('click', () => setActiveWorktradeTemplate(btn.dataset.id));
    });
  } catch (e) {
    console.error('Error loading worktrade template history:', e);
  }
}

async function loadWorktradeTemplate(templateId) {
  try {
    const { data, error } = await supabase
      .from('worktrade_agreement_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (error) throw error;

    document.getElementById('worktradeTemplateName').value = data.name;
    document.getElementById('worktradeTemplateContent').value = data.content;
    showToast('Work trade template loaded', 'success');
  } catch (e) {
    showToast('Error loading work trade template: ' + e.message, 'error');
  }
}

async function setActiveWorktradeTemplate(templateId) {
  try {
    await worktradeTemplateService.setActiveTemplate(templateId);
    await loadWorktradeTemplateHistory();
    showToast('Work trade template set as active', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function saveWorktradeTemplate() {
  const name = document.getElementById('worktradeTemplateName').value.trim();
  const content = document.getElementById('worktradeTemplateContent').value;
  const makeActive = document.getElementById('worktradeMakeActive').checked;

  if (!name) {
    showToast('Please enter a template name', 'warning');
    return;
  }

  if (!content.trim()) {
    showToast('Template content cannot be empty', 'warning');
    return;
  }

  const validation = worktradeTemplateService.validateTemplate(content);
  const validationDiv = document.getElementById('worktradeTemplateValidation');

  if (!validation.isValid) {
    validationDiv.innerHTML = `
      <div class="validation-error">
        <strong>Validation Errors:</strong>
        <ul>${validation.errors.map(e => `<li>${e}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
    return;
  }

  if (validation.warnings.length > 0) {
    validationDiv.innerHTML = `
      <div class="validation-warning">
        <strong>Warnings:</strong>
        <ul>${validation.warnings.map(w => `<li>${w}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
  } else {
    validationDiv.style.display = 'none';
  }

  try {
    await worktradeTemplateService.saveTemplate(content, name, makeActive);
    await loadWorktradeTemplateHistory();
    showToast('Work trade template saved successfully!', 'success');
  } catch (e) {
    showToast('Error saving work trade template: ' + e.message, 'error');
  }
}

function loadDefaultWorktradeTemplate() {
  document.getElementById('worktradeTemplateContent').value = worktradeTemplateService.getDefaultTemplate();
  document.getElementById('worktradeTemplateName').value = 'Standard Work Trade Agreement';
  showToast('Default work trade template loaded', 'info');
}

// =============================================
// RENTER WAIVER TEMPLATE FUNCTIONS
// =============================================

async function loadRenterWaiverTemplateHistory() {
  try {
    const templates = await leaseTemplateService.getAllTemplates('renter_waiver');
    const tbody = document.getElementById('renterWaiverTemplateHistoryBody');
    if (!tbody) return;

    if (templates.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted">No templates saved yet</td></tr>';
      return;
    }

    tbody.innerHTML = templates.map(t => `
      <tr>
        <td>${t.name}</td>
        <td>v${t.version}</td>
        <td>${formatDateAustin(t.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
        <td>${t.is_active ? '<span class="status-badge active">Active</span>' : ''}</td>
        <td>
          <button class="btn-small" data-action="load-renter-waiver-template" data-id="${t.id}">Load</button>
          ${!t.is_active ? `<button class="btn-small" data-action="set-active-renter-waiver-template" data-id="${t.id}">Set Active</button>` : ''}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-action="load-renter-waiver-template"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { data } = await supabase.from('lease_templates').select('*').eq('id', btn.dataset.id).single();
        if (data) {
          document.getElementById('renterWaiverTemplateName').value = data.name;
          document.getElementById('renterWaiverTemplateContent').value = data.content;
          showToast('Renter waiver template loaded', 'success');
        }
      });
    });
    tbody.querySelectorAll('[data-action="set-active-renter-waiver-template"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await leaseTemplateService.setActiveTemplate(btn.dataset.id);
          await loadRenterWaiverTemplateHistory();
          showToast('Renter waiver template set as active', 'success');
        } catch (e) {
          showToast('Error: ' + e.message, 'error');
        }
      });
    });
  } catch (e) {
    console.error('Error loading renter waiver template history:', e);
  }
}

async function saveRenterWaiverTemplate() {
  const name = document.getElementById('renterWaiverTemplateName').value.trim();
  const content = document.getElementById('renterWaiverTemplateContent').value;
  const makeActive = document.getElementById('renterWaiverMakeActive').checked;

  if (!name) {
    showToast('Please enter a template name', 'warning');
    return;
  }

  if (!content.trim()) {
    showToast('Template content cannot be empty', 'warning');
    return;
  }

  const validation = leaseTemplateService.validateTemplate(content, 'renter_waiver');
  const validationDiv = document.getElementById('renterWaiverTemplateValidation');

  if (!validation.isValid) {
    validationDiv.innerHTML = `
      <div class="validation-error">
        <strong>Validation Errors:</strong>
        <ul>${validation.errors.map(e => `<li>${e}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
    return;
  }

  if (validation.warnings.length > 0) {
    validationDiv.innerHTML = `
      <div class="validation-warning">
        <strong>Warnings:</strong>
        <ul>${validation.warnings.map(w => `<li>${w}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
  } else {
    validationDiv.style.display = 'none';
  }

  try {
    await leaseTemplateService.saveTemplate(content, name, makeActive, 'renter_waiver');
    await loadRenterWaiverTemplateHistory();
    showToast('Renter waiver template saved!', 'success');
  } catch (e) {
    showToast('Error saving template: ' + e.message, 'error');
  }
}

function loadDefaultRenterWaiver() {
  document.getElementById('renterWaiverTemplateContent').value = leaseTemplateService.getDefaultTemplate('renter_waiver');
  document.getElementById('renterWaiverTemplateName').value = 'Renter Liability Waiver';
  showToast('Default renter waiver loaded', 'info');
}

// =============================================
// EVENT/GUEST WAIVER TEMPLATE FUNCTIONS
// =============================================

async function loadEventWaiverTemplateHistory() {
  try {
    const templates = await leaseTemplateService.getAllTemplates('event_waiver');
    const tbody = document.getElementById('eventWaiverTemplateHistoryBody');
    if (!tbody) return;

    if (templates.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted">No templates saved yet</td></tr>';
      return;
    }

    tbody.innerHTML = templates.map(t => `
      <tr>
        <td>${t.name}</td>
        <td>v${t.version}</td>
        <td>${formatDateAustin(t.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
        <td>${t.is_active ? '<span class="status-badge active">Active</span>' : ''}</td>
        <td>
          <button class="btn-small" data-action="load-event-waiver-template" data-id="${t.id}">Load</button>
          ${!t.is_active ? `<button class="btn-small" data-action="set-active-event-waiver-template" data-id="${t.id}">Set Active</button>` : ''}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-action="load-event-waiver-template"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { data } = await supabase.from('lease_templates').select('*').eq('id', btn.dataset.id).single();
        if (data) {
          document.getElementById('eventWaiverTemplateName').value = data.name;
          document.getElementById('eventWaiverTemplateContent').value = data.content;
          showToast('Event waiver template loaded', 'success');
        }
      });
    });
    tbody.querySelectorAll('[data-action="set-active-event-waiver-template"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await leaseTemplateService.setActiveTemplate(btn.dataset.id);
          await loadEventWaiverTemplateHistory();
          showToast('Event waiver template set as active', 'success');
        } catch (e) {
          showToast('Error: ' + e.message, 'error');
        }
      });
    });
  } catch (e) {
    console.error('Error loading event waiver template history:', e);
  }
}

async function saveEventWaiverTemplate() {
  const name = document.getElementById('eventWaiverTemplateName').value.trim();
  const content = document.getElementById('eventWaiverTemplateContent').value;
  const makeActive = document.getElementById('eventWaiverMakeActive').checked;

  if (!name) {
    showToast('Please enter a template name', 'warning');
    return;
  }

  if (!content.trim()) {
    showToast('Template content cannot be empty', 'warning');
    return;
  }

  const validation = leaseTemplateService.validateTemplate(content, 'event_waiver');
  const validationDiv = document.getElementById('eventWaiverTemplateValidation');

  if (!validation.isValid) {
    validationDiv.innerHTML = `
      <div class="validation-error">
        <strong>Validation Errors:</strong>
        <ul>${validation.errors.map(e => `<li>${e}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
    return;
  }

  if (validation.warnings.length > 0) {
    validationDiv.innerHTML = `
      <div class="validation-warning">
        <strong>Warnings:</strong>
        <ul>${validation.warnings.map(w => `<li>${w}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
  } else {
    validationDiv.style.display = 'none';
  }

  try {
    await leaseTemplateService.saveTemplate(content, name, makeActive, 'event_waiver');
    await loadEventWaiverTemplateHistory();
    showToast('Event waiver template saved!', 'success');
  } catch (e) {
    showToast('Error saving template: ' + e.message, 'error');
  }
}

function loadDefaultEventWaiver() {
  document.getElementById('eventWaiverTemplateContent').value = leaseTemplateService.getDefaultTemplate('event_waiver');
  document.getElementById('eventWaiverTemplateName').value = 'Event/Guest Liability Waiver';
  showToast('Default event/guest waiver loaded', 'info');
}

// =============================================
// VEHICLE RENTAL TEMPLATE FUNCTIONS
// =============================================

async function loadVehicleRentalTemplateHistory() {
  try {
    const templates = await leaseTemplateService.getAllTemplates('vehicle_rental');
    const tbody = document.getElementById('vehicleRentalTemplateHistoryBody');
    if (!tbody) return;

    if (templates.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted">No templates saved yet</td></tr>';
      return;
    }

    tbody.innerHTML = templates.map(t => `
      <tr>
        <td>${t.name}</td>
        <td>v${t.version}</td>
        <td>${formatDateAustin(t.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
        <td>${t.is_active ? '<span class="status-badge active">Active</span>' : ''}</td>
        <td>
          <button class="btn-small" data-action="load-vehicle-rental-template" data-id="${t.id}">Load</button>
          ${!t.is_active ? `<button class="btn-small" data-action="set-active-vehicle-rental-template" data-id="${t.id}">Set Active</button>` : ''}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-action="load-vehicle-rental-template"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { data } = await supabase.from('lease_templates').select('*').eq('id', btn.dataset.id).single();
        if (data) {
          document.getElementById('vehicleRentalTemplateName').value = data.name;
          document.getElementById('vehicleRentalTemplateContent').value = data.content;
          showToast('Vehicle rental template loaded', 'success');
        }
      });
    });
    tbody.querySelectorAll('[data-action="set-active-vehicle-rental-template"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await leaseTemplateService.setActiveTemplate(btn.dataset.id);
          await loadVehicleRentalTemplateHistory();
          showToast('Vehicle rental template set as active', 'success');
        } catch (e) {
          showToast('Error: ' + e.message, 'error');
        }
      });
    });
  } catch (e) {
    console.error('Error loading vehicle rental template history:', e);
  }
}

async function saveVehicleRentalTemplate() {
  const name = document.getElementById('vehicleRentalTemplateName').value.trim();
  const content = document.getElementById('vehicleRentalTemplateContent').value;
  const makeActive = document.getElementById('vehicleRentalMakeActive').checked;

  if (!name) {
    showToast('Please enter a template name', 'warning');
    return;
  }

  if (!content.trim()) {
    showToast('Template content cannot be empty', 'warning');
    return;
  }

  const validation = leaseTemplateService.validateTemplate(content, 'vehicle_rental');
  const validationDiv = document.getElementById('vehicleRentalTemplateValidation');

  if (!validation.isValid) {
    validationDiv.innerHTML = `
      <div class="validation-error">
        <strong>Validation Errors:</strong>
        <ul>${validation.errors.map(e => `<li>${e}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
    return;
  }

  if (validation.warnings.length > 0) {
    validationDiv.innerHTML = `
      <div class="validation-warning">
        <strong>Warnings:</strong>
        <ul>${validation.warnings.map(w => `<li>${w}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
  } else {
    validationDiv.style.display = 'none';
  }

  try {
    await leaseTemplateService.saveTemplate(content, name, makeActive, 'vehicle_rental');
    await loadVehicleRentalTemplateHistory();
    showToast('Vehicle rental template saved!', 'success');
  } catch (e) {
    showToast('Error saving template: ' + e.message, 'error');
  }
}

function loadDefaultVehicleRental() {
  document.getElementById('vehicleRentalTemplateContent').value = leaseTemplateService.getDefaultTemplate('vehicle_rental');
  document.getElementById('vehicleRentalTemplateName').value = 'Vehicle Rental Agreement';
  showToast('Default vehicle rental template loaded', 'info');
}

// =============================================
// SIGNWELL CONFIG
// =============================================

async function loadSignwellConfig() {
  try {
    const { data, error } = await supabase
      .from('signwell_config')
      .select('*')
      .single();

    if (data) {
      document.getElementById('signwellApiKey').value = data.api_key || '';
      document.getElementById('signwellTestMode').checked = data.test_mode !== false;
    }
  } catch (e) {
    console.error('Error loading SignWell config:', e);
  }
}

async function saveSignwellConfig() {
  const apiKey = document.getElementById('signwellApiKey').value.trim();
  const testMode = document.getElementById('signwellTestMode').checked;

  try {
    const { error } = await supabase
      .from('signwell_config')
      .upsert({
        id: 1,
        api_key: apiKey || null,
        test_mode: testMode,
        updated_at: new Date().toISOString(),
      });

    if (error) throw error;
    showToast('SignWell configuration saved', 'success');
  } catch (e) {
    showToast('Error saving config: ' + e.message, 'error');
  }
}

// =============================================
// EMAIL TEMPLATE FUNCTIONS
// =============================================

async function editEmailTemplate(templateKey) {
  try {
    const template = await emailTemplateService.getActiveTemplate(templateKey);
    if (!template) {
      showToast('Template not found', 'error');
      return;
    }

    currentEmailTemplateKey = templateKey;

    // Populate editor
    const keyLabel = templateKey.replace(/_/g, ' ');
    document.getElementById('emailEditorTitle').textContent = `Edit: ${keyLabel}`;
    document.getElementById('emailDescription').value = template.description || '';
    document.getElementById('emailSubject').value = template.subject_template || '';

    // Store HTML source-of-truth
    emailHtmlSource = template.html_template || '';
    emailHtmlPreviousSource = '';

    // Reset to visual mode
    toggleEmailEditorMode('visual');

    // Render visual preview
    renderEmailVisual();

    // Hide undo button
    document.getElementById('aiEditUndo').style.display = 'none';
    document.getElementById('aiEditStatus').textContent = '';
    document.getElementById('aiEditPrompt').value = '';

    // Populate placeholder reference
    const placeholderList = document.getElementById('emailPlaceholderList');
    const placeholders = template.placeholders || [];
    if (placeholders.length > 0) {
      placeholderList.innerHTML = placeholders.map(p => `
        <div class="placeholder-item">
          <code>{{${p.key}}}</code>
          <span class="placeholder-desc">${p.description || ''}${p.required ? '' : ' <em>(optional)</em>'}</span>
        </div>
      `).join('');
    } else {
      placeholderList.innerHTML = '<p class="text-muted">No placeholders defined</p>';
    }

    // Load version history
    await loadEmailVersionHistory(templateKey);

    // Show editor
    document.getElementById('emailEditorView').style.display = 'block';
    document.getElementById('emailTemplateValidation').style.display = 'none';
  } catch (e) {
    console.error('Error loading email template:', e);
    showToast('Error loading template', 'error');
  }
}

// ---- Visual / Source mode toggle ----

function toggleEmailEditorMode(mode) {
  emailEditorMode = mode;

  // Update toggle buttons
  document.querySelectorAll('.email-editor-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const visualContainer = document.getElementById('emailVisualContainer');
  const sourceContainer = document.getElementById('emailSourceContainer');

  if (mode === 'visual') {
    // If switching from source, read textarea back into state
    const sourceEditor = document.getElementById('emailSourceEditor');
    if (sourceContainer.style.display !== 'none' && sourceEditor) {
      emailHtmlSource = sourceEditor.value;
    }
    visualContainer.style.display = 'block';
    sourceContainer.style.display = 'none';
    renderEmailVisual();
  } else {
    // Populate source textarea
    document.getElementById('emailSourceEditor').value = emailHtmlSource;
    visualContainer.style.display = 'none';
    sourceContainer.style.display = 'block';
  }
}

function getEmailSampleData() {
  const current = emailTemplateList.find(t => t.template_key === currentEmailTemplateKey);
  const placeholders = current?.placeholders || [];
  const sampleData = {};
  for (const p of placeholders) {
    sampleData[p.key] = p.sample_value || `[${p.key}]`;
  }
  return sampleData;
}

function renderEmailVisual() {
  const iframe = document.getElementById('emailVisualPreview');
  if (!iframe) return;

  const sampleData = getEmailSampleData();
  const rendered = renderTemplate(emailHtmlSource, sampleData);
  iframe.srcdoc = rendered;
}

// Sync source before save (in case user is in source mode)
function syncHtmlFromEditor() {
  if (emailEditorMode === 'source') {
    emailHtmlSource = document.getElementById('emailSourceEditor').value;
  }
}

// ---- AI Edit ----

async function aiEditTemplate() {
  const promptEl = document.getElementById('aiEditPrompt');
  const statusEl = document.getElementById('aiEditStatus');
  const prompt = promptEl.value.trim();

  if (!prompt) {
    showToast('Enter an edit instruction', 'warning');
    return;
  }

  syncHtmlFromEditor();

  if (!emailHtmlSource.trim()) {
    showToast('No HTML to edit', 'warning');
    return;
  }

  // Show loading
  statusEl.innerHTML = '<span class="ai-edit-loading">Applying AI edit...</span>';
  document.getElementById('aiEditApply').disabled = true;

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const resp = await fetch(
      `YOUR_SUPABASE_URL/functions/v1/edit-email-template`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ html: emailHtmlSource, prompt }),
      }
    );

    const result = await resp.json();

    if (!resp.ok) {
      throw new Error(result.error || `API error: ${resp.status}`);
    }

    if (!result.html) {
      throw new Error('Empty response from AI');
    }

    // Save previous for undo
    emailHtmlPreviousSource = emailHtmlSource;
    emailHtmlSource = result.html;

    // Update visual or source view
    if (emailEditorMode === 'visual') {
      renderEmailVisual();
    } else {
      document.getElementById('emailSourceEditor').value = emailHtmlSource;
    }

    promptEl.value = '';
    statusEl.innerHTML = '<span style="color:var(--success);">Edit applied.</span>';
    document.getElementById('aiEditUndo').style.display = '';

  } catch (e) {
    console.error('AI edit error:', e);
    statusEl.innerHTML = `<span style="color:var(--occupied);">Error: ${e.message}</span>`;
  } finally {
    document.getElementById('aiEditApply').disabled = false;
  }
}

function aiUndoEdit() {
  if (!emailHtmlPreviousSource) return;

  emailHtmlSource = emailHtmlPreviousSource;
  emailHtmlPreviousSource = '';

  if (emailEditorMode === 'visual') {
    renderEmailVisual();
  } else {
    document.getElementById('emailSourceEditor').value = emailHtmlSource;
  }

  document.getElementById('aiEditUndo').style.display = 'none';
  document.getElementById('aiEditStatus').innerHTML = '<span style="color:var(--text-muted);">AI edit undone.</span>';
  showToast('AI edit undone', 'info');
}

// ---- Version History ----

async function loadEmailVersionHistory(templateKey) {
  try {
    const versions = await emailTemplateService.getTemplateVersions(templateKey);
    const tbody = document.getElementById('emailVersionHistoryBody');
    if (!tbody) return;

    if (versions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-muted">No versions yet</td></tr>';
      return;
    }

    tbody.innerHTML = versions.map(v => `
      <tr>
        <td>v${v.version}</td>
        <td>${formatDateAustin(v.updated_at || v.created_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
        <td>${v.is_active ? '<span class="status-badge active">Active</span>' : ''}</td>
        <td>
          <button class="btn-small" data-action="load-email-version" data-id="${v.id}">Load</button>
          ${!v.is_active ? `<button class="btn-small" data-action="set-active-email-version" data-id="${v.id}" data-key="${v.template_key}">Set Active</button>` : ''}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-action="load-email-version"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { data } = await supabase.from('email_templates').select('*').eq('id', btn.dataset.id).single();
        if (data) {
          document.getElementById('emailSubject').value = data.subject_template || '';
          document.getElementById('emailDescription').value = data.description || '';
          emailHtmlSource = data.html_template || '';
          if (emailEditorMode === 'visual') {
            renderEmailVisual();
          } else {
            document.getElementById('emailSourceEditor').value = emailHtmlSource;
          }
          showToast('Version loaded', 'success');
        }
      });
    });

    tbody.querySelectorAll('[data-action="set-active-email-version"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await emailTemplateService.setActiveVersion(btn.dataset.id, btn.dataset.key);
          await loadEmailVersionHistory(btn.dataset.key);
          showToast('Version set as active', 'success');
        } catch (e) {
          showToast('Error: ' + e.message, 'error');
        }
      });
    });
  } catch (e) {
    console.error('Error loading email version history:', e);
  }
}

// ---- Save ----

async function emailSaveTemplate() {
  if (!currentEmailTemplateKey) return;

  syncHtmlFromEditor();

  const subject = document.getElementById('emailSubject').value.trim();
  const html = emailHtmlSource;
  const description = document.getElementById('emailDescription').value.trim();

  if (!subject) {
    showToast('Subject line cannot be empty', 'warning');
    return;
  }
  if (!html.trim()) {
    showToast('HTML body cannot be empty', 'warning');
    return;
  }

  // Get current template for category/sender/placeholders
  const current = await emailTemplateService.getActiveTemplate(currentEmailTemplateKey);
  if (!current) {
    showToast('Could not find current template', 'error');
    return;
  }

  // Validate
  const allContent = subject + ' ' + html;
  const validation = emailTemplateService.validateTemplate(allContent, current.placeholders);
  const validationDiv = document.getElementById('emailTemplateValidation');

  if (validation.warnings.length > 0) {
    validationDiv.innerHTML = `
      <div class="validation-warning">
        <strong>Warnings:</strong>
        <ul>${validation.warnings.map(w => `<li>${w}</li>`).join('')}</ul>
      </div>
    `;
    validationDiv.style.display = 'block';
  } else {
    validationDiv.style.display = 'none';
  }

  try {
    await emailTemplateService.saveTemplate(currentEmailTemplateKey, {
      category: current.category,
      description: description || current.description,
      sender_type: current.sender_type,
      subject_template: subject,
      html_template: html,
      text_template: '', // plain text no longer used
      placeholders: current.placeholders,
    }, true);

    await loadEmailVersionHistory(currentEmailTemplateKey);
    showToast('Email template saved!', 'success');
  } catch (e) {
    showToast('Error saving: ' + e.message, 'error');
  }
}

// ---- Preview modal ----

function emailPreviewTemplate() {
  syncHtmlFromEditor();

  const subject = document.getElementById('emailSubject').value;
  const sampleData = getEmailSampleData();

  const renderedSubject = renderTemplate(subject, sampleData);
  const renderedHtml = renderTemplate(emailHtmlSource, sampleData);

  document.getElementById('emailPreviewSubject').textContent = renderedSubject;
  const iframe = document.getElementById('emailPreviewFrame');
  iframe.srcdoc = renderedHtml;

  document.getElementById('emailPreviewModal').style.display = 'flex';
}
