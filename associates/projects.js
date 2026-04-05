/**
 * Associate Projects Page
 * Task board view — all associates can see all tasks and update status.
 * Supports add, edit, status transitions, and photo uploads.
 */

import { initAssociatePage, showToast } from '../shared/associate-shell.js';
import { projectService } from '../shared/project-service.js';
import { mediaService } from '../shared/media-service.js';

let currentUser = null;
let allTasks = [];
let myTasksActive = false;
let modalDataLoaded = false;
let editingTaskId = null;
let taskThumbnails = {};
let searchDebounce = null;

// ---- Init ----
initAssociatePage({
  activeTab: 'projects',
  onReady: async (state) => {
    currentUser = state.appUser;
    await loadAssignees();
    await loadTasks();
    bindEvents();
  }
});

// ---- Load Assignees for Filter ----
async function loadAssignees() {
  try {
    const users = await projectService.getUsers();
    const sel = document.getElementById('filterAssignee');
    const currentVal = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    users.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.display_name;
      sel.appendChild(opt);
    });
    sel.value = currentVal;
  } catch (e) {
    console.error('Failed to load assignees:', e);
  }
}

// ---- Load Tasks ----
async function loadTasks() {
  try {
    const filters = getFilters();
    allTasks = await projectService.getAllTasks(filters);

    // Load photo thumbnails
    const taskIds = allTasks.map(t => t.id);
    try {
      taskThumbnails = await projectService.getTaskPhotoThumbnails(taskIds);
    } catch (e) {
      console.warn('Failed to load thumbnails:', e);
      taskThumbnails = {};
    }

    renderTasks(allTasks);
    updateStats(allTasks);
  } catch (e) {
    console.error('Failed to load tasks:', e);
    document.getElementById('taskList').innerHTML = '<div class="empty-state">Failed to load tasks.</div>';
  }
}

function getFilters() {
  const filters = {};

  const status = document.getElementById('filterStatus').value;
  if (status === 'all') {
    filters.status = 'all';
  } else if (status) {
    filters.status = status;
  } else {
    filters.status = 'all';
  }

  const priority = document.getElementById('filterPriority').value;
  if (priority) filters.priority = parseInt(priority);

  if (myTasksActive && currentUser) {
    filters.assignedTo = currentUser.id;
  } else {
    const assignee = document.getElementById('filterAssignee').value;
    if (assignee) filters.assignedTo = assignee;
  }

  const search = document.getElementById('searchInput').value.trim();
  if (search) filters.search = search;

  return filters;
}

