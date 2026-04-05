/**
 * Profile Page - User profile editing
 */
import { initResidentPage, showToast } from '../shared/resident-shell.js';
import { supabase } from '../shared/supabase.js';
import { getAuthState } from '../shared/auth.js';
import { identityService } from '../shared/identity-service.js';

const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB after compression
const AVATAR_MAX_DIM = 512;

let currentUser = null;
let profileData = null;
let savedSnapshot = null; // snapshot of form values after load/save
let userVehicles = []; // vehicles the user owns or drives
let ownedVehicles = []; // vehicles the user owns (for limit check)
let vehicleLimit = 1;
let editingVehicleId = null; // null = adding new, number = editing existing
let connectedTeslaAccountId = null; // set after Tesla OAuth return

document.addEventListener('DOMContentLoaded', async () => {
  await initResidentPage({
    activeTab: 'profile',
    requiredRole: 'resident',
    onReady: async (authState) => {
      currentUser = authState.appUser;
      await loadProfile();
      bindEvents();
    },
  });
});

// =============================================
// LOAD PROFILE
// =============================================

async function loadProfile() {
  const [profileRes, ownedRes, driverRes] = await Promise.all([
    supabase
      .from('app_users')
      .select('id, display_name, first_name, last_name, email, contact_email, role, avatar_url, bio, phone, phone2, whatsapp, gender, pronouns, birthday, instagram, telegram, facebook_url, links, nationality, location_base, dietary_preferences, allergies, privacy_settings, vehicle_limit, is_current_resident, person_id, slug')
      .eq('id', currentUser.id)
      .single(),
    supabase
      .from('vehicles')
      .select('id, name, vehicle_make, vehicle_model, year, color, color_hex, vin, image_url, license_plate, vehicle_length_ft, account_id, drivers:vehicle_drivers(id, app_user:app_user_id(id, display_name, email))')
      .eq('owner_id', currentUser.id)
      .eq('is_active', true)
      .order('display_order'),
    supabase
      .from('vehicle_drivers')
      .select('vehicle_id, vehicles:vehicle_id(id, name, vehicle_make, vehicle_model, year, color, color_hex, vin, image_url, license_plate, vehicle_length_ft, account_id)')
      .eq('app_user_id', currentUser.id),
  ]);

  if (profileRes.error) {
    showToast('Failed to load profile', 'error');
    return;
  }

  profileData = profileRes.data;
  vehicleLimit = profileRes.data.vehicle_limit || 1;

  // Merge owned + driver vehicles, deduplicate
  ownedVehicles = (ownedRes.data || []).map(v => ({ ...v, relationship: 'Owner' }));
  const driven = (driverRes.data || [])
    .map(d => d.vehicles)
    .filter(Boolean)
    .map(v => ({ ...v, relationship: 'Driver' }));
  const seen = new Set();
  userVehicles = [];
  for (const v of [...ownedVehicles, ...driven]) {
    if (!seen.has(v.id)) {
      seen.add(v.id);
      userVehicles.push(v);
    }
  }

  renderProfile();
  renderPersonalUrl();
  renderVehicles();
  renderIdVerification();

  // Auto-generate slug if not set
  if (!profileData.slug) {
    await autoGenerateSlug();
  }

  // Check for Tesla OAuth return
  const urlParams = new URLSearchParams(window.location.search);
  const teslaConnectedId = urlParams.get('tesla_connected');
  if (teslaConnectedId) {
    connectedTeslaAccountId = parseInt(teslaConnectedId);
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    // Restore draft and reopen form
    restoreVehicleDraft();
  }

  // Scroll to vehicles section if hash
  if (window.location.hash === '#vehicles') {
    document.getElementById('vehiclesSection')?.scrollIntoView({ behavior: 'smooth' });
  }
}

function getDisplayName(d) {
  if (d.first_name && d.last_name) return `${d.first_name} ${d.last_name}`;
  if (d.first_name) return d.first_name;
  return d.display_name || d.email;
}

function renderProfile() {
  const d = profileData;
  const displayName = getDisplayName(d);

  // Header section
  renderAvatar(d.avatar_url, displayName);
  document.getElementById('profileName').textContent = displayName;
  const roleEl = document.getElementById('profileRole');
  roleEl.textContent = (d.role || 'resident').charAt(0).toUpperCase() + (d.role || 'resident').slice(1);
  roleEl.className = 'role-badge ' + (d.role || 'resident');

  // Current resident badge
  const residentStatusEl = document.getElementById('profileResidentStatus');
  if (residentStatusEl) {
    if (d.is_current_resident) {
      residentStatusEl.textContent = '&#127968; Currently here';
      residentStatusEl.innerHTML = '&#127968; Currently here';
      residentStatusEl.className = 'resident-status-badge here';
      residentStatusEl.style.display = '';
    } else {
      residentStatusEl.style.display = 'none';
    }
  }

  // Form fields
  document.getElementById('fieldFirstName').value = d.first_name || '';
  document.getElementById('fieldLastName').value = d.last_name || '';
  document.getElementById('fieldDisplayName').value = d.display_name || '';
  const hasSeparateContact = !!d.contact_email;
  document.getElementById('contactEmailSameAsLogin').checked = !hasSeparateContact;
  document.getElementById('fieldContactEmail').value = d.contact_email || '';
  document.getElementById('fieldContactEmail').placeholder = d.email || '';
  document.getElementById('fieldContactEmail').style.display = hasSeparateContact ? '' : 'none';
  document.getElementById('fieldGender').value = d.gender || '';
  document.getElementById('fieldBio').value = d.bio || '';
  document.getElementById('fieldNationality').value = d.nationality || '';
  document.getElementById('fieldLocationBase').value = d.location_base || '';
  document.getElementById('fieldBirthday').value = d.birthday || '';
  document.getElementById('fieldPhone').value = d.phone || '';
  document.getElementById('fieldPhone2').value = d.phone2 || '';
  document.getElementById('fieldWhatsApp').value = d.whatsapp || '';
  document.getElementById('fieldInstagram').value = d.instagram || '';
  document.getElementById('fieldTelegram').value = d.telegram || '';
  document.getElementById('fieldFacebook').value = d.facebook_url || '';

  // Dietary preferences
  const dietary = d.dietary_preferences || {};
  const selectedDiets = dietary.selected || [];
  document.querySelectorAll('#dietaryOptions input[type="checkbox"]').forEach(cb => {
    cb.checked = selectedDiets.includes(cb.value);
  });
  document.getElementById('fieldDietaryCustom').value = dietary.custom || '';

  // Allergies
  const allergies = d.allergies || {};
  const selectedAllergies = allergies.selected || [];
  document.querySelectorAll('#allergyOptions input[type="checkbox"]').forEach(cb => {
    cb.checked = selectedAllergies.includes(cb.value);
  });
  document.getElementById('fieldAllergyCustom').value = allergies.custom || '';

  // Bio counter
  updateBioCount();

  // Flags
  updateNationalityFlag();
  updateLocationFlag();

  // Links
  renderLinks(d.links || []);

  // Privacy controls
  renderPrivacyControls();

  // Snapshot for dirty tracking (after all fields are set)
  savedSnapshot = getFormSnapshot();
  updateSaveButton();
}

function renderAvatar(avatarUrl, name) {
  const container = document.getElementById('profileAvatar');
  const initialsEl = document.getElementById('avatarInitials');

  if (avatarUrl) {
    container.style.backgroundImage = `url(${avatarUrl})`;
    container.style.backgroundSize = 'cover';
    container.style.backgroundPosition = 'center';
    initialsEl.style.display = 'none';
  } else {
    container.style.backgroundImage = '';
    initialsEl.style.display = '';
    initialsEl.textContent = getInitials(name);
  }
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name[0].toUpperCase();
}

// =============================================
// LINKS
// =============================================

function renderLinks(links) {
  const container = document.getElementById('linksContainer');
  container.innerHTML = '';

  links.forEach((link, i) => {
    const row = document.createElement('div');
    row.className = 'profile-link-row';
    row.innerHTML = `
      <input type="text" class="link-label" placeholder="Label" value="${escapeAttr(link.label || '')}" maxlength="30">
      <input type="url" class="link-url" placeholder="https://..." value="${escapeAttr(link.url || '')}" maxlength="200">
      <button class="btn-icon profile-link-remove" data-index="${i}" title="Remove link">&times;</button>
    `;
    container.appendChild(row);
  });

  // Bind remove buttons
  container.querySelectorAll('.profile-link-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.profile-link-row').remove();
      updateSaveButton();
    });
  });
}

