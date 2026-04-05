// Consumer view - Public spaces listing
import { supabase, SUPABASE_URL } from '../shared/supabase.js';
import { formatDateAustin, getAustinToday, parseAustinDate, isTodayOrAfterAustin } from '../shared/timezone.js';
import { initPublicHeaderAuth } from '../shared/site-components.js';
import { initAuth, requireAuth } from '../shared/auth.js';

// App state
let spaces = [];
let currentView = 'card';
let accessTokenMode = false; // true when viewing via access link (no auth)

/**
 * Validate an access token against the DB.
 * Returns true if token is valid, not revoked, and not expired.
 */
async function validateAccessToken(token) {
  try {
    const { data, error } = await supabase
      .from('access_tokens')
      .select('id, expires_at, is_revoked')
      .eq('token', token)
      .single();
    if (error || !data) return false;
    if (data.is_revoked) return false;
    if (new Date(data.expires_at) < new Date()) return false;
    return true;
  } catch (e) {
    console.error('[access-token] Validation failed:', e);
    return false;
  }
}

// Trigger daily error digest check (runs in background, doesn't block page load)
async function triggerErrorDigest() {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/error-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send_digest' }),
    });
    if (response.ok) {
      const result = await response.json();
      if (result.emailSent) {
        console.log('[digest] Error digest email sent');
      } else if (result.skipped) {
        console.log('[digest] Skipped:', result.reason);
      } else if (result.errorCount === 0) {
        console.log('[digest] No errors to report');
      }
    }
  } catch (e) {
    // Silently ignore digest errors - this is non-critical
    console.log('[digest] Check failed (non-critical):', e.message);
  }
}

// Fire digest check after a short delay (don't block page load)
setTimeout(triggerErrorDigest, 5000);

// DOM elements
const cardView = document.getElementById('cardView');
const tableView = document.getElementById('tableView');
const tableBody = document.getElementById('tableBody');
const cardViewBtn = document.getElementById('cardViewBtn');
const tableViewBtn = document.getElementById('tableViewBtn');
const searchInput = document.getElementById('searchInput');
const parentFilter = document.getElementById('parentFilter');
const bathFilter = document.getElementById('bathFilter');
const showDwellings = document.getElementById('showDwellings');
const showEventSpaces = document.getElementById('showEventSpaces');
const showOther = document.getElementById('showOther');
const clearFilters = document.getElementById('clearFilters');
const spaceDetailModal = document.getElementById('spaceDetailModal');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);

  // Check for access token in URL or sessionStorage (allows unauthenticated viewing)
  const urlToken = urlParams.get('access');
  const sessionToken = sessionStorage.getItem('your-project-access-token');

  if (urlToken) {
    const valid = await validateAccessToken(urlToken);
    if (valid) {
      accessTokenMode = true;
      sessionStorage.setItem('your-project-access-token', urlToken);
      // Strip token from URL to prevent accidental sharing
      const cleanUrl = new URL(window.location);
      cleanUrl.searchParams.delete('access');
      window.history.replaceState({}, '', cleanUrl);
    }
  } else if (sessionToken) {
    // Re-validate stored token (may have been revoked or expired)
    const valid = await validateAccessToken(sessionToken);
    if (valid) {
      accessTokenMode = true;
    } else {
      sessionStorage.removeItem('your-project-access-token');
    }
  }

  if (!accessTokenMode) {
    // Init auth but don't require it — this is a public page
    await initAuth();
    initPublicHeaderAuth({ authContainerId: 'publicHeaderAuth', signInLinkId: 'publicSignInLink' });
  }
  // Check for URL parameters
  const directSpaceSlug = urlParams.get('space');
  const directSpaceId = urlParams.get('id');
  const viewParam = urlParams.get('view');

  // Handle ?view=events to show event spaces by default
  if (viewParam === 'events') {
    showDwellings.checked = false;
    showEventSpaces.checked = true;
  }

  await loadData();
  setupEventListeners();
  render();

  // If slug or ID provided, show that space's detail modal
  if (directSpaceSlug) {
    const space = spaces.find(s => s.slug === directSpaceSlug);
    if (space) showSpaceDetail(space.id);
  } else if (directSpaceId) {
    showSpaceDetail(directSpaceId);
  }
});

