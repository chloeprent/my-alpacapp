/**
 * Version Info — hover tooltip + click modal for the site version badge.
 *
 * Reads /version.json (written by CI on each push to main) and renders:
 *   - Hover: version, release #, actor, model, machine
 *   - Click modal: same, plus list of commits in that push
 *
 * Works on any page. Finds the version span by matching class names or the
 * `r` + 9-digit pattern. Auto-initializes on DOMContentLoaded.
 *
 * Include as: <script type="module" src="/shared/version-info.js"></script>
 */

/* ── cache ─────────────────────────────────────────────────────────── */
let _cache = null;

async function fetchVersionInfo() {
  if (_cache) return _cache;
  try {
    const r = await fetch('/version.json?_=' + Date.now());
    if (!r.ok) return null;
    _cache = await r.json();
    return _cache;
  } catch { return null; }
}

/* ── helpers ────────────────────────────────────────────────────────── */
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      hour12: true, timeZone: 'America/Chicago',
    });
  } catch { return iso; }
}

function shortSha(sha) { return sha ? sha.slice(0, 8) : '—'; }

const MODEL_NAMES = {
  ci:   'CI',
  cur:  'Cursor',
  cursor: 'Cursor',
  claude: 'Claude',
  'o4.6': 'Claude Opus 4.6',
  's4.0': 'Claude Sonnet 4',
  'g2.5': 'Gemini 2.5',
  'g4o': 'GPT-4o',
  gemini: 'Gemini',
  gpt: 'GPT',
  'modl-a': 'Cursor Auto',
  'modl a': 'Cursor Auto',
};
function modelName(code) { return (code && MODEL_NAMES[code]) || code || '—'; }

function val(...args) {
  for (const v of args) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '—';
}

/** Format release number as r00001 (r + 5-digit zero-padded) */
function rNum(n) {
  const num = parseInt(n, 10);
  return isNaN(num) ? '—' : 'r' + String(num).padStart(5, '0');
}

/* ── find the version span in the DOM ──────────────────────────────── */
function findVersionSpan() {
  // Match vYYMMDD.NN (primary) or r000000000 (legacy)
  const pat = /^(v\d{6}\.\d{2}|r\d{9})/;
  const versionClasses = [
    '.aap-header__version',
    '.site-nav__version',
    '.login-card__version',
  ];
  const candidates = [
    ...document.querySelectorAll(versionClasses.join(',')),
    ...document.querySelectorAll('.header-left span'),
  ];
  // First pass: look for spans that already contain a version string
  for (const el of candidates) if (pat.test(el.textContent.trim())) return el;
  for (const span of document.querySelectorAll('span'))
    if (pat.test(span.textContent.trim())) return span;
  // Second pass: return the first empty/placeholder span with a known version class
  // so setupVersionInfo() can populate it from /version.json at runtime
  for (const el of candidates) {
    const txt = el.textContent.trim();
    if (!txt || txt === '—' || txt === '--') return el;
  }
  return null;
}