function collectLinks() {
  const rows = document.querySelectorAll('#linksContainer .profile-link-row');
  const links = [];
  rows.forEach(row => {
    const label = row.querySelector('.link-label').value.trim();
    const url = row.querySelector('.link-url').value.trim();
    if (label || url) {
      links.push({ label, url });
    }
  });
  return links;
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =============================================
// AVATAR UPLOAD
// =============================================

async function handleAvatarUpload(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('Please select an image file', 'error');
    return;
  }

  showToast('Uploading avatar...', 'info', 10000);

  try {
    // Compress image
    const compressed = await compressAvatar(file);

    // Upload to Supabase Storage
    const ext = 'webp';
    const path = `avatars/${currentUser.id}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('housephotos')
      .upload(path, compressed, {
        contentType: 'image/webp',
        upsert: true,
      });

    if (uploadError) throw uploadError;

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('housephotos')
      .getPublicUrl(path);

    const avatarUrl = urlData.publicUrl + '?t=' + Date.now(); // cache bust

    // Save to database
    const { error: dbError } = await supabase
      .from('app_users')
      .update({ avatar_url: avatarUrl })
      .eq('id', currentUser.id);

    if (dbError) throw dbError;

    if (profileData) profileData.avatar_url = avatarUrl;
    renderAvatar(avatarUrl, profileData?.display_name || profileData?.email || '');

    // Update cached auth state
    updateCachedAuth({ avatar_url: avatarUrl });

    showToast('Avatar updated', 'success');
  } catch (err) {
    console.error('Avatar upload failed:', err);
    showToast('Failed to upload avatar: ' + err.message, 'error');
  }
}

function compressAvatar(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement('canvas');
      let w = img.width;
      let h = img.height;

      // Scale down if needed
      if (w > AVATAR_MAX_DIM || h > AVATAR_MAX_DIM) {
        const ratio = Math.min(AVATAR_MAX_DIM / w, AVATAR_MAX_DIM / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }

      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('Compression failed')),
        'image/webp',
        0.85
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load image'));
    };
    img.src = objectUrl;
  });
}

// =============================================
// SOCIAL MEDIA VALIDATION
// =============================================

function normalizeFacebookUrl(input) {
  if (!input) return null;

  // If it's already a full URL, validate and return
  if (input.startsWith('http://') || input.startsWith('https://')) {
    try {
      const url = new URL(input);
      if (url.hostname.includes('facebook.com') || url.hostname.includes('fb.com') || url.hostname.includes('fb.me')) {
        return input;
      }
      // Invalid Facebook URL
      return null;
    } catch (e) {
      return null;
    }
  }

  // If it looks like a username (no dots, slashes, etc.), convert to URL
  const username = input.replace(/^@/, '').trim();
  if (/^[a-zA-Z0-9._]+$/.test(username)) {
    return `https://facebook.com/${username}`;
  }

  // Try to extract from partial URL (e.g., "facebook.com/username")
  if (input.includes('facebook.com/') || input.includes('fb.com/') || input.includes('fb.me/')) {
    return `https://${input.replace(/^(https?:\/\/)/, '')}`;
  }

  return null;
}

// =============================================
// SAVE PROFILE
// =============================================

async function saveProfile() {
  const btn = document.getElementById('saveProfileBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const firstName = document.getElementById('fieldFirstName').value.trim() || null;
    const lastName = document.getElementById('fieldLastName').value.trim() || null;

    const sameAsLogin = document.getElementById('contactEmailSameAsLogin').checked;
    const contactEmail = sameAsLogin ? null : (document.getElementById('fieldContactEmail').value.trim() || null);

    const telegram = document.getElementById('fieldTelegram').value.trim().replace(/^@/, '') || null;
    const facebook = document.getElementById('fieldFacebook').value.trim() || null;

    const updates = {
      first_name: firstName,
      last_name: lastName,
      display_name: document.getElementById('fieldDisplayName').value.trim() || null,
      contact_email: contactEmail,
      gender: document.getElementById('fieldGender').value || null,
      bio: document.getElementById('fieldBio').value.trim() || null,
      nationality: document.getElementById('fieldNationality').value.trim() || null,
      location_base: document.getElementById('fieldLocationBase').value.trim() || null,
      birthday: document.getElementById('fieldBirthday').value || null,
      phone: document.getElementById('fieldPhone').value.trim() || null,
      phone2: document.getElementById('fieldPhone2').value.trim() || null,
      whatsapp: document.getElementById('fieldWhatsApp').value.trim() || null,
      instagram: document.getElementById('fieldInstagram').value.trim().replace(/^@/, '') || null,
      telegram: telegram,
      facebook_url: normalizeFacebookUrl(facebook),
      dietary_preferences: collectDietaryPreferences(),
      allergies: collectAllergies(),
      links: collectLinks(),
      privacy_settings: collectPrivacySettings(),
    };

    const { error } = await supabase
      .from('app_users')
      .update(updates)
      .eq('id', currentUser.id);

    if (error) throw error;

    // Update local state
    Object.assign(profileData, updates);

    // Sync contact email to linked person record
    if (profileData.person_id && contactEmail) {
      await supabase
        .from('people')
        .update({ email: contactEmail })
        .eq('id', profileData.person_id);
    }

    // Update header name
    const headerName = getDisplayName(profileData);
    document.getElementById('profileName').textContent = headerName;

    // Update cached auth state so header updates on other pages
    updateCachedAuth({ display_name: updates.display_name, first_name: updates.first_name, last_name: updates.last_name });

    // Update this page's header
    const userInfoEl = document.getElementById('userInfo');
    if (userInfoEl) {
      const nameSpan = userInfoEl.querySelector('.user-profile-name');
      if (nameSpan) nameSpan.textContent = headerName;
    }

    showToast('Profile saved', 'success');

    // Re-snapshot so button becomes disabled again
    savedSnapshot = getFormSnapshot();
    updateSaveButton();
  } catch (err) {
    console.error('Save failed:', err);
    showToast('Failed to save: ' + err.message, 'error');
  } finally {
    if (btn.textContent === 'Saving...') {
      btn.textContent = 'Save Profile';
    }
    updateSaveButton();
  }
}

// =============================================
// CACHED AUTH UPDATE
// =============================================

function updateCachedAuth(fields) {
  try {
    const cached = localStorage.getItem('your-project-cached-auth');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.appUser) {
        Object.assign(parsed.appUser, fields);
        localStorage.setItem('your-project-cached-auth', JSON.stringify(parsed));
      }
    }
  } catch (e) {
    // Ignore cache update failures
  }
}

// =============================================
// BIO COUNT
// =============================================

function updateBioCount() {
  const bio = document.getElementById('fieldBio');
  document.getElementById('bioCount').textContent = (bio.value || '').length;
}

// =============================================
// COUNTRY FLAG LOOKUP
// =============================================