// ---- Render ----
function renderTasks(tasks) {
  const container = document.getElementById('taskList');

  const statusFilter = document.getElementById('filterStatus').value;
  if (!statusFilter) {
    tasks = tasks.filter(t => t.status !== 'done');
  }

  if (!tasks.length) {
    container.innerHTML = '<div class="empty-state">No tasks match your filters.</div>';
    return;
  }

  // Separate on_hold tasks into their own section at the bottom
  const onHoldTasks = tasks.filter(t => t.status === 'on_hold');
  const activeTasks = tasks.filter(t => t.status !== 'on_hold');

  const groups = {};
  const labels = { 1: 'P1 — Urgent', 2: 'P2 — High', 3: 'P3 — Medium', 4: 'P4 — Low', null: 'No Priority' };

  activeTasks.forEach(t => {
    const key = t.priority || 'null';
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  const order = [1, 2, 3, 4, 'null'];
  let html = '';
  let rowNum = 1;

  order.forEach(key => {
    const g = groups[key];
    if (!g || !g.length) return;
    html += `<div class="task-group">
      <div class="task-group-header">${labels[key === 'null' ? null : key]} (${g.length})</div>`;
    g.forEach(t => { html += renderTaskCard(t, rowNum++); });
    html += '</div>';
  });

  // On Hold section at the very end
  if (onHoldTasks.length) {
    html += `<div class="task-group">
      <div class="task-group-header" style="color:#9d174d">On Hold (${onHoldTasks.length})</div>`;
    onHoldTasks.forEach(t => { html += renderTaskCard(t, rowNum++); });
    html += '</div>';
  }

  container.innerHTML = html;
}

function renderTaskCard(task, rowNum) {
  const pClass = task.priority ? `p${task.priority}` : 'pnone';
  const pLabel = task.priority ? `P${task.priority}` : '—';
  const location = task.space?.name || task.location_label || '';
  const doneClass = task.status === 'done' ? 'done' : (task.status === 'on_hold' ? 'on-hold' : '');

  const editIcon = `<button class="task-edit-icon" data-id="${task.id}" data-action="edit" title="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>`;

  let actions = '';
  if (task.status === 'open') {
    actions = `<button class="btn-start" data-id="${task.id}" data-action="start">Start Working</button>
               <button class="btn-hold" data-id="${task.id}" data-action="hold">Hold</button>
               <button class="btn-done" data-id="${task.id}" data-action="done">Mark Done</button>`;
  } else if (task.status === 'in_progress') {
    actions = `<button class="btn-hold" data-id="${task.id}" data-action="hold">Hold</button>
               <button class="btn-done" data-id="${task.id}" data-action="done">Mark Done</button>`;
  } else if (task.status === 'on_hold') {
    actions = `<button class="btn-start" data-id="${task.id}" data-action="start">Resume</button>
               <button class="btn-reopen" data-id="${task.id}" data-action="reopen">Reopen</button>`;
  } else {
    actions = `<button class="btn-reopen" data-id="${task.id}" data-action="reopen">Reopen</button>`;
  }

  let statusBadge = '';
  if (task.status === 'in_progress') {
    statusBadge = '<span style="color:#d97706;font-weight:600;font-size:0.75rem">IN PROGRESS</span>';
  } else if (task.status === 'on_hold') {
    statusBadge = '<span style="color:#9d174d;font-weight:600;font-size:0.75rem">ON HOLD</span>';
  }

  const thumbUrl = taskThumbnails[task.id];
  const photoHtml = thumbUrl
    ? `<div class="task-card-photos"><img src="${esc(thumbUrl)}" loading="lazy" data-lightbox="${esc(thumbUrl)}"></div>`
    : '';

  const descHtml = task.description
    ? `<div class="task-description">${esc(task.description.length > 120 ? task.description.substring(0, 120) + '...' : task.description)}</div>`
    : '';

  const canonId = task.canonical_id || '';

  return `<div class="task-card ${doneClass}">
    ${editIcon}
    <div class="task-card-top">
      <div class="task-row-num">${rowNum}</div>
      <span class="task-priority ${pClass}">${pLabel}</span>
      <div class="task-card-body">
        <div class="task-title">${canonId ? `<span class="task-canon-id">${esc(canonId)}</span> ` : ''}${esc(task.title)}</div>
        <div class="task-meta">
          ${location ? `<span class="task-location">${esc(location)}</span>` : ''}
          ${task.assigned_name ? `<span class="task-assignee">${esc(task.assigned_name)}</span>` : ''}
          ${statusBadge}
        </div>
        ${task.notes ? `<div class="task-notes">${esc(task.notes)}</div>` : ''}
        ${descHtml}
        ${photoHtml}
        ${task.status === 'done' && task.completed_date ? `<div class="task-completed-date">Completed: ${esc(task.completed_date)}</div>` : ''}
        ${task.status === 'done' && task.completed_at && !task.completed_date ? `<div class="task-completed-date">Completed: ${new Date(task.completed_at).toLocaleDateString()}</div>` : ''}
        <div class="task-actions">${actions}</div>
      </div>
    </div>
  </div>`;
}

function updateStats() {
  projectService.getTaskStats().then(stats => {
    document.getElementById('statOpen').textContent = stats.open;
    document.getElementById('statInProgress').textContent = stats.in_progress;
    document.getElementById('statOnHold').textContent = stats.on_hold;
    document.getElementById('statDone').textContent = stats.done;
  });
}

// ---- Events ----
function bindEvents() {
  // Search with debounce
  document.getElementById('searchInput').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadTasks, 300);
  });

  // Filters
  document.getElementById('filterAssignee').addEventListener('change', () => {
    myTasksActive = false;
    document.getElementById('btnMyTasks').classList.remove('active');
    loadTasks();
  });
  document.getElementById('filterStatus').addEventListener('change', loadTasks);
  document.getElementById('filterPriority').addEventListener('change', loadTasks);

  // My Tasks toggle
  document.getElementById('btnMyTasks').addEventListener('click', () => {
    myTasksActive = !myTasksActive;
    document.getElementById('btnMyTasks').classList.toggle('active', myTasksActive);
    if (myTasksActive) {
      document.getElementById('filterAssignee').value = '';
    }
    loadTasks();
  });

  // Add Project
  document.getElementById('btnAddProject').addEventListener('click', openAddModal);
  document.getElementById('btnCloseModal').addEventListener('click', closeModal);
  document.getElementById('btnCancelModal').addEventListener('click', closeModal);
  document.getElementById('addProjectModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('addProjectForm').addEventListener('submit', handleSaveProject);

  // Task action buttons (delegated)
  document.getElementById('taskList').addEventListener('click', async (e) => {
    // Lightbox clicks on thumbnails
    const lbImg = e.target.closest('[data-lightbox]');
    if (lbImg) {
      e.stopPropagation();
      document.getElementById('lightboxImg').src = lbImg.dataset.lightbox;
      document.getElementById('simpleLightbox').classList.remove('hidden');
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const id = btn.dataset.id;
    const action = btn.dataset.action;

    if (action === 'edit') {
      const task = allTasks.find(t => t.id === id);
      if (task) openEditModal(task);
      return;
    }

    btn.disabled = true;
    try {
      if (action === 'start') {
        await projectService.updateTask(id, { status: 'in_progress' });
        showToast('Task started', 'success');
      } else if (action === 'hold') {
        await projectService.updateTask(id, { status: 'on_hold' });
        showToast('Task put on hold', 'info');
      } else if (action === 'done') {
        await projectService.updateTask(id, { status: 'done' });
        showToast('Task completed', 'success');
      } else if (action === 'reopen') {
        await projectService.updateTask(id, { status: 'open' });
        showToast('Task reopened', 'info');
      }
      await loadTasks();
    } catch (e) {
      console.error('Task update failed:', e);
      showToast('Failed to update task', 'error');
      btn.disabled = false;
    }
  });

  // Photo upload
  document.getElementById('photoInput').addEventListener('change', handlePhotoUpload);

  // Photo remove (delegated)
  document.getElementById('taskPhotos').addEventListener('click', async (e) => {
    const btn = e.target.closest('.photo-remove');
    if (!btn) return;
    e.stopPropagation();
    const photoId = btn.dataset.photoId;
    if (!photoId) return;
    try {
      await projectService.removeTaskPhoto(photoId);
      btn.closest('.task-photo-thumb').remove();
      showToast('Photo removed', 'success');
    } catch (err) {
      showToast('Failed to remove photo', 'error');
    }
  });

  // Lightbox in modal photos
  document.getElementById('taskPhotos').addEventListener('click', (e) => {
    const img = e.target.closest('img');
    if (!img || e.target.closest('.photo-remove')) return;
    document.getElementById('lightboxImg').src = img.src;
    document.getElementById('simpleLightbox').classList.remove('hidden');
  });

  // Close lightbox
  document.getElementById('simpleLightbox').addEventListener('click', () => {
    document.getElementById('simpleLightbox').classList.add('hidden');
  });

  // Escape key closes modal (with dirty check)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const lightbox = document.getElementById('simpleLightbox');
      if (!lightbox.classList.contains('hidden')) {
        lightbox.classList.add('hidden');
        return;
      }
      const modal = document.getElementById('addProjectModal');
      if (!modal.classList.contains('hidden')) {
        closeModal();
      }
    }
  });
}

