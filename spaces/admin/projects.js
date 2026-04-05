/**
 * Admin Projects Page - Create, edit, delete, and reassign tasks
 */
import { initAdminPage, showToast } from '../../shared/admin-shell.js';
import { supabase } from '../../shared/supabase.js';
import { projectService } from '../../shared/project-service.js';
import { mediaService } from '../../shared/media-service.js';

let allTasks = [];
let spaces = [];
let assigneeNames = [];
let selectedIds = new Set();
let initialized = false;
let debounceTimer = null;
let currentView = 'tasks';
let allInquiries = [];

// ---- Init ----
initAdminPage({
  activeTab: 'projects',
  section: 'staff',
  onReady: async () => {
    if (initialized) return;
    initialized = true;
    await Promise.all([loadSpaces(), loadAssignees()]);
    bindEvents();
    await loadTasks();
  }
});

// ---- Load reference data ----
async function loadSpaces() {
  const { data } = await supabase
    .from('spaces')
    .select('id, name')
    .eq('is_archived', false)
    .eq('is_micro', false)
    .order('name');
  spaces = data || [];

  // Populate modal dropdown
  const sel = document.getElementById('inputSpace');
  spaces.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
}

async function loadAssignees() {
  assigneeNames = await projectService.getAssigneeNames();

  // Load app_users for all dropdowns
  const { data: users } = await supabase
    .from('app_users')
    .select('id, display_name, role')
    .in('role', ['associate', 'staff', 'admin', 'oracle'])
    .order('display_name');

  // Populate filter + bulk dropdowns with user IDs (matches assigned_to, not assigned_name)
  [document.getElementById('filterAssignee'), document.getElementById('bulkAssignee')].forEach(sel => {
    if (users && users.length) {
      users.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.display_name;
        sel.appendChild(opt);
      });
    }
  });

  const modalSel = document.getElementById('inputAssignee');
  // Add a "name only" group (for tasks not linked to a user account)
  const optGroupName = document.createElement('optgroup');
  optGroupName.label = 'Name Only';
  assigneeNames.forEach(name => {
    const opt = document.createElement('option');
    opt.value = `name:${name}`;
    opt.textContent = name;
    optGroupName.appendChild(opt);
  });
  modalSel.appendChild(optGroupName);

  // Add linked users group
  if (users && users.length) {
    const optGroupUsers = document.createElement('optgroup');
    optGroupUsers.label = 'System Users';
    users.forEach(u => {
      const opt = document.createElement('option');
      opt.value = `user:${u.id}:${u.display_name}`;
      opt.textContent = `${u.display_name} (${u.role})`;
      optGroupUsers.appendChild(opt);
    });
    modalSel.appendChild(optGroupUsers);
  }
}

// ---- Load Tasks ----
async function loadTasks() {
  const filters = getFilters();
  allTasks = await projectService.getAllTasks(filters);

  // Default: show open + in_progress only
  const statusVal = document.getElementById('filterStatus').value;
  let display = allTasks;
  if (!statusVal) {
    display = allTasks.filter(t => t.status !== 'done');
  }

  renderTable(display);
  updateStats();
  updateBulkBar();
}

function getFilters() {
  const f = {};
  const status = document.getElementById('filterStatus').value;
  f.status = status || 'all';

  const priority = document.getElementById('filterPriority').value;
  if (priority) f.priority = parseInt(priority);

  const assignee = document.getElementById('filterAssignee').value;
  if (assignee) f.assignedTo = assignee;

  const search = document.getElementById('searchInput').value.trim();
  if (search) f.search = search;

  return f;
}