// Load data from Supabase with retry logic
async function loadData(retryCount = 0) {
  const maxRetries = 3;

  try {
    // Load spaces
    const { data: spacesData, error: spacesError } = await supabase
      .from('spaces')
      .select(`
        id, name, slug, description, location, monthly_rate,
        sq_footage, bath_privacy, bath_fixture,
        beds_king, beds_queen, beds_double, beds_twin, beds_folding,
        min_residents, max_residents, is_listed, is_secret, is_micro, can_be_dwelling, can_be_event,
        parent_id,
        parent:parent_id(name, slug),
        space_amenities(amenity:amenity_id(name)),
        media_spaces(display_order, is_primary, media:media_id(id, url, caption))
      `)
      .order('monthly_rate', { ascending: false, nullsFirst: false })
      .order('name');

    if (spacesError) throw spacesError;

    // Load active assignments (just dates, no personal info)
    const { data: assignmentsData, error: assignmentsError } = await supabase
      .from('assignments')
      .select(`
        id,
        start_date,
        end_date,
        desired_departure_date,
        desired_departure_listed,
        status,
        assignment_spaces(space_id)
      `)
      .in('status', ['active', 'pending_contract', 'contract_sent']);

    if (assignmentsError) throw assignmentsError;

    const assignments = assignmentsData || [];
    const today = getAustinToday();

    // Add N days to a Date object (returns a new Date)
    const addDays = (date, n) => {
      const d = new Date(date);
      d.setDate(d.getDate() + n);
      return d;
    };

    // Process spaces
    spaces = (spacesData || []).filter(s => !s.is_archived && !s.is_micro);

    spaces.forEach(space => {
      space.amenities = space.space_amenities?.map(sa => sa.amenity?.name).filter(Boolean) || [];
      space.photos = (space.media_spaces || [])
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(ms => ms.media ? { ...ms.media, display_order: ms.display_order, is_primary: ms.is_primary } : null)
        .filter(p => p && p.url);

      // Compute availability from assignments
      const spaceAssignments = assignments
        .filter(a => a.assignment_spaces?.some(as => as.space_id === space.id))
        .sort((a, b) => {
          const aStart = a.start_date ? new Date(a.start_date) : new Date(0);
          const bStart = b.start_date ? new Date(b.start_date) : new Date(0);
          return aStart - bStart;
        });

      // Find current assignment (active and either no end date or end date >= today)
      const currentAssignment = spaceAssignments.find(a => {
        if (a.status !== 'active') return false;
        // Only use desired_departure_date if it's listed (published for consumers)
        const effectiveEndDate = (a.desired_departure_listed && a.desired_departure_date) || a.end_date;
        if (!effectiveEndDate) return true;
        return isTodayOrAfterAustin(effectiveEndDate);
      });

      // Get effective end date (only use desired_departure_date if listed)
      const getEffectiveEndDate = (assignment) => {
        if (!assignment) return null;
        if (assignment.desired_departure_listed && assignment.desired_departure_date) {
          return assignment.desired_departure_date;
        }
        return assignment.end_date;
      };

      // Find next assignment (starts after current ends)
      // end_date = last occupied night, so available = end_date + 2
      // (checkout day + 1 day cleaning buffer)
      const effectiveEndDate = getEffectiveEndDate(currentAssignment);
      const availableFrom = effectiveEndDate
        ? addDays(parseAustinDate(effectiveEndDate), 2)
        : today;

      const nextAssignment = spaceAssignments.find(a => {
        if (a === currentAssignment) return false;
        if (!a.start_date) return false;
        const startDate = parseAustinDate(a.start_date);
        return startDate >= availableFrom;
      });

      space.isAvailable = !currentAssignment;
      space.availableFrom = currentAssignment
        ? (effectiveEndDate ? addDays(parseAustinDate(effectiveEndDate), 2) : null)
        : today;
      space.availableUntil = nextAssignment?.start_date
        ? parseAustinDate(nextAssignment.start_date)
        : null;
    });

    // Note: Parent-child availability is independent. Each space's availability
    // is determined solely by its own assignments. A booking in one room of a
    // multi-unit space (e.g. Spartan Trailer) does not block other rooms.

    // Third pass: propagate child unavailability to parents
    // If any child space is occupied, the parent is also unavailable
    // Note: A space can be both a parent (has children) AND a child (has parent_id)
    spaces.forEach(space => {
      if (space.isAvailable) {
        // Check if this space has any children
        const childSpaces = spaces.filter(s => s.parent_id === space.id);
        if (childSpaces.length > 0) {
          const unavailableChildren = childSpaces.filter(child => !child.isAvailable);
          if (unavailableChildren.length > 0) {
            // At least one child is occupied, so parent becomes unavailable
            space.isAvailable = false;
            // Parent becomes available when ALL children are available
            // So use the latest (max) availableFrom date among unavailable children
            const childAvailableDates = unavailableChildren
              .map(c => c.availableFrom)
              .filter(d => d !== null);
            if (childAvailableDates.length > 0) {
              space.availableFrom = new Date(Math.max(...childAvailableDates.map(d => d.getTime())));
            } else {
              space.availableFrom = null; // TBD - no known end date
            }
          }
        }
      }
    });

  } catch (error) {
    console.error('Error loading data:', error);

    // Retry on AbortError (network issues)
    if (error.name === 'AbortError' || error.message?.includes('aborted')) {
      if (retryCount < maxRetries) {
        console.log(`Retrying... (attempt ${retryCount + 2}/${maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        return loadData(retryCount + 1);
      }
    }

    // Show user-friendly message
    cardView.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--text-muted);">
        <p>Unable to load spaces. Please refresh the page.</p>
        <button onclick="location.reload()" style="margin-top: 1rem; padding: 0.5rem 1rem; cursor: pointer;">
          Refresh
        </button>
      </div>
    `;
  }
}

// Setup event listeners
function setupEventListeners() {
  // View toggle
  cardViewBtn.addEventListener('click', () => setView('card'));
  tableViewBtn.addEventListener('click', () => setView('table'));

  // Filters
  searchInput.addEventListener('input', render);
  parentFilter.addEventListener('change', render);
  bathFilter.addEventListener('change', render);
  showDwellings?.addEventListener('change', render);
  showEventSpaces?.addEventListener('change', render);
  showOther?.addEventListener('change', render);
  clearFilters.addEventListener('click', resetFilters);

  // Populate parent filter dropdown
  populateParentFilter();

  // Table sorting
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => handleSort(th.dataset.sort));
  });

  // Modal close
  document.getElementById('closeDetailModal').addEventListener('click', () => {
    spaceDetailModal.classList.add('hidden');
    document.body.style.overflow = '';
    const url = new URL(window.location);
    url.searchParams.delete('id');
    url.searchParams.delete('space');
    window.history.replaceState({}, '', url);
  });

  // Share button — uses edge function URL for OG-tagged link previews
  document.getElementById('detailShareBtn').addEventListener('click', async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const spaceSlug = urlParams.get('space');
    const spaceId = urlParams.get('id');
    // Build share URL: edge function for slug-based (OG tags), direct URL for id-based
    const shareUrl = spaceSlug
      ? `${SUPABASE_URL}/functions/v1/share-space?space=${encodeURIComponent(spaceSlug)}`
      : window.location.href;
    const title = document.getElementById('detailSpaceName').textContent;
    const btn = document.getElementById('detailShareBtn');
    if (navigator.share) {
      try {
        await navigator.share({ title, url: shareUrl });
      } catch (e) { /* user cancelled */ }
    } else {
      await navigator.clipboard.writeText(shareUrl);
      btn.classList.add('copied');
      btn.title = 'Link copied!';
      setTimeout(() => { btn.classList.remove('copied'); btn.title = 'Share this space'; }, 2000);
    }
  });

  spaceDetailModal.addEventListener('click', (e) => {
    if (e.target === spaceDetailModal) {
      spaceDetailModal.classList.add('hidden');
      document.body.style.overflow = '';
      const url = new URL(window.location);
      url.searchParams.delete('id');
      url.searchParams.delete('space');
      window.history.replaceState({}, '', url);
    }
  });
}

