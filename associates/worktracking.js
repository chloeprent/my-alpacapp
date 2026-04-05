/**
 * Associate Hours Page - Mobile-optimized time tracking
 * Clock in/out, view history, upload work photos, manage payment preferences
 */
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../shared/supabase.js';
import { initAssociatePage, showToast as shellShowToast } from '../shared/associate-shell.js';
import { hoursService, HoursService, PHOTO_TYPE_LABELS } from '../shared/hours-service.js';
import { mediaService } from '../shared/media-service.js';
import { PAYMENT_METHOD_LABELS } from '../shared/accounting-service.js';
import { identityService } from '../shared/identity-service.js';
import { AUSTIN_TIMEZONE } from '../shared/timezone.js';
import { projectService } from '../shared/project-service.js';
import { payoutService } from '../shared/payout-service.js';
import { initTabList } from '../shared/tab-utils.js';
import { emailService } from '../shared/email-service.js';

// =============================================
// STATE
// =============================================
let authState = null;
let profile = null;
let activeEntry = null;
let timerInterval = null;
let selectedPhotoType = 'before';
let currentLocation = null;
let spacesMap = {};
let scheduleData = [];
let scheduleActuals = {};
let scheduleLoaded = false;
let editingEntryId = null;
let editingEntryOriginal = null;
let editingOldValues = null;
const PENCIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';

// =============================================
// INITIALIZATION
// =============================================
initAssociatePage({
  activeTab: 'hours',
  onReady: async (state) => {
    authState = state;
    await initApp();
  }
});

async function initApp() {
  // Get or create associate profile
  try {
    profile = await hoursService.getOrCreateProfile(authState.appUser.id, authState.appUser.role);
  } catch (err) {
    console.error('Failed to get profile:', err);
    showToast('Failed to load your profile', 'error');
    return;
  }

  if (!profile) {
    showToast('No hours profile found — contact an admin to set you up', 'error');
    return;
  }

  setupEventListeners();
  requestLocation();
  await loadSpaces();
  initWorkplaceSelector();
  await loadTasksForSelector();
  await refreshAll();

  // Handle Stripe onboarding return
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('stripe_onboarding') === 'complete') {
    showToast('Stripe Connect onboarding completed!', 'success');
    // Clean up URL
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
    // Switch to payment tab to show updated status
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelector('[data-tab="payment"]')?.classList.add('active');
    document.getElementById('tabPayment')?.classList.add('active');
    await refreshPaymentTab();
  }
}

async function refreshAll() {
  await Promise.all([
    refreshClockState(),
    refreshToday(),
    refreshTodayPhotos(),
    refreshPaymentTab(),
    refreshTasksList()
  ]);
}

// =============================================
// LOCATION
// =============================================
function requestLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => { currentLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
    () => { currentLocation = null; },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(currentLocation),
      { enableHighAccuracy: true, timeout: 5000 }
    );
  });
}

// =============================================
// SPACE SELECTOR (sticky)
// =============================================
const SPACE_KEY = 'worktracking-selected-space';
const WORKPLACE_KEY = 'worktracking-selected-workplace';

function initWorkplaceSelector() {
  const sel = document.getElementById('workplaceSelector');
  if (!sel) return;

  // Build per-user key
  const userId = authState?.appUser?.id || '';
  const key = `${WORKPLACE_KEY}-${userId}`;

  // Restore saved selection
  const saved = localStorage.getItem(key);
  if (saved && sel.querySelector(`option[value="${saved}"]`)) {
    sel.value = saved;
  }

  // Persist on change
  sel.addEventListener('change', () => {
    localStorage.setItem(key, sel.value);
  });
}

function getSelectedWorkplace() {
  const sel = document.getElementById('workplaceSelector');
  return sel ? sel.value : 'onsite';
}

async function loadSpaces() {
  try {
    const { data, error } = await supabase
      .from('spaces')
      .select('id, name, parent:parent_id(name)')
      .eq('is_archived', false)
      .eq('is_micro', false)
      .order('name');

    if (error) throw error;

    // Build a lookup map for space names (used by history/today rendering)
    spacesMap = {};
    for (const s of (data || [])) {
      spacesMap[s.id] = s.parent?.name ? `${s.name} (${s.parent.name})` : s.name;
    }

    const sel = document.getElementById('spaceSelector');
    let opts = '<option value="">Select space...</option>';
    for (const s of (data || [])) {
      const label = s.parent?.name ? `${s.name} (${s.parent.name})` : s.name;
      opts += `<option value="${s.id}">${escapeHtml(label)}</option>`;
    }
    opts += '<option value="virtual">Virtual</option>';
    opts += '<option value="other">Other</option>';
    sel.innerHTML = opts;

    // Restore sticky selection
    const saved = localStorage.getItem(SPACE_KEY);
    if (saved && sel.querySelector(`option[value="${saved}"]`)) {
      sel.value = saved;
    }

    // Persist on change
    sel.addEventListener('change', () => {
      localStorage.setItem(SPACE_KEY, sel.value);
    });
  } catch (err) {
    console.error('Failed to load spaces:', err);
  }
}

function getSelectedSpaceId() {
  const val = document.getElementById('spaceSelector').value;
  return val && val !== 'other' && val !== 'virtual' ? val : null;
}

function getSelectedTaskId() {
  const sel = document.getElementById('taskSelector');
  return sel ? (sel.value || null) : null;
}

async function loadTasksForSelector() {
  try {
    const userId = authState?.appUser?.id;
    const tasks = userId
      ? await projectService.getOpenTasksForUser(userId)
      : await projectService.getAllTasks({ status: 'all' });
    const sel = document.getElementById('taskSelector');
    if (!sel) return;
    // Keep the first "No specific task" option
    while (sel.options.length > 1) sel.remove(1);
    (tasks || []).forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      const location = t.space?.name || '';
      opt.textContent = location ? `${t.title} (${location})` : t.title;
      sel.appendChild(opt);
    });
  } catch (err) {
    console.error('Failed to load tasks:', err);
  }
}

// =============================================
// CLOCK IN/OUT
// =============================================
async function refreshClockState() {
  try {
    activeEntry = await hoursService.getActiveEntry(profile.id);
    updateClockUI();
  } catch (err) {
    console.error('Failed to get clock state:', err);
  }
}

function updateClockUI() {
  const btn = document.getElementById('clockBtn');
  const timer = document.getElementById('timerDisplay');
  const timerLabel = document.getElementById('timerLabel');
  const rateDisplay = document.getElementById('rateDisplay');
  const prompt = document.getElementById('clockoutPrompt');

  rateDisplay.textContent = `Your rate: ${HoursService.formatCurrency(profile.hourly_rate)}/hr`;
  prompt.classList.remove('visible');

  if (activeEntry) {
    btn.className = 'clock-btn clock-out';
    btn.textContent = 'Clock Out';
    btn.onclick = showClockoutPrompt;
    timer.style.display = '';
    timerLabel.style.display = '';
    startTimer();
  } else {
    btn.className = 'clock-btn clock-in';
    btn.textContent = 'Clock In';
    btn.onclick = handleClockIn;
    timer.style.display = 'none';
    timerLabel.style.display = 'none';
    stopTimer();
  }
}

