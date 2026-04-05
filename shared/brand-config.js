/**
 * Brand Configuration Module
 *
 * Single source of truth for all brand tokens (colors, fonts, logos, etc.).
 * Loads from Supabase `brand_config` table with hardcoded fallback.
 * Used by: email templates, style guide page, any new collateral.
 */

import { getSupabase } from './supabase.js';

// Hardcoded fallback (matches the DB seed exactly)
const FALLBACK_CONFIG = {
  brand: {
    primary_name: 'YOUR_PROPERTY_NAME',
    full_name: 'YOUR_PROPERTY_NAME Austin',
    platform_name: 'YOUR_APP_NAME',
    legal_name: 'YOUR_APP_NAME Residency',
    tagline: 'Where the herd gathers',
    address: '123 Main St, Your City, ST 00000',
    website: 'https://YOUR_DOMAIN',
  },
  colors: {
    primary: {
      background: '#faf9f6',
      background_muted: '#f2f0e8',
      background_dark: '#1c1618',
      text: '#2a1f23',
      text_light: '#faf9f6',
      text_muted: '#7d6f74',
      accent: '#d4883a',
      accent_hover: '#be7830',
      accent_light: 'rgba(212, 136, 58, 0.1)',
      border: '#e6e2d9',
    },
    status: {
      success: '#54a326',
      success_light: '#e8f5e0',
      error: '#8f3d4b',
      error_light: '#f5e6e9',
      warning: '#d4883a',
      warning_light: '#fdf1e0',
      info: '#3b82f6',
      info_light: '#eff6ff',
    },
    semantic: {
      occupied: '#8f3d4b',
      occupied_light: '#f5e6e9',
      available: '#54a326',
      available_light: '#e8f5e0',
      secret: '#7c6a9a',
      secret_light: '#f3effc',
    },
  },
  typography: {
    font_family: 'DM Sans',
    font_import: 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap',
    font_stack: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    font_stack_mono: "'SF Mono', 'Menlo', monospace",
    scale: { h1: '2.75rem', h2: '2.25rem', h3: '1.75rem', h4: '1.35rem', body: '1rem', small: '0.875rem', tiny: '0.75rem' },
    weights: { light: 300, regular: 400, medium: 500, semibold: 600, bold: 700 },
  },
  logos: {
    base_url: 'YOUR_SUPABASE_URL/storage/v1/object/public/housephotos/logos',
    icon_dark: 'logo-black-transparent.png',
    icon_light: 'logo-white-transparent.png',
    wordmark_dark: 'wordmark-black-transparent.png',
    wordmark_light: 'wordmark-white-transparent.png',
    sizes: {
      header_icon: '30px',
      header_wordmark: '22px',
      footer_icon: '52px',
      footer_wordmark: '24px',
      email_icon: '40px',
      email_wordmark: '28px',
    },
  },
  visual: {
    border_radius: { small: '6px', standard: '8px', large: '16px', pill: '100px' },
    shadows: {
      small: '0 1px 2px rgba(42, 31, 35, 0.04)',
      standard: '0 2px 8px rgba(42, 31, 35, 0.06), 0 1px 2px rgba(42, 31, 35, 0.04)',
      large: '0 8px 24px rgba(42, 31, 35, 0.08), 0 2px 6px rgba(42, 31, 35, 0.04)',
      accent_glow: '0 2px 8px rgba(212, 136, 58, 0.30)',
    },
    transitions: { standard: '0.2s ease', slow: '0.4s cubic-bezier(0.16, 1, 0.3, 1)' },
  },
  email: {
    max_width: '600px',
    header: { background: '#1c1618', text_color: '#faf9f6', padding: '32px', logo_height: '40px', wordmark_height: '20px' },
    body: { background: '#faf9f6', text_color: '#2a1f23', text_muted: '#7d6f74', padding: '32px', line_height: '1.6' },
    callout: { background: '#f2f0e8', border_color: '#e6e2d9', border_radius: '8px', padding: '20px 24px' },
    button: { background: '#d4883a', text_color: '#ffffff', border_radius: '8px', padding: '14px 36px', font_weight: '600', shadow: '0 2px 8px rgba(212, 136, 58, 0.30)' },
    footer: { background: '#f2f0e8', text_color: '#7d6f74', border_top: '1px solid #e6e2d9', padding: '20px 32px' },
  },
};

let _cachedConfig = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Load brand config from DB with fallback to hardcoded values.
 * Caches for 5 minutes.
 */
export async function getBrandConfig() {
  if (_cachedConfig && Date.now() - _cacheTime < CACHE_TTL) {
    return _cachedConfig;
  }

  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('brand_config')
      .select('config')
      .eq('id', 1)
      .single();

    if (data && !error) {
      _cachedConfig = data.config;
      _cacheTime = Date.now();
      return _cachedConfig;
    }
  } catch (e) {
    console.warn('Failed to load brand config from DB, using fallback:', e);
  }

  _cachedConfig = FALLBACK_CONFIG;
  _cacheTime = Date.now();
  return FALLBACK_CONFIG;
}

/**
 * Get the hardcoded fallback config (no DB call).
 * Useful for synchronous access or when Supabase isn't available.
 */
export function getBrandConfigSync() {
  return _cachedConfig || FALLBACK_CONFIG;
}

/**
 * Build a full logo URL from a filename.
 */
export function logoUrl(filename, config = null) {
  const c = config || getBrandConfigSync();
  return `${c.logos.base_url}/${filename}`;
}

/**
 * Invalidate the cache (e.g., after admin updates the config).
 */
export function invalidateBrandCache() {
  _cachedConfig = null;
  _cacheTime = 0;
}