// ---- Render ----
function renderTable(tasks) {
  const tbody = document.getElementById('taskTableBody');

  if (!tasks.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No tasks match your filters.</td></tr>';
    return;
  }

  tbody.innerHTML = tasks.map((t, idx) => {
    const pClass = t.priority ? `p${t.priority}` : '';
    const pLabel = t.priority ? `P${t.priority}` : '';
    const location = t.space?.name || t.location_label || '';
    const checked = selectedIds.has(t.id) ? 'checked' : '';
    const canonId = t.canonical_id || '';

    const rowClass = t.status === 'done' ? 'done' : (t.status === 'on_hold' ? 'on-hold' : '');
    return `<tr class="${rowClass}">
      <td><input type="checkbox" class="row-check" data-id="${t.id}" ${checked}></td>
      <td class="row-num-cell">${idx + 1}</td>
      <td>${pLabel ? `<span class="priority-badge ${pClass}">${pLabel}</span>` : ''}</td>
      <td class="title-cell">
        <div class="title-text">${canonId ? `<span style="color:var(--text-muted);font-weight:400">${esc(canonId)}</span> ` : ''}${esc(t.title)}</div>
        ${t.notes ? `<div class="notes-text">${esc(t.notes)}</div>` : ''}
        ${t.description ? `<div class="notes-text" style="font-style:italic">${esc(t.description.length > 80 ? t.description.substring(0, 80) + '...' : t.description)}</div>` : ''}
      </td>
      <td>${t.assigned_name ? `<span class="assignee-badge">${esc(t.assigned_name)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${esc(location)}</td>
      <td><span class="status-badge ${t.status}">${statusLabel(t.status)}</span></td>
      <td class="hide-mobile">
        <div class="row-actions">
          <button data-edit="${t.id}" title="Edit">Edit</button>
          <button class="btn-del" data-delete="${t.id}" title="Delete">&times;</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function statusLabel(s) {
  return { open: 'Open', in_progress: 'In Progress', on_hold: 'On Hold', done: 'Done' }[s] || s;
}

async function updateStats() {
  const stats = await projectService.getTaskStats();
  document.getElementById('statTotal').textContent = stats.total;
  document.getElementById('statOpen').textContent = stats.open;
  document.getElementById('statInProgress').textContent = stats.in_progress;
  document.getElementById('statOnHold').textContent = stats.on_hold;
  document.getElementById('statDone').textContent = stats.done;
}

function updateBulkBar() {
  const bar = document.getElementById('bulkBar');
  bar.classList.toggle('visible', selectedIds.size > 0);
  document.getElementById('bulkCount').textContent = selectedIds.size;
}

// ---- Events ----
function bindEvents() {
  // Filters
  ['filterAssignee', 'filterStatus', 'filterPriority'].forEach(id => {
    document.getElementById(id).addEventListener('change', loadTasks);
  });

  // Search debounce
  document.getElementById('searchInput').addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadTasks, 300);
  });

  // Select all
  document.getElementById('selectAll').addEventListener('change', (e) => {
    const checks = document.querySelectorAll('.row-check');
    checks.forEach(c => {
      c.checked = e.target.checked;
      if (e.target.checked) selectedIds.add(c.dataset.id);
      else selectedIds.delete(c.dataset.id);
    });
    updateBulkBar();
  });

  // Individual checkboxes (delegated)
  document.getElementById('taskTableBody').addEventListener('change', (e) => {
    if (!e.target.classList.contains('row-check')) return;
    if (e.target.checked) selectedIds.add(e.target.dataset.id);
    else selectedIds.delete(e.target.dataset.id);
    updateBulkBar();
  });

  // Row actions (delegated)
  document.getElementById('taskTableBody').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      const task = allTasks.find(t => t.id === editBtn.dataset.edit);
      if (task) openEditModal(task);
      return;
    }
    const delBtn = e.target.closest('[data-delete]');
    if (delBtn) {
      if (!confirm('Delete this task?')) return;
      try {
        await projectService.deleteTask(delBtn.dataset.delete);
        showToast('Task deleted', 'success');
        await loadTasks();
      } catch (err) {
        showToast('Delete failed', 'error');
      }
    }
  });

  // Add task button
  document.getElementById('btnAddTask').addEventListener('click', openAddModal);

  // Modal save/cancel
  document.getElementById('btnModalSave').addEventListener('click', saveTask);
  document.getElementById('btnModalCancel').addEventListener('click', closeModal);
  document.getElementById('taskModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Bulk reassign
  document.getElementById('btnBulkReassign').addEventListener('click', async () => {
    const val = document.getElementById('bulkAssignee').value;
    if (!val || !selectedIds.size) return;
    try {
      await projectService.bulkReassign([...selectedIds], null, val);
      showToast(`Reassigned ${selectedIds.size} tasks to ${val}`, 'success');
      selectedIds.clear();
      await loadTasks();
    } catch (err) {
      showToast('Reassign failed', 'error');
    }
  });

  // Photo upload
  document.getElementById('adminPhotoInput').addEventListener('change', handleAdminPhotoUpload);

  // Photo remove (delegated)
  document.getElementById('adminTaskPhotos').addEventListener('click', async (e) => {
    const removeBtn = e.target.closest('.photo-remove');
    if (!removeBtn) return;
    try {
      await projectService.removeTaskPhoto(removeBtn.dataset.photoId);
      const taskId = document.getElementById('editTaskId').value;
      if (taskId) await loadAdminTaskPhotos(taskId);
      showToast('Photo removed', 'success');
    } catch (err) {
      showToast('Remove failed', 'error');
    }
  });

  // Bulk status
  document.getElementById('btnBulkStatus').addEventListener('click', async () => {
    const status = document.getElementById('bulkStatus').value;
    if (!status || !selectedIds.size) return;
    try {
      for (const id of selectedIds) {
        await projectService.updateTask(id, { status });
      }
      showToast(`Updated ${selectedIds.size} tasks to ${statusLabel(status)}`, 'success');
      selectedIds.clear();
      await loadTasks();
    } catch (err) {
      showToast('Status update failed', 'error');
    }
  });

  // View toggle (Tasks / Inquiries)
  document.getElementById('viewToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    const view = btn.dataset.view;
    if (view === currentView) return;
    currentView = view;
    document.querySelectorAll('#viewToggle button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    document.getElementById('tasksView').style.display = view === 'tasks' ? '' : 'none';
    document.getElementById('inquiriesView').style.display = view === 'inquiries' ? '' : 'none';
    if (view === 'inquiries') loadInquiries();
  });

  // Inquiry filters
  ['inquiryFilterStatus', 'inquiryFilterType'].forEach(id => {
    document.getElementById(id).addEventListener('change', loadInquiries);
  });

  // Inquiry grid click (expand/collapse results + image lightbox)
  document.getElementById('inquiryGrid').addEventListener('click', (e) => {
    const thumb = e.target.closest('.inquiry-thumb');
    if (thumb) {
      const url = thumb.querySelector('img')?.src;
      if (url) window.open(url, '_blank');
      return;
    }
    const card = e.target.closest('.inquiry-card');
    if (!card) return;
    const detail = card.querySelector('.inquiry-detail');
    if (detail) detail.style.display = detail.style.display === 'none' ? '' : 'none';
  });
}

