// Authentication module with Google OAuth and email/password support
import { supabase } from './supabase.js';

// Timeout configuration
const AUTH_TIMEOUT_MS = 15000; // 15 seconds for auth operations
const INIT_TIMEOUT_MS = 10000; // 10 seconds for initial auth check
const CACHED_AUTH_KEY = 'your-project-cached-auth';
const CACHED_AUTH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Split a display name into first_name and last_name.
 * Returns { first_name, last_name } or {} if name can't be parsed.
 */
function splitDisplayName(displayName) {
  if (!displayName) return {};
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return {};
  // Single word or looks like an email prefix — treat as first name only
  if (parts.length === 1) return { first_name: parts[0] };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

// Structured auth logger
const authLog = {
  _fmt(level, msg, data) {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = `[AUTH ${ts}]`;
    if (data !== undefined) {
      console[level](prefix, msg, data);
    } else {
      console[level](prefix, msg);
    }
  },
  info(msg, data) { this._fmt('log', msg, data); },
  warn(msg, data) { this._fmt('warn', msg, data); },
  error(msg, data) { this._fmt('error', msg, data); },
};

/**
 * Wrap a promise with a timeout to prevent indefinite hangs
 */
function withTimeout(promise, ms = AUTH_TIMEOUT_MS, errorMessage = 'Auth operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), ms)
    )
  ]);
}

/**
 * Retry a function with exponential backoff
 */
