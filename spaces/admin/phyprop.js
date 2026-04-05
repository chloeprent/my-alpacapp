/**
 * PhyProp - Physical Property data dashboard
 */

import { supabase } from '../../shared/supabase.js';
import { initAdminPage, showToast } from '../../shared/admin-shell.js';

let authState = null;
let activeSubtab = 'overview';
const loadedTabs = new Set();

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'phyprop',
    requiredRole: 'staff',
    section: 'staff',
    onReady: async () => {
      initSubtabs();
    }
  });
});

// =============================================
// SUBTAB ROUTING
// =============================================

function initSubtabs() {
  const hash = location.hash.replace('#', '');
  if (hash && document.getElementById(`pp-panel-${hash}`)) activeSubtab = hash;

  document.querySelectorAll('.pp-subtab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      switchSubtab(btn.dataset.tab);
    });
  });
  switchSubtab(activeSubtab);
}

function switchSubtab(tab) {
  activeSubtab = tab;
  location.hash = tab === 'overview' ? '' : tab;

  document.querySelectorAll('.pp-subtab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.querySelectorAll('.pp-panel').forEach(p => {
    p.style.display = p.id === `pp-panel-${tab}` ? '' : 'none';
  });

  if (!loadedTabs.has(tab)) {
    loadedTabs.add(tab);
    const loaders = {
      overview: loadOverviewTab,
      structures: loadStructuresTab,
      renderings: loadRenderingsTab,
    };
    loaders[tab]?.();
  }
}

async function loadOverviewTab() {
  await loadSpaces();
}

async function loadStructuresTab() {
  await Promise.all([
    loadParcel(),
    loadEdges(),
    loadStructures(),
    loadUtilities(),
    loadImpervious(),
    loadZoning(),
  ]);
}

// =============================================
// HELPERS
// =============================================

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

function badge(text, color = 'gray') {
  return `<span class="pp-badge pp-badge-${color}">${esc(text)}</span>`;
}

function typeBadge(type) {
  const colors = { Dwelling: 'blue', Amenity: 'green', Event: 'amber', Storage: 'gray' };
  return badge(type, colors[type] || 'gray');
}

function setCount(id, n) {
  const el = document.getElementById(id);
  if (el) el.textContent = `(${n})`;
}

