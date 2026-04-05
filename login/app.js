// Login page application
import { supabase } from '../shared/supabase.js';
import { initAuth, signInWithGoogle, signInWithPassword, signUpWithPassword, signOut, getAuthState, onAuthStateChange } from '../shared/auth.js';

const CACHED_AUTH_KEY = 'your-project-cached-auth';

// DOM elements
const loginContent = document.getElementById('loginContent');
const loadingContent = document.getElementById('loadingContent');
const errorContent = document.getElementById('errorContent');
const unauthorizedContent = document.getElementById('unauthorizedContent');
const signUpSuccessContent = document.getElementById('signUpSuccessContent');
const googleSignInBtn = document.getElementById('googleSignIn');
const errorMessage = document.getElementById('errorMessage');
const retryBtn = document.getElementById('retryBtn');
const noAccountContent = document.getElementById('noAccountContent');
const noAccountEmail = document.getElementById('noAccountEmail');

// Tab elements
const tabSignIn = document.getElementById('tabSignIn');
const tabSignUp = document.getElementById('tabSignUp');
const signInPane = document.getElementById('signInPane');
const signUpPane = document.getElementById('signUpPane');

// Get redirect URL from query params or localStorage (survives OAuth round-trip)
const urlParams = new URLSearchParams(window.location.search);
const redirectUrl = urlParams.get('redirect')
  || localStorage.getItem('your-project-login-redirect')
  || '/spaces/admin/';

console.log('[LOGIN]', 'Page loaded', { redirectUrl, href: window.location.href });

/**
 * Show a specific UI state
 */
function showState(state, message = '') {
  console.log('[LOGIN]', `showState(${state})`, message || '');
  // Make the page visible (was hidden to prevent login form flash on cached-auth redirect)
  document.body.classList.add('ready');

  loginContent.classList.add('hidden');
  loadingContent.classList.add('hidden');
  errorContent.classList.add('hidden');
  noAccountContent.classList.add('hidden');
  unauthorizedContent.classList.add('hidden');
  signUpSuccessContent.classList.add('hidden');

  switch (state) {
    case 'login':
      loginContent.classList.remove('hidden');
      break;
    case 'loading':
      loadingContent.classList.remove('hidden');
      break;
    case 'error':
      errorContent.classList.remove('hidden');
      errorMessage.textContent = message || 'An error occurred';
      break;
    case 'noAccount':
      noAccountContent.classList.remove('hidden');
      if (noAccountEmail) noAccountEmail.textContent = message || '';
      break;
    case 'unauthorized':
      unauthorizedContent.classList.remove('hidden');
      break;
    case 'signUpSuccess':
      signUpSuccessContent.classList.remove('hidden');
      break;
  }
}

/**
 * Get the appropriate redirect target based on user role
 */
function getRedirectTarget(role) {
  let target = redirectUrl;
  // Public users always go to consumer spaces view
  if (['public'].includes(role)) {
    target = '/spaces/';
  }
  // Resident/associate users go to resident area by default (not admin)
  else if (target === '/spaces/admin/' && ['resident', 'associate'].includes(role)) {
    target = '/residents/cameras.html';
  }
  return target;
}

/**
 * Initialize the login page
 */
