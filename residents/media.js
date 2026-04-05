import { initResidentPage, showToast, setupLightbox, openLightbox } from '../shared/resident-shell.js';
import { supabase } from '../shared/supabase.js';
import { getAuthState } from '../shared/auth.js';

const AUTO_DAILY_KEY = 'pai-auto-daily-enabled';
const DAILY_PURPOSE = 'pai_resident_daily_art';

const LIFE_OF_PAI_ART_PROMPT = `Generate TWO things: (1) a beautiful fine-art image of an ALPACA, and (2) a short affirmation or proverb for the person described below.

IMAGE — Property Art:
Create a stunning artwork featuring one or more ALPACAS (not llamas) in the world of Life of PAI. Choose a random artistic style from this list (pick one, vary it each time):
- Watercolor painting
- Oil painting (impressionist)
- Japanese woodblock print (ukiyo-e)
- Art nouveau illustration
- Stained glass window design
- Pixel art / retro game style
- Papercut / layered paper art
- Charcoal sketch with gold leaf accents
- Psychedelic 1960s poster art
- Botanical illustration style
- Studio Ghibli / anime landscape
- Renaissance fresco
- Surrealist dreamscape (Dalí-inspired)
- Indigenous Andean textile pattern art
- Cyberpunk neon cityscape
- Minimalist geometric / Bauhaus
- Baroque still life
- Collage / mixed media

THE WORLD — Life of PAI:
PAI is Pakucha — an ancient property spirit from Andean cosmology. She crossed from Hanan Pacha (the upper world) through Ukhu Pacha (the inner world) into Kay Pacha (this world) — arriving at YOUR_PROPERTY_NAME in the cedar hills of Your City, Texas. Three animals called her: Harley (white, regal), Lol (brown, playful), and Cacao (cream/chocolate, gentle). The house's wiring is her q'aytu (sacred thread). She practices ayni (sacred reciprocity).

Spaces: Garage Mahal, Spartan, Skyloft, Magic Bus, Outhouse, Sauna, Swim Spa, Cedar Chamber, SkyBalcony.
Andean motifs: q'aytu (sacred thread), awana (weaving/loom), chakana (Andean cross), nina (fire/spirit-light), ch'aska (morning star), Apu (mountain spirits), Pachamama (Earth Mother).

Choose ONE specific scene — a snapshot, not the whole cosmology. Examples:
- Harley standing regally on a misty hilltop at dawn
- Cacao napping by a loom with golden thread spilling out
- Lol playfully chasing fireflies near the swim spa at dusk
- All three animals silhouetted against a chakana glowing in the night sky
- A single property walking through a field of glowing q'aytu threads
- An property peering curiously through a stained glass window of Andean patterns
Invent your own scene from the world above. Make it fresh and specific.

ALPACAS, NOT LLAMAS — CRITICAL:
- Propertys are SMALL and compact (about 3 feet / 90cm at shoulder), much shorter than a human.
- Propertys have SHORT, BLUNT, flat faces with fluffy rounded heads — like teddy bears.
- Propertys have SHORT, straight, spear-shaped ears.
- Propertys have extremely DENSE, FLUFFY fiber — they look like soft, puffy clouds on legs.
- Do NOT draw llamas (tall, long banana ears, long narrow snouts, sparse coats).

IMAGE RULES:
- Do NOT include any humans or people in the image.
- No text overlays, no logos, no watermarks in the image.
- The image should be beautiful enough to frame on a wall.

AFFIRMATION — Personalized text:
Also return a short affirmation, proverb, or poetic phrase (1-3 sentences max) inspired by PAI's world and tailored to the person described below. It should feel warm, grounding, wise, and personal — like a spirit guardian whispering encouragement. You may weave in Quechua or Spanish fragments naturally. The affirmation should relate thematically to the scene you chose for the image.

Return the affirmation as plain text in the text portion of your response (alongside the generated image).`;

