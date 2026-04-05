/**
 * Media Library - Browse, filter, and manage all media
 */

import { supabase } from '../../shared/supabase.js';
import { mediaService } from '../../shared/media-service.js';
import { errorLogger } from '../../shared/error-logger.js';
import { formatDateTimeFull } from '../../shared/timezone.js';
import { initAdminPage, showToast, setupLightbox } from '../../shared/admin-shell.js';

// Set up global error handlers
errorLogger.setupGlobalHandlers();

// =============================================
// STATE
// =============================================

let allMedia = [];
let allTags = [];
let allSpaces = [];
let selectedMediaIds = new Set();
let currentFilters = {
  category: '',
  tags: [],
};
let currentMediaId = null;
let authState = null;

// Upload state
let selectedUploadFiles = [];

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize auth and admin page
  authState = await initAdminPage({
    activeTab: 'media',
    requiredRole: 'staff',
    section: 'staff',
    onReady: async (state) => {
      // Set up lightbox
      setupLightbox();

      // Load initial data
      await Promise.all([
        loadStorageUsage(),
        loadTags(),
        loadSpaces(),
        loadMedia(),
      ]);

      // Set up event listeners
      setupEventListeners();
    }
  });
});

// =============================================
// DATA LOADING
// =============================================

async function loadStorageUsage() {
  const usage = await mediaService.getStorageUsage();
  if (!usage) return;

  const indicator = document.getElementById('storageIndicator');
  const percent = usage.percent_used;
  let statusClass = 'storage-ok';
  if (percent >= 90) statusClass = 'storage-critical';
  else if (percent >= 70) statusClass = 'storage-warning';

  indicator.className = `storage-indicator-inline ${statusClass}`;
  indicator.innerHTML = `
    <div class="storage-bar">
      <div class="storage-fill" style="width: ${Math.min(percent, 100)}%"></div>
    </div>
    <span class="storage-text">
      ${mediaService.formatBytes(usage.current_bytes)} / ${mediaService.formatBytes(usage.limit_bytes)}
      (${percent.toFixed(1)}%)
    </span>
  `;
}

async function loadTags() {
  allTags = await mediaService.getTags();
  renderTagFilters();
}

async function loadSpaces() {
  const { data, error } = await supabase
    .from('spaces')
    .select('id, name')
    .order('name');

  if (!error) {
    allSpaces = data || [];
  }
}

async function loadMedia() {
  const media = await mediaService.search({
    category: currentFilters.category || null,
    tags: currentFilters.tags,
    limit: 200,
  });

  allMedia = media;
  renderMediaGrid();
  updateMediaCount();
}

// =============================================
// RENDERING
// =============================================

function renderTagFilters() {
  const container = document.getElementById('tagFilterChips');
  container.innerHTML = allTags.map(tag => `
    <button
      type="button"
      class="tag-filter-chip ${currentFilters.tags.includes(tag.name) ? 'active' : ''}"
      data-tag="${tag.name}"
      style="${tag.color ? `--tag-color: ${tag.color}` : ''}"
    >
      ${tag.name}
    </button>
  `).join('');

  // Add click handlers
  container.querySelectorAll('.tag-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const tagName = chip.dataset.tag;
      if (currentFilters.tags.includes(tagName)) {
        currentFilters.tags = currentFilters.tags.filter(t => t !== tagName);
        chip.classList.remove('active');
      } else {
        currentFilters.tags.push(tagName);
        chip.classList.add('active');
      }
      loadMedia();
    });
  });
}

function renderMediaGrid() {
  const grid = document.getElementById('mediaGrid');
  const emptyState = document.getElementById('emptyState');

  if (allMedia.length === 0) {
    grid.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  grid.innerHTML = allMedia.map(media => {
    const tags = media.tags || [];
    const spacesLinked = media.spaces?.length || 0;
    const isSelected = selectedMediaIds.has(media.id);

    return `
      <div class="media-grid-item ${isSelected ? 'selected' : ''}" data-id="${media.id}">
        <div class="select-checkbox" data-action="select">✓</div>
        ${spacesLinked > 0 ? `<span class="spaces-count">${spacesLinked} space${spacesLinked > 1 ? 's' : ''}</span>` : ''}
        <div class="media-thumb">
          <img src="${media.url}" alt="${media.caption || 'Media'}" loading="lazy">
        </div>
        <div class="media-info">
          <div class="media-caption ${!media.caption ? 'no-caption' : ''}">
            ${media.caption || 'No caption'}
          </div>
          <div class="media-meta">
            <span>${media.file_size_bytes ? mediaService.formatBytes(media.file_size_bytes) : '-'}</span>
            <span>${formatDate(media.uploaded_at)}</span>
          </div>
          <div class="media-tags">
            <span class="category-badge">${media.category || 'mktg'}</span>
            ${tags.slice(0, 4).map(t => `<span class="media-tag" style="${t.color ? `border-left: 2px solid ${t.color}` : ''}">${t.name}</span>`).join('')}
            ${tags.length > 4 ? `<span class="media-tag">+${tags.length - 4}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers
  grid.querySelectorAll('.media-grid-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const mediaId = item.dataset.id;

      // Check if clicking the select checkbox
      if (e.target.closest('[data-action="select"]')) {
        toggleSelection(mediaId);
        return;
      }

      // Otherwise open detail modal
      openMediaDetail(mediaId);
    });
  });
}

