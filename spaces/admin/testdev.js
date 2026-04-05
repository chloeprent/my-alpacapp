import { initAdminPage, showToast } from '../../shared/admin-shell.js';

const REPO = 'USERNAME/REPO';
const PER_PAGE = 30;
const DEFAULT_DAYS = 7;

let allCommits = [];
let page = 1;
let hasMore = true;
let currentAuthor = '';
let sinceDate = '';

document.addEventListener('DOMContentLoaded', async () => {
  await initAdminPage({
    activeTab: 'testdev',
    requiredRole: 'admin',
    section: 'admin',
    onReady: async () => {
      // Default: last 7 days
      const since = new Date();
      since.setDate(since.getDate() - DEFAULT_DAYS);
      sinceDate = since.toISOString();

      bindEvents();
      await loadCommits();
    },
  });
});

function bindEvents() {
  document.getElementById('refreshBtn')?.addEventListener('click', async () => {
    page = 1;
    allCommits = [];
    hasMore = true;
    await loadCommits(true);
  });

  document.getElementById('authorFilter')?.addEventListener('change', (e) => {
    currentAuthor = e.target.value;
    renderCommits();
    renderSummary();
  });

  document.getElementById('loadMoreBtn')?.addEventListener('click', async () => {
    page++;
    await loadCommits();
  });
}