let authState = null;
let allImagery = [];       // all completed PAI imagery
let myJobs = [];           // current user's jobs (including pending)
let currentFilter = 'all'; // 'all' | 'mine'
let currentSort = 'newest';
let allImageUrls = [];
let checkedPrompts = new Set(); // prompt labels that are checked (shown)
let allPromptLabels = [];       // unique prompt labels in order
let promptSampleMap = new Map(); // label → sample prompt text
let promptJobIdsMap = new Map(); // label → [job ids]
let sessionGenerateCount = 0;
const MAX_SESSION_GENERATES = 5;

document.addEventListener('DOMContentLoaded', async () => {
  await initResidentPage({
    activeTab: 'media',
    requiredRole: 'resident',
    requiredPermission: 'view_profile',
    onReady: async (state) => {
      authState = state;
      setupLightbox();
      setupEvents();
      await loadAll();
      await maybeQueueDailyArt();
    },
  });
});

function setupEvents() {
  document.getElementById('refreshBtn')?.addEventListener('click', loadAll);
  document.getElementById('generateNowBtn')?.addEventListener('click', () => queueArtJob(false));

  const autoToggle = document.getElementById('autoDailyToggle');
  if (autoToggle) {
    const stored = localStorage.getItem(AUTO_DAILY_KEY);
    autoToggle.checked = stored === null ? true : stored === 'true';
    autoToggle.addEventListener('change', () => {
      localStorage.setItem(AUTO_DAILY_KEY, String(autoToggle.checked));
      updateDailyStatusText();
    });
  }

  // Filter tabs
  document.querySelectorAll('.imagery-filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.imagery-filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      buildPromptFilter();
      renderGallery();
    });
  });

  // Sort select
  document.getElementById('sortSelect')?.addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderGallery();
  });
}