const COUNTRY_FLAGS = {
  'afghan':'🇦🇫','albanian':'🇦🇱','algerian':'🇩🇿','american':'🇺🇸','andorran':'🇦🇩',
  'angolan':'🇦🇴','argentine':'🇦🇷','argentinian':'🇦🇷','armenian':'🇦🇲','australian':'🇦🇺',
  'austrian':'🇦🇹','azerbaijani':'🇦🇿','bahamian':'🇧🇸','bahraini':'🇧🇭','bangladeshi':'🇧🇩',
  'barbadian':'🇧🇧','belarusian':'🇧🇾','belgian':'🇧🇪','belizean':'🇧🇿','beninese':'🇧🇯',
  'bhutanese':'🇧🇹','bolivian':'🇧🇴','bosnian':'🇧🇦','brazilian':'🇧🇷','british':'🇬🇧',
  'bruneian':'🇧🇳','bulgarian':'🇧🇬','burkinabe':'🇧🇫','burmese':'🇲🇲','burundian':'🇧🇮',
  'cambodian':'🇰🇭','cameroonian':'🇨🇲','canadian':'🇨🇦','cape verdean':'🇨🇻','chadian':'🇹🇩',
  'chilean':'🇨🇱','chinese':'🇨🇳','colombian':'🇨🇴','comorian':'🇰🇲','congolese':'🇨🇬',
  'costa rican':'🇨🇷','croatian':'🇭🇷','cuban':'🇨🇺','cypriot':'🇨🇾','czech':'🇨🇿',
  'danish':'🇩🇰','djiboutian':'🇩🇯','dominican':'🇩🇴','dutch':'🇳🇱','ecuadorian':'🇪🇨',
  'egyptian':'🇪🇬','emirati':'🇦🇪','english':'🏴󠁧󠁢󠁥󠁮󠁧󠁿','eritrean':'🇪🇷','estonian':'🇪🇪',
  'ethiopian':'🇪🇹','fijian':'🇫🇯','filipino':'🇵🇭','finnish':'🇫🇮','french':'🇫🇷',
  'gabonese':'🇬🇦','gambian':'🇬🇲','georgian':'🇬🇪','german':'🇩🇪','ghanaian':'🇬🇭',
  'greek':'🇬🇷','grenadian':'🇬🇩','guatemalan':'🇬🇹','guinean':'🇬🇳','guyanese':'🇬🇾',
  'haitian':'🇭🇹','honduran':'🇭🇳','hungarian':'🇭🇺','icelandic':'🇮🇸','indian':'🇮🇳',
  'indonesian':'🇮🇩','iranian':'🇮🇷','iraqi':'🇮🇶','irish':'🇮🇪','israeli':'🇮🇱',
  'italian':'🇮🇹','ivorian':'🇨🇮','jamaican':'🇯🇲','japanese':'🇯🇵','jordanian':'🇯🇴',
  'kazakh':'🇰🇿','kenyan':'🇰🇪','korean':'🇰🇷','south korean':'🇰🇷','north korean':'🇰🇵',
  'kuwaiti':'🇰🇼','kyrgyz':'🇰🇬','lao':'🇱🇦','latvian':'🇱🇻','lebanese':'🇱🇧',
  'liberian':'🇱🇷','libyan':'🇱🇾','lithuanian':'🇱🇹','luxembourgish':'🇱🇺','macedonian':'🇲🇰',
  'malagasy':'🇲🇬','malawian':'🇲🇼','malaysian':'🇲🇾','maldivian':'🇲🇻','malian':'🇲🇱',
  'maltese':'🇲🇹','mauritanian':'🇲🇷','mauritian':'🇲🇺','mexican':'🇲🇽','moldovan':'🇲🇩',
  'mongolian':'🇲🇳','montenegrin':'🇲🇪','moroccan':'🇲🇦','mozambican':'🇲🇿','namibian':'🇳🇦',
  'nepalese':'🇳🇵','nepali':'🇳🇵','new zealander':'🇳🇿','kiwi':'🇳🇿','nicaraguan':'🇳🇮',
  'nigerien':'🇳🇪','nigerian':'🇳🇬','norwegian':'🇳🇴','omani':'🇴🇲','pakistani':'🇵🇰',
  'palestinian':'🇵🇸','panamanian':'🇵🇦','paraguayan':'🇵🇾','peruvian':'🇵🇪','polish':'🇵🇱',
  'portuguese':'🇵🇹','puerto rican':'🇵🇷','qatari':'🇶🇦','romanian':'🇷🇴','russian':'🇷🇺',
  'rwandan':'🇷🇼','salvadoran':'🇸🇻','saudi':'🇸🇦','scottish':'🏴󠁧󠁢󠁳󠁣󠁴󠁿','senegalese':'🇸🇳',
  'serbian':'🇷🇸','singaporean':'🇸🇬','slovak':'🇸🇰','slovenian':'🇸🇮','somali':'🇸🇴',
  'south african':'🇿🇦','spanish':'🇪🇸','sri lankan':'🇱🇰','sudanese':'🇸🇩','surinamese':'🇸🇷',
  'swedish':'🇸🇪','swiss':'🇨🇭','syrian':'🇸🇾','taiwanese':'🇹🇼','tajik':'🇹🇯',
  'tanzanian':'🇹🇿','thai':'🇹🇭','togolese':'🇹🇬','trinidadian':'🇹🇹','tunisian':'🇹🇳',
  'turkish':'🇹🇷','turkmen':'🇹🇲','ugandan':'🇺🇬','ukrainian':'🇺🇦','uruguayan':'🇺🇾',
  'uzbek':'🇺🇿','venezuelan':'🇻🇪','vietnamese':'🇻🇳','welsh':'🏴󠁧󠁢󠁷󠁬󠁳󠁿','yemeni':'🇾🇪',
  'zambian':'🇿🇲','zimbabwean':'🇿🇼',
  // Country names
  'usa':'🇺🇸','us':'🇺🇸','united states':'🇺🇸','uk':'🇬🇧','united kingdom':'🇬🇧',
  'brazil':'🇧🇷','mexico':'🇲🇽','canada':'🇨🇦','france':'🇫🇷','germany':'🇩🇪',
  'italy':'🇮🇹','spain':'🇪🇸','portugal':'🇵🇹','japan':'🇯🇵','china':'🇨🇳',
  'india':'🇮🇳','australia':'🇦🇺','argentina':'🇦🇷','colombia':'🇨🇴','chile':'🇨🇱',
  'peru':'🇵🇪','nigeria':'🇳🇬','south africa':'🇿🇦','egypt':'🇪🇬','kenya':'🇰🇪',
  'israel':'🇮🇱','turkey':'🇹🇷','russia':'🇷🇺','ukraine':'🇺🇦','poland':'🇵🇱',
  'netherlands':'🇳🇱','sweden':'🇸🇪','norway':'🇳🇴','denmark':'🇩🇰','finland':'🇫🇮',
  'ireland':'🇮🇪','scotland':'🏴󠁧󠁢󠁳󠁣󠁴󠁿','england':'🏴󠁧󠁢󠁥󠁮󠁧󠁿','wales':'🏴󠁧󠁢󠁷󠁬󠁳󠁿',
  'switzerland':'🇨🇭','austria':'🇦🇹','belgium':'🇧🇪','greece':'🇬🇷','czech republic':'🇨🇿',
  'czechia':'🇨🇿','hungary':'🇭🇺','romania':'🇷🇴','croatia':'🇭🇷','serbia':'🇷🇸',
  'thailand':'🇹🇭','vietnam':'🇻🇳','philippines':'🇵🇭','indonesia':'🇮🇩','malaysia':'🇲🇾',
  'singapore':'🇸🇬','south korea':'🇰🇷','korea':'🇰🇷','taiwan':'🇹🇼','pakistan':'🇵🇰',
  'bangladesh':'🇧🇩','nepal':'🇳🇵','sri lanka':'🇱🇰','iran':'🇮🇷','iraq':'🇮🇶',
  'saudi arabia':'🇸🇦','uae':'🇦🇪','qatar':'🇶🇦','kuwait':'🇰🇼','jordan':'🇯🇴',
  'lebanon':'🇱🇧','morocco':'🇲🇦','tunisia':'🇹🇳','ghana':'🇬🇭','ethiopia':'🇪🇹',
  'tanzania':'🇹🇿','cuba':'🇨🇺','jamaica':'🇯🇲','puerto rico':'🇵🇷','haiti':'🇭🇹',
  'new zealand':'🇳🇿','iceland':'🇮🇸','luxembourg':'🇱🇺',
};

// Location-based flag mapping (city/state → country flag)
const LOCATION_FLAGS = {
  // US states & cities
  'tx':'🇺🇸','texas':'🇺🇸','austin':'🇺🇸','houston':'🇺🇸','dallas':'🇺🇸','san antonio':'🇺🇸',
  'ca':'🇺🇸','california':'🇺🇸','los angeles':'🇺🇸','san francisco':'🇺🇸','san diego':'🇺🇸',
  'ny':'🇺🇸','new york':'🇺🇸','nyc':'🇺🇸','brooklyn':'🇺🇸','manhattan':'🇺🇸',
  'fl':'🇺🇸','florida':'🇺🇸','miami':'🇺🇸','orlando':'🇺🇸','tampa':'🇺🇸',
  'il':'🇺🇸','illinois':'🇺🇸','chicago':'🇺🇸',
  'wa':'🇺🇸','washington':'🇺🇸','seattle':'🇺🇸',
  'co':'🇺🇸','colorado':'🇺🇸','denver':'🇺🇸','boulder':'🇺🇸',
  'ma':'🇺🇸','massachusetts':'🇺🇸','boston':'🇺🇸',
  'ga':'🇺🇸','georgia':'🇺🇸','atlanta':'🇺🇸',
  'pa':'🇺🇸','pennsylvania':'🇺🇸','philadelphia':'🇺🇸','pittsburgh':'🇺🇸',
  'az':'🇺🇸','arizona':'🇺🇸','phoenix':'🇺🇸','scottsdale':'🇺🇸',
  'nc':'🇺🇸','north carolina':'🇺🇸','charlotte':'🇺🇸','raleigh':'🇺🇸',
  'oh':'🇺🇸','ohio':'🇺🇸','columbus':'🇺🇸','cleveland':'🇺🇸',
  'or':'🇺🇸','oregon':'🇺🇸','portland':'🇺🇸',
  'nv':'🇺🇸','nevada':'🇺🇸','las vegas':'🇺🇸',
  'tn':'🇺🇸','tennessee':'🇺🇸','nashville':'🇺🇸','memphis':'🇺🇸',
  'mi':'🇺🇸','michigan':'🇺🇸','detroit':'🇺🇸',
  'mn':'🇺🇸','minnesota':'🇺🇸','minneapolis':'🇺🇸',
  'hi':'🇺🇸','hawaii':'🇺🇸','honolulu':'🇺🇸',
  'cedar creek':'🇺🇸',
  // International cities
  'london':'🇬🇧','manchester':'🇬🇧','birmingham':'🇬🇧','edinburgh':'🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  'paris':'🇫🇷','lyon':'🇫🇷','marseille':'🇫🇷',
  'berlin':'🇩🇪','munich':'🇩🇪','hamburg':'🇩🇪','frankfurt':'🇩🇪',
  'rome':'🇮🇹','milan':'🇮🇹','florence':'🇮🇹','naples':'🇮🇹',
  'madrid':'🇪🇸','barcelona':'🇪🇸','seville':'🇪🇸',
  'lisbon':'🇵🇹','porto':'🇵🇹',
  'amsterdam':'🇳🇱','rotterdam':'🇳🇱',
  'tokyo':'🇯🇵','osaka':'🇯🇵','kyoto':'🇯🇵',
  'beijing':'🇨🇳','shanghai':'🇨🇳','shenzhen':'🇨🇳',
  'mumbai':'🇮🇳','delhi':'🇮🇳','bangalore':'🇮🇳','bengaluru':'🇮🇳',
  'sydney':'🇦🇺','melbourne':'🇦🇺','brisbane':'🇦🇺',
  'toronto':'🇨🇦','vancouver':'🇨🇦','montreal':'🇨🇦',
  'mexico city':'🇲🇽','guadalajara':'🇲🇽','cancun':'🇲🇽',
  'são paulo':'🇧🇷','sao paulo':'🇧🇷','rio de janeiro':'🇧🇷','rio':'🇧🇷',
  'buenos aires':'🇦🇷','bogota':'🇨🇴','bogotá':'🇨🇴','medellín':'🇨🇴','medellin':'🇨🇴',
  'lima':'🇵🇪','santiago':'🇨🇱',
  'seoul':'🇰🇷','bangkok':'🇹🇭','singapore':'🇸🇬','hong kong':'🇭🇰',
  'taipei':'🇹🇼','kuala lumpur':'🇲🇾','jakarta':'🇮🇩','manila':'🇵🇭',
  'dubai':'🇦🇪','abu dhabi':'🇦🇪','tel aviv':'🇮🇱','jerusalem':'🇮🇱',
  'istanbul':'🇹🇷','cairo':'🇪🇬','nairobi':'🇰🇪','cape town':'🇿🇦',
  'johannesburg':'🇿🇦','lagos':'🇳🇬','accra':'🇬🇭',
  'stockholm':'🇸🇪','oslo':'🇳🇴','copenhagen':'🇩🇰','helsinki':'🇫🇮',
  'dublin':'🇮🇪','zurich':'🇨🇭','geneva':'🇨🇭','vienna':'🇦🇹',
  'brussels':'🇧🇪','prague':'🇨🇿','budapest':'🇭🇺','warsaw':'🇵🇱',
  'bucharest':'🇷🇴','athens':'🇬🇷','zagreb':'🇭🇷','belgrade':'🇷🇸',
  'havana':'🇨🇺','kingston':'🇯🇲','auckland':'🇳🇿','reykjavik':'🇮🇸',
};