async function init() {
  // Fast path: check cached auth first for instant redirect
  // (only if we have a fully resolved role, not 'pending')
  try {
    const raw = localStorage.getItem(CACHED_AUTH_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      const age = Date.now() - (cached.timestamp || 0);
      if (age < 90 * 24 * 60 * 60 * 1000 && ['oracle', 'admin', 'staff', 'resident', 'associate', 'public'].includes(cached.role)) {
        const targetUrl = getRedirectTarget(cached.role);
        console.log('[LOGIN]', 'Cached auth found, redirecting immediately', { email: cached.email, role: cached.role });
        localStorage.removeItem('your-project-login-redirect');
        window.location.href = targetUrl;
        return;
      }
    }
  } catch (e) {
    // ignore cache errors
  }

  showState('loading');

  try {
    // Run initAuth which handles both existing sessions and OAuth callbacks (PKCE code exchange)
    console.log('[LOGIN]', 'Running initAuth() (handles existing session + OAuth callback)...');
    await initAuth();

    // If role is still 'pending', wait for handleAuthChange() to finish resolving the role.
    // This prevents redirecting to /spaces/admin/ before we know the user's actual role,
    // which caused a redirect loop for new users (admin page rejects non-admin → back to login).
    let state = getAuthState();
    if (state.isAuthenticated && state.isPending) {
      console.log('[LOGIN]', 'Role is pending, waiting for full resolution...');
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.log('[LOGIN]', 'Timed out waiting for role resolution after 12s');
          resolve();
        }, 12000);
        const unsub = onAuthStateChange((newState) => {
          if (!newState.isPending) {
            console.log('[LOGIN]', 'Role resolved:', newState.role);
            clearTimeout(timeout);
            unsub();
            resolve();
          }
        });
      });
    }

    checkAuthAndRedirect();
  } catch (error) {
    console.error('[LOGIN]', 'Auth init error:', error);
    showState('error', error.message);
  }
}

function checkAuthAndRedirect() {
  const state = getAuthState();
  console.log('[LOGIN]', 'checkAuthAndRedirect()', {
    isAuthenticated: state.isAuthenticated,
    isAuthorized: state.isAuthorized,
    isUnauthorized: state.isUnauthorized,
    role: state.role,
    email: state.user?.email,
  });

  if (state.isAuthenticated) {
    if (state.isAuthorized) {
      const targetUrl = getRedirectTarget(state.role);
      console.log('[LOGIN]', 'Authorized — redirecting to:', targetUrl);
      localStorage.removeItem('your-project-login-redirect');
      window.location.href = targetUrl;
    } else if (state.isUnauthorized) {
      console.log('[LOGIN]', 'Authenticated but unauthorized');
      showState('unauthorized');
    } else {
      console.log('[LOGIN]', 'Unexpected auth state, showing login');
      showState('login');
    }
  } else {
    console.log('[LOGIN]', 'Not authenticated, showing login form');
    showState('login');
  }
}

// Tab switching
tabSignIn.addEventListener('click', () => {
  tabSignIn.classList.add('active');
  tabSignUp.classList.remove('active');
  signInPane.classList.remove('hidden');
  signUpPane.classList.add('hidden');
});

tabSignUp.addEventListener('click', () => {
  tabSignUp.classList.add('active');
  tabSignIn.classList.remove('active');
  signUpPane.classList.remove('hidden');
  signInPane.classList.add('hidden');
});

// Email/password sign-in form handler
const emailPasswordForm = document.getElementById('emailPasswordForm');
emailPasswordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  console.log('[LOGIN]', 'Email/password form submitted');
  showState('loading');

  const email = document.getElementById('emailInput').value.trim();
  const password = document.getElementById('passwordInput').value;

  try {
    // Listen for the SIGNED_IN event before triggering sign-in
    const unsub = onAuthStateChange((state) => {
      if (state.isAuthenticated) {
        unsub();
        checkAuthAndRedirect();
      }
    });
    await signInWithPassword(email, password);
  } catch (error) {
    console.error('[LOGIN]', 'Email/password sign in error:', error);
    const msg = error.message || '';
    if (msg.toLowerCase().includes('invalid login credentials')) {
      // Supabase returns the same error for wrong password AND non-existent account.
      // Show a neutral message that covers both cases instead of "No account found".
      showState('error', 'Incorrect email or password. Please try again, or sign up for a new account.');
    } else {
      showState('error', msg);
    }
  }
});