async function handleClockIn() {
  const spaceSel = document.getElementById('spaceSelector');
  const spaceVal = spaceSel.value;
  console.log('[clockIn] spaceSelector.value =', JSON.stringify(spaceVal), 'selectedIndex =', spaceSel.selectedIndex);
  if (!spaceVal) {
    showToast('Please select a space before clocking in', 'error');
    spaceSel.focus();
    return;
  }
  const spaceId = getSelectedSpaceId(); // null for virtual/other, UUID for real spaces
  const btn = document.getElementById('clockBtn');
  btn.disabled = true;
  try {
    const loc = await getLocation();
    activeEntry = await hoursService.clockIn(profile.id, { ...(loc || {}), spaceId, taskId: getSelectedTaskId() });
    showToast('Clocked in!', 'success');
    updateClockUI();
    await refreshToday();

    // Show clock-in summary with task list + photo reminder at top of Today tab
    switchToTab('today');
    setPhotoType('before');
    showPhotoBanner('before');
    await showClockInSummary();

    // Send clock-in email with task list to associate + admin
    sendClockInEmail().catch(err => console.warn('Clock-in email failed (non-critical):', err.message));

    // Schedule a one-shot photo reminder 15 min after clock-in
    if (activeEntry?.id) {
      const entryId = activeEntry.id;
      setTimeout(() => {
        fetch(`${SUPABASE_URL}/functions/v1/work-photo-reminder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
          body: JSON.stringify({ time_entry_id: entryId })
        }).catch(() => {});
      }, 15 * 60 * 1000);
    }
  } catch (err) {
    showToast('Failed to clock in: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function showClockoutPrompt() {
  document.getElementById('clockoutPrompt').classList.add('visible');
  document.getElementById('clockoutDesc').value = '';

  // Switch to Today tab, show After photo banner, and scroll to photo section
  switchToTab('today');
  setPhotoType('after');
  showPhotoBanner('after');
  setTimeout(() => {
    document.getElementById('photoSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 300);

  // Check if after photos exist for this session
  const warning = document.getElementById('afterPhotoWarning');
  if (activeEntry?.id && warning) {
    try {
      const photos = await hoursService.getWorkPhotos(profile.id, { timeEntryId: activeEntry.id });
      const hasAfterPhotos = photos.some(p => p.photo_type === 'after');
      warning.style.display = hasAfterPhotos ? 'none' : 'block';
    } catch (_) {
      warning.style.display = 'none';
    }
  }
}

async function handleClockOut(description) {
  const btn = document.getElementById('btnClockoutSubmit');
  btn.disabled = true;
  try {
    const loc = await getLocation();
    // Capture entry data before clock-out clears it
    const entryId = activeEntry.id;
    const entrySpaceId = activeEntry.space_id;
    const entryTaskId = activeEntry.task_id;
    const entryRate = parseFloat(activeEntry.hourly_rate) || 0;

    const updatedEntry = await hoursService.clockOut(entryId, {
      ...(loc || {}),
      description: description || null
    });
    activeEntry = null;
    showToast('Clocked out!', 'success');
    updateClockUI();
    await refreshToday();

    // Fire-and-forget: send checkout summary email
    sendCheckoutSummaryEmail(updatedEntry, entrySpaceId, entryTaskId, entryRate, description);

    // Check for after photos — if missing, send reminder email immediately
    try {
      const photos = await hoursService.getWorkPhotos(profile.id, { timeEntryId: entryId });
      const hasAfterPhotos = photos.some(p => p.photo_type === 'after');
      if (!hasAfterPhotos) {
        fetch(`${SUPABASE_URL}/functions/v1/work-photo-reminder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
          body: JSON.stringify({ time_entry_id: entryId })
        }).catch(() => {});
      }
    } catch (_) { /* ignore — cron backup will catch it */ }
  } catch (err) {
    showToast('Failed to clock out: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/**
 * Send work checkout summary email (fire-and-forget, non-blocking)
 */
async function sendCheckoutSummaryEmail(entry, spaceId, taskId, rate, description) {
  try {
    // Gather space name
    const spaceName = spaceId && spacesMap[spaceId] ? spacesMap[spaceId] : null;

    // Gather task name if applicable
    let taskName = null;
    if (taskId) {
      try {
        const { data: task } = await supabase.from('tasks').select('title').eq('id', taskId).single();
        taskName = task?.title || null;
      } catch (_) { /* ignore */ }
    }

    // Fetch work photos for this time entry
    const photos = await hoursService.getWorkPhotos(profile.id, { timeEntryId: entry.id });
    const photoData = photos.map(p => ({
      url: p.media?.url || '',
      type: p.photo_type || 'progress',
      caption: p.caption || p.media?.caption || ''
    })).filter(p => p.url);

    // Compute values
    const durationMins = parseFloat(entry.duration_minutes) || 0;
    const earnings = (durationMins / 60) * rate;

    // Compute cumulative stats (week, month, year)
    const now = new Date();
    const austinDate = new Date(now.toLocaleString('en-US', { timeZone: AUSTIN_TIMEZONE }));
    const dayOfWeek = austinDate.getDay(); // 0=Sun
    const weekStart = new Date(austinDate);
    weekStart.setDate(weekStart.getDate() - dayOfWeek);
    const monthStart = new Date(austinDate.getFullYear(), austinDate.getMonth(), 1);
    const yearStart = new Date(austinDate.getFullYear(), 0, 1);

    const toDateStr = d => d.toLocaleDateString('en-CA');
    const todayStr = toDateStr(austinDate);

    let cumulative = null;
    try {
      const [weekEntries, monthEntries, yearEntries] = await Promise.all([
        hoursService.getEntries(profile.id, { dateFrom: toDateStr(weekStart), dateTo: todayStr }),
        hoursService.getEntries(profile.id, { dateFrom: toDateStr(monthStart), dateTo: todayStr }),
        hoursService.getEntries(profile.id, { dateFrom: toDateStr(yearStart), dateTo: todayStr }),
      ]);

      const sumUp = (entries) => {
        let mins = 0, pay = 0;
        for (const e of entries) {
          if (!e.clock_out) continue;
          const m = parseFloat(e.duration_minutes) || 0;
          mins += m;
          pay += (m / 60) * parseFloat(e.hourly_rate || 0);
        }
        return { hours: HoursService.formatDuration(mins), earnings: HoursService.formatCurrency(pay) };
      };

      cumulative = {
        week: sumUp(weekEntries),
        month: sumUp(monthEntries),
        year: sumUp(yearEntries),
      };
    } catch (e) {
      console.warn('Failed to compute cumulative stats:', e.message);
    }

    const emailData = {
      associate_email: authState.appUser.email,
      first_name: authState.appUser.first_name || authState.appUser.display_name || 'Team Member',
      date: HoursService.formatDate(new Date(entry.clock_in).toLocaleDateString('en-CA', { timeZone: AUSTIN_TIMEZONE })),
      clock_in_time: HoursService.formatTime(entry.clock_in),
      clock_out_time: HoursService.formatTime(entry.clock_out),
      duration: HoursService.formatDuration(durationMins),
      space_name: spaceName,
      task_name: taskName,
      description: description || null,
      hourly_rate: rate.toFixed(2),
      earnings: HoursService.formatCurrency(earnings),
      photos: photoData,
      cumulative,
    };

    await emailService.sendWorkCheckoutSummary(emailData);
  } catch (err) {
    console.warn('Checkout summary email failed (non-critical):', err.message);
  }
}

// =============================================
// TIMER
// =============================================
function startTimer() {
  stopTimer();
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function updateTimerDisplay() {
  if (!activeEntry) return;
  const elapsed = Date.now() - new Date(activeEntry.clock_in).getTime();
  const secs = Math.floor(elapsed / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  document.getElementById('timerDisplay').textContent =
    `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// =============================================
// TODAY TAB
// =============================================
async function refreshToday() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const entries = await hoursService.getEntries(profile.id, { dateFrom: today, dateTo: today });

    let totalMins = 0, totalAmt = 0;
    for (const e of entries) {
      const mins = parseFloat(e.duration_minutes) || 0;
      totalMins += mins;
      totalAmt += (mins / 60) * parseFloat(e.hourly_rate);
    }

    // If clocked in, add running time
    if (activeEntry) {
      const runningMins = (Date.now() - new Date(activeEntry.clock_in).getTime()) / 60000;
      totalMins += runningMins;
      totalAmt += (runningMins / 60) * parseFloat(activeEntry.hourly_rate);
    }

    document.getElementById('todayHours').textContent = HoursService.formatDuration(totalMins);
    document.getElementById('todayAmount').textContent = HoursService.formatCurrency(totalAmt);

    const container = document.getElementById('todayEntries');
    if (!entries.length && !activeEntry) {
      container.innerHTML = '<p style="color:var(--text-muted);text-align:center;font-size:0.85rem;">No entries yet today. Hit Clock In to start!</p>';
      return;
    }

    container.innerHTML = entries.map(e => {
      const ci = HoursService.formatTime(e.clock_in);
      const co = e.clock_out ? HoursService.formatTime(e.clock_out) : 'Active';
      const dur = e.duration_minutes ? HoursService.formatDuration(e.duration_minutes) : '...';
      const desc = e.description ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.15rem;">${escapeHtml(e.description)}</div>` : '';
      const manual = e.is_manual ? '<span class="manual-badge" style="margin-left:0.3rem;">Manual</span>' : '';
      const spaceLabel = e.space_id && spacesMap[e.space_id] ? `<span class="space-tag">${escapeHtml(spacesMap[e.space_id])}</span>` : '';
      const editBtn = (e.clock_out && !e.is_paid) ? `<button class="entry-edit-btn" onclick="window._openEditModal('${e.id}')" title="Edit entry">${PENCIL_ICON}</button>` : '';
      return `<div class="entry-row">
        <div><span class="entry-times">${ci} — ${co}</span>${manual}${spaceLabel}${desc}</div>
        <div style="display:flex;align-items:center;gap:0.5rem;">
          ${editBtn}
          <span class="entry-duration">${dur}</span>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    console.error('Failed to refresh today:', err);
  }
}

// =============================================
// PHOTOS
// =============================================
async function refreshTodayPhotos() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const photos = await hoursService.getPhotosForDate(profile.id, today);
    const grid = document.getElementById('todayPhotos');

    if (!photos.length) {
      grid.innerHTML = '';
      return;
    }

    grid.innerHTML = photos.map(p => {
      const url = p.media?.url || '';
      const type = PHOTO_TYPE_LABELS[p.photo_type] || p.photo_type;
      const mediaType = p.media?.media_type || 'image';
      const title = p.media?.title || '';
      const mimeType = p.media?.mime_type || '';

      // Render document/file thumbnails differently from images
      if (mediaType === 'document' || (!mimeType.startsWith('image/') && mediaType !== 'image')) {
        const icon = getFileIcon(mimeType, title);
        const displayName = title || 'File';
        return `<div class="photo-thumb file-thumb" onclick="window.open('${escapeHtml(url)}','_blank')">
          <span class="file-icon">${icon}</span>
          <span class="file-name">${escapeHtml(displayName)}</span>
          <span class="type-tag">${escapeHtml(type)}</span>
        </div>`;
      }

      return `<div class="photo-thumb" onclick="window.open('${escapeHtml(url)}','_blank')">
        <img src="${escapeHtml(url)}" alt="${escapeHtml(type)}" loading="lazy">
        <span class="type-tag">${escapeHtml(type)}</span>
      </div>`;
    }).join('');
  } catch (err) {
    console.error('Failed to load photos:', err);
  }
}

function getFileIcon(mimeType, filename) {
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  if (mimeType === 'application/pdf' || ext === 'pdf') return '📄';
  if (mimeType.includes('word') || ext === 'doc' || ext === 'docx') return '📝';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || ext === 'xls' || ext === 'xlsx' || ext === 'csv') return '📊';
  if (mimeType.includes('text') || ext === 'txt') return '📃';
  if (mimeType.includes('zip') || mimeType.includes('compressed') || ext === 'zip') return '🗜️';
  return '📎';
}

/** Show the clock-in summary card with the associate's task list */
async function showClockInSummary() {
  const summary = document.getElementById('clockInSummary');
  const taskListDiv = document.getElementById('clockInTaskList');
  if (!summary || !taskListDiv) return;

  try {
    const userId = authState?.appUser?.id;
    const { data: tasks } = await supabase
      .from('tasks')
      .select('id, title, priority, status, space:space_id(name)')
      .in('status', ['open', 'in_progress'])
      .or(`assigned_to.eq.${userId},assigned_to.is.null`)
      .order('priority', { ascending: true, nullsFirst: false })
      .limit(10);

    if (tasks && tasks.length > 0) {
      const pLabels = { 1: '🔴', 2: '🟠', 3: '🟡', 4: '🔵' };
      taskListDiv.innerHTML = tasks.map(t => {
        const icon = pLabels[t.priority] || '⚪';
        const loc = t.space?.name ? ` <span style="color:#6b7280;font-size:0.8rem;">(${escapeHtml(t.space.name)})</span>` : '';
        return `<div style="padding:0.25rem 0;">${icon} ${escapeHtml(t.title)}${loc}</div>`;
      }).join('');
    } else {
      taskListDiv.innerHTML = '<div style="padding:0.25rem 0;">No open tasks — you\'re all caught up!</div>';
    }

    summary.style.display = 'block';
    // Scroll to top of today tab so summary is visible without scrolling
    summary.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.warn('Failed to show clock-in summary:', err.message);
  }
}

/** Send clock-in email with task list to associate + admin */
async function sendClockInEmail() {
  const userId = authState?.appUser?.id;
  if (!userId) return;

  const { data: tasks } = await supabase
    .from('tasks')
    .select('id, title, priority, status, space:space_id(name), notes')
    .in('status', ['open', 'in_progress'])
    .or(`assigned_to.eq.${userId},assigned_to.is.null`)
    .order('priority', { ascending: true, nullsFirst: false })
    .limit(20);

  const taskList = (tasks || []).map(t => ({
    title: t.title,
    priority: t.priority,
    location: t.space?.name || '',
    notes: t.notes || '',
  }));

  const spaceSel = document.getElementById('spaceSelector');
  const spaceName = spaceSel?.options[spaceSel.selectedIndex]?.text || '';

  const emailData = {
    associate_email: authState.appUser.email,
    first_name: authState.appUser.first_name || authState.appUser.display_name || 'Team Member',
    space_name: spaceName,
    clock_in_time: HoursService.formatTime(activeEntry?.clock_in || new Date().toISOString()),
    tasks: taskList,
  };

  // Send via edge function
  await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      type: 'work_clockin_summary',
      to: [authState.appUser.email, 'automation@YOUR_DOMAIN'].filter(Boolean),
      data: emailData,
    }),
  });
}

/** Set the photo type selector to a specific type */
function setPhotoType(type) {
  document.querySelectorAll('[data-photo-type]').forEach(b => {
    b.classList.toggle('active', b.dataset.photoType === type);
  });
  selectedPhotoType = type;
}

/** Show a prominent photo-required banner */
function showPhotoBanner(phase) {
  const beforeBanner = document.getElementById('beforePhotoBanner');
  const afterBanner = document.getElementById('afterPhotoBanner');
  if (beforeBanner) beforeBanner.style.display = phase === 'before' ? 'block' : 'none';
  if (afterBanner) afterBanner.style.display = phase === 'after' ? 'block' : 'none';
}

async function handlePhotoUpload(file) {
  if (!file) return;
  showToast('Uploading photo...', 'info', 2000);

  try {
    // Upload via media service
    const result = await mediaService.upload(file, { category: 'projects' });
    if (!result.success) throw new Error(result.error || 'Upload failed');

    // Create work photo record
    await hoursService.createWorkPhoto({
      associateId: profile.id,
      mediaId: result.media.id,
      timeEntryId: activeEntry?.id || null,
      photoType: selectedPhotoType,
      workDate: new Date().toISOString().split('T')[0]
    });

    showToast('Photo uploaded!', 'success');
    await refreshTodayPhotos();
  } catch (err) {
    showToast('Failed to upload photo: ' + err.message, 'error');
  }
}

async function handleFileUpload(file) {
  if (!file) return;

  // Route images through the existing photo upload handler
  if (file.type.startsWith('image/')) {
    return handlePhotoUpload(file);
  }

  // For non-image files, upload directly to Supabase storage
  showToast('Uploading file...', 'info', 3000);

  try {
    const ext = file.name.split('.').pop()?.toLowerCase() || 'bin';
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 8);
    const storagePath = `projects/${timestamp}-${randomId}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('housephotos')
      .upload(storagePath, file);

    if (uploadError) throw new Error(uploadError.message);

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('housephotos')
      .getPublicUrl(storagePath);

    // Create media record
    const { data: mediaRecord, error: mediaError } = await supabase
      .from('media')
      .insert({
        url: urlData.publicUrl,
        storage_provider: 'supabase',
        storage_path: storagePath,
        media_type: 'document',
        mime_type: file.type || 'application/octet-stream',
        file_size_bytes: file.size,
        title: file.name,
        category: 'projects',
      })
      .select()
      .single();

    if (mediaError) throw new Error(mediaError.message);

    // Create work photo record (links the file to this work session)
    await hoursService.createWorkPhoto({
      associateId: profile.id,
      mediaId: mediaRecord.id,
      timeEntryId: activeEntry?.id || null,
      photoType: selectedPhotoType,
      workDate: new Date().toISOString().split('T')[0]
    });

    showToast('File uploaded!', 'success');
    await refreshTodayPhotos();
  } catch (err) {
    showToast('Failed to upload file: ' + err.message, 'error');
  }
}

// =============================================
// HISTORY TAB
// =============================================
async function refreshHistory() {
  try {
    const periodDays = document.getElementById('historyPeriod').value;
    const statusFilter = document.getElementById('historyStatus').value;

    let dateFrom = null;
    const today = new Date().toISOString().split('T')[0];
    if (periodDays !== 'all') {
      const d = new Date();
      d.setDate(d.getDate() - parseInt(periodDays));
      dateFrom = d.toISOString().split('T')[0];
    }

    const isPaid = statusFilter === 'paid' ? true : (statusFilter === 'unpaid' ? false : undefined);
    const days = await hoursService.getHistory(profile.id, { dateFrom, isPaid });

    // Load schedule data for the same period to build weekly comparison
    const scheduleRows = await hoursService.getSchedule(profile.id, dateFrom, today);

    const container = document.getElementById('historyList');
    if (!days.length && !scheduleRows.length) {
      container.innerHTML = `<div class="history-empty">
        <div class="he-icon">📋</div>
        <div class="he-text">No entries found</div>
        <div class="he-sub">Try adjusting your filters or clock in to start tracking</div>
      </div>`;
      return;
    }

    // Compute period totals
    let periodMins = 0, periodAmt = 0, periodDayCount = days.length;
    for (const day of days) {
      periodMins += day.totalMinutes;
      periodAmt += day.totalAmount;
    }

    const summaryHtml = `<div class="history-summary">
      <div><div class="hs-val">${periodDayCount}</div><div class="hs-lbl">Days</div></div>
      <div><div class="hs-val">${HoursService.formatHoursDecimal(periodMins)}h</div><div class="hs-lbl">Total Hours</div></div>
      <div><div class="hs-val">${HoursService.formatCurrency(periodAmt)}</div><div class="hs-lbl">Total Earned</div></div>
    </div>`;

    // Build schedule vs actuals weekly comparison
    let scheduleComparisonHtml = '';
    if (scheduleRows.length > 0) {
      // Build actuals by date from the history days
      const actualsByDate = {};
      for (const day of days) {
        actualsByDate[day.date] = day.totalMinutes;
      }

      // Group schedule rows + actuals into Sun-Sat weeks
      const allDates = new Set([
        ...scheduleRows.map(r => r.schedule_date),
        ...days.map(d => d.date)
      ]);
      const weekMap = {};
      for (const date of allDates) {
        const sun = getWeekSunday(date);
        if (!weekMap[sun]) weekMap[sun] = { sunday: sun, scheduledMins: 0, actualMins: 0, mods: 0 };
      }
      for (const row of scheduleRows) {
        const sun = getWeekSunday(row.schedule_date);
        if (!weekMap[sun]) weekMap[sun] = { sunday: sun, scheduledMins: 0, actualMins: 0, mods: 0 };
        weekMap[sun].scheduledMins += row.scheduled_minutes;
        weekMap[sun].mods += row.modification_count;
      }
      for (const day of days) {
        const sun = getWeekSunday(day.date);
        if (!weekMap[sun]) weekMap[sun] = { sunday: sun, scheduledMins: 0, actualMins: 0, mods: 0 };
        weekMap[sun].actualMins += day.totalMinutes;
      }

      // Sort weeks most recent first, only show weeks that have schedule data
      const weeks = Object.values(weekMap)
        .filter(w => w.scheduledMins > 0)
        .sort((a, b) => b.sunday.localeCompare(a.sunday));

      if (weeks.length > 0) {
        const weeksHtml = weeks.map(w => {
          const sunDate = new Date(w.sunday + 'T12:00:00');
          const satDate = new Date(sunDate);
          satDate.setDate(sunDate.getDate() + 6);
          const sunLabel = sunDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const satLabel = satDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

          const schedH = HoursService.formatHoursDecimal(w.scheduledMins);
          const actualH = HoursService.formatHoursDecimal(w.actualMins);
          const deltaMins = w.actualMins - w.scheduledMins;
          const deltaH = HoursService.formatHoursDecimal(Math.abs(deltaMins));
          const deltaSign = deltaMins > 0 ? '+' : (deltaMins < 0 ? '-' : '');
          const deltaClass = deltaMins > 0 ? 'positive' : (deltaMins < 0 ? 'negative' : 'zero');
          const modsLabel = w.mods > 0 ? `<span class="hsb-mods">${w.mods} change${w.mods !== 1 ? 's' : ''}</span>` : '';

          return `<div class="hsb-week">
            <div class="hsb-week-label">${sunLabel} – ${satLabel}${modsLabel}<span class="hsb-dates">Sun – Sat</span></div>
            <div class="hsb-week-stats">
              <div class="hsb-stat sched"><span class="hsb-num">${schedH}h</span><span class="hsb-lbl">Sched</span></div>
              <div class="hsb-stat actual"><span class="hsb-num">${actualH}h</span><span class="hsb-lbl">Actual</span></div>
              <div class="hsb-stat delta"><span class="hsb-num ${deltaClass}">${deltaSign}${deltaH}h</span><span class="hsb-lbl">Delta</span></div>
            </div>
          </div>`;
        }).join('');

        scheduleComparisonHtml = `<div class="history-schedule-bar">
          <h4>Schedule vs Actual</h4>
          <div class="hsb-weeks">${weeksHtml}</div>
        </div>`;
      }
    }

    const daysHtml = days.map(day => {
      const badgeClass = day.hasPaid && day.hasUnpaid ? 'mixed' : (day.hasPaid ? 'paid' : 'unpaid');
      const badgeText = day.hasPaid && day.hasUnpaid ? 'Partial' : (day.hasPaid ? 'Paid' : 'Pending');

      const entriesHtml = day.entries.map(e => {
        const ci = HoursService.formatTime(e.clock_in);
        const co = e.clock_out ? HoursService.formatTime(e.clock_out) : 'Active';
        const mins = parseFloat(e.duration_minutes) || 0;
        const dur = e.clock_out ? HoursService.formatDuration(mins) : '...';
        const earned = mins > 0 ? HoursService.formatCurrency((mins / 60) * parseFloat(e.hourly_rate)) : '';
        const desc = e.description ? `<div class="ed-desc" title="${escapeHtml(e.description)}">${escapeHtml(e.description)}</div>` : '';
        const paidClass = e.is_paid ? 'paid' : 'unpaid';
        const manualHtml = e.is_manual ? `<span class="manual-badge" title="${escapeHtml(e.manual_reason || 'Manual entry')}">Manual</span>` : '';
        const spaceHtml = e.space_id && spacesMap[e.space_id] ? `<div class="ed-desc">${escapeHtml(spacesMap[e.space_id])}</div>` : '';
        const editBtnHtml = (e.clock_out && !e.is_paid) ? `<button class="entry-edit-btn" onclick="window._openEditModal('${e.id}')" title="Edit entry">${PENCIL_ICON}</button>` : '';

        return `<div class="history-entry">
          <div class="entry-time-block">
            <span class="etb-in">${ci}</span>
            <span class="etb-divider">▾</span>
            <span class="etb-out">${co}</span>
          </div>
          <div class="entry-detail">
            <div class="ed-duration">${dur}${manualHtml}${editBtnHtml}</div>
            ${desc}
            ${spaceHtml}
          </div>
          ${earned ? `<div class="entry-earned">${earned}</div>` : ''}
          <div class="entry-paid-dot ${paidClass}" title="${e.is_paid ? 'Paid' : 'Payment pending'}"></div>
        </div>`;
      }).join('');

      return `<div class="day-group">
        <div class="day-header">
          <div>
            <span class="day-date">${HoursService.formatDate(day.date)}</span>
            <span class="day-badge ${badgeClass}">${badgeText}</span>
          </div>
          <div class="day-totals">
            <div class="day-hours">${HoursService.formatDuration(day.totalMinutes)}</div>
            <div class="day-amount">${HoursService.formatCurrency(day.totalAmount)} earned</div>
          </div>
        </div>
        <div class="day-entries">${entriesHtml}</div>
      </div>`;
    }).join('');

    container.innerHTML = summaryHtml + scheduleComparisonHtml + daysHtml;
  } catch (err) {
    console.error('Failed to load history:', err);
    showToast('Failed to load history', 'error');
  }
}

// =============================================
// PAYMENT TAB
// =============================================
async function refreshPaymentTab() {
  try {
    // Refresh profile to get latest rate
    profile = await hoursService.getOrCreateProfile(authState.appUser.id, authState.appUser.role);

    document.getElementById('payRate').textContent = `${HoursService.formatCurrency(profile.hourly_rate)}/hr`;
    document.getElementById('payMethod').value = profile.payment_method || '';
    document.getElementById('payHandle').value = profile.payment_handle || '';

    // Toggle Stripe Connect section vs payHandle based on selected method
    toggleStripeConnectUI(profile.payment_method);

    const summary = await hoursService.getAssociateSummary(profile.id);
    document.getElementById('payTotal').textContent = HoursService.formatCurrency(summary.totalAmount);
    document.getElementById('payPaid').textContent = HoursService.formatCurrency(summary.paidAmount);
    document.getElementById('payUnpaid').textContent = HoursService.formatCurrency(summary.unpaidAmount);

    // Get unpaid entries for detailed breakdown + rate mismatch detection
    const unpaidEntries = await hoursService.getEntries(profile.id, { isPaid: false });
    renderUnpaidBreakdown(unpaidEntries);
    renderRateMismatchBanner(unpaidEntries);

    // Show/hide request payment button
    const requestBtn = document.getElementById('btnRequestPayment');
    const hasUnpaidCompleted = unpaidEntries.some(e => e.clock_out);
    requestBtn.style.display = hasUnpaidCompleted ? 'block' : 'none';

    // Show ID verification banner
    renderIdVerificationBanner(profile.identity_verification_status);
  } catch (err) {
    console.error('Failed to refresh payment tab:', err);
  }
}

// =============================================
// UNPAID BREAKDOWN & RATE MISMATCH
// =============================================
function renderUnpaidBreakdown(unpaidEntries) {
  const container = document.getElementById('unpaidDetails');
  if (!container) return;

  const completedEntries = unpaidEntries.filter(e => e.clock_out);
  if (!completedEntries.length) {
    container.style.display = 'none';
    return;
  }

  // Group by rate to show breakdown
  const byRate = {};
  for (const e of completedEntries) {
    const rate = parseFloat(e.hourly_rate) || 0;
    const key = rate.toFixed(2);
    if (!byRate[key]) byRate[key] = { rate, totalMins: 0, totalAmt: 0, count: 0 };
    const mins = parseFloat(e.duration_minutes) || 0;
    byRate[key].totalMins += mins;
    byRate[key].totalAmt += (mins / 60) * rate;
    byRate[key].count++;
  }

  const groups = Object.values(byRate).sort((a, b) => b.rate - a.rate);
  const currentRate = parseFloat(profile.hourly_rate) || 0;

  // Only show breakdown if there are entries at different rates, or entries at $0
  const hasZeroRate = groups.some(g => g.rate === 0);
  const hasMultipleRates = groups.length > 1;
  if (!hasZeroRate && !hasMultipleRates) {
    container.style.display = 'none';
    return;
  }

  let totalUnpaidMins = 0;
  let totalAtCurrentRate = 0;
  for (const e of completedEntries) {
    const mins = parseFloat(e.duration_minutes) || 0;
    totalUnpaidMins += mins;
    totalAtCurrentRate += (mins / 60) * currentRate;
  }

  let html = '<div class="unpaid-breakdown">';
  html += '<div style="font-weight:600;margin-bottom:0.35rem;color:#334155;">Unpaid Hours Breakdown</div>';

  for (const g of groups) {
    const hoursLabel = HoursService.formatDuration(g.totalMins);
    const rateLabel = g.rate === 0 ? '$0/hr' : `${HoursService.formatCurrency(g.rate)}/hr`;
    const amtClass = g.rate === 0 ? 'zero' : 'positive';
    const amtLabel = HoursService.formatCurrency(g.totalAmt);
    html += `<div class="ub-row">
      <span><span class="ub-hours">${hoursLabel}</span> at ${rateLabel} (${g.count} ${g.count === 1 ? 'entry' : 'entries'})</span>
      <span class="ub-amount ${amtClass}">${amtLabel}</span>
    </div>`;
  }

  if (hasZeroRate && currentRate > 0) {
    html += `<div class="ub-note">Some entries were logged at $0/hr before your rate was set. At your current rate of ${HoursService.formatCurrency(currentRate)}/hr, these hours would be worth ${HoursService.formatCurrency(totalAtCurrentRate)}. Use "Request Payment" below to ask admin to update.</div>`;
  }

  html += '</div>';
  container.innerHTML = html;
  container.style.display = 'block';
}

function renderRateMismatchBanner(unpaidEntries) {
  const banner = document.getElementById('rateMismatchBanner');
  if (!banner) return;

  const currentRate = parseFloat(profile.hourly_rate) || 0;
  const completedEntries = unpaidEntries.filter(e => e.clock_out);

  // Find entries where the recorded rate differs from current rate
  const mismatchedEntries = completedEntries.filter(e => {
    const entryRate = parseFloat(e.hourly_rate) || 0;
    return Math.abs(entryRate - currentRate) > 0.001;
  });

  if (mismatchedEntries.length === 0) {
    banner.style.display = 'none';
    return;
  }

  let mismatchMins = 0;
  let recordedAmt = 0;
  let correctedAmt = 0;
  for (const e of mismatchedEntries) {
    const mins = parseFloat(e.duration_minutes) || 0;
    mismatchMins += mins;
    recordedAmt += (mins / 60) * (parseFloat(e.hourly_rate) || 0);
    correctedAmt += (mins / 60) * currentRate;
  }

  const diff = correctedAmt - recordedAmt;
  const hoursLabel = HoursService.formatHoursDecimal(mismatchMins);

  banner.style.display = 'block';
  banner.innerHTML = `<div class="rate-mismatch-banner">
    <strong>Rate Update Needed</strong>
    ${mismatchedEntries.length} time ${mismatchedEntries.length === 1 ? 'entry' : 'entries'} (${hoursLabel}h) ${mismatchedEntries.length === 1 ? 'was' : 'were'} recorded at a different hourly rate than your current rate of ${HoursService.formatCurrency(currentRate)}/hr.
    <div class="mismatch-detail">
      Currently showing: ${HoursService.formatCurrency(recordedAmt)} &rarr; Should be: ${HoursService.formatCurrency(correctedAmt)} (${diff >= 0 ? '+' : ''}${HoursService.formatCurrency(diff)})
    </div>
    <div class="mismatch-detail">Tap "Request Payment" to notify your admin to correct this.</div>
  </div>`;
}

// =============================================
// REQUEST PAYMENT
// =============================================
async function handleRequestPayment() {
  const btn = document.getElementById('btnRequestPayment');
  btn.disabled = true;
  btn.textContent = 'Sending request...';

  try {
    // Get unpaid summary for the request
    const unpaidSummary = await hoursService.getUnpaidSummary(profile.id);
    if (unpaidSummary.count === 0 || unpaidSummary.totalMinutes === 0) {
      showToast('No unpaid hours to request payment for', 'info');
      return;
    }

    const currentRate = parseFloat(profile.hourly_rate) || 0;
    const name = `${authState.appUser.first_name || ''} ${authState.appUser.last_name || ''}`.trim()
      || authState.appUser.display_name
      || authState.appUser.email;

    // Check for rate-mismatched entries
    const mismatchedEntries = unpaidSummary.entries.filter(e => {
      const entryRate = parseFloat(e.hourly_rate) || 0;
      return e.clock_out && Math.abs(entryRate - currentRate) > 0.001;
    });

    let correctedTotal = 0;
    for (const e of unpaidSummary.entries) {
      if (!e.clock_out) continue;
      const mins = parseFloat(e.duration_minutes) || 0;
      correctedTotal += (mins / 60) * currentRate;
    }

    // Send email to admin
    const { sendEmail } = await import('../shared/email-service.js');
    const adminEmail = 'team@YOUR_DOMAIN';

    const hasRateMismatch = mismatchedEntries.length > 0;
    const subject = `Payment Request from ${name}` + (hasRateMismatch ? ' (Rate Update Needed)' : '');

    // Build a simple HTML body for the email
    let body = `<p><strong>${escapeHtml(name)}</strong> is requesting payment for their logged hours.</p>`;
    body += `<table style="border-collapse:collapse;width:100%;margin:12px 0;">`;
    body += `<tr><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:600;">Unpaid Hours</td><td style="padding:6px 12px;border:1px solid #e5e7eb;">${HoursService.formatHoursDecimal(unpaidSummary.totalMinutes)}h</td></tr>`;
    body += `<tr><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:600;">Current Rate</td><td style="padding:6px 12px;border:1px solid #e5e7eb;">${HoursService.formatCurrency(currentRate)}/hr</td></tr>`;
    body += `<tr><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:600;">Recorded Total</td><td style="padding:6px 12px;border:1px solid #e5e7eb;">${HoursService.formatCurrency(unpaidSummary.totalAmount)}</td></tr>`;
    if (hasRateMismatch) {
      body += `<tr><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:600;color:#dc2626;">Corrected Total (at current rate)</td><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:700;color:#dc2626;">${HoursService.formatCurrency(correctedTotal)}</td></tr>`;
      body += `<tr><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:600;color:#92400e;">Entries Needing Rate Update</td><td style="padding:6px 12px;border:1px solid #e5e7eb;">${mismatchedEntries.length} entries</td></tr>`;
    }
    body += `</table>`;
    if (hasRateMismatch) {
      body += `<p style="color:#92400e;"><strong>Action needed:</strong> Some entries were recorded at the wrong rate. Go to <a href="https://YOUR_DOMAIN/spaces/admin/worktracking.html">Admin Hours</a>, filter by ${escapeHtml(name)}, select all unpaid entries, and click "Recalc" to update them to the current rate. Then "Mark Selected as Paid" to process payment.</p>`;
    } else {
      body += `<p>Go to <a href="https://YOUR_DOMAIN/spaces/admin/worktracking.html">Admin Hours</a> to review and process payment.</p>`;
    }

    const result = await sendEmail('custom', adminEmail, {
      subject,
      html: body,
    });

    if (result.success) {
      showToast('Payment request sent to admin!', 'success');
    } else {
      showToast('Failed to send request: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    console.error('Failed to request payment:', err);
    showToast('Failed to send payment request: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Request Payment';
  }
}

function renderIdVerificationBanner(status) {
  const banner = document.getElementById('idVerificationBanner');
  if (!banner) return;

  if (status === 'verified') {
    banner.style.display = 'block';
    banner.innerHTML = `<div class="id-banner ok"><strong>Identity Verified</strong>Your ID has been verified. You're all set to receive payments.</div>`;
    return;
  }

  if (status === 'link_sent') {
    banner.style.display = 'block';
    banner.innerHTML = `<div class="id-banner info"><strong>ID Verification Pending</strong>A verification link has been sent. Complete it to receive payments.<button class="btn-verify" id="btnVerifyId">Verify My ID</button></div>`;
    document.getElementById('btnVerifyId')?.addEventListener('click', handleSelfVerify);
    return;
  }

  if (status === 'flagged') {
    banner.style.display = 'block';
    banner.innerHTML = `<div class="id-banner info"><strong>ID Under Review</strong>Your ID is being reviewed by our team. We'll update you shortly.</div>`;
    return;
  }

  if (status === 'rejected') {
    banner.style.display = 'block';
    banner.innerHTML = `<div class="id-banner error"><strong>ID Verification Issue</strong>There was an issue with your ID. Please upload a new one.<button class="btn-verify" id="btnVerifyId">Upload New ID</button></div>`;
    document.getElementById('btnVerifyId')?.addEventListener('click', handleSelfVerify);
    return;
  }

  // pending or null — not yet requested
  banner.style.display = 'block';
  banner.innerHTML = `<div class="id-banner warn"><strong>ID Verification Required</strong>Upload your driver's license or state ID to receive payments.<button class="btn-verify" id="btnVerifyId">Verify My ID</button></div>`;
  document.getElementById('btnVerifyId')?.addEventListener('click', handleSelfVerify);
}

async function handleSelfVerify() {
  const btn = document.getElementById('btnVerifyId');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating link...'; }
  try {
    const { uploadUrl } = await identityService.requestAssociateVerification(authState.appUser.id, 'self', authState.appUser.person_id);
    window.location.href = uploadUrl;
  } catch (err) {
    showToast('Failed to start verification: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Verify My ID'; }
  }
}

async function savePaymentPref() {
  const method = document.getElementById('payMethod').value || null;
  const handle = document.getElementById('payHandle').value.trim() || null;

  try {
    await hoursService.updateProfile(profile.id, { payment_method: method, payment_handle: handle });
    profile.payment_method = method;
    profile.payment_handle = handle;
    showToast('Payment preference saved!', 'success');
  } catch (err) {
    showToast('Failed to save: ' + err.message, 'error');
  }
}

// =============================================
// STRIPE CONNECT
// =============================================

/**
 * Show/hide the Stripe Connect section vs payHandle input based on selected payment method
 */
function toggleStripeConnectUI(method) {
  const stripeSection = document.getElementById('stripeConnectSection');
  const payHandleRow = document.getElementById('payHandleRow');

  if (method === 'stripe') {
    if (stripeSection) stripeSection.style.display = 'block';
    if (payHandleRow) payHandleRow.style.display = 'none';
    updateStripeConnectStatus();
  } else {
    if (stripeSection) stripeSection.style.display = 'none';
    if (payHandleRow) payHandleRow.style.display = 'block';
  }
}

/**
 * Update the Stripe Connect status display based on profile data
 */
function updateStripeConnectStatus() {
  const statusEl = document.getElementById('stripeConnectStatus');
  const connectBtn = document.getElementById('btnStripeConnect');
  if (!statusEl || !connectBtn) return;

  const connectId = profile?.stripe_connect_account_id;
  if (connectId) {
    statusEl.innerHTML = '<span style="color:#16a34a;font-weight:600;">Connected</span> — Your Stripe account is linked and ready to receive payouts.';
    connectBtn.textContent = 'Manage Stripe Account';
  } else {
    statusEl.innerHTML = '<span style="color:#92400e;font-weight:600;">Not connected</span> — Connect your bank account via Stripe to receive ACH payouts with low fees.';
    connectBtn.textContent = 'Connect with Stripe';
  }
}

/**
 * Handle Stripe Connect button click — create account if needed, then redirect to onboarding
 */
async function handleStripeConnect() {
  const btn = document.getElementById('btnStripeConnect');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Setting up...';

  try {
    // Step 1: Create Connect account if needed
    const createResult = await payoutService.createStripeConnectAccount(profile.id);
    if (!createResult.success) {
      showToast('Failed to create Stripe account: ' + createResult.error, 'error');
      return;
    }

    // Step 2: Get onboarding link
    const linkResult = await payoutService.getStripeConnectLink(profile.id);
    if (!linkResult.success) {
      showToast('Failed to generate onboarding link: ' + linkResult.error, 'error');
      return;
    }

    // Step 3: Redirect to Stripe onboarding
    window.location.href = linkResult.url;
  } catch (err) {
    showToast('Stripe Connect setup failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = profile?.stripe_connect_account_id ? 'Manage Stripe Account' : 'Connect with Stripe';
  }
}

// =============================================
// EVENT LISTENERS
// =============================================
function setupEventListeners() {
  // Tab switching (ARIA + keyboard nav + click handling via tab-utils)
  const workTabsContainer = document.getElementById('workTabs');
  if (workTabsContainer) {
    initTabList(workTabsContainer, {
      tabSelector: 'button',
      panelForTab: (btn) => {
        const tabId = `tab${btn.dataset.tab.charAt(0).toUpperCase() + btn.dataset.tab.slice(1)}`;
        return document.getElementById(tabId);
      },
      onSwitch: (btn) => {
        if (btn?.dataset?.tab === 'history') refreshHistory();
        else if (btn?.dataset?.tab === 'tasks') refreshTasksList();
        else if (btn?.dataset?.tab === 'coworkers') refreshCoworkers();
        else if (btn?.dataset?.tab === 'payment') refreshPaymentTab();
      },
      fade: true,
    });
  }

  // Clock out prompt
  document.getElementById('btnClockoutSubmit').addEventListener('click', () => {
    handleClockOut(document.getElementById('clockoutDesc').value.trim());
  });
  document.getElementById('btnClockoutSkip').addEventListener('click', () => {
    handleClockOut(null);
  });

  // Photo type selector
  document.querySelectorAll('[data-photo-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-photo-type]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPhotoType = btn.dataset.photoType;
    });
  });

  // Photo upload — Take Photo (camera) — label triggers input natively
  document.getElementById('cameraInput').addEventListener('change', (e) => {
    if (e.target.files[0]) handlePhotoUpload(e.target.files[0]);
    e.target.value = '';
  });

  // File upload — Upload File (gallery / files) — label triggers input natively
  document.getElementById('fileInput').addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      handleFileUpload(file);
    }
    e.target.value = '';
  });

  // History filters
  document.getElementById('historyPeriod').addEventListener('change', refreshHistory);
  document.getElementById('historyStatus').addEventListener('change', refreshHistory);

  // Save payment preference
  document.getElementById('btnSavePref').addEventListener('click', savePaymentPref);

  // Request payment
  document.getElementById('btnRequestPayment').addEventListener('click', handleRequestPayment);

  // Payment method change — toggle Stripe Connect section vs payHandle
  document.getElementById('payMethod').addEventListener('change', (e) => {
    toggleStripeConnectUI(e.target.value);
  });

  // Stripe Connect button
  document.getElementById('btnStripeConnect')?.addEventListener('click', handleStripeConnect);

  // Edit entry modal
  document.getElementById('btnEditClose').addEventListener('click', closeEditModal);
  document.getElementById('editEntryModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeEditModal();
  });
  document.getElementById('btnEditSubmit').addEventListener('click', handleEditSubmit);
  document.getElementById('editClockIn').addEventListener('input', computeEditDuration);
  document.getElementById('editClockOut').addEventListener('input', computeEditDuration);

  // Manual entry modal
  document.getElementById('btnManualEntry').addEventListener('click', openManualModal);
  document.getElementById('btnManualClose').addEventListener('click', closeManualModal);
  document.getElementById('manualEntryModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeManualModal();
  });
  document.getElementById('btnManualSubmit').addEventListener('click', handleManualSubmit);

  // Scheduling — lazy load on first open
  document.getElementById('scheduleDetails').addEventListener('toggle', (e) => {
    if (e.target.open && !scheduleLoaded) loadSchedule();
  });
  document.getElementById('btnSaveSchedule').addEventListener('click', saveSchedule);

  // Live duration computation
  const computeDuration = () => {
    const date = document.getElementById('manualDate').value;
    const ci = document.getElementById('manualClockIn').value;
    const co = document.getElementById('manualClockOut').value;
    const durEl = document.getElementById('manualDuration');
    if (!ci || !co) { durEl.textContent = '—'; return; }
    const ciDate = new Date(`${date || new Date().toISOString().split('T')[0]}T${ci}`);
    const coDate = new Date(`${date || new Date().toISOString().split('T')[0]}T${co}`);
    const diffMs = coDate - ciDate;
    if (diffMs <= 0) { durEl.textContent = 'Invalid (out must be after in)'; durEl.style.color = '#ef4444'; return; }
    const mins = Math.round(diffMs / 60000);
    const earned = (mins / 60) * parseFloat(profile.hourly_rate || 0);
    durEl.style.color = '#0f766e';
    durEl.textContent = `${HoursService.formatDuration(mins)} — ${HoursService.formatCurrency(earned)}`;
  };
  document.getElementById('manualClockIn').addEventListener('input', computeDuration);
  document.getElementById('manualClockOut').addEventListener('input', computeDuration);
}