function getFlagForNationality(text) {
  if (!text) return '🏳️';
  const lower = text.trim().toLowerCase();
  // Try exact match first, then first word
  return COUNTRY_FLAGS[lower] || COUNTRY_FLAGS[lower.split(/[,\/]/)[0].trim()] || '🏳️';
}

function getFlagForLocation(text) {
  if (!text) return '📍';
  const lower = text.trim().toLowerCase();
  // Try full text, then each comma-separated part, then individual words
  if (LOCATION_FLAGS[lower]) return LOCATION_FLAGS[lower];
  if (COUNTRY_FLAGS[lower]) return COUNTRY_FLAGS[lower];
  const parts = lower.split(',').map(s => s.trim());
  for (const part of parts) {
    if (LOCATION_FLAGS[part]) return LOCATION_FLAGS[part];
    if (COUNTRY_FLAGS[part]) return COUNTRY_FLAGS[part];
  }
  // Try individual words (for "Austin, TX" → "austin" or "tx")
  for (const part of parts) {
    const words = part.split(/\s+/);
    for (const w of words) {
      if (LOCATION_FLAGS[w]) return LOCATION_FLAGS[w];
      if (COUNTRY_FLAGS[w]) return COUNTRY_FLAGS[w];
    }
  }
  return '📍';
}

function updateNationalityFlag() {
  const val = document.getElementById('fieldNationality').value;
  document.getElementById('nationalityFlag').textContent = getFlagForNationality(val);
}

function updateLocationFlag() {
  const val = document.getElementById('fieldLocationBase').value;
  document.getElementById('locationFlag').textContent = getFlagForLocation(val);
}

// =============================================
// DIETARY PREFERENCES
// =============================================

function collectDietaryPreferences() {
  const selected = [];
  document.querySelectorAll('#dietaryOptions input[type="checkbox"]:checked').forEach(cb => {
    selected.push(cb.value);
  });
  const custom = document.getElementById('fieldDietaryCustom').value.trim();
  if (!selected.length && !custom) return null;
  return { selected, custom: custom || null };
}

function collectAllergies() {
  const selected = [];
  document.querySelectorAll('#allergyOptions input[type="checkbox"]:checked').forEach(cb => {
    selected.push(cb.value);
  });
  const custom = document.getElementById('fieldAllergyCustom').value.trim();
  if (!selected.length && !custom) return null;
  return { selected, custom: custom || null };
}

// =============================================
// DIRTY TRACKING
// =============================================

function getFormSnapshot() {
  return JSON.stringify({
    first_name: document.getElementById('fieldFirstName').value.trim(),
    last_name: document.getElementById('fieldLastName').value.trim(),
    display_name: document.getElementById('fieldDisplayName').value.trim(),
    contact_email_same: document.getElementById('contactEmailSameAsLogin').checked,
    contact_email: document.getElementById('fieldContactEmail').value.trim(),
    gender: document.getElementById('fieldGender').value,
    bio: document.getElementById('fieldBio').value.trim(),
    nationality: document.getElementById('fieldNationality').value.trim(),
    location_base: document.getElementById('fieldLocationBase').value.trim(),
    birthday: document.getElementById('fieldBirthday').value,
    phone: document.getElementById('fieldPhone').value.trim(),
    phone2: document.getElementById('fieldPhone2').value.trim(),
    whatsapp: document.getElementById('fieldWhatsApp').value.trim(),
    instagram: document.getElementById('fieldInstagram').value.trim().replace(/^@/, ''),
    telegram: document.getElementById('fieldTelegram').value.trim().replace(/^@/, ''),
    facebook: document.getElementById('fieldFacebook').value.trim(),
    dietary: JSON.stringify(collectDietaryPreferences()),
    allergies: JSON.stringify(collectAllergies()),
    links: collectLinks(),
    privacy: collectPrivacySettings(),
  });
}

function updateSaveButton() {
  const btn = document.getElementById('saveProfileBtn');
  const dirty = getFormSnapshot() !== savedSnapshot;
  btn.disabled = !dirty;
}

// =============================================
// EVENT BINDINGS
// =============================================

