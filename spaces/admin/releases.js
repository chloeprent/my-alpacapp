import { supabase } from '../../shared/supabase.js';
import { initAdminPage, showToast } from '../../shared/admin-shell.js';

const HISTORY_LIMIT = 50;

let latestRelease = null;
let releaseHistory = [];

document.addEventListener('DOMContentLoaded', async () => {
  await initAdminPage({
    activeTab: 'releases',
    requiredRole: 'admin',
    section: 'admin',
    onReady: async () => {
      bindEvents();
      await loadReleaseHistory();
    },
  });
});

function bindEvents() {
  document.getElementById('refreshReleasesBtn')?.addEventListener('click', async () => {
    await loadReleaseHistory(true);
  });
}

async function loadReleaseHistory(isManualRefresh = false) {
  const tableContainer = document.getElementById('releaseHistoryTable');
  if (!tableContainer) return;

  if (isManualRefresh) {
    showToast('Refreshing release history...', 'info', 1200);
  }

  tableContainer.innerHTML = '<div class="release-empty">Loading release events...</div>';

  try {
    // Fetch latest release using RPC
    const { data: latestRaw, error: latestError } = await supabase.rpc('get_latest_release_event');
    if (latestError) throw latestError;

    // Fetch release history
    const { data: historyRows, error: historyError } = await supabase
      .from('release_events')
      .select('seq, display_version, push_sha, branch, pushed_at, actor_login, actor_id, source, compare_from_sha, compare_to_sha, model_code, machine_name, metadata')
      .order('seq', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (historyError) throw historyError;

    latestRelease = latestRaw || null;
    releaseHistory = historyRows || [];

    renderSummary();
    renderTable();

    if (isManualRefresh) {
      showToast('Release history refreshed', 'success');
    }
  } catch (error) {
    console.error('Failed to load release history:', error);
    tableContainer.innerHTML = '<div class="release-empty">Unable to load release history right now.</div>';
    showToast('Failed to load release history', 'error');
  }
}

function renderSummary() {
  const latestVersionEl = document.getElementById('latestVersion');
  const latestTimestampEl = document.getElementById('latestTimestamp');
  const latestSequenceEl = document.getElementById('latestSequence');
  const latestPushShaEl = document.getElementById('latestPushSha');
  const latestActorEl = document.getElementById('latestActor');
  const latestSourceEl = document.getElementById('latestSource');

  if (!latestRelease || Object.keys(latestRelease).length === 0) {
    if (latestVersionEl) latestVersionEl.textContent = '--';
    if (latestTimestampEl) latestTimestampEl.textContent = '--';
    if (latestSequenceEl) latestSequenceEl.textContent = '--';
    if (latestPushShaEl) latestPushShaEl.textContent = '--';
    if (latestActorEl) latestActorEl.textContent = '--';
    if (latestSourceEl) latestSourceEl.textContent = '--';
    return;
  }

  if (latestVersionEl) latestVersionEl.textContent = latestRelease.display_version || '--';
  if (latestTimestampEl) latestTimestampEl.textContent = formatDateTime(latestRelease.pushed_at);
  if (latestSequenceEl) latestSequenceEl.textContent = `#${latestRelease.seq ?? '--'}`;
  if (latestPushShaEl) latestPushShaEl.textContent = shortSha(latestRelease.push_sha);
  if (latestActorEl) latestActorEl.textContent = latestRelease.actor_login || '--';
  if (latestSourceEl) latestSourceEl.textContent = latestRelease.source || '--';
}

function renderTable() {
  const container = document.getElementById('releaseHistoryTable');
  if (!container) return;

  if (!releaseHistory.length) {
    container.innerHTML = '<div class="release-empty">No release events found.</div>';
    return;
  }

  container.innerHTML = `
    <table class="release-table">
      <thead>
        <tr>
          <th>Release</th>
          <th>When</th>
          <th>Pushed By</th>
          <th>Compare</th>
        </tr>
      </thead>
      <tbody>
        ${releaseHistory.map(renderHistoryRow).join('')}
      </tbody>
    </table>
  `;
}

function renderHistoryRow(item) {
  const metadata = item.metadata || {};
  const commitCount = metadata.commit_count ?? metadata.commits_count ?? '--';
  const compareFrom = item.compare_from_sha ? shortSha(item.compare_from_sha) : 'none';
  const compareTo = item.compare_to_sha ? shortSha(item.compare_to_sha) : shortSha(item.push_sha);
  const commitSnippets = Array.isArray(metadata.commit_summaries) ? metadata.commit_summaries : [];

  const commitMarkup = commitSnippets.length
    ? `<div class="release-commits">${commitSnippets.slice(0, 6).map((c) => `
        <div class="release-commit-item">
          <span class="release-commit-hash">${escapeHtml(shortSha(c.sha || ''))}</span>${escapeHtml(c.message || '')}
        </div>
      `).join('')}</div>`
    : '';

  return `
    <tr>
      <td>
        <div><span class="release-pill">${escapeHtml(item.display_version || '--')}</span></div>
        <div class="release-meta">#${escapeHtml(String(item.seq ?? '--'))} · commits: ${escapeHtml(String(commitCount))}</div>
      </td>
      <td>
        <div>${escapeHtml(formatDateTime(item.pushed_at))}</div>
        <div class="release-meta">${escapeHtml(shortSha(item.push_sha || ''))}</div>
      </td>
      <td>
        <div>${escapeHtml(item.actor_login || '--')}</div>
        <div class="release-meta">${escapeHtml(item.source || '--')}</div>
      </td>
      <td>
        <div class="release-meta">${escapeHtml(compareFrom)} .. ${escapeHtml(compareTo)}</div>
        ${commitMarkup}
      </td>
    </tr>
  `;
}

function formatDateTime(value) {
  if (!value) return '--';
  try {
    return new Date(value).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Chicago',
    });
  } catch {
    return value;
  }
}

function shortSha(sha) {
  if (!sha) return '--';
  return sha.slice(0, 8);
}

function escapeHtml(input) {
  const div = document.createElement('div');
  div.textContent = String(input ?? '');
  return div.innerHTML;
}