// =============================================
// MANUAL ENTRY
// =============================================
function openManualModal() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('manualDate').value = today;
  document.getElementById('manualClockIn').value = '';
  document.getElementById('manualClockOut').value = '';
  document.getElementById('manualDesc').value = '';
  document.getElementById('manualReason').value = '';
  document.getElementById('manualDuration').textContent = '—';
  document.getElementById('manualEntryModal').classList.add('visible');
}

function closeManualModal() {
  document.getElementById('manualEntryModal').classList.remove('visible');
}

async function handleManualSubmit() {
  const date = document.getElementById('manualDate').value;
  const clockIn = document.getElementById('manualClockIn').value;
  const clockOut = document.getElementById('manualClockOut').value;
  const description = document.getElementById('manualDesc').value.trim();
  const manualReason = document.getElementById('manualReason').value.trim();

  if (!date || !clockIn || !clockOut) {
    showToast('Please fill in date, clock in, and clock out times', 'error');
    return;
  }
  if (!document.getElementById('spaceSelector').value) {
    showToast('Please select a space', 'error');
    return;
  }
  if (!manualReason) {
    showToast('Please provide a reason for the manual entry', 'error');
    return;
  }

  const ciDateTime = `${date}T${clockIn}`;
  const coDateTime = `${date}T${clockOut}`;
  if (new Date(coDateTime) <= new Date(ciDateTime)) {
    showToast('Clock out must be after clock in', 'error');
    return;
  }

  const btn = document.getElementById('btnManualSubmit');
  btn.disabled = true;
  btn.textContent = 'Adding...';

  try {
    await hoursService.createManualEntry(profile.id, {
      clockIn: ciDateTime,
      clockOut: coDateTime,
      description: description || null,
      manualReason,
      hourlyRate: profile.hourly_rate,
      spaceId: getSelectedSpaceId(),
      taskId: getSelectedTaskId()
    });
    showToast('Manual entry added!', 'success');
    closeManualModal();
    await Promise.all([refreshToday(), refreshHistory()]);
  } catch (err) {
    showToast('Failed to add entry: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add Entry';
  }
}

// =============================================
// EDIT ENTRY
// =============================================
async function openEditModal(entryId) {
  // Fetch the entry from today's or history entries
  const { data: entry, error } = await supabase
    .from('time_entries')
    .select('*')
    .eq('id', entryId)
    .single();

  if (error || !entry) {
    showToast('Failed to load entry', 'error');
    return;
  }

  // Don't allow editing paid entries
  if (entry.is_paid) {
    showToast('Paid entries cannot be edited', 'error');
    return;
  }

  // Don't allow editing active (clocked-in) entries
  if (!entry.clock_out) {
    showToast('Clock out first before editing', 'error');
    return;
  }

  editingEntryId = entryId;
  editingEntryOriginal = { ...entry };

  // Capture old values for email notification
  const ciOld = new Date(entry.clock_in);
  const coOld = new Date(entry.clock_out);
  const oldMins = parseFloat(entry.duration_minutes) || 0;
  editingOldValues = {
    clock_in: ciOld.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
    clock_out: coOld.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
    duration: HoursService.formatDuration(oldMins),
    space_id: entry.space_id,
    description: entry.description,
  };

  // Populate space dropdown
  const editSpace = document.getElementById('editSpace');
  let opts = '<option value="">No space</option>';
  for (const [id, name] of Object.entries(spacesMap)) {
    opts += `<option value="${id}"${id === entry.space_id ? ' selected' : ''}>${escapeHtml(name)}</option>`;
  }
  editSpace.innerHTML = opts;

  // Populate fields
  const ciDate = new Date(entry.clock_in);
  const coDate = new Date(entry.clock_out);
  document.getElementById('editDate').value = ciDate.toISOString().split('T')[0];
  document.getElementById('editClockIn').value = ciDate.toTimeString().slice(0, 5);
  document.getElementById('editClockOut').value = coDate.toTimeString().slice(0, 5);
  document.getElementById('editDesc').value = entry.description || '';

  // Compute duration display
  computeEditDuration();

  document.getElementById('editEntryModal').classList.add('visible');
}

function closeEditModal() {
  document.getElementById('editEntryModal').classList.remove('visible');
  editingEntryId = null;
  editingEntryOriginal = null;
}

function computeEditDuration() {
  const date = document.getElementById('editDate').value;
  const ci = document.getElementById('editClockIn').value;
  const co = document.getElementById('editClockOut').value;
  const durEl = document.getElementById('editDuration');
  if (!ci || !co) { durEl.textContent = '—'; return; }
  const ciDate = new Date(`${date || new Date().toISOString().split('T')[0]}T${ci}`);
  const coDate = new Date(`${date || new Date().toISOString().split('T')[0]}T${co}`);
  const diffMs = coDate - ciDate;
  if (diffMs <= 0) { durEl.textContent = 'Invalid (out must be after in)'; durEl.style.color = '#ef4444'; return; }
  const mins = Math.round(diffMs / 60000);
  const earned = (mins / 60) * parseFloat(profile.hourly_rate || 0);
  durEl.style.color = '#0f766e';
  durEl.textContent = `${HoursService.formatDuration(mins)} — ${HoursService.formatCurrency(earned)}`;
}

async function handleEditSubmit() {
  if (!editingEntryId || !editingEntryOriginal) return;

  const date = document.getElementById('editDate').value;
  const clockIn = document.getElementById('editClockIn').value;
  const clockOut = document.getElementById('editClockOut').value;
  const description = document.getElementById('editDesc').value.trim();
  const spaceId = document.getElementById('editSpace').value || null;

  if (!date || !clockIn || !clockOut) {
    showToast('Please fill in date, clock in, and clock out times', 'error');
    return;
  }

  const ciDateTime = `${date}T${clockIn}`;
  const coDateTime = `${date}T${clockOut}`;
  const newCi = new Date(ciDateTime);
  const newCo = new Date(coDateTime);
  if (newCo <= newCi) {
    showToast('Clock out must be after clock in', 'error');
    return;
  }

  const btn = document.getElementById('btnEditSubmit');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const newDurationMins = Math.round((newCo - newCi) / 60000);
    const oldDurationMins = parseFloat(editingEntryOriginal.duration_minutes) || 0;
    const addedMinutes = newDurationMins - oldDurationMins;

    // If edit adds more than 10 hours, require admin approval
    if (addedMinutes > 600) {
      await hoursService.createEditRequest(
        editingEntryId,
        authState.appUser.id,
        { clock_in: newCi.toISOString(), clock_out: newCo.toISOString(), description: description || null, space_id: spaceId },
        { clock_in: editingEntryOriginal.clock_in, clock_out: editingEntryOriginal.clock_out, duration_minutes: oldDurationMins }
      );
      showToast('This edit adds over 10 hours — submitted for admin approval', 'info');
      closeEditModal();
      return;
    }

    // Build audit trail of what changed
    const changes = {};
    if (newCi.toISOString() !== new Date(editingEntryOriginal.clock_in).toISOString()) {
      changes.clock_in = { oldVal: editingEntryOriginal.clock_in, newVal: newCi.toISOString() };
    }
    if (newCo.toISOString() !== new Date(editingEntryOriginal.clock_out).toISOString()) {
      changes.clock_out = { oldVal: editingEntryOriginal.clock_out, newVal: newCo.toISOString() };
    }
    if ((description || '') !== (editingEntryOriginal.description || '')) {
      changes.description = { oldVal: editingEntryOriginal.description, newVal: description || null };
    }
    if ((spaceId || null) !== (editingEntryOriginal.space_id || null)) {
      changes.space_id = { oldVal: editingEntryOriginal.space_id, newVal: spaceId };
    }

    await hoursService.updateEntry(editingEntryId, {
      clock_in: newCi.toISOString(),
      clock_out: newCo.toISOString(),
      description: description || null,
      space_id: spaceId
    });

    // Log audit trail
    if (Object.keys(changes).length > 0) {
      await hoursService.logEdit(editingEntryId, authState.appUser.id, changes);
    }

    showToast('Entry updated!', 'success');

    // Send email notification (fire-and-forget)
    if (editingOldValues) {
      const newCi = new Date(ciDateTime);
      const newCo = new Date(coDateTime);
      const newMins = Math.round((newCo - newCi) / 60000);
      const formatTime = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      const entryDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

      emailService.sendTimeEntryEdited({
        associate_email: authState.appUser.email,
        first_name: authState.appUser.first_name || authState.appUser.email,
        entry_date: entryDate,
        old_clock_in: editingOldValues.clock_in,
        old_clock_out: editingOldValues.clock_out,
        old_duration: editingOldValues.duration,
        new_clock_in: formatTime(newCi),
        new_clock_out: formatTime(newCo),
        new_duration: HoursService.formatDuration(newMins),
        description: description || null,
        space_name: spaceId && spacesMap[spaceId] ? spacesMap[spaceId] : null,
      }).catch(err => console.warn('Edit notification email failed:', err));
    }

    closeEditModal();
    await Promise.all([refreshToday(), refreshHistory()]);
  } catch (err) {
    showToast('Failed to update entry: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

// Make openEditModal available to onclick handlers in rendered HTML
window._openEditModal = openEditModal;

// =============================================
// SCHEDULING
// =============================================
function getScheduleDates() {
  const dates = [];
  const today = new Date();
  for (let i = 0; i < 10; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

async function loadSchedule() {
  if (!profile) return;
  try {
    const dates = getScheduleDates();
    scheduleData = await hoursService.getSchedule(profile.id, dates[0], dates[9]);

    // Load actuals for the same period
    const entries = await hoursService.getEntries(profile.id, { dateFrom: dates[0], dateTo: dates[9] });
    scheduleActuals = {};
    for (const e of entries) {
      if (!e.duration_minutes) continue;
      const date = new Date(e.clock_in).toLocaleDateString('en-CA', { timeZone: AUSTIN_TIMEZONE });
      scheduleActuals[date] = (scheduleActuals[date] || 0) + parseFloat(e.duration_minutes);
    }

    scheduleLoaded = true;
    renderSchedule();
  } catch (err) {
    console.error('Failed to load schedule:', err);
  }
}

/**
 * Get the Sunday that starts the week containing a given date string (YYYY-MM-DD).
 */
function getWeekSunday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - day);
  return d.toISOString().split('T')[0];
}

function renderSchedule() {
  const dates = getScheduleDates();
  const today = new Date().toISOString().split('T')[0];

  // Build lookup from existing schedule data
  const schedMap = {};
  let totalModifications = 0;
  for (const row of scheduleData) {
    schedMap[row.schedule_date] = row;
    totalModifications += row.modification_count;
  }

  // Compute totals
  let totalScheduledMins = 0;
  let totalActualMins = 0;
  for (const date of dates) {
    const sched = schedMap[date];
    if (sched) totalScheduledMins += sched.scheduled_minutes;
    totalActualMins += (scheduleActuals[date] || 0);
  }

  // Summary
  const summaryEl = document.getElementById('scheduleSummary');
  const pctRaw = totalScheduledMins > 0 ? Math.round((totalActualMins / totalScheduledMins) * 100) : 0;
  const pctClass = pctRaw >= 90 ? 'green' : (pctRaw >= 50 ? 'yellow' : 'red');
  const scheduledH = HoursService.formatHoursDecimal(totalScheduledMins);
  const actualH = HoursService.formatHoursDecimal(totalActualMins);

  let summaryHtml = `<span><span class="ss-val">${scheduledH}h</span> planned</span>`;
  summaryHtml += `<span><span class="ss-val">${actualH}h</span> worked</span>`;
  if (totalScheduledMins > 0) {
    summaryHtml += `<span class="ss-pct ${pctClass}">${pctRaw}%</span>`;
  }
  if (totalModifications > 0) {
    summaryHtml += `<span class="ss-mods">${totalModifications} modification${totalModifications !== 1 ? 's' : ''}</span>`;
  }
  summaryEl.innerHTML = summaryHtml;

  // Group dates into Sun-Sat weeks
  const weeks = [];
  let currentWeek = null;
  for (const date of dates) {
    const weekSun = getWeekSunday(date);
    if (!currentWeek || currentWeek.sunday !== weekSun) {
      currentWeek = { sunday: weekSun, dates: [], scheduledMins: 0, actualMins: 0, mods: 0 };
      weeks.push(currentWeek);
    }
    currentWeek.dates.push(date);
    const sched = schedMap[date];
    if (sched) {
      currentWeek.scheduledMins += sched.scheduled_minutes;
      currentWeek.mods += sched.modification_count;
    }
    currentWeek.actualMins += (scheduleActuals[date] || 0);
  }

  // Grid rows grouped by week
  const gridEl = document.getElementById('scheduleGrid');
  let html = '';

  for (const week of weeks) {
    // Week header
    const sunDate = new Date(week.sunday + 'T12:00:00');
    const satDate = new Date(sunDate);
    satDate.setDate(sunDate.getDate() + 6);
    const sunLabel = sunDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const satLabel = satDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const modsLabel = week.mods > 0 ? `${week.mods} change${week.mods !== 1 ? 's' : ''}` : '';
    html += `<div class="schedule-week-header">
      <span>Week of ${sunLabel} – ${satLabel}</span>
      <span>${modsLabel}</span>
    </div>`;

    // Day rows for this week
    for (const date of week.dates) {
      const sched = schedMap[date];
      const isToday = date === today;
      const dayLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const startVal = sched ? sched.start_time.slice(0, 5) : '';
      const endVal = sched ? sched.end_time.slice(0, 5) : '';
      const plannedMins = sched ? sched.scheduled_minutes : 0;
      const actualMins = scheduleActuals[date] || 0;
      const plannedLabel = plannedMins > 0 ? HoursService.formatDuration(plannedMins) : '';
      const actualLabel = actualMins > 0 ? HoursService.formatDuration(actualMins) : (plannedMins > 0 ? '0:00' : '');
      const actualClass = plannedMins > 0
        ? (actualMins >= plannedMins ? 'met' : (actualMins > 0 ? 'partial' : 'none'))
        : 'none';

      const hasVal = startVal || endVal;
      html += `<div class="schedule-row">
        <span class="sr-date${isToday ? ' today' : ''}">${dayLabel}</span>
        <input type="time" data-date="${date}" data-field="start" value="${startVal}">
        <span class="sr-arrow">&rarr;</span>
        <input type="time" data-date="${date}" data-field="end" value="${endVal}">
        <span class="sr-planned">${plannedLabel}</span>
        <span class="sr-actual ${actualClass}">${actualLabel}</span>
        <button type="button" class="sr-clear${hasVal ? ' has-value' : ''}" data-date="${date}" title="Clear day">&times;</button>
      </div>`;
    }

    // Week subtotal row
    if (week.scheduledMins > 0 || week.actualMins > 0) {
      html += `<div class="schedule-week-totals">
        <span class="swt-label">Week total:</span>
        <span class="swt-hours">${HoursService.formatDuration(week.scheduledMins)} planned</span>
        <span class="swt-hours">${HoursService.formatDuration(week.actualMins)} worked</span>
      </div>`;
    }
  }

  gridEl.innerHTML = html;

  // Clear button handlers
  gridEl.querySelectorAll('.sr-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      const date = btn.dataset.date;
      const startInput = gridEl.querySelector(`input[data-date="${date}"][data-field="start"]`);
      const endInput = gridEl.querySelector(`input[data-date="${date}"][data-field="end"]`);
      if (startInput) startInput.value = '';
      if (endInput) endInput.value = '';
      btn.classList.remove('has-value');
    });
  });
}

