// Supabase client configuration with auth support
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

// Wait for Supabase to be available (handles race condition with script loading)
function waitForSupabase(maxAttempts = 50) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (window.supabase?.createClient) {
        resolve(window.supabase);
      } else if (attempts >= maxAttempts) {
        reject(new Error('Supabase library failed to load'));
      } else {
        attempts++;
        setTimeout(check, 100);
      }
    };
    check();
  });
}

// Initialize Supabase client with auth configuration
let supabase;

// If supabase is already available, create client immediately
if (window.supabase?.createClient) {
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      storage: window.localStorage,
      storageKey: 'your-project-auth',
      flowType: 'pkce',
    },
  });
} else {
  // Wait for it to load
  await waitForSupabase();
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      storage: window.localStorage,
      storageKey: 'your-project-auth',
      flowType: 'pkce',
    },
  });
}

/**
 * Lightweight connectivity probe (HEAD request to REST endpoint).
 * Returns true if Supabase is reachable, false otherwise.
 * Used by supabase-health.js for recovery detection.
 */
async function pingSupabase() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/brand_config?select=id&limit=1`, {
      method: 'HEAD',
      headers: { 'apikey': SUPABASE_ANON_KEY },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    clearTimeout(timeout);
    return false;
  }
}

// Proactively refresh the session when the page returns from background.
// Mobile browsers suspend tabs when backgrounded — the auto-refresh timer
// doesn't fire, so the JWT can expire. This handler ensures the refresh
// token is exchanged for a new JWT as soon as the user comes back.
if (typeof document !== 'undefined') {
  let lastVisibleAt = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const elapsed = Date.now() - lastVisibleAt;
      // Only bother refreshing if backgrounded for > 5 minutes
      if (elapsed > 5 * 60 * 1000) {
        supabase.auth.getSession().then(({ data }) => {
          if (!data?.session) {
            // No session — try an explicit refresh using the stored refresh token
            supabase.auth.refreshSession();
          }
        });
      }
      lastVisibleAt = Date.now();
    } else {
      lastVisibleAt = Date.now();
    }
  });
}

// Export for use in other modules
export { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, pingSupabase };