/* ── inject CSS (once) ─────────────────────────────────────────────── */
function injectStyles() {
  if (document.getElementById('vi-styles')) return;
  const s = document.createElement('style');
  s.id = 'vi-styles';
  s.textContent = `
    /* ── tooltip ─────────────────────────── */
    .vi-tooltip{position:fixed;background:#1a1a2e;color:#f0f0f0;padding:10px 16px;
      border-radius:10px;font-size:.95rem;pointer-events:none;opacity:0;
      transition:opacity .15s;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.3);
      max-width:360px;line-height:1.5;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
    .vi-tt-ver{font-size:1.1rem;font-weight:700;margin-bottom:4px}
    .vi-tt-row{font-size:.8rem;color:#aaa}
    .vi-tt-row span{color:#7dd3fc}
    .vi-tt-hint{margin-top:6px;font-size:.75rem;color:#9ca3af}

    /* ── modal overlay ───────────────────── */
    #vi-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);
      display:flex;align-items:center;justify-content:center;z-index:10000;
      animation:vi-fade .15s ease-out}
    @keyframes vi-fade{from{opacity:0}to{opacity:1}}
    #vi-modal{background:#fff;border-radius:14px;padding:0;
      max-width:520px;width:94%;max-height:85vh;overflow-y:auto;
      box-shadow:0 12px 40px rgba(0,0,0,.25);
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif}
    #vi-modal *{box-sizing:border-box}

    /* header */
    .vi-hd{padding:1.25rem 1.5rem 1rem;border-bottom:1px solid #e5e7eb;
      display:flex;justify-content:space-between;align-items:flex-start}
    .vi-hd h2{margin:0;font-size:1.5rem;font-weight:700;color:#111}
    .vi-hd-sub{font-size:.85rem;color:#666;font-family:ui-monospace,'SF Mono',Monaco,monospace;margin-top:2px}
    .vi-close{background:none;border:none;font-size:1.8rem;cursor:pointer;
      color:#999;line-height:1;padding:0 0 0 8px;transition:color .15s}
    .vi-close:hover{color:#333}

    /* body + sections */
    .vi-body{padding:1rem 1.5rem 1.5rem}
    .vi-section{margin-bottom:1.25rem}
    .vi-section:last-child{margin-bottom:0}
    .vi-sec-title{font-size:.75rem;font-weight:700;text-transform:uppercase;
      letter-spacing:.05em;margin-bottom:.5rem;display:flex;align-items:center;gap:6px;color:#374151}
    .vi-count{background:#e5e7eb;border-radius:10px;padding:1px 7px;font-size:.7rem;font-weight:600}

    /* commit rows */
    .vi-row{padding:.5rem .75rem;display:flex;align-items:flex-start;gap:8px;
      font-size:.9rem;line-height:1.4;background:#fff;border-bottom:1px solid #f3f4f6}
    .vi-row:nth-child(even){background:#f9fafb}
    .vi-row:last-child{border-bottom:none}
    .vi-dot{flex-shrink:0;width:20px;height:20px;border-radius:50%;
      display:flex;align-items:center;justify-content:center;font-size:.7rem;
      margin-top:2px;background:#f3f4f6;color:#6b7280}
    .vi-txt{flex:1;min-width:0}
    .vi-msg{color:#333;word-break:break-word}
    .vi-meta{font-size:.75rem;color:#6b7280;font-family:ui-monospace,'SF Mono',Monaco,monospace;
      margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .vi-empty{font-size:.85rem;color:#9ca3af;font-style:italic;padding:.5rem .75rem}
  `;
  document.head.appendChild(s);
}

/* ── resolve fields from version.json (handles both old & new schemas) ─── */
function resolveInfo(info) {
  if (!info) return null;
  // New schema: info.release is a number. Old schema: info.release is an object.
  const r = (typeof info.release === 'object' && info.release !== null) ? info.release : {};
  const releaseNum = typeof info.release === 'number' ? info.release : (r.seq ?? '');
  return {
    version:  val(info.version, r.display_version),
    release:  val(String(releaseNum)),
    sha:      val(info.sha, info.commit, shortSha(r.push_sha)),
    fullSha:  val(info.fullSha, info.full_commit, r.push_sha),
    actor:    val(info.actor, r.actor_login, info.user),
    source:   val(info.source, r.source),
    model:    val(info.model, r.model_code),
    machine:  val(info.machine, r.machine_name),
    pushedAt: info.pushedAt || r.pushed_at || info.timestamp || '',
    commits:  info.commits || info.changes || [],
  };
}

/* ── tooltip content ───────────────────────────────────────────────── */
function tooltipHtml(d) {
  return [
    `<div class="vi-tt-ver">${esc(d.version)}</div>`,
    `<div class="vi-tt-row">Release: <span>${esc(rNum(d.release))}</span> by ${esc(d.actor)}</div>`,
    `<div class="vi-tt-row">Model: <span style="color:#d4883a">${esc(modelName(d.model))}</span></div>`,
    `<div class="vi-tt-row">Machine: ${esc(d.machine)}</div>`,
    `<div class="vi-tt-hint">Click for full build details</div>`,
  ].join('');
}