// View management
function setView(view) {
  currentView = view;
  cardViewBtn.classList.toggle('active', view === 'card');
  tableViewBtn.classList.toggle('active', view === 'table');
  cardView.classList.toggle('hidden', view !== 'card');
  tableView.classList.toggle('hidden', view !== 'table');
}

// Filtering - only show listed, non-secret spaces in the listing
function getFilteredSpaces() {
  // Filter to only listed, non-secret spaces for browsing
  let filtered = spaces.filter(s => s.is_listed && !s.is_secret);

  // Search
  const search = searchInput.value.toLowerCase();
  if (search) {
    filtered = filtered.filter(s =>
      s.name.toLowerCase().includes(search) ||
      (s.description && s.description.toLowerCase().includes(search))
    );
  }

  // Parent filter
  const parent = parentFilter.value;
  if (parent) {
    filtered = filtered.filter(s => s.parent?.name === parent);
  }

  // Bath filter
  const bath = bathFilter.value;
  if (bath) {
    filtered = filtered.filter(s => s.bath_privacy === bath);
  }

  // Type filter (Dwellings, Event Spaces, Other)
  const dwellingsChecked = showDwellings?.checked ?? true;
  const eventSpacesChecked = showEventSpaces?.checked ?? true;
  const otherChecked = showOther?.checked ?? true;
  if (!dwellingsChecked || !eventSpacesChecked || !otherChecked) {
    filtered = filtered.filter(s => {
      const isDwelling = s.can_be_dwelling;
      const isEventSpace = s.can_be_event;
      const isOther = !isDwelling && !isEventSpace;
      if (dwellingsChecked && isDwelling) return true;
      if (eventSpacesChecked && isEventSpace) return true;
      if (otherChecked && isOther) return true;
      return false;
    });
  }

  // Sort: available within 30 days first, then by monthly_rate descending, then by name
  const today = getAustinToday();
  const thirtyDaysFromNow = new Date(today);
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  filtered.sort((a, b) => {
    // Spaces available within the next 30 days come first
    const aAvailSoon = a.availableFrom && a.availableFrom <= thirtyDaysFromNow;
    const bAvailSoon = b.availableFrom && b.availableFrom <= thirtyDaysFromNow;
    if (aAvailSoon && !bAvailSoon) return -1;
    if (!aAvailSoon && bAvailSoon) return 1;

    // Then sort by monthly_rate descending (highest first)
    const aRate = a.monthly_rate || 0;
    const bRate = b.monthly_rate || 0;
    if (aRate !== bRate) return bRate - aRate;

    // Then by name
    return (a.name || '').localeCompare(b.name || '');
  });

  return filtered;
}