async function withRetry(fn, maxRetries = 2, baseDelayMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        authLog.info(`Retry attempt ${attempt + 1} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// Auth state
let currentUser = null;
let currentAppUser = null;
let currentRole = 'public';
let currentPermissions = new Set();
let authStateListeners = [];
let authHandlingInProgress = false; // Prevent concurrent auth handling
let pendingAuthSession = null; // Queue the latest session if one arrives while handling
let resolvedFromCache = false; // Track whether we initially resolved from cache

/**
 * Save verified auth state to localStorage for instant restore on next visit
 */
function cacheAuthState(user, appUser, role) {
  try {
    const cached = {
      email: user?.email,
      userId: user?.id,
      appUser: appUser ? { id: appUser.id, role: appUser.role, display_name: appUser.display_name, email: appUser.email, avatar_url: appUser.avatar_url, person_id: appUser.person_id, is_current_resident: appUser.is_current_resident } : null,
      role,
      timestamp: Date.now(),
    };
    localStorage.setItem(CACHED_AUTH_KEY, JSON.stringify(cached));
    authLog.info('Cached auth state', { email: cached.email, role });
  } catch (e) {
    authLog.warn('Failed to cache auth state', e.message);
  }
}

/**
 * Load cached auth state from localStorage (returns null if expired or missing)
 */
function loadCachedAuthState() {
  try {
    const raw = localStorage.getItem(CACHED_AUTH_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    const age = Date.now() - (cached.timestamp || 0);
    if (age > CACHED_AUTH_MAX_AGE_MS) {
      authLog.info('Cached auth expired', { ageMs: age });
      localStorage.removeItem(CACHED_AUTH_KEY);
      return null;
    }
    authLog.info('Loaded cached auth', { email: cached.email, role: cached.role, ageMinutes: Math.round(age / 60000) });
    return cached;
  } catch (e) {
    authLog.warn('Failed to load cached auth', e.message);
    return null;
  }
}

/**
 * Clear cached auth state (called on sign out)
 */
function clearCachedAuthState() {
  try {
    localStorage.removeItem(CACHED_AUTH_KEY);
    authLog.info('Cleared cached auth state');
  } catch (e) {
    // ignore
  }
}

/**
 * Initialize authentication and check for existing session
 * Uses cached auth state for instant access when available, verifies in background.
 * @returns {Promise<{user: object|null, role: string}>}
 */
export async function initAuth() {
  const initStart = performance.now();
  authLog.info('initAuth() started');

  // Check for cached auth state first - provides instant access
  const cached = loadCachedAuthState();

  return new Promise((resolve) => {
    let resolved = false;

    function doResolve(user, role, source) {
      if (resolved) return;
      resolved = true;
      const elapsed = Math.round(performance.now() - initStart);
      authLog.info(`initAuth() resolved via ${source} in ${elapsed}ms`, { hasUser: !!user, role });
      resolve({ user, role });
    }

    // If we have cached auth, use it to pre-populate state immediately
    // This lets the UI show content instantly while Supabase verifies in background
    if (cached?.appUser && ['oracle', 'admin', 'staff', 'resident', 'associate', 'demo', 'public', 'prospect'].includes(cached.role)) {
      authLog.info('Using cached auth for instant access');
      currentRole = cached.role;
      currentAppUser = cached.appUser;
      currentPermissions = new Set(); // permissions fetched fresh from Supabase, not cached
      resolvedFromCache = true;
      // We still need the actual Supabase user object, so we don't set currentUser yet
      // but we resolve with a minimal user so the UI can proceed
      const minimalUser = { id: cached.userId, email: cached.email, displayName: cached.appUser.display_name };
      currentUser = minimalUser;
      doResolve(minimalUser, cached.role, 'cache');
    }

    // Listen for auth changes (login, logout, token refresh)
    supabase.auth.onAuthStateChange(async (event, session) => {
      authLog.info(`onAuthStateChange fired: ${event}`, {
        hasSession: !!session,
        userEmail: session?.user?.email,
        expiresAt: session?.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
      });

      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        if (session?.user) {
          currentUser = session.user;
          authLog.info('Session user found', { email: session.user.email, id: session.user.id });

          // If we already resolved from cache, just update in background
          if (!resolved) {
            currentRole = 'pending';
            doResolve(currentUser, currentRole, `supabase:${event}`);
          }
          // Fetch full user record (updates cached state when complete)
          handleAuthChange(session);
        } else if (event === 'INITIAL_SESSION') {
          authLog.info('INITIAL_SESSION with no session - user not logged in');
          if (resolvedFromCache) {
            // Session expired but we already showed the page from cache.
            // Don't nuke state and cause a disruptive redirect — keep the cached
            // state so the page stays visible. The user will be prompted to
            // re-authenticate only if an API call fails with 401.
            authLog.warn('Supabase session gone but page loaded from cache — keeping cached state (session needs refresh)');
            // Don't clear cache, don't reset state, don't notify listeners.
            // The page continues to work with cached identity until a
            // Supabase API call forces re-auth.
          } else if (cached) {
            // Cache exists but we didn't resolve from it (shouldn't normally happen)
            authLog.warn('Cached auth exists but Supabase session gone — clearing cache');
            clearCachedAuthState();
            currentUser = null;
            currentAppUser = null;
            currentRole = 'public';
            currentPermissions = new Set();
            notifyListeners();
          }
          doResolve(null, 'public', 'supabase:no-session');
        }
      } else if (event === 'SIGNED_OUT') {
        authLog.info('User signed out');
        currentUser = null;
        currentAppUser = null;
        currentRole = 'public';
        currentPermissions = new Set();
        clearCachedAuthState();
        notifyListeners();
        doResolve(null, 'public', 'supabase:signed-out');
      }
    });

    // Timeout fallback
    setTimeout(() => {
      if (!resolved) {
        authLog.warn(`initAuth() timed out after ${INIT_TIMEOUT_MS}ms`);
        doResolve(currentUser, currentRole, 'timeout');
      }
    }, INIT_TIMEOUT_MS);
  });
}

/**
 * Handle auth state changes - fetch user role from app_users
 */
async function handleAuthChange(session) {
  const start = performance.now();
  authLog.info('handleAuthChange() started', { email: session?.user?.email });

  if (!session?.user) {
    authLog.info('handleAuthChange() - no user in session, clearing state');
    currentUser = null;
    currentAppUser = null;
    currentRole = 'public';
    currentPermissions = new Set();
    clearCachedAuthState();
    notifyListeners();
    return;
  }

  // Prevent concurrent auth handling (can happen with INITIAL_SESSION + SIGNED_IN events)
  // Instead of dropping the event, queue it so the latest session is always processed.
  if (authHandlingInProgress) {
    authLog.info('handleAuthChange() queued - already in progress');
    pendingAuthSession = session;
    return;
  }
  authHandlingInProgress = true;

  try {
    currentUser = session.user;
    currentRole = 'pending';
    authLog.info('Fetching app_user record...', { authUserId: session.user.id });

  // Fetch user record from app_users table (with timeout and retry)
  let appUser = null;
  let fetchError = null;
  try {
    const fetchStart = performance.now();
    const result = await withRetry(async () => {
      return await withTimeout(
        supabase
          .from('app_users')
          .select('id, role, display_name, email, avatar_url, person_id, is_current_resident')
          .eq('auth_user_id', session.user.id)
          .single(),
        AUTH_TIMEOUT_MS,
        'Fetching user record timed out'
      );
    }, 2, 1000);
    appUser = result.data;
    fetchError = result.error;
    const fetchElapsed = Math.round(performance.now() - fetchStart);
    authLog.info(`app_users fetch completed in ${fetchElapsed}ms`, { found: !!appUser, error: fetchError?.message });
  } catch (timeoutError) {
    authLog.error('app_users fetch failed after retries', timeoutError.message);
    fetchError = timeoutError;
  }

  if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 = no rows found
    authLog.error('Error fetching app_user', { code: fetchError.code, message: fetchError.message });
  }

  if (appUser) {
    currentAppUser = appUser;
    currentRole = appUser.role;
    currentUser.displayName = appUser.display_name || currentUser.user_metadata?.full_name || currentUser.email;
    authLog.info('User role resolved', { role: appUser.role, displayName: currentUser.displayName });

    // Fetch effective permissions (role defaults ± user overrides)
    try {
      const { data: permData, error: permError } = await withTimeout(
        supabase.rpc('get_effective_permissions', { p_app_user_id: appUser.id }),
        AUTH_TIMEOUT_MS,
        'Permission fetch timed out'
      );
      if (!permError && permData) {
        currentPermissions = new Set(permData);
        authLog.info('Permissions loaded', { count: currentPermissions.size });
      } else {
        authLog.warn('Failed to fetch permissions, keeping existing', permError?.message);
        // Keep cached permissions if we have them, only clear if truly empty
        if (currentPermissions.size === 0) {
          authLog.warn('No cached permissions available either');
        }
      }
    } catch (permTimeoutError) {
      authLog.warn('Permission fetch timed out, keeping existing permissions');
      // Keep cached permissions — don't clear on network failure
    }

    // Cache the verified auth state for instant restore on next visit
    cacheAuthState(currentUser, appUser, appUser.role);

    // Update last login timestamp (fire and forget with timeout - don't block auth)
    withTimeout(
      supabase
        .from('app_users')
        .update({ last_login_at: new Date().toISOString() })
        .eq('auth_user_id', session.user.id),
      5000,
      'Last login update timed out'
    ).catch(err => authLog.warn('Failed to update last login', err.message));
  } else {
    // User not in app_users - check for pending invitation (with timeout)
    const userEmail = session.user.email?.toLowerCase();
    authLog.info('User not in app_users, checking invitations', { email: userEmail });
    let invitation = null;
    let invError = null;

    try {
      const result = await withTimeout(
        supabase
          .from('user_invitations')
          .select('*')
          .eq('email', userEmail)
          .eq('status', 'pending')
          .order('invited_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        AUTH_TIMEOUT_MS,
        'Invitation check timed out'
      );
      invitation = result.data;
      invError = result.error;
      authLog.info('Invitation check result', { found: !!invitation, error: invError?.message });
    } catch (timeoutError) {
      authLog.warn('Invitation check timed out', timeoutError.message);
      invError = timeoutError;
    }

    if (invitation && !invError) {
      authLog.info('Found pending invitation, creating app_user', { role: invitation.role });
      const displayName = session.user.user_metadata?.full_name || userEmail.split('@')[0];

      // Try to find an existing person record to link
      let personId = null;
      try {
        const { data: existingPerson } = await supabase
          .from('people').select('id').eq('email', userEmail).maybeSingle();
        if (existingPerson) personId = existingPerson.id;
      } catch (e) { /* non-critical */ }

      let newAppUser = null;
      let createError = null;
      try {
        const insertData = {
          auth_user_id: session.user.id,
          email: userEmail,
          display_name: displayName,
          ...splitDisplayName(displayName),
          role: invitation.role,
          invited_by: invitation.invited_by,
        };
        if (personId) insertData.person_id = personId;

        const result = await withTimeout(
          supabase
            .from('app_users')
            .insert(insertData)
            .select()
            .single(),
          AUTH_TIMEOUT_MS,
          'User creation timed out'
        );
        newAppUser = result.data;
        createError = result.error;
      } catch (timeoutError) {
        authLog.warn('User creation timed out', timeoutError.message);
        createError = timeoutError;
      }

      if (!createError && newAppUser) {
        authLog.info('Created app_user from invitation', { role: newAppUser.role });
        // Mark invitation as accepted (fire and forget - don't block auth)
        withTimeout(
          supabase
            .from('user_invitations')
            .update({ status: 'accepted' })
            .eq('id', invitation.id),
          5000,
          'Invitation update timed out'
        ).catch(err => authLog.warn('Failed to mark invitation accepted', err.message));

        currentAppUser = newAppUser;
        currentRole = newAppUser.role;
        currentUser.displayName = displayName;

        // Cache the new auth state
        cacheAuthState(currentUser, newAppUser, newAppUser.role);
      } else {
        authLog.error('Error creating app_user from invitation', createError);
        currentAppUser = null;
        currentRole = 'unauthorized';
        currentUser.displayName = session.user.user_metadata?.full_name || session.user.email;
      }
    } else {
      // No invitation found — auto-create as public user
      authLog.info('No invitation found — auto-creating as public user', { email: userEmail });
      const displayName = session.user.user_metadata?.full_name || userEmail.split('@')[0];

      let newPublicUser = null;
      let publicCreateError = null;
      try {
        const result = await withTimeout(
          supabase
            .from('app_users')
            .insert({
              auth_user_id: session.user.id,
              email: userEmail,
              display_name: displayName,
              ...splitDisplayName(displayName),
              role: 'public',
            })
            .select()
            .single(),
          AUTH_TIMEOUT_MS,
          'Public user creation timed out'
        );
        newPublicUser = result.data;
        publicCreateError = result.error;
      } catch (timeoutError) {
        authLog.warn('Public user creation timed out', timeoutError.message);
        publicCreateError = timeoutError;
      }

      if (!publicCreateError && newPublicUser) {
        authLog.info('Created public app_user', { email: userEmail });
        currentAppUser = newPublicUser;
        currentRole = 'public';
        currentUser.displayName = displayName;
        cacheAuthState(currentUser, newPublicUser, 'public');
      } else {
        authLog.error('Error creating public app_user', publicCreateError);
        currentAppUser = null;
        currentRole = 'unauthorized';
        currentUser.displayName = session.user.user_metadata?.full_name || session.user.email;
      }
    }
  }

  const elapsed = Math.round(performance.now() - start);
  authLog.info(`handleAuthChange() completed in ${elapsed}ms`, { role: currentRole });
  notifyListeners();
  } finally {
    authHandlingInProgress = false;
    // If another auth event arrived while we were processing, handle it now
    if (pendingAuthSession) {
      const queued = pendingAuthSession;
      pendingAuthSession = null;
      authLog.info('Processing queued auth session');
      handleAuthChange(queued);
    }
  }
}

/**
 * Sign in with Google OAuth
 * @param {string} redirectTo - URL to redirect to after sign in
 */
export async function signInWithGoogle(redirectTo) {
  authLog.info('signInWithGoogle() called', { redirectTo });
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: redirectTo || window.location.origin + '/spaces/admin/',
      queryParams: {
        prompt: 'select_account',
      },
    },
  });

  if (error) {
    authLog.error('signInWithGoogle() error', error);
    throw error;
  }

  authLog.info('signInWithGoogle() redirecting to Google');
  return data;
}

/**
 * Sign in with email and password
 * @param {string} email
 * @param {string} password
 * @returns {Promise<object>} Session data
 */
export async function signInWithPassword(email, password) {
  authLog.info('signInWithPassword() called', { email });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    authLog.error('signInWithPassword() error', error);
    throw error;
  }
  authLog.info('signInWithPassword() success', { email: data.user?.email });
  return data;
}

/**
 * Sign up with email and password (creates a new Supabase auth user)
 * @param {string} email
 * @param {string} password
 * @returns {Promise<object>} Session data (user will need to confirm email)
 */
export async function signUpWithPassword(email, password) {
  authLog.info('signUpWithPassword() called', { email });
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    authLog.error('signUpWithPassword() error', error);
    throw error;
  }
  authLog.info('signUpWithPassword() success', { email: data.user?.email, confirmed: !!data.session });
  return data;
}

/**
 * Send a password reset email
 * @param {string} email
 * @param {string} redirectTo - URL to redirect to after clicking reset link
 */
export async function resetPasswordForEmail(email, redirectTo) {
  authLog.info('resetPasswordForEmail() called', { email, redirectTo });
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) {
    authLog.error('resetPasswordForEmail() error', error);
    throw error;
  }
  authLog.info('resetPasswordForEmail() email sent');
}

/**
 * Update the current user's password
 * @param {string} newPassword
 */
export async function updatePassword(newPassword) {
  authLog.info('updatePassword() called');
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    authLog.error('updatePassword() error', error);
    throw error;
  }
  authLog.info('updatePassword() success');
}

/**
 * Sign out the current user
 */
export async function signOut() {
  authLog.info('signOut() called');

  const { error } = await supabase.auth.signOut();

  if (error) {
    authLog.error('signOut() error', error);
    throw error;
  }

  // Clear cache AFTER successful sign out to avoid inconsistent state on error
  clearCachedAuthState();
  currentUser = null;
  currentAppUser = null;
  currentRole = 'public';
  currentPermissions = new Set();
  authLog.info('signOut() completed');
  notifyListeners();
}

/**
 * Get the current authentication state
 * @returns {{user: object|null, appUser: object|null, role: string, isAuthenticated: boolean, isAdmin: boolean, isStaff: boolean, isAuthorized: boolean}}
 */
export function getAuthState() {
  return {
    user: currentUser,
    appUser: currentAppUser,
    role: currentRole,
    isAuthenticated: currentUser !== null,
    isAdmin: ['admin', 'oracle'].includes(currentRole),
    isStaff: ['staff', 'admin', 'oracle'].includes(currentRole),
    isResident: ['resident', 'associate', 'staff', 'admin', 'oracle'].includes(currentRole),
    isPublic: currentRole === 'public',
    // Treat 'pending' as authorized to allow redirect while we verify in background
    isAuthorized: ['oracle', 'admin', 'staff', 'resident', 'associate', 'demo', 'public', 'prospect', 'pending'].includes(currentRole),
    isUnauthorized: currentRole === 'unauthorized',
    isPending: currentRole === 'pending',
    isCurrentResident: currentAppUser?.is_current_resident === true,
    // Granular permissions
    permissions: currentPermissions,
    hasPermission: (key) => currentPermissions.has(key),
    hasAnyPermission: (...keys) => keys.some(k => currentPermissions.has(k)),
  };
}

/**
 * Check if the current user has a specific permission
 * @param {string} permKey - Permission key to check
 * @returns {boolean}
 */
export function hasPermission(permKey) {
  return currentPermissions.has(permKey);
}

/**
 * Check if the current user has any of the specified permissions
 * @param {...string} permKeys - Permission keys to check
 * @returns {boolean}
 */
export function hasAnyPermission(...permKeys) {
  return permKeys.some(k => currentPermissions.has(k));
}

/**
 * Subscribe to auth state changes
 * @param {function} callback - Called with auth state on changes
 * @returns {function} Unsubscribe function
 */
export function onAuthStateChange(callback) {
  authStateListeners.push(callback);

  // Return unsubscribe function
  return () => {
    authStateListeners = authStateListeners.filter(cb => cb !== callback);
  };
}

/**
 * Notify all listeners of auth state change
 */
function notifyListeners() {
  const state = getAuthState();
  authLog.info('Notifying listeners', { role: state.role, isAuthenticated: state.isAuthenticated, listenerCount: authStateListeners.length });
  authStateListeners.forEach(cb => cb(state));
}

/**
 * Guard: Require authentication, redirect to login if not authenticated
 * @param {string} redirectUrl - URL to redirect to if not authenticated
 * @returns {boolean} True if authenticated
 */
export function requireAuth(redirectUrl = '/login/') {
  const state = getAuthState();

  if (!state.isAuthenticated) {
    const currentPath = window.location.pathname;
    window.location.href = redirectUrl + '?redirect=' + encodeURIComponent(currentPath);
    return false;
  }

  return true;
}

/**
 * Guard: Require a specific role, redirect if insufficient permissions
 * @param {string} role - Required role ('admin' or 'staff')
 * @param {string} redirectUrl - URL to redirect to if unauthorized
 * @returns {boolean} True if user has required role
 */
export function requireRole(role, redirectUrl = '/spaces/') {
  const state = getAuthState();

  if (!state.isAuthenticated) {
    const currentPath = window.location.pathname;
    window.location.href = '/login/?redirect=' + encodeURIComponent(currentPath);
    return false;
  }

  if (state.isUnauthorized) {
    // User logged in but not in app_users - show unauthorized message
    return false;
  }

  if (role === 'admin' && !state.isAdmin) {
    alert('Admin access required');
    window.location.href = redirectUrl;
    return false;
  }

  if (role === 'staff' && !state.isStaff) {
    alert('Staff access required');
    window.location.href = redirectUrl;
    return false;
  }

  if (role === 'resident' && !state.isResident) {
    alert('Resident access required');
    window.location.href = redirectUrl;
    return false;
  }

  return true;
}

/**
 * Check if user can perform admin actions (for conditional UI)
 * @returns {boolean}
 */
export function canEdit() {
  return getAuthState().isAdmin;
}

/**
 * Check if user can view all data including unlisted/secret
 * @returns {boolean}
 */
export function canViewAll() {
  return getAuthState().isStaff;
}