async function saveSchedule() {
  const btn = document.getElementById('btnSaveSchedule');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const dates = getScheduleDates();
    const rows = [];

    for (const date of dates) {
      const startInput = document.querySelector(`input[data-date="${date}"][data-field="start"]`);
      const endInput = document.querySelector(`input[data-date="${date}"][data-field="end"]`);
      const startTime = startInput?.value || '';
      const endTime = endInput?.value || '';

      if (startTime && endTime) {
        // Compute minutes
        const [sh, sm] = startTime.split(':').map(Number);
        const [eh, em] = endTime.split(':').map(Number);
        const scheduledMinutes = (eh * 60 + em) - (sh * 60 + sm);

        if (scheduledMinutes <= 0) {
          showToast(`Invalid times for ${HoursService.formatDate(date)} — end must be after start`, 'error');
          btn.disabled = false;
          btn.textContent = 'Save Schedule';
          return;
        }

        rows.push({
          schedule_date: date,
          start_time: startTime + ':00',
          end_time: endTime + ':00',
          scheduled_minutes: scheduledMinutes
        });
      } else {
        // Clear row
        rows.push({ schedule_date: date, start_time: '', end_time: '', scheduled_minutes: 0 });
      }
    }

    await hoursService.upsertSchedule(profile.id, rows);
    showToast('Schedule saved!', 'success');
    await loadSchedule();
  } catch (err) {
    showToast('Failed to save schedule: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Schedule';
  }
}