/* ── modal ─────────────────────────────────────────────────────────── */
function showModal(d) {
  document.getElementById('vi-overlay')?.remove();
  injectStyles();

  const overlay = document.createElement('div');
  overlay.id = 'vi-overlay';

  if (!d) {
    overlay.innerHTML = `
      <div id="vi-modal">
        <div class="vi-hd"><div><h2>Build Info</h2></div><button class="vi-close" data-close>&times;</button></div>
        <div class="vi-body"><p style="color:#666;font-size:.95rem">No version.json found.</p></div>
      </div>`;
  } else {
    const commits = d.commits || [];
    const commitsHtml = commits.length
      ? commits.map(c => `
          <div class="vi-row">
            <div class="vi-dot">&#8226;</div>
            <div class="vi-txt">
              <div class="vi-msg">${esc(c.message || c.msg || '')}</div>
              <div class="vi-meta">${esc(shortSha(c.sha || c.hash || ''))}${c.author ? ' · ' + esc(c.author) : c.author_name ? ' · ' + esc(c.author_name) : ''}</div>
            </div>
          </div>`).join('')
      : '<div class="vi-empty">No commits recorded for this release</div>';

    overlay.innerHTML = `
      <div id="vi-modal">
        <div class="vi-hd">
          <div>
            <h2>${esc(d.version)}</h2>
            <div class="vi-hd-sub">${fmtTime(d.pushedAt)} · ${esc(d.sha)}</div>
            <div class="vi-hd-sub" style="margin-top:4px">${esc(rNum(d.release))} · by ${esc(d.actor)} · ${esc(d.source)}</div>
            <div class="vi-hd-sub" style="margin-top:4px">Model: <span style="color:#d4883a">${esc(modelName(d.model))}</span> · Machine: ${esc(d.machine)}</div>
          </div>
          <button class="vi-close" data-close>&times;</button>
        </div>
        <div class="vi-body">
          <div class="vi-section">
            <div class="vi-sec-title">Commits <span class="vi-count">${commits.length}</span></div>
            ${commitsHtml}
          </div>
        </div>
      </div>`;
  }

  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.closest('[data-close]')) overlay.remove();
  });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); }
  });
  document.body.appendChild(overlay);
}

/* ── setup ─────────────────────────────────────────────────────────── */
export function setupVersionInfo() {
  const span = findVersionSpan();
  if (!span) return;

  span.style.cursor = 'pointer';
  span.style.textDecoration = 'underline dotted';
  span.style.textUnderlineOffset = '2px';

  const computed = getComputedStyle(span);
  if (parseFloat(computed.fontSize) < 10) span.style.fontSize = '0.55rem';

  injectStyles();

  // Immediately fetch version.json and overwrite the displayed version
  // so all pages show the same live version regardless of HTML caching
  fetchVersionInfo().then(info => {
    const d = resolveInfo(info);
    if (d && d.version && d.version !== '—') {
      span.textContent = d.version;
    }
  });

  // Tooltip
  const tip = document.createElement('div');
  tip.className = 'vi-tooltip';
  tip.innerHTML = '<div class="vi-tt-ver">Loading…</div>';
  document.body.appendChild(tip);

  span.addEventListener('mouseenter', async () => {
    const info = await fetchVersionInfo();
    const d = resolveInfo(info);
    tip.innerHTML = d ? tooltipHtml(d) : '<div class="vi-tt-ver">Build info unavailable</div>';
    const rect = span.getBoundingClientRect();
    tip.style.left = Math.min(rect.left, window.innerWidth - 370) + 'px';
    tip.style.top = (rect.bottom + 8) + 'px';
    tip.style.opacity = '1';
  });

  span.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });

  span.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    tip.style.opacity = '0';
    const info = await fetchVersionInfo();
    showModal(resolveInfo(info));
  });
}

// Auto-init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setupVersionInfo());
} else {
  setupVersionInfo();
}