function setStat(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// =============================================
// SPACES
// =============================================

async function loadSpaces() {
  try {
    const { data } = await supabase
      .from('spaces')
      .select('id, name, type, monthly_rate, beds, baths, is_archived, parent:parent_id(name)')
      .eq('is_archived', false)
      .order('name');

    const body = document.getElementById('spacesBody');
    if (!data || !data.length) { body.innerHTML = '<tr><td colspan="6" class="pp-empty">No spaces found</td></tr>'; return; }

    setCount('spacesCount', data.length);
    setStat('statSpaces', data.length);

    body.innerHTML = data.map(s => `<tr>
      <td style="font-weight:500;">${esc(s.name)}</td>
      <td>${typeBadge(s.type)}</td>
      <td>${s.monthly_rate ? `$${Number(s.monthly_rate).toLocaleString()}` : '--'}</td>
      <td>${s.beds ?? '--'}</td>
      <td>${s.baths ?? '--'}</td>
      <td style="color:var(--text-muted);font-size:0.75rem;">${s.parent?.name ? esc(s.parent.name) : '--'}</td>
    </tr>`).join('');
  } catch (err) {
    console.error('Spaces load error:', err);
  }
}


// =============================================
// STRUCTURES TAB — Parcel
// =============================================

async function loadParcel() {
  try {
    const { data } = await supabase
      .from('parcels')
      .select('*')
      .limit(1)
      .single();

    const el = document.getElementById('parcelSummary');
    if (!data) { el.innerHTML = '<div class="pp-empty">No parcel data found</div>'; return; }

    el.innerHTML = `
      <div class="pp-stat"><div class="pp-stat-label">Name</div><div class="pp-stat-value" style="font-size:1rem;">${esc(data.name)}</div></div>
      <div class="pp-stat"><div class="pp-stat-label">Acreage</div><div class="pp-stat-value">${data.acreage ?? '--'}</div></div>
      <div class="pp-stat"><div class="pp-stat-label">Area (sq ft)</div><div class="pp-stat-value">${data.area_sqft ? Number(data.area_sqft).toLocaleString() : '--'}</div></div>
      <div class="pp-stat"><div class="pp-stat-label">Flood Zone</div><div class="pp-stat-value" style="font-size:1rem;">${esc(data.flood_zone || '--')}</div></div>
      <div class="pp-stat"><div class="pp-stat-label">ESD District</div><div class="pp-stat-value" style="font-size:1rem;">${esc(data.esd_district || '--')}</div></div>
      <div class="pp-stat"><div class="pp-stat-label">Survey</div><div class="pp-stat-value" style="font-size:0.875rem;">${esc(data.survey_by || '--')} (${data.survey_date || '--'})</div></div>
    `;
  } catch (err) {
    console.error('Parcel load error:', err);
  }
}

// =============================================
// STRUCTURES TAB — Edges
// =============================================

async function loadEdges() {
  try {
    const { data } = await supabase
      .from('parcel_edges')
      .select('*')
      .order('edge_side');

    const body = document.getElementById('edgesBody');
    if (!data || !data.length) { body.innerHTML = '<tr><td colspan="7" class="pp-empty">No edges found</td></tr>'; return; }

    setCount('edgesCount', data.length);

    body.innerHTML = data.map(e => `<tr>
      <td><span class="pp-badge pp-badge-blue">${esc(e.edge_side)}</span></td>
      <td style="font-weight:500;">${esc(e.edge_label || '--')}</td>
      <td>${e.length_ft ? `${Number(e.length_ft).toFixed(1)} ft` : '--'}</td>
      <td style="font-size:0.75rem;">${esc(e.bearing || '--')}</td>
      <td>${e.is_road_frontage ? badge(e.road_name || 'Yes', 'green') : badge('No', 'gray')}</td>
      <td>${e.has_easement ? badge(`${e.easement_type} (${e.easement_width_ft}')`, 'amber') : badge('None', 'gray')}</td>
      <td>${e.setback_required_ft ? `${e.setback_required_ft} ft` : '--'}</td>
    </tr>`).join('');
  } catch (err) {
    console.error('Edges load error:', err);
  }
}

// =============================================
// STRUCTURES TAB — Structures
// =============================================

async function loadStructures() {
  try {
    const [{ data: structures }, { data: spaces }] = await Promise.all([
      supabase.from('structures')
        .select('*, structure_setbacks(*, edge:edge_id(edge_side, edge_label))')
        .order('name'),
      supabase.from('spaces')
        .select('id, name, type, parent_id, is_archived')
        .eq('is_archived', false)
        .order('name'),
    ]);

    const el = document.getElementById('structureTree');
    if (!structures || !structures.length) { el.innerHTML = '<div class="pp-empty">No structures found</div>'; return; }

    setCount('structuresCount', structures.length);

    // Build spaces hierarchy: top-level spaces → children
    const spaceMap = {};
    (spaces || []).forEach(sp => { spaceMap[sp.id] = sp; });
    const topSpaces = (spaces || []).filter(sp => !sp.parent_id);
    const childSpacesOf = (parentId) => (spaces || []).filter(sp => sp.parent_id === parentId);

    // Match structures to spaces by fuzzy name matching
    const structuresBySpace = {};
    const unmatched = [];
    structures.forEach(s => {
      const nameLower = (s.name || '').toLowerCase();
      const match = (spaces || []).find(sp => {
        const spLower = sp.name.toLowerCase();
        return spLower === nameLower || nameLower.includes(spLower) || spLower.includes(nameLower);
      });
      if (match) {
        if (!structuresBySpace[match.id]) structuresBySpace[match.id] = [];
        structuresBySpace[match.id].push(s);
      } else {
        unmatched.push(s);
      }
    });

    // Render tree
    let html = '<div class="pp-tree">';

    // Render a space group with its structures
    function renderSpaceGroup(space, depth = 0) {
      const children = childSpacesOf(space.id);
      const matched = structuresBySpace[space.id] || [];
      const hasContent = matched.length > 0 || children.some(c =>
        (structuresBySpace[c.id] || []).length > 0 || childSpacesOf(c.id).length > 0
      );
      if (!hasContent) return '';

      const indent = '<span class="pp-tree-indent"></span>'.repeat(depth);
      const groupId = `spgrp-${space.id}`;
      let out = '';

      // Group header row
      out += `<div class="pp-tree-row pp-group" onclick="document.getElementById('${groupId}').classList.toggle('open');this.querySelector('.pp-tree-arrow').classList.toggle('open')">
        ${indent}
        <span class="pp-tree-arrow">&#9654;</span>
        <span class="pp-tree-name">${esc(space.name)}</span>
        <span class="pp-tree-badges">
          ${badge(space.type || '--', space.type === 'Dwelling' ? 'blue' : space.type === 'Amenity' ? 'green' : 'gray')}
          <span style="font-size:0.6875rem;color:var(--text-muted)">${matched.length} structure${matched.length !== 1 ? 's' : ''}</span>
        </span>
      </div>`;

      // Children container
      out += `<div id="${groupId}" class="pp-tree-children">`;

      // Render structures under this space
      matched.forEach(s => { out += renderStructureRow(s, depth + 1); });

      // Recurse into child spaces
      children.forEach(c => { out += renderSpaceGroup(c, depth + 1); });

      out += '</div>';
      return out;
    }

    // Render a single structure row + expandable detail
    function renderStructureRow(s, depth) {
      const indent = '<span class="pp-tree-indent"></span>'.repeat(depth);
      const detailId = `stdet-${s.id}`;
      const compClass = s.setback_compliant === true ? 'compliant'
        : s.setback_compliant === false ? 'violation' : 'pending';
      const permitColors = {
        permitted: 'green', exempt: 'green', grandfathered: 'blue',
        unpermitted: 'red', violation: 'red', pending: 'amber',
      };

      const dims = [s.width_ft, s.length_ft].filter(Boolean).join(' × ');
      const dimsStr = dims ? `${dims} ft` : '';

      let out = `<div class="pp-tree-row" onclick="document.getElementById('${detailId}').classList.toggle('open');this.querySelector('.pp-tree-arrow').classList.toggle('open')">
        ${indent}
        <span class="pp-tree-arrow">&#9654;</span>
        <span class="pp-compliance-dot ${compClass}"></span>
        <span class="pp-tree-name">${esc(s.name)}</span>
        <span class="pp-tree-badges">
          ${badge(s.structure_type || '--', 'blue')}
          ${badge(s.permit_status || '?', permitColors[s.permit_status] || 'gray')}
          ${dimsStr ? `<span style="font-size:0.6875rem;color:var(--text-muted)">${esc(dimsStr)}</span>` : ''}
        </span>
      </div>`;

      // Expandable detail panel
      const amenities = [];
      if (s.has_plumbing) amenities.push('Plumbing');
      if (s.has_electric) amenities.push('Electric');
      if (s.has_hvac) amenities.push('HVAC');

      const setbacks = (s.structure_setbacks || []).map(sb => {
        const edgeLabel = sb.edge?.edge_side || '?';
        return `${sb.measured_distance_ft}′ to ${esc(edgeLabel)} (req ${sb.required_distance_ft}′) ${sb.is_compliant ? '✓' : '✗'}`;
      });

      out += `<div id="${detailId}" class="pp-tree-detail" style="padding-left:${1 + (depth + 1) * 1.25}rem">
        <dl class="pp-tree-detail-grid">
          <dt>Type</dt><dd>${esc(s.structure_type || '--')}</dd>
          <dt>Use</dt><dd>${esc(s.use_type || '--')}</dd>
          <dt>Dimensions</dt><dd>${dims ? `${dims}${s.height_ft ? ` × ${s.height_ft} H` : ''} ft` : '--'}</dd>
          <dt>Area</dt><dd>${s.area_sqft ? `${Number(s.area_sqft).toLocaleString()} sq ft` : '--'}</dd>
          <dt>Stories</dt><dd>${s.stories ?? '--'}</dd>
          <dt>Material</dt><dd>${esc(s.material || '--')}</dd>
          <dt>Roof</dt><dd>${esc(s.roof_type || '--')}</dd>
          <dt>Permit</dt><dd>${esc(s.permit_status || '--')}</dd>
          ${s.guest_capacity ? `<dt>Capacity</dt><dd>${s.guest_capacity} guests</dd>` : ''}
          ${s.bedrooms ? `<dt>Beds / Baths</dt><dd>${s.bedrooms} / ${s.bathrooms ?? '--'}</dd>` : ''}
          <dt>Movable</dt><dd>${s.is_movable ? 'Yes' : 'No'}</dd>
          ${amenities.length ? `<dt>Utilities</dt><dd>${amenities.join(', ')}</dd>` : ''}
          <dt>Nearest Edge</dt><dd>${s.nearest_edge_side ? `${s.nearest_edge_side} — ${s.nearest_edge_distance_ft}′ (req ${s.setback_required_ft}′)` : '--'}</dd>
          ${s.setback_surplus_ft != null ? `<dt>Setback Surplus</dt><dd>${s.setback_surplus_ft > 0 ? `+${s.setback_surplus_ft}′` : `${s.setback_surplus_ft}′`}</dd>` : ''}
        </dl>
        ${setbacks.length ? `<div style="margin-top:0.5rem;font-size:0.75rem;color:var(--text-muted);">
          <strong>Setback Measurements:</strong> ${setbacks.join(' · ')}
        </div>` : ''}
      </div>`;

      return out;
    }

    // Render top-level spaces
    topSpaces.forEach(sp => { html += renderSpaceGroup(sp, 0); });

    // Render unmatched structures at root level
    if (unmatched.length) {
      html += `<div class="pp-tree-row pp-group" onclick="document.getElementById('spgrp-unmatched').classList.toggle('open');this.querySelector('.pp-tree-arrow').classList.toggle('open')">
        <span class="pp-tree-arrow">&#9654;</span>
        <span class="pp-tree-name" style="color:var(--text-muted)">Other Structures</span>
        <span class="pp-tree-badges"><span style="font-size:0.6875rem;color:var(--text-muted)">${unmatched.length}</span></span>
      </div>`;
      html += '<div id="spgrp-unmatched" class="pp-tree-children">';
      unmatched.forEach(s => { html += renderStructureRow(s, 0); });
      html += '</div>';
    }

    html += '</div>';
    el.innerHTML = html;
  } catch (err) {
    console.error('Structures load error:', err);
  }
}

// =============================================
// STRUCTURES TAB — Utilities
// =============================================

async function loadUtilities() {
  try {
    const { data } = await supabase
      .from('property_utilities')
      .select('*')
      .order('utility_type');

    const body = document.getElementById('utilitiesBody');
    if (!data || !data.length) { body.innerHTML = '<tr><td colspan="4" class="pp-empty">No utilities found</td></tr>'; return; }

    setCount('utilitiesCount', data.length);

    body.innerHTML = data.map(u => `<tr>
      <td style="font-weight:500;">${esc(u.utility_type)}</td>
      <td>${esc(u.provider || '--')}</td>
      <td>${esc(u.system_type || '--')}</td>
      <td>${badge(u.availability_letter_status || '--', u.availability_letter_status === 'obtained' ? 'green' : u.availability_letter_status === 'pending' ? 'amber' : 'gray')}</td>
    </tr>`).join('');
  } catch (err) {
    console.error('Utilities load error:', err);
  }
}

// =============================================
// STRUCTURES TAB — Impervious Cover
// =============================================

async function loadImpervious() {
  try {
    const { data } = await supabase
      .from('impervious_cover')
      .select('*, structure:structure_id(name)')
      .order('id');

    const body = document.getElementById('imperviousBody');
    if (!data || !data.length) { body.innerHTML = '<tr><td colspan="3" class="pp-empty">No impervious cover data</td></tr>'; return; }

    setCount('imperviousCount', data.length);

    body.innerHTML = data.map(ic => `<tr>
      <td style="font-weight:500;">${esc(ic.structure?.name || ic.source_label || '--')}</td>
      <td>${esc(ic.surface_type || '--')}</td>
      <td>${ic.area_sqft ? `${Number(ic.area_sqft).toLocaleString()} sq ft` : '--'}</td>
    </tr>`).join('');
  } catch (err) {
    console.error('Impervious load error:', err);
  }
}

// =============================================
// STRUCTURES TAB — Zoning Rules
// =============================================

async function loadZoning() {
  try {
    const { data } = await supabase
      .from('zoning_rules')
      .select('*')
      .order('id');

    const body = document.getElementById('zoningBody');
    if (!data || !data.length) { body.innerHTML = '<tr><td colspan="4" class="pp-empty">No zoning rules found</td></tr>'; return; }

    body.innerHTML = data.map(z => `<tr>
      <td style="font-weight:500;">${esc(z.rule_name || z.name || '--')}</td>
      <td>${badge(z.category || z.rule_type || '--', 'blue')}</td>
      <td>${esc(z.value || z.rule_value || '--')}</td>
      <td style="font-size:0.75rem;color:var(--text-muted);">${esc(z.notes || z.description || '--')}</td>
    </tr>`).join('');
  } catch (err) {
    console.error('Zoning load error:', err);
  }
}

// =============================================
// RENDERINGS TAB
// =============================================

const STORAGE_BASE = 'YOUR_SUPABASE_URL/storage/v1/object/public/housephotos';

const SURVEY_PLATS = [
  {
    title: 'Land Title Survey — 2025 Update',
    description: '4Ward Land Surveying (Jason Ward, R.P.L.S. #5811). Shows all current structures including trailers, shipping containers, pool, main house, back house. Lot 14-B, Block 6, Blue Bonnet Acres.',
    url: '../../jackie/pages/permittingplan/survey-ward-2025.png',
    date: '2025',
    tags: ['survey', 'current', '4Ward'],
  },
  {
    title: 'Land Title Survey — Original (2021)',
    description: 'Original land title survey by 4Ward Land Surveying (Feb 4, 2021). Lot 14-B, Block 6, Blue Bonnet Acres, Corrected Plat, Section One, Your County.',
    url: '../../jackie/pages/permittingplan/survey-base.png',
    date: '2021-02-04',
    tags: ['survey', 'original', '4Ward'],
  },
];

const RENDERINGS = [
  {
    title: 'Bird\'s-Eye View — Full Property (DB Geometry)',
    description: '123 Main St — 14 structures rendered from PostGIS footprint_geom. Main House (stone, brown roof), Back House (wood), 4 containers (red/blue/beige), 2 trailers, deck, sauna, bathroom bldg, pool, driveway. Yellow lines = property boundary. Orange lines = setback lines. Red pins = corner markers.',
    file: 'renderings/property-birdseye-2026-03-21.png',
    date: '2026-03-21',
    engine: 'Cycles',
    samples: 128,
    resolution: '2560 × 1440',
    tags: ['bird\'s-eye', 'full property', 'database-driven'],
  },
];

function renderCard(r, urlOverride) {
  const url = urlOverride || `${STORAGE_BASE}/${r.file}`;
  return `<div class="pp-render-card">
    <img src="${esc(url)}" alt="${esc(r.title)}" loading="lazy"
         onclick="window.open('${esc(url)}', '_blank')">
    <div class="pp-render-meta">
      <div class="pp-render-info">
        <h4>${esc(r.title)}</h4>
        <p>${esc(r.description)}</p>
        ${r.engine ? `<p style="margin-top:0.375rem;font-size:0.75rem;color:var(--text-muted);">
          ${esc(r.engine)} · ${r.samples ? `${r.samples} samples` : ''} · ${esc(r.resolution || '')} · ${esc(r.date)}
        </p>` : `<p style="margin-top:0.375rem;font-size:0.75rem;color:var(--text-muted);">${esc(r.date)}</p>`}
      </div>
      <div class="pp-render-tags">
        ${(r.tags || []).map(t => `<span class="pp-tool-tag">${esc(t)}</span>`).join('')}
      </div>
    </div>
  </div>`;
}

async function loadRenderingsTab() {
  // Populate survey plats
  const surveyEl = document.getElementById('surveyGrid');
  surveyEl.innerHTML = SURVEY_PLATS.map(s => renderCard(s, s.url)).join('');

  // Populate 3D renderings
  const el = document.getElementById('renderingsGrid');

  // Also list any additional renders from storage
  const { data: files } = await supabase.storage
    .from('housephotos')
    .list('renderings', { limit: 50, sortBy: { column: 'created_at', order: 'desc' } });

  // Merge storage files with known renderings (avoid duplicates)
  const knownFiles = new Set(RENDERINGS.map(r => r.file.split('/').pop()));
  const extraFiles = (files || [])
    .filter(f => f.name.match(/\.(png|jpg|jpeg|webp)$/i) && !knownFiles.has(f.name))
    .map(f => ({
      title: f.name.replace(/[-_]/g, ' ').replace(/\.\w+$/, ''),
      description: '',
      file: `renderings/${f.name}`,
      date: f.created_at ? new Date(f.created_at).toISOString().slice(0, 10) : '--',
      tags: [],
    }));

  const allRenderings = [...RENDERINGS, ...extraFiles];

  if (!allRenderings.length) {
    el.innerHTML = '<div class="pp-empty">No renderings yet. Run <code>blender -P render_property.py</code> on Property Mac to generate.</div>';
    return;
  }

  el.innerHTML = allRenderings.map(r => renderCard(r)).join('');
}