function updateMediaCount() {
  document.getElementById('mediaCount').textContent = `${allMedia.length} items`;
}

function updateSelectionUI() {
  const count = selectedMediaIds.size;
  document.getElementById('selectedCount').textContent = count;
  document.getElementById('bulkTagBtn').disabled = count === 0;
  document.getElementById('bulkDeleteBtn').disabled = count === 0;

  // Update select/deselect buttons
  const selectAllBtn = document.getElementById('selectAllBtn');
  const deselectAllBtn = document.getElementById('deselectAllBtn');

  if (count > 0) {
    selectAllBtn.classList.add('hidden');
    deselectAllBtn.classList.remove('hidden');
  } else {
    selectAllBtn.classList.remove('hidden');
    deselectAllBtn.classList.add('hidden');
  }

  // Update visual state of grid items
  document.querySelectorAll('.media-grid-item').forEach(item => {
    if (selectedMediaIds.has(item.dataset.id)) {
      item.classList.add('selected');
    } else {
      item.classList.remove('selected');
    }
  });
}

// =============================================
// SELECTION
// =============================================

function toggleSelection(mediaId) {
  if (selectedMediaIds.has(mediaId)) {
    selectedMediaIds.delete(mediaId);
  } else {
    selectedMediaIds.add(mediaId);
  }
  updateSelectionUI();
}

function selectAll() {
  allMedia.forEach(m => selectedMediaIds.add(m.id));
  updateSelectionUI();
}

function deselectAll() {
  selectedMediaIds.clear();
  updateSelectionUI();
}

// =============================================
// MEDIA DETAIL MODAL
// =============================================

async function openMediaDetail(mediaId) {
  const media = allMedia.find(m => m.id === mediaId);
  if (!media) return;

  currentMediaId = mediaId;

  // Populate modal
  document.getElementById('detailImage').src = media.url;
  document.getElementById('detailCaption').value = media.caption || '';
  document.getElementById('detailCategory').value = media.category || 'mktg';

  // Metadata
  document.getElementById('detailSize').textContent = media.file_size_bytes
    ? mediaService.formatBytes(media.file_size_bytes)
    : 'Unknown';
  document.getElementById('detailDimensions').textContent = media.width && media.height
    ? `${media.width} × ${media.height}`
    : 'Unknown';
  document.getElementById('detailDate').textContent = formatDate(media.uploaded_at, true);

  // Spaces linked
  const spacesLinked = media.spaces?.map(s => {
    const space = allSpaces.find(sp => sp.id === s.space_id);
    return space?.name || 'Unknown';
  }).join(', ') || 'None';
  document.getElementById('detailSpaces').textContent = spacesLinked;

  // Render tags
  const groupedTags = await mediaService.getTagsGrouped();
  const mediaTags = media.tags?.map(t => t.name) || [];
  renderDetailTags(groupedTags, mediaTags);

  // Show modal
  document.getElementById('mediaDetailModal').classList.remove('hidden');
}

function renderDetailTags(groupedTags, selectedTags) {
  const container = document.getElementById('detailTagsContainer');

  // Get all groups dynamically from the data
  const groupNames = Object.keys(groupedTags).sort();

  container.innerHTML = `
    ${groupNames
      .filter(g => groupedTags[g]?.length > 0)
      .map(group => `
        <div class="tag-group">
          <span class="tag-group-label">${group}</span>
          <div class="tag-checkboxes">
            ${groupedTags[group].map(tag => `
              <label class="tag-checkbox">
                <input type="checkbox" name="detailTag" value="${tag.name}"
                  ${selectedTags.includes(tag.name) ? 'checked' : ''}>
                <span class="tag-chip" style="--tag-color: ${tag.color || 'var(--accent)'}">
                  ${tag.name}
                </span>
              </label>
            `).join('')}
          </div>
        </div>
      `).join('')}
    <div class="add-tag-inline">
      <button type="button" class="btn-add-tag" onclick="showAddTagFormMedia()">+ Add Tag</button>
    </div>
  `;
}