function resetFilters() {
  searchInput.value = '';
  parentFilter.value = '';
  bathFilter.value = '';
  if (showDwellings) showDwellings.checked = true;
  if (showEventSpaces) showEventSpaces.checked = false;
  if (showOther) showOther.checked = false;
  render();
}

// Populate parent filter dropdown from loaded spaces
function populateParentFilter() {
  const parents = new Set();
  spaces.forEach(s => {
    if (s.parent?.name) {
      parents.add(s.parent.name);
    }
  });

  // Sort parent names alphabetically
  const sortedParents = Array.from(parents).sort();

  // Clear existing options except first
  while (parentFilter.options.length > 1) {
    parentFilter.remove(1);
  }

  // Add parent options
  sortedParents.forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    parentFilter.appendChild(option);
  });
}

function handleSort(column) {
  // For now, just re-render (sorting is handled in getFilteredSpaces)
  render();
}

// Rendering
function render() {
  const filtered = getFilteredSpaces();
  renderCards(filtered);
  renderTable(filtered);
}

// Helper to format dates in Austin timezone
function formatDate(d) {
  if (!d) return null;
  return formatDateAustin(d, { month: 'short', day: 'numeric' });
}

function renderCards(spacesToRender) {
  if (spacesToRender.length === 0) {
    cardView.innerHTML = `
      <div style="grid-column: 1/-1;" class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <p class="empty-state-title">No spaces found</p>
        <p>Try adjusting your filters or search terms</p>
      </div>
    `;
    return;
  }

  cardView.innerHTML = spacesToRender.map(space => {
    const photo = space.photos[0];
    const photoCount = space.photos.length;
    const beds = getBedSummary(space);
    const bathText = (space.can_be_dwelling && space.bath_privacy && space.bath_privacy !== 'none') ? space.bath_privacy : '';

    // Availability display
    const availFromStr = space.isAvailable ? 'Now' : (space.availableFrom ? formatDate(space.availableFrom) : 'TBD');
    const availUntilStr = space.availableUntil ? formatDate(space.availableUntil) : 'Open-ended';

    const fromBadgeClass = space.isAvailable ? 'available' : 'occupied';
    const untilBadgeClass = availUntilStr === 'Open-ended' ? 'available' : 'occupied';

    // Location/parent display
    const locationText = space.location || (space.parent ? space.parent.name : '');

    // Photo count overlay (only show if more than 1 photo)
    const photoCountHtml = photoCount > 1 ? `
      <div class="photo-count">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
        ${photoCount}
      </div>
    ` : '';

    return `
      <div class="space-card" onclick="showSpaceDetail('${space.id}')">
        <div class="card-image">
          ${photo
            ? `<img src="${photo.url}" alt="${space.name}">`
            : `<div class="no-photo">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
                  <path d="M21 15l-5-5L5 21"/>
                </svg>
                No photos
              </div>`
          }
          ${photoCountHtml}
        </div>
        <div class="card-badges">
          <span class="badge ${fromBadgeClass}">Available: ${availFromStr}</span>
          <span class="badge ${untilBadgeClass} badge-right">Until: ${availUntilStr}</span>
        </div>
        <div class="card-body">
          <div class="card-header">
            <div>
              <div class="card-title">${space.parent?.name ? `<a href="?${getParentUrlParam(space.parent)}" class="card-parent-link" onclick="event.stopPropagation();">${space.parent.name} /</a> ` : ''}${space.name}</div>
              ${space.description ? `<div class="card-description">${space.description}</div>` : ''}
            </div>
          </div>
          <div class="card-details">
            ${space.sq_footage ? `<span class="detail-item"><span class="detail-icon">📐</span>${space.sq_footage} sq ft</span>` : ''}
            ${beds ? `<span class="detail-item"><span class="detail-icon">🛏️</span>${beds}</span>` : ''}
            ${bathText ? `<span class="detail-item"><span class="detail-icon">🚿</span>${bathText} bath</span>` : ''}
          </div>
          <div class="card-footer">
            ${space.monthly_rate ? `<div class="card-price">$${space.monthly_rate}<span>/mo</span></div>` : ''}
            ${space.amenities.length ? `
              <div class="card-amenities">
                ${space.amenities.slice(0, 3).map(a => `<span class="amenity-tag">${a}</span>`).join('')}
                ${space.amenities.length > 3 ? `<span class="amenity-tag amenity-more">+${space.amenities.length - 3}</span>` : ''}
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderTable(spacesToRender) {
  if (spacesToRender.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="10" class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <p class="empty-state-title">No spaces found</p>
          <p>Try adjusting your filters or search terms</p>
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = spacesToRender.map(space => {
    const beds = getBedSummary(space);

    const availFromStr = space.isAvailable ? 'Now' : (space.availableFrom ? formatDate(space.availableFrom) : 'TBD');
    const availUntilStr = space.availableUntil ? formatDate(space.availableUntil) : 'Open-ended';

    // Thumbnail
    const thumbnail = space.photos.length > 0
      ? `<img src="${space.photos[0].url}" alt="" class="table-thumbnail" onclick="event.stopPropagation(); openLightboxForSpace('${space.photos[0].url}', '${space.id}')" style="cursor: zoom-in;">`
      : `<div class="table-thumbnail-placeholder"></div>`;

    // Description (truncated)
    const description = space.description
      ? (space.description.length > 80 ? space.description.substring(0, 80) + '...' : space.description)
      : '-';

    return `
      <tr onclick="showSpaceDetail('${space.id}')" style="cursor:pointer;">
        <td class="td-thumbnail">${thumbnail}</td>
        <td>${space.parent?.name ? `<a href="?${getParentUrlParam(space.parent)}" class="table-parent-link" onclick="event.stopPropagation();">${space.parent.name} /</a> ` : ''}<strong>${space.name}</strong></td>
        <td class="td-description">${description}</td>
        <td>${space.monthly_rate ? `$${space.monthly_rate}/mo` : '-'}</td>
        <td class="td-hide-mobile">${space.sq_footage || '-'}</td>
        <td>${beds || '-'}</td>
        <td class="td-hide-mobile">${(space.can_be_dwelling && space.bath_privacy && space.bath_privacy !== 'none') ? space.bath_privacy : '-'}</td>
        <td class="td-hide-mobile">${space.amenities.slice(0, 3).join(', ') || '-'}</td>
        <td>${availFromStr}</td>
        <td class="td-hide-mobile">${availUntilStr}</td>
      </tr>
    `;
  }).join('');
}

// Helpers
function getParentSpaceId(parentName) {
  const parentSpace = spaces.find(s => s.name === parentName);
  return parentSpace?.id || '';
}

function getSpaceUrlParam(space) {
  return space.slug ? `space=${encodeURIComponent(space.slug)}` : `id=${space.id}`;
}

function getParentUrlParam(parentObj) {
  if (parentObj?.slug) return `space=${encodeURIComponent(parentObj.slug)}`;
  const parentSpace = spaces.find(s => s.name === parentObj?.name);
  return parentSpace?.slug ? `space=${encodeURIComponent(parentSpace.slug)}` : `id=${parentSpace?.id || ''}`;
}

function getBedSummary(space) {
  const beds = [];
  if (space.beds_king) beds.push(`${space.beds_king} king`);
  if (space.beds_queen) beds.push(`${space.beds_queen} queen`);
  if (space.beds_double) beds.push(`${space.beds_double} full`);
  if (space.beds_twin) beds.push(`${space.beds_twin} twin`);
  if (space.beds_folding) beds.push(`${space.beds_folding} folding`);
  return beds.join(', ');
}

// Space detail modal - works for both listed and secret spaces via direct link
function showSpaceDetail(spaceId) {
  const space = spaces.find(s => s.id === spaceId);
  if (!space) {
    // Space not found - might be a secret space we need to fetch directly
    fetchAndShowSpace(spaceId);
    return;
  }

  displaySpaceDetail(space);
}

async function fetchAndShowSpace(spaceId) {
  try {
    const { data: space, error } = await supabase
      .from('spaces')
      .select(`
        id, name, slug, description, location, monthly_rate,
        sq_footage, bath_privacy, bath_fixture,
        beds_king, beds_queen, beds_double, beds_twin, beds_folding,
        min_residents, max_residents, is_listed, is_secret, is_micro, can_be_dwelling, can_be_event,
        parent:parent_id(name, slug),
        space_amenities(amenity:amenity_id(name)),
        media_spaces(display_order, is_primary, media:media_id(id, url, caption))
      `)
      .eq('id', spaceId)
      .eq('can_be_dwelling', true)
      .single();

    if (error || !space) {
      alert('Space not found');
      return;
    }

    // Process the space data
    space.amenities = space.space_amenities?.map(sa => sa.amenity?.name).filter(Boolean) || [];
    space.photos = (space.media_spaces || [])
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
      .map(ms => ms.media ? { ...ms.media, display_order: ms.display_order, is_primary: ms.is_primary } : null)
      .filter(p => p && p.url);

    // For directly fetched spaces, assume available (we don't load assignments for single fetch)
    space.isAvailable = true;
    space.availableFrom = getAustinToday();
    space.availableUntil = null;

    displaySpaceDetail(space);
  } catch (error) {
    console.error('Error fetching space:', error);
    alert('Failed to load space');
  }
}

function displaySpaceDetail(space) {
  // Update header with parent link if exists
  const headerHtml = space.parent?.name
    ? `<a href="?${getParentUrlParam(space.parent)}" class="detail-parent-link">${space.parent.name} /</a> ${space.name}`
    : space.name;
  document.getElementById('detailSpaceName').innerHTML = headerHtml;

  // Update URL with slug for shareable links (fallback to id if no slug)
  const url = new URL(window.location);
  if (space.slug) {
    url.searchParams.delete('id');
    url.searchParams.set('space', space.slug);
  } else {
    url.searchParams.set('id', space.id);
  }
  window.history.replaceState({}, '', url);

  // Walk up the parent chain to collect all ancestor photos
  // Each entry: { name, photos }
  const ancestorPhotoSections = [];
  let currentParentName = space.parent?.name;
  console.log('Starting parent chain walk from:', space.name, 'first parent:', currentParentName);
  while (currentParentName) {
    const parentSpace = spaces.find(s => s.name === currentParentName);
    console.log('Looking for:', currentParentName, 'found:', parentSpace?.name, 'photos:', parentSpace?.photos?.length);
    if (parentSpace && parentSpace.photos && parentSpace.photos.length > 0) {
      ancestorPhotoSections.push({
        name: parentSpace.name,
        photos: parentSpace.photos
      });
    }
    // Move up to the next parent
    const nextParent = parentSpace?.parent?.name || null;
    console.log('Next parent:', nextParent);
    currentParentName = nextParent;
  }
  console.log('Ancestor sections:', ancestorPhotoSections.map(s => s.name));

  // Find child spaces (spaces whose parent is this space)
  const childSpaces = spaces.filter(s => s.parent?.name === space.name && s.photos && s.photos.length > 0);
  console.log('Child spaces with photos:', childSpaces.map(s => s.name));

  // Combine all photos for lightbox gallery (space photos first, then children, then ancestors)
  const allPhotos = [...space.photos];
  childSpaces.forEach(child => {
    allPhotos.push(...child.photos);
  });
  ancestorPhotoSections.forEach(section => {
    allPhotos.push(...section.photos);
  });
  if (allPhotos.length) {
    setCurrentGallery(allPhotos);
  }

  // Build space photos HTML (at bottom)
  let spacePhotosHtml = '';
  if (space.photos.length) {
    spacePhotosHtml = `
      <div class="detail-section detail-photos">
        <h3>${space.name} Photos</h3>
        <div class="detail-photos-grid">
          ${space.photos.map(p => `
            <div class="detail-photo" onclick="openLightbox('${p.url}')" style="cursor: zoom-in;">
              <img src="${p.url}" alt="${p.caption || space.name}">
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Build child spaces photos HTML (each child gets its own section)
  let childPhotosHtml = '';
  childSpaces.forEach(child => {
    childPhotosHtml += `
      <div class="detail-section detail-photos">
        <h3>${child.name} Photos</h3>
        <div class="detail-photos-grid">
          ${child.photos.map(p => `
            <div class="detail-photo" onclick="openLightbox('${p.url}')" style="cursor: zoom-in;">
              <img src="${p.url}" alt="${p.caption || child.name}">
            </div>
          `).join('')}
        </div>
      </div>
    `;
  });

  // Build ancestor photos HTML (each ancestor gets its own section, closest parent first)
  // Add visual separator if there are space or child photos before ancestors
  const needsSeparator = (space.photos.length > 0 || childSpaces.length > 0) && ancestorPhotoSections.length > 0;
  let ancestorPhotosHtml = needsSeparator ? '<hr style="border: none; border-top: 1px solid var(--border); margin: 1.5rem 0;">' : '';
  ancestorPhotoSections.forEach(section => {
    ancestorPhotosHtml += `
      <div class="detail-section detail-photos">
        <h3>${section.name} Photos</h3>
        <div class="detail-photos-grid">
          ${section.photos.map(p => `
            <div class="detail-photo" onclick="openLightbox('${p.url}')" style="cursor: zoom-in;">
              <img src="${p.url}" alt="${p.caption || section.name}">
            </div>
          `).join('')}
        </div>
      </div>
    `;
  });

  // Availability info
  const availFromStr = space.isAvailable ? 'Now' : (space.availableFrom ? formatDate(space.availableFrom) : 'TBD');
  const availUntilStr = space.availableUntil ? formatDate(space.availableUntil) : 'Ongoing';

  document.getElementById('spaceDetailBody').innerHTML = `
    <div class="detail-grid">
      <div class="detail-section">
        <h3>Details</h3>
        ${space.monthly_rate ? `<p><strong>Rate:</strong> $${space.monthly_rate}/mo</p>` : ''}
        <p><strong>Size:</strong> ${space.sq_footage ? `${space.sq_footage} sq ft` : 'N/A'}</p>
        <p><strong>Beds:</strong> ${getBedSummary(space) || 'N/A'}</p>
        ${space.can_be_dwelling && ((space.bath_privacy && space.bath_privacy !== 'none') || space.bath_fixture) ? `<p><strong>Bathroom:</strong> ${(space.bath_privacy && space.bath_privacy !== 'none') ? space.bath_privacy : ''}${space.bath_fixture ? ` (${space.bath_fixture})` : ''}</p>` : ''}
        <p><strong>Capacity:</strong> ${space.min_residents || 1}-${space.max_residents || '?'} residents</p>
      </div>
      <div class="detail-section">
        <h3>Availability</h3>
        <p><strong>Available from:</strong> ${availFromStr}</p>
        <p><strong>Available until:</strong> ${availUntilStr}</p>
      </div>
      <div class="detail-section detail-full-width">
        <h3>Amenities</h3>
        ${space.amenities.length
          ? `<p>${space.amenities.join(', ')}</p>`
          : '<p>No amenities listed</p>'
        }
      </div>
    ${space.description ? `
      <div class="detail-section detail-description">
        <h3>Description</h3>
        <p>${space.description}</p>
      </div>
    ` : ''}
    </div>
    ${spacePhotosHtml}
    ${childPhotosHtml}
    ${ancestorPhotosHtml}
  `;

  spaceDetailModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

// Lightbox functionality
let lightboxGallery = [];
let lightboxIndex = 0;
let currentGalleryUrls = []; // Stores URLs of photos in currently displayed space

function setCurrentGallery(photos) {
  currentGalleryUrls = photos.map(p => p.url);
}

function openLightboxForSpace(imageUrl, spaceId) {
  const space = spaces.find(s => s.id === spaceId);
  const gallery = space ? space.photos.map(p => p.url) : [];
  openLightbox(imageUrl, gallery);
}

function openLightbox(imageUrl, galleryUrls) {
  const lightbox = document.getElementById('imageLightbox');
  const lightboxImage = document.getElementById('lightboxImage');
  if (lightbox && lightboxImage) {
    // Use explicit gallery if provided, then current gallery, then single image
    if (galleryUrls && galleryUrls.length > 0) {
      lightboxGallery = [...galleryUrls];
      lightboxIndex = lightboxGallery.indexOf(imageUrl);
      if (lightboxIndex < 0) lightboxIndex = 0;
    } else if (currentGalleryUrls.length > 0 && currentGalleryUrls.includes(imageUrl)) {
      lightboxGallery = [...currentGalleryUrls];
      lightboxIndex = lightboxGallery.indexOf(imageUrl);
    } else {
      lightboxGallery = [imageUrl];
      lightboxIndex = 0;
    }

    lightboxImage.src = imageUrl;
    lightbox.classList.remove('hidden');
    updateLightboxNav();
  }
}

function updateLightboxNav() {
  const prevBtn = document.getElementById('lightboxPrev');
  const nextBtn = document.getElementById('lightboxNext');
  if (prevBtn && nextBtn) {
    prevBtn.disabled = lightboxIndex <= 0;
    nextBtn.disabled = lightboxIndex >= lightboxGallery.length - 1;
    // Hide nav buttons if only one image
    const showNav = lightboxGallery.length > 1;
    prevBtn.style.display = showNav ? 'flex' : 'none';
    nextBtn.style.display = showNav ? 'flex' : 'none';
  }
}

function lightboxPrev() {
  if (lightboxIndex > 0) {
    lightboxIndex--;
    document.getElementById('lightboxImage').src = lightboxGallery[lightboxIndex];
    updateLightboxNav();
  }
}

function lightboxNext() {
  if (lightboxIndex < lightboxGallery.length - 1) {
    lightboxIndex++;
    document.getElementById('lightboxImage').src = lightboxGallery[lightboxIndex];
    updateLightboxNav();
  }
}

function closeLightbox() {
  const lightbox = document.getElementById('imageLightbox');
  if (lightbox) {
    lightbox.classList.add('hidden');
    document.getElementById('lightboxImage').src = '';
    lightboxGallery = [];
    lightboxIndex = 0;
  }
}

// Lightbox event listeners
document.addEventListener('DOMContentLoaded', () => {
  const lightbox = document.getElementById('imageLightbox');
  if (lightbox) {
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox || e.target.classList.contains('lightbox-close')) {
        closeLightbox();
      }
    });
  }

  // Navigation buttons
  const prevBtn = document.getElementById('lightboxPrev');
  const nextBtn = document.getElementById('lightboxNext');
  if (prevBtn) prevBtn.addEventListener('click', (e) => { e.stopPropagation(); lightboxPrev(); });
  if (nextBtn) nextBtn.addEventListener('click', (e) => { e.stopPropagation(); lightboxNext(); });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    const lightbox = document.getElementById('imageLightbox');
    if (!lightbox || lightbox.classList.contains('hidden')) return;

    if (e.key === 'Escape') {
      closeLightbox();
    } else if (e.key === 'ArrowLeft') {
      lightboxPrev();
    } else if (e.key === 'ArrowRight') {
      lightboxNext();
    }
  });
});

// Make functions globally accessible for onclick handlers
window.showSpaceDetail = showSpaceDetail;
window.openLightbox = openLightbox;
