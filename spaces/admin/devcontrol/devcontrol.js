/**
 * DevControl — AI development tools and activity dashboard
 * Sub-tabs: Overview, Releases, Sessions, Tokens, Context, Backups
 */
import { supabase } from '../../../shared/supabase.js';
import { initAdminPage, showToast } from '../../../shared/admin-shell.js';
import { getAuthState } from '../../../shared/auth.js';

// ═══════════════════════════════════════════════════════════
// CONFIG — project-specific values
// ═══════════════════════════════════════════════════════════
const SESSIONS_API = 'https://claude-sessions.alpacapps.workers.dev';
const SESSIONS_TOKEN = 'alpaca-sessions-2026';
const PROJECT_FILTER = 'genalpaca'; // Only show this project's sessions
const GH_OWNER = 'rsonnad';
const GH_REPO = 'alpacapps';
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`;
const RAW_BASE = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}`;
const CONTEXT_WINDOW = 200_000;

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
const esc = (s) => { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; };
const fmt = (n) => n ? n.toLocaleString() : '0';
const fmtCost = (n) => n ? `$${n.toFixed(2)}` : '$0.00';
const fmtTokensShort = (n) => { if (!n) return ''; return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n); };
const charsToTokens = (c) => Math.round(c / 4);
const fmtDate = (iso) => {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
const fmtDuration = (s) => {
  if (!s) return '\u2014';
  return s < 60 ? `${s}s` : s % 60 > 0 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`;
};

const sessionHeaders = { Authorization: `Bearer ${SESSIONS_TOKEN}` };

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}

// ═══════════════════════════════════════════════════════════
// SUB-TAB ROUTING
// ═══════════════════════════════════════════════════════════
let activeSubtab = 'overview';
const loadedTabs = new Set();

function initSubtabs() {
  const hash = location.hash.replace('#', '');
  if (hash && document.getElementById(`dc-panel-${hash}`)) activeSubtab = hash;

  document.querySelectorAll('.dc-manage-tab').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.preventDefault(); switchTab(btn.dataset.tab); });
  });
  switchTab(activeSubtab);
}

function switchTab(tab) {
  activeSubtab = tab;
  location.hash = tab === 'overview' ? '' : tab;

  document.querySelectorAll('.dc-manage-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.dc-panel').forEach((p) => { p.style.display = p.id === `dc-panel-${tab}` ? '' : 'none'; });

  if (!loadedTabs.has(tab)) {
    loadedTabs.add(tab);
    const loaders = { overview: loadOverview, releases: loadReleases, sessions: loadSessions, tokens: loadTokens, context: loadContext, backups: loadBackups, planlist: loadPlanList, tests: loadTests };
    loaders[tab]?.();
  }
}

// ═══════════════════════════════════════════════════════════
// OVERVIEW TAB
// ═══════════════════════════════════════════════════════════
function loadOverview() {
  const cards = [
    { tab: 'releases', label: 'Releases', desc: 'Every PR shipped, with version numbers and line counts', icon: '<path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25"/>' },
    { tab: 'sessions', label: 'Sessions', desc: 'AI development session history for this project', icon: '<path d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/>' },
    { tab: 'tokens', label: 'Tokens & Cost', desc: 'Token usage, costs, and session analytics', icon: '<path d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"/>' },
    { tab: 'context', label: 'Context Window', desc: 'What files load into Claude\'s context and how much space they use', icon: '<path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/>' },
    { tab: 'backups', label: 'Backups', desc: 'Database and file storage backup status', icon: '<path d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"/>' },
    { tab: 'planlist', label: 'PlanList', desc: 'Development todo items, checklists, and project tasks', icon: '<path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/>' },
    { tab: '_devdocs', label: 'Dev Docs', desc: 'Internal development documentation — schema, patterns, credentials, guides', icon: '<path d="M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 0 1-2.25 2.25M16.5 7.5V18a2.25 2.25 0 0 0 2.25 2.25M16.5 7.5V4.875c0-.621-.504-1.125-1.125-1.125H4.125C3.504 3.75 3 4.254 3 4.875V18a2.25 2.25 0 0 0 2.25 2.25h13.5M6 7.5h3v3H6V7.5Z"/>' },
    { tab: 'tests', label: 'Test Suite', desc: 'All registered tests, last run results, models, and status', icon: '<path d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0 1 12 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5"/>' },
  ];

  const panel = document.getElementById('dc-panel-overview');
  panel.innerHTML = `
    <h2 style="font-size:1.375rem;font-weight:700;margin-bottom:0.25rem;">DevControl</h2>
    <p style="color:var(--text-muted,#888);font-size:0.875rem;margin-bottom:1.5rem;">AI-powered development tools and activity</p>
    <div class="dc-overview-grid">
      ${cards.map((c) => `
        <div class="dc-overview-card" data-goto="${c.tab}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${c.icon}</svg>
          <div><h3>${esc(c.label)}</h3><p>${esc(c.desc)}</p></div>
        </div>
      `).join('')}
    </div>`;

  panel.querySelectorAll('[data-goto]').forEach((card) => {
    card.addEventListener('click', () => {
      const target = card.dataset.goto;
      if (target.startsWith('_')) {
        // External link cards
        if (target === '_devdocs') window.location.href = '/spaces/admin/devcontrol/devdocs/';
      } else {
        switchTab(target);
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════
// RELEASES TAB  (GitHub PR changelog)
// ═══════════════════════════════════════════════════════════
async function loadReleases() {
  const panel = document.getElementById('dc-panel-releases');
  panel.innerHTML = '<div class="dc-empty">Loading changelog...</div>';

  try {
    const [prListRes, commitsRes] = await Promise.all([
      fetch(`${GH_API}/pulls?state=closed&sort=updated&direction=desc&per_page=50`),
      fetch(`${GH_API}/commits?per_page=100`),
    ]);
    if (!prListRes.ok) throw new Error(`GitHub API ${prListRes.status}`);

    const prList = (await prListRes.json()).filter((pr) => pr.merged_at);
    const commits = commitsRes.ok ? await commitsRes.json() : [];

    // Map PR numbers to version bump SHAs
    const prToVersionSha = {};
    for (let i = 0; i < commits.length; i++) {
      if (commits[i].commit.message.startsWith('chore: bump version')) {
        const next = commits[i + 1];
        if (next) {
          const m = next.commit.message.match(/Merge pull request #(\d+)/);
          if (m) prToVersionSha[parseInt(m[1])] = commits[i].sha;
        }
      }
    }

    // Fetch PR details + version.json in parallel
    const detailPromises = prList.map((pr) =>
      fetch(`${GH_API}/pulls/${pr.number}`).then((r) => r.ok ? r.json() : null).catch(() => null)
    );
    const versionShas = [...new Set(Object.values(prToVersionSha))];
    const versionPromises = versionShas.map((sha) =>
      fetch(`${RAW_BASE}/${sha}/version.json`).then((r) => r.ok ? r.json() : null).catch(() => null)
    );

    const [prDetails, ...versionResults] = await Promise.all([Promise.all(detailPromises), ...versionPromises]);
    const shaToVersion = {};
    versionShas.forEach((sha, i) => { if (versionResults[i]?.version) shaToVersion[sha] = versionResults[i].version; });

    const enriched = prList.map((pr, idx) => {
      const d = prDetails[idx];
      const vSha = prToVersionSha[pr.number];
      return { ...pr, additions: d?.additions ?? 0, deletions: d?.deletions ?? 0, changed_files: d?.changed_files ?? 0, version: vSha ? shaToVersion[vSha] : undefined };
    });

    const totalLines = enriched.reduce((s, pr) => s + pr.additions + pr.deletions, 0);

    // Group by date
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    const groups = new Map();
    for (const pr of enriched) {
      const d = new Date(pr.merged_at).toDateString();
      const label = d === today ? 'Today' : d === yesterday ? 'Yesterday' : new Date(pr.merged_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(pr);
    }

    function categorize(title) {
      const t = title.toLowerCase();
      if (t.startsWith('fix') || t.includes('bug')) return { label: 'Fix', cls: 'dc-release-tag-fix' };
      if (t.includes('add') || t.includes('new')) return { label: 'New', cls: 'dc-release-tag-new' };
      if (t.includes('rewrite') || t.includes('refactor') || t.includes('redesign')) return { label: 'Rewrite', cls: 'dc-release-tag-rewrite' };
      return { label: 'Update', cls: 'dc-release-tag-update' };
    }

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">
        <div>
          <h2 style="font-size:1.375rem;font-weight:700;margin:0;">Changelog</h2>
          <p style="color:var(--text-muted,#888);font-size:0.8125rem;margin:0.25rem 0 0;">${enriched.length} changes shipped &middot; ${totalLines.toLocaleString()} lines changed</p>
        </div>
        <a href="https://github.com/${GH_OWNER}/${GH_REPO}/pulls?q=is%3Apr+is%3Amerged" target="_blank" rel="noopener" style="font-size:0.8125rem;color:var(--text-muted,#888);">View on GitHub &rarr;</a>
      </div>`;

    for (const [label, prs] of groups) {
      html += `<div class="dc-release-group-label">${esc(label)}</div>`;
      for (const pr of prs) {
        const cat = categorize(pr.title);
        const lines = pr.additions + pr.deletions;
        html += `
          <a href="${esc(pr.html_url)}" target="_blank" rel="noopener" class="dc-release-item">
            <span class="dc-release-tag ${cat.cls}">${cat.label}</span>
            <span class="dc-release-title">${esc(pr.title)}</span>
            <div class="dc-release-meta">
              ${pr.version ? `<span class="dc-release-version">${esc(pr.version)}</span>` : ''}
              ${lines > 0 ? `<span class="dc-release-lines"><span class="plus">+${pr.additions}</span> <span class="minus">-${pr.deletions}</span></span>` : ''}
              <span>#${pr.number}</span>
              <span>${fmtDate(pr.merged_at)}</span>
            </div>
          </a>`;
      }
    }
    panel.innerHTML = html || '<div class="dc-empty">No changes recorded yet.</div>';
  } catch (err) {
    panel.innerHTML = `<div class="dc-empty">Failed to load changelog: ${esc(err.message)}</div>`;
  }
}

// ═══════════════════════════════════════════════════════════
// SESSIONS TAB  (single-project only)
// ═══════════════════════════════════════════════════════════
let sessionsState = { items: [], stats: null, search: '', dateFrom: '', dateTo: '', expandedId: null, transcriptCache: {} };

async function loadSessions() {
  const panel = document.getElementById('dc-panel-sessions');

  // Stats
  try {
    const res = await fetch(`${SESSIONS_API}/stats?project=${PROJECT_FILTER}`, { headers: sessionHeaders });
    if (res.ok) sessionsState.stats = await res.json();
  } catch {}

  renderSessionsUI(panel);
  await fetchSessions(panel);
}

function renderSessionsUI(panel) {
  const s = sessionsState.stats;
  panel.innerHTML = `
    <h2 style="font-size:1.375rem;font-weight:700;margin-bottom:0.25rem;">Sessions</h2>
    <p style="color:var(--text-muted,#888);font-size:0.8125rem;margin-bottom:1.25rem;">AI development session history for this project</p>
    ${s ? `<div class="dc-stats">
      <div class="dc-stat"><div class="dc-stat-value" style="color:#7c3aed">${fmt(s.total_sessions)}</div><div class="dc-stat-label">Sessions</div></div>
      <div class="dc-stat"><div class="dc-stat-value" style="color:#059669">${fmt(s.total_tokens)}</div><div class="dc-stat-label">Tokens</div></div>
      <div class="dc-stat"><div class="dc-stat-value" style="color:#2563eb">${s.total_minutes ? Math.round(s.total_minutes / 60) + 'h' : '\u2014'}</div><div class="dc-stat-label">Total Hours</div></div>
      <div class="dc-stat"><div class="dc-stat-value" style="color:#d97706">${s.avg_duration ? Math.round(s.avg_duration / 60) + 'm' : '\u2014'}</div><div class="dc-stat-label">Avg Duration</div></div>
    </div>` : ''}
    <div class="dc-filters">
      <input type="text" id="dc-sess-search" placeholder="Search sessions..." value="${esc(sessionsState.search)}">
      <input type="date" id="dc-sess-from" value="${sessionsState.dateFrom}">
      <input type="date" id="dc-sess-to" value="${sessionsState.dateTo}">
      <button class="dc-btn-primary" id="dc-sess-go">Search</button>
      <button class="dc-btn-secondary" id="dc-sess-clear">Clear</button>
    </div>
    <div id="dc-sess-list" class="dc-session-list"><div class="dc-empty">Loading...</div></div>`;

  panel.querySelector('#dc-sess-go').addEventListener('click', () => {
    sessionsState.search = panel.querySelector('#dc-sess-search').value;
    sessionsState.dateFrom = panel.querySelector('#dc-sess-from').value;
    sessionsState.dateTo = panel.querySelector('#dc-sess-to').value;
    fetchSessions(panel);
  });
  panel.querySelector('#dc-sess-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') panel.querySelector('#dc-sess-go').click();
  });
  panel.querySelector('#dc-sess-clear').addEventListener('click', () => {
    sessionsState.search = ''; sessionsState.dateFrom = ''; sessionsState.dateTo = '';
    panel.querySelector('#dc-sess-search').value = '';
    panel.querySelector('#dc-sess-from').value = '';
    panel.querySelector('#dc-sess-to').value = '';
    fetchSessions(panel);
  });
}

async function fetchSessions(panel) {
  const list = panel.querySelector('#dc-sess-list');
  list.innerHTML = '<div class="dc-empty">Loading...</div>';

  try {
    const params = new URLSearchParams({ limit: '50', project: PROJECT_FILTER });
    if (sessionsState.search) params.set('search', sessionsState.search);
    if (sessionsState.dateFrom) params.set('from', sessionsState.dateFrom);
    if (sessionsState.dateTo) params.set('to', sessionsState.dateTo);

    const res = await fetch(`${SESSIONS_API}/sessions?${params}`, { headers: sessionHeaders });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    sessionsState.items = data.sessions || data || [];
    renderSessionList(list);
  } catch (err) {
    list.innerHTML = `<div class="dc-empty">Failed to load sessions: ${esc(err.message)}</div>`;
  }
}

