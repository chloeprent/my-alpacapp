/**
 * 3D Printer Data Service
 * Loads FlashForge printer data from Supabase and sends control commands via edge function.
 * No DOM code — just data fetching and commands.
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabase.js';

const PRINTER_CONTROL_URL = `${SUPABASE_URL}/functions/v1/printer-control`;

// =============================================
// API WRAPPER
// =============================================

async function printerApi(action, params = {}) {
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

  const response = await fetch(PRINTER_CONTROL_URL, {
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

export async function loadPrinters() {
  const { data, error } = await supabase
    .from('printer_devices')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) throw error;
  return data || [];
}

// =============================================
// COMMANDS (via edge function → printer proxy → TCP)
// =============================================

export async function refreshPrinterStatus(printerId) {
  return printerApi('getStatus', { printerId });
}

export async function startPrint(printerId, filename) {
  return printerApi('startPrint', { printerId, filename });
}

export async function pausePrint(printerId) {
  return printerApi('pausePrint', { printerId });
}

export async function resumePrint(printerId) {
  return printerApi('resumePrint', { printerId });
}

export async function cancelPrint(printerId) {
  return printerApi('cancelPrint', { printerId });
}

export async function setNozzleTemp(printerId, tempC) {
  return printerApi('setTemperature', { printerId, target: 'nozzle', tempC });
}

export async function setBedTemp(printerId, tempC) {
  return printerApi('setTemperature', { printerId, target: 'bed', tempC });
}

export async function toggleLight(printerId, on) {
  return printerApi('toggleLight', { printerId, on });
}

export async function homeAxes(printerId) {
  return printerApi('homeAxes', { printerId });
}

export async function listFiles(printerId) {
  return printerApi('listFiles', { printerId });
}

// =============================================
// DISPLAY HELPERS
// =============================================

/**
 * Get display state from a printer device record.
 */
export function getPrinterStateDisplay(printer) {
  const s = printer.last_state;
  if (!s) return { text: 'No data', color: 'var(--text-muted)', isPrinting: false };

  const status = s.machineStatus;

  if (status === 'BUILDING_FROM_SD' || status === 'BUILDING_COMPLETED' || s.printing) {
    const progress = s.printProgress;
    if (progress && progress.percent >= 100) {
      return { text: 'Complete', color: 'var(--available)', isPrinting: false };
    }
    return { text: 'Printing', color: 'var(--available)', isPrinting: true };
  }

  if (status === 'PAUSED') {
    return { text: 'Paused', color: '#f59e0b', isPrinting: true };
  }

  if (status === 'READY') {
    return { text: 'Ready', color: 'var(--text-muted)', isPrinting: false };
  }

  if (status === 'BUSY') {
    return { text: 'Busy', color: '#f59e0b', isPrinting: false };
  }

  // Check if nozzle or bed is heating
  if (s.nozzle && s.nozzle.target > 0) {
    return { text: 'Heating', color: '#f59e0b', isPrinting: false };
  }

  return { text: status || 'Unknown', color: 'var(--text-muted)', isPrinting: false };
}

/**
 * Get nozzle temperature info.
 */
export function getNozzleTemp(printer) {
  const s = printer.last_state;
  if (!s?.nozzle) return null;
  return { current: s.nozzle.current, target: s.nozzle.target };
}

/**
 * Get bed temperature info.
 */
export function getBedTemp(printer) {
  const s = printer.last_state;
  if (!s?.bed) return null;
  return { current: s.bed.current, target: s.bed.target };
}

/**
 * Get print progress info.
 */
export function getPrintProgress(printer) {
  const s = printer.last_state;
  if (!s?.printProgress) return null;
  if (!s.printing && s.printProgress.percent === 0) return null;

  return {
    percent: s.printProgress.percent || 0,
    filename: s.currentFile || null,
  };
}

/**
 * Check if the LED is on.
 */
export function isLedOn(printer) {
  return printer.last_state?.ledOn ?? null;
}

/**
 * Get camera MJPEG stream URL for a printer.
 * This goes through the Caddy proxy on Hostinger → Property Mac → printer LAN IP.
 */
export function getCameraUrl(printer) {
  // TODO: Once Caddy route is configured, use the proxied URL
  // For now, direct LAN URL (only works on same network)
  if (!printer.lan_ip) return null;
  const port = printer.camera_port || 8080;
  return `http://${printer.lan_ip}:${port}/?action=stream`;
}

export function formatSyncTime(lastSyncedAt) {
  if (!lastSyncedAt) return 'Never synced';
  const diff = Date.now() - new Date(lastSyncedAt).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return new Date(lastSyncedAt).toLocaleDateString();
}