function bindEvents() {
  // Avatar upload
  document.getElementById('avatarEditBtn').addEventListener('click', () => {
    document.getElementById('avatarInput').click();
  });
  document.getElementById('profileAvatar').addEventListener('click', () => {
    document.getElementById('avatarInput').click();
  });
  document.getElementById('avatarInput').addEventListener('change', (e) => {
    if (e.target.files[0]) handleAvatarUpload(e.target.files[0]);
  });

  // Save
  document.getElementById('saveProfileBtn').addEventListener('click', saveProfile);

  // Personal URL
  document.getElementById('copyUrlBtn')?.addEventListener('click', () => {
    const slug = profileData.slug;
    if (slug) {
      navigator.clipboard.writeText(`https://YOUR_DOMAIN/${slug}`);
      showToast('URL copied!', 'success');
    }
  });
  document.getElementById('slugInput')?.addEventListener('input', () => {
    const input = document.getElementById('slugInput');
    const saveBtn = document.getElementById('saveSlugBtn');
    const errorEl = document.getElementById('slugError');
    errorEl.style.display = 'none';
    saveBtn.disabled = input.value.trim().toLowerCase() === (input.dataset.original || '');
  });
  document.getElementById('saveSlugBtn')?.addEventListener('click', saveSlug);

  // Contact email checkbox toggle
  document.getElementById('contactEmailSameAsLogin').addEventListener('change', (e) => {
    const emailInput = document.getElementById('fieldContactEmail');
    emailInput.style.display = e.target.checked ? 'none' : '';
    if (!e.target.checked) emailInput.focus();
    updateSaveButton();
  });

  // Add link
  document.getElementById('addLinkBtn').addEventListener('click', () => {
    const links = collectLinks();
    links.push({ label: '', url: '' });
    renderLinks(links);
    updateSaveButton();
  });

  // Bio character counter
  document.getElementById('fieldBio').addEventListener('input', updateBioCount);

  // Flag updates on typing
  document.getElementById('fieldNationality').addEventListener('input', updateNationalityFlag);
  document.getElementById('fieldLocationBase').addEventListener('input', updateLocationFlag);

  // Dirty tracking on all form fields
  const textFields = ['fieldFirstName', 'fieldLastName', 'fieldDisplayName', 'fieldContactEmail', 'fieldBio', 'fieldNationality',
    'fieldLocationBase', 'fieldPhone', 'fieldPhone2', 'fieldWhatsApp', 'fieldInstagram', 'fieldTelegram', 'fieldFacebook'];
  textFields.forEach(id => {
    document.getElementById(id).addEventListener('input', updateSaveButton);
  });
  document.getElementById('fieldBirthday').addEventListener('change', updateSaveButton);
  document.getElementById('fieldGender').addEventListener('change', updateSaveButton);
  document.getElementById('fieldDietaryCustom').addEventListener('input', updateSaveButton);
  document.querySelectorAll('#dietaryOptions input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', updateSaveButton);
  });
  document.getElementById('fieldAllergyCustom').addEventListener('input', updateSaveButton);
  document.querySelectorAll('#allergyOptions input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', updateSaveButton);
  });

  // Links container — listen for input on dynamically added link fields
  document.getElementById('linksContainer').addEventListener('input', updateSaveButton);

  // Privacy dropdowns — Facebook-style icon menus
  initPrivacyDropdowns();

  // Vehicle section events (delegated)
  document.getElementById('vehiclesSection').addEventListener('click', (e) => {
    // Expand/collapse card
    const header = e.target.closest('.profile-vehicle-header');
    if (header && !e.target.closest('button')) {
      const card = header.closest('.profile-vehicle-card');
      card.toggleAttribute('open');
      return;
    }

    // Edit vehicle
    const editBtn = e.target.closest('.vehicle-edit-btn');
    if (editBtn) {
      const vid = parseInt(editBtn.dataset.vehicleId);
      const v = ownedVehicles.find(v => v.id === vid);
      if (v) showVehicleForm(v);
      return;
    }

    // Remove vehicle
    const removeBtn = e.target.closest('.vehicle-remove-btn');
    if (removeBtn) {
      removeVehicle(parseInt(removeBtn.dataset.vehicleId));
      return;
    }

    // Add driver button
    const addDriverBtn = e.target.closest('.vehicle-add-driver-btn');
    if (addDriverBtn) {
      showAddDriverDropdown(parseInt(addDriverBtn.dataset.vehicleId));
      return;
    }

    // Driver result (add)
    const driverResult = e.target.closest('.vehicle-driver-result');
    if (driverResult) {
      addDriver(parseInt(driverResult.dataset.vehicleId), driverResult.dataset.userId);
      return;
    }

    // Remove driver
    const removeDriverBtn = e.target.closest('.vehicle-driver-remove');
    if (removeDriverBtn) {
      removeDriver(parseInt(removeDriverBtn.dataset.vehicleId), removeDriverBtn.dataset.driverUserId);
      return;
    }
  });

  // Add vehicle button
  document.getElementById('addVehicleBtn').addEventListener('click', () => {
    if (ownedVehicles.length >= vehicleLimit) {
      showToast('Vehicle limit reached. Contact admin for more slots.', 'error');
      return;
    }
    showVehicleForm(null);
  });
}

// =============================================
// ID VERIFICATION
// =============================================

