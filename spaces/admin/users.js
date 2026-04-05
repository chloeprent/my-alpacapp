// User Management - Admin only
import { supabase } from '../../shared/supabase.js';
import { initAdminPage, showToast } from '../../shared/admin-shell.js';
import { emailService } from '../../shared/email-service.js';
import { formatDateAustin, getAustinToday } from '../../shared/timezone.js';
import { hasPermission } from '../../shared/auth.js';
import { isDemoUser, redactString } from '../../shared/demo-redact.js';

// Timeout configuration
const DB_TIMEOUT_MS = 10000; // 10 seconds for database operations

/**
 * Wrap a promise with a timeout to prevent indefinite hangs
 */
function withTimeout(promise, ms = DB_TIMEOUT_MS, errorMessage = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), ms)
    )
  ]);
}

let authState = null;
let users = [];
let invitations = [];
let prospectTokens = {}; // invitation_id → access_token record
let peopleSuggestions = []; // For typeahead

// DOM elements (set after DOM ready)
let pendingSection, usersSection, pendingCount, usersCount;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize auth and admin page (requires admin role)
  authState = await initAdminPage({
    activeTab: 'users',
    requiredRole: 'admin',
    section: 'admin',
    onReady: async (state) => {
      authState = state;

      // Set DOM element references
      pendingSection = document.getElementById('pendingSection');
      usersSection = document.getElementById('usersSection');
      pendingCount = document.getElementById('pendingCount');
      usersCount = document.getElementById('usersCount');

      // Load data
      await Promise.all([loadUsers(), loadInvitations(), loadPeople()]);
      render();
      setupEventListeners();
    }
  });
});

function setupEventListeners() {
  // Invite form
  document.getElementById('inviteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('inviteEmail').value.trim().toLowerCase();
    const role = document.getElementById('inviteRole').value;
    const firstName = document.getElementById('inviteFirstName').value.trim();
    const lastName = document.getElementById('inviteLastName').value.trim();
    const phone = document.getElementById('invitePhone').value.trim();
    await inviteUser(email, role, { firstName, lastName, phone });
  });

  // Typeahead for email input
  setupTypeahead();
}

async function loadUsers() {
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('app_users')
        .select('*')
        .order('created_at', { ascending: false }),
      DB_TIMEOUT_MS,
      'Loading users timed out'
    );

    if (error) {
      console.error('Error loading users:', error);
      showToast('Failed to load users: ' + error.message, 'error');
      return;
    }

    users = data || [];
  } catch (timeoutError) {
    console.error('Users load timeout:', timeoutError.message);
    showToast('Loading users timed out. Please refresh the page.', 'error');
  }
}

async function loadInvitations() {
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('user_invitations')
        .select('*')
        .eq('status', 'pending')
        .order('invited_at', { ascending: false }),
      DB_TIMEOUT_MS,
      'Loading invitations timed out'
    );

    if (error) {
      console.error('Error loading invitations:', error);
      showToast('Failed to load invitations: ' + error.message, 'error');
      return;
    }

    invitations = data || [];

    // Load access tokens for prospect invitations
    const prospectInvIds = invitations.filter(i => i.role === 'prospect').map(i => i.id);
    prospectTokens = {};
    if (prospectInvIds.length > 0) {
      const { data: tokens } = await supabase
        .from('access_tokens')
        .select('*')
        .in('invitation_id', prospectInvIds);
      (tokens || []).forEach(t => { prospectTokens[t.invitation_id] = t; });
    }
  } catch (timeoutError) {
    console.error('Invitations load timeout:', timeoutError.message);
    showToast('Loading invitations timed out. Please refresh the page.', 'error');
  }
}

async function loadPeople() {
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('people')
        .select('id, first_name, last_name, email, phone, type')
        .not('email', 'is', null)
        .neq('email', '')
        .order('first_name'),
      DB_TIMEOUT_MS,
      'Loading people timed out'
    );

    if (error) {
      console.error('Error loading people:', error);
      return;
    }

    // Deduplicate by email (keep first occurrence which has latest name)
    const seen = new Set();
    peopleSuggestions = (data || []).filter(p => {
      const key = p.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (e) {
    console.error('People load timeout:', e.message);
  }
}

// Typeahead state
let typeaheadIndex = -1;
let typeaheadFiltered = [];

function setupTypeahead() {
  const input = document.getElementById('inviteEmail');
  const dropdown = document.getElementById('typeaheadDropdown');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    typeaheadIndex = -1;

    if (q.length < 1) {
      dropdown.classList.add('hidden');
      return;
    }

    typeaheadFiltered = peopleSuggestions.filter(p => {
      const full = `${p.first_name} ${p.last_name} ${p.email}`.toLowerCase();
      return full.includes(q);
    }).slice(0, 8);

    if (typeaheadFiltered.length === 0) {
      dropdown.classList.add('hidden');
      return;
    }

    renderTypeahead();
    dropdown.classList.remove('hidden');
  });

  input.addEventListener('keydown', (e) => {
    if (dropdown.classList.contains('hidden')) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      typeaheadIndex = Math.min(typeaheadIndex + 1, typeaheadFiltered.length - 1);
      renderTypeahead();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      typeaheadIndex = Math.max(typeaheadIndex - 1, -1);
      renderTypeahead();
    } else if (e.key === 'Enter' && typeaheadIndex >= 0) {
      e.preventDefault();
      selectTypeaheadItem(typeaheadFiltered[typeaheadIndex]);
    } else if (e.key === 'Escape') {
      dropdown.classList.add('hidden');
    }
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.email-typeahead-wrap')) {
      dropdown.classList.add('hidden');
    }
  });

  // Re-show on focus if there's text
  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 1 && typeaheadFiltered.length > 0) {
      dropdown.classList.remove('hidden');
    }
  });
}

function renderTypeahead() {
  const dropdown = document.getElementById('typeaheadDropdown');
  dropdown.innerHTML = typeaheadFiltered.map((p, i) => `
    <div class="typeahead-item ${i === typeaheadIndex ? 'active' : ''}" data-index="${i}">
      <span>
        <span class="ta-name">${p.first_name} ${p.last_name}</span>
        <span class="ta-type">${p.type}</span>
      </span>
      <span class="ta-email">${p.email}</span>
    </div>
  `).join('');

  dropdown.querySelectorAll('.typeahead-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectTypeaheadItem(typeaheadFiltered[parseInt(item.dataset.index)]);
    });
  });
}