// Sign-up form handler
const signUpForm = document.getElementById('signUpForm');
signUpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  console.log('[LOGIN]', 'Sign-up form submitted');

  const email = document.getElementById('signUpEmail').value.trim();
  const password = document.getElementById('signUpPassword').value;
  const confirm = document.getElementById('signUpConfirm').value;

  if (password !== confirm) {
    showState('error', 'Passwords do not match');
    return;
  }

  if (password.length < 6) {
    showState('error', 'Password must be at least 6 characters');
    return;
  }

  showState('loading');

  try {
    const data = await signUpWithPassword(email, password);
    // If Supabase returns a session immediately (email confirmation disabled), redirect
    if (data.session) {
      const unsub = onAuthStateChange((state) => {
        if (state.isAuthenticated) {
          unsub();
          checkAuthAndRedirect();
        }
      });
    } else {
      // Email confirmation required — show success message
      console.log('[LOGIN]', 'Sign-up success, awaiting email verification');
      showState('signUpSuccess');
    }
  } catch (error) {
    console.error('[LOGIN]', 'Sign-up error:', error);
    showState('error', error.message);
  }
});

// Back to sign in from success screen
const backToSignInBtn = document.getElementById('backToSignInBtn');
backToSignInBtn.addEventListener('click', () => {
  showState('login');
  tabSignIn.classList.add('active');
  tabSignUp.classList.remove('active');
  signInPane.classList.remove('hidden');
  signUpPane.classList.add('hidden');
});

// Google sign in
googleSignInBtn.addEventListener('click', async () => {
  console.log('[LOGIN]', 'Google sign-in button clicked');
  showState('loading');

  try {
    // Redirect URL: use just /login/ so Supabase can append ?code= cleanly (PKCE flow)
    // We store the intended destination in sessionStorage so it survives the OAuth round-trip
    localStorage.setItem('your-project-login-redirect', redirectUrl);
    // In Capacitor (native app), use the custom URL scheme for OAuth redirect
    const isCapacitor = window.Capacitor?.isNativePlatform?.() ?? false;
    const loginRedirect = isCapacitor
      ? 'com.yourorg.app://login/'
      : window.location.origin + '/login/';
    console.log('[LOGIN]', 'Calling signInWithGoogle()', { loginRedirect, storedRedirect: redirectUrl, isCapacitor });
    await signInWithGoogle(loginRedirect);
    // Note: signInWithGoogle redirects to Google, so this line won't execute
  } catch (error) {
    console.error('[LOGIN]', 'Sign in error:', error);
    showState('error', error.message);
  }
});

retryBtn.addEventListener('click', () => {
  console.log('[LOGIN]', 'Retry clicked');
  showState('login');
});

// No-account state: switch to Sign Up tab
const noAccountSignUpBtn = document.getElementById('noAccountSignUp');
if (noAccountSignUpBtn) {
  noAccountSignUpBtn.addEventListener('click', () => {
    showState('login');
    // Switch to Sign Up tab
    tabSignUp.classList.add('active');
    tabSignIn.classList.remove('active');
    signUpPane.classList.remove('hidden');
    signInPane.classList.add('hidden');
    // Pre-fill email if available
    const email = noAccountEmail?.textContent?.trim();
    if (email) {
      const signUpEmailInput = document.getElementById('signUpEmail');
      if (signUpEmailInput) signUpEmailInput.value = email;
    }
  });
}

// No-account state: try Google instead
const noAccountGoogleBtn = document.getElementById('noAccountGoogle');
if (noAccountGoogleBtn) {
  noAccountGoogleBtn.addEventListener('click', () => {
    googleSignInBtn.click();
  });
}

// Sign out button (for unauthorized users to try another account)
const signOutBtn = document.getElementById('signOutBtn');
if (signOutBtn) {
  signOutBtn.addEventListener('click', async () => {
    console.log('[LOGIN]', 'Sign out clicked');
    showState('loading');
    try {
      await signOut();
      showState('login');
    } catch (error) {
      console.error('[LOGIN]', 'Sign out error:', error);
      showState('error', error.message);
    }
  });
}

// Initialize on page load
init();
