/**
 * Personal Directory Page
 * Renders a user's profile at YOUR_DOMAIN/{slug}
 * Privacy-aware: respects privacy_settings per field
 */
import { supabase } from '../shared/supabase.js';
import { initAuth, getAuthState } from '../shared/auth.js';
import { renderHeader, renderFooter, initSiteComponents } from '../shared/site-components.js';
import { isDemoUser, redactString } from '../shared/demo-redact.js';

// =============================================
// CONSTANTS
// =============================================

const ROLE_LABELS = {
  admin: 'Admin',
  oracle: 'Admin',
  staff: 'Staff',
  resident: 'Resident',
  associate: 'Associate',
  demo: 'Demo',
  public: 'Guest'
};

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  // Render site header & footer
  const version = document.querySelector('[data-site-version]')?.textContent || '';
  document.getElementById('siteHeader').innerHTML = renderHeader({
    transparent: false,
    light: false,
    version
  });
  document.getElementById('siteFooter').innerHTML = renderFooter();
  initSiteComponents();

  // Extract slug from query params (set by 404.html redirect)
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('slug')?.toLowerCase();

  if (!slug) {
    showNotFound();
    return;
  }

  try {
    // Try to init auth (non-blocking, for determining viewer identity)
    let viewer = null;
    try {
      await Promise.race([
        initAuth().then(() => { viewer = getAuthState(); }),
        new Promise(resolve => setTimeout(resolve, 5000))
      ]);
    } catch (e) {
      // Proceed without auth — anonymous viewer
    }

    // Query user by slug
    const { data: profileUser, error } = await supabase
      .from('app_users')
      .select('id, display_name, first_name, last_name, email, role, avatar_url, bio, phone, phone2, whatsapp, gender, pronouns, birthday, instagram, links, nationality, location_base, privacy_settings, is_current_resident, person_id, slug')
      .eq('slug', slug)
      .maybeSingle();

    if (error || !profileUser) {
      showNotFound();
      return;
    }

    // Set page title
    const displayName = profileUser.display_name || profileUser.first_name || 'Profile';
    document.title = `${displayName} — YOUR_PROPERTY_NAME`;

    // Determine viewer relationship
    const isSelf = viewer?.appUser?.id === profileUser.id;
    const isResident = viewer?.isResident === true;

    // Load related data in parallel
    const [assignmentResult, ownedVehiclesResult, drivenVehiclesResult] = await Promise.all([
      // Current assignment (via person_id)
      profileUser.person_id
        ? supabase
            .from('assignments')
            .select('id, start_date, end_date, status, assignment_spaces(space_id, spaces:space_id(name))')
            .eq('person_id', profileUser.person_id)
            .in('status', ['active', 'pending_contract', 'contract_sent'])
            .limit(1)
        : { data: null },
      // Owned vehicles
      supabase
        .from('vehicles')
        .select('id, name, vehicle_make, vehicle_model, year, color, color_hex, image_url')
        .eq('owner_id', profileUser.id)
        .eq('is_active', true)
        .order('display_order'),
      // Driven vehicles (via junction)
      supabase
        .from('vehicle_drivers')
        .select('vehicles:vehicle_id(id, name, vehicle_make, vehicle_model, year, color, color_hex, image_url)')
        .eq('app_user_id', profileUser.id)
    ]);

    const currentAssignment = assignmentResult.data?.[0] || null;

    // Merge owned + driven vehicles, dedup
    const vehicles = [...(ownedVehiclesResult.data || [])];
    const seen = new Set(vehicles.map(v => v.id));
    for (const d of (drivenVehiclesResult.data || [])) {
      if (d.vehicles && !seen.has(d.vehicles.id)) {
        vehicles.push(d.vehicles);
        seen.add(d.vehicles.id);
      }
    }

    // Check if associate
    const isAssociate = ['associate'].includes(profileUser.role);

    // Render
    renderProfile(profileUser, {
      isSelf,
      isResident,
      currentAssignment,
      vehicles,
      isAssociate
    });
  } catch (err) {
    console.error('[directory] Failed to load profile:', err);
    showNotFound();
  }
});

// =============================================
// PRIVACY
// =============================================

function shouldShow(fieldKey, privacySettings, isSelf, isResident) {
  if (isSelf) return true;
  const level = privacySettings?.[fieldKey] || 'all_guests';
  switch (level) {
    case 'all_guests': return true;
    case 'residents': return isResident;
    case 'only_me': return false;
    default: return true;
  }
}