function renderSessionList(container) {
  if (!sessionsState.items.length) {
    container.innerHTML = '<div class="dc-empty">No sessions found</div>';
    return;
  }

  container.innerHTML = sessionsState.items.map((s) => {
    const model = s.model ? s.model.replace('claude-', '').split('-202')[0] : '';
    const tokens = fmtTokensShort(s.token_count);
    return `
      <div class="dc-session-card" data-id="${esc(s.id)}">
        <div class="dc-session-header">
          <span class="dc-session-summary">${esc(s.summary || 'No summary')}</span>
          <div class="dc-session-meta">
            <span class="dc-pill dc-pill-date">${esc(fmtDate(s.started_at))}</span>
            ${model ? `<span class="dc-pill dc-pill-model">${esc(model)}</span>` : ''}
            ${s.duration_mins > 0 ? `<span class="dc-pill dc-pill-duration">${s.duration_mins}m</span>` : ''}
            ${tokens ? `<span class="dc-pill dc-pill-tokens">${tokens}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('.dc-session-header').forEach((hdr) => {
    hdr.addEventListener('click', () => toggleSession(hdr.closest('.dc-session-card')));
  });
}

async function toggleSession(card) {
  const id = card.dataset.id;
  const existing = card.querySelector('.dc-session-transcript');
  if (existing) { existing.remove(); sessionsState.expandedId = null; return; }

  // Collapse any other
  document.querySelectorAll('.dc-session-transcript').forEach((el) => el.remove());
  sessionsState.expandedId = id;

  // Fetch full transcript
  if (!sessionsState.transcriptCache[id]) {
    try {
      const res = await fetch(`${SESSIONS_API}/sessions/${id}`, { headers: sessionHeaders });
      if (res.ok) { const data = await res.json(); sessionsState.transcriptCache[id] = data.transcript || ''; }
    } catch {}
  }

  const transcript = sessionsState.transcriptCache[id] || '';
  const messages = parseTranscript(transcript);

  const div = document.createElement('div');
  div.className = 'dc-session-transcript';
  div.innerHTML = `
    <div class="dc-transcript-actions">
      <button class="dc-copy-btn" data-copy-full>Copy Full Session</button>
    </div>
    <div class="dc-transcript-messages">
      ${messages.length ? messages.map((m, i) => `
        <div class="dc-msg ${m.role === 'USER' ? 'dc-msg-user' : 'dc-msg-assistant'}">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="dc-msg-role">${m.role}</span>
            <button class="dc-copy-btn" data-copy-idx="${i}">Copy</button>
          </div>
          <div style="font-family:inherit;white-space:pre-wrap;font-size:0.8125rem;line-height:1.6;">${esc(m.content.length > 3000 ? m.content.substring(0, 3000) + '\n\n... [truncated]' : m.content)}</div>
        </div>
      `).join('') : '<div class="dc-empty">No transcript available</div>'}
    </div>`;

  div.querySelector('[data-copy-full]')?.addEventListener('click', function () {
    copyToClipboard(messages.map((m) => `### ${m.role}\n\n${m.content}`).join('\n\n---\n\n'), this);
  });
  div.querySelectorAll('[data-copy-idx]').forEach((btn) => {
    btn.addEventListener('click', function () { copyToClipboard(messages[parseInt(this.dataset.copyIdx)].content, this); });
  });

  card.appendChild(div);
}

function parseTranscript(text) {
  if (!text) return [];
  return text.split(/\n---\n/).map((part) => {
    part = part.trim();
    if (!part) return null;
    const role = part.startsWith('## User') ? 'USER' : 'ASSISTANT';
    const content = part.replace(/^## (User|Assistant)\n?/, '').trim();
    return { role, content };
  }).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════
// TOKENS TAB
// ═══════════════════════════════════════════════════════════
async function loadTokens() {
  const panel = document.getElementById('dc-panel-tokens');
  panel.innerHTML = '<div class="dc-empty">Loading token analytics...</div>';

  try {
    const [statsRes, sessionsRes] = await Promise.all([
      fetch(`${SESSIONS_API}/stats?project=${PROJECT_FILTER}`, { headers: sessionHeaders }),
      fetch(`${SESSIONS_API}/sessions?limit=200&project=${PROJECT_FILTER}`, { headers: sessionHeaders }),
    ]);

    const stats = statsRes.ok ? await statsRes.json() : {};
    const sessData = sessionsRes.ok ? await sessionsRes.json() : {};
    const sessions = sessData.sessions || sessData || [];

    // Group by day
    const byDay = {};
    for (const s of sessions) {
      const d = s.started_at ? new Date(s.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'unknown';
      if (!byDay[d]) byDay[d] = { tokens: 0, sessions: 0 };
      byDay[d].tokens += s.token_count || 0;
      byDay[d].sessions += 1;
    }
    const dayEntries = Object.entries(byDay).map(([date, data]) => ({ date, ...data })).reverse();
    const maxDayTokens = Math.max(...dayEntries.map((d) => d.tokens), 1);

    // Group by model
    const byModel = {};
    for (const s of sessions) {
      const k = s.model ? s.model.replace('claude-', '').split('-202')[0] : 'unknown';
      if (!byModel[k]) byModel[k] = { tokens: 0, sessions: 0 };
      byModel[k].tokens += s.token_count || 0;
      byModel[k].sessions += 1;
    }
    const modelEntries = Object.entries(byModel).map(([key, data]) => ({ key, ...data })).sort((a, b) => b.tokens - a.tokens);

    panel.innerHTML = `
      <h2 style="font-size:1.375rem;font-weight:700;margin-bottom:0.25rem;">Tokens & Cost</h2>
      <p style="color:var(--text-muted,#888);font-size:0.8125rem;margin-bottom:1.25rem;">Token usage and session analytics for this project</p>

      <div class="dc-stats">
        <div class="dc-stat"><div class="dc-stat-value" style="color:#059669">${fmt(stats.total_tokens || 0)}</div><div class="dc-stat-label">Total Tokens</div></div>
        <div class="dc-stat"><div class="dc-stat-value" style="color:#d97706">${fmtCost(stats.total_cost || 0)}</div><div class="dc-stat-label">Total Cost</div></div>
        <div class="dc-stat"><div class="dc-stat-value" style="color:#2563eb">${fmt(Math.round(stats.avg_tokens || 0))}</div><div class="dc-stat-label">Avg / Session</div></div>
        <div class="dc-stat"><div class="dc-stat-value" style="color:#7c3aed">${fmt(stats.total_sessions || 0)}</div><div class="dc-stat-label">Sessions</div></div>
      </div>

      ${dayEntries.length ? `
        <h3 class="dc-section-header">Daily Token Usage</h3>
        <div style="border:1px solid var(--border,#e2e0db);border-radius:12px;padding:1rem;background:var(--bg-card,#fff);margin-bottom:1.5rem;">
          ${dayEntries.map((d) => `
            <div class="dc-bar-row">
              <span class="dc-bar-label">${esc(d.date)}</span>
              <div class="dc-bar-track"><div class="dc-bar-fill" style="width:${(d.tokens / maxDayTokens) * 100}%"></div></div>
              <span class="dc-bar-value">${fmt(d.tokens)}</span>
            </div>
          `).join('')}
        </div>` : ''}

      ${modelEntries.length ? `
        <h3 class="dc-section-header">By Model</h3>
        <div class="dc-table-wrap">
          <table class="dc-table">
            <thead><tr><th>Model</th><th class="text-right">Sessions</th><th class="text-right">Tokens</th></tr></thead>
            <tbody>
              ${modelEntries.map((r) => `<tr><td class="mono">${esc(r.key)}</td><td class="text-right tabular">${r.sessions}</td><td class="text-right tabular">${fmt(r.tokens)}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}`;
  } catch (err) {
    panel.innerHTML = `<div class="dc-empty">Failed to load token data: ${esc(err.message)}</div>`;
  }
}

// ═══════════════════════════════════════════════════════════
// CONTEXT TAB
// ═══════════════════════════════════════════════════════════

function renderTokenHistoryChart(snapshots, currentAlways) {
  if (snapshots.length === 0 && !currentAlways) return '';

  const today = new Date().toISOString().split('T')[0];
  const points = [...snapshots.filter((s) => s.snapshot_date !== today)];
  if (currentAlways > 0) {
    points.push({ snapshot_date: today, always_loaded_tokens: currentAlways, total_tokens: 0 });
  }
  if (points.length < 2) {
    return `
      <div style="border:1px solid var(--border,#e2e0db);border-radius:12px;padding:1.25rem;background:var(--bg-card,#fff);margin-bottom:1.5rem;">
        <h3 class="dc-section-header" style="margin-bottom:0.25rem;">Always-Loaded Tokens — Last 90 Days</h3>
        <p style="color:var(--text-muted,#aaa);font-size:0.75rem;">Not enough data yet. Check back tomorrow.</p>
      </div>`;
  }

  points.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  const values = points.map((p) => p.always_loaded_tokens);
  const minVal = Math.min(...values) * 0.9;
  const maxVal = Math.max(...values) * 1.1;
  const range = maxVal - minVal || 1;

  const W = 700, H = 180;
  const PAD = { top: 20, right: 20, bottom: 30, left: 50 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const xScale = (i) => PAD.left + (i / (points.length - 1)) * plotW;
  const yScale = (v) => PAD.top + plotH - ((v - minVal) / range) * plotH;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(p.always_loaded_tokens).toFixed(1)}`).join(' ');
  const area = `${line} L${xScale(points.length - 1).toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${PAD.left},${(PAD.top + plotH).toFixed(1)} Z`;

  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount }, (_, i) => minVal + (range * i) / (tickCount - 1));
  const labelInterval = Math.max(1, Math.floor(points.length / 5));

  function fmtTokShort(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString(); }

  const latest = values[values.length - 1];
  const earliest = values[0];
  const delta = latest - earliest;
  const deltaPct = earliest > 0 ? ((delta / earliest) * 100).toFixed(1) : '0';
  const deltaColor = delta > 0 ? '#ef4444' : delta < 0 ? '#10b981' : '#94a3b8';
  const deltaSign = delta > 0 ? '+' : '';

  let gridLines = '';
  for (const v of yTicks) {
    gridLines += `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${yScale(v).toFixed(1)}" y2="${yScale(v).toFixed(1)}" stroke="#e2e8f0" stroke-width="0.5"/>`;
    gridLines += `<text x="${PAD.left - 6}" y="${(yScale(v) + 3).toFixed(1)}" text-anchor="end" fill="#94a3b8" font-size="9">${fmtTokShort(Math.round(v))}</text>`;
  }

  let dataDots = '';
  const dotR = points.length > 30 ? 1.5 : 3;
  for (let i = 0; i < points.length; i++) {
    dataDots += `<circle cx="${xScale(i).toFixed(1)}" cy="${yScale(points[i].always_loaded_tokens).toFixed(1)}" r="${dotR}" fill="#6366f1"/>`;
  }

  let xLabels = '';
  for (let i = 0; i < points.length; i++) {
    if (i % labelInterval === 0 || i === points.length - 1) {
      const d = new Date(points[i].snapshot_date + 'T00:00:00');
      xLabels += `<text x="${xScale(i).toFixed(1)}" y="${H - 5}" text-anchor="middle" fill="#94a3b8" font-size="9">${d.getMonth() + 1}/${d.getDate()}</text>`;
    }
  }

  return `
    <div style="border:1px solid var(--border,#e2e0db);border-radius:12px;padding:1.25rem;background:var(--bg-card,#fff);margin-bottom:1.5rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
        <div>
          <h3 style="font-size:0.875rem;font-weight:600;color:var(--text,#1e1e1e);margin:0;">Always-Loaded Tokens — Last 90 Days</h3>
          <p style="color:var(--text-muted,#aaa);font-size:0.75rem;margin:0.125rem 0 0;">${points.length} data points</p>
        </div>
        <div style="text-align:right;">
          <div style="font-size:1.125rem;font-weight:700;color:var(--text,#1e1e1e);font-variant-numeric:tabular-nums;">${fmtTokShort(latest)}</div>
          <div style="font-size:0.75rem;font-weight:500;color:${deltaColor};font-variant-numeric:tabular-nums;">${deltaSign}${fmtTokShort(delta)} (${deltaSign}${deltaPct}%)</div>
        </div>
      </div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-height:200px;">
        ${gridLines}
        <defs><linearGradient id="ctxAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6366f1" stop-opacity="0.15"/><stop offset="100%" stop-color="#6366f1" stop-opacity="0.02"/></linearGradient></defs>
        <path d="${area}" fill="url(#ctxAreaGrad)"/>
        <path d="${line}" fill="none" stroke="#6366f1" stroke-width="2" stroke-linejoin="round"/>
        ${dataDots}
        ${xLabels}
      </svg>
    </div>`;
}

async function loadContext() {
  const panel = document.getElementById('dc-panel-context');
  panel.innerHTML = '<div class="dc-empty">Loading file sizes...</div>';

  const CONTEXT_FILES = [
    { name: 'Global CLAUDE.md', path: '~/.claude/CLAUDE.md', category: 'instructions',
      desc: 'User\'s private global instructions for all projects. Contains project identity checks (keyword-to-directory mapping), Bitwarden CLI unlock helpers, and gstack skill routing. Loaded in every session regardless of project.' },
    { name: 'Project CLAUDE.md', path: './CLAUDE.md', category: 'instructions', gh: 'CLAUDE.md',
      desc: 'Project-specific directives and code guards for AlpacApps. Defines mandatory behaviors (version stamping, push-on-change, CI versioning), code guards (media_spaces naming, showToast, Tailwind aap-* tokens, hero banner protection), on-demand doc loading triggers, and quick refs for the tech stack (Vanilla HTML/JS, Tailwind v4, Supabase, GitHub Pages, Capacitor 8).' },
    { name: 'CLAUDE.local.md', path: './CLAUDE.local.md', category: 'instructions',
      desc: 'Local overrides not committed to the repo. Contains machine-specific settings, experimental flags, or temporary behavioral overrides that only apply to one developer\'s environment. Loaded at startup but invisible to other contributors.' },
    { name: 'MEMORY.md', path: 'memory/MEMORY.md', category: 'memory',
      desc: 'Persistent memory index that carries context across conversations. Contains home automation endpoints (Sonos, WiZ lights, Music Assistant), data lookup routing (which Supabase table answers which question), quick DB query templates, SSH access gotchas, and pointers to detailed memory files for sessions, service access, and cloud infrastructure.' },
    { name: 'System prompt', path: '(built-in)', category: 'system',
      desc: 'Claude\'s built-in system prompt including tool definitions, environment detection, safety guidelines, and behavioral instructions. This is fixed by Anthropic and not editable. It defines how Claude reasons, uses tools, handles permissions, and interacts with the filesystem. Always present in every conversation.' },
    { name: 'SCHEMA.md', path: 'devdocs/SCHEMA.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/SCHEMA.md',
      desc: 'Complete Supabase database schema reference. Documents every table (spaces, people, assignments, password_vault, nest_devices, vehicles, camera_streams, stripe_payments, sms_messages, inbound_emails, amazon_orders, etc.), their columns, types, foreign keys, RLS policies, and indexes. Essential for writing correct SQL queries, debugging data issues, and understanding entity relationships.' },
    { name: 'PATTERNS.md', path: 'devdocs/PATTERNS.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/PATTERNS.md',
      desc: 'UI development patterns and Tailwind styling conventions. Defines the aap-* design token system (colors, spacing, typography, border radius), component patterns (cards, modals, toasts, tables, lightbox), shared JS utilities (showToast, openLightbox, initAdminPage), responsive breakpoints, and testing checklists. The authoritative guide for writing frontend code that matches the existing design system.' },
    { name: 'KEY-FILES.md', path: 'devdocs/KEY-FILES.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/KEY-FILES.md',
      desc: 'Project structure and file location index. Maps the full directory tree — shared/ (auth, navigation, Supabase client), spaces/admin/ (management dashboards), jackie/ (property management pages), residents/ (tenant-facing views), vendor/ (third-party libs), edge functions, and static assets. Use this to find where code lives before making changes.' },
    { name: 'DEPLOY.md', path: 'devdocs/DEPLOY.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/DEPLOY.md',
      desc: 'Deployment pipeline documentation. Covers the GitHub Pages deploy flow (push to main triggers build), CI version bumping (automated vYYMMDD.NN format), edge function deployment via Supabase CLI, DNS/domain configuration, cache invalidation, and rollback procedures. Read this before pushing changes or troubleshooting deploy failures.' },
    { name: 'INTEGRATIONS.md', path: 'devdocs/INTEGRATIONS.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/INTEGRATIONS.md',
      desc: 'External API and vendor integration reference. Documents Supabase (auth, storage, realtime, edge functions), Stripe (payments, webhooks), Telnyx (SMS), Resend (email), Google (OAuth, Maps), Nest (thermostats), Tesla (vehicles), UniFi (cameras, sensors), Govee/WiZ (smart lights), LG (appliances), and Capacitor (mobile). Includes API keys location, webhook URLs, rate limits, and pricing notes.' },
    { name: 'CHANGELOG.md', path: 'devdocs/CHANGELOG.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/CHANGELOG.md',
      desc: 'Chronological record of significant changes, features, and fixes. Organized by date with version numbers, affected files, and migration notes. Use this to understand what changed recently, why a migration was done, or what context led to a particular architectural decision. Critical for onboarding and debugging regressions.' },
    { name: 'CAD.md', path: 'devdocs/CAD.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/CAD.md',
      desc: 'CAD and 3D modeling tool reference for the property site plan system. Documents installed software on Alpuca (192.168.1.200): Blender 4.5.7 (3D modeling, rendering, Grease Pencil drafting), QGIS 4.0.0 (GIS parcel data, map composition), LibreCAD 2.x (2D DXF drafting), GDAL 3.12.0 (format conversion). Lists Blender add-ons (Bonsai/BlenderBIM, BlenderGIS, CAD Sketcher, Archipack, MeasureIt-ARCH), GIS data sources for Bastrop County, and quick-start workflows for site plans, 2D drafting, and headless rendering.' },
    { name: 'CAD-SITE-PLANS.md', path: 'devdocs/CAD-SITE-PLANS.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/CAD-SITE-PLANS.md',
      desc: 'End-to-end site plan generation guide for 160 Still Forest Drive, Cedar Creek TX (Bastrop County). Covers the two-machine pipeline (Almaca design workstation + Hostinger VPS automation backend), all deliverables (county permit sheets, 3D renders, interactive maps, automated permit packets), step-by-step workflows (QGIS base map → Blender 3D scene → BlenderBIM permit sheets → presentation renders → packet assembly), GIS data sources (TNRIS, USGS 3DEP LiDAR, FEMA flood, TCEQ environmental), and AlpacApps integration plans (live property map, on-demand render API, automated permit packet generation).' },
    { name: 'CAD-RENDER-PIPELINE.md', path: 'devdocs/CAD-RENDER-PIPELINE.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/CAD-RENDER-PIPELINE.md',
      desc: '3D property rendering pipeline for 160 Still Forest Drive. Covers photorealistic render workflow using Blender 4.5 + add-ons, QGIS 4.0, and GDAL on Alpuca (192.168.1.200). Documents on-site data collection tasks (drone photography, LiDAR scanning, reference photos), scene assembly, material libraries, lighting rigs, and render output formats. Loaded when working on 3D property renders or on-site data collection tasks.' },
    { name: 'HOMEAUTOMATION.md', path: 'devdocs/HOMEAUTOMATION.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/HOMEAUTOMATION.md',
      desc: 'Comprehensive smart home reference for Alpaca Playhouse. Documents all Home Assistant (HAOS) setup on 192.168.1.39, device integrations (Nest thermostats, Tesla vehicles, UniFi cameras/sensors, LG appliances, Sonos speakers), MQTT/Zigbee/WiFi device management, automation rules, Paca Mac Mini migration plans, and SSH access patterns via the alpuca wrapper script. Loaded when controlling devices, debugging automations, or managing smart home infrastructure.' },
    { name: 'LIGHTINGAUTOMATION.md', path: 'devdocs/LIGHTINGAUTOMATION.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/LIGHTINGAUTOMATION.md',
      desc: 'Smart lighting control reference for all rooms at Alpaca Playhouse. Documents WiZ, Govee, and Tuya light entities in HAOS, room-by-room entity IDs, brightness/color commands via the alpuca ha wrapper, scene definitions, and light group configurations. Loaded when controlling lights, changing colors/brightness, or debugging light entities. For non-lighting HAOS devices see HOMEAUTOMATION.md.' },
    { name: 'TESTING-GUIDE.md', path: 'devdocs/TESTING-GUIDE.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/TESTING-GUIDE.md',
      desc: 'Testing guide with test account credentials (testuser@alpacaplayhouse.com), auth architecture overview, and testing workflows for admin pages. Documents how to authenticate as a test user, role-based access patterns, and QA checklists for verifying UI changes. Loaded when testing admin pages, debugging auth issues, or running manual QA.' },
    { name: 'SECRETS-GUIDE.md', path: 'devdocs/SECRETS-GUIDE.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/SECRETS-GUIDE.md',
      desc: 'Cross-project secrets management guide using Bitwarden as the source of truth. Documents the bw-read helper script, Bitwarden CLI patterns (bw unlock, bw list items), secret naming conventions, how to store and retrieve API keys/tokens/passwords, and the DevOps-alpacapps vault organization. Replicable across all projects (alpacapps, finleg, portsie, etc.). Loaded when managing secrets, setting up new API keys, or debugging credential access.' },
    { name: 'ARCHITECTURE.md', path: 'ARCHITECTURE.md', category: 'docs', gh: 'ARCHITECTURE.md',
      desc: 'Comprehensive system architecture documentation. Covers the full AlpacApps stack — browser-only frontend, GitHub Pages hosting, Supabase backend (auth, storage, realtime, edge functions), module boundaries (spaces, residents, jackie, rahulio, community), shared utilities, and data flow patterns. Essential for understanding how components connect and where to make changes.' },
    { name: 'API.md', path: 'API.md', category: 'docs', gh: 'API.md',
      desc: 'Centralized REST API reference. Documents the single permissioned endpoint that handles all entity CRUD operations, request/response formats, authentication flow, RLS policy enforcement, and edge function signatures. Loaded when building or debugging API calls, edge functions, or REST endpoints.' },
    { name: 'PRODUCTDESIGN.md', path: 'PRODUCTDESIGN.md', category: 'docs', gh: 'PRODUCTDESIGN.md',
      desc: 'Product design decisions and the "why" behind how AlpacApps is built. Covers financial reasoning, user experience philosophy, business model choices, and design tradeoffs. Documents pricing strategy, feature prioritization rationale, and UX principles. Read alongside ARCHITECTURE.md for the full picture.' },
    { name: 'home-assistant-lighting-design.md', path: 'devdocs/home-assistant-lighting-design.md', category: 'docs', gh: 'spaces/admin/devcontrol/devdocs/home-assistant-lighting-design.md',
      desc: 'HAOS unified lighting architecture (canonical design doc). Documents the target state for all smart lighting control through Home Assistant, WiZ Proxy deprecation plan, entity naming conventions, automation templates, and room-by-room migration status. Loaded alongside LIGHTINGAUTOMATION.md for lighting architecture work.' },
  ];

  const SYSTEM_PROMPT_TOKENS = 8000;
  const CAT = {
    instructions: { label: 'Instructions', bar: '#3b82f6' },
    memory: { label: 'Memory', bar: '#8b5cf6' },
    docs: { label: 'On-Demand Docs', bar: '#d97706' },
    system: { label: 'System', bar: '#6b7280' },
  };

  // Fetch last 90 days of snapshots
  let snapshots = [];
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const { data } = await supabase
      .from('context_snapshots')
      .select('snapshot_date, always_loaded_tokens, total_tokens')
      .gte('snapshot_date', cutoff.toISOString().split('T')[0])
      .order('snapshot_date');
    if (data) snapshots = data;
  } catch {}

  const items = await Promise.all(CONTEXT_FILES.map(async (f) => {
    if (f.category === 'system') return { ...f, tokens: SYSTEM_PROMPT_TOKENS };
    if (f.gh) {
      try {
        const res = await fetch(`${RAW_BASE}/main/${f.gh}`);
        if (res.ok) { const text = await res.text(); return { ...f, tokens: charsToTokens(text.length) }; }
      } catch {}
    }
    const estimates = { 'Global CLAUDE.md': 1048, 'CLAUDE.local.md': 800, 'MEMORY.md': 600 };
    return { ...f, tokens: charsToTokens(estimates[f.name] || 200) };
  }));

  const alwaysLoaded = items.filter((i) => i.category !== 'docs');
  const onDemand = items.filter((i) => i.category === 'docs');
  const alwaysTokens = alwaysLoaded.reduce((s, i) => s + i.tokens, 0);
  const onDemandTokens = onDemand.reduce((s, i) => s + i.tokens, 0);
  const totalTokens = alwaysTokens + onDemandTokens;
  const alwaysPct = ((alwaysTokens / CONTEXT_WINDOW) * 100).toFixed(1);
  const totalPct = ((totalTokens / CONTEXT_WINDOW) * 100).toFixed(1);

  // Record today's snapshot
  try {
    const breakdown = {};
    for (const i of items) breakdown[i.category] = (breakdown[i.category] || 0) + i.tokens;
    await supabase.from('context_snapshots').upsert(
      { snapshot_date: new Date().toISOString().split('T')[0], always_loaded_tokens: alwaysTokens, total_tokens: totalTokens, breakdown },
      { onConflict: 'snapshot_date' }
    );
  } catch {}

  const catTotals = {};
  for (const i of items) catTotals[i.category] = (catTotals[i.category] || 0) + i.tokens;
  const catSorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);

  function fmtTok(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString(); }

  // Cache for fetched file contents
  const contentCache = {};

  // Lookup helper: find a CONTEXT_FILES entry by name
  const fileByName = {};
  for (const f of items) fileByName[f.name] = f;

  // Shared expand/collapse for any file node
  // Load docs-viewer.css once for rendered HTML companions
  if (!document.getElementById('docs-viewer-css')) {
    const link = document.createElement('link');
    link.id = 'docs-viewer-css';
    link.rel = 'stylesheet';
    link.href = '/devdocs/rendered/docs-viewer.css';
    document.head.appendChild(link);
  }

  window._toggleCtxNode = async function(el) {
    const ghPath = el.getAttribute('data-gh');
    const contentDiv = el.nextElementSibling;
    if (!contentDiv || !contentDiv.classList.contains('dc-ctx-content')) return;
    const arrow = el.querySelector('.dc-ctx-arrow');
    const isOpen = contentDiv.style.display !== 'none';
    if (isOpen) {
      contentDiv.style.display = 'none';
      if (arrow) arrow.style.transform = 'rotate(0deg)';
      return;
    }
    contentDiv.style.display = '';
    if (arrow) arrow.style.transform = 'rotate(90deg)';
    if (!ghPath) return;
    if (contentCache[ghPath]) { contentDiv.querySelector('.dc-file-preview').innerHTML = contentCache[ghPath]; return; }
    const previewDiv = contentDiv.querySelector('.dc-file-preview');
    previewDiv.innerHTML = '<div class="dc-empty" style="padding:0.75rem;">Loading...</div>';

    // Try rendered HTML companion first, then fall back to raw markdown
    const mdName = ghPath.split('/').pop();
    const htmlName = mdName.replace('.md', '.html');
    const renderedUrl = `/devdocs/rendered/${htmlName}`;
    try {
      const renderedRes = await fetch(renderedUrl);
      if (renderedRes.ok) {
        const html = await renderedRes.text();
        contentCache[ghPath] = html;
        previewDiv.innerHTML = html;
        // Also fetch raw for search cache
        fetch(`${RAW_BASE}/main/${ghPath}`).then(r => r.ok ? r.text() : '').then(t => {
          if (t) { window._ctxRawCache = window._ctxRawCache || {}; window._ctxRawCache[ghPath] = t; }
        }).catch(() => {});
        return;
      }
    } catch {}

    // Fallback: render markdown inline
    try {
      const res = await fetch(`${RAW_BASE}/main/${ghPath}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const text = await res.text();
      window._ctxRawCache = window._ctxRawCache || {};
      window._ctxRawCache[ghPath] = text;
      const lines = text.split('\n');
      const preview = lines.slice(0, 150).join('\n');
      const truncated = lines.length > 150;
      const truncNote = truncated ? `<p style="color:var(--text-muted,#888);font-size:0.7rem;font-style:italic;padding:0 1rem 0.5rem;">... ${lines.length - 150} more lines — <a href="https://github.com/${GH_OWNER}/${GH_REPO}/blob/main/${ghPath}" target="_blank" style="color:var(--accent,#b8a88a);">view full file on GitHub</a></p>` : '';
      const html = renderMd(preview) + truncNote;
      contentCache[ghPath] = html;
      previewDiv.innerHTML = html;
    } catch (err) {
      previewDiv.innerHTML = `<div class="dc-empty" style="padding:0.75rem;color:#c62828;">Failed to load: ${esc(err.message)}</div>`;
    }
  };

  // Build a tree node for a single file
  function treeNode(name, hint) {
    const f = fileByName[name];
    const catColors = { instructions: '#3b82f6', memory: '#8b5cf6', system: '#6b7280', docs: '#d97706' };
    const color = f ? (catColors[f.category] || '#d97706') : '#999';
    const tokens = f ? f.tokens : 0;
    const ghAttr = f && f.gh ? `data-gh="${esc(f.gh)}"` : '';
    const canExpand = f && f.gh;
    const hintSpan = hint ? `<span style="color:var(--text-muted,#999);font-weight:400;margin-left:0.375rem;font-size:0.6875rem;">${hint}</span>` : '';
    const tokPill = tokens ? `<span style="font-size:0.65rem;color:var(--text-muted,#aaa);margin-left:0.5rem;font-variant-numeric:tabular-nums;">${fmtTok(tokens)}</span>` : '';

    return `
      <div class="dc-ctx-node${canExpand ? ' dc-ctx-clickable' : ''}" ${ghAttr} ${canExpand ? 'onclick="window._toggleCtxNode(this)"' : ''}>
        ${canExpand ? '<span class="dc-ctx-arrow">&#9654;</span>' : '<span style="display:inline-block;width:14px;"></span>'}
        <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0;"></span>
        <span class="mono" style="font-weight:600;font-size:0.8125rem;">${esc(name)}</span>${tokPill}${hintSpan}
      </div>
      ${canExpand ? `<div class="dc-ctx-content" style="display:none;"><div class="dc-file-preview" style="margin:0.25rem 0 0.5rem 1.5rem;"><div class="dc-empty" style="padding:0.5rem;font-size:0.75rem;">Click to load...</div></div></div>` : ''}`;
  }

  function renderContextTree() {
    // folder toggle handler
    window._toggleFolder = function(el) {
      const children = el.closest('.dc-ctx-item').querySelector('.dc-ctx-children');
      if (!children) return;
      const open = children.style.display !== 'none';
      children.style.display = open ? 'none' : 'block';
      const arrow = el.querySelector('.dc-ctx-folder-arrow');
      if (arrow) arrow.style.transform = open ? 'rotate(0deg)' : 'rotate(90deg)';
    };

    function folder(name, children, open = true) {
      return `
        <div class="dc-ctx-item">
          <div class="dc-ctx-folder dc-ctx-clickable" onclick="window._toggleFolder(this)">
            <span class="dc-ctx-folder-arrow" style="transform:${open ? 'rotate(90deg)' : 'rotate(0deg)'}">&#9654;</span>
            <span style="font-size:0.75rem;">&#128193;</span>
            <span class="mono" style="font-weight:600;font-size:0.8125rem;">${esc(name)}</span>
          </div>
          <div class="dc-ctx-children" style="display:${open ? 'block' : 'none'};">
            ${children}
          </div>
        </div>`;
    }

    function leaf(name, hint) {
      return `<div class="dc-ctx-item">${treeNode(name, hint)}</div>`;
    }

    return `
      <style>
        .dc-ctx-tree { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 0.8125rem; }
        .dc-ctx-tree .dc-ctx-group { font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted, #aaa); margin: 1.25rem 0 0.375rem; padding-bottom: 0.25rem; border-bottom: 1px solid var(--border, #e2e0db); }
        .dc-ctx-tree .dc-ctx-group:first-child { margin-top: 0; }
        .dc-ctx-tree .dc-ctx-item { position: relative; padding: 0.125rem 0 0.125rem 1.25rem; }
        .dc-ctx-tree .dc-ctx-item::before { content: ''; position: absolute; left: 0.25rem; top: 0; bottom: 0; width: 1px; border-left: 1px solid var(--border, #ddd); }
        .dc-ctx-tree .dc-ctx-item::after { content: ''; position: absolute; left: 0.25rem; top: 0.85rem; width: 0.65rem; height: 1px; border-bottom: 1px solid var(--border, #ddd); }
        .dc-ctx-tree .dc-ctx-item:last-child::before { height: 0.85rem; }
        .dc-ctx-tree .dc-ctx-node { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.2rem 0.4rem; border-radius: 6px; }
        .dc-ctx-tree .dc-ctx-folder { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.2rem 0.4rem; border-radius: 6px; }
        .dc-ctx-tree .dc-ctx-folder-arrow { display: inline-block; width: 14px; font-size: 0.55rem; color: var(--text-muted, #888); transition: transform 0.15s; flex-shrink: 0; }
        .dc-ctx-clickable { cursor: pointer; transition: background 0.1s; }
        .dc-ctx-clickable:hover { background: var(--bg-subtle, #f5f4f0); }
        .dc-ctx-arrow { display: inline-block; width: 14px; font-size: 0.55rem; color: var(--text-muted, #888); transition: transform 0.15s; flex-shrink: 0; }
        .dc-ctx-content { overflow: hidden; }
        .dc-ctx-content .dc-file-preview { max-height: 600px; overflow: auto; border: 1px solid var(--border, #e2e0db); border-radius: 8px; background: var(--bg-subtle, #faf9f6); }
        .dc-ctx-content .dc-file-preview h1 { font-size: 0.95rem; margin: 0.5rem 0 0.25rem; }
        .dc-ctx-content .dc-file-preview h2 { font-size: 0.85rem; margin: 0.4rem 0 0.2rem; }
        .dc-ctx-content .dc-file-preview h3 { font-size: 0.8rem; margin: 0.3rem 0 0.15rem; }
        .dc-ctx-content .dc-file-preview h4, .dc-ctx-content .dc-file-preview h5, .dc-ctx-content .dc-file-preview h6 { font-size: 0.75rem; margin: 0.25rem 0 0.1rem; }
        .dc-ctx-content .dc-file-preview p, .dc-ctx-content .dc-file-preview li, .dc-ctx-content .dc-file-preview td { font-size: 0.75rem; line-height: 1.5; }
        .dc-ctx-content .dc-file-preview blockquote { font-size: 0.73rem; }
        .dc-ctx-content .dc-file-content { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 0.7rem; line-height: 1.55; white-space: pre-wrap; word-break: break-word; padding: 1rem; margin: 0; }
        .dc-ctx-tree .dc-ctx-children { margin-left: 0; }
      </style>
      <div class="dc-ctx-tree">

        <div class="dc-ctx-group">Always Loaded</div>
        <div style="padding:0;">
          ${leaf('System prompt', 'Claude built-in context')}
          ${folder('~/.claude/', leaf('Global CLAUDE.md', 'user-level rules, all projects'))}
          ${leaf('Project CLAUDE.md', 'project directives — triggers on-demand loading')}
          ${leaf('CLAUDE.local.md', 'local overrides, not in git')}
          ${folder('memory/', leaf('MEMORY.md', 'persistent memory index'))}
        </div>

        <div class="dc-ctx-group">On-Demand Docs</div>
        <div style="padding:0;">
          ${leaf('ARCHITECTURE.md', 'system architecture, component relationships')}
          ${leaf('API.md', 'REST endpoints, edge functions')}
          ${leaf('PRODUCTDESIGN.md', 'product decisions, UX philosophy')}
          ${folder('devdocs/', [
            folder('schema & data', [
              leaf('SCHEMA.md', 'queries, tables, debugging data'),
              leaf('CREDENTIALS.md', 'SQL, SSH, API keys'),
              leaf('SECRETS-GUIDE.md', 'Bitwarden, secret management'),
            ].join(''), true),
            folder('architecture & patterns', [
              leaf('PATTERNS.md', 'UI code, Tailwind tokens, components'),
              leaf('KEY-FILES.md', 'file search, project structure'),
            ].join(''), true),
            folder('deploy & ops', [
              leaf('DEPLOY.md', 'pushing, deploying, version questions'),
              leaf('INTEGRATIONS.md', 'external APIs, vendor setup'),
              leaf('CHANGELOG.md', 'recent changes, migration context'),
              leaf('TESTING-GUIDE.md', 'test accounts, QA workflows'),
            ].join(''), true),
            folder('smart home', [
              leaf('HOMEAUTOMATION.md', 'HAOS, devices, automations'),
              leaf('LIGHTINGAUTOMATION.md', 'lighting entities, commands'),
              leaf('home-assistant-lighting-design.md', 'canonical lighting architecture'),
            ].join(''), true),
            folder('CAD & property', [
              leaf('CAD.md', 'Blender, QGIS, 3D modeling'),
              leaf('CAD-SITE-PLANS.md', 'site plan workflows, GIS data'),
              leaf('CAD-RENDER-PIPELINE.md', '3D renders, on-site data collection'),
            ].join(''), false),
          ].join(''), true)}
        </div>

      </div>`;
  }

  // ── Simple markdown → HTML renderer ──
  function renderMd(src) {
    let html = esc(src);
    // fenced code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre style="background:var(--bg-code,#1e1e1e);color:#d4d4d4;padding:0.75rem;border-radius:6px;overflow-x:auto;font-size:0.7rem;line-height:1.5;margin:0.5rem 0;">${code.trim()}</pre>`);
    // inline code
    html = html.replace(/`([^`]+)`/g, '<code style="background:var(--bg-subtle,#f0efe9);padding:0.1rem 0.3rem;border-radius:3px;font-size:0.7rem;">$1</code>');
    // headings
    html = html.replace(/^#### (.+)$/gm, '<h4 style="font-size:0.75rem;margin:0.4rem 0 0.15rem;font-weight:600;">$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3 style="font-size:0.8rem;margin:0.5rem 0 0.2rem;font-weight:600;">$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2 style="font-size:0.85rem;margin:0.6rem 0 0.25rem;font-weight:600;">$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1 style="font-size:0.95rem;margin:0.75rem 0 0.3rem;font-weight:700;">$1</h1>');
    // bold & italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:3px solid var(--border,#ddd);padding-left:0.75rem;margin:0.3rem 0;color:var(--text-muted,#888);font-size:0.73rem;">$1</blockquote>');
    // unordered lists
    html = html.replace(/^- (.+)$/gm, '<li style="font-size:0.75rem;margin-left:1.25rem;list-style:disc;">$1</li>');
    // horizontal rule
    html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--border,#ddd);margin:0.5rem 0;">');
    // links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--accent,#b8a88a);">$1</a>');
    // paragraphs — wrap remaining lines
    html = html.replace(/\n\n/g, '</p><p style="font-size:0.75rem;line-height:1.55;margin:0.3rem 0;">');
    return `<div style="padding:0.75rem 1rem;font-size:0.75rem;line-height:1.55;"><p style="font-size:0.75rem;line-height:1.55;margin:0.3rem 0;">${html}</p></div>`;
  }

  // ── All Project .md Files — searchable reference ──
  let allMdFiles = null; // lazy loaded
  const allMdCache = {}; // path → raw text

  function renderAllFilesSection() {
    return `
      <h3 class="dc-section-header" style="margin-top:2rem;">All Project .md Files</h3>
      <p class="dc-section-sub">Every markdown file in the repo — searchable by keyword</p>
      <div class="dc-filters" style="margin-bottom:0.75rem;">
        <input type="text" id="dc-ctx-search" placeholder="Search across all .md files...">
        <button class="dc-btn-primary" id="dc-ctx-search-go">Search</button>
        <button class="dc-btn-secondary" id="dc-ctx-search-clear">Clear</button>
      </div>
      <div id="dc-ctx-all-files"><div class="dc-empty" style="padding:1.5rem;">Loading file index...</div></div>`;
  }

  async function initAllFilesSearch(panel) {
    const container = panel.querySelector('#dc-ctx-all-files');
    const searchInput = panel.querySelector('#dc-ctx-search');
    const searchBtn = panel.querySelector('#dc-ctx-search-go');
    const clearBtn = panel.querySelector('#dc-ctx-search-clear');
    if (!container || !searchInput) return;

    // Fetch file tree from GitHub API
    if (!allMdFiles) {
      try {
        const res = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/trees/main?recursive=1`);
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        allMdFiles = (data.tree || [])
          .filter(f => f.type === 'blob' && f.path.endsWith('.md') && !f.path.startsWith('mistiq/') && !f.path.startsWith('node_modules/') && !f.path.startsWith('.claude/'))
          .map(f => f.path)
          .sort();
      } catch (err) {
        container.innerHTML = `<div class="dc-empty" style="color:#c62828;">Failed to load file index: ${esc(err.message)}</div>`;
        return;
      }
    }

    function renderFileList(files, highlights) {
      if (files.length === 0) return '<div class="dc-empty" style="padding:1rem;">No matching files found.</div>';
      return `<div class="dc-table-wrap"><table class="dc-table">
        <thead><tr><th>File</th><th>Path</th>${highlights ? '<th>Matches</th>' : ''}</tr></thead>
        <tbody>${files.map((fpath, idx) => {
          const name = fpath.split('/').pop();
          const isContext = items.some(i => i.gh === fpath);
          const contextBadge = isContext ? '<span style="font-size:0.6rem;background:#e8f0e8;color:#3a6b3a;padding:0.1rem 0.35rem;border-radius:4px;margin-left:0.35rem;font-weight:600;">IN CONTEXT</span>' : '';
          const matchSnippets = highlights && highlights[fpath] ? highlights[fpath] : '';
          const expandId = `allmd-${idx}`;
          return `
            <tr class="dc-expandable-row" data-gh="${esc(fpath)}" data-expand-id="${expandId}" onclick="window._toggleAllMdRow(this)" style="cursor:pointer;">
              <td><span class="dc-expand-arrow" style="display:inline-block;width:12px;margin-right:4px;font-size:0.6rem;color:var(--text-muted,#888);transition:transform 0.15s;">&#9654;</span><span class="mono" style="font-weight:500;">${esc(name)}</span>${contextBadge}</td>
              <td style="color:var(--text-muted,#888);font-size:0.75rem;">${esc(fpath)}</td>
              ${highlights ? `<td style="font-size:0.7rem;color:var(--text-muted,#888);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${matchSnippets}</td>` : ''}
            </tr>
            <tr id="${expandId}" class="dc-expand-content" style="display:none;">
              <td colspan="${highlights ? 3 : 2}" style="padding:0;">
                <div class="dc-file-preview" style="max-height:500px;overflow:auto;"><div class="dc-empty" style="padding:0.75rem;font-size:0.75rem;">Click to load...</div></div>
              </td>
            </tr>`;
        }).join('')}
        </tbody></table></div>
        <p style="font-size:0.7rem;color:var(--text-muted,#aaa);margin-top:0.5rem;">${files.length} file${files.length !== 1 ? 's' : ''}</p>`;
    }

    // Show full list initially
    container.innerHTML = renderFileList(allMdFiles);

    // Expand handler for all-md rows
    window._toggleAllMdRow = async function(tr) {
      const expandId = tr.getAttribute('data-expand-id');
      const ghPath = tr.getAttribute('data-gh');
      const expandRow = document.getElementById(expandId);
      const arrow = tr.querySelector('.dc-expand-arrow');
      if (!expandRow) return;
      const isOpen = expandRow.style.display !== 'none';
      if (isOpen) { expandRow.style.display = 'none'; if (arrow) arrow.style.transform = 'rotate(0deg)'; return; }
      expandRow.style.display = '';
      if (arrow) arrow.style.transform = 'rotate(90deg)';
      const previewDiv = expandRow.querySelector('.dc-file-preview');
      if (allMdCache[ghPath]) { previewDiv.innerHTML = allMdCache[ghPath]; return; }
      previewDiv.innerHTML = '<div class="dc-empty" style="padding:0.75rem;">Loading...</div>';

      // Try rendered HTML companion first
      const mdName = ghPath.split('/').pop();
      const htmlName = mdName.replace('.md', '.html');
      const renderedUrl = `/spaces/admin/devcontrol/devdocs/rendered/${htmlName}`;
      try {
        const renderedRes = await fetch(renderedUrl);
        if (renderedRes.ok) {
          const rhtml = await renderedRes.text();
          allMdCache[ghPath] = rhtml;
          previewDiv.innerHTML = rhtml;
          fetch(`${RAW_BASE}/main/${ghPath}`).then(r => r.ok ? r.text() : '').then(t => {
            if (t) { window._ctxRawCache = window._ctxRawCache || {}; window._ctxRawCache[ghPath] = t; }
          }).catch(() => {});
          return;
        }
      } catch {}

      // Fallback: fetch raw markdown and render it
      try {
        const res = await fetch(`${RAW_BASE}/main/${ghPath}`);
        if (!res.ok) throw new Error(`${res.status}`);
        const text = await res.text();
        window._ctxRawCache = window._ctxRawCache || {};
        window._ctxRawCache[ghPath] = text;
        const lines = text.split('\n');
        const preview = lines.slice(0, 150).join('\n');
        const truncated = lines.length > 150;
        const truncNote = truncated ? `<p style="color:var(--text-muted,#888);font-size:0.7rem;font-style:italic;padding:0 1rem 0.5rem;">... ${lines.length - 150} more lines — <a href="https://github.com/${GH_OWNER}/${GH_REPO}/blob/main/${ghPath}" target="_blank" style="color:var(--accent,#b8a88a);">view full file on GitHub</a></p>` : '';
        const html = renderMd(preview) + truncNote;
        allMdCache[ghPath] = html;
        previewDiv.innerHTML = html;
      } catch (err) {
        previewDiv.innerHTML = `<div class="dc-empty" style="padding:0.75rem;color:#c62828;">Failed: ${esc(err.message)}</div>`;
      }
    };

    // Search handler
    async function doSearch() {
      const query = searchInput.value.trim().toLowerCase();
      if (!query) { container.innerHTML = renderFileList(allMdFiles); return; }
      container.innerHTML = '<div class="dc-empty" style="padding:1.5rem;">Searching...</div>';

      // Fetch all files that aren't cached yet (batch fetch)
      const toFetch = allMdFiles.filter(p => !window._ctxRawCache?.[p]);
      window._ctxRawCache = window._ctxRawCache || {};
      if (toFetch.length > 0) {
        const batchSize = 10;
        for (let i = 0; i < toFetch.length; i += batchSize) {
          const batch = toFetch.slice(i, i + batchSize);
          await Promise.all(batch.map(async (p) => {
            try {
              const res = await fetch(`${RAW_BASE}/main/${p}`);
              if (res.ok) window._ctxRawCache[p] = await res.text();
            } catch {}
          }));
          container.querySelector('.dc-empty').textContent = `Searching... (${Math.min(i + batchSize, toFetch.length)}/${toFetch.length} files loaded)`;
        }
      }

      // Search across all cached content
      const matchingFiles = [];
      const highlights = {};
      const terms = query.split(/\s+/);
      for (const fpath of allMdFiles) {
        const text = window._ctxRawCache[fpath];
        if (!text) continue;
        const lower = text.toLowerCase();
        if (terms.every(t => lower.includes(t))) {
          matchingFiles.push(fpath);
          // Find first matching line for snippet
          const lines = text.split('\n');
          const snippets = [];
          for (let i = 0; i < lines.length && snippets.length < 3; i++) {
            const ll = lines[i].toLowerCase();
            if (terms.some(t => ll.includes(t))) {
              const lineNum = i + 1;
              let snip = lines[i].trim().slice(0, 80);
              // Bold the matching terms
              for (const t of terms) {
                snip = snip.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<strong style="color:var(--text,#1a1a1a);">$1</strong>');
              }
              snippets.push(`<span style="color:var(--text-muted,#aaa);">L${lineNum}:</span> ${snip}`);
            }
          }
          highlights[fpath] = snippets.join('<br>');
        }
      }
      container.innerHTML = renderFileList(matchingFiles, highlights);
    }

    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    clearBtn.addEventListener('click', () => { searchInput.value = ''; container.innerHTML = renderFileList(allMdFiles); });
  }

  panel.innerHTML = `
    <h2 style="font-size:1.375rem;font-weight:700;margin-bottom:0.25rem;">Context Window</h2>
    <p style="color:var(--text-muted,#888);font-size:0.8125rem;margin-bottom:1.25rem;">${fmtTok(alwaysTokens)} tokens loaded on startup (${alwaysPct}% of ${fmtTok(CONTEXT_WINDOW)} window)</p>

    ${renderTokenHistoryChart(snapshots, alwaysTokens)}

    <div class="dc-context-bar-wrap">
      <div class="dc-context-bar-header"><span>Context Window Usage</span><span>${fmtTok(CONTEXT_WINDOW)} total capacity</span></div>
      <div class="dc-context-bar">
        ${catSorted.map(([cat, tokens]) => `<div style="width:${(tokens / CONTEXT_WINDOW) * 100}%;height:100%;background:${CAT[cat]?.bar || '#999'}" title="${CAT[cat]?.label}: ${fmtTok(tokens)} tokens"></div>`).join('')}
      </div>
      <div class="dc-context-legend">
        ${catSorted.map(([cat, tokens]) => `
          <div class="dc-context-legend-item">
            <div class="dc-context-legend-dot" style="background:${CAT[cat]?.bar || '#999'}"></div>
            <span style="font-weight:500;">${CAT[cat]?.label}</span>
            <span style="color:var(--text-muted,#aaa);">${fmtTok(tokens)} (${((tokens / CONTEXT_WINDOW) * 100).toFixed(1)}%)</span>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="dc-stats">
      <div class="dc-stat"><div class="dc-stat-value" style="color:#059669">${fmtTok(alwaysTokens)}</div><div class="dc-stat-label">Always Loaded</div><div class="dc-stat-sub">${alwaysPct}%</div></div>
      <div class="dc-stat"><div class="dc-stat-value" style="color:#d97706">${fmtTok(onDemandTokens)}</div><div class="dc-stat-label">On-Demand Docs</div><div class="dc-stat-sub">loaded as needed</div></div>
      <div class="dc-stat"><div class="dc-stat-value" style="color:#2563eb">${fmtTok(totalTokens)}</div><div class="dc-stat-label">Total if All Loaded</div><div class="dc-stat-sub">${totalPct}%</div></div>
      <div class="dc-stat"><div class="dc-stat-value" style="color:#7c3aed">${fmtTok(CONTEXT_WINDOW - alwaysTokens)}</div><div class="dc-stat-label">Remaining for Chat</div><div class="dc-stat-sub">${(100 - parseFloat(alwaysPct)).toFixed(1)}%</div></div>
    </div>

    <h3 class="dc-section-header">Context File Tree</h3>
    <p class="dc-section-sub">Click any file to expand and read its contents. Grouped by how Claude Code loads them.</p>
    <div class="dc-table-wrap" style="padding:1.25rem 1.25rem 0.75rem;overflow-x:auto;">
      ${renderContextTree()}
    </div>

    ${renderAllFilesSection()}`;

  // Initialize the search section after innerHTML is set
  initAllFilesSearch(panel);
}

// ═══════════════════════════════════════════════════════════
// BACKUPS TAB
// ═══════════════════════════════════════════════════════════

// Schedule helpers
function getNextOccurrence(dayOfWeek, hour, minute) {
  // dayOfWeek: 0=Sun, 1=Mon, ...
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  const daysUntil = (dayOfWeek - now.getDay() + 7) % 7;
  if (daysUntil === 0 && now >= target) target.setDate(target.getDate() + 7);
  else target.setDate(target.getDate() + daysUntil);
  return target;
}

function timeUntil(date) {
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `in ${Math.ceil(ms / 60000)}m`;
  if (h < 24) return `in ${h}h ${Math.floor((ms % 3600000) / 60000)}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return d === 1 ? `in 1 day, ${remH}h` : `in ${d} days, ${remH}h`;
}

function fmtScheduleDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

async function loadBackups() {
  const panel = document.getElementById('dc-panel-backups');
  panel.innerHTML = '<div class="dc-empty">Loading backup logs...</div>';

  const [rvaultResult, haosResult, triggersResult, recentTriggersResult, filesResult] = await Promise.allSettled([
    supabase.from('backup_logs').select('*').order('created_at', { ascending: false }).limit(50),
    supabase.from('haos_backups').select('*').order('date', { ascending: false }).limit(50),
    supabase.from('backup_triggers').select('*').in('status', ['pending', 'running']).order('requested_at', { ascending: false }),
    supabase.from('backup_triggers').select('*').in('status', ['completed', 'failed']).order('completed_at', { ascending: false }).limit(20),
    supabase.from('backup_files').select('*').order('backup_date', { ascending: false }).limit(100),
  ]);

  const logs = rvaultResult.status === 'fulfilled' && !rvaultResult.value.error ? rvaultResult.value.data || [] : [];
  const haosBackups = haosResult.status === 'fulfilled' && !haosResult.value.error ? haosResult.value.data || [] : [];
  const activeTriggers = triggersResult.status === 'fulfilled' && !triggersResult.value.error ? triggersResult.value.data || [] : [];
  const recentTriggers = recentTriggersResult.status === 'fulfilled' && !recentTriggersResult.value.error ? recentTriggersResult.value.data || [] : [];
  const rawBackupFiles = filesResult.status === 'fulfilled' && !filesResult.value.error ? filesResult.value.data || [] : [];
  // Deduplicate by filename (keep first = most recent by backup_date desc)
  const seenFilenames = new Set();
  const backupFiles = rawBackupFiles.filter(f => {
    if (!f.filename || seenFilenames.has(f.filename)) return false;
    seenFilenames.add(f.filename);
    return true;
  });

  const lastSyncMs = haosBackups.length ? Math.max(...haosBackups.map(b => new Date(b.synced_at).getTime())) : 0;
  function haosStillExists(b) {
    return lastSyncMs > 0 && (lastSyncMs - new Date(b.synced_at).getTime()) < 86400000;
  }

  function fmtSize(mb) {
    if (!mb && mb !== 0) return '—';
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${Number(mb).toFixed(1)} MB`;
  }

  function fmtShort(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
           new Date(dateStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function badge(label, color, bg) {
    return `<span class="dc-bk-badge" style="color:${color};background:${bg}">${esc(label)}</span>`;
  }

  const nextRvault = getNextOccurrence(1, 1, 0);
  const nextHaosApp = (() => {
    const now = new Date(); const t = new Date(now); t.setHours(2, 0, 0, 0);
    return now >= t ? new Date(t.getTime() + 86400000) : t;
  })();
  const nextHaosVm = (() => {
    const now = new Date(); const t = new Date(now); t.setHours(3, 17, 0, 0);
    return now >= t ? new Date(t.getTime() + 86400000) : t;
  })();

  // Build an instance table with optional row collapse beyond first 3
  function instanceTable(headers, rows, id) {
    if (!rows.length) return `<span class="dc-bk-none">No instances recorded</span>`;
    const thead = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
    const first3 = rows.slice(0, 3);
    const rest = rows.slice(3);
    const moreId = `dc-bk-more-${id}`;
    return `<table class="dc-bk-inst-table">
      ${thead}
      <tbody>${first3.join('')}</tbody>
      ${rest.length ? `<tbody id="${moreId}" style="display:none">${rest.join('')}</tbody>` : ''}
    </table>
    ${rest.length ? `<button class="dc-bk-more-btn" onclick="var b=document.getElementById('${moreId}');var s=b.style.display==='none';b.style.display=s?'':'none';this.textContent=s?'show less':'+ ${rest.length} more'">+ ${rest.length} more</button>` : ''}`;
  }

  // Format bytes to human-readable
  function fmtBytes(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
  }

  // Build rows for a service — uses backup_files table if populated, else falls back to backup_logs
  function rvaultRowsFor(key, folder, svcKey) {
    const svcFiles = backupFiles.filter(f => f.service === svcKey);

    // If we have file records from backup_files, show those
    if (svcFiles.length) {
      return svcFiles.map(f => {
        const copyPath = f.filepath || `/Volumes/RVAULT20/backups/alpacapps/${folder}/`;
        return `<tr>
          <td style="white-space:nowrap">${esc(fmtShort(f.backup_date))}</td>
          <td>${badge('exists','#2e7d32','#e8f5e9')}</td>
          <td style="font-weight:500">${esc(f.filename)}</td>
          <td>${esc(fmtBytes(f.size_bytes))}</td>
          <td><button class="dc-bk-copy-path" onclick="navigator.clipboard.writeText('${esc(copyPath)}');showToast('Path copied — paste in Finder ⌘⇧G')" title="${esc(copyPath)}">📋 ${esc(copyPath)}</button></td>
        </tr>`;
      });
    }

    // Fallback: use backup_logs details
    return logs.filter(l => l.backup_type === 'full-to-rvault').map(l => {
      const s = (l.details || {})[key];
      const statusBadge = !s ? badge('no data','#aaa','#f5f5f5') :
        s.status === 'success' ? badge('success','#2e7d32','#e8f5e9') :
        badge('error','#c62828','#ffebee');
      const detail = s?.detail;
      let detailStr = '—';
      if (detail && typeof detail === 'string') detailStr = esc(detail);
      else if (detail?.files != null) detailStr = `${detail.files} files`;
      else if (detail?.commits != null) detailStr = `${detail.commits} commits`;
      const size = esc(detail?.size || (key === 'supabase' && (l.details||{}).total_size ? (l.details||{}).total_size : '') || '—');
      const folderPath = `/Volumes/RVAULT20/backups/alpacapps/${folder}/`;
      return `<tr>
        <td style="white-space:nowrap">${esc(fmtShort(l.created_at))}</td>
        <td>${statusBadge}</td>
        <td style="color:var(--text-muted,#888)">${detailStr}</td>
        <td>${size}</td>
        <td><button class="dc-bk-copy-path" onclick="navigator.clipboard.writeText('${folderPath}');showToast('Path copied — paste in Finder ⌘⇧G')" title="${folderPath}">📋 ${folderPath}</button></td>
      </tr>`;
    });
  }

  // HAOS: one row per backup snapshot
  const haosRows = haosBackups.map(b => {
    const exists = haosStillExists(b);
    const existsBadge = exists ? badge('on HAOS','#2e7d32','#e8f5e9') : badge('deleted','#888','#f0ede8');
    const typeBadge = b.type === 'full' ? badge('full','#2e7d32','#e8f5e9') : badge(b.type || '—','#1565c0','#e3f2fd');
    const content = b.content || {};
    const parts = [];
    if (content.homeassistant) parts.push('HA Core');
    if (content.addons?.length) parts.push(`${content.addons.length} add-ons`);
    if (content.folders?.length) parts.push(`${content.folders.length} folders`);
    return `<tr>
      <td style="white-space:nowrap">${esc(fmtShort(b.date))}</td>
      <td class="dc-bk-name-col">${esc(b.name || b.slug || '—')}</td>
      <td>${typeBadge}</td>
      <td>${esc(fmtSize(b.size_mb))}</td>
      <td style="color:var(--text-muted,#888)">${esc(parts.join(', ') || '—')}</td>
      <td><span class="dc-bk-path" style="font-size:0.6875rem">HAOS VM + Supabase</span></td>
      <td>${existsBadge}</td>
    </tr>`;
  });

  // Backup Now: insert trigger, update schedule area to show pending
  window.dcBackupNow = async function(service) {
    const btn = event.target.closest('button');
    btn.disabled = true;
    btn.textContent = 'Requesting…';
    try {
      const { error } = await supabase.from('backup_triggers').insert({
        service,
        requested_at: new Date().toISOString(),
        status: 'pending',
      });
      if (error) throw error;
      showToast(`Backup requested for ${service} — poller checks every 5 min`);
      btn.textContent = 'Requested ✓';
      // Update the schedule section to show the pending request
      const schedEl = document.getElementById(`dc-bk-sched-${service}`);
      if (schedEl) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        schedEl.insertAdjacentHTML('beforeend',
          `<div class="dc-bk-sched-pending" style="color:#1565c0">⏳ Backup requested at ${timeStr} — poller runs every 5 min</div>`);
      }
    } catch (e) {
      showToast(`Trigger failed: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Backup Now';
    }
  };

  // Compute last successful backup per service from backup_files, completed triggers, and backup_logs
  function lastBackupInfo(svcKey) {
    // Check backup_files first (most accurate)
    const svcFiles = backupFiles.filter(f => f.service === svcKey);
    if (svcFiles.length) {
      const latest = svcFiles[0]; // already sorted by backup_date desc
      return { date: latest.backup_date, source: 'file', size: fmtBytes(latest.size_bytes) };
    }
    // Check completed triggers
    const completedTrigger = recentTriggers.find(t => t.service === svcKey && t.status === 'completed');
    if (completedTrigger) {
      return { date: completedTrigger.completed_at, source: 'trigger' };
    }
    // Check backup_logs (legacy)
    const svcLog = logs.find(l => {
      const d = l.details || {};
      const keyMap = { 'supabase-db': 'supabase', 'cloudflare-r2': 'r2', 'cloudflare-d1': 'd1', 'github-repo': 'github' };
      const k = keyMap[svcKey];
      return k && d[k] && d[k].status === 'success';
    });
    if (svcLog) return { date: svcLog.created_at, source: 'log' };
    return null;
  }

  function lastBackupHtml(svcKey) {
    const info = lastBackupInfo(svcKey);
    if (!info) return `<div class="dc-bk-last-backup" style="color:#c62828;font-size:0.75rem;margin-top:0.25rem">No successful backup on record</div>`;
    const d = new Date(info.date);
    const ageMs = Date.now() - d.getTime();
    const ageDays = Math.floor(ageMs / 86400000);
    const ageStr = ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays}d ago`;
    const stale = ageDays > 8; // weekly backups — warn if >8 days
    const color = stale ? '#c62828' : '#2e7d32';
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
                    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `<div class="dc-bk-last-backup" style="color:${color};font-size:0.75rem;margin-top:0.25rem;font-weight:500">Last backup: ${esc(dateStr)} (${esc(ageStr)})${info.size ? ` · ${esc(info.size)}` : ''}${stale ? ' ⚠️ stale' : ''}</div>`;
  }

  function serviceBlock(dotClass, name, desc, meta, freq, next, backupsHtml, svcKey) {
    const active = activeTriggers.filter(t => t.service === svcKey);
    const recent = recentTriggers.filter(t => t.service === svcKey).slice(0, 3);
    // Combine active + recent triggers, sort reverse-chronologically
    const allTriggers = [...active, ...recent].sort((a, b) => {
      const da = new Date(a.completed_at || a.requested_at).getTime();
      const db = new Date(b.completed_at || b.requested_at).getTime();
      return db - da;
    }).slice(0, 5);
    // Check if any success exists (to dim earlier failures)
    const hasSuccess = allTriggers.some(t => t.status === 'completed');
    const triggerHtml = allTriggers.map(t => {
      const trigDate = new Date(t.completed_at || t.requested_at);
      const today = new Date();
      const isToday = trigDate.toDateString() === today.toDateString();
      const when = isToday
        ? trigDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : trigDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + trigDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const resultDetail = t.notes || '';
      const ageMs = Date.now() - trigDate.getTime();
      const staleMs = 30 * 60 * 1000; // 30 minutes
      if (t.status === 'running') {
        if (ageMs > staleMs) {
          return `<div class="dc-bk-sched-pending" style="color:#b0a090;font-size:0.6875rem;opacity:0.7">⚠️ Backup stale — started ${when}, likely crashed</div>`;
        }
        return `<div class="dc-bk-sched-pending" style="color:#e65100">🔄 Backup running since ${when}</div>`;
      }
      if (t.status === 'pending') {
        if (ageMs > staleMs) {
          return `<div class="dc-bk-sched-pending" style="color:#b0a090;font-size:0.6875rem;opacity:0.7">⚠️ Backup request stale — requested ${when}, poller may be down</div>`;
        }
        return `<div class="dc-bk-sched-pending" style="color:#1565c0">⏳ Backup requested at ${when} — poller runs every 5 min</div>`;
      }
      if (t.status === 'completed') {
        return `<div class="dc-bk-sched-pending" style="color:#2e7d32">✅ Manual backup completed at ${when}${resultDetail ? ` — ${esc(resultDetail)}` : ''}</div>`;
      }
      // Failed — dim if a success exists after it
      const dimStyle = hasSuccess ? 'color:#b0a090;font-size:0.6875rem;opacity:0.7' : 'color:#c62828';
      return `<div class="dc-bk-sched-pending" style="${dimStyle}">❌ Manual backup failed at ${when}${resultDetail ? ` — ${esc(resultDetail)}` : ''}</div>`;
    }).join('');
    return `<div class="dc-bk-service">
      <div class="dc-bk-section">
        <div class="dc-bk-section-label">Service</div>
        <div class="dc-bk-section-body">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div class="dc-bk-svc-name"><span class="dc-schedule-dot ${dotClass}"></span> ${esc(name)}</div>
              <div class="dc-bk-svc-desc">${desc}</div>
              <div class="dc-bk-svc-meta">${meta}</div>
              ${lastBackupHtml(svcKey)}
            </div>
            <button class="dc-bk-now-btn" onclick="dcBackupNow('${svcKey}')"${active.length ? ' disabled' : ''}>
              ${active.length ? (active[0].status === 'running' ? 'Running…' : 'Requested ✓') : 'Backup Now'}
            </button>
          </div>
        </div>
      </div>
      <div class="dc-bk-section">
        <div class="dc-bk-section-label">Schedule</div>
        <div class="dc-bk-section-body" id="dc-bk-sched-${svcKey}">
          <div class="dc-bk-sched-line">
            <span class="dc-bk-sched-freq">${esc(freq)}</span>
            <span class="dc-bk-sched-next">Next: ${esc(fmtScheduleDate(next))}</span>
            <span class="dc-bk-sched-countdown">${esc(timeUntil(next))}</span>
          </div>
          ${triggerHtml}
        </div>
      </div>
      <div class="dc-bk-section">
        <div class="dc-bk-section-label">Backups</div>
        <div class="dc-bk-section-body">${backupsHtml}</div>
      </div>
    </div>`;
  }

  function link(href, label) {
    return `<a href="${href}" target="_blank" style="color:var(--accent,#b8a88a);text-decoration:none;font-size:0.75rem;">${label}</a>`;
  }

  // Choose columns based on whether we have file-level records
  function rvaultCols(svcKey) {
    return backupFiles.some(f => f.service === svcKey)
      ? ['When','Status','Filename','Size','Path']
      : ['When','Status','Detail','Size','Location'];
  }

  panel.innerHTML = `
    <h2 style="font-size:1.375rem;font-weight:700;margin-bottom:0.25rem;">Backups</h2>
    <p style="color:var(--text-muted,#888);font-size:0.8125rem;margin-bottom:1.5rem;">Automated backups across infrastructure services.</p>

    <div class="dc-bk-list">

      ${serviceBlock('active', 'Supabase DB',
        'Full database dump of the AlpacApps Supabase project — all tables, data, schemas, and RLS policies',
        `/Volumes/RVAULT20/backups/alpacapps/db/ &nbsp;·&nbsp; 12 rolling dumps &nbsp;·&nbsp; Cron on Alpuca
         &nbsp;·&nbsp; ${link('https://supabase.com/dashboard/project/aphrrfprbixmhissnjfn','Supabase dashboard ↗')}`,
        'Every Monday at 1:00 AM CT', nextRvault,
        instanceTable(rvaultCols('supabase-db'), rvaultRowsFor('supabase','db','supabase-db'), 'supabase'),
        'supabase-db'
      )}

      ${serviceBlock('active', 'Cloudflare R2',
        'Full mirror of the alpacapps R2 bucket — uploaded images, attachments, and media files',
        `/Volumes/RVAULT20/backups/alpacapps/r2/ &nbsp;·&nbsp; Full mirror retained &nbsp;·&nbsp; Cron on Alpuca
         &nbsp;·&nbsp; ${link('https://dash.cloudflare.com','Cloudflare dashboard ↗')}`,
        'Every Monday at 1:00 AM CT', nextRvault,
        instanceTable(rvaultCols('cloudflare-r2'), rvaultRowsFor('r2','r2','cloudflare-r2'), 'r2'),
        'cloudflare-r2'
      )}

      ${serviceBlock('active', 'Cloudflare D1',
        'Export of the claude-sessions D1 database — all Claude conversation session records',
        `/Volumes/RVAULT20/backups/alpacapps/d1/ &nbsp;·&nbsp; 12 rolling exports &nbsp;·&nbsp; Cron on Alpuca
         &nbsp;·&nbsp; ${link('https://dash.cloudflare.com','Cloudflare dashboard ↗')}`,
        'Every Monday at 1:00 AM CT', nextRvault,
        instanceTable(rvaultCols('cloudflare-d1'), rvaultRowsFor('d1','d1','cloudflare-d1'), 'd1'),
        'cloudflare-d1'
      )}

      ${serviceBlock('active', 'GitHub Repo',
        'Bare mirror of the rsonnad/alpacapps repository — all branches, tags, and full commit history',
        `/Volumes/RVAULT20/backups/alpacapps/github/ &nbsp;·&nbsp; Cron on Alpuca
         &nbsp;·&nbsp; ${link('https://github.com/rsonnad/alpacapps','github.com/rsonnad/alpacapps ↗')}`,
        'Every Monday at 1:00 AM CT', nextRvault,
        instanceTable(rvaultCols('github-repo'), rvaultRowsFor('github','github','github-repo'), 'github'),
        'github-repo'
      )}

      ${serviceBlock(
        haosBackups.length ? 'active' : 'pending', 'Home Assistant',
        'Application-level snapshots — automations, integrations, add-on configs, entity registry, and history',
        `HAOS VM (192.168.1.39) → synced to Supabase &nbsp;·&nbsp; Cron on Alpuca (192.168.1.200)
         &nbsp;·&nbsp; ${link('http://192.168.1.39:8123','HA UI ↗ (LAN only)')}`,
        'Daily at 2:00 AM CT', nextHaosApp,
        instanceTable(['When','Name','Type','Size','Contents','Location','Exists'], haosRows, 'haos'),
        'home-assistant'
      )}

      ${serviceBlock('active', 'HAOS VM Image',
        'Raw QEMU disk image of the entire Home Assistant OS virtual machine — bootable full system recovery',
        `/Volumes/RVAULT20/backups/haos/ &nbsp;·&nbsp; 7-day retention &nbsp;·&nbsp; haos_generic-aarch64.img &nbsp;·&nbsp; Cron on Alpuca`,
        'Daily at 3:17 AM CT', nextHaosVm,
        instanceTable(rvaultCols('haos-vm-image'), rvaultRowsFor('haos-vm','haos','haos-vm-image'), 'haos-vm'),
        'haos-vm-image'
      )}

    </div>`;
}

// ═══════════════════════════════════════════════════════════
// PLANLIST TAB
// ═══════════════════════════════════════════════════════════
// PLANLIST (TODO) — full CRUD checklist
// ═══════════════════════════════════════════════════════════
let todoCategories = [];
let todoAllItems = [];
let todoSearchQuery = '';

const todoDefaultIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>';
const todoIcons = {
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  up: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>',
  down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>',
  chevron: '<svg class="todo-category-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>',
};

function todoTimeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function todoItemMatchesSearch(item, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (item.title || '').toLowerCase().includes(q) || (item.description || '').toLowerCase().includes(q) || (item.badge || '').toLowerCase().includes(q);
}

function todoHighlightText(text, query) {
  if (!query || !text) return esc(text);
  const escaped = esc(text);
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp(`(${q})`, 'gi'), '<span class="todo-search-highlight">$1</span>');
}

function todoHighlightHtml(html, query) {
  if (!query || !html) return html;
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(/(<[^>]+>)|([^<]+)/g, (match, tag, text) => {
    if (tag) return tag;
    return text.replace(new RegExp(`(${q})`, 'gi'), '<span class="todo-search-highlight">$1</span>');
  });
}

async function loadTodoData() {
  try {
    const [catRes, itemRes] = await Promise.all([
      supabase.from('todo_categories').select('*').order('display_order'),
      supabase.from('todo_items').select('*').order('display_order'),
    ]);
    if (catRes.error) showToast('Failed to load categories: ' + catRes.error.message, 'error');
    if (itemRes.error) showToast('Failed to load items: ' + itemRes.error.message, 'error');
    todoAllItems = itemRes.data || [];
    todoCategories = (catRes.data || []).map(cat => ({
      ...cat,
      items: todoAllItems.filter(i => i.category_id === cat.id)
    }));
  } catch (err) {
    showToast('Error loading data: ' + err.message, 'error');
  }
  renderTodo();
}

function renderTodo() {
  const panel = document.getElementById('dc-panel-planlist');
  const total = todoAllItems.length;
  const done = todoAllItems.filter(i => i.is_checked).length;
  const remaining = total - done;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  panel.innerHTML = `
    <h2 style="font-size:1.375rem;font-weight:700;margin-bottom:0.25rem;">PlanList</h2>
    <p style="color:var(--text-muted,#888);font-size:0.8125rem;margin-bottom:1.25rem;">Development todo items, implementation plans, and project checklists</p>

    <div class="todo-summary">
      <div class="todo-summary-stat"><span class="todo-summary-value total">${total}</span><span class="todo-summary-label">Total</span></div>
      <div class="todo-summary-stat"><span class="todo-summary-value done">${done}</span><span class="todo-summary-label">Done</span></div>
      <div class="todo-summary-stat"><span class="todo-summary-value remaining">${remaining}</span><span class="todo-summary-label">Remaining</span></div>
      <div class="todo-summary-stat"><span class="todo-summary-value" style="color:${pct === 100 ? 'var(--success)' : 'var(--text)'}">${pct}%</span><span class="todo-summary-label">Progress</span></div>
    </div>
    <div class="todo-progress-bar"><div class="todo-progress-fill" style="width:${pct}%"></div></div>

    <div class="todo-search">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input type="text" id="todoSearch" placeholder="Search tasks..." autocomplete="off" value="${esc(todoSearchQuery)}">
      <span class="todo-search-count" id="todoSearchCount"></span>
      <button class="todo-search-clear ${todoSearchQuery ? '' : 'hidden'}" id="todoSearchClear">&times;</button>
    </div>

    <div class="todo-actions">
      <button class="btn-small btn-secondary" id="resetAllBtn">Reset All</button>
      <button class="btn-small btn-primary" id="addCategoryBtn">+ Category</button>
    </div>

    <div id="todoContainer">${todoCategories.map(cat => {
      const visibleItems = cat.items.filter(i => todoItemMatchesSearch(i, todoSearchQuery));
      const catHidden = todoSearchQuery && visibleItems.length === 0;
      const catDone = cat.items.filter(i => i.is_checked).length;
      const catTotal = cat.items.length;
      const allDone = catDone === catTotal && catTotal > 0;
      const collapsed = todoSearchQuery ? false : allDone;
      return `
        <div class="todo-category${collapsed ? ' collapsed' : ''}${catHidden ? ' search-hidden' : ''}" data-cat="${cat.id}">
          <div class="todo-category-header" onclick="this.parentElement.classList.toggle('collapsed')">
            ${cat.icon_svg || todoDefaultIcon}
            <h2>${esc(cat.title)}</h2>
            <span class="todo-category-progress"><span class="${allDone ? 'done' : ''}">${todoSearchQuery ? `${visibleItems.length}/` : ''}${catDone}/${catTotal}</span></span>
            <div class="todo-cat-actions" onclick="event.stopPropagation()">
              <button class="todo-action-btn" title="Add item" data-action="add-item" data-cat-id="${cat.id}">${todoIcons.plus}</button>
              <button class="todo-action-btn" title="Edit" data-action="edit-cat" data-cat-id="${cat.id}">${todoIcons.edit}</button>
              <button class="todo-action-btn" title="Move up" data-action="move-cat-up" data-cat-id="${cat.id}">${todoIcons.up}</button>
              <button class="todo-action-btn" title="Move down" data-action="move-cat-down" data-cat-id="${cat.id}">${todoIcons.down}</button>
            </div>
            ${todoIcons.chevron}
          </div>
          <div class="todo-items">
            ${cat.items.map((item, idx) => {
              const matches = todoItemMatchesSearch(item, todoSearchQuery);
              const checked = item.is_checked;
              const badgeHtml = item.badge ? `<span class="todo-badge ${item.badge}">${item.badge}</span>` : '';
              const checkedInfo = checked && item.checked_at ? `<div class="todo-checked-info">${todoTimeAgo(item.checked_at)}</div>` : '';
              const titleHtml = todoSearchQuery ? todoHighlightText(item.title, todoSearchQuery) : esc(item.title);
              const descHtml = item.description ? (todoSearchQuery ? todoHighlightHtml(item.description, todoSearchQuery) : item.description) : '';
              return `
                <div class="todo-item${checked ? ' checked' : ''}${!matches ? ' search-hidden' : ''}">
                  <input type="checkbox" class="todo-checkbox" data-id="${item.id}" ${checked ? 'checked' : ''}>
                  <div class="todo-item-content">
                    <div class="todo-item-title">${titleHtml}</div>
                    ${descHtml ? `<div class="todo-item-desc">${descHtml}</div>` : ''}
                    ${checkedInfo}
                  </div>
                  ${badgeHtml}
                  <button class="todo-item-edit-btn" title="Edit" data-action="edit-item" data-item-id="${item.id}">${todoIcons.edit}</button>
                  <div class="todo-item-actions" onclick="event.stopPropagation()">
                    <button class="todo-action-btn" title="Move up" data-action="move-item-up" data-item-id="${item.id}" ${idx === 0 ? 'disabled' : ''}>${todoIcons.up}</button>
                    <button class="todo-action-btn" title="Move down" data-action="move-item-down" data-item-id="${item.id}" ${idx === cat.items.length - 1 ? 'disabled' : ''}>${todoIcons.down}</button>
                  </div>
                </div>`;
            }).join('')}
          </div>
        </div>`;
    }).join('')}</div>

    <!-- Todo CRUD Modal -->
    <div id="todoModal" class="modal hidden">
      <div class="modal-content" style="max-width:560px">
        <div class="modal-header">
          <h2 id="todoModalTitle">Add Category</h2>
          <button class="modal-close" id="todoModalClose">&times;</button>
        </div>
        <div class="modal-body" id="todoModalBody"></div>
        <div class="modal-footer">
          <button class="btn-secondary" id="todoModalDelete" style="display:none;margin-right:auto;color:#991b1b">Delete</button>
          <button class="btn-secondary" id="todoModalCancel">Cancel</button>
          <button class="btn-primary" id="todoModalSave">Save</button>
        </div>
      </div>
    </div>`;

  // Bind events after render
  setupTodoEvents();

  // Update search count
  if (todoSearchQuery) {
    const matchCount = todoAllItems.filter(i => todoItemMatchesSearch(i, todoSearchQuery)).length;
    const countEl = document.getElementById('todoSearchCount');
    if (countEl) countEl.textContent = `${matchCount}/${todoAllItems.length}`;
  }
}

function setupTodoEvents() {
  const container = document.getElementById('todoContainer');
  if (!container) return;

  container.addEventListener('change', (e) => {
    if (e.target.classList.contains('todo-checkbox')) todoToggleItem(e.target.dataset.id);
  });

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, catId, itemId } = btn.dataset;
    switch (action) {
      case 'add-item': todoOpenItemModal(catId); break;
      case 'edit-cat': { const c = todoCategories.find(x => x.id === catId); if (c) todoOpenCategoryModal(c); break; }
      case 'move-cat-up': todoMoveCategory(catId, 'up'); break;
      case 'move-cat-down': todoMoveCategory(catId, 'down'); break;
      case 'edit-item': { const i = todoAllItems.find(x => x.id === itemId); if (i) todoOpenItemModal(i.category_id, i); break; }
      case 'move-item-up': todoMoveItem(itemId, 'up'); break;
      case 'move-item-down': todoMoveItem(itemId, 'down'); break;
    }
  });

  const searchInput = document.getElementById('todoSearch');
  if (searchInput) {
    searchInput.addEventListener('input', () => { todoSearchQuery = searchInput.value.trim(); renderTodo(); });
    // Re-focus after re-render
    searchInput.focus();
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
  }
  document.getElementById('todoSearchClear')?.addEventListener('click', () => { todoSearchQuery = ''; renderTodo(); });
  document.getElementById('resetAllBtn')?.addEventListener('click', todoHandleResetAll);
  document.getElementById('addCategoryBtn')?.addEventListener('click', () => todoOpenCategoryModal());
  document.getElementById('todoModalClose')?.addEventListener('click', todoCloseModal);
  document.getElementById('todoModalCancel')?.addEventListener('click', todoCloseModal);
  document.getElementById('todoModal')?.addEventListener('click', (e) => { if (e.target.id === 'todoModal') todoCloseModal(); });
}

async function todoToggleItem(itemId) {
  const item = todoAllItems.find(i => i.id === itemId);
  if (!item) return;
  const auth = getAuthState();
  const newChecked = !item.is_checked;
  item.is_checked = newChecked;
  item.checked_at = newChecked ? new Date().toISOString() : null;
  renderTodo();
  const { error } = await supabase.from('todo_items').update({
    is_checked: newChecked,
    checked_by: newChecked ? (auth?.appUser?.id || null) : null,
    checked_at: newChecked ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  }).eq('id', itemId);
  if (error) { item.is_checked = !newChecked; renderTodo(); showToast('Failed to update', 'error'); }
}

function todoOpenCategoryModal(category = null) {
  const modal = document.getElementById('todoModal');
  const title = document.getElementById('todoModalTitle');
  const body = document.getElementById('todoModalBody');
  const saveBtn = document.getElementById('todoModalSave');
  const deleteBtn = document.getElementById('todoModalDelete');
  title.textContent = category ? 'Edit Category' : 'Add Category';
  body.innerHTML = `
    <label for="catTitle">Title</label>
    <input type="text" id="catTitle" value="${esc(category?.title || '')}" placeholder="Category name">
    <label for="catIcon">Icon SVG</label>
    <textarea id="catIcon" rows="3" style="font-family:monospace;font-size:0.8rem" placeholder="Paste SVG element">${esc(category?.icon_svg || todoDefaultIcon)}</textarea>
    <small style="color:var(--text-muted);display:block;margin-top:0.25rem">Paste a Feather Icons SVG or leave default</small>`;
  deleteBtn.style.display = category ? '' : 'none';
  deleteBtn.onclick = async () => {
    if (!confirm(`Delete "${category.title}" and all its items?`)) return;
    const { error } = await supabase.from('todo_categories').delete().eq('id', category.id);
    if (error) { showToast('Delete failed', 'error'); return; }
    todoCloseModal(); showToast('Category deleted', 'info'); await loadTodoData();
  };
  saveBtn.onclick = async () => {
    const t = document.getElementById('catTitle').value.trim();
    const icon = document.getElementById('catIcon').value.trim();
    if (!t) { showToast('Title is required', 'error'); return; }
    if (category) {
      const { error } = await supabase.from('todo_categories').update({ title: t, icon_svg: icon, updated_at: new Date().toISOString() }).eq('id', category.id);
      if (error) { showToast('Save failed', 'error'); return; }
      showToast('Category updated', 'success');
    } else {
      const maxOrder = todoCategories.reduce((max, c) => Math.max(max, c.display_order), -1);
      const { error } = await supabase.from('todo_categories').insert({ title: t, icon_svg: icon, display_order: maxOrder + 1 });
      if (error) { showToast('Save failed', 'error'); return; }
      showToast('Category added', 'success');
    }
    todoCloseModal(); await loadTodoData();
  };
  modal.classList.remove('hidden');
}

function todoOpenItemModal(categoryId, item = null) {
  const modal = document.getElementById('todoModal');
  const title = document.getElementById('todoModalTitle');
  const body = document.getElementById('todoModalBody');
  const saveBtn = document.getElementById('todoModalSave');
  const deleteBtn = document.getElementById('todoModalDelete');
  title.textContent = item ? 'Edit Item' : 'Add Item';
  const catOptions = todoCategories.map(c =>
    `<option value="${c.id}" ${c.id === (item?.category_id || categoryId) ? 'selected' : ''}>${esc(c.title)}</option>`
  ).join('');
  body.innerHTML = `
    <label for="itemTitle">Title</label>
    <input type="text" id="itemTitle" value="${esc(item?.title || '')}" placeholder="Task title">
    <label for="itemDesc">Description <small style="font-weight:400;color:var(--text-muted)">(HTML allowed)</small></label>
    <textarea id="itemDesc" rows="3" placeholder="Optional description...">${item?.description || ''}</textarea>
    <label for="itemBadge">Priority</label>
    <select id="itemBadge">
      <option value="" ${!item?.badge ? 'selected' : ''}>None</option>
      <option value="critical" ${item?.badge === 'critical' ? 'selected' : ''}>Critical</option>
      <option value="important" ${item?.badge === 'important' ? 'selected' : ''}>Important</option>
      <option value="nice" ${item?.badge === 'nice' ? 'selected' : ''}>Nice to Have</option>
      <option value="blocked" ${item?.badge === 'blocked' ? 'selected' : ''}>Blocked</option>
    </select>
    <label for="itemCategory">Category</label>
    <select id="itemCategory">${catOptions}</select>`;
  deleteBtn.style.display = item ? '' : 'none';
  deleteBtn.onclick = async () => {
    if (!confirm(`Delete "${item.title}"?`)) return;
    const { error } = await supabase.from('todo_items').delete().eq('id', item.id);
    if (error) { showToast('Delete failed', 'error'); return; }
    todoCloseModal(); showToast('Item deleted', 'info'); await loadTodoData();
  };
  saveBtn.onclick = async () => {
    const t = document.getElementById('itemTitle').value.trim();
    const desc = document.getElementById('itemDesc').value.trim();
    const badge = document.getElementById('itemBadge').value || null;
    const catId = document.getElementById('itemCategory').value;
    if (!t) { showToast('Title is required', 'error'); return; }
    if (item) {
      const { error } = await supabase.from('todo_items').update({ title: t, description: desc || null, badge, category_id: catId, updated_at: new Date().toISOString() }).eq('id', item.id);
      if (error) { showToast('Save failed', 'error'); return; }
      showToast('Item updated', 'success');
    } else {
      const catItems = todoAllItems.filter(i => i.category_id === catId);
      const maxOrder = catItems.reduce((max, i) => Math.max(max, i.display_order), -1);
      const { error } = await supabase.from('todo_items').insert({ category_id: catId, title: t, description: desc || null, badge, display_order: maxOrder + 1 });
      if (error) { showToast('Save failed', 'error'); return; }
      showToast('Item added', 'success');
    }
    todoCloseModal(); await loadTodoData();
  };
  modal.classList.remove('hidden');
}

function todoCloseModal() { document.getElementById('todoModal')?.classList.add('hidden'); }

async function todoMoveCategory(catId, direction) {
  const idx = todoCategories.findIndex(c => c.id === catId);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= todoCategories.length) return;
  const a = todoCategories[idx], b = todoCategories[swapIdx];
  await Promise.all([
    supabase.from('todo_categories').update({ display_order: b.display_order }).eq('id', a.id),
    supabase.from('todo_categories').update({ display_order: a.display_order }).eq('id', b.id)
  ]);
  await loadTodoData();
}

async function todoMoveItem(itemId, direction) {
  const cat = todoCategories.find(c => c.items.some(i => i.id === itemId));
  if (!cat) return;
  const items = cat.items;
  const idx = items.findIndex(i => i.id === itemId);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= items.length) return;
  const a = items[idx], b = items[swapIdx];
  await Promise.all([
    supabase.from('todo_items').update({ display_order: b.display_order }).eq('id', a.id),
    supabase.from('todo_items').update({ display_order: a.display_order }).eq('id', b.id)
  ]);
  await loadTodoData();
}

async function todoHandleResetAll() {
  if (!confirm('Reset all checkboxes? This will uncheck everything.')) return;
  const { error } = await supabase.from('todo_items').update({
    is_checked: false, checked_by: null, checked_at: null, updated_at: new Date().toISOString()
  }).eq('is_checked', true);
  if (error) { showToast('Reset failed', 'error'); return; }
  showToast('All tasks reset', 'info');
  await loadTodoData();
}

async function loadPlanList() {
  const panel = document.getElementById('dc-panel-planlist');
  panel.innerHTML = '<div class="dc-empty">Loading tasks...</div>';
  await loadTodoData();
}

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  await initAdminPage({
    activeTab: 'devcontrol',
    requiredRole: 'staff',
    requiredPermission: 'view_devcontrol',
    section: 'devcontrol',
    onReady: () => { renderDevControlTabs(); initSubtabs(); },
  });
});

// ═══════════════════════════════════════════════════════════
// TESTS TAB
// ═══════════════════════════════════════════════════════════
function loadTests() {
  const panel = document.getElementById('dc-panel-tests');

  const TESTS = [
    {
      id: 'pai-test-suite', name: 'PAI Response Quality', section: 'AI / LLM',
      description: 'Queries real Supabase data, generates 50+ test questions across 14 categories, calls PAI API endpoint, and scores responses with keyword matching.',
      runner: 'dev/testing/pai-test-suite.js', reportUrl: '/dev/testing/testrun1.html', resultsFile: '/dev/testing/results.json',
      models: ['Gemini 2.5 Flash'], sentToClaude: false,
    },
    {
      id: 'site-health', name: 'Site Health Check', section: 'Infrastructure',
      description: 'Loads 40+ pages (public, resident, admin), checks camera feeds, verifies device inventory, and tests Supabase connectivity.',
      runner: 'spaces/admin/devcontrol/devdocs/tests/site-health.js', reportUrl: null, resultsFile: null,
      models: [], sentToClaude: false,
    },
    {
      id: 'email-classifier', name: 'Email Classifier Accuracy', section: 'AI / LLM',
      description: 'Tests the dual-model email classifier (Gemini Flash + Llama Maverick) with sample emails across categories: spam, payment, receipt, query, complaint.',
      runner: null, reportUrl: null, resultsFile: null,
      models: ['Gemini 2.5 Flash', 'Llama 4 Maverick'], sentToClaude: false, notImplemented: true,
    },
    {
      id: 'payment-email-parsing', name: 'Payment Email Parsing', section: 'Payment & Email',
      description: 'Tests Zelle, PayPal, and Coinbase email parsers with sample notification emails. Verifies sender name, amount, and transaction ID extraction.',
      runner: null, reportUrl: null, resultsFile: null,
      models: [], sentToClaude: false, notImplemented: true,
    },
    {
      id: 'tenant-matcher', name: 'Tenant Matcher Accuracy', section: 'Payment & Email',
      description: 'Tests the 3-tier payment sender matching (cached → exact → Gemini AI) with various name formats, misspellings, and amount-based matching.',
      runner: null, reportUrl: null, resultsFile: null,
      models: ['Gemini 2.0 Flash'], sentToClaude: false, notImplemented: true,
    },
  ];

  function fmtDuration(ms) {
    if (!ms) return '—';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }

  function fmtDate(iso) {
    if (!iso) return 'Never';
    const d = new Date(iso), now = new Date();
    const days = Math.floor((now - d) / 86400000);
    const ds = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const ts = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const ago = days === 0 ? ' (today)' : days === 1 ? ' (yesterday)' : days < 30 ? ` (${days}d ago)` : ` (${Math.floor(days / 30)}mo ago)`;
    return ds + ' ' + ts + ago;
  }

  function getStatus(t) {
    if (t.notImplemented || !t.lastRun) return 'never';
    const days = Math.floor((Date.now() - new Date(t.lastRun)) / 86400000);
    if (days > 14) return 'stale';
    return (t.failed > 0) ? 'fail' : 'pass';
  }

  const statusColors = { pass: 'var(--success, #16a34a)', fail: 'var(--error, #dc2626)', stale: '#f59e0b', never: '#d1d5db' };

  async function init() {
    // Load results from JSON files
    for (const test of TESTS) {
      if (!test.resultsFile) continue;
      try {
        const resp = await fetch(test.resultsFile + '?t=' + Date.now());
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.summary) {
          test.lastRun = data.summary.runStart;
          test.duration = data.summary.durationFormatted || fmtDuration(data.summary.durationMs);
          test.passRate = data.summary.passRate;
          test.totalQueries = data.summary.totalQueries;
          test.passed = data.summary.passed;
          test.failed = data.summary.failed;
          test.avgScore = data.summary.avgScore;
          test.avgResponseTime = data.summary.avgResponseTimeMs ? Math.round(data.summary.avgResponseTimeMs) + 'ms' : null;
        }
      } catch (e) { /* skip */ }
    }

    // Compute summary
    let nPass = 0, nFail = 0, nNever = 0;
    TESTS.forEach(t => { const s = getStatus(t); if (s === 'pass') nPass++; else if (s === 'fail' || s === 'stale') nFail++; else nNever++; });

    // Group by section
    const sections = {};
    TESTS.forEach(t => { (sections[t.section] = sections[t.section] || []).push(t); });

    panel.innerHTML = `
      <h2 style="font-size:1.375rem;font-weight:700;margin-bottom:0.25rem;">Test Suite</h2>
      <p style="color:var(--text-muted);font-size:0.875rem;margin-bottom:1.25rem;">All registered tests, their last run results, and status.</p>
      <div style="display:flex;gap:0.75rem;margin-bottom:1.5rem;flex-wrap:wrap;">
        <div class="dc-stat"><div class="dc-stat-value">${TESTS.length}</div><div class="dc-stat-label">Tests</div></div>
        <div class="dc-stat"><div class="dc-stat-value" style="color:var(--success)">${nPass}</div><div class="dc-stat-label">Passed</div></div>
        <div class="dc-stat"><div class="dc-stat-value" style="color:var(--error)">${nFail}</div><div class="dc-stat-label">Failed</div></div>
        <div class="dc-stat"><div class="dc-stat-value">${nNever}</div><div class="dc-stat-label">Never Run</div></div>
      </div>
      ${Object.entries(sections).map(([section, tests]) => `
        <div style="font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin:1.5rem 0 0.5rem;">${esc(section)}</div>
        ${tests.map(t => {
          const status = getStatus(t);
          const dotColor = statusColors[status];
          return `
          <div class="dc-test-card" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:0.5rem;overflow:hidden;">
            <div style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem 1rem;cursor:pointer;" onclick="this.parentElement.classList.toggle('dc-test-expanded')">
              <div style="width:10px;height:10px;border-radius:50%;background:${dotColor};flex-shrink:0;"></div>
              <span style="font-weight:600;font-size:0.9rem;flex:1;">${esc(t.name)}</span>
              <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
                ${t.models.map(m => `<span style="font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:4px;background:#ede9fe;color:#6b21a8;">${esc(m)}</span>`).join('')}
                ${t.sentToClaude ? '<span style="font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:4px;background:#dbeafe;color:#1d4ed8;">Sent to Claude</span>' : ''}
                ${t.notImplemented ? '<span style="font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:4px;background:var(--bg);color:var(--text-muted);">Not implemented</span>' : ''}
                ${t.duration ? `<span style="font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:4px;background:var(--bg);color:var(--text-muted);">${esc(t.duration)}</span>` : ''}
              </div>
            </div>
            <div class="dc-test-details" style="display:none;padding:0 1rem 0.75rem;border-top:1px solid var(--border);">
              <p style="font-size:0.8rem;color:var(--text-muted);margin:0.75rem 0 0.5rem;">${esc(t.description)}</p>
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:0.5rem;">
                <div><div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;">Last Run</div><div style="font-size:0.8rem;font-weight:500;">${fmtDate(t.lastRun)}</div></div>
                <div><div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;">Duration</div><div style="font-size:0.8rem;font-weight:500;">${t.duration || '—'}</div></div>
                <div><div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;">Runner</div><div style="font-size:0.8rem;font-weight:500;">${t.runner ? `<code style="font-size:0.7rem">${esc(t.runner)}</code>` : '<em>Not implemented</em>'}</div></div>
                ${t.reportUrl ? `<div><div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;">Report</div><div style="font-size:0.8rem;"><a href="${t.reportUrl}" target="_blank" style="color:var(--accent);text-decoration:none;">View report →</a></div></div>` : ''}
              </div>
              ${t.lastRun ? `<div style="margin-top:0.75rem;padding:0.5rem 0.75rem;background:var(--bg);border-radius:6px;font-size:0.8rem;">
                <span style="color:var(--success);font-weight:600;">${t.passed || 0} passed</span> ·
                <span style="color:var(--error);font-weight:600;">${t.failed || 0} failed</span>
                ${t.totalQueries ? ` · ${t.totalQueries} total` : ''}
                ${t.passRate ? ` · ${t.passRate} pass rate` : ''}
                ${t.avgScore ? ` · avg score ${t.avgScore}` : ''}
                ${t.avgResponseTime ? ` · avg ${t.avgResponseTime}` : ''}
                ${t.sentToClaude ? ' · <span style="color:#1d4ed8;font-weight:600;">Failures sent to headless Claude for fix</span>' : ''}
              </div>` : ''}
            </div>
          </div>`;
        }).join('')}
      `).join('')}
    `;

    // Toggle expand
    panel.querySelectorAll('.dc-test-card').forEach(card => {
      const details = card.querySelector('.dc-test-details');
      if (details) {
        const observer = new MutationObserver(() => {
          details.style.display = card.classList.contains('dc-test-expanded') ? 'block' : 'none';
        });
        observer.observe(card, { attributes: true, attributeFilter: ['class'] });
      }
    });
  }

  init();
}

function renderDevControlTabs() {
  const tabsContainer = document.querySelector('.manage-tabs');
  if (!tabsContainer) return;
  const subtabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'releases', label: 'Releases' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'tokens', label: 'Tokens' },
    { id: 'context', label: 'Context' },
    { id: 'backups', label: 'Backups' },
    { id: 'planlist', label: 'PlanList' },
    { id: 'tests', label: 'Tests' },
  ];
  tabsContainer.innerHTML = subtabs.map(tab =>
    `<a href="#${tab.id === 'overview' ? '' : tab.id}" class="manage-tab dc-manage-tab" data-tab="${tab.id}">${tab.label}</a>`
  ).join('');
}