// ---- Modal ----
async function ensureModalData() {
  if (modalDataLoaded) return;
  modalDataLoaded = true;
  try {
    const [spaces, users] = await Promise.all([
      projectService.getSpaces(),
      projectService.getUsers(),
    ]);

    const spaceSel = document.getElementById('newSpace');
    spaces.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      spaceSel.appendChild(opt);
    });

    const assigneeSel = document.getElementById('newAssignee');
    users.forEach(u => {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ id: u.id, name: u.display_name });
      opt.textContent = u.display_name;
      assigneeSel.appendChild(opt);
    });
  } catch (e) {
    console.error('Failed to load modal data:', e);
  }
}

async function openAddModal() {
  editingTaskId = null;
  document.getElementById('modalTitle').textContent = 'New Project Task';
  document.getElementById('editTaskId').value = '';
  document.getElementById('btnSubmitProject').textContent = 'Create Project Task';
  document.getElementById('statusGroup').classList.add('hidden');

  document.getElementById('newTitle').value = '';
  document.getElementById('newNotes').value = '';
  document.getElementById('newDescription').value = '';
  document.getElementById('newPriority').value = '';
  document.getElementById('newAssignee').value = '';
  document.getElementById('newSpace').value = '';
  document.getElementById('newLocationLabel').value = '';
  document.getElementById('newStatus').value = 'open';
  document.getElementById('taskPhotos').innerHTML = '';

  await ensureModalData();

  const modal = document.getElementById('addProjectModal');
  modal.classList.remove('hidden');
  document.getElementById('newTitle').focus();
}

