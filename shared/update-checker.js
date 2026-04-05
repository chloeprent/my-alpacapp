// AlpacApps Update Checker
// Fetches the template repo's updates manifest and compares against
// the user's last check date (stored in localStorage).
// Shows a notification banner when new features are available.

const MANIFEST_URL = 'https://alpacaplayhouse.com/infra/updates.json';
const STORAGE_KEY = 'alpacapps_last_update_check';
const CHECK_INTERVAL_DAYS = 30;

/**
 * Check for available updates from the template repo.
 * Returns { hasUpdates, newFeatures[], lastChecked, manifestDate }
 */
export async function checkForUpdates() {
  const lastChecked = localStorage.getItem(STORAGE_KEY);
  const lastDate = lastChecked ? new Date(lastChecked) : new Date(0);

  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!res.ok) return { hasUpdates: false, newFeatures: [], lastChecked, error: 'fetch-failed' };

    const manifest = await res.json();
    const recentFeatures = manifest.features.filter(f => new Date(f.date) > lastDate);

    // Filter out features already synced (detected by file existence)
    const detectionChecks = await Promise.all(
      recentFeatures.map(async f => {
        if (!f.detects || f.detects.length === 0) return false;
        try {
          const resp = await fetch('/' + f.detects[0], { method: 'HEAD' });
          return resp.ok;
        } catch { return false; }
      })
    );
    const newFeatures = recentFeatures.filter((_, i) => !detectionChecks[i]);

    return {
      hasUpdates: newFeatures.length > 0,
      newFeatures,
      lastChecked: lastChecked || null,
      manifestDate: manifest.lastUpdated,
      updatesPage: manifest.updatesPage
    };
  } catch (e) {
    return { hasUpdates: false, newFeatures: [], lastChecked, error: e.message };
  }
}

/**
 * Mark that the user has seen updates as of now.
 */
export function markUpdatesChecked() {
  localStorage.setItem(STORAGE_KEY, new Date().toISOString().split('T')[0]);
}

/**
 * Check if enough time has passed to warrant checking again.
 */
export function shouldCheckForUpdates() {
  const lastChecked = localStorage.getItem(STORAGE_KEY);
  if (!lastChecked) return true;

  const daysSince = (Date.now() - new Date(lastChecked).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= CHECK_INTERVAL_DAYS;
}

/**
 * Render a notification banner in the given container element.
 * Call this from the admin dashboard or intranet header.
 *
 * @param {HTMLElement} container - Where to insert the banner
 * @param {object} result - Result from checkForUpdates()
 */
export function renderUpdateBanner(container, result) {
  if (!result.hasUpdates || !container) return;

  // Inject styles once
  if (!document.getElementById('update-banner-styles')) {
    const style = document.createElement('style');
    style.id = 'update-banner-styles';
    style.textContent = `
      .update-banner { background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
      .update-banner__inner { display: flex; align-items: center; gap: 0.75rem; }
      .update-banner__icon { font-size: 1.2rem; }
      .update-banner__text { flex: 1; min-width: 0; }
      .update-banner__text strong { display: block; font-size: 0.88rem; color: #312e81; }
      .update-banner__text span { font-size: 0.8rem; color: #4338ca; }
      .update-banner__actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
      .update-banner__btn { font-size: 0.78rem; font-weight: 600; padding: 0.35rem 0.75rem; border-radius: 4px; text-decoration: none; border: none; cursor: pointer; }
      .update-banner__btn--primary { background: #4f46e5; color: #fff; }
      .update-banner__btn--primary:hover { background: #4338ca; }
      .update-banner__btn--dismiss { background: none; color: #818cf8; }
      .update-banner__btn--dismiss:hover { color: #4f46e5; }
    `;
    document.head.appendChild(style);
  }

  const count = result.newFeatures.length;
  const names = result.newFeatures.map(f => f.name);
  const preview = names.length <= 3
    ? names.join(', ')
    : names.slice(0, 2).join(', ') + `, and ${names.length - 2} more`;

  const banner = document.createElement('div');
  banner.className = 'update-banner';
  banner.innerHTML = `
    <div class="update-banner__inner">
      <div class="update-banner__icon">&#x2728;</div>
      <div class="update-banner__text">
        <strong>${count} new feature${count > 1 ? 's' : ''} available</strong>
        <span>${preview}</span>
      </div>
      <div class="update-banner__actions">
        <a href="${result.updatesPage}" class="update-banner__btn update-banner__btn--primary">View Updates</a>
        <button class="update-banner__btn update-banner__btn--dismiss" id="update-banner-dismiss">Dismiss</button>
      </div>
    </div>
  `;

  container.prepend(banner);

  banner.querySelector('#update-banner-dismiss').addEventListener('click', () => {
    markUpdatesChecked();
    banner.remove();
  });
}

/**
 * Auto-check and show banner if needed. One-liner for admin pages.
 * Usage: import { autoCheckUpdates } from '/shared/update-checker.js';
 *        autoCheckUpdates(document.getElementById('update-banner-slot'));
 */
export async function autoCheckUpdates(container) {
  if (!shouldCheckForUpdates()) return;

  const result = await checkForUpdates();
  if (result.hasUpdates) {
    renderUpdateBanner(container, result);
  }
}