async function showAddTagFormMedia() {
  const container = document.getElementById('detailTagsContainer');
  if (!container) return;

  // Check if form already exists
  if (container.querySelector('.add-tag-form')) {
    container.querySelector('.add-tag-form').remove();
    return;
  }

  // Get existing groups
  const existingGroups = await mediaService.getTagGroups();

  // Create inline form
  const form = document.createElement('div');
  form.className = 'add-tag-form';
  form.innerHTML = `
    <div class="add-tag-form-row">
      <input type="text" id="newTagNameMedia" placeholder="Tag name" class="tag-input">
      <select id="newTagGroupMedia" class="tag-select">
        <option value="">Category (optional)</option>
        ${existingGroups.map(g => `<option value="${g}">${g}</option>`).join('')}
        <option value="__new__">+ New category...</option>
      </select>
      <input type="text" id="newTagGroupCustomMedia" placeholder="New category" class="tag-input hidden">
      <button type="button" class="btn-small btn-primary" onclick="createNewTagMedia()">Add</button>
      <button type="button" class="btn-small" onclick="hideAddTagFormMedia()">Cancel</button>
    </div>
  `;

  // Insert before the add button
  const addBtn = container.querySelector('.add-tag-inline');
  if (addBtn) {
    addBtn.before(form);
  } else {
    container.appendChild(form);
  }

  // Focus the name input
  form.querySelector('#newTagNameMedia').focus();

  // Handle category dropdown change
  form.querySelector('#newTagGroupMedia').addEventListener('change', (e) => {
    const customInput = form.querySelector('#newTagGroupCustomMedia');
    if (e.target.value === '__new__') {
      customInput.classList.remove('hidden');
      customInput.focus();
    } else {
      customInput.classList.add('hidden');
    }
  });
}

function hideAddTagFormMedia() {
  const container = document.getElementById('detailTagsContainer');
  if (!container) return;
  const form = container.querySelector('.add-tag-form');
  if (form) form.remove();
}

async function createNewTagMedia() {
  const container = document.getElementById('detailTagsContainer');
  if (!container) return;

  const nameInput = container.querySelector('#newTagNameMedia');
  const groupSelect = container.querySelector('#newTagGroupMedia');
  const customGroupInput = container.querySelector('#newTagGroupCustomMedia');

  const name = nameInput?.value.trim();
  if (!name) {
    showToast('Please enter a tag name', 'warning');
    return;
  }

  let group = groupSelect?.value;
  if (group === '__new__') {
    group = customGroupInput?.value.trim().toLowerCase();
    if (!group) {
      showToast('Please enter a category name', 'warning');
      return;
    }
  }

  try {
    const result = await mediaService.createTag(name, group || null);

    if (!result.success) {
      if (result.duplicate) {
        showToast('A tag with that name already exists', 'warning');
      } else {
        showToast('Failed to create tag: ' + result.error, 'error');
      }
      return;
    }

    // Add to allTags
    allTags.push(result.tag);

    // Re-render the detail tags
    const currentMedia = allMedia.find(m => m.id === currentMediaId);
    const selectedTags = currentMedia?.tags?.map(t => t.name) || [];
    const groupedTags = groupTagsByGroup(allTags);
    renderDetailTags(groupedTags, selectedTags);

    // Select the newly created tag
    const checkbox = container.querySelector(`input[value="${result.tag.name}"]`);
    if (checkbox) checkbox.checked = true;

    showToast('Tag created', 'success');

  } catch (error) {
    console.error('Error creating tag:', error);
    showToast('Failed to create tag', 'error');
  }
}

function groupTagsByGroup(tags) {
  const grouped = {};
  for (const tag of tags) {
    const group = tag.tag_group || 'other';
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(tag);
  }
  return grouped;
}