async function loadCommits(isRefresh = false) {
  const listEl = document.getElementById('commitList');
  if (!listEl) return;

  if (page === 1) {
    listEl.innerHTML = '<div class="testdev-empty">Loading commits...</div>';
  }

  if (isRefresh) showToast('Refreshing...', 'info', 1200);

  try {
    const params = new URLSearchParams({
      sha: 'main',
      per_page: String(PER_PAGE),
      page: String(page),
      since: sinceDate,
    });
    const url = `https://api.github.com/repos/${REPO}/commits?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);

    const data = await res.json();
    if (data.length < PER_PAGE) hasMore = false;

    allCommits = page === 1 ? data : allCommits.concat(data);

    populateAuthorFilter();
    renderSummary();
    renderCommits();

    document.getElementById('loadMoreWrap')?.classList.toggle('hidden', !hasMore);

    if (isRefresh) showToast('Commits refreshed', 'success');
  } catch (err) {
    console.error('Failed to load commits:', err);
    listEl.innerHTML = '<div class="testdev-empty">Unable to load commits. GitHub API may be rate-limited (60 req/hr unauthenticated).</div>';
    showToast('Failed to load commits', 'error');
  }
}

function getFiltered() {
  if (!currentAuthor) return allCommits;
  return allCommits.filter(c => (c.author?.login || c.commit?.author?.name) === currentAuthor);
}

function populateAuthorFilter() {
  const sel = document.getElementById('authorFilter');
  if (!sel) return;

  const authors = new Map();
  for (const c of allCommits) {
    const login = c.author?.login || c.commit?.author?.name || 'unknown';
    if (!authors.has(login)) {
      authors.set(login, (c.author?.avatar_url || ''));
    }
  }

  const prev = sel.value;
  sel.innerHTML = '<option value="">All authors</option>';
  for (const [login] of authors) {
    const opt = document.createElement('option');
    opt.value = login;
    opt.textContent = login;
    sel.appendChild(opt);
  }
  sel.value = prev;
}

function renderSummary() {
  const filtered = getFiltered();

  const totalEl = document.getElementById('totalCommits');
  const rangeEl = document.getElementById('dateRange');
  const authorCountEl = document.getElementById('authorCount');
  const topAuthorEl = document.getElementById('topAuthor');
  const latestMsgEl = document.getElementById('latestMessage');
  const latestWhenEl = document.getElementById('latestWhen');

  if (totalEl) totalEl.textContent = filtered.length;
  if (rangeEl) {
    if (filtered.length) {
      const oldest = filtered[filtered.length - 1].commit?.author?.date;
      const newest = filtered[0].commit?.author?.date;
      rangeEl.textContent = `${fmtShort(oldest)} - ${fmtShort(newest)}`;
    } else {
      rangeEl.textContent = '--';
    }
  }

  // Author stats (from all, not filtered)
  const authorCounts = {};
  for (const c of allCommits) {
    const a = c.author?.login || c.commit?.author?.name || 'unknown';
    authorCounts[a] = (authorCounts[a] || 0) + 1;
  }
  const uniqueAuthors = Object.keys(authorCounts);
  if (authorCountEl) authorCountEl.textContent = uniqueAuthors.length;
  if (topAuthorEl) {
    const top = uniqueAuthors.sort((a, b) => authorCounts[b] - authorCounts[a])[0];
    topAuthorEl.textContent = top ? `Top: ${top} (${authorCounts[top]})` : '--';
  }

  if (filtered.length) {
    const latest = filtered[0];
    const msg = latest.commit?.message?.split('\n')[0] || '--';
    if (latestMsgEl) latestMsgEl.textContent = msg.length > 60 ? msg.slice(0, 57) + '...' : msg;
    if (latestWhenEl) latestWhenEl.textContent = fmtDateTime(latest.commit?.author?.date);
  } else {
    if (latestMsgEl) latestMsgEl.textContent = '--';
    if (latestWhenEl) latestWhenEl.textContent = '--';
  }

  const subtitle = document.getElementById('commitSubtitle');
  if (subtitle) {
    subtitle.textContent = currentAuthor
      ? `Showing ${filtered.length} commits by ${currentAuthor}`
      : `Showing ${filtered.length} commits from all authors`;
  }
}

function renderCommits() {
  const container = document.getElementById('commitList');
  if (!container) return;

  const filtered = getFiltered();
  if (!filtered.length) {
    container.innerHTML = '<div class="testdev-empty">No commits found for this period.</div>';
    return;
  }

  // Group by date
  const groups = {};
  for (const c of filtered) {
    const date = c.commit?.author?.date?.slice(0, 10) || 'unknown';
    if (!groups[date]) groups[date] = [];
    groups[date].push(c);
  }

  let html = '';
  for (const [date, commits] of Object.entries(groups)) {
    html += `<div class="testdev-date-group">
      <div class="testdev-date-label">${fmtDateLabel(date)}</div>
      ${commits.map(renderCommitRow).join('')}
    </div>`;
  }

  container.innerHTML = html;
}

function renderCommitRow(c) {
  const msg = c.commit?.message || '';
  const firstLine = esc(msg.split('\n')[0]);
  const body = msg.split('\n').slice(1).join('\n').trim();
  const author = esc(c.author?.login || c.commit?.author?.name || 'unknown');
  const avatar = c.author?.avatar_url || '';
  const sha = (c.sha || '').slice(0, 8);
  const time = fmtTime(c.commit?.author?.date);
  const commitUrl = c.html_url || `https://github.com/${REPO}/commit/${c.sha}`;

  // Detect type from message
  const typeBadge = getTypeBadge(firstLine);

  const avatarHtml = avatar
    ? `<img src="${esc(avatar)}" alt="" class="testdev-avatar" width="28" height="28" loading="lazy">`
    : `<div class="testdev-avatar testdev-avatar--placeholder">${author.charAt(0).toUpperCase()}</div>`;

  const bodyHtml = body
    ? `<div class="testdev-commit-body">${esc(body.slice(0, 200))}${body.length > 200 ? '...' : ''}</div>`
    : '';

  return `
    <div class="testdev-commit-row">
      ${avatarHtml}
      <div class="testdev-commit-info">
        <div class="testdev-commit-message">
          ${typeBadge}
          <a href="${esc(commitUrl)}" target="_blank" rel="noopener">${firstLine}</a>
        </div>
        ${bodyHtml}
        <div class="testdev-commit-meta">
          <span class="testdev-author">${author}</span>
          <span class="testdev-sha">${esc(sha)}</span>
          <span>${time}</span>
        </div>
      </div>
    </div>
  `;
}

function getTypeBadge(message) {
  const lower = message.toLowerCase();
  if (lower.startsWith('fix') || lower.includes('bug')) return '<span class="testdev-badge testdev-badge--fix">fix</span>';
  if (lower.startsWith('feat') || lower.startsWith('add')) return '<span class="testdev-badge testdev-badge--feat">feat</span>';
  if (lower.startsWith('chore') || lower.includes('[skip ci]')) return '<span class="testdev-badge testdev-badge--chore">chore</span>';
  if (lower.startsWith('refactor')) return '<span class="testdev-badge testdev-badge--refactor">refactor</span>';
  if (lower.startsWith('docs') || lower.startsWith('doc')) return '<span class="testdev-badge testdev-badge--docs">docs</span>';
  return '';
}

function fmtDateTime(val) {
  if (!val) return '--';
  try {
    return new Date(val).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/Chicago',
    });
  } catch { return val; }
}

function fmtShort(val) {
  if (!val) return '--';
  try {
    return new Date(val).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
      timeZone: 'America/Chicago',
    });
  } catch { return val; }
}

function fmtDateLabel(dateStr) {
  if (!dateStr || dateStr === 'unknown') return 'Unknown';
  try {
    const d = new Date(dateStr + 'T12:00:00');
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

    return d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric',
    });
  } catch { return dateStr; }
}

function fmtTime(val) {
  if (!val) return '';
  try {
    return new Date(val).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/Chicago',
    });
  } catch { return ''; }
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}