function selectTypeaheadItem(person) {
  const input = document.getElementById('inviteEmail');
  const dropdown = document.getElementById('typeaheadDropdown');
  input.value = person.email;
  dropdown.classList.add('hidden');
  typeaheadFiltered = [];
  typeaheadIndex = -1;

  // Auto-fill optional fields from people record
  document.getElementById('inviteFirstName').value = person.first_name || '';
  document.getElementById('inviteLastName').value = person.last_name || '';
  document.getElementById('invitePhone').value = person.phone || '';

  input.focus();
}

async function inviteUser(email, role, personInfo = {}) {
  const isProspect = role === 'prospect';

  // For prospects, use name as identifier if no email; otherwise validate email
  if (!isProspect) {
    if (!email || !email.includes('@')) {
      showToast('Please enter a valid email address', 'warning');
      return;
    }
  }

  // Use a placeholder email for prospects if none provided
  const effectiveEmail = email && email.includes('@') ? email.toLowerCase() : null;

  if (!isProspect && effectiveEmail) {
    // Check if user already exists
    const existing = users.find(u => u.email.toLowerCase() === effectiveEmail);
    if (existing) {
      showToast('This user already has an account', 'warning');
      return;
    }

    // Check if invitation already pending
    const pendingInvite = invitations.find(i => i.email.toLowerCase() === effectiveEmail);
    if (pendingInvite) {
      showToast('An invitation is already pending for this email', 'warning');
      return;
    }
  }

  // For prospects, require at least a name or email
  if (isProspect && !effectiveEmail && !personInfo.firstName && !personInfo.lastName) {
    // Use the raw input as a name
    const rawInput = document.getElementById('inviteEmail').value.trim();
    if (!rawInput) {
      showToast('Please enter a name or email for the prospect', 'warning');
      return;
    }
    personInfo.firstName = rawInput;
  }

  try {
    // If name or phone provided, upsert into people table
    const { firstName, lastName, phone } = personInfo;
    if (firstName || lastName || phone) {
      const personData = {};
      if (effectiveEmail) personData.email = effectiveEmail;
      if (firstName) personData.first_name = firstName;
      if (lastName) personData.last_name = lastName;
      if (phone) personData.phone = phone;

      // Check if person already exists — match by email, phone, or full name
      let existingPerson = null;

      if (effectiveEmail) {
        const { data } = await supabase
          .from('people').select('id').eq('email', effectiveEmail).maybeSingle();
        existingPerson = data;
      }

      if (!existingPerson && phone) {
        const { data } = await supabase
          .from('people').select('id').eq('phone', phone).maybeSingle();
        existingPerson = data;
      }

      if (!existingPerson && firstName && lastName) {
        const { data } = await supabase
          .from('people').select('id')
          .ilike('first_name', firstName)
          .ilike('last_name', lastName)
          .maybeSingle();
        existingPerson = data;
      }

      if (existingPerson) {
        const updates = {};
        if (firstName) updates.first_name = firstName;
        if (lastName) updates.last_name = lastName;
        if (phone) updates.phone = phone;
        if (effectiveEmail) updates.email = effectiveEmail;
        await supabase.from('people').update(updates).eq('id', existingPerson.id);
      } else {
        personData.first_name = firstName || 'Unknown';
        await supabase.from('people').insert(personData);
      }
    }

    // For prospects, use a placeholder email if none provided
    const inviteEmail = effectiveEmail || `prospect-${Date.now()}@noemail.local`;

    // Delete any existing pending invitations for this email to avoid duplicates
    // (which can cause .single() failures in the auth flow)
    await supabase
      .from('user_invitations')
      .delete()
      .eq('email', inviteEmail)
      .eq('status', 'pending');

    // Create invitation record
    const { data: newInvite, error } = await supabase
      .from('user_invitations')
      .insert({
        email: inviteEmail,
        role: role,
        invited_by: authState.appUser?.id
      })
      .select()
      .single();

    if (error) throw error;

    // For prospects, also create an access token linked to this invitation
    let accessToken = null;
    if (isProspect) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 14);

      const prospectLabel = [firstName, lastName].filter(Boolean).join(' ') || effectiveEmail || 'Prospect';

      const { data: tokenData, error: tokenError } = await supabase
        .from('access_tokens')
        .insert({
          label: prospectLabel,
          created_by: authState.appUser?.id,
          expires_at: expiresAt.toISOString(),
          invitation_id: newInvite.id,
        })
        .select()
        .single();

      if (tokenError) throw tokenError;
      accessToken = tokenData.token;
    }

    // Clear form fields
    document.getElementById('inviteEmail').value = '';
    document.getElementById('inviteFirstName').value = '';
    document.getElementById('inviteLastName').value = '';
    document.getElementById('invitePhone').value = '';

    await loadInvitations();
    await loadPeople();
    render();

    // Show invitation modal
    if (isProspect && accessToken) {
      showProspectLinkModal(accessToken, [firstName, lastName].filter(Boolean).join(' ') || effectiveEmail || 'Prospect', effectiveEmail);
    } else {
      showInvitationModal(inviteEmail, role);
    }

  } catch (error) {
    console.error('Error inviting user:', error);
    showToast('Failed to send invitation: ' + error.message, 'error');
  }
}

/**
 * Send or resend invitation email and update tracking
 */
async function sendInvitationEmail(invitationId, email, role) {
  const loginUrl = 'https://YOUR_DOMAIN/login/';

  // Look up person's name for personalized greeting
  let name = '';
  try {
    const { data: person } = await supabase
      .from('people')
      .select('first_name, last_name')
      .eq('email', email.toLowerCase())
      .maybeSingle();
    if (person) {
      name = person.first_name || '';
    }
  } catch (e) { /* name lookup is best-effort */ }

  const emailResult = await emailService.sendStaffInvitation(email, role, loginUrl, name);

  if (emailResult.success) {
    // Update email tracking: set sent timestamp and increment send count
    const invitation = invitations?.find(i => i.id === invitationId);
    const currentCount = invitation?.email_send_count || 0;
    await supabase
      .from('user_invitations')
      .update({
        email_sent_at: new Date().toISOString(),
        email_send_count: currentCount + 1,
      })
      .eq('id', invitationId);

    return true;
  } else {
    console.error('Email send failed:', emailResult.error);
    return false;
  }
}

/**
 * Resend invitation email
 */