// =============================================
// TASKS TAB
// =============================================
const PRIORITY_LABELS = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
const PRIORITY_CLASSES = { 1: 'p1', 2: 'p2', 3: 'p3', 4: 'p4' };

async function refreshTasksList() {
  const container = document.getElementById('tasksList');
  if (!container) return;

  try {
    const userId = authState?.appUser?.id;
    // Fetch tasks assigned to this user + unassigned, sorted by priority
    const tasks = userId
      ? await projectService.getOpenTasksForUser(userId)
      : [];

    // Also fetch full task details (notes, priority, status) for a richer view
    const { data: fullTasks } = await supabase
      .from('tasks')
      .select('id, title, notes, description, priority, status, location_label, assigned_name, space:space_id(id, name)')
      .in('status', ['open', 'in_progress'])
      .or(`assigned_to.eq.${userId},assigned_to.is.null`)
      .order('priority', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });

    const taskList = fullTasks || [];

    if (taskList.length === 0) {
      container.innerHTML = `
        <div class="tasks-empty">
          <div class="te-icon">✅</div>
          <div class="te-text">No open tasks</div>
          <div class="te-sub">You're all caught up!</div>
        </div>`;
      return;
    }

    // Split into assigned-to-me vs unassigned
    const myTasks = taskList.filter(t => t.assigned_name);
    const unassigned = taskList.filter(t => !t.assigned_name);

    let html = '';

    if (myTasks.length > 0) {
      html += '<div class="tasks-section-label">Your Tasks</div>';
      html += myTasks.map(t => renderTaskCard(t)).join('');
    }

    if (unassigned.length > 0) {
      html += '<div class="tasks-section-label">Unassigned Tasks</div>';
      html += unassigned.map(t => renderTaskCard(t)).join('');
    }

    container.innerHTML = html;

    // Attach status toggle handlers
    container.querySelectorAll('.task-status-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const taskId = btn.dataset.taskId;
        const currentStatus = btn.dataset.status;
        const newStatus = currentStatus === 'open' ? 'in_progress' : currentStatus === 'in_progress' ? 'done' : 'open';

        btn.disabled = true;
        btn.textContent = 'Updating...';
        try {
          const { data: updated, error: err } = await supabase
            .from('tasks')
            .update({ status: newStatus, updated_at: new Date().toISOString(), ...(newStatus === 'done' ? { completed_at: new Date().toISOString() } : { completed_at: null }) })
            .eq('id', taskId)
            .select()
            .single();
          if (err) throw err;

          const statusLabels = { open: 'To Do', in_progress: 'In Progress', done: 'Done' };
          showToast(`Task marked as ${statusLabels[newStatus] || newStatus}`, 'success');

          // Refresh task selector and task list
          await Promise.all([loadTasksForSelector(), refreshTasksList()]);
        } catch (err) {
          showToast('Failed to update task: ' + err.message, 'error');
          btn.disabled = false;
          btn.textContent = currentStatus === 'open' ? 'Start' : currentStatus === 'in_progress' ? 'Complete' : 'Reopen';
        }
      });
    });
  } catch (err) {
    console.error('Failed to load tasks:', err);
    container.innerHTML = '<p style="color:var(--text-muted);text-align:center;font-size:0.85rem;">Failed to load tasks</p>';
  }
}