async function saveMediaDetail() {
  if (!currentMediaId) return;

  const caption = document.getElementById('detailCaption').value.trim();
  const category = document.getElementById('detailCategory').value;

  // Get selected tags
  const selectedTags = Array.from(
    document.querySelectorAll('#detailTagsContainer input[name="detailTag"]:checked')
  ).map(cb => cb.value);

  // Update media record
  const { error } = await supabase
    .from('media')
    .update({ caption, category })
    .eq('id', currentMediaId);

  if (error) {
    showToast('Failed to save: ' + error.message, 'error');
    return;
  }

  // Clear existing tags and reassign
  await supabase
    .from('media_tag_assignments')
    .delete()
    .eq('media_id', currentMediaId);

  if (selectedTags.length > 0) {
    await mediaService.assignTags(currentMediaId, selectedTags);
  }

  // Close modal and reload
  closeMediaDetail();
  await loadMedia();
}

function closeMediaDetail() {
  document.getElementById('mediaDetailModal').classList.add('hidden');
  currentMediaId = null;
}

async function deleteCurrentMedia() {
  if (!currentMediaId) return;

  const media = allMedia.find(m => m.id === currentMediaId);
  const spacesCount = media?.spaces?.length || 0;

  let confirmMsg = 'Are you sure you want to permanently delete this image?';
  if (spacesCount > 0) {
    confirmMsg = `This image is linked to ${spacesCount} space(s). Deleting it will remove it from all spaces.\n\nAre you sure you want to permanently delete it?`;
  }

  if (!confirm(confirmMsg)) return;

  const result = await mediaService.delete(currentMediaId);

  if (!result.success) {
    showToast('Failed to delete: ' + result.error, 'error');
    return;
  }

  closeMediaDetail();
  await loadMedia();
  await loadStorageUsage();
  showToast('Media deleted', 'success');
}

// =============================================
// BULK TAG MODAL
// =============================================

async function openBulkTagModal() {
  if (selectedMediaIds.size === 0) return;

  document.getElementById('bulkCount').textContent = selectedMediaIds.size;

  // Render tag options
  const groupedTags = await mediaService.getTagsGrouped();
  renderBulkTags('bulkAddTags', groupedTags);
  renderBulkTags('bulkRemoveTags', groupedTags);

  document.getElementById('bulkTagModal').classList.remove('hidden');
}

function renderBulkTags(containerId, groupedTags) {
  const container = document.getElementById(containerId);

  // Get all groups dynamically from the data
  const groupNames = Object.keys(groupedTags).sort();

  container.innerHTML = groupNames
    .filter(g => groupedTags[g]?.length > 0)
    .map(group => `
      <div class="tag-group">
        <span class="tag-group-label">${group}</span>
        <div class="tag-checkboxes">
          ${groupedTags[group].map(tag => `
            <label class="tag-checkbox">
              <input type="checkbox" name="${containerId}Tag" value="${tag.name}">
              <span class="tag-chip" style="--tag-color: ${tag.color || 'var(--accent)'}">
                ${tag.name}
              </span>
            </label>
          `).join('')}
        </div>
      </div>
    `).join('');
}

async function applyBulkTags() {
  const tagsToAdd = Array.from(
    document.querySelectorAll('#bulkAddTags input[name="bulkAddTagsTag"]:checked')
  ).map(cb => cb.value);

  const tagsToRemove = Array.from(
    document.querySelectorAll('#bulkRemoveTags input[name="bulkRemoveTagsTag"]:checked')
  ).map(cb => cb.value);

  if (tagsToAdd.length === 0 && tagsToRemove.length === 0) {
    showToast('Please select at least one tag to add or remove', 'warning');
    return;
  }

  // Get tag IDs for removal
  const { data: tagRecords } = await supabase
    .from('media_tags')
    .select('id, name')
    .in('name', tagsToRemove);

  const tagIdMap = new Map(tagRecords?.map(t => [t.name, t.id]) || []);

  // Process each selected media
  for (const mediaId of selectedMediaIds) {
    // Add tags
    if (tagsToAdd.length > 0) {
      await mediaService.assignTags(mediaId, tagsToAdd);
    }

    // Remove tags
    for (const tagName of tagsToRemove) {
      const tagId = tagIdMap.get(tagName);
      if (tagId) {
        await mediaService.removeTag(mediaId, tagId);
      }
    }
  }

  // Close modal and refresh
  closeBulkTagModal();
  deselectAll();
  await loadMedia();
}

function closeBulkTagModal() {
  document.getElementById('bulkTagModal').classList.add('hidden');
}

// =============================================
// BULK DELETE
// =============================================