// ---- Modal ----
function openAddModal() {
  document.getElementById('modalTitle').textContent = 'Add Task';
  document.getElementById('editTaskId').value = '';
  document.getElementById('inputTitle').value = '';
  document.getElementById('inputNotes').value = '';
  document.getElementById('inputDescription').value = '';
  document.getElementById('inputPriority').value = '';
  document.getElementById('inputSpace').value = '';
  document.getElementById('inputLocationLabel').value = '';
  document.getElementById('inputAssignee').value = '';
  document.getElementById('inputStatus').value = 'open';
  document.getElementById('adminTaskPhotos').innerHTML = '';
  document.getElementById('taskModal').classList.add('open');
}

async function openEditModal(task) {
  document.getElementById('modalTitle').textContent = 'Edit Task';
  document.getElementById('editTaskId').value = task.id;
  document.getElementById('inputTitle').value = task.title;
  document.getElementById('inputNotes').value = task.notes || '';
  document.getElementById('inputDescription').value = task.description || '';
  document.getElementById('inputPriority').value = task.priority || '';
  document.getElementById('inputSpace').value = task.space_id || '';
  document.getElementById('inputLocationLabel').value = task.location_label || '';
  document.getElementById('inputStatus').value = task.status;

  // Set assignee with fallback matching
  const assigneeSel = document.getElementById('inputAssignee');
  if (task.assigned_to) {
    assigneeSel.value = `user:${task.assigned_to}:${task.assigned_name || ''}`;
    // Fallback: match by UUID prefix if exact match fails
    if (!assigneeSel.value) {
      for (const opt of assigneeSel.options) {
        if (opt.value.startsWith(`user:${task.assigned_to}:`)) {
          assigneeSel.value = opt.value;
          break;
        }
      }
    }
  } else if (task.assigned_name) {
    assigneeSel.value = `name:${task.assigned_name}`;
  } else {
    assigneeSel.value = '';
  }

  // Load photos
  await loadAdminTaskPhotos(task.id);

  document.getElementById('taskModal').classList.add('open');
}

