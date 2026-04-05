/**
 * Oven Data Service
 * Loads Anova Precision Oven data from Supabase and sends control commands via edge function.
 * No DOM code — just data fetching and commands.
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabase.js';

const ANOVA_CONTROL_URL = `${SUPABASE_URL}/functions/v1/anova-control`;

// =============================================
// API WRAPPER
// =============================================

async function anovaApi(action, params = {}) {
  let { data: { session } } = await supabase.auth.getSession();
  if (session) {
    const expiresAt = session.expires_at;
    const now = Math.floor(Date.now() / 1000);
    if (!expiresAt || expiresAt - now < 60) {
      const { data } = await supabase.auth.refreshSession();
      session = data.session;
    }
  } else {
    const { data } = await supabase.auth.refreshSession();
    session = data.session;
  }
  const token = session?.access_token;
  if (!token) throw new Error('No auth token');

  const response = await fetch(ANOVA_CONTROL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action, ...params }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `API error ${response.status}`);
  }
  return response.json();
}

// =============================================
// DATA LOADING
// =============================================

export async function loadOvens() {
  const { data, error } = await supabase
    .from('anova_ovens')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) throw error;
  return data || [];
}

// =============================================
// COMMANDS (via edge function → Anova WebSocket)
// =============================================

export async function refreshOvenState(ovenId) {
  return anovaApi('getStatus', { ovenId });
}

export async function startCook(ovenId, stages) {
  return anovaApi('startCook', { ovenId, stages });
}

export async function stopCook(ovenId) {
  return anovaApi('stopCook', { ovenId });
}

// =============================================
// DISPLAY HELPERS
// =============================================

export function getOvenStateDisplay(oven) {
  const s = oven.last_state;
  if (!s) return { text: 'No data', color: 'var(--text-muted)', isCooking: false };

  const online = s.systemInfo?.online;
  if (!online) return { text: 'Offline', color: 'var(--text-muted)', isCooking: false };

  const mode = s.state?.mode;
  const timerMode = s.nodes?.timer?.mode;

  if (mode === 'cook' || mode === 'preheating') {
    if (timerMode === 'running') return { text: 'Cooking', color: 'var(--available)', isCooking: true };
    return { text: 'Preheating', color: '#f59e0b', isCooking: true };
  }

  if (mode === 'idle' || !mode) return { text: 'Idle', color: 'var(--text-muted)', isCooking: false };

  return { text: mode, color: 'var(--text-muted)', isCooking: false };
}

export function getCurrentTemp(oven) {
  const s = oven.last_state;
  if (!s?.nodes?.temperatureBulbs) return null;
  const mode = s.nodes.temperatureBulbs.mode || 'dry';
  const bulb = s.nodes.temperatureBulbs[mode];
  return bulb?.current?.fahrenheit ?? null;
}

export function getTargetTemp(oven) {
  const s = oven.last_state;
  if (!s?.nodes?.temperatureBulbs) return null;
  const mode = s.nodes.temperatureBulbs.mode || 'dry';
  const bulb = s.nodes.temperatureBulbs[mode];
  return bulb?.setpoint?.fahrenheit ?? null;
}

export function getProbeTemp(oven) {
  const s = oven.last_state;
  if (!s?.nodes?.temperatureProbe) return null;
  return s.nodes.temperatureProbe.current?.fahrenheit ?? null;
}

export function getTimerDisplay(oven) {
  const s = oven.last_state;
  if (!s?.nodes?.timer) return null;
  const timer = s.nodes.timer;
  if (timer.mode === 'idle' || !timer.initial) return null;

  const elapsed = timer.current || 0;
  const total = timer.initial || 0;
  const remaining = Math.max(0, total - elapsed);
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const progress = total > 0 ? Math.round((elapsed / total) * 100) : 0;

  return {
    elapsed,
    total,
    remaining,
    progress: Math.min(100, progress),
    display: mins > 0 ? `${mins}m ${secs}s` : `${secs}s`,
  };
}

export function getDoorStatus(oven) {
  const s = oven.last_state;
  if (!s?.nodes?.door) return null;
  return s.nodes.door.closed ? 'Closed' : 'Open';
}

export function getFanSpeed(oven) {
  const s = oven.last_state;
  return s?.nodes?.fan?.speed ?? null;
}

export function getSteamInfo(oven) {
  const s = oven.last_state;
  if (!s?.nodes?.steamGenerators) return null;
  const sg = s.nodes.steamGenerators;
  return {
    mode: sg.mode || 'idle',
    humidity: sg.relativeHumidity?.current ?? null,
    humidityTarget: sg.relativeHumidity?.setpoint ?? null,
  };
}

export function getHeatingElements(oven) {
  const s = oven.last_state;
  if (!s?.nodes?.heatingElements) return null;
  const he = s.nodes.heatingElements;
  return {
    top: he.top?.on ?? false,
    bottom: he.bottom?.on ?? false,
    rear: he.rear?.on ?? false,
  };
}

export function isWaterTankEmpty(oven) {
  return oven.last_state?.nodes?.waterTank?.empty ?? false;
}

export function formatSyncTime(lastSyncedAt) {
  if (!lastSyncedAt) return 'Never synced';
  const diff = Date.now() - new Date(lastSyncedAt).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return new Date(lastSyncedAt).toLocaleDateString();
}

/**
 * Build a single-stage cook payload from simple parameters.
 */
export function buildSimpleCookStages({
  temperatureF = 350,
  mode = 'dry',
  timerMinutes = null,
  fanSpeed = 100,
  steamPercent = null,
  heatingElements = null,
} = {}) {
  const celsius = Math.round(((temperatureF - 32) * 5) / 9 * 2) / 2;

  const stage = {
    id: crypto.randomUUID(),
    type: 'cook',
    userActionRequired: false,
    temperatureBulbs: {
      mode,
      dry: { setpoint: { celsius } },
    },
    heatingElements: heatingElements || {
      top: { on: true },
      bottom: { on: false },
      rear: { on: true },
    },
    fan: { speed: fanSpeed },
    vent: { open: false },
  };

  if (mode === 'wet') {
    stage.temperatureBulbs.wet = { setpoint: { celsius: Math.min(celsius, 100) } };
  }

  if (timerMinutes) {
    stage.timer = {
      initial: timerMinutes * 60,
      startType: 'when-preheated',
    };
  }

  if (steamPercent != null) {
    stage.steamGenerators = {
      mode: 'steam-percentage',
      steamPercentage: { setpoint: steamPercent },
    };
  }

  return [stage];
}