function renderTaskCard(task) {
  const priority = task.priority ? Number(task.priority) : null;
  const pClass = priority ? (PRIORITY_CLASSES[priority] || '') : '';
  const pLabel = priority ? (PRIORITY_LABELS[priority] || '') : '';
  const location = task.space?.name || task.location_label || '';
  const notes = task.notes || task.description || '';
  const status = task.status || 'open';

  const statusBtnLabel = status === 'open' ? 'Start' : status === 'in_progress' ? 'Complete' : 'Reopen';
  const statusBtnClass = status === 'in_progress' ? ' in-progress' : '';

  return `
    <div class="task-card priority-${priority || 0}">
      <div class="task-card-header">
        <div class="task-title">${escapeHtml(task.title)}</div>
        ${pLabel ? `<span class="task-priority-badge ${pClass}">${pLabel}</span>` : ''}
      </div>
      ${notes ? `<div class="task-notes">${escapeHtml(notes)}</div>` : ''}
      <div class="task-meta">
        ${location ? `<span>📍 ${escapeHtml(location)}</span>` : ''}
        ${status === 'in_progress' ? '<span>🔄 In Progress</span>' : ''}
      </div>
      <button class="task-status-btn${statusBtnClass}" data-task-id="${task.id}" data-status="${status}">${statusBtnLabel}</button>
    </div>`;
}

