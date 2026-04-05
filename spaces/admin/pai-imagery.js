import { supabase } from '../../shared/supabase.js';
import { initAdminPage, showToast, setupLightbox, openLightbox } from '../../shared/admin-shell.js';

let refreshTimer = null;
let allImageUrls = [];

document.addEventListener('DOMContentLoaded', async () => {
  await initAdminPage({
    activeTab: 'paiimagery',
    requiredRole: 'staff',
    section: 'staff',
    onReady: async () => {
      setupLightbox();
      setupEvents();
      await loadImageryFeed();
      startAutoRefresh();
    },
  });
});

function setupEvents() {
  document.getElementById('refreshBtn')?.addEventListener('click', loadImageryFeed);
  window.addEventListener('beforeunload', stopAutoRefresh);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutoRefresh();
    else startAutoRefresh();
  });
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (!document.hidden) loadImageryFeed();
  }, 30000);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

async function loadImageryFeed() {
  const { data, error } = await supabase
    .from('image_gen_jobs')
    .select('id, prompt, status, created_at, completed_at, result_url, metadata, result_media_id')
    .eq('status', 'completed')
    .not('result_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(400);

  if (error) {
    console.error('Failed to load PAI imagery feed:', error);
    showToast('Failed to load PAI imagery feed', 'error');
    return;
  }

  renderFeed(data || []);
}

function renderFeed(rows) {
  const list = document.getElementById('imageryList');
  const count = document.getElementById('feedCount');
  if (!list || !count) return;

  count.textContent = `${rows.length} image${rows.length === 1 ? '' : 's'}`;

  if (rows.length === 0) {
    list.innerHTML = '<p class="text-muted" style="font-size:0.85rem;">No generated images found.</p>';
    allImageUrls = [];
    return;
  }

  allImageUrls = rows.map(r => r.result_url);

  list.innerHTML = rows.map((row) => {
    const person = row.metadata?.app_user_name || row.metadata?.vehicle_name || row.metadata?.person_name || 'Unknown';
    const purpose = row.metadata?.purpose || row.batch_label || 'generated';
    const prompt = row.prompt || '';

    return `
      <article style="display:grid;grid-template-columns:140px 1fr;gap:0.75rem;border:1px solid var(--border,#ddd);border-radius:10px;padding:0.6rem;margin-bottom:0.65rem;background:#fff;">
        <a href="javascript:void(0)" onclick="window.__openPaiLightbox('${row.result_url.replace(/'/g, "\\'")}')" style="cursor:pointer;">
          <img src="${row.result_url}" alt="Generated imagery" loading="lazy" style="width:140px;height:140px;object-fit:cover;border-radius:8px;display:block;">
        </a>
        <div style="min-width:0;">
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;margin-bottom:0.3rem;">
            <strong>${escapeHtml(person)}</strong>
            <span class="text-muted" style="font-size:0.78rem;">${formatDate(row.completed_at || row.created_at)}</span>
            <span style="font-size:0.72rem;padding:0.15rem 0.4rem;border-radius:999px;border:1px solid var(--border,#ddd);">${escapeHtml(String(purpose))}</span>
          </div>
          <p class="text-muted" style="font-size:0.82rem;margin:0 0 0.4rem 0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">
            ${escapeHtml(prompt)}
          </p>
          <a href="${row.result_url}" target="_blank" rel="noopener" style="font-size:0.8rem;">Open full image</a>
        </div>
      </article>
    `;
  }).join('');
}

window.__openPaiLightbox = function(url) {
  openLightbox(url, allImageUrls);
};

function formatDate(value) {
  if (!value) return 'Unknown date';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Unknown date';
  return d.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function escapeHtml(input) {
  const div = document.createElement('div');
  div.textContent = String(input ?? '');
  return div.innerHTML;
}