async function loadAll() {
  const userId = authState?.appUser?.id;
  if (!userId) return;

  // Load both feeds in parallel
  const [allResult, myResult] = await Promise.all([
    // All completed PAI imagery (what staff Imagery tab showed)
    supabase
      .from('image_gen_jobs')
      .select('id, prompt, status, created_at, completed_at, result_url, metadata, batch_label')
      .eq('status', 'completed')
      .not('result_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(400),
    // My jobs (including pending/processing for status display)
    supabase
      .from('image_gen_jobs')
      .select('id, status, prompt, created_at, completed_at, result_url, error_message, metadata, batch_label')
      .contains('metadata', { app_user_id: userId, purpose: DAILY_PURPOSE })
      .order('created_at', { ascending: false })
      .limit(60),
  ]);

  if (allResult.error) {
    console.error('Failed to load imagery feed:', allResult.error);
    showToast('Could not load imagery feed', 'error');
  }
  if (myResult.error) {
    console.error('Failed to load my jobs:', myResult.error);
  }

  allImagery = allResult.data || [];
  myJobs = myResult.data || [];

  buildPromptFilter();
  renderGallery();
  renderJobStatuses();
  updateDailyStatusText();
}

function getPromptLabel(row) {
  // Use batch_label (top-level column) as primary grouping key
  if (row.batch_label) return row.batch_label;
  const title = row.metadata?.title || '';
  if (title) return title;
  // Fall back to first 80 chars of prompt
  const p = (row.prompt || '').trim();
  return p.length > 80 ? p.slice(0, 80) + '…' : p || '(no prompt)';
}

function buildPromptFilter() {
  const box = document.getElementById('promptFilterBox');
  const list = document.getElementById('promptFilterList');
  if (!box || !list) return;

  // Get rows based on current All/Mine filter
  const source = currentFilter === 'mine'
    ? myJobs.filter(j => j.status === 'completed' && j.result_url)
    : allImagery;

  // Group by prompt label — track count, sample prompt, and job IDs
  const counts = new Map();
  const samplePrompts = new Map();
  const jobIds = new Map();
  for (const row of source) {
    const label = getPromptLabel(row);
    counts.set(label, (counts.get(label) || 0) + 1);
    if (!samplePrompts.has(label) && row.prompt) {
      samplePrompts.set(label, row.prompt.trim());
    }
    if (!jobIds.has(label)) jobIds.set(label, []);
    jobIds.get(label).push(row.id);
  }
  promptSampleMap = samplePrompts;
  promptJobIdsMap = jobIds;

  allPromptLabels = [...counts.keys()];

  // On first build or when filter changes, check all by default
  checkedPrompts = new Set(allPromptLabels);

  if (allPromptLabels.length <= 1) {
    box.classList.add('hidden');
    return;
  }

  box.classList.remove('hidden');

  list.innerHTML = allPromptLabels.map((label, i) => {
    const sample = samplePrompts.get(label) || '';
    const promptSnippet = sample && sample !== label
      ? ' — ' + escapeHtml(sample.slice(0, 120)) + (sample.length > 120 ? '…' : '')
      : '';
    return `
    <div class="prompt-filter-item" data-idx="${i}">
      <input type="checkbox" checked data-idx="${i}">
      <button class="prompt-edit-btn" data-idx="${i}" title="Edit prompt">&#9998;</button>
      <span class="prompt-label"><strong>${escapeHtml(label)}</strong>${promptSnippet}</span>
      <span class="prompt-count">${counts.get(label)}</span>
    </div>`;
  }).join('');

  // Bind checkboxes + clicking label toggles checkbox
  list.querySelectorAll('.prompt-filter-item').forEach(item => {
    const cb = item.querySelector('input[type="checkbox"]');
    const labelSpan = item.querySelector('.prompt-label');
    if (!cb) return;
    cb.addEventListener('change', () => {
      const label = allPromptLabels[parseInt(cb.dataset.idx)];
      if (cb.checked) checkedPrompts.add(label); else checkedPrompts.delete(label);
      renderGallery();
    });
    labelSpan?.addEventListener('click', () => {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
  });

  // Select/Deselect all buttons
  document.getElementById('promptSelectAll')?.addEventListener('click', () => {
    checkedPrompts = new Set(allPromptLabels);
    list.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
    renderGallery();
  });
  document.getElementById('promptDeselectAll')?.addEventListener('click', () => {
    checkedPrompts.clear();
    list.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    renderGallery();
  });

  // Expand/collapse toggle
  const expandBtn = document.getElementById('promptExpandToggle');
  if (expandBtn) {
    // Reset to collapsed
    list.classList.add('prompt-filter-collapsed');
    list.classList.remove('prompt-filter-expanded');
    expandBtn.classList.remove('expanded');
    expandBtn.style.display = allPromptLabels.length > 3 ? '' : 'none';

    // Clone to remove old listeners
    const newBtn = expandBtn.cloneNode(true);
    expandBtn.replaceWith(newBtn);
    newBtn.addEventListener('click', () => {
      const isCollapsed = list.classList.contains('prompt-filter-collapsed');
      list.classList.toggle('prompt-filter-collapsed', !isCollapsed);
      list.classList.toggle('prompt-filter-expanded', isCollapsed);
      newBtn.classList.toggle('expanded', isCollapsed);
    });
  }

  // Edit prompt buttons
  list.querySelectorAll('.prompt-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      const label = allPromptLabels[idx];
      const prompt = promptSampleMap.get(label) || '';
      const ids = promptJobIdsMap.get(label) || [];
      showPromptEditModal(label, prompt, ids);
    });
  });

  // Generate from checked prompts
  const genBtn = document.getElementById('promptGenerateBtn');
  if (genBtn) {
    const newGenBtn = genBtn.cloneNode(true);
    genBtn.replaceWith(newGenBtn);
    newGenBtn.addEventListener('click', () => generateFromCheckedPrompts());
  }
}