// =============================================
// RENDER
// =============================================

function renderProfile(user, ctx) {
  const { isSelf, isResident, currentAssignment, vehicles, isAssociate } = ctx;
  const ps = user.privacy_settings || {};

  const container = document.getElementById('profileState');
  let html = '';

  // Self banner
  if (isSelf) {
    html += `<div class="dir-self-banner">
      <span>This is your personal page</span>
      <a href="/residents/profile.html">Edit Profile</a>
    </div>`;
  }

  html += '<div class="dir-card">';

  // --- Header: avatar, name, badges ---
  const nameRaw = user.display_name || `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Anonymous';
  const name = (isDemoUser() && !isSelf) ? redactString(nameRaw, 'name') : nameRaw;
  const initials = getInitials(name);
  const avatarHtml = user.avatar_url
    ? `<img src="${esc(user.avatar_url)}" alt="${esc(name)}">`
    : `<span class="dir-avatar-initials">${esc(initials)}</span>`;

  const roleClass = user.role === 'oracle' ? 'admin' : user.role;
  const roleLabel = ROLE_LABELS[user.role] || user.role;

  let badgesHtml = `<span class="dir-badge dir-badge--role ${esc(roleClass)}">${esc(roleLabel)}</span>`;
  if (user.is_current_resident) {
    badgesHtml += '<span class="dir-badge dir-badge--here">Currently Here</span>';
  }

  html += `<div class="dir-header">
    <div class="dir-avatar">${avatarHtml}</div>
    <h1 class="dir-name ${(isDemoUser() && !isSelf) ? 'demo-redacted' : ''}">${esc(name)}</h1>
    <div class="dir-badges">${badgesHtml}</div>
  </div>`;

  // --- Bio ---
  if (user.bio && shouldShow('bio', ps, isSelf, isResident)) {
    html += `<div class="dir-section">
      <div class="dir-bio">${esc(user.bio)}</div>
    </div>`;
  }

  // --- Details (nationality, location, gender, birthday, pronouns) ---
  const detailFields = [];

  if (user.nationality && shouldShow('nationality', ps, isSelf, isResident)) {
    const flag = nationalityFlag(user.nationality);
    detailFields.push({ label: 'From', value: `${flag} ${esc(user.nationality)}` });
  }
  if (user.location_base && shouldShow('location_base', ps, isSelf, isResident)) {
    detailFields.push({ label: 'Based in', value: esc(user.location_base) });
  }
  if (user.gender && shouldShow('gender', ps, isSelf, isResident)) {
    detailFields.push({ label: 'Gender', value: esc(capitalize(user.gender)) });
  }
  if (user.pronouns) {
    detailFields.push({ label: 'Pronouns', value: esc(user.pronouns) });
  }
  if (user.birthday && shouldShow('birthday', ps, isSelf, isResident)) {
    detailFields.push({ label: 'Birthday', value: formatBirthday(user.birthday) });
  }

  if (detailFields.length) {
    html += `<div class="dir-section">
      <div class="dir-section-title">About</div>
      ${detailFields.map(f => `<div class="dir-field">
        <span class="dir-field-label">${f.label}</span>
        <span class="dir-field-value">${f.value}</span>
      </div>`).join('')}
    </div>`;
  }

  // --- Contact (phone, whatsapp, instagram) ---
  const contactFields = [];

  if (user.phone && shouldShow('phone', ps, isSelf, isResident)) {
    contactFields.push({ label: 'Phone', value: `<a href="tel:${esc(user.phone)}">${esc(user.phone)}</a>` });
  }
  if (user.phone2 && shouldShow('phone2', ps, isSelf, isResident)) {
    contactFields.push({ label: 'Phone 2', value: `<a href="tel:${esc(user.phone2)}">${esc(user.phone2)}</a>` });
  }
  if (user.whatsapp && shouldShow('whatsapp', ps, isSelf, isResident)) {
    const waNum = user.whatsapp.replace(/\D/g, '');
    contactFields.push({ label: 'WhatsApp', value: `<a href="https://wa.me/${waNum}" target="_blank">${esc(user.whatsapp)}</a>` });
  }
  if (user.instagram && shouldShow('instagram', ps, isSelf, isResident)) {
    const ig = user.instagram.replace(/^@/, '');
    contactFields.push({ label: 'Instagram', value: `<a href="https://instagram.com/${esc(ig)}" target="_blank">@${esc(ig)}</a>` });
  }

  if (contactFields.length) {
    html += `<div class="dir-section">
      <div class="dir-section-title">Contact</div>
      ${contactFields.map(f => `<div class="dir-field">
        <span class="dir-field-label">${f.label}</span>
        <span class="dir-field-value">${f.value}</span>
      </div>`).join('')}
    </div>`;
  }

  // --- Links ---
  const links = user.links;
  if (links?.length && shouldShow('links', ps, isSelf, isResident)) {
    const chipsHtml = links.map(l =>
      `<a href="${esc(l.url)}" target="_blank" rel="noopener" class="dir-link-chip">${esc(l.label || l.url)}</a>`
    ).join('');
    html += `<div class="dir-section">
      <div class="dir-section-title">Links</div>
      <div class="dir-links">${chipsHtml}</div>
    </div>`;
  }

  // --- Current Assignment (resident-only) ---
  if (currentAssignment && (isSelf || isResident)) {
    const spaces = currentAssignment.assignment_spaces
      ?.map(as => as.spaces?.name)
      .filter(Boolean)
      .join(', ') || 'Unknown space';

    html += `<div class="dir-section">
      <div class="dir-section-title">Staying In</div>
      <div class="dir-space">
        <span class="dir-space-icon">🏠</span>
        <span>${esc(spaces)}</span>
      </div>
    </div>`;
  }

  // --- Vehicles (resident-only) ---
  if (vehicles.length && (isSelf || isResident)) {
    const vehiclesHtml = vehicles.map(v => {
      const colorHex = v.color_hex || '#ccc';
      const detail = [v.year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ');
      return `<div class="dir-vehicle">
        <div class="dir-vehicle-color" style="background:${esc(colorHex)}"></div>
        <div class="dir-vehicle-info">
          <div class="dir-vehicle-name">${esc(v.name || detail)}</div>
          ${v.name ? `<div class="dir-vehicle-detail">${esc(detail)}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    html += `<div class="dir-section">
      <div class="dir-section-title">Vehicles</div>
      ${vehiclesHtml}
    </div>`;
  }

  // --- Work Hours link (self-only, if associate) ---
  if (isSelf && isAssociate) {
    html += `<div class="dir-section">
      <div class="dir-section-title">Work</div>
      <a href="/associates/worktracking.html" class="dir-link-chip">View Work Hours</a>
    </div>`;
  }

  html += '</div>'; // close .dir-card

  container.innerHTML = html;
  showState('profileState');
}

// =============================================
// STATE MANAGEMENT
// =============================================

function showNotFound() {
  showState('notFoundState');
}

function showState(id) {
  document.getElementById('loadingState').classList.add('aap-hidden');
  document.getElementById('notFoundState').classList.add('aap-hidden');
  document.getElementById('profileState').classList.add('aap-hidden');
  document.getElementById(id).classList.remove('aap-hidden');
}

// =============================================
// HELPERS
// =============================================

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function getInitials(name) {
  return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).replace(/-/g, ' ');
}

function formatBirthday(dateStr) {
  try {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function nationalityFlag(nationality) {
  const map = {
    american: '🇺🇸', brazilian: '🇧🇷', british: '🇬🇧', canadian: '🇨🇦',
    chinese: '🇨🇳', colombian: '🇨🇴', cuban: '🇨🇺', dutch: '🇳🇱',
    french: '🇫🇷', german: '🇩🇪', indian: '🇮🇳', irish: '🇮🇪',
    italian: '🇮🇹', japanese: '🇯🇵', korean: '🇰🇷', mexican: '🇲🇽',
    polish: '🇵🇱', portuguese: '🇵🇹', russian: '🇷🇺', spanish: '🇪🇸',
    swedish: '🇸🇪', australian: '🇦🇺', argentinian: '🇦🇷', chilean: '🇨🇱',
    czech: '🇨🇿', danish: '🇩🇰', finnish: '🇫🇮', greek: '🇬🇷',
    hungarian: '🇭🇺', israeli: '🇮🇱', nigerian: '🇳🇬', norwegian: '🇳🇴',
    peruvian: '🇵🇪', filipino: '🇵🇭', romanian: '🇷🇴', south_african: '🇿🇦',
    swiss: '🇨🇭', thai: '🇹🇭', turkish: '🇹🇷', ukrainian: '🇺🇦',
    venezuelan: '🇻🇪', vietnamese: '🇻🇳'
  };
  const key = nationality.toLowerCase().replace(/\s+/g, '_');
  return map[key] || '🌍';
}