function closeModal() {
  document.getElementById('taskModal').classList.remove('open');
}

async function saveTask() {
  const title = document.getElementById('inputTitle').value.trim();
  if (!title) { showToast('Title is required', 'warning'); return; }

  const id = document.getElementById('editTaskId').value;
  const assigneeVal = document.getElementById('inputAssignee').value;
  let assignedTo = null, assignedName = null;

  if (assigneeVal.startsWith('user:')) {
    const parts = assigneeVal.split(':');
    assignedTo = parts[1];
    assignedName = parts.slice(2).join(':');
  } else if (assigneeVal.startsWith('name:')) {
    assignedName = assigneeVal.substring(5);
  }

  const payload = {
    title,
    notes: document.getElementById('inputNotes').value.trim(),
    description: document.getElementById('inputDescription').value.trim(),
    priority: document.getElementById('inputPriority').value ? parseInt(document.getElementById('inputPriority').value) : null,
    spaceId: document.getElementById('inputSpace').value || null,
    locationLabel: document.getElementById('inputLocationLabel').value.trim() || null,
    assignedTo,
    assignedName,
    status: document.getElementById('inputStatus').value,
  };

  try {
    if (id) {
      await projectService.updateTask(id, payload);
      showToast('Task updated', 'success');
    } else {
      await projectService.createTask(payload);
      showToast('Task created', 'success');
    }
    closeModal();
    await loadTasks();
  } catch (err) {
    console.error('Save failed:', err);
    showToast('Save failed', 'error');
  }
}

// ---- Admin Task Photos ----
async function loadAdminTaskPhotos(taskId) {
  const container = document.getElementById('adminTaskPhotos');
  container.innerHTML = '';
  try {
    const photos = await projectService.getTaskPhotos(taskId);
    photos.forEach(p => {
      if (!p.media?.url) return;
      const thumb = document.createElement('div');
      thumb.className = 'admin-photo-thumb';
      thumb.innerHTML = `
        <img src="${p.media.url}" alt="Task photo">
        <button class="photo-remove" data-photo-id="${p.id}" title="Remove">&times;</button>
      `;
      thumb.querySelector('img').addEventListener('click', () => {
        window.open(p.media.url, '_blank');
      });
      container.appendChild(thumb);
    });
  } catch (err) {
    console.error('Failed to load task photos:', err);
  }
}

async function handleAdminPhotoUpload(e) {
  const taskId = document.getElementById('editTaskId').value;
  if (!taskId) {
    showToast('Save the task first, then add photos', 'warning');
    e.target.value = '';
    return;
  }
  const files = Array.from(e.target.files);
  if (!files.length) return;

  for (const file of files) {
    try {
      const result = await mediaService.uploadMedia(file, { category: 'task' });
      if (result.isDuplicate && result.existingMedia) {
        // Photo already exists in media library — link existing media to this task
        await projectService.addTaskPhoto(taskId, result.existingMedia.id);
      } else if (result.success === false) {
        showToast(`Photo upload failed: ${result.error}`, 'error');
        continue;
      } else {
        await projectService.addTaskPhoto(taskId, result.id);
      }
    } catch (err) {
      console.error('Photo upload failed:', err);
      showToast('Photo upload failed: ' + (err.message || ''), 'error');
    }
  }
  e.target.value = '';
  await loadAdminTaskPhotos(taskId);
  showToast(`${files.length} photo(s) added`, 'success');
}

// ---- Inquiries ----
async function loadInquiries() {
  const grid = document.getElementById('inquiryGrid');
  grid.innerHTML = '<div class="empty-state">Loading inquiries...</div>';

  let query = supabase
    .from('project_inquiries')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  const statusFilter = document.getElementById('inquiryFilterStatus').value;
  if (statusFilter) query = query.eq('status', statusFilter);

  const typeFilter = document.getElementById('inquiryFilterType').value;
  if (typeFilter) query = query.eq('inquiry_type', typeFilter);

  const { data, error } = await query;
  if (error) {
    grid.innerHTML = '<div class="empty-state">Failed to load inquiries.</div>';
    return;
  }

  allInquiries = data || [];
  renderInquiries();
}