// =============================================
// COWORKERS TAB
// =============================================
async function refreshCoworkers() {
  const container = document.getElementById('coworkersList');
  try {
    const groups = await hoursService.getMyGroups(profile.id);

    if (!groups.length) {
      container.innerHTML = `<div class="cw-empty">
        <div class="cw-icon">👥</div>
        <div class="cw-text">No work group</div>
        <div class="cw-sub">Ask your admin to add you to a work group to see coworkers' schedules.</div>
      </div>`;
      return;
    }

    // Get current week Sun-Sat
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const dayOfWeek = today.getDay(); // 0=Sun
    const sunday = new Date(today);
    sunday.setDate(today.getDate() - dayOfWeek);
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);
    const sunStr = sunday.toISOString().split('T')[0];
    const satStr = saturday.toISOString().split('T')[0];

    // Build week date array
    const weekDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sunday);
      d.setDate(sunday.getDate() + i);
      weekDates.push(d.toISOString().split('T')[0]);
    }
    const dayAbbrevs = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let html = '';

    for (const group of groups) {
      const members = group.members || [];
      if (!members.length) continue;

      const associateIds = members.map(m => m.associate_id);

      // Fetch schedules and actuals for all members this week
      const [schedules, actuals] = await Promise.all([
        hoursService.getGroupSchedules(associateIds, sunStr, satStr),
        hoursService.getGroupActuals(associateIds, sunStr, satStr)
      ]);

      // Index schedules by associate_id → date
      const schedByAssoc = {};
      for (const s of schedules) {
        if (!schedByAssoc[s.associate_id]) schedByAssoc[s.associate_id] = {};
        schedByAssoc[s.associate_id][s.schedule_date] = s;
      }

      // Index actuals by associate_id → date (sum minutes)
      const actualsByAssoc = {};
      for (const a of actuals) {
        const date = new Date(a.clock_in).toLocaleDateString('en-CA', { timeZone: AUSTIN_TIMEZONE });
        if (!actualsByAssoc[a.associate_id]) actualsByAssoc[a.associate_id] = {};
        actualsByAssoc[a.associate_id][date] = (actualsByAssoc[a.associate_id][date] || 0) + parseFloat(a.duration_minutes);
      }

      html += `<div class="cw-group">`;
      html += `<div class="cw-group-name">${escapeHtml(group.name)}</div>`;

      for (const member of members) {
        const assocId = member.associate_id;
        const appUser = member.associate?.app_user;
        const fullName = `${appUser?.first_name || ''} ${appUser?.last_name || ''}`.trim();
        const name = fullName || appUser?.display_name || 'Unknown';
        const isYou = assocId === profile.id;
        const memberScheds = schedByAssoc[assocId] || {};
        const memberActuals = actualsByAssoc[assocId] || {};

        // Compute week totals
        let weekSchedMins = 0, weekActualMins = 0, weekMods = 0;
        for (const date of weekDates) {
          const sched = memberScheds[date];
          if (sched) { weekSchedMins += sched.scheduled_minutes; weekMods += sched.modification_count; }
          weekActualMins += (memberActuals[date] || 0);
        }

        const pctRaw = weekSchedMins > 0 ? Math.round((weekActualMins / weekSchedMins) * 100) : 0;
        const pctClass = weekSchedMins === 0 ? '' : (pctRaw >= 90 ? 'green' : (pctRaw >= 50 ? 'yellow' : 'red'));
        const schedH = HoursService.formatHoursDecimal(weekSchedMins);
        const actualH = HoursService.formatHoursDecimal(weekActualMins);

        // Day cells
        const daysHtml = weekDates.map((date, i) => {
          const sched = memberScheds[date];
          const actualMins = memberActuals[date] || 0;
          const schedMins = sched ? sched.scheduled_minutes : 0;
          const isToday = date === todayStr;

          let statusIcon = '';
          let dayClass = 'none';

          if (schedMins > 0) {
            if (actualMins >= schedMins) { dayClass = 'met'; statusIcon = '✓'; }
            else if (actualMins > 0) { dayClass = 'partial'; statusIcon = '◐'; }
            else {
              // Only mark as missed if the date is in the past
              if (date < todayStr) { dayClass = 'missed'; statusIcon = '✗'; }
              else { dayClass = 'none'; statusIcon = '◌'; }
            }
          }

          const hoursLabel = schedMins > 0 ? HoursService.formatDuration(schedMins) : '—';

          return `<div class="cw-day ${dayClass}${isToday ? ' today' : ''}">
            <span class="cw-d-label">${dayAbbrevs[i]}</span>
            <span class="cw-d-hours">${hoursLabel}</span>
            ${statusIcon ? `<span class="cw-d-status">${statusIcon}</span>` : ''}
          </div>`;
        }).join('');

        const modsHtml = weekMods > 0 ? `<div class="cw-mods">${weekMods} schedule change${weekMods !== 1 ? 's' : ''} this week</div>` : '';

        html += `<div class="cw-card">
          <div class="cw-card-header">
            <span class="cw-name${isYou ? ' is-you' : ''}">${escapeHtml(name)}${isYou ? ' (you)' : ''}</span>
            <div class="cw-week-stats">
              <span>${schedH}h sched</span>
              <span>${actualH}h actual</span>
              ${weekSchedMins > 0 ? `<span class="cw-pct ${pctClass}">${pctRaw}%</span>` : ''}
            </div>
          </div>
          <div class="cw-days">${daysHtml}</div>
          ${modsHtml}
        </div>`;
      }

      html += `</div>`;
    }

    container.innerHTML = html || `<div class="cw-empty">
      <div class="cw-icon">👥</div>
      <div class="cw-text">No coworkers in your group yet</div>
    </div>`;
  } catch (err) {
    console.error('Failed to load coworkers:', err);
    container.innerHTML = `<div class="cw-empty"><div class="cw-text">Failed to load coworkers</div></div>`;
  }
}

// =============================================
// TOAST (delegates to associate-shell.js)
// =============================================
function showToast(message, type = 'info', duration = 4000) {
  shellShowToast(message, type, duration);
}

// =============================================
// HELPERS
// =============================================
function switchToTab(tabName) {
  const tabsContainer = document.getElementById('workTabs');
  if (!tabsContainer) return;
  const btn = tabsContainer.querySelector(`[data-tab="${tabName}"]`);
  if (btn) btn.click();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
