/**
 * Spaces - Admin page for managing spaces
 */

import { supabase } from '../../shared/supabase.js';
import { mediaService } from '../../shared/media-service.js';
import {
  formatDateAustin,
  getAustinToday,
  parseAustinDate,
  isTodayOrAfterAustin,
} from '../../shared/timezone.js';
import {
  initAdminPage,
  showToast,
  openLightbox,
  closeLightbox,
  lightboxPrev,
  lightboxNext,
  setCurrentGallery,
  setupLightbox,
} from '../../shared/admin-shell.js';
import { isDemoUser, redactString } from '../../shared/demo-redact.js';

// =============================================
// STATE
// =============================================
let authState = null;
let allSpaces = [];
let archivedSpaces = [];
let assignments = [];
let photoRequests = [];
let allTags = [];
let storageUsage = null;

// Spaces view state
let currentView = 'table';  // 'card' or 'table' - default to table
let currentSort = { column: 'monthly_rate', direction: 'desc' };

// Photo upload state
let currentUploadSpaceId = null;
let currentUploadContext = null;
let selectedLibraryMedia = new Set();
let libraryMedia = [];
let activeLibraryFilters = { tags: [], category: '' };
let selectedUploadFiles = [];
let isPhotoUploading = false;
let isLibraryLoading = false;

// Edit space state
let currentEditSpaceId = null;
let isSavingSpace = false;
let allAmenities = []; // Cached list of all amenity definitions

// Lightbox state for spaces
let currentGalleryUrls = [];

// Media detail state
let currentMediaId = null;

// =============================================
// INITIALIZATION
// =============================================
document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'spaces',
    section: 'staff',
    onReady: (state) => {
      authState = state;
      loadSpacesData();
    }
  });

  // Add space form
  document.getElementById('addSpaceForm')?.addEventListener('submit', handleAddSpace);

  // View toggle
  document.getElementById('cardViewBtn')?.addEventListener('click', () => setView('card'));
  document.getElementById('tableViewBtn')?.addEventListener('click', () => setView('table'));

  // Space filters
  document.getElementById('searchFilter')?.addEventListener('input', renderSpacesView);
  document.getElementById('parentFilter')?.addEventListener('change', renderSpacesView);
  document.getElementById('bathFilter')?.addEventListener('change', renderSpacesView);
  document.getElementById('visibilityFilter')?.addEventListener('change', renderSpacesView);
  document.getElementById('showDwellings')?.addEventListener('change', renderSpacesView);
  document.getElementById('showEventSpaces')?.addEventListener('change', renderSpacesView);
  document.getElementById('showOther')?.addEventListener('change', renderSpacesView);
  document.getElementById('clearSpaceFilters')?.addEventListener('click', () => {
    document.getElementById('searchFilter').value = '';
    document.getElementById('parentFilter').value = '';
    document.getElementById('bathFilter').value = '';
    document.getElementById('visibilityFilter').value = '';
    document.getElementById('showDwellings').checked = true;
    document.getElementById('showEventSpaces').checked = true;
    document.getElementById('showOther').checked = true;
    renderSpacesView();
  });

  // Table sorting
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => handleSort(th.dataset.sort));
  });

  // Setup modal handlers
  setupSpaceModals();
  setupLightbox();
});

// =============================================
// SPACES DATA LOADING
// =============================================
async function loadSpacesData() {
  try {
    // Load spaces with all related data
    const { data: spacesData, error: spacesError } = await supabase
      .from('spaces')
      .select(`
        *,
        parent:parent_id(name),
        space_amenities(id, amenity:amenity_id(id, name)),
        media_spaces(
          display_order,
          is_primary,
          media:media_id(
            id,
            url,
            caption,
            title,
            media_type,
            category,
            file_size_bytes,
            media_tag_assignments(tag:tag_id(id,name,color,tag_group))
          )
        )
      `)
      .order('monthly_rate', { ascending: false, nullsFirst: false })
      .order('name');

    if (spacesError) throw spacesError;

    // Load all tags with usage counts
    allTags = await mediaService.getTagsWithUsage();

    // Check storage usage
    storageUsage = await mediaService.getStorageUsage();

    // Load active assignments with people
    const { data: assignmentsData, error: assignmentsError } = await supabase
      .from('assignments')
      .select(`
        *,
        person:person_id(first_name, last_name, type, email, phone),
        assignment_spaces(space_id)
      `)
      .in('status', ['active', 'pending_contract', 'contract_sent'])
      .order('start_date');

    if (assignmentsError) throw assignmentsError;

    // Load photo requests
    const { data: requestsData, error: requestsError } = await supabase
      .from('photo_requests')
      .select('*')
      .in('status', ['pending', 'submitted']);

    if (requestsError) throw requestsError;

    // Process the data
    const allData = spacesData || [];
    assignments = assignmentsData || [];
    photoRequests = requestsData || [];

    const today = getAustinToday();

    // Process each space
    const processedSpaces = allData.map(space => {
      // Map assignments to this space
      const spaceAssignments = assignments
        .filter(a => a.assignment_spaces?.some(as => as.space_id === space.id))
        .sort((a, b) => {
          const aStart = a.start_date ? parseAustinDate(a.start_date) : new Date(0);
          const bStart = b.start_date ? parseAustinDate(b.start_date) : new Date(0);
          return aStart - bStart;
        });

      const currentAssignment = spaceAssignments.find(a => {
        if (a.status !== 'active') return false;
        const effectiveEndDate = (a.desired_departure_listed && a.desired_departure_date) || a.end_date;
        if (!effectiveEndDate) return true;
        return isTodayOrAfterAustin(effectiveEndDate);
      });

      const getEffectiveEndDate = (assignment) => {
        if (!assignment) return null;
        if (assignment.desired_departure_listed && assignment.desired_departure_date) {
          return assignment.desired_departure_date;
        }
        return assignment.end_date;
      };

      const effectiveEndDate = getEffectiveEndDate(currentAssignment);
      const availableFrom = effectiveEndDate
        ? parseAustinDate(effectiveEndDate)
        : today;

      const nextAssignment = spaceAssignments.find(a => {
        if (a === currentAssignment) return false;
        if (!a.start_date) return false;
        const startDate = parseAustinDate(a.start_date);
        return startDate > availableFrom;
      });

      space.currentAssignment = currentAssignment || null;
      space.nextAssignment = nextAssignment || null;
      space.isAvailable = !currentAssignment;
      space.availableFrom = currentAssignment ? (effectiveEndDate ? parseAustinDate(effectiveEndDate) : null) : today;
      space.availableUntil = nextAssignment?.start_date ? parseAustinDate(nextAssignment.start_date) : null;

      space.amenities = space.space_amenities?.map(sa => sa.amenity?.name).filter(Boolean) || [];
      space.amenityIds = space.space_amenities?.map(sa => sa.amenity?.id).filter(Boolean) || [];

      // Process media
      space.photos = (space.media_spaces || [])
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(ms => {
          if (!ms.media) return null;
          return {
            ...ms.media,
            display_order: ms.display_order,
            is_primary: ms.is_primary,
            tags: ms.media.media_tag_assignments?.map(mta => mta.tag).filter(Boolean) || []
          };
        })
        .filter(p => p && p.url);

      space.photoRequests = photoRequests.filter(pr => pr.space_id === space.id);

      return space;
    });

    // Second pass: propagate parent unavailability to children
    processedSpaces.forEach(space => {
      if (space.parent_id && space.isAvailable) {
        const parentSpace = processedSpaces.find(s => s.id === space.parent_id);
        if (parentSpace && !parentSpace.isAvailable) {
          space.isAvailable = false;
          space.availableFrom = parentSpace.availableFrom;
          if (!space.availableUntil && parentSpace.availableUntil) {
            space.availableUntil = parentSpace.availableUntil;
          }
        }
      }
    });

    // Third pass: propagate child unavailability to parents
    processedSpaces.forEach(space => {
      if (space.isAvailable) {
        const childSpaces = processedSpaces.filter(s => s.parent_id === space.id);
        if (childSpaces.length > 0) {
          const unavailableChildren = childSpaces.filter(child => !child.isAvailable);
          if (unavailableChildren.length > 0) {
            space.isAvailable = false;
            const childAvailableDates = unavailableChildren
              .map(c => c.availableFrom)
              .filter(d => d !== null);
            if (childAvailableDates.length > 0) {
              space.availableFrom = new Date(Math.max(...childAvailableDates.map(d => d.getTime())));
            } else {
              space.availableFrom = null;
            }
          }
        }
      }
    });

    // Split into active and archived
    allSpaces = processedSpaces.filter(s => !s.is_archived);
    archivedSpaces = processedSpaces.filter(s => s.is_archived === true);

    // Render everything
    renderSpacesView();
    renderArchivedSpaces();
    populateParentDropdown();
    populateParentFilterDropdown();

    // Check for URL parameters
    checkUrlParameters();

  } catch (error) {
    console.error('Error loading spaces data:', error);
    showToast('Failed to load data. Check console for details.', 'error');
  }
}