function renderInquiries() {
  const grid = document.getElementById('inquiryGrid');

  if (!allInquiries.length) {
    grid.innerHTML = '<div class="empty-state">No inquiries found.</div>';
    return;
  }

  grid.innerHTML = allInquiries.map(inq => {
    const date = new Date(inq.created_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });

    const titleText = inq.inquiry_type === 'general' && inq.question
      ? inq.question.substring(0, 100) + (inq.question.length > 100 ? '...' : '')
      : inq.caption || 'Untitled inquiry';

    // Color swatches for color_pick results
    const colors = inq.analysis_result?.colors || [];
    const swatchesHtml = colors.slice(0, 6).map(c =>
      `<span class="inquiry-swatch" style="background:${esc(c.hex)}" title="${esc(c.name || c.hex)}"></span>`
    ).join('');

    // Detail section (initially hidden) for completed inquiries
    let detailHtml = '';
    if (inq.status === 'completed') {
      if (inq.inquiry_type === 'general' && inq.answer) {
        detailHtml = `<div class="inquiry-detail" style="display:none">
          <div class="inquiry-answer">${esc(inq.answer)}</div>
        </div>`;
      } else if (inq.inquiry_type === 'color_pick' && colors.length) {
        const colorDetails = colors.map(c => {
          const searches = inq.search_results?.colors || [];
          const matchIdx = colors.indexOf(c);
          const matches = searches[matchIdx]?.matches || [];
          const matchHtml = matches.slice(0, 3).map(m =>
            `<div style="font-size:0.75rem;margin-top:0.15rem">${esc(m.brand || '')} — ${esc(m.product_name || m.title || '')}${m.url ? ` <a href="${esc(m.url)}" target="_blank" rel="noopener" style="color:var(--accent)">View</a>` : ''}</div>`
          ).join('');
          return `<div style="display:flex;gap:0.5rem;align-items:flex-start;padding:0.4rem 0;border-bottom:1px solid #f3f4f6">
            <span class="inquiry-swatch" style="background:${esc(c.hex)};flex-shrink:0"></span>
            <div style="min-width:0">
              <div style="font-size:0.8rem;font-weight:600">${esc(c.name || c.hex)}</div>
              ${c.surface_type ? `<div style="font-size:0.7rem;color:var(--text-muted)">${esc(c.surface_type)}</div>` : ''}
              ${matchHtml}
            </div>
          </div>`;
        }).join('');

        const surfaceNote = inq.analysis_result?.surface_analysis
          ? `<div style="font-size:0.8rem;margin-bottom:0.5rem;color:#15803d;background:#f0fdf4;padding:0.4rem;border-radius:6px">${esc(inq.analysis_result.surface_analysis)}</div>`
          : '';

        detailHtml = `<div class="inquiry-detail" style="display:none">
          ${surfaceNote}${colorDetails}
        </div>`;
      }
    } else if (inq.status === 'failed' && inq.error_message) {
      detailHtml = `<div class="inquiry-detail" style="display:none">
        <div class="inquiry-answer" style="color:#991b1b;background:#fef2f2">${esc(inq.error_message)}</div>
      </div>`;
    }

    return `<div class="inquiry-card" data-id="${inq.id}" style="cursor:pointer">
      ${inq.image_url ? `<div class="inquiry-thumb"><img src="${esc(inq.image_url)}" alt="Inquiry photo" loading="lazy"></div>` : ''}
      <div class="inquiry-body">
        <div class="inquiry-title">${esc(titleText)}</div>
        <div class="inquiry-meta">
          <span class="inquiry-type-badge ${inq.inquiry_type}">${inq.inquiry_type === 'general' ? 'General' : 'Color Pick'}</span>
          <span class="inquiry-status ${inq.status}">${inq.status}</span>
          ${inq.assigned_to_name ? `<span>For: ${esc(inq.assigned_to_name)}</span>` : ''}
          <span>${date}</span>
        </div>
        ${swatchesHtml ? `<div class="inquiry-colors">${swatchesHtml}</div>` : ''}
        ${detailHtml}
      </div>
    </div>`;
  }).join('');
}

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