function showPromptEditModal(label, prompt, jobIds) {
  // Remove existing modal
  document.getElementById('promptEditOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'promptEditOverlay';
  overlay.className = 'prompt-edit-overlay';
  overlay.innerHTML = `
    <div class="prompt-edit-modal">
      <h3>Edit Prompt — ${escapeHtml(label)}</h3>
      <textarea id="promptEditText">${escapeHtml(prompt)}</textarea>
      <div class="prompt-edit-actions">
        <span class="text-muted" style="font-size:0.72rem;margin-right:auto;">${jobIds.length} image(s) use this prompt</span>
        <button class="btn-small" id="promptEditCancel">Cancel</button>
        <button class="btn-small btn-primary" id="promptEditSave">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.getElementById('promptEditCancel').addEventListener('click', () => overlay.remove());
  document.getElementById('promptEditSave').addEventListener('click', async () => {
    const newPrompt = document.getElementById('promptEditText').value.trim();
    if (!newPrompt || newPrompt === prompt) { overlay.remove(); return; }

    // Update all jobs with this prompt in the DB
    const { error } = await supabase
      .from('image_gen_jobs')
      .update({ prompt: newPrompt })
      .in('id', jobIds);

    if (error) {
      console.error('Failed to update prompt:', error);
      showToast('Could not update prompt', 'error');
      return;
    }

    showToast(`Prompt updated for ${jobIds.length} image(s)`, 'success');
    overlay.remove();
    await loadAll();
  });
}

async function generateFromCheckedPrompts() {
  const remaining = MAX_SESSION_GENERATES - sessionGenerateCount;
  if (remaining <= 0) {
    showToast(`Maximum ${MAX_SESSION_GENERATES} generations per session reached`, 'warning');
    return;
  }

  // Get checked labels that have prompts
  const toGenerate = [];
  for (const label of checkedPrompts) {
    const prompt = promptSampleMap.get(label);
    if (prompt) toGenerate.push({ label, prompt });
  }

  if (toGenerate.length === 0) {
    showToast('No prompts selected to generate from', 'warning');
    return;
  }

  const count = Math.min(toGenerate.length, remaining);
  if (toGenerate.length > remaining) {
    showToast(`Generating ${count} of ${toGenerate.length} — max ${MAX_SESSION_GENERATES} per session`, 'warning');
  }

  const user = authState?.appUser;
  if (!user?.id) return;
  const displayName = user.display_name || user.first_name || user.email || 'resident';

  for (let i = 0; i < count; i++) {
    const { label, prompt } = toGenerate[i];
    const payload = {
      prompt,
      job_type: 'generate',
      status: 'pending',
      source_media_id: null,
      metadata: {
        purpose: 'pai_prompt_regenerate',
        app_user_id: user.id,
        app_user_name: displayName,
        source_label: label,
      },
      batch_label: label,
      priority: 50,
      max_attempts: 3,
    };
    const { error } = await supabase.from('image_gen_jobs').insert(payload);
    if (error) {
      console.error('Failed to queue generation:', error);
      showToast(`Failed to queue: ${label}`, 'error');
      continue;
    }
    sessionGenerateCount++;
  }

  showToast(`Queued ${count} generation(s)`, 'success');
  await loadAll();
}

function getFilteredRows() {
  let rows;

  if (currentFilter === 'mine') {
    rows = myJobs.filter(j => j.status === 'completed' && j.result_url);
  } else {
    rows = allImagery;
  }

  // Filter by checked prompts
  if (checkedPrompts.size > 0 && checkedPrompts.size < allPromptLabels.length) {
    rows = rows.filter(r => checkedPrompts.has(getPromptLabel(r)));
  } else if (checkedPrompts.size === 0 && allPromptLabels.length > 0) {
    rows = [];
  }

  // Sort
  rows = [...rows].sort((a, b) => {
    const da = new Date(a.completed_at || a.created_at);
    const db = new Date(b.completed_at || b.created_at);
    return currentSort === 'newest' ? db - da : da - db;
  });

  return rows;
}

function renderGallery() {
  const grid = document.getElementById('galleryGrid');
  const countEl = document.getElementById('feedCount');
  if (!grid) return;

  const rows = getFilteredRows();

  if (countEl) countEl.textContent = `${rows.length} image${rows.length === 1 ? '' : 's'}`;

  if (rows.length === 0) {
    grid.innerHTML = currentFilter === 'mine'
      ? '<p class="text-muted" style="font-size:0.85rem;">No artwork yet. Generate one to get started.</p>'
      : '<p class="text-muted" style="font-size:0.85rem;">No generated images found.</p>';
    allImageUrls = [];
    return;
  }

  allImageUrls = rows.map(r => r.result_url);

  grid.innerHTML = rows.map((row) => {
    const person = row.metadata?.app_user_name || row.metadata?.vehicle_name || row.metadata?.person_name || '';
    const purpose = row.metadata?.purpose || '';
    const affirmation = row.metadata?.affirmation || '';
    const isMine = row.metadata?.app_user_id === authState?.appUser?.id;
    const dateStr = formatDate(row.completed_at || row.created_at);

    return `
    <article class="pai-gallery-card">
      <a href="#" class="pai-gallery-img-link" data-url="${row.result_url.replace(/"/g, '&quot;')}">
        <img src="${row.result_url}" alt="PAI imagery" loading="lazy">
      </a>
      ${affirmation ? `<div class="pai-gallery-card__affirmation">${escapeHtml(affirmation)}</div>` : ''}
      <div class="pai-gallery-card__meta">
        <span>${person ? escapeHtml(person) + ' · ' : ''}${dateStr}${purpose ? ' · ' + escapeHtml(humanizePurpose(purpose)) : ''}</span>
        ${isMine ? `<button class="pai-gallery-delete" data-job-id="${row.id}" title="Delete">&times;</button>` : ''}
      </div>
    </article>`;
  }).join('');

  grid.querySelectorAll('.pai-gallery-img-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openLightbox(link.dataset.url, allImageUrls);
    });
  });

  grid.querySelectorAll('.pai-gallery-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteGalleryJob(btn.dataset.jobId);
    });
  });
}

const DISMISSED_KEY = 'pai-dismissed-job-ids';
function getDismissedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')); } catch { return new Set(); }
}

function renderJobStatuses() {
  const list = document.getElementById('jobStatusList');
  if (!list) return;

  const dismissed = getDismissedIds();
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  const activeOrFailed = myJobs.filter((job) => {
    if (job.status === 'completed') return false;
    if (dismissed.has(String(job.id))) return false;
    // Auto-hide failed jobs older than 24h
    if (job.status === 'failed' && new Date(job.created_at).getTime() < oneDayAgo) return false;
    return true;
  }).slice(0, 4);

  if (activeOrFailed.length === 0) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = activeOrFailed.map((job) => `
    <div class="pai-job-status ${job.status}">
      <strong>${humanizeStatus(job.status)}</strong>
      <span>${formatDate(job.created_at)}</span>
      <button class="pai-job-dismiss" data-job-id="${job.id}" title="Dismiss">&times;</button>
      ${job.error_message ? `<small>${escapeHtml(job.error_message)}</small>` : ''}
    </div>
  `).join('');

  list.querySelectorAll('.pai-job-dismiss').forEach(btn => {
    btn.addEventListener('click', () => {
      const ids = getDismissedIds();
      ids.add(btn.dataset.jobId);
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
      renderJobStatuses();
    });
  });
}

// ---- Daily art generation ----

async function maybeQueueDailyArt() {
  const autoEnabled = getAutoDailyEnabled();
  if (!autoEnabled) return;
  if (hasTodayJob()) return;
  await queueArtJob(true);
}

async function queueArtJob(isAutoDaily) {
  const freshState = getAuthState();
  const user = freshState?.appUser || authState?.appUser;
  if (!user?.id) return;
  if (isAutoDaily && hasTodayJob()) return;

  const todayStr = new Date().toISOString().slice(0, 10);
  const displayName = user.display_name || user.first_name || user.email || 'resident';

  const userContext = [
    `Name: ${displayName}`,
    user.pronouns ? `Pronouns: ${user.pronouns}` : null,
    user.bio ? `Bio: ${user.bio}` : null,
    user.nationality ? `Nationality: ${user.nationality}` : null,
    user.location_base ? `Based in: ${user.location_base}` : null,
    user.birthday ? `Birthday: ${user.birthday}` : null,
    user.dietary_preferences ? `Dietary: ${user.dietary_preferences}` : null,
    user.instagram ? `Instagram: ${user.instagram}` : null,
    user.gender ? `Gender: ${user.gender}` : null,
  ].filter(Boolean).join('\n');

  const prompt = `${LIFE_OF_PAI_ART_PROMPT}