async function openEditModal(task) {
  editingTaskId = task.id;
  document.getElementById('modalTitle').textContent = 'Edit Project Task';
  document.getElementById('editTaskId').value = task.id;
  document.getElementById('btnSubmitProject').textContent = 'Save Changes';
  document.getElementById('statusGroup').classList.remove('hidden');

  document.getElementById('newTitle').value = task.title || '';
  document.getElementById('newNotes').value = task.notes || '';
  document.getElementById('newDescription').value = task.description || '';
  document.getElementById('newPriority').value = task.priority || '';
  document.getElementById('newSpace').value = task.space_id || '';
  document.getElementById('newLocationLabel').value = task.location_label || '';
  document.getElementById('newStatus').value = task.status || 'open';

  await ensureModalData();

  // Set assignee
  const assigneeSel = document.getElementById('newAssignee');
  assigneeSel.value = '';
  if (task.assigned_to) {
    for (const opt of assigneeSel.options) {
      if (!opt.value) continue;
      try {
        const parsed = JSON.parse(opt.value);
        if (parsed.id === task.assigned_to) {
          assigneeSel.value = opt.value;
          break;
        }
      } catch {}
    }
  }

  // Load photos
  await loadTaskPhotos(task.id);

  const modal = document.getElementById('addProjectModal');
  modal.classList.remove('hidden');
}

function isModalDirty() {
  const title = document.getElementById('newTitle').value.trim();
  const notes = document.getElementById('newNotes').value.trim();
  const description = document.getElementById('newDescription').value.trim();
  const priority = document.getElementById('newPriority').value;
  const assignee = document.getElementById('newAssignee').value;
  const space = document.getElementById('newSpace').value;
  const locationLabel = document.getElementById('newLocationLabel').value.trim();
  return !!(title || notes || description || priority || assignee || space || locationLabel);
}

function closeModal(force = false) {
  if (!force && !editingTaskId && isModalDirty()) {
    if (!confirm('You have unsaved content. Discard this project task?')) return;
  }
  document.getElementById('addProjectModal').classList.add('hidden');
  editingTaskId = null;
}

async function handleSaveProject(e) {
  e.preventDefault();
  const btn = document.getElementById('btnSubmitProject');
  const isEdit = !!document.getElementById('editTaskId').value;
  btn.disabled = true;
  btn.textContent = isEdit ? 'Saving...' : 'Creating...';

  try {
    const title = document.getElementById('newTitle').value.trim();
    const notes = document.getElementById('newNotes').value.trim();
    const description = document.getElementById('newDescription').value.trim();
    const priority = document.getElementById('newPriority').value;
    const spaceId = document.getElementById('newSpace').value;
    const locationLabel = document.getElementById('newLocationLabel').value.trim();
    const assigneeVal = document.getElementById('newAssignee').value;
    const status = document.getElementById('newStatus').value;

    let assignedTo = null;
    let assignedName = null;
    if (assigneeVal) {
      const parsed = JSON.parse(assigneeVal);
      assignedTo = parsed.id;
      assignedName = parsed.name;
    }

    const payload = {
      title,
      notes,
      description,
      priority: priority ? parseInt(priority) : null,
      spaceId: spaceId || null,
      locationLabel: locationLabel || null,
      assignedTo,
      assignedName,
    };

    if (isEdit) {
      payload.status = status;
      await projectService.updateTask(editingTaskId, payload);
      showToast('Project updated', 'success');
    } else {
      payload.status = 'open';
      await projectService.createTask(payload);
      showToast('Project created', 'success');
    }

    closeModal(true);
    await loadTasks();
    await loadAssignees();
  } catch (err) {
    console.error('Failed to save project task:', err);
    showToast('Failed to save project task', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = isEdit ? 'Save Changes' : 'Create Project Task';
  }
}

// ---- Photos ----
async function loadTaskPhotos(taskId) {
  const container = document.getElementById('taskPhotos');
  container.innerHTML = '';
  try {
    const photos = await projectService.getTaskPhotos(taskId);
    photos.forEach(p => {
      const url = p.media?.url;
      if (!url) return;
      const div = document.createElement('div');
      div.className = 'task-photo-thumb';
      div.innerHTML = `<img src="${esc(url)}" loading="lazy">
        <button class="photo-remove" data-photo-id="${p.id}" title="Remove">&times;</button>`;
      container.appendChild(div);
    });
  } catch (e) {
    console.error('Failed to load task photos:', e);
  }
}

async function handlePhotoUpload(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  const taskId = document.getElementById('editTaskId').value;
  if (!taskId) {
    showToast('Create the project first, then add photos by editing it', 'info');
    e.target.value = '';
    return;
  }

  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    showToast('Uploading photo...', 'info');
    try {
      const result = await mediaService.upload(file, { category: 'projects' });
      if (!result.success) throw new Error(result.error || 'Upload failed');
      await projectService.addTaskPhoto(taskId, result.media.id);
      await loadTaskPhotos(taskId);
      showToast('Photo added', 'success');
    } catch (err) {
      showToast('Photo upload failed: ' + err.message, 'error');
    }
  }
  e.target.value = '';
}

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