async function renderIdVerification() {
  const container = document.getElementById('idVerificationContent');
  if (!container) return;

  // Check if user has an associate profile with verification status
  const { data: assocProfile } = await supabase
    .from('associate_profiles')
    .select('identity_verification_status, identity_verification_id')
    .eq('app_user_id', currentUser.id)
    .maybeSingle();

  const status = assocProfile?.identity_verification_status || null;

  // Also check for any verification records directly linked to this user
  const { data: verification } = await supabase
    .from('identity_verifications')
    .select('id, verification_status, extracted_name, verified_at, created_at')
    .eq('app_user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const effectiveStatus = status || (verification ? verification.verification_status : null);

  if (effectiveStatus === 'verified' || effectiveStatus === 'auto_approved' || effectiveStatus === 'manually_approved') {
    const verifiedDate = verification?.verified_at || verification?.created_at;
    const dateStr = verifiedDate ? new Date(verifiedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;">
        <span style="font-size:1.5rem;">&#9989;</span>
        <div>
          <p style="margin:0;font-weight:600;color:#065f46;">Identity Verified</p>
          <p style="margin:0.15rem 0 0;font-size:0.8rem;color:var(--text-muted);">Your ID has been verified.${dateStr ? ' Verified on ' + dateStr + '.' : ''}</p>
        </div>
      </div>`;
    return;
  }

  if (effectiveStatus === 'link_sent') {
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;">
        <span style="font-size:1.5rem;">&#9203;</span>
        <div>
          <p style="margin:0;font-weight:600;color:#0c4a6e;">Verification Link Sent</p>
          <p style="margin:0.15rem 0 0;font-size:0.8rem;color:var(--text-muted);">A verification link was sent. You can complete it now or request a new one.</p>
          <button class="btn-small btn-primary" id="btnProfileVerifyId" style="margin-top:0.5rem;">Verify My ID</button>
        </div>
      </div>`;
    document.getElementById('btnProfileVerifyId')?.addEventListener('click', handleProfileVerify);
    return;
  }

  if (effectiveStatus === 'flagged') {
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;">
        <span style="font-size:1.5rem;">&#128269;</span>
        <div>
          <p style="margin:0;font-weight:600;color:#92400e;">Under Review</p>
          <p style="margin:0.15rem 0 0;font-size:0.8rem;color:var(--text-muted);">Your ID is being reviewed by our team. We'll update you shortly.</p>
        </div>
      </div>`;
    return;
  }

  if (effectiveStatus === 'rejected' || effectiveStatus === 'manually_rejected') {
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;">
        <span style="font-size:1.5rem;">&#10060;</span>
        <div>
          <p style="margin:0;font-weight:600;color:#991b1b;">Verification Issue</p>
          <p style="margin:0.15rem 0 0;font-size:0.8rem;color:var(--text-muted);">There was an issue with your previous submission. Please try again with a clear photo of your ID.</p>
          <button class="btn-small btn-primary" id="btnProfileVerifyId" style="margin-top:0.5rem;">Upload New ID</button>
        </div>
      </div>`;
    document.getElementById('btnProfileVerifyId')?.addEventListener('click', handleProfileVerify);
    return;
  }

  // Default: pending / not started
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;">
      <span style="font-size:1.5rem;">&#128196;</span>
      <div>
        <p style="margin:0;font-weight:600;color:var(--text);">Verify Your Identity</p>
        <p style="margin:0.15rem 0 0;font-size:0.8rem;color:var(--text-muted);">Upload your driver's license or state ID to verify your identity.</p>
        <button class="btn-small btn-primary" id="btnProfileVerifyId" style="margin-top:0.5rem;">Verify My ID</button>
      </div>
    </div>`;
  document.getElementById('btnProfileVerifyId')?.addEventListener('click', handleProfileVerify);
}

async function handleProfileVerify() {
  const btn = document.getElementById('btnProfileVerifyId');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating link...'; }
  try {
    const { uploadUrl } = await identityService.requestAssociateVerification(currentUser.id, 'self');
    window.location.href = uploadUrl;
  } catch (err) {
    showToast('Failed to start verification: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Verify My ID'; }
  }
}

// =============================================
// VEHICLES
// =============================================

function renderVehicles() {
  const container = document.getElementById('vehiclesContainer');
  const addBtn = document.getElementById('addVehicleBtn');

  // Show/hide add button based on limit
  const atLimit = ownedVehicles.length >= vehicleLimit;
  addBtn.style.display = atLimit ? 'none' : '';

  if (!userVehicles.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No vehicles registered yet.</p>';
    return;
  }

  container.innerHTML = userVehicles.map(v => {
    const make = v.vehicle_make || '';
    const model = v.vehicle_model || '';
    const year = v.year || '';
    const color = v.color || '';
    const vin = v.vin || '';
    const colorHex = v.color_hex || '#ccc';
    const plate = v.license_plate || '';
    const length = v.vehicle_length_ft || '';
    const subtitle = [year, make, model].filter(Boolean).join(' ');
    const isOwner = v.relationship === 'Owner';
    const isTesla = (make || '').toLowerCase() === 'tesla';
    const hasTeslaAccount = !!v.account_id;

    // Driver list (only for owned Tesla vehicles)
    let driversHtml = '';
    if (isOwner && isTesla && hasTeslaAccount) {
      const drivers = (v.drivers || []).map(d => d.app_user).filter(Boolean);
      const driverChips = drivers.map(d => `
        <span class="vehicle-driver-chip">
          ${escapeAttr(d.display_name || d.email)}
          <button class="vehicle-driver-remove" data-vehicle-id="${v.id}" data-driver-user-id="${d.id}" title="Remove driver">&times;</button>
        </span>
      `).join('');
      driversHtml = `
        <div class="vehicle-driver-section">
          <span class="profile-vehicle-detail-label">Drivers</span>
          <div class="vehicle-driver-list">
            ${driverChips || '<span style="color:var(--text-muted);font-size:0.8rem">No drivers added</span>'}
            <button class="vehicle-add-driver-btn" data-vehicle-id="${v.id}" title="Add driver">+ Add Driver</button>
          </div>
          <div class="vehicle-add-driver-dropdown" id="addDriverDropdown_${v.id}" style="display:none"></div>
        </div>
      `;
    }

    // Actions (only for owned vehicles)
    let actionsHtml = '';
    if (isOwner) {
      actionsHtml = `
        <div class="vehicle-profile-actions">
          <button class="btn-small vehicle-edit-btn" data-vehicle-id="${v.id}">Edit</button>
          <button class="btn-small vehicle-remove-btn" data-vehicle-id="${v.id}" style="color:var(--occupied,#e74c3c)">Remove</button>
        </div>
      `;
    }

    // Tesla badge
    const teslaBadge = isTesla && hasTeslaAccount
      ? '<span class="vehicle-tesla-badge"><span class="vehicle-tesla-dot"></span>Tesla Connected</span>'
      : '';

    return `
      <div class="profile-vehicle-card" data-vehicle-id="${v.id}">
        <div class="profile-vehicle-header">
          <span class="profile-vehicle-color" style="background:${escapeAttr(colorHex)}"></span>
          <div class="profile-vehicle-header-text">
            <span class="profile-vehicle-name">${escapeAttr(v.name)}</span>
            <span class="profile-vehicle-role">${escapeAttr(v.relationship)}</span>
          </div>
          <span class="profile-vehicle-chevron">&#9654;</span>
        </div>
        <div class="profile-vehicle-summary">${escapeAttr(subtitle)}${color ? ' \u00b7 ' + escapeAttr(color) : ''}${plate ? ' \u00b7 ' + escapeAttr(plate) : ''}</div>
        <div class="profile-vehicle-details">
          ${teslaBadge}
          <div class="profile-vehicle-grid">
            <div class="profile-vehicle-detail">
              <span class="profile-vehicle-detail-label">Make</span>
              <span class="profile-vehicle-detail-value">${escapeAttr(make) || '\u2014'}</span>
            </div>
            <div class="profile-vehicle-detail">
              <span class="profile-vehicle-detail-label">Model</span>
              <span class="profile-vehicle-detail-value">${escapeAttr(model) || '\u2014'}</span>
            </div>
            <div class="profile-vehicle-detail">
              <span class="profile-vehicle-detail-label">Year</span>
              <span class="profile-vehicle-detail-value">${year || '\u2014'}</span>
            </div>
            <div class="profile-vehicle-detail">
              <span class="profile-vehicle-detail-label">Color</span>
              <span class="profile-vehicle-detail-value">${escapeAttr(color) || '\u2014'}</span>
            </div>
            ${plate ? `<div class="profile-vehicle-detail">
              <span class="profile-vehicle-detail-label">Plate</span>
              <span class="profile-vehicle-detail-value">${escapeAttr(plate)}</span>
            </div>` : ''}
            ${length ? `<div class="profile-vehicle-detail">
              <span class="profile-vehicle-detail-label">Length</span>
              <span class="profile-vehicle-detail-value">${length} ft</span>
            </div>` : ''}
            ${vin ? `<div class="profile-vehicle-detail" style="grid-column:1/-1">
              <span class="profile-vehicle-detail-label">VIN</span>
              <span class="profile-vehicle-detail-value" style="font-family:monospace;font-size:0.8rem">${escapeAttr(vin)}</span>
            </div>` : ''}
          </div>
          ${driversHtml}
          ${actionsHtml}
        </div>
      </div>
    `;
  }).join('');
}

// =============================================
// VEHICLE FORM (Add / Edit)
// =============================================

function showVehicleForm(vehicleData) {
  editingVehicleId = vehicleData?.id || null;
  const isEdit = !!editingVehicleId;
  const formContainer = document.getElementById('vehicleFormContainer');
  const addBtn = document.getElementById('addVehicleBtn');
  addBtn.style.display = 'none';

  const isTesla = (vehicleData?.vehicle_make || '').toLowerCase() === 'tesla';
  const hasTeslaAccount = !!vehicleData?.account_id || !!connectedTeslaAccountId;

  formContainer.style.display = '';
  formContainer.innerHTML = `
    <div class="vehicle-form">
      <h3 style="margin:0 0 0.75rem">${isEdit ? 'Edit Vehicle' : 'Add Vehicle'}</h3>
      <div class="profile-field">
        <label for="vfName">Vehicle Name <span style="color:var(--occupied)">&ast;</span></label>
        <input type="text" id="vfName" placeholder="e.g. Casper, My Car" maxlength="50" value="${escapeAttr(vehicleData?.name || '')}">
      </div>
      <div class="profile-field">
        <label for="vfMake">Make <span style="color:var(--occupied)">&ast;</span></label>
        <input type="text" id="vfMake" placeholder="e.g. Tesla, Honda, Ford" maxlength="50" value="${escapeAttr(vehicleData?.vehicle_make || '')}">
      </div>
      <div class="profile-field">
        <label for="vfModel">Model <span style="color:var(--occupied)">&ast;</span></label>
        <input type="text" id="vfModel" placeholder="e.g. Model 3, Civic" maxlength="50" value="${escapeAttr(vehicleData?.vehicle_model || '')}">
      </div>
      <div class="profile-field">
        <label for="vfColor">Color <span style="color:var(--occupied)">&ast;</span></label>
        <div style="display:flex;gap:0.5rem;align-items:center">
          <input type="text" id="vfColor" placeholder="e.g. White, Black, Blue" maxlength="30" value="${escapeAttr(vehicleData?.color || '')}" style="flex:1">
          <input type="color" id="vfColorHex" value="${vehicleData?.color_hex || '#999999'}" style="width:36px;height:36px;padding:2px;border:1px solid var(--border);border-radius:6px;cursor:pointer">
        </div>
      </div>
      <div class="profile-field">
        <label for="vfYear">Year</label>
        <input type="number" id="vfYear" placeholder="e.g. 2024" min="1900" max="2030" value="${vehicleData?.year || ''}">
      </div>
      <div class="profile-field">
        <label for="vfPlate">License Plate</label>
        <input type="text" id="vfPlate" placeholder="e.g. ABC-1234" maxlength="20" value="${escapeAttr(vehicleData?.license_plate || '')}">
      </div>
      <div class="profile-field">
        <label for="vfLength">Length (ft)</label>
        <input type="number" id="vfLength" placeholder="For RVs, trailers, etc." min="1" max="100" step="0.5" value="${vehicleData?.vehicle_length_ft || ''}">
      </div>

      <!-- Tesla Connection Section (shown when make = Tesla) -->
      <div class="vehicle-tesla-section" id="vfTeslaSection" style="display:${isTesla ? '' : 'none'}">
        <div class="vehicle-tesla-connect-box" id="vfTeslaBox">
          ${hasTeslaAccount
            ? '<div class="vehicle-tesla-badge"><span class="vehicle-tesla-dot"></span>Tesla Account Connected</div>'
            : '<p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 0.5rem">Connect your Tesla account to enable live vehicle data, lock/unlock, and charging management.</p><button type="button" class="btn-primary" id="vfConnectTeslaBtn">Connect Tesla Account</button>'
          }
        </div>
      </div>

      <div class="profile-actions" style="gap:0.5rem">
        <button class="btn-primary" id="vfSaveBtn">${isEdit ? 'Save Changes' : 'Add Vehicle'}</button>
        <button class="btn-secondary" id="vfCancelBtn">Cancel</button>
      </div>
    </div>
  `;

  // Bind Make field to show/hide Tesla section
  document.getElementById('vfMake').addEventListener('input', (e) => {
    const teslaSection = document.getElementById('vfTeslaSection');
    teslaSection.style.display = e.target.value.trim().toLowerCase() === 'tesla' ? '' : 'none';
  });

  // Bind Tesla connect button
  const connectBtn = document.getElementById('vfConnectTeslaBtn');
  if (connectBtn) {
    connectBtn.addEventListener('click', startTeslaOAuth);
  }

  // Bind save/cancel
  document.getElementById('vfSaveBtn').addEventListener('click', saveVehicle);
  document.getElementById('vfCancelBtn').addEventListener('click', hideVehicleForm);

  // Scroll form into view
  formContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideVehicleForm() {
  const formContainer = document.getElementById('vehicleFormContainer');
  formContainer.style.display = 'none';
  formContainer.innerHTML = '';
  editingVehicleId = null;
  connectedTeslaAccountId = null;
  localStorage.removeItem('vehicle-profile-draft');

  // Show add button again if under limit
  const addBtn = document.getElementById('addVehicleBtn');
  addBtn.style.display = ownedVehicles.length >= vehicleLimit ? 'none' : '';
}

async function saveVehicle() {
  const name = document.getElementById('vfName').value.trim();
  const make = document.getElementById('vfMake').value.trim();
  const model = document.getElementById('vfModel').value.trim();
  const color = document.getElementById('vfColor').value.trim();

  if (!name || !make || !model || !color) {
    showToast('Name, Make, Model, and Color are required', 'error');
    return;
  }

  const btn = document.getElementById('vfSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const vehicleData = {
      name,
      vehicle_make: make,
      vehicle_model: model,
      color,
      color_hex: document.getElementById('vfColorHex').value,
      year: parseInt(document.getElementById('vfYear').value) || null,
      license_plate: document.getElementById('vfPlate').value.trim() || null,
      vehicle_length_ft: parseFloat(document.getElementById('vfLength').value) || null,
    };

    if (editingVehicleId) {
      // Update existing
      const { error } = await supabase
        .from('vehicles')
        .update(vehicleData)
        .eq('id', editingVehicleId);
      if (error) throw error;
      showToast('Vehicle updated', 'success');
    } else {
      // Insert new
      vehicleData.owner_id = currentUser.id;
      vehicleData.is_active = true;

      // Link Tesla account if connected
      if (connectedTeslaAccountId && make.toLowerCase() === 'tesla') {
        vehicleData.account_id = connectedTeslaAccountId;
      }

      const { error } = await supabase
        .from('vehicles')
        .insert(vehicleData);
      if (error) {
        if (error.message.includes('policy')) {
          showToast('Vehicle limit reached. Contact admin for more slots.', 'error');
        } else {
          throw error;
        }
        return;
      }
      showToast('Vehicle added', 'success');
    }

    hideVehicleForm();
    await reloadVehicles();
  } catch (err) {
    console.error('Save vehicle failed:', err);
    showToast('Failed to save vehicle: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = editingVehicleId ? 'Save Changes' : 'Add Vehicle';
  }
}

async function removeVehicle(vehicleId) {
  if (!confirm('Remove this vehicle from your profile?')) return;

  try {
    const { error } = await supabase
      .from('vehicles')
      .update({ is_active: false })
      .eq('id', vehicleId);
    if (error) throw error;
    showToast('Vehicle removed', 'success');
    await reloadVehicles();
  } catch (err) {
    showToast('Failed to remove vehicle: ' + err.message, 'error');
  }
}

async function reloadVehicles() {
  const [ownedRes, driverRes] = await Promise.all([
    supabase
      .from('vehicles')
      .select('id, name, vehicle_make, vehicle_model, year, color, color_hex, vin, image_url, license_plate, vehicle_length_ft, account_id, drivers:vehicle_drivers(id, app_user:app_user_id(id, display_name, email))')
      .eq('owner_id', currentUser.id)
      .eq('is_active', true)
      .order('display_order'),
    supabase
      .from('vehicle_drivers')
      .select('vehicle_id, vehicles:vehicle_id(id, name, vehicle_make, vehicle_model, year, color, color_hex, vin, image_url, license_plate, vehicle_length_ft, account_id)')
      .eq('app_user_id', currentUser.id),
  ]);

  ownedVehicles = (ownedRes.data || []).map(v => ({ ...v, relationship: 'Owner' }));
  const driven = (driverRes.data || [])
    .map(d => d.vehicles)
    .filter(Boolean)
    .map(v => ({ ...v, relationship: 'Driver' }));
  const seen = new Set();
  userVehicles = [];
  for (const v of [...ownedVehicles, ...driven]) {
    if (!seen.has(v.id)) {
      seen.add(v.id);
      userVehicles.push(v);
    }
  }

  renderVehicles();
}

// =============================================
// TESLA OAUTH (from profile)
// =============================================

async function startTeslaOAuth() {
  const btn = document.getElementById('vfConnectTeslaBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting...'; }

  try {
    // Save form draft to localStorage
    saveVehicleDraft();

    // Create a tesla_accounts row for this user
    const { data: account, error } = await supabase
      .from('tesla_accounts')
      .insert({
        owner_name: currentUser.display_name || currentUser.email,
        tesla_email: currentUser.email,
        app_user_id: currentUser.id,
        fleet_client_id: '3f53a292-07b8-443f-b86d-e4aedc37ac10',
        fleet_client_secret: 'ta-secret.TUwH2N+%JPP5!9^3',
        fleet_api_base: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
      })
      .select('id')
      .single();

    if (error) throw error;

    // Build Tesla OAuth URL — callback page gets a fresh session from localStorage
    const state = `profile:${account.id}`;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: '3f53a292-07b8-443f-b86d-e4aedc37ac10',
      redirect_uri: 'https://YOUR_DOMAIN/auth/tesla/callback',
      scope: 'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds',
      state,
      audience: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
    });

    window.location.href = `https://auth.tesla.com/oauth2/v3/authorize?${params.toString()}`;
  } catch (err) {
    console.error('Tesla OAuth start failed:', err);
    showToast('Failed to start Tesla connection: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Connect Tesla Account'; }
  }
}

function saveVehicleDraft() {
  const draft = {
    name: document.getElementById('vfName')?.value || '',
    make: document.getElementById('vfMake')?.value || '',
    model: document.getElementById('vfModel')?.value || '',
    color: document.getElementById('vfColor')?.value || '',
    colorHex: document.getElementById('vfColorHex')?.value || '#999999',
    year: document.getElementById('vfYear')?.value || '',
    plate: document.getElementById('vfPlate')?.value || '',
    length: document.getElementById('vfLength')?.value || '',
    editingId: editingVehicleId,
  };
  localStorage.setItem('vehicle-profile-draft', JSON.stringify(draft));
}

function restoreVehicleDraft() {
  try {
    const raw = localStorage.getItem('vehicle-profile-draft');
    if (!raw) {
      // No draft — just open a blank Tesla form
      showVehicleForm({ vehicle_make: 'Tesla', account_id: connectedTeslaAccountId });
      return;
    }
    const draft = JSON.parse(raw);
    showVehicleForm({
      id: draft.editingId || null,
      name: draft.name,
      vehicle_make: draft.make,
      vehicle_model: draft.model,
      color: draft.color,
      color_hex: draft.colorHex,
      year: draft.year ? parseInt(draft.year) : null,
      license_plate: draft.plate,
      vehicle_length_ft: draft.length ? parseFloat(draft.length) : null,
      account_id: connectedTeslaAccountId,
    });
    localStorage.removeItem('vehicle-profile-draft');
  } catch (e) {
    showVehicleForm({ vehicle_make: 'Tesla', account_id: connectedTeslaAccountId });
  }
}

// =============================================
// DRIVER MANAGEMENT
// =============================================

let driverSearchCache = null;

async function loadResidentsList() {
  if (driverSearchCache) return driverSearchCache;
  const { data } = await supabase
    .from('app_users')
    .select('id, display_name, email, role')
    .in('role', ['resident', 'staff', 'admin', 'oracle', 'associate'])
    .neq('id', currentUser.id)
    .order('display_name');
  driverSearchCache = data || [];
  return driverSearchCache;
}

async function showAddDriverDropdown(vehicleId) {
  const dropdown = document.getElementById(`addDriverDropdown_${vehicleId}`);
  if (!dropdown) return;

  if (dropdown.style.display !== 'none') {
    dropdown.style.display = 'none';
    return;
  }

  dropdown.innerHTML = '<div style="padding:0.5rem;color:var(--text-muted);font-size:0.8rem">Loading...</div>';
  dropdown.style.display = '';

  const residents = await loadResidentsList();
  const vehicle = userVehicles.find(v => v.id === vehicleId);
  const existingDriverIds = new Set((vehicle?.drivers || []).map(d => d.app_user?.id).filter(Boolean));

  const available = residents.filter(r => !existingDriverIds.has(r.id));

  if (!available.length) {
    dropdown.innerHTML = '<div style="padding:0.5rem;color:var(--text-muted);font-size:0.8rem">No residents available to add</div>';
    return;
  }

  dropdown.innerHTML = `
    <input type="text" class="vehicle-driver-search" placeholder="Search residents..." style="width:100%;margin-bottom:0.25rem">
    <div class="vehicle-driver-results">
      ${available.map(r => `
        <button class="vehicle-driver-result" data-user-id="${r.id}" data-vehicle-id="${vehicleId}">
          ${escapeAttr(r.display_name || r.email)}
          <span style="color:var(--text-muted);font-size:0.75rem;margin-left:0.25rem">${r.role}</span>
        </button>
      `).join('')}
    </div>
  `;

  // Search filter
  const searchInput = dropdown.querySelector('.vehicle-driver-search');
  const results = dropdown.querySelector('.vehicle-driver-results');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase();
    results.querySelectorAll('.vehicle-driver-result').forEach(btn => {
      btn.style.display = btn.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  searchInput.focus();
}

async function addDriver(vehicleId, userId) {
  try {
    const { error } = await supabase
      .from('vehicle_drivers')
      .insert({ vehicle_id: vehicleId, app_user_id: userId });
    if (error) throw error;
    showToast('Driver added', 'success');
    driverSearchCache = null;
    await reloadVehicles();
  } catch (err) {
    showToast('Failed to add driver: ' + err.message, 'error');
  }
}

async function removeDriver(vehicleId, userId) {
  try {
    const { error } = await supabase
      .from('vehicle_drivers')
      .delete()
      .eq('vehicle_id', vehicleId)
      .eq('app_user_id', userId);
    if (error) throw error;
    showToast('Driver removed', 'success');
    driverSearchCache = null;
    await reloadVehicles();
  } catch (err) {
    showToast('Failed to remove driver: ' + err.message, 'error');
  }
}

// =============================================
// PERSONAL URL / SLUG
// =============================================

const RESERVED_SLUGS = [
  'spaces', 'residents', 'associates', 'login', 'shared', 'mobile',
  'supabase', 'auth', 'scripts', 'visiting', 'visiting-1', 'lost',
  'index', 'directory', 'kioskhall', 'welcome', 'photos', 'sundays',
  'orientation', 'overnight', 'worktrade', 'contact', 'community',
  'events', 'mistiq', 'docs', 'assets', 'styles', 'your-app',
  'bug-reporter-extension', 'bug-reporter-firefox', 'bug-fixer',
  'feature-builder', 'camera-event-poller', 'image-gen',
  'lg-poller', 'tesla-poller', 'spirit-whisper-worker', 'migrations',
];

function renderPersonalUrl() {
  const section = document.getElementById('personalUrlSection');
  if (!section) return;

  const slug = profileData.slug || '';
  const slugInput = document.getElementById('slugInput');
  const openBtn = document.getElementById('openUrlBtn');
  const saveBtn = document.getElementById('saveSlugBtn');

  slugInput.value = slug;
  slugInput.dataset.original = slug;
  saveBtn.disabled = true;

  if (slug) {
    openBtn.href = `/${slug}`;
    openBtn.style.display = '';
  } else {
    openBtn.style.display = 'none';
  }
}

function validateSlug(slug) {
  if (!slug) return 'URL cannot be empty';
  if (slug.length < 2) return 'Must be at least 2 characters';
  if (slug.length > 30) return 'Must be 30 characters or less';
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) && slug.length > 1) return 'Only lowercase letters, numbers, and hyphens (cannot start/end with hyphen)';
  if (!/^[a-z0-9]+$/.test(slug) && slug.length === 1) return 'Must be at least 2 characters';
  if (RESERVED_SLUGS.includes(slug)) return 'This URL is reserved';
  return null;
}

async function saveSlug() {
  const input = document.getElementById('slugInput');
  const errorEl = document.getElementById('slugError');
  const slug = input.value.trim().toLowerCase();

  const validationError = validateSlug(slug);
  if (validationError) {
    errorEl.textContent = validationError;
    errorEl.style.display = '';
    return;
  }

  errorEl.style.display = 'none';

  // Check uniqueness
  const { data: existing } = await supabase
    .from('app_users')
    .select('id')
    .eq('slug', slug)
    .neq('id', currentUser.id)
    .maybeSingle();

  if (existing) {
    errorEl.textContent = 'This URL is already taken';
    errorEl.style.display = '';
    return;
  }

  const btn = document.getElementById('saveSlugBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const { error } = await supabase
      .from('app_users')
      .update({ slug })
      .eq('id', currentUser.id);

    if (error) throw error;

    profileData.slug = slug;
    renderPersonalUrl();
    showToast('Personal URL updated!', 'success');
  } catch (err) {
    showToast('Failed to update URL: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function autoGenerateSlug() {
  const baseName = profileData.first_name || profileData.display_name || profileData.email?.split('@')[0] || '';
  let candidate = baseName.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 30);

  if (!candidate || candidate.length < 2) return;
  if (RESERVED_SLUGS.includes(candidate)) return;

  // Check availability
  const { data: conflict } = await supabase
    .from('app_users')
    .select('id')
    .eq('slug', candidate)
    .neq('id', currentUser.id)
    .maybeSingle();

  if (conflict) {
    candidate += Math.floor(Math.random() * 100);
  }

  try {
    const { error } = await supabase
      .from('app_users')
      .update({ slug: candidate })
      .eq('id', currentUser.id);

    if (!error) {
      profileData.slug = candidate;
      renderPersonalUrl();
    }
  } catch (e) {
    // Silent — non-critical
  }
}

// =============================================
// PRIVACY SETTINGS
// =============================================

const PRIVACY_FIELDS = [
  { key: 'gender', label: 'Gender' },
  { key: 'bio', label: 'Bio' },
  { key: 'nationality', label: 'Nationality' },
  { key: 'location_base', label: 'Location Base' },
  { key: 'birthday', label: 'Birthday' },
  { key: 'dietary', label: 'Dietary Preferences' },
  { key: 'allergies', label: 'Allergies' },
  { key: 'phone', label: 'Phone' },
  { key: 'phone2', label: 'Phone 2' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'links', label: 'Links' },
];

// Facebook-style privacy icons (globe = all guests, people = residents, lock = only me)
const PRIVACY_ICONS = {
  all_guests: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm5.9 7H11.1a14.7 14.7 0 0 0-1-4.3A6 6 0 0 1 13.9 7zM8 14c-.6 0-1.8-1.7-2-5h4c-.2 3.3-1.4 5-2 5zM6 7c.2-3.3 1.4-5 2-5s1.8 1.7 2 5H6zM5.9 2.7A14.7 14.7 0 0 0 4.9 7H2.1a6 6 0 0 1 3.8-4.3zM2.1 9h2.8a14.7 14.7 0 0 0 1 4.3A6 6 0 0 1 2.1 9zm8 4.3a14.7 14.7 0 0 0 1-4.3h2.8a6 6 0 0 1-3.8 4.3z"/></svg>',
  residents: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm0 1C3 8 0 9.8 0 11v1.5c0 .3.2.5.5.5h10c.3 0 .5-.2.5-.5V11c0-1.2-3-3-5.5-3zm5-1a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm1.6 2c.6.6 1.9 1.5 1.9 2v1.5c0 .3-.2.5-.5.5H12V11c0-.7-.4-1.4-.9-2h1z"/></svg>',
  only_me: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M12 7V5a4 4 0 0 0-8 0v2a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM6 5a2 2 0 1 1 4 0v2H6V5z"/></svg>',
};

const PRIVACY_LABELS = {
  all_guests: 'All Guests',
  residents: 'Residents Only',
  only_me: 'Only Me',
};

const PRIVACY_DESCS = {
  all_guests: 'Anyone visiting the property',
  residents: 'Only current residents',
  only_me: 'Hidden from everyone',
};

function collectPrivacySettings() {
  const settings = {};
  PRIVACY_FIELDS.forEach(f => {
    const widget = document.getElementById(`privacy_${f.key}`);
    if (widget) settings[f.key] = widget.dataset.value || 'all_guests';
  });
  return settings;
}

function renderPrivacyControls() {
  const saved = profileData.privacy_settings || {};

  PRIVACY_FIELDS.forEach(f => {
    const widget = document.getElementById(`privacy_${f.key}`);
    if (!widget) return;

    const currentValue = saved[f.key] || 'all_guests';
    widget.dataset.value = currentValue;

    widget.innerHTML = `
      <button type="button" class="profile-privacy-btn" title="${PRIVACY_LABELS[currentValue]}">
        ${PRIVACY_ICONS[currentValue]}
        <svg class="privacy-caret" viewBox="0 0 10 10" fill="currentColor"><path d="M3 4l2 2 2-2"/></svg>
      </button>
      <div class="profile-privacy-menu">
        ${['all_guests', 'residents', 'only_me'].map(val => `
          <button type="button" class="profile-privacy-option${val === currentValue ? ' selected' : ''}" data-value="${val}">
            ${PRIVACY_ICONS[val]}
            <span class="profile-privacy-option-text">
              <span class="profile-privacy-option-label">${PRIVACY_LABELS[val]}</span>
              <span class="profile-privacy-option-desc">${PRIVACY_DESCS[val]}</span>
            </span>
          </button>
        `).join('')}
      </div>
    `;
  });
}

// Toggle privacy dropdown menus
function initPrivacyDropdowns() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.profile-privacy-btn');
    if (btn) {
      e.stopPropagation();
      // Close any other open menus
      document.querySelectorAll('.profile-privacy-menu.open').forEach(m => {
        if (m !== btn.nextElementSibling) m.classList.remove('open');
      });
      btn.nextElementSibling.classList.toggle('open');
      return;
    }

    const option = e.target.closest('.profile-privacy-option');
    if (option) {
      e.stopPropagation();
      const menu = option.closest('.profile-privacy-menu');
      const widget = option.closest('.profile-privacy-widget');
      const newValue = option.dataset.value;
      widget.dataset.value = newValue;

      // Update button icon
      const triggerBtn = widget.querySelector('.profile-privacy-btn');
      triggerBtn.title = PRIVACY_LABELS[newValue];
      triggerBtn.innerHTML = `${PRIVACY_ICONS[newValue]}<svg class="privacy-caret" viewBox="0 0 10 10" fill="currentColor"><path d="M3 4l2 2 2-2"/></svg>`;

      // Update selected state in menu
      menu.querySelectorAll('.profile-privacy-option').forEach(o => {
        o.classList.toggle('selected', o.dataset.value === newValue);
      });

      menu.classList.remove('open');
      updateSaveButton();
      return;
    }

    // Close all menus on outside click
    document.querySelectorAll('.profile-privacy-menu.open').forEach(m => m.classList.remove('open'));
  });
}