async function bulkDeleteSelected() {
  const count = selectedMediaIds.size;
  if (count === 0) return;

  // Check if any selected media are linked to spaces
  const linkedMedia = allMedia.filter(m => selectedMediaIds.has(m.id) && m.spaces?.length > 0);
  let confirmMsg = `Are you sure you want to permanently delete ${count} image${count > 1 ? 's' : ''}?`;

  if (linkedMedia.length > 0) {
    confirmMsg = `${linkedMedia.length} of these images are linked to spaces. Deleting them will remove them from those spaces.\n\n${confirmMsg}`;
  }

  if (!confirm(confirmMsg)) return;

  const btn = document.getElementById('bulkDeleteBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Deleting...';

  let successCount = 0;
  let failCount = 0;
  const idsToDelete = Array.from(selectedMediaIds);

  for (const mediaId of idsToDelete) {
    const result = await mediaService.delete(mediaId);
    if (result.success) {
      successCount++;
    } else {
      console.error(`Failed to delete ${mediaId}:`, result.error);
      failCount++;
    }
  }

  // Show results
  if (failCount === 0) {
    showToast(`${successCount} image${successCount > 1 ? 's' : ''} deleted`, 'success');
  } else {
    showToast(`Deleted ${successCount}, failed ${failCount}`, failCount > 0 ? 'warning' : 'success');
  }

  // Clear selection and refresh
  deselectAll();
  await Promise.all([
    loadStorageUsage(),
    loadMedia(),
  ]);

  btn.disabled = false;
  btn.textContent = originalText;
}

// =============================================
// UPLOAD FUNCTIONALITY
// =============================================

function renderUploadTags() {
  const container = document.getElementById('uploadTagsContainer');
  if (!container) return;

  // Group tags by tag_group and sort by priority
  const grouped = {};
  allTags.forEach(tag => {
    const group = tag.tag_group || 'other';
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(tag);
  });
  const sortedGroups = mediaService.sortTagGroups(grouped);

  // Render with inline add tag at top
  container.innerHTML = `
    <div class="inline-add-tag">
      <input type="text" data-quick-input placeholder="Add new tag..." class="quick-tag-input">
      <select data-quick-group class="quick-tag-select">
        <option value="">Category</option>
        ${[...new Set(allTags.map(t => t.tag_group).filter(Boolean))].sort().map(g =>
          `<option value="${g}" ${g === 'space' ? 'selected' : ''}>${g}</option>`
        ).join('')}
        <option value="__new__">+ New...</option>
      </select>
      <input type="text" data-quick-custom placeholder="New category" class="quick-tag-input hidden">
    </div>
    ${Object.entries(sortedGroups).map(([group, tags]) => `
      <div class="tag-row">
        <div class="tag-group-label">${group}</div>
        <div class="tag-checkboxes">
          ${tags.map(tag => `
            <label class="tag-checkbox" style="--tag-color: ${tag.color || '#666'}">
              <input type="checkbox" value="${tag.name}">
              <span class="tag-chip">${tag.name}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `).join('')}
  `;

  // Setup inline add tag handlers
  setupQuickAddTag();
}

function setupQuickAddTag() {
  const container = document.getElementById('uploadTagsContainer');
  if (!container) return;

  const input = container.querySelector('[data-quick-input]');
  const groupSelect = container.querySelector('[data-quick-group]');
  const customGroupInput = container.querySelector('[data-quick-custom]');

  if (!input) return;

  // Show/hide custom group input
  groupSelect?.addEventListener('change', (e) => {
    if (e.target.value === '__new__') {
      customGroupInput?.classList.remove('hidden');
      customGroupInput?.focus();
    } else {
      customGroupInput?.classList.add('hidden');
    }
  });

  // Create tag on Enter
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await quickCreateTag();
    }
  });
}

async function quickCreateTag() {
  const container = document.getElementById('uploadTagsContainer');
  if (!container) return;

  const input = container.querySelector('[data-quick-input]');
  const groupSelect = container.querySelector('[data-quick-group]');
  const customGroupInput = container.querySelector('[data-quick-custom]');

  const name = input?.value.trim();
  if (!name) return;

  let group = groupSelect?.value;
  if (group === '__new__') {
    group = customGroupInput?.value.trim().toLowerCase();
  }
  if (group === '') group = null;

  try {
    const result = await mediaService.createTag(name, group);

    if (!result.success) {
      if (result.duplicate) {
        showToast('Tag already exists', 'warning');
      } else {
        showToast('Failed to create tag: ' + result.error, 'error');
      }
      return;
    }

    // Add to local tags array
    allTags.push(result.tag);

    // Re-render tags and auto-select the new tag
    renderUploadTags();

    // Find and check the new tag
    const newCheckbox = container.querySelector(`input[value="${result.tag.name}"]`);
    if (newCheckbox) newCheckbox.checked = true;

    showToast('Tag created', 'success');

  } catch (error) {
    console.error('Error creating tag:', error);
    showToast('Failed to create tag', 'error');
  }
}

function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  // Limit to 10 files at once
  const filesToAdd = files.slice(0, 10);
  if (files.length > 10) {
    showToast('Limited to 10 files at once. First 10 selected.', 'warning');
  }

  selectedUploadFiles = filesToAdd.map((file, idx) => ({
    file,
    id: `file-${Date.now()}-${idx}`,
    caption: '',
    preview: null
  }));

  // Load previews for each file
  selectedUploadFiles.forEach((item) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      item.preview = e.target.result;
      renderUploadPreviews();
    };
    reader.readAsDataURL(item.file);
  });

  showUploadPreview();
  renderUploadTags();
}

function handleDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('uploadArea').classList.add('drag-over');
}

function handleDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('uploadArea').classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('uploadArea').classList.remove('drag-over');

  const files = Array.from(e.dataTransfer.files).filter(f =>
    ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(f.type)
  );

  if (!files.length) {
    showToast('Please drop image files (JPEG, PNG, WebP, GIF)', 'warning');
    return;
  }

  // Limit to 10 files at once
  const filesToAdd = files.slice(0, 10);
  if (files.length > 10) {
    showToast('Limited to 10 files at once. First 10 selected.', 'warning');
  }

  selectedUploadFiles = filesToAdd.map((file, idx) => ({
    file,
    id: `file-${Date.now()}-${idx}`,
    caption: '',
    preview: null
  }));

  // Load previews for each file
  selectedUploadFiles.forEach((item) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      item.preview = e.target.result;
      renderUploadPreviews();
    };
    reader.readAsDataURL(item.file);
  });

  showUploadPreview();
  renderUploadTags();
}

function showUploadPreview() {
  document.getElementById('uploadArea').classList.add('hidden');
  document.getElementById('uploadPreviewSection').classList.remove('hidden');
  renderUploadPreviews();
}

function hideUploadPreview() {
  document.getElementById('uploadArea').classList.remove('hidden');
  document.getElementById('uploadPreviewSection').classList.add('hidden');
  selectedUploadFiles = [];
  document.getElementById('mediaFileInput').value = '';
  document.getElementById('uploadBulkCaption').value = '';
  document.getElementById('uploadCategory').value = 'space';
  // Clear tag selections
  document.querySelectorAll('#uploadTagsContainer input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
  });
}

function renderUploadPreviews() {
  const grid = document.getElementById('uploadPreviewGrid');
  const fileCountEl = document.getElementById('uploadFileCount');
  const submitBtn = document.getElementById('submitUploadBtn');

  if (!grid) return;

  const count = selectedUploadFiles.length;
  if (fileCountEl) fileCountEl.textContent = count;
  if (submitBtn) submitBtn.textContent = count > 1 ? `Upload All (${count})` : 'Upload';

  if (count === 0) {
    hideUploadPreview();
    return;
  }

  grid.innerHTML = selectedUploadFiles.map((item, idx) => `
    <div class="upload-preview-item" data-file-id="${item.id}">
      ${item.preview
        ? `<img src="${item.preview}" alt="Preview ${idx + 1}">`
        : `<div class="preview-loading">Loading...</div>`
      }
      <span class="preview-index">${idx + 1}</span>
      <button type="button" class="preview-remove" data-remove-id="${item.id}" title="Remove">&times;</button>
      <div class="preview-caption">
        <input type="text"
          placeholder="Caption..."
          value="${item.caption}"
          data-caption-id="${item.id}">
      </div>
    </div>
  `).join('');

  // Add event listeners for remove buttons
  grid.querySelectorAll('.preview-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeUploadFile(btn.dataset.removeId);
    });
  });

  // Add event listeners for caption inputs
  grid.querySelectorAll('.preview-caption input').forEach(input => {
    input.addEventListener('change', (e) => {
      updateFileCaption(input.dataset.captionId, e.target.value);
    });
    input.addEventListener('click', (e) => e.stopPropagation());
  });
}

function removeUploadFile(fileId) {
  selectedUploadFiles = selectedUploadFiles.filter(f => f.id !== fileId);
  renderUploadPreviews();
}

function updateFileCaption(fileId, caption) {
  const item = selectedUploadFiles.find(f => f.id === fileId);
  if (item) item.caption = caption;
}

// Guard against concurrent uploads
let isUploading = false;

async function handleUpload() {
  console.log('handleUpload called');

  // Guard against double-click or multiple submissions
  if (isUploading) {
    console.log('Upload already in progress, ignoring');
    return;
  }

  if (!authState?.isAdmin && !authState?.isStaff) {
    showToast('You do not have permission to upload', 'warning');
    return;
  }

  if (selectedUploadFiles.length === 0) {
    showToast('Please select at least one image.', 'warning');
    return;
  }

  // Set guard before any async work
  isUploading = true;

  const bulkCaption = document.getElementById('uploadBulkCaption')?.value.trim() || '';
  const category = document.getElementById('uploadCategory')?.value || 'space';

  // Get selected tags
  const selectedTags = [];
  document.querySelectorAll('#uploadTagsContainer input[type="checkbox"]:checked').forEach(cb => {
    selectedTags.push(cb.value);
  });

  const submitBtn = document.getElementById('submitUploadBtn');
  const progressContainer = document.getElementById('uploadProgress');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressText = document.getElementById('uploadProgressText');

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Uploading...';
  }

  // Always show progress bar
  if (progressContainer) {
    progressContainer.classList.remove('hidden');
    if (progressFill) progressFill.style.width = '0%';
  }

  let successCount = 0;
  let failCount = 0;
  const totalFiles = selectedUploadFiles.length;

  try {
    for (let i = 0; i < selectedUploadFiles.length; i++) {
      const item = selectedUploadFiles[i];
      const fileSize = item.file.size;

      // Update progress text
      if (progressText) {
        progressText.textContent = totalFiles > 1
          ? `Uploading ${i + 1} of ${totalFiles}...`
          : 'Uploading...';
      }

      // Use per-file caption if set, otherwise bulk caption
      const caption = item.caption || bulkCaption;

      try {
        const result = await mediaService.upload(item.file, {
          category,
          caption,
          tags: selectedTags,
          onProgress: (loaded, total) => {
            // Calculate progress: for multiple files, show overall progress
            // For single file, show byte-level progress
            let percent;
            if (totalFiles > 1) {
              // Progress = completed files + current file progress
              const completedProgress = (i / totalFiles) * 100;
              const currentFileProgress = (loaded / total) * (100 / totalFiles);
              percent = Math.round(completedProgress + currentFileProgress);
            } else {
              percent = Math.round((loaded / total) * 100);
            }
            if (progressFill) progressFill.style.width = `${percent}%`;
            if (progressText) {
              const loadedKB = Math.round(loaded / 1024);
              const totalKB = Math.round(total / 1024);
              progressText.textContent = totalFiles > 1
                ? `Uploading ${i + 1} of ${totalFiles}: ${percent}%`
                : `Uploading: ${loadedKB}KB / ${totalKB}KB (${percent}%)`;
            }
          },
        });

        if (result.success) {
          successCount++;
        } else if (result.isDuplicate) {
          console.log(`Skipping duplicate ${item.file.name}:`, result.existingMedia?.id);
          showToast(`${item.file.name}: Already exists in library`, 'warning', 5000);
          failCount++;
        } else {
          console.error(`Failed to upload ${item.file.name}:`, result.error, result.errorDetails);
          failCount++;

          // Show specific error message for this file
          const errorCode = result.errorDetails?.code || 'UNKNOWN';
          const errorHint = result.errorDetails?.hint || '';

          if (errorCode === 'DB_TIMEOUT') {
            showToast(`${item.file.name}: Database timeout - file may have uploaded but record creation failed`, 'warning', 8000);
          } else if (errorCode === 'AUTH_EXPIRED') {
            showToast(`${item.file.name}: Session expired - please refresh the page`, 'error', 8000);
          } else if (errorCode === 'PERMISSION_DENIED') {
            showToast(`${item.file.name}: Permission denied - contact admin`, 'error', 8000);
          } else if (errorCode === 'FILE_TOO_LARGE') {
            showToast(`${item.file.name}: File too large`, 'error', 6000);
          } else if (errorCode === 'NETWORK_ERROR') {
            showToast(`${item.file.name}: Network error - check your connection`, 'error', 6000);
          }
        }
      } catch (err) {
        console.error(`Error uploading ${item.file.name}:`, err);
        failCount++;
        showToast(`${item.file.name}: Unexpected error - ${err.message}`, 'error', 6000);
      }
    }

    // Final progress
    if (progressFill) progressFill.style.width = '100%';
    if (progressText) progressText.textContent = 'Complete!';

    // Show results
    if (failCount === 0) {
      if (successCount === 1) {
        showToast('Photo uploaded successfully!', 'success');
      } else {
        showToast(`${successCount} photos uploaded successfully!`, 'success');
      }
    } else {
      showToast(`Uploaded ${successCount} of ${totalFiles} photos. ${failCount} failed.`, 'warning');
    }

    // Refresh data
    await Promise.all([
      loadStorageUsage(),
      loadMedia(),
    ]);

    // Reset upload UI
    hideUploadPreview();

  } catch (error) {
    console.error('Error during upload:', error);
    showToast('Upload failed: ' + error.message, 'error');
  } finally {
    // Reset guard
    isUploading = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = selectedUploadFiles.length > 1 ? `Upload All (${selectedUploadFiles.length})` : 'Upload';
    }
    if (progressContainer) progressContainer.classList.add('hidden');
  }
}

// =============================================
// EVENT LISTENERS
// =============================================

function setupEventListeners() {
  // Upload area - file input and drag/drop
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('mediaFileInput');
  const browseBtn = document.getElementById('browseFilesBtn');

  console.log('[media.js] Setting up event listeners');
  console.log('[media.js] browseBtn found:', !!browseBtn);
  console.log('[media.js] fileInput found:', !!fileInput);

  browseBtn?.addEventListener('click', () => {
    console.log('[media.js] Browse button clicked');
    fileInput?.click();
  });
  fileInput?.addEventListener('change', (e) => {
    console.log('[media.js] File input changed, files:', e.target.files?.length);
    handleFileSelect(e);
  });

  uploadArea?.addEventListener('dragover', handleDragOver);
  uploadArea?.addEventListener('dragleave', handleDragLeave);
  uploadArea?.addEventListener('drop', handleDrop);

  // Upload controls
  document.getElementById('clearUploadBtn')?.addEventListener('click', hideUploadPreview);
  document.getElementById('cancelUploadBtn')?.addEventListener('click', hideUploadPreview);
  document.getElementById('submitUploadBtn')?.addEventListener('click', handleUpload);

  // Category filter
  document.getElementById('categoryFilter').addEventListener('change', (e) => {
    currentFilters.category = e.target.value;
    loadMedia();
  });

  // Clear filters
  document.getElementById('clearFilters').addEventListener('click', () => {
    currentFilters = { category: '', tags: [] };
    document.getElementById('categoryFilter').value = '';
    document.querySelectorAll('.tag-filter-chip').forEach(c => c.classList.remove('active'));
    loadMedia();
  });

  // Selection buttons
  document.getElementById('selectAllBtn').addEventListener('click', selectAll);
  document.getElementById('deselectAllBtn').addEventListener('click', deselectAll);
  document.getElementById('bulkTagBtn').addEventListener('click', openBulkTagModal);
  document.getElementById('bulkDeleteBtn').addEventListener('click', bulkDeleteSelected);

  // Media detail modal
  document.getElementById('closeMediaDetail').addEventListener('click', closeMediaDetail);
  document.getElementById('cancelMediaDetail').addEventListener('click', closeMediaDetail);
  document.getElementById('saveMediaDetail').addEventListener('click', saveMediaDetail);
  document.getElementById('deleteMediaBtn').addEventListener('click', deleteCurrentMedia);

  // Bulk tag modal
  document.getElementById('closeBulkTag').addEventListener('click', closeBulkTagModal);
  document.getElementById('cancelBulkTag').addEventListener('click', closeBulkTagModal);
  document.getElementById('applyBulkTags').addEventListener('click', applyBulkTags);

  // Sign out is handled by initAdminPage

  // Close modals on backdrop click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMediaDetail();
      closeBulkTagModal();
    }
  });
}

// =============================================
// UTILITIES
// =============================================

function formatDate(dateStr, full = false) {
  if (!dateStr) return '-';
  return formatDateTimeFull(dateStr, full);
}

// =============================================
// GLOBAL EXPORTS (for onclick handlers in rendered HTML)
// =============================================

window.showAddTagFormMedia = showAddTagFormMedia;
window.hideAddTagFormMedia = hideAddTagFormMedia;
window.createNewTagMedia = createNewTagMedia;