Person context (for personalizing the affirmation — NOT for the image):
${userContext}

Date: ${todayStr}
Pick a fresh artistic style and scene. Make the affirmation feel personal to this individual.`;

  const metadata = {
    purpose: DAILY_PURPOSE,
    app_user_id: user.id,
    app_user_name: displayName,
    auto_daily: isAutoDaily,
    title: `Life of PAI - ${displayName} - ${todayStr}`,
  };

  const payload = {
    prompt,
    job_type: 'generate',
    status: 'pending',
    source_media_id: null,
    metadata,
    batch_label: `Life of PAI - ${displayName}`,
    priority: isAutoDaily ? 20 : 50,
    max_attempts: 3,
  };

  const { error } = await supabase.from('image_gen_jobs').insert(payload);
  if (error) {
    console.error('Failed to queue art job:', error);
    showToast('Could not queue art generation', 'error');
    return;
  }

  showToast(isAutoDaily ? 'Daily artwork queued' : 'Artwork generation queued', 'success');
  await loadAll();
}

async function deleteGalleryJob(jobId) {
  const job = myJobs.find((j) => String(j.id) === String(jobId))
    || allImagery.find((j) => String(j.id) === String(jobId));
  if (!job) return;

  // Optimistic removal
  myJobs = myJobs.filter((j) => String(j.id) !== String(jobId));
  allImagery = allImagery.filter((j) => String(j.id) !== String(jobId));
  renderGallery();

  const { data, error } = await supabase
    .from('image_gen_jobs')
    .delete()
    .eq('id', jobId)
    .select('id');

  if (error || !data?.length) {
    console.error('Failed to delete:', error || 'no rows deleted (RLS?)');
    showToast('Could not delete — check permissions', 'error');
    await loadAll(); // reload to restore
    return;
  }

  showToast('Deleted', 'success');
}

function hasTodayJob() {
  const today = new Date().toISOString().slice(0, 10);
  return myJobs.some((job) => {
    if (!job?.created_at) return false;
    const created = String(job.created_at).slice(0, 10);
    return created === today && ['pending', 'processing', 'completed'].includes(job.status);
  });
}

function getAutoDailyEnabled() {
  const stored = localStorage.getItem(AUTO_DAILY_KEY);
  return stored === null ? true : stored === 'true';
}

function updateDailyStatusText() {
  const el = document.getElementById('dailyStatusText');
  if (!el) return;
  const auto = getAutoDailyEnabled();
  const todayDone = hasTodayJob();

  if (!auto) {
    el.textContent = 'Auto-daily generation is off.';
    return;
  }
  if (todayDone) {
    el.textContent = 'Today\'s artwork already exists or is currently processing.';
    return;
  }
  el.textContent = 'No artwork for today yet. It will be generated automatically when this page is opened.';
}

// ---- Helpers ----

function humanizeStatus(status) {
  const map = { pending: 'Pending', processing: 'Processing', failed: 'Failed', cancelled: 'Cancelled' };
  return map[status] || status;
}

function humanizePurpose(purpose) {
  const labels = {
    pai_resident_daily_art: 'Daily Art',
    pai_work_photo_art: 'Work Art',
    tesla_vehicle_photo: 'Vehicle',
    co_reviewed: 'Co-Reviewed',
    pai_email_art: 'Email Art',
  };
  return labels[purpose] || purpose.replace(/^pai_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatDate(value) {
  if (!value) return 'Unknown date';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Unknown date';
  return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
}