function checkUrlParameters() {
  const urlParams = new URLSearchParams(window.location.search);
  const editSpaceId = urlParams.get('edit');
  if (editSpaceId) {
    const space = allSpaces.find(s => s.id === editSpaceId);
    if (space) {
      openEditSpace(editSpaceId);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }
}

// =============================================
// FILTERING & SORTING
// =============================================
function getFilteredSpaces() {
  let filtered = [...allSpaces];

  // Search filter
  const search = document.getElementById('searchFilter')?.value?.toLowerCase() || '';
  if (search) {
    filtered = filtered.filter(s =>
      s.name.toLowerCase().includes(search) ||
      (s.description && s.description.toLowerCase().includes(search))
    );
  }

  // Parent filter
  const parentId = document.getElementById('parentFilter')?.value || '';
  if (parentId) {
    filtered = filtered.filter(s => s.parent?.name === allSpaces.find(p => p.id === parentId)?.name || s.parent_id === parentId);
  }

  // Bath filter
  const bath = document.getElementById('bathFilter')?.value || '';
  if (bath) {
    filtered = filtered.filter(s => s.bath_privacy === bath);
  }

  // Visibility filter
  const visibility = document.getElementById('visibilityFilter')?.value || '';
  if (visibility === 'listed') {
    filtered = filtered.filter(s => s.is_listed && !s.is_secret);
  } else if (visibility === 'unlisted') {
    filtered = filtered.filter(s => !s.is_listed);
  } else if (visibility === 'secret') {
    filtered = filtered.filter(s => s.is_secret);
  }

  // Type filter (Dwellings, Event Spaces, Other)
  const dwellingsChecked = document.getElementById('showDwellings')?.checked ?? true;
  const eventSpacesChecked = document.getElementById('showEventSpaces')?.checked ?? true;
  const otherChecked = document.getElementById('showOther')?.checked ?? true;
  if (!dwellingsChecked || !eventSpacesChecked || !otherChecked) {
    filtered = filtered.filter(s => {
      const isDwelling = s.can_be_dwelling === true;
      const isEventSpace = s.can_be_event === true;
      const isOther = !isDwelling && !isEventSpace;
      if (dwellingsChecked && isDwelling) return true;
      if (eventSpacesChecked && isEventSpace) return true;
      if (otherChecked && isOther) return true;
      return false;
    });
  }

  // Sort: available spaces first, then by selected column
  filtered.sort((a, b) => {
    const aAvailable = !a.currentAssignment;
    const bAvailable = !b.currentAssignment;
    if (aAvailable && !bAvailable) return -1;
    if (!aAvailable && bAvailable) return 1;

    let aVal = a[currentSort.column];
    let bVal = b[currentSort.column];

    if (currentSort.column === 'occupant') {
      aVal = a.currentAssignment?.person?.first_name || '';
      bVal = b.currentAssignment?.person?.first_name || '';
    }

    const aNull = aVal === null || aVal === undefined || aVal === '';
    const bNull = bVal === null || bVal === undefined || bVal === '';
    if (aNull && !bNull) return 1;
    if (!aNull && bNull) return -1;
    if (aNull && bNull) return a.name.localeCompare(b.name);

    if (typeof aVal === 'string') {
      aVal = aVal.toLowerCase();
      bVal = bVal.toLowerCase();
    }

    if (aVal < bVal) return currentSort.direction === 'asc' ? -1 : 1;
    if (aVal > bVal) return currentSort.direction === 'asc' ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return filtered;
}

function populateParentFilterDropdown() {
  const select = document.getElementById('parentFilter');
  const parents = new Set();
  allSpaces.forEach(s => {
    if (s.parent?.name) parents.add(s.parent.name);
  });
  const sortedParents = Array.from(parents).sort();
  select.innerHTML = '<option value="">All areas</option>' +
    sortedParents.map(name => {
      const space = allSpaces.find(s => s.name === name);
      return `<option value="${space?.id || ''}">${name}</option>`;
    }).join('');
}

// =============================================
// VIEW MANAGEMENT
// =============================================
function setView(view) {
  currentView = view;
  document.getElementById('cardViewBtn')?.classList.toggle('active', view === 'card');
  document.getElementById('tableViewBtn')?.classList.toggle('active', view === 'table');
  document.getElementById('cardView')?.classList.toggle('hidden', view !== 'card');
  document.getElementById('tableView')?.classList.toggle('hidden', view !== 'table');
}

function handleSort(column) {
  if (currentSort.column === column) {
    currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    currentSort.column = column;
    currentSort.direction = 'asc';
  }
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === column) {
      th.classList.add(currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
  renderSpacesView();
}

function getSpaceCategoryType() {
  const d = document.getElementById('showDwellings')?.checked ?? true;
  const e = document.getElementById('showEventSpaces')?.checked ?? true;
  const o = document.getElementById('showOther')?.checked ?? true;
  if (d && e && o) return 'total';
  if (d && !e && !o) return 'dwelling';
  if (!d && e && !o) return 'event';
  if (!d && !e && o) return 'other';
  if (d && e && !o) return 'dwelling & event';
  if (d && !e && o) return 'dwelling & other';
  if (!d && e && o) return 'event & other';
  if (!d && !e && !o) return 'total';
  return 'total';
}

function renderSpacesView() {
  const filtered = getFilteredSpaces();
  const type = getSpaceCategoryType();
  const el = document.getElementById('spacesCount');
  el.innerHTML = `<strong>${filtered.length}</strong> ${type} spaces`;
  renderCards(filtered);
  renderTable(filtered);
}

// =============================================
// RENDERING
// =============================================
function getBedSummary(space) {
  const beds = [];
  if (space.beds_king) beds.push(`${space.beds_king} king`);
  if (space.beds_queen) beds.push(`${space.beds_queen} queen`);
  if (space.beds_double) beds.push(`${space.beds_double} full`);
  if (space.beds_twin) beds.push(`${space.beds_twin} twin`);
  if (space.beds_folding) beds.push(`${space.beds_folding} folding`);
  return beds.join(', ');
}

function getParentSpaceId(parentName) {
  const parentSpace = allSpaces.find(s => s.name === parentName);
  return parentSpace ? parentSpace.id : null;
}

function renderCards(spacesToRender) {
  const cardView = document.getElementById('cardView');
  const isAdmin = ['admin', 'oracle'].includes(authState?.appUser?.role);

  cardView.innerHTML = spacesToRender.map(space => {
    const occupant = space.currentAssignment?.person;
    const photo = space.photos[0];
    const photoCount = space.photos.length;
    const isOccupied = !!space.currentAssignment;

    const fmtDate = (d) => d ? formatDateAustin(d, { month: 'short', day: 'numeric' }) : null;
    const availFromStr = space.availableFrom && space.availableFrom > getAustinToday()
      ? fmtDate(space.availableFrom)
      : 'NOW';
    const availUntilStr = space.availableUntil ? fmtDate(space.availableUntil) : 'Open';

    const fromBadgeClass = availFromStr === 'NOW' ? 'available' : 'occupied';
    const untilBadgeClass = availUntilStr === 'Open' ? 'available' : 'occupied';

    let badges = `<span class="badge ${fromBadgeClass}">Available: ${availFromStr}</span>`;
    badges += `<span class="badge ${untilBadgeClass} badge-right">Until: ${availUntilStr}</span>`;

    if (space.is_secret) badges += '<span class="badge secret">Secret</span>';
    else if (!space.is_listed) badges += '<span class="badge unlisted">Unlisted</span>';

    const beds = getBedSummary(space);
    const bathText = (space.can_be_dwelling && space.bath_privacy && space.bath_privacy !== 'none') ? space.bath_privacy : '';

    const photoCountHtml = photoCount > 1 ? `
      <div class="photo-count">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
        ${photoCount}
      </div>
    ` : '';

    let occupantHtml = '';
    if (isOccupied && occupant) {
      const name = `${occupant.first_name} ${occupant.last_name || ''}`.trim();
      const endDate = space.currentAssignment.end_date
        ? formatDateAustin(space.currentAssignment.end_date, { month: 'short', day: 'numeric', year: 'numeric' })
        : 'No end date';
      occupantHtml = `
        <div class="card-occupant">
          <strong>${name}</strong> · ${occupant.type}<br>
          <small>Until: ${endDate}</small>
        </div>
      `;
    }

    const pendingRequests = space.photoRequests?.filter(r => r.status === 'pending').length || 0;

    let actionsHtml = '';
    if (isAdmin) {
      actionsHtml = `
        <div class="card-actions">
          <button class="btn-edit" onclick="event.stopPropagation(); openEditSpace('${space.id}')">Edit</button>
          <button class="btn-small" onclick="event.stopPropagation(); openPhotoUpload('${space.id}', '${space.name.replace(/'/g, "\\'")}')">
            Add Images${pendingRequests ? ` (${pendingRequests} pending)` : ''}
          </button>
        </div>
      `;
    }

    return `
      <div class="space-card" onclick="showSpaceDetail('${space.id}')">
        <div class="card-image">
          ${photo
            ? `<img src="${photo.url}" alt="${space.name}" onclick="event.stopPropagation(); openLightboxForSpace('${space.id}', '${photo.url}')" style="cursor: zoom-in;">`
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
        <div class="card-badges">${badges}</div>
        <div class="card-body">
          <div class="card-header">
            <div>
              <div class="card-title">${space.parent?.name ? `<a href="?edit=${getParentSpaceId(space.parent.name)}" class="card-parent-link" onclick="event.stopPropagation();">${space.parent.name} /</a> ` : ''}${space.name}</div>
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
          ${occupantHtml}
          ${actionsHtml}
        </div>
      </div>
    `;
  }).join('');
}

function renderTable(spacesToRender) {
  const tableBody = document.getElementById('tableBody');

  tableBody.innerHTML = spacesToRender.map(space => {
    const isOccupied = !!space.currentAssignment;
    const occupant = space.currentAssignment?.person;
    const beds = getBedSummary(space);

    const occupantName = occupant
      ? `${occupant.first_name} ${occupant.last_name || ''}`.trim()
      : '-';

    const assignment = space.currentAssignment;
    let leaseDatesHtml = '-';
    if (assignment) {
      const startStr = assignment.start_date
        ? formatDateAustin(assignment.start_date, { month: 'short', day: 'numeric', year: '2-digit' })
        : '?';
      const endStr = assignment.end_date
        ? formatDateAustin(assignment.end_date, { month: 'short', day: 'numeric', year: '2-digit' })
        : 'ongoing';
      leaseDatesHtml = `${startStr} - ${endStr}`;

      if (assignment.desired_departure_date) {
        const earlyStr = formatDateAustin(assignment.desired_departure_date, { month: 'short', day: 'numeric', year: '2-digit' });
        const listedIcon = assignment.desired_departure_listed ? '✓' : '';
        leaseDatesHtml += `<br><small style="color:var(--accent);">Early exit: ${earlyStr} ${listedIcon}</small>`;
      }
    }

    const fmtDate = (d) => d ? formatDateAustin(d, { month: 'short', day: 'numeric' }) : null;
    const availFromStr = space.availableFrom && space.availableFrom > getAustinToday()
      ? fmtDate(space.availableFrom)
      : 'NOW';
    const availUntilStr = space.availableUntil ? fmtDate(space.availableUntil) : 'Open';

    let statusBadge = space.isAvailable
      ? '<span class="badge badge-circle available" title="Available">A</span>'
      : '<span class="badge badge-circle occupied" title="Occupied">O</span>';

    let visBadge = '';
    if (space.is_secret) visBadge = '<span class="badge badge-circle secret" title="Secret">S</span>';
    else if (!space.is_listed) visBadge = '<span class="badge badge-circle unlisted" title="Unlisted">U</span>';

    const thumbnail = space.photos.length > 0
      ? `<img src="${space.photos[0].url}" alt="" class="table-thumbnail" onclick="event.stopPropagation(); openLightboxForSpace('${space.id}', '${space.photos[0].url}')" style="cursor: zoom-in;">`
      : `<div class="table-thumbnail-placeholder"></div>`;

    const description = space.description
      ? (space.description.length > 100 ? space.description.substring(0, 100) + '...' : space.description)
      : '';

    const detailLines = [];
    if (space.can_be_dwelling && space.bath_privacy && space.bath_privacy !== 'none') detailLines.push(`${space.bath_privacy} bath`);
    if (beds) detailLines.push(beds);
    const detailsHtml = detailLines.length > 0 ? detailLines.join('<br>') : '-';

    return `
      <tr onclick="showSpaceDetail('${space.id}')" style="cursor:pointer;">
        <td class="td-thumbnail">${thumbnail}</td>
        <td class="td-name-desc">${space.parent?.name ? `<a href="?edit=${getParentSpaceId(space.parent.name)}" class="table-parent-link" onclick="event.stopPropagation();">${space.parent.name} /</a> ` : ''}<strong>${space.name}</strong>${description ? `<br><small class="td-description-inline">${description}</small>` : ''}</td>
        <td>${space.monthly_rate ? `$${space.monthly_rate}/mo` : '-'}</td>
        <td class="td-details">${detailsHtml}</td>
        <td>${space.amenities.slice(0, 3).join(', ') || '-'}</td>
        <td>${availFromStr}</td>
        <td>${availUntilStr}</td>
        <td>${occupantName}${occupant?.type ? `<br><small style="color:var(--text-muted)">${occupant.type}</small>` : ''}</td>
        <td>${leaseDatesHtml}</td>
        <td>${statusBadge}</td>
        <td>${visBadge}</td>
      </tr>
    `;
  }).join('');
}

function renderArchivedSpaces() {
  const section = document.getElementById('archivedSection');
  const container = document.getElementById('archivedSpacesList');
  const countEl = document.getElementById('archivedCount');

  if (archivedSpaces.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  countEl.textContent = `${archivedSpaces.length} archived`;

  container.innerHTML = archivedSpaces.map(space => {
    const photo = space.photos?.[0];
    const thumbHtml = photo
      ? `<img src="${photo.url}" alt="${space.name}" class="space-item-thumb" onclick="event.stopPropagation(); openLightbox('${photo.url}')">`
      : `<div class="space-item-thumb-placeholder"></div>`;
    return `
      <div class="space-item" style="opacity: 0.7;">
        <div class="space-item-info">
          ${thumbHtml}
          <div class="space-item-details">
            <h3>${space.name}</h3>
            <small>Archived</small>
          </div>
        </div>
        <div class="space-item-actions">
          <button class="btn-small btn-primary" onclick="unarchiveSpace('${space.id}', '${space.name.replace(/'/g, "\\'")}')">Restore</button>
        </div>
      </div>
    `;
  }).join('');
}

function populateParentDropdown() {
  const select = document.getElementById('newSpaceParent');
  select.innerHTML = '<option value="">None (top-level)</option>' +
    allSpaces.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
}

// =============================================
// ADD/ARCHIVE/DELETE SPACE
// =============================================
async function handleAddSpace(e) {
  e.preventDefault();
  const name = document.getElementById('newSpaceName').value.trim();
  const parentId = document.getElementById('newSpaceParent').value || null;

  if (!name) {
    showToast('Name is required', 'warning');
    return;
  }

  const { data, error } = await supabase
    .from('spaces')
    .insert({ name, parent_id: parentId, can_be_dwelling: true, is_listed: true, is_secret: false })
    .select();

  if (error) {
    showToast('Error creating space: ' + error.message, 'error');
    return;
  }

  document.getElementById('newSpaceName').value = '';
  document.getElementById('newSpaceParent').value = '';
  loadSpacesData();
  showToast('Space created! Click on it to edit.', 'success');
}

window.unarchiveSpace = async function(id, name) {
  if (!confirm(`Restore "${name}"? It will appear in the main spaces list again.`)) return;

  const { error } = await supabase
    .from('spaces')
    .update({ is_archived: false })
    .eq('id', id);

  if (error) {
    showToast('Error restoring space: ' + error.message, 'error');
    return;
  }
  loadSpacesData();
  showToast('Space restored', 'success');
};

window.deleteSpace = async function(id, name) {
  if (!confirm(`Permanently delete "${name}"? This cannot be undone.\n\nConsider archiving instead if you might need it later.`)) return;

  const { error } = await supabase.from('spaces').delete().eq('id', id);
  if (error) {
    showToast('Error deleting space: ' + error.message, 'error');
    return;
  }
  loadSpacesData();
  showToast('Space deleted', 'success');
};

// =============================================
// SPACE MODALS
// =============================================
function setupSpaceModals() {
  const spaceDetailModal = document.getElementById('spaceDetailModal');
  const photoUploadModal = document.getElementById('photoUploadModal');
  const editSpaceModal = document.getElementById('editSpaceModal');

  // Detail modal
  document.getElementById('closeDetailModal')?.addEventListener('click', () => {
    spaceDetailModal.classList.add('hidden');
  });
  spaceDetailModal?.addEventListener('click', (e) => {
    if (e.target === spaceDetailModal) spaceDetailModal.classList.add('hidden');
  });

  // Photo upload modal
  document.getElementById('closeUploadModal')?.addEventListener('click', () => {
    photoUploadModal.classList.add('hidden');
  });
  document.getElementById('cancelPhotoUpload')?.addEventListener('click', () => {
    photoUploadModal.classList.add('hidden');
  });
  document.getElementById('submitPhotoUpload')?.addEventListener('click', handlePhotoUpload);
  document.getElementById('photoFile')?.addEventListener('change', handleFilePreview);
  photoUploadModal?.addEventListener('click', (e) => {
    if (e.target === photoUploadModal) photoUploadModal.classList.add('hidden');
  });

  // Media picker tab switching
  document.querySelectorAll('#photoUploadModal .media-picker-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMediaPickerTab(btn.dataset.tab));
  });

  // Library tab handlers
  document.getElementById('cancelLibrarySelect')?.addEventListener('click', () => {
    photoUploadModal.classList.add('hidden');
  });
  document.getElementById('submitLibrarySelect')?.addEventListener('click', handleLibrarySelect);
  document.getElementById('libraryCategoryFilter')?.addEventListener('change', (e) => {
    activeLibraryFilters.category = e.target.value;
    loadLibraryMedia();
  });

  // Request tab handlers
  document.getElementById('cancelPhotoRequest')?.addEventListener('click', () => {
    photoUploadModal.classList.add('hidden');
  });
  document.getElementById('submitPhotoRequest')?.addEventListener('click', handlePhotoRequestSubmit);

  // Edit space modal handlers
  document.getElementById('closeEditModal')?.addEventListener('click', () => {
    editSpaceModal.classList.add('hidden');
  });
  document.getElementById('cancelEditSpace')?.addEventListener('click', () => {
    editSpaceModal.classList.add('hidden');
  });
  document.getElementById('submitEditSpace')?.addEventListener('click', handleEditSpaceSubmit);
  document.getElementById('archiveSpaceBtn')?.addEventListener('click', handleArchiveSpace);
  document.getElementById('editSpaceForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
  });
  editSpaceModal?.addEventListener('click', (e) => {
    if (e.target === editSpaceModal) editSpaceModal.classList.add('hidden');
  });

  // Add more photos link in edit modal
  document.getElementById('addMorePhotosLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    const spaceId = document.getElementById('editSpaceId').value;
    const spaceName = document.getElementById('editName').value;
    if (spaceId) {
      editSpaceModal.classList.add('hidden');
      openPhotoUpload(spaceId, spaceName);
    }
  });

  // Media detail modal handlers
  setupMediaDetailModal();
}

// =============================================
// LIGHTBOX FOR SPACES
// =============================================
function openLightboxForSpace(spaceId, imageUrl) {
  const space = allSpaces.find(s => s.id === spaceId);
  if (space && space.photos && space.photos.length > 0) {
    const galleryUrls = space.photos.map(p => p.url);
    openLightbox(imageUrl, galleryUrls);
  } else {
    openLightbox(imageUrl);
  }
}

// =============================================
// SPACE DETAIL MODAL
// =============================================
function showSpaceDetail(spaceId) {
  const space = allSpaces.find(s => s.id === spaceId);
  if (!space) return;

  const isAdmin = ['admin', 'oracle'].includes(authState?.appUser?.role);
  const spaceDetailModal = document.getElementById('spaceDetailModal');

  const headerHtml = space.parent?.name
    ? `<a href="#" class="detail-parent-link" onclick="event.preventDefault(); showSpaceDetail('${getParentSpaceId(space.parent.name)}');">${space.parent.name}</a> / ${space.name}`
    : space.name;
  document.getElementById('detailSpaceName').innerHTML = headerHtml;

  const headerButtonsHtml = isAdmin ? `
    <button class="btn-primary" onclick="openEditSpace('${space.id}'); document.getElementById('spaceDetailModal').classList.add('hidden');">Edit Space</button>
    <button class="btn-secondary" onclick="openPhotoUpload('${space.id}', '${space.name.replace(/'/g, "\\'")}'); document.getElementById('spaceDetailModal').classList.add('hidden');">Add Images</button>
  ` : '';
  document.getElementById('detailHeaderButtons').innerHTML = headerButtonsHtml;

  const isOccupied = !!space.currentAssignment;
  const occupant = space.currentAssignment?.person;

  // Get child spaces with photos
  const childSpaces = allSpaces.filter(s => s.parent?.name === space.name && s.photos && s.photos.length > 0);

  // Walk up the parent chain to collect all ancestor photos
  const ancestorPhotoSections = [];
  let currentParentName = space.parent?.name;
  while (currentParentName) {
    const parentSpace = allSpaces.find(s => s.name === currentParentName);
    if (parentSpace && parentSpace.photos && parentSpace.photos.length > 0) {
      ancestorPhotoSections.push({
        id: parentSpace.id,
        name: parentSpace.name,
        photos: parentSpace.photos
      });
    }
    currentParentName = parentSpace?.parent?.name || null;
  }

  // Combine all photos for lightbox gallery
  const allPhotos = [...space.photos];
  childSpaces.forEach(child => { allPhotos.push(...child.photos); });
  ancestorPhotoSections.forEach(section => { allPhotos.push(...section.photos); });
  if (allPhotos.length) setCurrentGallery(allPhotos);

  let occupantHtml = '';
  if (isOccupied && occupant) {
    const a = space.currentAssignment;
    const desiredDepartureStr = a.desired_departure_date
      ? formatDateAustin(a.desired_departure_date, { month: 'short', day: 'numeric', year: 'numeric' })
      : null;
    const earlyExitHtml = desiredDepartureStr
      ? `<p style="color: var(--accent);"><strong>Early Exit:</strong> ${desiredDepartureStr}</p>`
      : '';
    occupantHtml = `
      <div class="detail-section">
        <h3>Current Occupant</h3>
        <p><strong class="${isDemoUser() ? 'demo-redacted' : ''}">${isDemoUser() ? redactString(`${occupant.first_name} ${occupant.last_name || ''}`, 'name') : `${occupant.first_name} ${occupant.last_name || ''}`}</strong> (${occupant.type})</p>
        ${occupant.email ? `<p class="${isDemoUser() ? 'demo-redacted' : ''}">Email: ${isDemoUser() ? redactString(occupant.email, 'email') : occupant.email}</p>` : ''}
        ${occupant.phone ? `<p>Phone: ${occupant.phone}</p>` : ''}
        <p>Rate: $${a.rate_amount}/${a.rate_term}</p>
        <p>Start: ${a.start_date ? formatDateAustin(a.start_date, { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A'}</p>
        <p>End: ${a.end_date ? formatDateAustin(a.end_date, { month: 'short', day: 'numeric', year: 'numeric' }) : 'No end date'}</p>
        ${earlyExitHtml}
        ${isAdmin ? `
          <div style="margin-top: 0.75rem;">
            <label style="font-size: 0.875rem; color: var(--text-muted);">Desired Departure (Early Exit):</label>
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.25rem;">
              <input type="date" id="desiredDepartureDate" value="${a.desired_departure_date || ''}"
                style="padding: 0.25rem 0.5rem; border: 1px solid var(--border); border-radius: var(--radius);"
                onchange="updateDesiredDeparture('${a.id}', this.value)">
              ${a.desired_departure_date ? `
                <button onclick="toggleDesiredDepartureListed('${a.id}', ${!a.desired_departure_listed})"
                  style="padding: 0.25rem 0.75rem; border: 1px solid ${a.desired_departure_listed ? 'var(--error)' : 'var(--accent)'};
                    background: ${a.desired_departure_listed ? 'var(--error-light)' : 'var(--accent-light)'};
                    color: ${a.desired_departure_listed ? 'var(--error)' : 'var(--accent)'};
                    border-radius: var(--radius); cursor: pointer; font-size: 0.875rem; font-weight: 500;">
                  ${a.desired_departure_listed ? 'Unlist' : 'List'}
                </button>
                ${a.desired_departure_listed ? '<span style="color: var(--accent); font-size: 0.75rem;">✓ Listed for new renters</span>' : '<span style="color: var(--text-muted); font-size: 0.75rem;">Not listed yet</span>'}
              ` : ''}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  // Related occupancy
  let relatedOccupancyHtml = '';
  if (isAdmin) {
    const relatedItems = [];

    if (space.parent_id) {
      const parentSpace = allSpaces.find(s => s.id === space.parent_id);
      if (parentSpace && parentSpace.currentAssignment?.person) {
        const pa = parentSpace.currentAssignment;
        const pp = pa.person;
        const parentEnd = pa.end_date ? formatDateAustin(pa.end_date, { month: 'short', day: 'numeric', year: 'numeric' }) : 'No end date';
        relatedItems.push(`
          <div style="margin-bottom: 0.5rem;">
            <span style="display: inline-block; background: var(--accent-light); color: var(--accent); font-size: 0.7rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 3px; margin-right: 0.35rem; vertical-align: middle;">PARENT</span>
            <a href="#" onclick="event.preventDefault(); showSpaceDetail('${parentSpace.id}');" style="color: var(--accent); font-weight: 500;">${parentSpace.name}</a>
            — <strong>${pp.first_name} ${pp.last_name || ''}</strong> (${pp.type}), until ${parentEnd}
          </div>
        `);
      }
    }

    const occupiedChildren = allSpaces.filter(s => s.parent_id === space.id && s.currentAssignment?.person);
    occupiedChildren.forEach(child => {
      const ca = child.currentAssignment;
      const cp = ca.person;
      const childEnd = ca.end_date ? formatDateAustin(ca.end_date, { month: 'short', day: 'numeric', year: 'numeric' }) : 'No end date';
      relatedItems.push(`
        <div style="margin-bottom: 0.5rem;">
          <span style="display: inline-block; background: #e8f4fd; color: #1a73e8; font-size: 0.7rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 3px; margin-right: 0.35rem; vertical-align: middle;">CHILD</span>
          <a href="#" onclick="event.preventDefault(); showSpaceDetail('${child.id}');" style="color: var(--accent); font-weight: 500;">${child.name}</a>
          — <strong>${cp.first_name} ${cp.last_name || ''}</strong> (${cp.type}), until ${childEnd}
        </div>
      `);
    });

    if (relatedItems.length > 0) {
      relatedOccupancyHtml = `
        <div class="detail-section">
          <h3>Related Occupancy</h3>
          ${relatedItems.join('')}
        </div>
      `;
    }
  }

  // Space photos
  let spacePhotosHtml = '';
  if (space.photos.length) {
    const photosHeading = isAdmin
      ? `<a href="#" class="photos-heading-link" onclick="event.preventDefault(); openEditSpace('${space.id}'); document.getElementById('spaceDetailModal').classList.add('hidden');">${space.name} Photos</a>`
      : `${space.name} Photos`;
    spacePhotosHtml = `
      <div class="detail-section detail-photos">
        <h3>${photosHeading}</h3>
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

  // Child photos
  let childPhotosHtml = '';
  childSpaces.forEach(child => {
    const childHeading = isAdmin
      ? `<a href="#" class="photos-heading-link" onclick="event.preventDefault(); openEditSpace('${child.id}'); document.getElementById('spaceDetailModal').classList.add('hidden');">${child.name} Photos</a>`
      : `${child.name} Photos`;
    childPhotosHtml += `
      <div class="detail-section detail-photos">
        <h3>${childHeading}</h3>
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

  // Ancestor photos
  const needsSeparator = (space.photos.length > 0 || childSpaces.length > 0) && ancestorPhotoSections.length > 0;
  let ancestorPhotosHtml = needsSeparator ? '<hr style="border: none; border-top: 1px solid var(--border); margin: 1.5rem 0;">' : '';
  ancestorPhotoSections.forEach(section => {
    const ancestorHeading = isAdmin
      ? `<a href="#" class="photos-heading-link" onclick="event.preventDefault(); openEditSpace('${section.id}'); document.getElementById('spaceDetailModal').classList.add('hidden');">${section.name} Photos</a>`
      : `${section.name} Photos`;
    ancestorPhotosHtml += `
      <div class="detail-section detail-photos">
        <h3>${ancestorHeading}</h3>
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

  document.getElementById('spaceDetailBody').innerHTML = `
    <div class="detail-grid">
      <div class="detail-section">
        <h3>Details</h3>
        ${space.monthly_rate ? `<p><strong>Rate:</strong> $${space.monthly_rate}/mo</p>` : ''}
        <p><strong>Size:</strong> ${space.sq_footage ? `${space.sq_footage} sq ft` : 'N/A'}</p>
        <p><strong>Beds:</strong> ${getBedSummary(space) || 'N/A'}</p>
        ${space.can_be_dwelling && ((space.bath_privacy && space.bath_privacy !== 'none') || space.bath_fixture) ? `<p><strong>Bathroom:</strong> ${(space.bath_privacy && space.bath_privacy !== 'none') ? space.bath_privacy : ''}${space.bath_fixture ? ` (${space.bath_fixture})` : ''}</p>` : ''}
        <p><strong>Capacity:</strong> ${space.min_residents || 1}-${space.max_residents || '?'} residents</p>
        ${space.gender_restriction && space.gender_restriction !== 'none' ? `<p><strong>Restriction:</strong> ${space.gender_restriction} only</p>` : ''}
      </div>
      <div class="detail-section">
        <h3>Amenities</h3>
        ${space.amenities.length ? `<p>${space.amenities.join(', ')}</p>` : '<p>No amenities listed</p>'}
      </div>
      ${occupantHtml}
      ${relatedOccupancyHtml}
    </div>
    ${space.description ? `<div class="detail-section detail-description"><h3>Description</h3><p>${space.description}</p></div>` : ''}
    ${spacePhotosHtml}
    ${childPhotosHtml}
    ${ancestorPhotosHtml}
  `;

  spaceDetailModal.classList.remove('hidden');
}

// =============================================
// EDIT SPACE MODAL
// =============================================
async function openEditSpace(spaceId) {
  if (!['admin', 'oracle'].includes(authState?.appUser?.role)) {
    showToast('Only admins can edit spaces', 'warning');
    return;
  }

  const space = allSpaces.find(s => s.id === spaceId);
  if (!space) {
    showToast('Space not found', 'error');
    return;
  }

  currentEditSpaceId = spaceId;
  document.getElementById('editSpaceName').textContent = space.name;
  document.getElementById('editSpaceId').value = spaceId;

  // Populate parent space dropdown
  const parentSelect = document.getElementById('editParentSpace');
  if (parentSelect) {
    const possibleParents = allSpaces.filter(s => s.id !== spaceId && !s.is_archived);
    parentSelect.innerHTML = '<option value="">None (top level)</option>' +
      possibleParents.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    parentSelect.value = space.parent_id || '';
  }

  // Populate form fields
  document.getElementById('editName').value = space.name || '';
  document.getElementById('editLocation').value = space.location || '';
  document.getElementById('editType').value = space.type || '';
  document.getElementById('editDescription').value = space.description || '';
  document.getElementById('editMonthlyRate').value = space.monthly_rate || '';
  document.getElementById('editWeeklyRate').value = space.weekly_rate || '';
  document.getElementById('editNightlyRate').value = space.nightly_rate || '';
  document.getElementById('editRentalTerm').value = space.rental_term || '';
  document.getElementById('editStandardDeposit').value = space.standard_deposit || '';
  document.getElementById('editSqFootage').value = space.sq_footage || '';
  document.getElementById('editMinResidents').value = space.min_residents || 1;
  document.getElementById('editMaxResidents').value = space.max_residents || '';
  document.getElementById('editBathPrivacy').value = space.bath_privacy || '';
  document.getElementById('editBathFixture').value = space.bath_fixture || '';
  document.getElementById('editGenderRestriction').value = space.gender_restriction || 'none';
  document.getElementById('editBedsKing').value = space.beds_king || 0;
  document.getElementById('editBedsQueen').value = space.beds_queen || 0;
  document.getElementById('editBedsDouble').value = space.beds_double || 0;
  document.getElementById('editBedsTwin').value = space.beds_twin || 0;
  document.getElementById('editBedsFolding').value = space.beds_folding || 0;
  document.getElementById('editIsListed').checked = space.is_listed || false;
  document.getElementById('editIsSecret').checked = space.is_secret || false;
  document.getElementById('editCanBeDwelling').checked = space.can_be_dwelling !== false;
  document.getElementById('editCanBeEvent').checked = space.can_be_event || false;
  document.getElementById('editIsMicro').checked = space.is_micro || false;

  // Populate amenity checkboxes
  await renderAmenityCheckboxes(space);

  renderEditPhotos(space);
  document.getElementById('editSpaceModal').classList.remove('hidden');
}

async function renderAmenityCheckboxes(space) {
  const container = document.getElementById('editAmenitiesContainer');
  if (!container) return;

  // Load all amenities once
  if (allAmenities.length === 0) {
    const { data, error } = await supabase
      .from('amenities')
      .select('id, name, category')
      .order('category')
      .order('name');
    if (error) {
      console.error('Error loading amenities:', error);
      container.innerHTML = '<p style="color: var(--text-muted);">Failed to load amenities</p>';
      return;
    }
    allAmenities = data || [];
  }

  const spaceAmenityIds = space.amenityIds || [];

  container.innerHTML = allAmenities.map(amenity => `
    <div class="form-group checkbox-group">
      <label>
        <input type="checkbox" name="editAmenity" value="${amenity.id}"
          ${spaceAmenityIds.includes(amenity.id) ? 'checked' : ''}>
        ${amenity.name}
      </label>
    </div>
  `).join('');
}

function renderEditPhotos(space) {
  const container = document.getElementById('editPhotosContainer');
  if (!space.photos || space.photos.length === 0) {
    container.innerHTML = '<div class="no-photos-message">No photos yet. Use the Images button to add photos.</div>';
    return;
  }

  setCurrentGallery(space.photos);

  container.innerHTML = space.photos.map((photo, idx) => {
    const primaryBadge = photo.is_primary ? '<span class="photo-tag" style="background: var(--accent);">Primary</span>' : '';
    return `
      <div class="edit-photo-item" draggable="true" data-photo-id="${photo.id}" data-space-id="${space.id}">
        <div class="drag-handle" title="Drag to reorder">⋮⋮</div>
        <img src="${photo.url}" alt="${photo.caption || 'Photo ' + (idx + 1)}" onclick="openLightbox('${photo.url}')" style="cursor: zoom-in;">
        <span class="photo-order">#${idx + 1} ${primaryBadge}</span>
        <button type="button" class="btn-remove-photo" onclick="event.preventDefault(); event.stopPropagation(); removePhotoFromSpace('${space.id}', '${photo.id}')" title="Remove">×</button>
      </div>
    `;
  }).join('');

  initPhotoDragAndDrop(container, space.id);
}

function initPhotoDragAndDrop(container, spaceId) {
  let draggedItem = null;

  container.querySelectorAll('.edit-photo-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      draggedItem = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedItem = null;
      container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (draggedItem && draggedItem !== item) {
        item.classList.add('drag-over');
      }
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!draggedItem || draggedItem === item) return;

      const items = [...container.querySelectorAll('.edit-photo-item')];
      const fromIndex = items.indexOf(draggedItem);
      const toIndex = items.indexOf(item);

      if (fromIndex < toIndex) {
        item.parentNode.insertBefore(draggedItem, item.nextSibling);
      } else {
        item.parentNode.insertBefore(draggedItem, item);
      }

      const newOrder = [...container.querySelectorAll('.edit-photo-item')].map(el => el.dataset.photoId);
      await savePhotoOrder(spaceId, newOrder);
    });
  });
}

async function savePhotoOrder(spaceId, mediaIds) {
  try {
    await mediaService.reorderInSpace(spaceId, mediaIds);
    const space = allSpaces.find(s => s.id === spaceId);
    if (space) {
      const photoMap = new Map(space.photos.map(p => [p.id, p]));
      space.photos = mediaIds.map(id => photoMap.get(id)).filter(Boolean);
      renderEditPhotos(space);
    }
  } catch (error) {
    console.error('Error saving photo order:', error);
    showToast('Failed to save photo order', 'error');
  }
}

async function handleEditSpaceSubmit() {
  if (isSavingSpace) return;

  if (!['admin', 'oracle'].includes(authState?.appUser?.role)) {
    showToast('Only admins can edit spaces', 'warning');
    return;
  }

  const spaceId = document.getElementById('editSpaceId').value;
  const name = document.getElementById('editName').value.trim();

  if (!name) {
    showToast('Name is required', 'warning');
    return;
  }

  const submitBtn = document.getElementById('submitEditSpace');
  isSavingSpace = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';

  try {
    const getVal = (id) => document.getElementById(id)?.value?.trim() || null;
    const getInt = (id) => parseInt(document.getElementById(id)?.value) || null;
    const getIntOrZero = (id) => parseInt(document.getElementById(id)?.value) || 0;
    const getChecked = (id) => document.getElementById(id)?.checked || false;

    const updates = {
      name: name,
      parent_id: getVal('editParentSpace') || null,
      location: getVal('editLocation'),
      type: getVal('editType'),
      description: getVal('editDescription'),
      monthly_rate: getInt('editMonthlyRate'),
      weekly_rate: getInt('editWeeklyRate'),
      nightly_rate: getInt('editNightlyRate'),
      rental_term: getVal('editRentalTerm'),
      standard_deposit: getVal('editStandardDeposit'),
      sq_footage: getInt('editSqFootage'),
      min_residents: getInt('editMinResidents') || 1,
      max_residents: getInt('editMaxResidents'),
      bath_privacy: getVal('editBathPrivacy'),
      bath_fixture: getVal('editBathFixture'),
      gender_restriction: getVal('editGenderRestriction') || 'none',
      beds_king: getIntOrZero('editBedsKing'),
      beds_queen: getIntOrZero('editBedsQueen'),
      beds_double: getIntOrZero('editBedsDouble'),
      beds_twin: getIntOrZero('editBedsTwin'),
      beds_folding: getIntOrZero('editBedsFolding'),
      is_listed: getChecked('editIsListed'),
      is_secret: getChecked('editIsSecret'),
      can_be_dwelling: getChecked('editCanBeDwelling'),
      can_be_event: getChecked('editCanBeEvent'),
      is_micro: getChecked('editIsMicro'),
    };

    const { error } = await supabase
      .from('spaces')
      .update(updates)
      .eq('id', spaceId)
      .select();

    if (error) throw error;

    // Save amenity changes
    const checkedAmenityIds = [...document.querySelectorAll('input[name="editAmenity"]:checked')]
      .map(cb => cb.value);
    const space = allSpaces.find(s => s.id === spaceId);
    const currentAmenityIds = space?.amenityIds || [];

    const toAdd = checkedAmenityIds.filter(id => !currentAmenityIds.includes(id));
    const toRemove = currentAmenityIds.filter(id => !checkedAmenityIds.includes(id));

    if (toRemove.length > 0) {
      const { error: delError } = await supabase
        .from('space_amenities')
        .delete()
        .eq('space_id', spaceId)
        .in('amenity_id', toRemove);
      if (delError) throw delError;
    }

    if (toAdd.length > 0) {
      const { error: insError } = await supabase
        .from('space_amenities')
        .insert(toAdd.map(amenityId => ({ space_id: spaceId, amenity_id: amenityId })));
      if (insError) throw insError;
    }

    showToast('Space updated successfully!', 'success');
    document.getElementById('editSpaceModal').classList.add('hidden');
    isSavingSpace = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save Changes';

    loadSpacesData();

  } catch (error) {
    console.error('Error updating space:', error);
    showToast('Failed to update space: ' + error.message, 'error');
    isSavingSpace = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save Changes';
  }
}

async function handleArchiveSpace() {
  if (!['admin', 'oracle'].includes(authState?.appUser?.role)) {
    showToast('Only admins can archive spaces', 'warning');
    return;
  }

  const spaceId = document.getElementById('editSpaceId').value;
  const space = allSpaces.find(s => s.id === spaceId);
  if (!space) return;

  if (!confirm(`Archive "${space.name}"?\n\nThis will hide the space from all views but keep it in the database. You can restore it later.`)) return;

  try {
    const { error } = await supabase
      .from('spaces')
      .update({ is_archived: true })
      .eq('id', spaceId)
      .select();

    if (error) throw error;

    showToast(`"${space.name}" has been archived`, 'success');
    document.getElementById('editSpaceModal').classList.add('hidden');
    loadSpacesData();

  } catch (error) {
    console.error('Error archiving space:', error);
    showToast('Failed to archive space: ' + error.message, 'error');
  }
}

async function removePhotoFromSpace(spaceId, mediaId) {
  if (!['admin', 'oracle'].includes(authState?.appUser?.role)) {
    showToast('Only admins can remove photos', 'warning');
    return;
  }

  try {
    await mediaService.unlinkFromSpace(mediaId, spaceId);
    const space = allSpaces.find(s => s.id === spaceId);
    if (space) {
      space.photos = space.photos.filter(p => p.id !== mediaId);
      renderEditPhotos(space);
    }
    showToast('Photo removed from space', 'success');
  } catch (error) {
    console.error('Error removing photo:', error);
    showToast('Failed to remove photo: ' + error.message, 'error');
  }
}

// =============================================
// PHOTO UPLOAD MODAL
// =============================================
async function openPhotoUpload(spaceId, spaceName, context = 'dwelling', initialTab = 'library') {
  if (!['admin', 'oracle'].includes(authState?.appUser?.role)) {
    showToast('Only admins can upload photos', 'warning');
    return;
  }
  console.log('[openPhotoUpload] Opening for space:', spaceId, spaceName);
  currentUploadSpaceId = spaceId;
  currentUploadContext = context;
  selectedLibraryMedia.clear();
  selectedUploadFiles = [];
  isPhotoUploading = false;

  const submitBtn = document.getElementById('submitPhotoUpload');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Upload';
  }

  document.getElementById('uploadModalSpaceName').textContent = spaceName;
  document.getElementById('photoFile').value = '';
  document.getElementById('photoBulkCaption').value = '';
  document.getElementById('uploadPreviewGrid').innerHTML = '';
  document.getElementById('bulkTagSection')?.classList.add('hidden');
  document.getElementById('uploadProgress')?.classList.add('hidden');

  const categorySelect = document.getElementById('photoCategory');
  if (categorySelect) {
    categorySelect.value = context === 'projects' ? 'projects' : 'space';
  }

  renderUploadTags();
  updateModalStorageIndicator();
  activeLibraryFilters = { tags: [], category: '' };
  const libraryCategoryFilter = document.getElementById('libraryCategoryFilter');
  if (libraryCategoryFilter) libraryCategoryFilter.value = '';

  // Show modal immediately but with loading state for library
  const libraryGrid = document.getElementById('libraryMediaGrid');
  if (libraryGrid) {
    libraryGrid.innerHTML = '<div class="library-empty"><p>Loading media library...</p></div>';
  }

  renderLibraryTagFilter();
  renderRequestTab();
  switchMediaPickerTab(initialTab);
  document.getElementById('photoUploadModal').classList.remove('hidden');

  // Load library media in background
  loadLibraryMedia().then(() => {
    console.log('[openPhotoUpload] Library loaded with', libraryMedia?.length || 0, 'items');
  }).catch(err => {
    console.warn('[openPhotoUpload] Library load failed:', err.message);
  });
}

function updateModalStorageIndicator() {
  const indicator = document.getElementById('modalStorageIndicator');
  if (!indicator || !storageUsage) return;

  const percent = storageUsage.percent_used || 0;
  const used = mediaService.formatBytes(storageUsage.current_bytes || 0);
  const limit = mediaService.formatBytes(storageUsage.limit_bytes || 0);

  let colorClass = 'storage-ok';
  if (percent >= 90) colorClass = 'storage-critical';
  else if (percent >= 70) colorClass = 'storage-warning';

  indicator.innerHTML = `
    <div class="storage-bar ${colorClass}">
      <div class="storage-fill" style="width: ${Math.min(percent, 100)}%"></div>
    </div>
    <div class="storage-text">${used} / ${limit} (${percent.toFixed(1)}%)</div>
  `;
}

function switchMediaPickerTab(tabName) {
  document.querySelectorAll('#photoUploadModal .media-picker-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.getElementById('uploadTab')?.classList.toggle('active', tabName === 'upload');
  document.getElementById('libraryTab')?.classList.toggle('active', tabName === 'library');
  document.getElementById('requestTab')?.classList.toggle('active', tabName === 'request');
}

function getAutoTagsForContext(context) {
  switch (context) {
    case 'dwelling': return ['listing'];
    case 'event': return ['listing'];
    case 'projects': return ['in-progress'];
    case 'social': return ['social'];
    default: return ['listing'];
  }
}

function renderUploadTags() {
  const container = document.getElementById('uploadTagsContainer');
  if (!container) return;

  const autoTags = getAutoTagsForContext(currentUploadContext);

  const grouped = {};
  allTags.forEach(tag => {
    const group = tag.tag_group || 'other';
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(tag);
  });
  const sortedGroups = mediaService.sortTagGroups(grouped);

  container.innerHTML = Object.entries(sortedGroups).map(([group, tags]) => `
    <div class="tag-row">
      <div class="tag-group-label">${group}</div>
      <div class="tag-checkboxes">
        ${tags.map(tag => {
          const isAuto = autoTags.includes(tag.name);
          return `
            <label class="tag-checkbox" style="--tag-color: ${tag.color || '#666'}">
              <input type="checkbox" value="${tag.name}" ${isAuto ? 'checked' : ''}>
              <span class="tag-chip">${tag.name}</span>
            </label>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');

  const autoTagHint = document.getElementById('autoTagHint');
  if (autoTagHint) {
    autoTagHint.textContent = autoTags.length ? `Auto-tagged: ${autoTags.join(', ')}` : '';
  }
}

function renderRequestTab() {
  const descriptionEl = document.getElementById('requestDescription');
  if (descriptionEl) descriptionEl.value = '';
  renderRequestTags();
  renderExistingRequests();
}

function renderRequestTags() {
  const container = document.getElementById('requestTagsContainer');
  if (!container) return;

  const autoTags = getAutoTagsForContext(currentUploadContext);
  const grouped = {};
  allTags.forEach(tag => {
    const group = tag.tag_group || 'other';
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(tag);
  });
  const sortedGroups = mediaService.sortTagGroups(grouped);

  container.innerHTML = Object.entries(sortedGroups).map(([group, tags]) => `
    <div class="tag-row">
      <div class="tag-group-label">${group}</div>
      <div class="tag-checkboxes">
        ${tags.map(tag => {
          const isAuto = autoTags.includes(tag.name);
          return `
            <label class="tag-checkbox" style="--tag-color: ${tag.color || '#666'}">
              <input type="checkbox" value="${tag.name}" ${isAuto ? 'checked' : ''}>
              <span class="tag-chip">${tag.name}</span>
            </label>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');
}

function renderExistingRequests() {
  const section = document.getElementById('existingRequestsSection');
  const list = document.getElementById('existingRequestsList');
  if (!section || !list) return;

  const space = allSpaces.find(s => s.id === currentUploadSpaceId);
  const pendingRequests = space?.photoRequests?.filter(r => r.status === 'pending') || [];

  if (pendingRequests.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  list.innerHTML = pendingRequests.map(pr => `
    <div class="existing-request-item">
      <span class="request-status ${pr.status}">${pr.status}</span>
      <p>${pr.description}</p>
      <small>Requested ${formatDateAustin(pr.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</small>
    </div>
  `).join('');
}

async function loadLibraryMedia() {
  if (isLibraryLoading) {
    console.log('[loadLibraryMedia] Already loading, skipping');
    return;
  }

  console.log('[loadLibraryMedia] Starting, filters:', activeLibraryFilters);
  const container = document.getElementById('libraryMediaGrid');
  isLibraryLoading = true;

  try {
    const result = await mediaService.search({
      category: activeLibraryFilters.category || null,
      tags: activeLibraryFilters.tags,
      limit: 100,
      minimal: true,
    });

    console.log('[loadLibraryMedia] Search returned', result?.length || 0, 'items');
    libraryMedia = result || [];
    renderLibraryGrid();
  } catch (error) {
    console.error('[loadLibraryMedia] Error loading library:', error);
    libraryMedia = [];
    if (container) {
      container.innerHTML = `
        <div class="library-empty">
          <p>Failed to load media library. <a href="#" onclick="loadLibraryMedia(); return false;">Try again</a></p>
          <small style="color: #999;">${error.message || 'Unknown error'}</small>
        </div>
      `;
    }
  } finally {
    isLibraryLoading = false;
  }
}

function renderLibraryTagFilter() {
  const container = document.getElementById('libraryTagFilter');
  if (!container) return;

  const filterableTags = allTags
    .filter(t => t.tag_group === 'space')
    .sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0));

  container.innerHTML = filterableTags.map(tag => `
    <button type="button"
      class="tag-filter-chip ${activeLibraryFilters.tags.includes(tag.name) ? 'active' : ''}"
      data-tag="${tag.name}"
      onclick="toggleLibraryTagFilter('${tag.name}')"
    >${tag.name}</button>
  `).join('');
}

window.toggleLibraryTagFilter = function(tagName) {
  const idx = activeLibraryFilters.tags.indexOf(tagName);
  if (idx >= 0) {
    activeLibraryFilters.tags.splice(idx, 1);
  } else {
    activeLibraryFilters.tags.push(tagName);
  }
  renderLibraryTagFilter();
  loadLibraryMedia();
};

function renderLibraryGrid() {
  console.log('[renderLibraryGrid] Called with', libraryMedia?.length || 0, 'items');
  const container = document.getElementById('libraryMediaGrid');
  if (!container) {
    console.warn('[renderLibraryGrid] Container not found!');
    return;
  }

  if (!libraryMedia || libraryMedia.length === 0) {
    console.log('[renderLibraryGrid] Showing empty state');
    container.innerHTML = `
      <div class="library-empty">
        <p>No media found${activeLibraryFilters.tags.length ? ' matching filters' : ''}.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = libraryMedia.map(media => {
    const isSelected = selectedLibraryMedia.has(media.id);
    const tagsHtml = media.tags?.slice(0, 3).map(t => `<span class="tag-chip">${t.name}</span>`).join('') || '';

    return `
      <div class="library-media-item ${isSelected ? 'selected' : ''}"
           data-media-id="${media.id}"
           onclick="toggleLibraryMediaSelection('${media.id}')">
        <img src="${media.url}" alt="${media.caption || 'Media'}">
        ${tagsHtml ? `<div class="media-info">${tagsHtml}</div>` : ''}
      </div>
    `;
  }).join('');

  updateLibrarySelectButton();
}

window.toggleLibraryMediaSelection = function(mediaId) {
  if (selectedLibraryMedia.has(mediaId)) {
    selectedLibraryMedia.delete(mediaId);
  } else {
    selectedLibraryMedia.add(mediaId);
  }
  renderLibraryGrid();
};

function updateLibrarySelectButton() {
  const btn = document.getElementById('submitLibrarySelect');
  if (!btn) return;
  const count = selectedLibraryMedia.size;
  btn.disabled = count === 0;
  btn.textContent = `Add Selected (${count})`;
}

async function handleLibrarySelect() {
  if (selectedLibraryMedia.size === 0) return;

  const submitBtn = document.getElementById('submitLibrarySelect');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Adding...';

  try {
    const space = allSpaces.find(s => s.id === currentUploadSpaceId);
    let displayOrder = space?.photos?.length || 0;

    for (const mediaId of selectedLibraryMedia) {
      await mediaService.linkToSpace(mediaId, currentUploadSpaceId, displayOrder);
      displayOrder++;
    }

    showToast(`Added ${selectedLibraryMedia.size} media item(s) to space.`, 'success');
    document.getElementById('photoUploadModal').classList.add('hidden');
    loadSpacesData();

  } catch (error) {
    console.error('Error adding media from library:', error);
    showToast('Failed to add media: ' + error.message, 'error');
  } finally {
    submitBtn.disabled = false;
    updateLibrarySelectButton();
  }
}

function handleFilePreview(e) {
  const files = Array.from(e.target.files);
  if (!files.length) {
    selectedUploadFiles = [];
    renderUploadPreviews();
    return;
  }

  selectedUploadFiles = files.map((file, idx) => ({
    file,
    id: `file-${Date.now()}-${idx}`,
    caption: '',
    preview: null
  }));

  selectedUploadFiles.forEach((item) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      item.preview = ev.target.result;
      renderUploadPreviews();
    };
    reader.readAsDataURL(item.file);
  });

  renderUploadPreviews();
}

function renderUploadPreviews() {
  const grid = document.getElementById('uploadPreviewGrid');
  const bulkSection = document.getElementById('bulkTagSection');
  const fileCountEl = document.getElementById('fileCount');
  const submitBtn = document.getElementById('submitPhotoUpload');

  if (!grid) return;

  const count = selectedUploadFiles.length;
  if (fileCountEl) fileCountEl.textContent = count;
  if (bulkSection) bulkSection.classList.toggle('hidden', count <= 1);
  if (submitBtn) submitBtn.textContent = count > 1 ? `Upload All (${count})` : 'Upload';

  if (count === 0) {
    grid.innerHTML = '';
    return;
  }

  grid.innerHTML = selectedUploadFiles.map((item, idx) => `
    <div class="upload-preview-item" data-file-id="${item.id}">
      ${item.preview
        ? `<img src="${item.preview}" alt="Preview ${idx + 1}">`
        : `<div style="display:flex;align-items:center;justify-content:center;height:100%;background:var(--bg);color:var(--text-muted);font-size:0.75rem;">Loading...</div>`
      }
      <span class="preview-index">${idx + 1}</span>
      <button type="button" class="preview-remove" onclick="removeUploadFile('${item.id}')" title="Remove">×</button>
      <div class="preview-caption">
        <input type="text"
          placeholder="Caption..."
          value="${item.caption}"
          onchange="updateFileCaption('${item.id}', this.value)"
          onclick="event.stopPropagation()">
      </div>
    </div>
  `).join('');
}

window.removeUploadFile = function(fileId) {
  selectedUploadFiles = selectedUploadFiles.filter(f => f.id !== fileId);
  renderUploadPreviews();
  if (selectedUploadFiles.length === 0) {
    document.getElementById('photoFile').value = '';
  }
};

window.updateFileCaption = function(fileId, caption) {
  const item = selectedUploadFiles.find(f => f.id === fileId);
  if (item) item.caption = caption;
};

async function handlePhotoUpload() {
  if (isPhotoUploading) return;

  if (!['admin', 'oracle'].includes(authState?.appUser?.role)) {
    showToast('Only admins can upload photos', 'warning');
    return;
  }

  if (selectedUploadFiles.length === 0) {
    showToast('Please select at least one image.', 'warning');
    return;
  }

  isPhotoUploading = true;

  const bulkCaption = document.getElementById('photoBulkCaption')?.value.trim() || '';
  const category = document.getElementById('photoCategory')?.value || 'space';

  const selectedTags = [];
  document.querySelectorAll('#uploadTagsContainer input[type="checkbox"]:checked').forEach(cb => {
    selectedTags.push(cb.value);
  });

  const submitBtn = document.getElementById('submitPhotoUpload');
  const progressContainer = document.getElementById('uploadProgress');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressText = document.getElementById('uploadProgressText');

  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading...';

  if (selectedUploadFiles.length > 1 && progressContainer) {
    progressContainer.classList.remove('hidden');
  }

  let successCount = 0;
  let failCount = 0;
  const totalFiles = selectedUploadFiles.length;

  try {
    for (let i = 0; i < selectedUploadFiles.length; i++) {
      const item = selectedUploadFiles[i];

      if (progressFill) progressFill.style.width = `${((i) / totalFiles) * 100}%`;
      if (progressText) progressText.textContent = `Uploading ${i + 1} of ${totalFiles}...`;

      const caption = item.caption || bulkCaption;

      try {
        const result = await mediaService.upload(item.file, {
          category,
          caption,
          tags: selectedTags,
          spaceId: currentUploadSpaceId,
        });

        if (result.success) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (err) {
        failCount++;
      }
    }

    if (progressFill) progressFill.style.width = '100%';
    if (progressText) progressText.textContent = 'Complete!';

    if (failCount === 0) {
      showToast(successCount === 1 ? 'Photo uploaded successfully!' : `${successCount} photos uploaded successfully!`, 'success');
    } else {
      showToast(`Uploaded ${successCount} of ${totalFiles} photos. ${failCount} failed.`, 'warning');
    }

    document.getElementById('photoUploadModal').classList.add('hidden');
    loadSpacesData();

    // Update storage usage in background
    mediaService.getStorageUsage().then(usage => {
      if (usage) storageUsage = usage;
    }).catch(() => {});

  } catch (error) {
    console.error('Error during upload:', error);
    showToast('Upload failed: ' + error.message, 'error');
  } finally {
    isPhotoUploading = false;
    submitBtn.disabled = false;
    submitBtn.textContent = selectedUploadFiles.length > 1 ? `Upload All (${selectedUploadFiles.length})` : 'Upload';
    if (progressContainer) progressContainer.classList.add('hidden');
    selectedUploadFiles = [];
  }
}

async function handlePhotoRequestSubmit() {
  const description = document.getElementById('requestDescription')?.value.trim();
  if (!description) {
    showToast('Please describe the photo needed.', 'warning');
    return;
  }

  const suggestedTags = [];
  document.querySelectorAll('#requestTagsContainer input[type="checkbox"]:checked').forEach(cb => {
    suggestedTags.push(cb.value);
  });

  try {
    const { error } = await supabase
      .from('photo_requests')
      .insert({
        space_id: currentUploadSpaceId,
        description: description,
        status: 'pending',
        requested_by: authState.appUser?.id || 'admin',
        suggested_tags: suggestedTags.length > 0 ? suggestedTags : null
      });

    if (error) throw error;

    showToast('Photo request submitted!', 'success');
    document.getElementById('photoUploadModal').classList.add('hidden');
    loadSpacesData();

  } catch (error) {
    console.error('Error submitting photo request:', error);
    showToast('Failed to submit request. Check console for details.', 'error');
  }
}

// =============================================
// DESIRED DEPARTURE FUNCTIONS
// =============================================
window.updateDesiredDeparture = async function(assignmentId, dateValue) {
  try {
    const { error } = await supabase
      .from('assignments')
      .update({
        desired_departure_date: dateValue || null,
        desired_departure_listed: false
      })
      .eq('id', assignmentId)
      .select();

    if (error) throw error;

    showToast('Desired departure date updated', 'success');
    loadSpacesData();
  } catch (error) {
    console.error('Error updating desired departure:', error);
    showToast('Failed to update departure date', 'error');
  }
};

window.toggleDesiredDepartureListed = async function(assignmentId, listed) {
  try {
    const { error } = await supabase
      .from('assignments')
      .update({ desired_departure_listed: listed })
      .eq('id', assignmentId)
      .select();

    if (error) throw error;

    showToast(listed ? 'Early exit date listed for new renters' : 'Early exit date unlisted', 'success');
    loadSpacesData();
  } catch (error) {
    console.error('Error toggling listed status:', error);
    showToast('Failed to update listing status', 'error');
  }
};

// =============================================
// MEDIA DETAIL MODAL
// =============================================
function setupMediaDetailModal() {
  const modal = document.getElementById('mediaDetailModal');
  if (!modal) return;

  document.getElementById('closeMediaDetail')?.addEventListener('click', () => {
    modal.classList.add('hidden');
  });
  document.getElementById('cancelMediaDetail')?.addEventListener('click', () => {
    modal.classList.add('hidden');
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });

  document.getElementById('saveMediaDetail')?.addEventListener('click', saveMediaDetail);
  document.getElementById('deleteMediaBtn')?.addEventListener('click', deleteMedia);
}

async function openMediaDetail(mediaId) {
  currentMediaId = mediaId;
  const modal = document.getElementById('mediaDetailModal');
  if (!modal) return;

  // Find media from libraryMedia or fetch it
  let media = libraryMedia.find(m => m.id === mediaId);
  if (!media) {
    const { data } = await supabase
      .from('media')
      .select('*, media_spaces(space:space_id(id, name)), media_tag_assignments(tag:tag_id(id, name, color, tag_group))')
      .eq('id', mediaId)
      .single();
    media = data;
    if (media) {
      media.tags = media.media_tag_assignments?.map(mta => mta.tag).filter(Boolean) || [];
      media.spaces = media.media_spaces?.map(ms => ms.space).filter(Boolean) || [];
    }
  }

  if (!media) {
    showToast('Media not found', 'error');
    return;
  }

  document.getElementById('detailImage').src = media.url;
  document.getElementById('detailCaption').value = media.caption || '';
  document.getElementById('detailCategory').value = media.category || 'mktg';
  document.getElementById('detailSize').textContent = media.file_size_bytes ? mediaService.formatBytes(media.file_size_bytes) : '-';
  document.getElementById('detailDimensions').textContent = media.width && media.height ? `${media.width} × ${media.height}` : '-';
  document.getElementById('detailDate').textContent = media.uploaded_at ? new Date(media.uploaded_at).toLocaleDateString() : '-';
  document.getElementById('detailSpaces').textContent = media.spaces?.map(s => s.name).join(', ') || 'Not linked';

  // Render tag checkboxes
  const tagsContainer = document.getElementById('detailTagsContainer');
  if (tagsContainer) {
    const mediaTags = media.tags?.map(t => t.name) || [];
    const grouped = {};
    allTags.forEach(tag => {
      const group = tag.tag_group || 'other';
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(tag);
    });
    const sortedGroups = mediaService.sortTagGroups(grouped);

    tagsContainer.innerHTML = Object.entries(sortedGroups).map(([group, tags]) => `
      <div class="tag-row">
        <div class="tag-group-label">${group}</div>
        <div class="tag-checkboxes">
          ${tags.map(tag => `
            <label class="tag-checkbox" style="--tag-color: ${tag.color || '#666'}">
              <input type="checkbox" value="${tag.name}" ${mediaTags.includes(tag.name) ? 'checked' : ''}>
              <span class="tag-chip">${tag.name}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  modal.classList.remove('hidden');
}

async function saveMediaDetail() {
  if (!currentMediaId) return;

  const caption = document.getElementById('detailCaption').value.trim();
  const category = document.getElementById('detailCategory').value;
  const selectedTags = [];
  document.querySelectorAll('#detailTagsContainer input[type="checkbox"]:checked').forEach(cb => {
    selectedTags.push(cb.value);
  });

  try {
    await mediaService.update(currentMediaId, { caption, category });
    await mediaService.setTags(currentMediaId, selectedTags);

    showToast('Media updated', 'success');
    document.getElementById('mediaDetailModal').classList.add('hidden');
    loadSpacesData();
  } catch (error) {
    console.error('Error saving media:', error);
    showToast('Failed to save: ' + error.message, 'error');
  }
}

async function deleteMedia() {
  if (!currentMediaId) return;
  if (!confirm('Permanently delete this media? This cannot be undone.')) return;

  try {
    await mediaService.delete(currentMediaId);
    showToast('Media deleted', 'success');
    document.getElementById('mediaDetailModal').classList.add('hidden');
    loadSpacesData();
  } catch (error) {
    console.error('Error deleting media:', error);
    showToast('Failed to delete: ' + error.message, 'error');
  }
}

// =============================================
// GLOBAL FUNCTION EXPORTS
// =============================================
window.showSpaceDetail = showSpaceDetail;
window.openEditSpace = openEditSpace;
window.openPhotoUpload = openPhotoUpload;
window.openLightbox = openLightbox;
window.openLightboxForSpace = openLightboxForSpace;
window.removePhotoFromSpace = removePhotoFromSpace;
window.openMediaDetail = openMediaDetail;
window.loadLibraryMedia = loadLibraryMedia;