async function resendInvitation(invitationId) {
  const invitation = invitations.find(i => i.id === invitationId);
  if (!invitation) {
    showToast('Invitation not found', 'error');
    return;
  }

  // Find and disable the button for loading state
  const btn = document.querySelector(`button[onclick="resendInvitation('${invitationId}')"]`);
  const originalText = btn?.textContent;
  if (btn) {
    btn.textContent = 'Sending...';
    btn.disabled = true;
  }

  try {
    // Check if expired
    if (new Date(invitation.expires_at) < new Date()) {
      // Extend expiration by 7 days
      const newExpiry = new Date();
      newExpiry.setDate(newExpiry.getDate() + 7);

      const { error } = await supabase
        .from('user_invitations')
        .update({ expires_at: newExpiry.toISOString() })
        .eq('id', invitationId);

      if (error) throw error;
    }

    const emailSent = await sendInvitationEmail(invitationId, invitation.email, invitation.role);

    if (emailSent) {
      showToast('Invitation resent to ' + invitation.email, 'success');
      await loadInvitations();
      render();
    } else {
      showToast('Failed to send email. Try copying the invite text manually.', 'error');
      showInvitationModal(invitation.email, invitation.role);
    }
  } catch (error) {
    console.error('Error resending invitation:', error);
    showToast('Failed to resend: ' + error.message, 'error');
  } finally {
    if (btn) {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
}

// Store current invitation details for sending email
let currentInviteEmail = null;
let currentInviteRole = null;
let currentProspectToken = null;
let currentProspectName = null;

function showInvitationModal(email, role) {
  currentInviteEmail = email;
  currentInviteRole = role;

  const roleDescriptions = {
    admin: 'full admin access (view all spaces, occupant details, edit spaces, manage photos, and invite users)',
    staff: 'staff access (view all spaces and occupant details)',
    demo: 'demo access (conduct self-demo of YOUR_APP_NAME, see redacted fake names and amounts for privacy)',
    resident: 'resident access (cameras, lighting, and house info)',
    associate: 'associate access (cameras, lighting, and house info)',
    public: 'public access (view available spaces)',
    prospect: 'prospect access (view available spaces via link, no login required)',
  };
  const roleDescription = roleDescriptions[role] || roleDescriptions.resident;

  const roleLabels = { admin: 'an admin', staff: 'a staff member', demo: 'a demo user', resident: 'a resident', associate: 'an associate', public: 'a public user' };
  const inviteText = `Hi,

You've been invited to access AlpacApp as ${roleLabels[role] || 'a user'}.

You will have ${roleDescription}.

To get started:
1. Go to: https://YOUR_DOMAIN/login/
2. Sign in with Google, or use your email and password

If you don't have a password yet, click "Forgot password?" on the login page to set one up.

Your access has already been pre-approved for ${email}, so you'll have immediate access once you sign in.

If there are any problems or suggestions for improvements, please email them to team@YOUR_DOMAIN as soon as you can and they will be rapidly addressed.`;

  // Show modal
  const modal = document.getElementById('inviteTextModal');
  document.getElementById('inviteTextContent').value = inviteText;
  modal.classList.remove('hidden');
}

function copyInviteText() {
  const textarea = document.getElementById('inviteTextContent');
  textarea.select();
  document.execCommand('copy');
  showToast('Invitation text copied to clipboard', 'success');
}

function closeInviteModal() {
  document.getElementById('inviteTextModal').classList.add('hidden');
  currentInviteEmail = null;
  currentInviteRole = null;
}

function showProspectLinkModal(token, name, email) {
  const url = `https://YOUR_DOMAIN/spaces/?access=${token}`;
  const firstName = name && name !== 'Prospect' ? name.split(' ')[0] : '';

  const inviteText = `Hi${firstName ? ' ' + firstName : ''},

You've been invited to browse available spaces at YOUR_PROPERTY_NAME, a unique co-living community in Your City, Texas.

No account or login is needed — just click the link below to start browsing:

${url}

You'll be able to see photos, amenities, pricing, and availability for all of our spaces. This link is personal to you and will expire in 14 days.

When you're ready, you can also:
• Apply for a rental space: https://YOUR_DOMAIN/spaces/apply/
• Host an event: https://YOUR_DOMAIN/spaces/hostevent/

If you have any questions or would like to schedule a tour, feel free to reply to this message or email team@YOUR_DOMAIN.

Yours,
The YOUR_PROPERTY_NAME Community Team`;

  // Store state for email sending
  currentProspectToken = token;
  currentProspectName = firstName;
  const hasRealEmail = email && email.includes('@') && !email.includes('@noemail.local');
  currentInviteEmail = hasRealEmail ? email : null;
  currentInviteRole = 'prospect';

  const modal = document.getElementById('inviteTextModal');
  const textarea = document.getElementById('inviteTextContent');

  modal.querySelector('.modal-header h2').textContent = 'Invitation Ready';
  modal.querySelector('.modal-body > p').textContent = 'The invitation has been created. Copy the text below and send it via email or message:';
  textarea.value = inviteText;
  textarea.style.height = '300px';

  // Show send email button only if prospect has a real email
  const sendBtn = document.getElementById('sendInviteEmailBtn');
  sendBtn.style.display = hasRealEmail ? '' : 'none';

  modal.classList.remove('hidden');
}

// Override close to reset modal state
const _originalCloseInviteModal = closeInviteModal;
window.closeInviteModal = function() {
  _originalCloseInviteModal();
  currentProspectToken = null;
  currentProspectName = null;
  document.getElementById('sendInviteEmailBtn').style.display = '';
  document.getElementById('inviteTextContent').style.height = '250px';
};

async function sendInviteEmail() {
  if (!currentInviteEmail || !currentInviteRole) {
    showToast('No invitation to send', 'error');
    return;
  }

  const btn = document.getElementById('sendInviteEmailBtn');
  const originalText = btn.textContent;
  btn.textContent = 'Sending...';
  btn.disabled = true;

  try {
    // Handle prospect emails differently
    if (currentInviteRole === 'prospect' && currentProspectToken) {
      const accessUrl = `https://YOUR_DOMAIN/spaces/?access=${currentProspectToken}`;
      const emailResult = await emailService.sendProspectInvitation(currentInviteEmail, currentProspectName, accessUrl);

      if (emailResult.success) {
        // Update invitation email tracking
        const invitation = invitations.find(i => i.email.toLowerCase() === currentInviteEmail.toLowerCase());
        if (invitation) {
          const currentCount = invitation.email_send_count || 0;
          await supabase
            .from('user_invitations')
            .update({ email_sent_at: new Date().toISOString(), email_send_count: currentCount + 1 })
            .eq('id', invitation.id);
        }
        showToast('Email sent to ' + currentInviteEmail, 'success');
        closeInviteModal();
        await loadInvitations();
        render();
      } else {
        showToast('Failed to send email. Try copying the invite text manually.', 'error');
      }
      return;
    }

    const invitation = invitations.find(i => i.email.toLowerCase() === currentInviteEmail.toLowerCase());
    if (!invitation) {
      showToast('Invitation not found', 'error');
      return;
    }

    const emailSent = await sendInvitationEmail(invitation.id, currentInviteEmail, currentInviteRole);

    if (emailSent) {
      showToast('Email sent to ' + currentInviteEmail, 'success');
      closeInviteModal();
      await loadInvitations();
      render();
    } else {
      showToast('Failed to send email. Try copying the invite text manually.', 'error');
    }
  } catch (error) {
    console.error('Error sending invitation email:', error);
    showToast('Failed to send email: ' + error.message, 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function revokeInvitation(invitationId) {
  try {
    const { error } = await supabase
      .from('user_invitations')
      .update({ status: 'revoked' })
      .eq('id', invitationId);

    if (error) throw error;

    await loadInvitations();
    render();
    showToast('Invitation revoked', 'success');

  } catch (error) {
    console.error('Error revoking invitation:', error);
    showToast('Failed to revoke: ' + error.message, 'error');
  }
}

window.copyProspectLink = function(token, label, email) {
  showProspectLinkModal(token, label || 'Prospect', email || null);
};

window.revokeProspectToken = async function(tokenId, invitationId) {
  if (!confirm('Revoke this access link? The prospect will lose access.')) return;

  try {
    // Revoke the access token
    const { error: tokenError } = await supabase
      .from('access_tokens')
      .update({ is_revoked: true })
      .eq('id', tokenId);
    if (tokenError) throw tokenError;

    // Also revoke the invitation
    const { error: invError } = await supabase
      .from('user_invitations')
      .update({ status: 'revoked' })
      .eq('id', invitationId);
    if (invError) throw invError;

    await loadInvitations();
    render();
    showToast('Prospect access revoked', 'success');
  } catch (error) {
    console.error('Error revoking prospect access:', error);
    showToast('Failed to revoke: ' + error.message, 'error');
  }
};

async function updateUserRole(userId, newRole) {
  try {
    const { error } = await supabase
      .from('app_users')
      .update({ role: newRole })
      .eq('id', userId);

    if (error) throw error;

    await loadUsers();
    render();
    showToast('Role updated', 'success');

  } catch (error) {
    console.error('Error updating role:', error);
    showToast('Failed to update role: ' + error.message, 'error');
  }
}

async function removeUser(userId) {
  if (!confirm('Remove this user? They will no longer be able to access admin features.')) return;

  try {
    const { error } = await supabase
      .from('app_users')
      .delete()
      .eq('id', userId);

    if (error) throw error;

    await loadUsers();
    render();
    showToast('User removed', 'success');

  } catch (error) {
    console.error('Error removing user:', error);
    showToast('Failed to remove user: ' + error.message, 'error');
  }
}

// --- Current Resident Management ---

async function refreshResidencyStatus() {
  try {
    const { error } = await supabase.rpc('recompute_current_residents');
    if (error) {
      showToast('Failed to refresh residency status: ' + error.message, 'error');
      return;
    }
    await loadUsers();
    render();
    showToast('Residency status refreshed', 'success');
  } catch (e) {
    showToast('Error refreshing: ' + e.message, 'error');
  }
}

async function toggleCurrentResident(userId) {
  const user = users.find(u => u.id === userId);
  if (!user) return;

  // Cycle override: null (auto) → !current (manual opposite) → null (back to auto)
  let newOverride;
  if (user.is_current_resident_override === null) {
    // Auto mode → set manual override to opposite of current effective value
    newOverride = !user.is_current_resident;
  } else {
    // Manual mode → go back to auto
    newOverride = null;
  }

  try {
    const { error } = await supabase
      .from('app_users')
      .update({ is_current_resident_override: newOverride })
      .eq('id', userId);
    if (error) throw error;

    // Recompute effective values
    await supabase.rpc('recompute_current_residents');
    await loadUsers();
    render();
  } catch (e) {
    showToast('Failed to update: ' + e.message, 'error');
  }
}

function getPersonName(personId) {
  const person = peopleSuggestions.find(p => p.id === personId);
  if (!person) return '(linked)';
  return `${person.first_name || ''} ${person.last_name || ''}`.trim() || person.email;
}

function showLinkPersonModal(userId, userEmail) {
  const modal = document.getElementById('linkPersonModal');
  modal.dataset.userId = userId;

  // Filter people suggestions, put email match first
  const sorted = [...peopleSuggestions].sort((a, b) => {
    const aMatch = a.email?.toLowerCase() === userEmail?.toLowerCase();
    const bMatch = b.email?.toLowerCase() === userEmail?.toLowerCase();
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;
    return 0;
  });

  const select = document.getElementById('linkPersonSelect');
  select.innerHTML = `
    <option value="">-- Select a person --</option>
    ${sorted.map(p => `
      <option value="${p.id}" ${p.email?.toLowerCase() === userEmail?.toLowerCase() ? 'selected' : ''}>
        ${p.first_name || ''} ${p.last_name || ''} — ${p.email} (${p.type || '?'})
      </option>
    `).join('')}
  `;

  modal.classList.remove('hidden');
}

function closeLinkPersonModal() {
  document.getElementById('linkPersonModal').classList.add('hidden');
}

async function confirmLinkPerson() {
  const modal = document.getElementById('linkPersonModal');
  const userId = modal.dataset.userId;
  const personId = document.getElementById('linkPersonSelect').value;

  if (!personId) {
    showToast('Please select a person', 'warning');
    return;
  }

  try {
    const { error } = await supabase
      .from('app_users')
      .update({ person_id: personId })
      .eq('id', userId);
    if (error) throw error;

    // Recompute residency after linking
    await supabase.rpc('recompute_current_residents');
    await loadUsers();
    render();
    closeLinkPersonModal();
    showToast('Person linked', 'success');
  } catch (e) {
    showToast('Failed to link: ' + e.message, 'error');
  }
}

async function unlinkPerson(userId) {
  try {
    const { error } = await supabase
      .from('app_users')
      .update({ person_id: null })
      .eq('id', userId);
    if (error) throw error;

    await supabase.rpc('recompute_current_residents');
    await loadUsers();
    render();
    showToast('Person unlinked', 'success');
  } catch (e) {
    showToast('Failed to unlink: ' + e.message, 'error');
  }
}

function render() {
  renderInvitations();
  renderUsers();
}

function renderInvitations() {
  // Deduplicate invitations by email, keeping only the most recent one per email
  // (invitations are already sorted by invited_at desc, so first occurrence is most recent)
  const seenEmails = new Set();
  const uniqueInvitations = invitations.filter(inv => {
    const emailLower = inv.email.toLowerCase();
    if (seenEmails.has(emailLower)) {
      return false;
    }
    seenEmails.add(emailLower);
    return true;
  });

  pendingCount.textContent = uniqueInvitations.length;

  if (uniqueInvitations.length === 0) {
    pendingSection.innerHTML = `
      <div class="empty-state">
        No pending invitations
      </div>
    `;
    return;
  }

  pendingSection.innerHTML = `
    <table class="users-table">
      <colgroup>
        <col style="width: 25%">
        <col style="width: 10%">
        <col style="width: 15%">
        <col style="width: 18%">
        <col style="width: 32%">
      </colgroup>
      <thead>
        <tr>
          <th>Email</th>
          <th>Role</th>
          <th>Email Status</th>
          <th>Expires</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${uniqueInvitations.map(inv => {
          const isExpired = new Date(inv.expires_at) < getAustinToday();
          const isProspect = inv.role === 'prospect';
          const token = isProspect ? prospectTokens[inv.id] : null;
          const tokenExpired = token && new Date(token.expires_at) < new Date();
          const tokenRevoked = token && token.is_revoked;

          // For prospects: show label or email; hide placeholder emails
          const displayEmail = isProspect
            ? (token?.label || (inv.email.includes('@noemail.local') ? '—' : inv.email))
            : (isDemoUser() ? `<span class="demo-redacted">${redactString(inv.email, 'email')}</span>` : inv.email);

          // For prospects: show link status instead of email status
          let statusHtml;
          if (isProspect && token) {
            const clicks = token.use_count || 0;
            const lastUsed = token.last_used_at ? formatDateAustin(token.last_used_at, { month: 'short', day: 'numeric' }) : null;
            if (tokenRevoked) {
              statusHtml = '<span class="email-status status-not-sent">Revoked</span>';
            } else if (tokenExpired) {
              statusHtml = `<span class="email-status status-not-sent">Expired</span>${clicks ? ` <span class="send-count">(${clicks} click${clicks !== 1 ? 's' : ''})</span>` : ''}`;
            } else if (clicks > 0) {
              statusHtml = `<span class="email-status status-sent-recent">Clicked ${clicks}x</span>${lastUsed ? ` <span class="send-count">(${lastUsed})</span>` : ''}`;
            } else {
              statusHtml = '<span class="email-status status-not-sent">Not clicked</span>';
            }
          } else {
            const emailStatus = getEmailStatus(inv);
            statusHtml = `<span class="email-status ${emailStatus.class}">${emailStatus.text}</span>${inv.email_send_count > 1 ? ` <span class="send-count">(${inv.email_send_count}x)</span>` : ''}`;
          }

          // Expiration: for prospects show token expiry
          const expiresAt = isProspect && token ? token.expires_at : inv.expires_at;
          const effectiveExpired = isProspect ? (tokenExpired || tokenRevoked) : isExpired;

          return `
            <tr class="${effectiveExpired ? 'expired-row' : ''}">
              <td>${displayEmail}</td>
              <td><span class="role-badge ${inv.role}">${inv.role}</span></td>
              <td>${statusHtml}</td>
              <td>
                <span class="${effectiveExpired ? 'expired-text' : ''}">${formatDateAustin(expiresAt, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                ${effectiveExpired ? '<span class="expired-badge">' + (tokenRevoked ? 'Revoked' : 'Expired') + '</span>' : ''}
              </td>
              <td class="actions-cell">
                ${isProspect && token ? `
                  ${!tokenRevoked && !tokenExpired ? `<button class="btn-secondary btn-small" onclick="copyProspectLink('${token.token}', '${(token.label || 'Prospect').replace(/'/g, "\\'")}', '${inv.email.includes('@noemail.local') ? '' : inv.email.replace(/'/g, "\\'")}')" title="Copy invitation text">Copy</button>` : ''}
                  ${!tokenRevoked ? `<button class="btn-danger btn-small" onclick="revokeProspectToken('${token.id}', '${inv.id}')">Revoke</button>` : ''}
                ` : `
                  <button class="btn-secondary btn-small" onclick="resendInvitation('${inv.id}')" title="Resend invitation email">
                    ${isExpired ? 'Resend & Extend' : 'Resend'}
                  </button>
                  <button class="btn-text" onclick="showInvitationModal('${inv.email}', '${inv.role}')" title="Copy invite text">
                    Copy
                  </button>
                  <button class="btn-danger btn-small" onclick="revokeInvitation('${inv.id}')">Revoke</button>
                `}
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function getEmailStatus(invitation) {
  if (!invitation.email_sent_at) {
    return { text: 'Not sent', class: 'status-not-sent' };
  }

  const sentDate = new Date(invitation.email_sent_at);
  const now = new Date();
  const hoursSince = (now - sentDate) / (1000 * 60 * 60);

  if (hoursSince < 1) {
    const minsSince = Math.floor((now - sentDate) / (1000 * 60));
    return { text: `Sent ${minsSince}m ago`, class: 'status-sent-recent' };
  } else if (hoursSince < 24) {
    return { text: `Sent ${Math.floor(hoursSince)}h ago`, class: 'status-sent-recent' };
  } else {
    const daysSince = Math.floor(hoursSince / 24);
    return { text: `Sent ${daysSince}d ago`, class: 'status-sent' };
  }
}

function renderUsers() {
  usersCount.textContent = users.length;

  if (users.length === 0) {
    usersSection.innerHTML = `
      <div class="empty-state">
        No users yet
      </div>
    `;
    return;
  }

  const currentUserId = authState.appUser?.id;

  usersSection.innerHTML = `
    <table class="users-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Role</th>
          <th>Here</th>
          <th>Person</th>
          <th>Last Login</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${users.map(u => {
          const isCurrentUser = u.id === currentUserId;
          const isHere = u.is_current_resident;
          const isOverride = u.is_current_resident_override !== null && u.is_current_resident_override !== undefined;
          const overrideTitle = isOverride
            ? `Manual override (${u.is_current_resident_override ? 'forced ON' : 'forced OFF'}). Click to reset to auto.`
            : `Auto-derived from assignments. Click to override.`;
          const displayName = isDemoUser() ? redactString(u.display_name || '-', 'name') : (u.display_name || '-');
          const personName = isDemoUser() ? redactString(getPersonName(u.person_id), 'name') : getPersonName(u.person_id);
          return `
            <tr>
              <td>
                <span class="${isDemoUser() ? 'demo-redacted' : ''}">${displayName}</span>
                ${isCurrentUser ? '<span class="you-tag">You</span>' : ''}
              </td>
              <td>${isDemoUser() ? `<span class="demo-redacted">${redactString(u.email, 'email')}</span>` : u.email}${u.contact_email && u.contact_email !== u.email ? `<br><span style="font-size:0.75rem;color:var(--text-muted)">contact: ${isDemoUser() ? `<span class="demo-redacted">${redactString(u.contact_email, 'email')}</span>` : u.contact_email}</span>` : ''}</td>
              <td>
                <select
                  class="role-select"
                  data-user-id="${u.id}"
                  ${isCurrentUser || isDemoUser() ? 'disabled' : ''}
                  onchange="updateUserRole('${u.id}', this.value)"
                >
                  <option value="prospect" ${u.role === 'prospect' ? 'selected' : ''}>Prospect</option>
                  <option value="public" ${u.role === 'public' ? 'selected' : ''}>Public</option>
                  <option value="demo" ${u.role === 'demo' ? 'selected' : ''}>Demo</option>
                  <option value="associate" ${u.role === 'associate' ? 'selected' : ''}>Associate</option>
                  <option value="resident" ${u.role === 'resident' ? 'selected' : ''}>Resident</option>
                  <option value="staff" ${u.role === 'staff' ? 'selected' : ''}>Staff</option>
                  <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
                  <option value="oracle" ${u.role === 'oracle' ? 'selected' : ''}>Oracle</option>
                </select>
              </td>
              <td>
                <button class="residency-toggle ${isHere ? 'is-here' : ''} ${isOverride ? 'manual' : ''}"
                  onclick="toggleCurrentResident('${u.id}')"
                  title="${overrideTitle}">
                  ${isHere ? '&#127968;' : '&mdash;'}${isOverride ? ' &#128274;' : ''}
                </button>
              </td>
              <td class="person-cell">
                ${u.person_id
                  ? `<span class="person-link ${isDemoUser() ? 'demo-redacted' : ''}" title="Click to unlink">${personName}</span>
                     ${isDemoUser() ? '' : `<button class="btn-unlink" onclick="unlinkPerson('${u.id}')" title="Unlink person">&times;</button>`}`
                  : (isDemoUser() ? '—' : `<button class="btn-text btn-small" onclick="showLinkPersonModal('${u.id}', '${u.email}')">Link</button>`)
                }
              </td>
              <td>${u.last_login_at ? formatDateAustin(u.last_login_at, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never'}</td>
              <td>
                ${hasPermission('manage_permissions') && !isCurrentUser
                  ? `<button class="btn-secondary btn-small" onclick="showPermissionsModal('${u.id}')" style="margin-right:0.25rem;">Permissions</button>`
                  : ''
                }
                ${isCurrentUser
                  ? ''
                  : `<button class="btn-danger btn-small" onclick="removeUser('${u.id}')" title="Remove user">&times;</button>`
                }
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// =============================================
// PERMISSIONS MODAL
// =============================================

// ---- Permission groups: functional grouping with colors ----
// Each group maps DB permission keys → a visual section with icon, label, and background tint.
// "admin_key" is the matching admin_resident permission to indent under this group.
const PERM_GROUPS = [
  // -- Resident smart-home tabs (matches GUI tab order: Lighting → Music → Cameras → Climate → Laundry → Cars → Profile → PAI) --
  { id: 'lighting', icon: '💡', label: 'Lighting', bg: '#fef9ec', headerBg: '#fdf0cc', headerColor: '#92600e',
    keys: ['view_lighting', 'control_lighting'], adminKey: 'admin_lighting_settings' },
  { id: 'music',    icon: '🎵', label: 'Music',    bg: '#f3effc', headerBg: '#e2dafc', headerColor: '#5b3fa0',
    keys: ['view_music', 'control_music'], adminKey: 'admin_music_settings' },
  { id: 'cameras',  icon: '📹', label: 'Cameras',  bg: '#eef6fc', headerBg: '#d6ebf7', headerColor: '#1e5f8a',
    keys: ['view_cameras', 'use_camera_ptz', 'use_camera_talkback'], adminKey: null },
  { id: 'climate',  icon: '🌡️', label: 'Climate',  bg: '#ecfdf5', headerBg: '#c8f5dd', headerColor: '#065f46',
    keys: ['view_climate', 'control_climate'], adminKey: 'admin_climate_settings' },
  { id: 'laundry',  icon: '🧺', label: 'Appliances',  bg: '#fef2f2', headerBg: '#fde2e2', headerColor: '#9b2c2c',
    keys: ['view_laundry'], adminKey: 'admin_laundry_settings' },
  { id: 'oven',     icon: '♨️', label: 'Oven',      bg: '#fef9ec', headerBg: '#fde8b2', headerColor: '#92400e',
    keys: ['view_oven', 'control_oven'], adminKey: 'admin_oven_settings' },
  { id: 'cars',     icon: '🚗', label: 'Vehicles', bg: '#f0f4f8', headerBg: '#dbe4ee', headerColor: '#374151',
    keys: ['view_cars', 'control_cars'], adminKey: 'admin_cars_settings' },
  { id: 'profile',  icon: '👤', label: 'Profile',  bg: '#f5f5f5', headerBg: '#e8e8e8', headerColor: '#555',
    keys: ['view_profile', 'edit_profile'], adminKey: null },
  { id: 'pai',      icon: '🦙', label: 'PAI',      bg: '#fdf1e0', headerBg: '#f9dfb8', headerColor: '#92400e',
    keys: ['use_pai'], adminKey: 'admin_pai_settings' },
  // -- Staff admin tabs --
  { id: 'spaces',   icon: '🏠', label: 'Spaces',   bg: '#fdf1e0', headerBg: '#f9dfb8', headerColor: '#92400e',
    keys: ['view_spaces', 'manage_spaces'], adminKey: null },
  { id: 'rentals',  icon: '📋', label: 'Rentals',  bg: '#ecfdf5', headerBg: '#c8f5dd', headerColor: '#065f46',
    keys: ['view_rentals', 'manage_rentals'], adminKey: null },
  { id: 'events',   icon: '🎉', label: 'Events',   bg: '#f3effc', headerBg: '#e2dafc', headerColor: '#5b3fa0',
    keys: ['view_events', 'manage_events'], adminKey: null },
  { id: 'media',    icon: '🖼️', label: 'Media',    bg: '#eef6fc', headerBg: '#d6ebf7', headerColor: '#1e5f8a',
    keys: ['view_media', 'manage_media'], adminKey: null },
  { id: 'purchases', icon: '🛒', label: 'Purchases', bg: '#ecfdf5', headerBg: '#c8f5dd', headerColor: '#065f46',
    keys: ['view_purchases', 'manage_purchases'], adminKey: null },
  { id: 'sms',      icon: '💬', label: 'SMS',      bg: '#fef9ec', headerBg: '#fdf0cc', headerColor: '#92600e',
    keys: ['view_sms', 'send_sms'], adminKey: null },
  { id: 'hours',    icon: '⏱️', label: 'Workstuff',    bg: '#fef2f2', headerBg: '#fde2e2', headerColor: '#9b2c2c',
    keys: ['view_hours', 'manage_hours'], adminKey: null },
  { id: 'faq',      icon: '❓', label: 'FAQ / AI', bg: '#f0f4f8', headerBg: '#dbe4ee', headerColor: '#374151',
    keys: ['view_faq', 'manage_faq'], adminKey: null },
  { id: 'voice',    icon: '📞', label: 'Voice',    bg: '#f5f5f5', headerBg: '#e8e8e8', headerColor: '#555',
    keys: ['view_voice', 'manage_voice'], adminKey: null },
  { id: 'todo',     icon: '✅', label: 'Todo',     bg: '#ecfdf5', headerBg: '#c8f5dd', headerColor: '#065f46',
    keys: ['view_todo', 'manage_todo'], adminKey: null },
  { id: 'appdev',   icon: '🤖', label: 'App Dev',  bg: '#eef6fc', headerBg: '#d6ebf7', headerColor: '#1e5f8a',
    keys: ['view_appdev', 'approve_appdev'], adminKey: null },
  // -- Admin-only --
  { id: 'users',    icon: '👥', label: 'Users & Permissions', bg: '#fef3c7', headerBg: '#fde68a', headerColor: '#92400e',
    keys: ['view_users', 'manage_users', 'manage_permissions'], adminKey: null },
  { id: 'passwords',icon: '🔑', label: 'Passwords', bg: '#fef3c7', headerBg: '#fde68a', headerColor: '#92400e',
    keys: ['view_passwords', 'manage_passwords'], adminKey: null },
  { id: 'settings', icon: '⚙️', label: 'Settings', bg: '#fef3c7', headerBg: '#fde68a', headerColor: '#92400e',
    keys: ['view_settings', 'manage_settings'], adminKey: null },
  { id: 'templates',icon: '📄', label: 'Templates',bg: '#fef3c7', headerBg: '#fde68a', headerColor: '#92400e',
    keys: ['view_templates', 'manage_templates'], adminKey: null },
  { id: 'accounting',icon:'💰', label: 'Accounting',bg: '#fef3c7', headerBg: '#fde68a', headerColor: '#92400e',
    keys: ['view_accounting', 'manage_accounting'], adminKey: null },
  { id: 'testdev',icon:'🧪', label: 'Test Dev',bg: '#fef3c7', headerBg: '#fde68a', headerColor: '#92400e',
    keys: ['view_testdev'], adminKey: null },
  // -- Associate --
  { id: 'associate', icon: '🔧', label: 'Associate Work', bg: '#fce7f3', headerBg: '#f9d0e7', headerColor: '#9d174d',
    keys: ['clock_in_out', 'upload_work_photos', 'view_own_hours', 'manage_payment_prefs'], adminKey: null },
];

// Super-sections that group the above
const PERM_SUPER_SECTIONS = [
  { label: 'Resident', groupIds: ['lighting','music','cameras','climate','laundry','cars','profile','pai'] },
  { label: 'Staff',    groupIds: ['spaces','rentals','events','media','purchases','sms','hours','faq','voice','todo','appdev'] },
  { label: 'Admin',    groupIds: ['users','passwords','settings','templates','accounting','testdev'] },
  { label: 'Associate',groupIds: ['associate'] },
];

// Track current modal state
let permModalUserId = null;
let permModalUserRole = null;
let permModalRoleDefaults = new Set();
let permModalOverrides = new Map(); // key → boolean (granted)
let permModalInitialOverrides = null; // snapshot of overrides at modal open, for dirty detection
let allRoleMappings = null; // permission_key → [roles], cached across modal opens

async function showPermissionsModal(userId) {
  const user = users.find(u => u.id === userId);
  if (!user) return;

  permModalUserId = userId;
  permModalUserRole = user.role;

  document.getElementById('permUserName').textContent = user.display_name || user.email;
  const badge = document.getElementById('permUserRoleBadge');
  badge.textContent = user.role;
  badge.className = 'role-badge ' + user.role;

  // Fetch all permissions, role defaults, user overrides, and all role mappings
  const fetches = [
    supabase.from('permissions').select('*').order('category').order('sort_order'),
    supabase.from('role_permissions').select('permission_key').eq('role', user.role),
    supabase.from('user_permissions').select('permission_key, granted').eq('app_user_id', userId),
  ];
  if (!allRoleMappings) {
    fetches.push(supabase.from('role_permissions').select('permission_key, role'));
  }

  const results = await Promise.all(fetches);
  const allPerms = results[0].data || [];
  const permsMap = Object.fromEntries(allPerms.map(p => [p.key, p]));
  permModalRoleDefaults = new Set((results[1].data || []).map(r => r.permission_key));
  permModalOverrides = new Map((results[2].data || []).map(o => [o.permission_key, o.granted]));

  if (results[3]) {
    allRoleMappings = {};
    for (const row of (results[3].data || [])) {
      if (!allRoleMappings[row.permission_key]) allRoleMappings[row.permission_key] = [];
      allRoleMappings[row.permission_key].push(row.role);
    }
  }

  const roleOrder = ['associate', 'resident', 'demo', 'staff', 'admin', 'oracle'];
  const roleAbbrev = { associate: 'asc', resident: 'res', demo: 'dem', staff: 'stf', admin: 'adm', oracle: 'orc' };

  function renderRow(perm, indent) {
    const isRoleDefault = permModalRoleDefaults.has(perm.key);
    const override = permModalOverrides.get(perm.key);
    const isEffective = override !== undefined ? override : isRoleDefault;
    const stateClass = override === true ? 'perm-granted' :
                       override === false ? 'perm-revoked' : '';
    const roles = (allRoleMappings[perm.key] || []).sort((a, b) => roleOrder.indexOf(a) - roleOrder.indexOf(b));
    const roleColors = {
      oracle:    { bg: '#92400e', color: '#fff' },
      admin:     { bg: '#b45309', color: '#fff' },
      staff:     { bg: '#3730a3', color: '#fff' },
      demo:      { bg: '#6b7280', color: '#fff' },
      resident:  { bg: '#065f46', color: '#fff' },
      associate: { bg: '#9d174d', color: '#fff' },
    };
    const rolesHtml = roles.map(r => {
      const c = roleColors[r] || { bg: '#6b7280', color: '#fff' };
      return `<span class="perm-role-chip" style="background:${c.bg};color:${c.color};">${roleAbbrev[r] || r}</span>`;
    }).join('');
    return `<tr class="${stateClass} ${indent ? 'pt-indent' : ''}" data-key="${perm.key}" data-role-default="${isRoleDefault}">
      <td class="pt-check"><input type="checkbox" ${isEffective ? 'checked' : ''} onchange="togglePermOverride(this, '${perm.key}', ${isRoleDefault})"></td>
      <td class="pt-name">${indent ? '↳ ' : ''}${perm.label}</td>
      <td class="pt-desc">${perm.description || ''}</td>
      <td class="pt-roles">${rolesHtml}</td>
    </tr>`;
  }

  let html = '';
  let isFirstSection = true;
  for (const section of PERM_SUPER_SECTIONS) {
    html += `<div class="perm-super-section">${section.label}</div>`;
    if (isFirstSection) {
      html += `<div class="perm-col-headers">
        <span class="pch-check"></span>
        <span class="pch-name">Permission</span>
        <span class="pch-desc">Description</span>
        <span class="pch-roles">Included in</span>
      </div>`;
      isFirstSection = false;
    }
    for (const gid of section.groupIds) {
      const group = PERM_GROUPS.find(g => g.id === gid);
      if (!group) continue;
      // Collect permissions for this group
      const groupPerms = group.keys.map(k => permsMap[k]).filter(Boolean);
      const adminPerm = group.adminKey ? permsMap[group.adminKey] : null;
      if (groupPerms.length === 0 && !adminPerm) continue;
      const totalCount = groupPerms.length + (adminPerm ? 1 : 0);

      html += `<div class="perm-group">`;
      html += `<div class="perm-group-header" style="background:${group.headerBg};color:${group.headerColor};">
        <span class="pg-icon">${group.icon}</span> ${group.label}
        <span class="pg-count">${totalCount}</span>
      </div>`;
      html += `<table class="perm-table" style="background:${group.bg};">`;
      for (const perm of groupPerms) {
        html += renderRow(perm, false);
      }
      if (adminPerm) {
        html += renderRow(adminPerm, true);
      }
      html += '</table></div>';
    }
  }

  document.getElementById('permissionCategories').innerHTML = html;
  // Snapshot initial state for dirty detection
  permModalInitialOverrides = new Map(permModalOverrides);
  updateSaveButtonState();
  document.getElementById('permissionsModal').classList.remove('hidden');
}

function updateSaveButtonState() {
  const saveBtn = document.getElementById('permSaveBtn');
  if (!saveBtn) return;
  // Compare current overrides to initial snapshot
  let dirty = false;
  if (permModalInitialOverrides.size !== permModalOverrides.size) {
    dirty = true;
  } else {
    for (const [k, v] of permModalOverrides) {
      if (permModalInitialOverrides.get(k) !== v) { dirty = true; break; }
    }
    if (!dirty) {
      for (const k of permModalInitialOverrides.keys()) {
        if (!permModalOverrides.has(k)) { dirty = true; break; }
      }
    }
  }
  saveBtn.disabled = !dirty;
  saveBtn.style.opacity = dirty ? '1' : '0.4';
}

function togglePermOverride(checkbox, key, isRoleDefault) {
  const isChecked = checkbox.checked;
  const row = checkbox.closest('tr');
  const indentClass = row.classList.contains('pt-indent') ? ' pt-indent' : '';

  if (isRoleDefault && isChecked) {
    permModalOverrides.delete(key);
    row.className = indentClass.trim();
  } else if (isRoleDefault && !isChecked) {
    permModalOverrides.set(key, false);
    row.className = ('perm-revoked' + indentClass).trim();
  } else if (!isRoleDefault && isChecked) {
    permModalOverrides.set(key, true);
    row.className = ('perm-granted' + indentClass).trim();
  } else if (!isRoleDefault && !isChecked) {
    permModalOverrides.delete(key);
    row.className = indentClass.trim();
  }
  updateSaveButtonState();
}

function closePermissionsModal() {
  document.getElementById('permissionsModal').classList.add('hidden');
  permModalUserId = null;
}

async function resetPermissions() {
  if (!permModalUserId) return;
  try {
    const { error } = await supabase
      .from('user_permissions')
      .delete()
      .eq('app_user_id', permModalUserId);
    if (error) throw error;
    showToast('Permissions reset to role defaults', 'success');
    // Reopen modal to refresh
    await showPermissionsModal(permModalUserId);
  } catch (e) {
    showToast('Failed to reset: ' + e.message, 'error');
  }
}

async function savePermissions() {
  if (!permModalUserId) return;
  try {
    // Delete all existing overrides for this user
    const { error: delError } = await supabase
      .from('user_permissions')
      .delete()
      .eq('app_user_id', permModalUserId);
    if (delError) throw delError;

    // Insert new overrides
    if (permModalOverrides.size > 0) {
      const rows = [];
      for (const [key, granted] of permModalOverrides) {
        rows.push({
          app_user_id: permModalUserId,
          permission_key: key,
          granted,
          granted_by: authState.appUser?.id,
        });
      }
      const { error: insertError } = await supabase
        .from('user_permissions')
        .insert(rows);
      if (insertError) throw insertError;
    }

    showToast('Permissions saved', 'success');
    closePermissionsModal();
  } catch (e) {
    showToast('Failed to save: ' + e.message, 'error');
  }
}

// Make functions globally accessible
window.revokeInvitation = revokeInvitation;
window.resendInvitation = resendInvitation;
window.updateUserRole = updateUserRole;
window.removeUser = removeUser;
window.copyInviteText = copyInviteText;
window.closeInviteModal = closeInviteModal;
window.showInvitationModal = showInvitationModal;
window.sendInviteEmail = sendInviteEmail;
window.toggleCurrentResident = toggleCurrentResident;
window.refreshResidencyStatus = refreshResidencyStatus;
window.showLinkPersonModal = showLinkPersonModal;
window.closeLinkPersonModal = closeLinkPersonModal;
window.confirmLinkPerson = confirmLinkPerson;
window.unlinkPerson = unlinkPerson;
window.showPermissionsModal = showPermissionsModal;
window.closePermissionsModal = closePermissionsModal;
window.togglePermOverride = togglePermOverride;
window.resetPermissions = resetPermissions;
window.savePermissions = savePermissions;
