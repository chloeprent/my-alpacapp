/**
 * Brand Style Guide Page
 *
 * Loads brand_config from Supabase and renders a comprehensive
 * visual style guide showing colors, logos, typography, visual elements,
 * and email template previews.
 */

import { supabase } from '../../shared/supabase.js';
import { initAdminPage, showToast } from '../../shared/admin-shell.js';

/** Read a live CSS custom property value from :root */
function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let authState = null;
let brandConfig = null;

// =============================================
// INIT
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'brand',
    requiredRole: 'admin',
    section: 'admin',
    onReady: async () => {
      await loadBrandConfig();
      renderAll();
    },
  });
});

async function loadBrandConfig() {
  try {
    const { data, error } = await supabase
      .from('brand_config')
      .select('config, updated_at')
      .eq('id', 1)
      .single();

    if (data && !error) {
      brandConfig = data.config;
      const lastUpdated = document.getElementById('lastUpdated');
      if (lastUpdated) {
        lastUpdated.textContent = new Date(data.updated_at).toLocaleString('en-US', {
          timeZone: 'America/Chicago',
          year: 'numeric', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        });
      }
    } else {
      showToast('Could not load brand config from database', 'error');
    }
  } catch (e) {
    console.error('Failed to load brand config:', e);
    showToast('Failed to load brand config', 'error');
  }
}

function renderAll() {
  if (!brandConfig) return;
  renderBrandNames();
  renderLogos();
  renderLogoSizes();
  renderColors('primaryColors', brandConfig.colors?.primary, 'primary');
  renderColors('statusColors', brandConfig.colors?.status, 'status');
  renderColors('semanticColors', brandConfig.colors?.semantic, 'semantic');
  renderContrastPairings();
  renderTypography();
  renderTypeScale();
  renderFontWeights();
  renderTypeSpecimen();
  renderRadiusDemo();
  renderShadowDemo();
  renderButtonDemo();
  renderEmailPreview();
  renderEmailComponents();
  renderComponentPlayground();
  renderEmailAnatomy();
  renderEmailDesignGuide();
  renderUIComponents();
  renderRawJson();

  // Design tokens (read from CSS, independent of brandConfig)
  renderSpacingScale();
  renderSpacingAliases();
  renderTokenTypeScale();
  renderMotionTokens();
  renderZIndexTokens();
  renderLayoutTokens();
}

// =============================================
// BRAND NAMES
// =============================================

function renderBrandNames() {
  const el = document.getElementById('brandNames');
  if (!el) return;
  const b = brandConfig.brand || {};

  const names = [
    { label: 'Primary Name', value: b.primary_name, usage: 'Headers, verbal references, casual contexts' },
    { label: 'Full Name', value: b.full_name, usage: 'Site header/footer, formal email headers' },
    { label: 'Platform Name', value: b.platform_name, usage: 'Login buttons, app references, technical contexts' },
    { label: 'Legal Name', value: b.legal_name, usage: 'Contracts, lease agreements, legal documents' },
    { label: 'Tagline', value: b.tagline, usage: 'Email footers, marketing materials' },
    { label: 'Address', value: b.address, usage: 'Footers, legal documents, contact pages' },
    { label: 'Website', value: b.website, usage: 'All external-facing materials' },
  ];

  el.innerHTML = names.map(n => `
    <div class="brand-name-item">
      <div class="brand-name-label">${n.label}</div>
      <div class="brand-name-value">${n.value || '—'}</div>
      <div class="brand-name-usage">${n.usage}</div>
    </div>
  `).join('');
}

// =============================================
// LOGOS
// =============================================

function renderLogos() {
  const el = document.getElementById('logoGrid');
  if (!el) return;
  const logos = brandConfig.logos || {};
  const base = logos.base_url || '';

  const items = [
    { name: 'Icon (Dark)', file: logos.icon_dark, bg: '#faf9f6', desc: 'Use on light backgrounds' },
    { name: 'Icon (Light)', file: logos.icon_light, bg: '#1c1618', desc: 'Use on dark backgrounds' },
    { name: 'Wordmark (Dark)', file: logos.wordmark_dark, bg: '#faf9f6', desc: 'Use on light backgrounds', wide: true },
    { name: 'Wordmark (Light)', file: logos.wordmark_light, bg: '#1c1618', desc: 'Use on dark backgrounds', wide: true },
  ];

  el.innerHTML = items.map(item => `
    <div class="brand-logo-item${item.wide ? ' brand-logo-item--wide' : ''}">
      <div class="brand-logo-preview" style="background:${item.bg};">
        <img src="${base}/${item.file}" alt="${item.name}" />
      </div>
      <div class="brand-logo-meta">
        <strong>${item.name}</strong>
        <span>${item.desc}</span>
        <code>${item.file}</code>
      </div>
    </div>
  `).join('');
}

function renderLogoSizes() {
  const el = document.getElementById('logoSizes');
  if (!el) return;
  const sizes = brandConfig.logos?.sizes || {};

  el.innerHTML = `
    <table class="brand-table">
      <thead><tr><th>Context</th><th>Size</th></tr></thead>
      <tbody>
        ${Object.entries(sizes).map(([key, val]) => `
          <tr>
            <td>${key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</td>
            <td><code>${val}</code></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// =============================================
// COLORS
// =============================================

function renderColors(containerId, colors, _label) {
  const el = document.getElementById(containerId);
  if (!el || !colors) return;

  el.innerHTML = Object.entries(colors).map(([key, value]) => {
    const textColor = isLightColor(value) ? '#2a1f23' : '#faf9f6';

    return `
      <div class="brand-swatch" title="Click to copy" onclick="navigator.clipboard.writeText('${value}')">
        <div class="brand-swatch-color" style="background:${value};color:${textColor};" data-color="${value}">
          <span class="brand-swatch-hex">${value}</span>
        </div>
        <div class="brand-swatch-label">${key.replace(/_/g, ' ')}</div>
      </div>
    `;
  }).join('');
}

function isLightColor(color) {
  if (!color || color.startsWith('rgba')) return true;
  const hex = color.replace('#', '');
  if (hex.length !== 6) return true;
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128;
}

// =============================================
// CONTRAST PAIRINGS
// =============================================

function getRelativeLuminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const srgb = [r, g, b].map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function getContrastRatio(hex1, hex2) {
  const l1 = getRelativeLuminance(hex1);
  const l2 = getRelativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return ((lighter + 0.05) / (darker + 0.05)).toFixed(1);
}

function renderContrastPairings() {
  const el = document.getElementById('contrastPairings');
  if (!el) return;
  const c = brandConfig.colors?.primary || {};

  const pairings = [
    { text: c.text || '#2a1f23', bg: c.background || '#faf9f6', label: 'Dark text on cream' },
    { text: c.text_light || '#faf9f6', bg: c.background_dark || '#1c1618', label: 'Light text on dark' },
    { text: c.text_muted || '#7d6f74', bg: c.background || '#faf9f6', label: 'Muted text on cream' },
    { text: c.accent || '#d4883a', bg: c.background || '#faf9f6', label: 'Accent on cream' },
    { text: c.text || '#2a1f23', bg: c.background_muted || '#f2f0e8', label: 'Dark text on muted' },
    { text: '#ffffff', bg: c.accent || '#d4883a', label: 'White on accent (buttons)' },
  ];

  el.innerHTML = `<div class="brand-contrast-grid">${pairings.map(p => {
    const ratio = getContrastRatio(p.text, p.bg);
    const pass = ratio >= 4.5;
    const aaa = ratio >= 7;
    const badge = aaa ? 'AAA' : pass ? 'AA' : 'Fail';
    const badgeClass = aaa ? 'brand-contrast-badge--aaa' : pass ? 'brand-contrast-badge--aa' : 'brand-contrast-badge--fail';

    return `
      <div class="brand-contrast-pair">
        <div class="brand-contrast-preview" style="background:${p.bg};color:${p.text};border:1px solid ${c.border || '#e6e2d9'};">
          <span style="font-size:1.25rem;font-weight:600;">Aa</span>
          <span style="font-size:0.875rem;">The quick brown property</span>
        </div>
        <div class="brand-contrast-meta">
          <span class="brand-contrast-label">${p.label}</span>
          <span class="brand-contrast-badge ${badgeClass}">${badge} ${ratio}:1</span>
        </div>
      </div>`;
  }).join('')}</div>`;
}

// =============================================
// TYPOGRAPHY
// =============================================

function renderTypography() {
  const el = document.getElementById('fontFamily');
  if (!el) return;
  const t = brandConfig.typography || {};

  el.innerHTML = `
    <div class="brand-font-display">
      <div class="brand-font-sample" style="font-family:${t.font_stack || 'DM Sans, sans-serif'};">
        <span style="font-size:3rem;font-weight:700;">Aa</span>
        <span style="font-size:1.5rem;font-weight:400;">The quick brown property jumps over the lazy fence.</span>
      </div>
      <div class="brand-font-meta">
        <div><strong>Family:</strong> <code>${t.font_family || 'DM Sans'}</code></div>
        <div><strong>Stack:</strong> <code>${t.font_stack || ''}</code></div>
        <div><strong>Mono:</strong> <code>${t.font_stack_mono || ''}</code></div>
        <div><strong>Import:</strong> <a href="${t.font_import || '#'}" target="_blank" style="word-break:break-all;">${t.font_import || '—'}</a></div>
      </div>
    </div>
  `;
}

function renderTypeScale() {
  const el = document.getElementById('typeScale');
  if (!el) return;
  const scale = brandConfig.typography?.scale || {};

  el.innerHTML = `
    <div class="brand-type-scale">
      ${Object.entries(scale).map(([key, size]) => `
        <div class="brand-type-row">
          <span class="brand-type-label">${key.toUpperCase()}</span>
          <span class="brand-type-sample" style="font-size:${size};font-weight:${key.startsWith('h') ? '600' : '400'};">The quick brown property</span>
          <code class="brand-type-size">${size}</code>
        </div>
      `).join('')}
    </div>
  `;
}

function renderFontWeights() {
  const el = document.getElementById('fontWeights');
  if (!el) return;
  const weights = brandConfig.typography?.weights || {};

  el.innerHTML = `
    <div class="brand-weights">
      ${Object.entries(weights).map(([key, w]) => `
        <div class="brand-weight-row">
          <span class="brand-weight-sample" style="font-weight:${w};font-size:1.25rem;">YOUR_PROPERTY_NAME</span>
          <span class="brand-weight-label">${key} (${w})</span>
        </div>
      `).join('')}
    </div>
  `;
}

// =============================================
// TYPE SPECIMEN
// =============================================

function renderTypeSpecimen() {
  const el = document.getElementById('typeSpecimen');
  if (!el) return;
  const t = brandConfig.typography || {};
  const c = brandConfig.colors?.primary || {};
  const font = t.font_stack || "'DM Sans', sans-serif";

  el.innerHTML = `
    <div class="brand-specimen" style="font-family:${font};">
      <div class="brand-specimen-block" style="background:${c.background || '#faf9f6'};color:${c.text || '#2a1f23'};border:1px solid ${c.border || '#e6e2d9'};border-radius:12px;padding:2rem;margin-bottom:1rem;">
        <h2 style="font-size:1.75rem;font-weight:700;margin:0 0 0.25rem;color:${c.text || '#2a1f23'};">Welcome to YOUR_PROPERTY_NAME</h2>
        <p style="font-size:0.875rem;color:${c.text_muted || '#7d6f74'};margin:0 0 1rem;font-weight:400;">Where we redefine your idea of what an YOUR_PROPERTY_NAME can be.</p>
        <p style="font-size:1rem;line-height:1.6;margin:0 0 0.75rem;font-weight:400;">Our property features <strong>six unique living spaces</strong>, each designed with a distinct personality. From the minimalist <em>Spartan Suite</em> to the luxurious <em>Garage Mahal</em>, there's a perfect fit for everyone.</p>
        <p style="font-size:0.875rem;line-height:1.55;color:${c.text_muted || '#7d6f74'};margin:0;">Amenities include high-speed WiFi, smart home controls, a maker space with laser cutter, and our famous property herd on 5 acres of Texas hill country.</p>
      </div>
      <div class="brand-specimen-block" style="background:${c.background_dark || '#1c1618'};color:${c.text_light || '#faf9f6'};border-radius:12px;padding:2rem;">
        <h2 style="font-size:1.75rem;font-weight:700;margin:0 0 0.25rem;">Welcome to YOUR_PROPERTY_NAME</h2>
        <p style="font-size:0.875rem;opacity:0.7;margin:0 0 1rem;font-weight:400;">Where we redefine your idea of what an YOUR_PROPERTY_NAME can be.</p>
        <p style="font-size:1rem;line-height:1.6;margin:0 0 0.75rem;font-weight:400;">Our property features <strong>six unique living spaces</strong>, each designed with a distinct personality. From the minimalist <em>Spartan Suite</em> to the luxurious <em>Garage Mahal</em>, there's a perfect fit for everyone.</p>
        <p style="font-size:0.875rem;line-height:1.55;opacity:0.6;margin:0;">Amenities include high-speed WiFi, smart home controls, a maker space with laser cutter, and our famous property herd on 5 acres of Texas hill country.</p>
      </div>
    </div>
  `;
}

// =============================================
// VISUAL ELEMENTS
// =============================================

function renderRadiusDemo() {
  const el = document.getElementById('radiusDemo');
  if (!el) return;
  const radii = brandConfig.visual?.border_radius || {};

  el.innerHTML = Object.entries(radii).map(([key, val]) => `
    <div class="brand-radius-item">
      <div class="brand-radius-box" style="border-radius:${val};"></div>
      <div><strong>${key}</strong></div>
      <code>${val}</code>
    </div>
  `).join('');
}

function renderShadowDemo() {
  const el = document.getElementById('shadowDemo');
  if (!el) return;
  const shadows = brandConfig.visual?.shadows || {};

  el.innerHTML = Object.entries(shadows).map(([key, val]) => `
    <div class="brand-shadow-item">
      <div class="brand-shadow-box" style="box-shadow:${val};"></div>
      <div><strong>${key.replace(/_/g, ' ')}</strong></div>
      <code style="font-size:0.7em;word-break:break-all;">${val}</code>
    </div>
  `).join('');
}

function renderButtonDemo() {
  const el = document.getElementById('buttonDemo');
  if (!el) return;
  const btn = brandConfig.email?.button || {};
  const c = brandConfig.colors?.primary || {};

  el.innerHTML = `
    <div class="brand-button-row">
      <div class="brand-button-example">
        <button style="background:${btn.background || '#d4883a'};color:${btn.text_color || '#fff'};border:none;border-radius:${btn.border_radius || '8px'};padding:${btn.padding || '14px 36px'};font-weight:${btn.font_weight || '600'};font-size:16px;cursor:pointer;box-shadow:${btn.shadow || 'none'};font-family:'DM Sans',sans-serif;letter-spacing:0.02em;">Primary Button</button>
        <span class="brand-button-label">Primary / CTA</span>
      </div>
      <div class="brand-button-example">
        <button style="background:transparent;color:${c.text || '#2a1f23'};border:1.5px solid ${c.border || '#e6e2d9'};border-radius:${btn.border_radius || '8px'};padding:12px 24px;font-weight:500;font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif;">Outline Button</button>
        <span class="brand-button-label">Secondary / Outline</span>
      </div>
      <div class="brand-button-example">
        <button style="background:${c.background_dark || '#1c1618'};color:${c.text_light || '#faf9f6'};border:1.5px solid rgba(255,255,255,0.2);border-radius:${btn.border_radius || '8px'};padding:12px 24px;font-weight:500;font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif;">Dark Button</button>
        <span class="brand-button-label">Dark variant</span>
      </div>
    </div>
  `;
}

// =============================================
// EMAIL PREVIEW
// =============================================

function renderEmailPreview() {
  const el = document.getElementById('emailPreview');
  if (!el) return;

  const e = brandConfig.email || {};
  const c = brandConfig.colors?.primary || {};
  const logos = brandConfig.logos || {};
  const brand = brandConfig.brand || {};
  const base = logos.base_url || '';
  const iconUrl = `${base}/${logos.icon_light}`;
  const wordmarkUrl = `${base}/${logos.wordmark_light}`;
  const btn = e.button || {};
  const callout = e.callout || {};

  const previewHtml = `
    <div style="background:${c.background_muted || '#f2f0e8'};padding:24px 16px;border-radius:8px;">
      <table cellpadding="0" cellspacing="0" style="max-width:${e.max_width || '600px'};width:100%;margin:0 auto;background:${c.background || '#faf9f6'};border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(42,31,35,0.06);">
        <!-- Header -->
        <tr>
          <td style="background:${e.header?.background || '#1c1618'};padding:${e.header?.padding || '32px'};text-align:center;">
            <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>
                <td style="padding-right:12px;vertical-align:middle;">
                  <img src="${iconUrl}" alt="" height="40" style="height:${e.header?.logo_height || '40px'};width:auto;" />
                </td>
                <td style="vertical-align:middle;">
                  <img src="${wordmarkUrl}" alt="${brand.full_name}" height="20" style="height:${e.header?.wordmark_height || '20px'};width:auto;" />
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:${e.body?.padding || '32px'};color:${e.body?.text_color || '#2a1f23'};font-size:16px;line-height:${e.body?.line_height || '1.6'};font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            <p style="margin:0 0 16px;">Hi there,</p>
            <p style="margin:0 0 16px;">This is an example of the <strong>standard email template</strong> used across all YOUR_PROPERTY_NAME communications. It demonstrates the branded header, body formatting, components, and footer.</p>

            <!-- Callout -->
            <div style="background:${callout.background || '#f2f0e8'};border:1px solid ${callout.border_color || '#e6e2d9'};border-radius:${callout.border_radius || '8px'};padding:${callout.padding || '20px 24px'};margin:16px 0;">
              <p style="margin:0;font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:${e.body?.text_muted || '#7d6f74'};margin-bottom:8px;">Important Information</p>
              <p style="margin:0;">Callout boxes use the muted background color and border for visual distinction. Use them for key information, instructions, or summaries.</p>
            </div>

            <!-- CTA Button -->
            <table cellpadding="0" cellspacing="0" style="margin:24px auto;text-align:center;">
              <tr>
                <td style="background:${btn.background || '#d4883a'};border-radius:${btn.border_radius || '8px'};box-shadow:${btn.shadow || 'none'};">
                  <a href="#" style="display:inline-block;padding:${btn.padding || '14px 36px'};color:${btn.text_color || '#fff'};text-decoration:none;font-weight:${btn.font_weight || '600'};font-size:16px;font-family:'DM Sans',sans-serif;letter-spacing:0.02em;">Call to Action</a>
                </td>
              </tr>
            </table>

            <p style="margin:0;color:${e.body?.text_muted || '#7d6f74'};font-size:13px;text-align:center;">Questions? Just reply to this email.</p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:${e.footer?.background || '#f2f0e8'};padding:${e.footer?.padding || '20px 32px'};text-align:center;border-top:${e.footer?.border_top || '1px solid #e6e2d9'};">
            <p style="margin:0;color:${e.footer?.text_color || '#7d6f74'};font-size:12px;">${brand.address || ''}</p>
            <p style="margin:6px 0 0;color:${e.footer?.text_color || '#7d6f74'};font-size:11px;opacity:0.7;">${brand.platform_name || 'YOUR_APP_NAME'} &bull; ${brand.tagline || ''}</p>
          </td>
        </tr>
      </table>
    </div>
  `;

  el.innerHTML = previewHtml;
}

function renderEmailComponents() {
  const el = document.getElementById('emailComponents');
  if (!el) return;
  const e = brandConfig.email || {};

  const sections = [
    { label: 'Header', data: e.header },
    { label: 'Body', data: e.body },
    { label: 'Callout Box', data: e.callout },
    { label: 'CTA Button', data: e.button },
    { label: 'Footer', data: e.footer },
  ];

  el.innerHTML = sections.map(s => {
    if (!s.data) return '';
    return `
      <div class="brand-email-component">
        <h4>${s.label}</h4>
        <table class="brand-table brand-table--compact">
          <tbody>
            ${Object.entries(s.data).map(([k, v]) => `
              <tr>
                <td>${k.replace(/_/g, ' ')}</td>
                <td>
                  <code>${v}</code>
                  ${String(v).startsWith('#') ? `<span class="brand-inline-swatch" style="background:${v};"></span>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }).join('');
}

// =============================================
// COMPONENT PLAYGROUND
// =============================================

function renderComponentPlayground() {
  const el = document.getElementById('componentPlayground');
  if (!el) return;
  const e = brandConfig.email || {};
  const c = brandConfig.colors?.primary || {};
  const btn = e.button || {};
  const callout = e.callout || {};
  const font = brandConfig.typography?.font_stack || "'DM Sans', sans-serif";

  el.innerHTML = `
    <div class="brand-playground">
      <!-- CTA Buttons -->
      <div class="brand-playground-section">
        <h4>CTA Buttons</h4>
        <p class="brand-hint" style="margin-bottom:12px;">Generated by <code>emailButton(text, url)</code> in the brand wrapper.</p>
        <div style="background:${c.background || '#faf9f6'};border:1px solid ${c.border || '#e6e2d9'};border-radius:8px;padding:24px;text-align:center;">
          <table cellpadding="0" cellspacing="0" style="margin:0 auto 16px;text-align:center;">
            <tr>
              <td style="background:${btn.background || '#d4883a'};border-radius:${btn.border_radius || '8px'};box-shadow:${btn.shadow || 'none'};">
                <a href="#" onclick="return false" style="display:inline-block;padding:${btn.padding || '14px 36px'};color:${btn.text_color || '#fff'};text-decoration:none;font-weight:${btn.font_weight || '600'};font-size:16px;font-family:${font};letter-spacing:0.02em;">View Your Space</a>
              </td>
            </tr>
          </table>
          <table cellpadding="0" cellspacing="0" style="margin:0 auto;text-align:center;">
            <tr>
              <td style="background:${btn.background || '#d4883a'};border-radius:${btn.border_radius || '8px'};box-shadow:${btn.shadow || 'none'};">
                <a href="#" onclick="return false" style="display:inline-block;padding:12px 28px;color:${btn.text_color || '#fff'};text-decoration:none;font-weight:${btn.font_weight || '600'};font-size:14px;font-family:${font};letter-spacing:0.02em;">Pay Online</a>
              </td>
            </tr>
          </table>
        </div>
      </div>

      <!-- Callout Boxes -->
      <div class="brand-playground-section">
        <h4>Callout Boxes</h4>
        <p class="brand-hint" style="margin-bottom:12px;">Generated by <code>emailCallout(innerHtml)</code> in the brand wrapper.</p>
        <div style="background:${c.background || '#faf9f6'};border:1px solid ${c.border || '#e6e2d9'};border-radius:8px;padding:24px;">
          <div style="background:${callout.background || '#f2f0e8'};border:1px solid ${callout.border_color || '#e6e2d9'};border-radius:${callout.border_radius || '8px'};padding:${callout.padding || '20px 24px'};margin-bottom:12px;font-family:${font};">
            <p style="margin:0 0 8px;font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:${c.text_muted || '#7d6f74'};">Important Information</p>
            <p style="margin:0;font-size:15px;color:${c.text || '#2a1f23'};line-height:1.5;">Your move-in date is <strong>March 1, 2026</strong>. Please arrive after 3:00 PM. Your door code will be sent separately.</p>
          </div>
          <div style="background:#fdf1e0;border-left:3px solid ${c.accent || '#d4883a'};padding:10px 16px;border-radius:0 8px 8px 0;font-family:${font};">
            <p style="margin:0;color:${c.text_muted || '#7d6f74'};font-size:13px;line-height:1.5;"><strong style="color:${c.text || '#2a1f23'};">Reminder:</strong> Please review the visiting guidelines before sharing the address with guests.</p>
          </div>
        </div>
      </div>

      <!-- Data Table -->
      <div class="brand-playground-section">
        <h4>Info Tables</h4>
        <p class="brand-hint" style="margin-bottom:12px;">Used in move-in emails, payment receipts, and reservation details.</p>
        <div style="background:${c.background || '#faf9f6'};border:1px solid ${c.border || '#e6e2d9'};border-radius:8px;padding:24px;">
          <table style="border-collapse:collapse;width:100%;font-size:14px;border:1px solid ${c.border || '#e6e2d9'};border-radius:8px;overflow:hidden;font-family:${font};">
            <thead>
              <tr style="background:${c.background_dark || '#1c1618'};">
                <th colspan="2" style="padding:10px 12px;text-align:left;color:${c.text_light || '#faf9f6'};font-weight:600;font-size:14px;letter-spacing:0.3px;">Reservation Details</th>
              </tr>
            </thead>
            <tbody>
              <tr style="background:${c.background || '#faf9f6'};">
                <td style="padding:10px 12px;color:${c.text_muted || '#7d6f74'};font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;width:120px;">Space</td>
                <td style="padding:10px 12px;color:${c.accent || '#d4883a'};font-size:15px;font-weight:600;">Spartan Suite</td>
              </tr>
              <tr style="background:${c.background_muted || '#f2f0e8'};">
                <td style="padding:10px 12px;color:${c.text_muted || '#7d6f74'};font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Move-in</td>
                <td style="padding:10px 12px;color:${c.text || '#2a1f23'};font-size:15px;font-weight:600;">March 1, 2026</td>
              </tr>
              <tr style="background:${c.background || '#faf9f6'};">
                <td style="padding:10px 12px;color:${c.text_muted || '#7d6f74'};font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Rate</td>
                <td style="padding:10px 12px;color:${c.text || '#2a1f23'};font-size:15px;font-weight:600;">$1,200/mo</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Payment Badges -->
      <div class="brand-playground-section">
        <h4>Payment Method Badges</h4>
        <p class="brand-hint" style="margin-bottom:12px;">Colored badges for different payment methods shown in move-in and receipt emails.</p>
        <div style="background:${c.background || '#faf9f6'};border:1px solid ${c.border || '#e6e2d9'};border-radius:8px;padding:24px;display:flex;gap:8px;flex-wrap:wrap;font-family:${font};">
          <span style="display:inline-block;background:#3d95ce;color:white;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:600;">Venmo</span>
          <span style="display:inline-block;background:#6c1cd3;color:white;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:600;">Zelle</span>
          <span style="display:inline-block;background:#003087;color:white;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:600;">PayPal</span>
          <span style="display:inline-block;background:#635bff;color:white;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:600;">Stripe</span>
          <span style="display:inline-block;background:#2e7d32;color:white;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:600;">Bank</span>
        </div>
      </div>
    </div>
  `;
}

// =============================================
// EMAIL ANATOMY
// =============================================

function renderEmailAnatomy() {
  const el = document.getElementById('emailAnatomy');
  if (!el) return;
  const e = brandConfig.email || {};
  const c = brandConfig.colors?.primary || {};

  el.innerHTML = `
    <div class="brand-anatomy">
      <div class="brand-anatomy-diagram">
        <!-- Max width annotation -->
        <div class="brand-anatomy-width">
          <span class="brand-anatomy-arrow">&larr; ${e.max_width || '600px'} max-width &rarr;</span>
        </div>

        <!-- Container -->
        <div class="brand-anatomy-container" style="border:2px dashed ${c.accent || '#d4883a'};border-radius:12px;overflow:hidden;max-width:400px;margin:0 auto;">

          <!-- Header -->
          <div style="background:${c.background_dark || '#1c1618'};padding:20px;text-align:center;position:relative;">
            <span style="color:${c.text_light || '#faf9f6'};font-size:13px;font-weight:600;">HEADER</span>
            <span class="brand-anatomy-label" style="right:-80px;">pad: ${e.header?.padding || '32px'}</span>
          </div>

          <!-- Body -->
          <div style="background:${c.background || '#faf9f6'};padding:20px;position:relative;min-height:100px;display:flex;align-items:center;justify-content:center;">
            <span style="color:${c.text || '#2a1f23'};font-size:13px;font-weight:600;">BODY CONTENT</span>
            <span class="brand-anatomy-label" style="right:-80px;">pad: ${e.body?.padding || '32px'}</span>
          </div>

          <!-- Gallery -->
          <div style="background:${c.background || '#faf9f6'};padding:8px 20px;text-align:center;border-top:1px dashed ${c.border || '#e6e2d9'};position:relative;">
            <span style="color:${c.text_muted || '#7d6f74'};font-size:11px;">IMAGE GALLERY</span>
          </div>

          <!-- Footer -->
          <div style="background:${c.background_muted || '#f2f0e8'};padding:14px 20px;text-align:center;border-top:1px solid ${c.border || '#e6e2d9'};position:relative;">
            <span style="color:${c.text_muted || '#7d6f74'};font-size:13px;font-weight:600;">FOOTER</span>
            <span class="brand-anatomy-label" style="right:-80px;">pad: ${e.footer?.padding || '20px 32px'}</span>
          </div>
        </div>

        <!-- Outer padding annotation -->
        <div class="brand-anatomy-outer">
          <span style="font-size:0.75rem;color:${c.text_muted || '#7d6f74'};">Outer background: <code style="font-size:0.7rem;">${c.background_muted || '#f2f0e8'}</code> &middot; Outer padding: <code style="font-size:0.7rem;">24px 16px</code></span>
        </div>
      </div>

      <!-- Legend -->
      <div class="brand-anatomy-legend">
        <div class="brand-anatomy-legend-item">
          <span class="brand-anatomy-swatch" style="background:${c.background_dark || '#1c1618'};"></span>
          <span>Header: Logo + wordmark on dark bg</span>
        </div>
        <div class="brand-anatomy-legend-item">
          <span class="brand-anatomy-swatch" style="background:${c.background || '#faf9f6'};border:1px solid ${c.border || '#e6e2d9'};"></span>
          <span>Body: Main content area (cream)</span>
        </div>
        <div class="brand-anatomy-legend-item">
          <span class="brand-anatomy-swatch" style="background:${c.background_muted || '#f2f0e8'};border:1px solid ${c.border || '#e6e2d9'};"></span>
          <span>Footer + Outer: Muted background</span>
        </div>
        <div class="brand-anatomy-legend-item">
          <span class="brand-anatomy-swatch" style="background:${c.accent || '#d4883a'};"></span>
          <span>Container outline (12px border-radius)</span>
        </div>
      </div>
    </div>
  `;
}

// =============================================
// EMAIL DESIGN GUIDE
// =============================================

function renderEmailDesignGuide() {
  renderGuideLayout();
  renderGuideTypography();
  renderGuideSpacing();
  renderGuideButtons();
  renderGuideImages();
  renderGuideColors();
  renderGuideMobile();
  renderGuideDarkMode();
  renderGuideClientQuirks();
  renderGuideHelpers();
  renderGuideChecklist();
}

function guideTable(headers, rows) {
  return `<table class="brand-table brand-table--compact">
    <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

function renderGuideLayout() {
  const el = document.getElementById('guideLayout');
  if (!el) return;
  const c = brandConfig.colors?.primary || {};
  const bg = c.background || '#faf9f6';
  const bgMuted = c.background_muted || '#f2f0e8';
  const dark = c.dark || '#1c1618';
  const accent = c.accent || '#d4883a';
  const border = c.border || '#e6e2d9';
  el.innerHTML = `
    <div class="guide-layout-diagram">
      <div class="guide-layout-outer" style="background:${bgMuted};border:2px dashed ${border};border-radius:12px;padding:16px;text-align:center;">
        <div style="font-size:11px;color:var(--aap-text-muted);margin-bottom:8px;">width: 100% (fluid outer wrapper)</div>
        <div class="guide-layout-inner" style="max-width:400px;margin:0 auto;background:${bg};border:2px solid ${border};border-radius:12px;overflow:hidden;">
          <div style="background:${dark};color:${bg};padding:16px;font-size:13px;font-weight:600;text-align:center;">
            Header — logo + wordmark
            <div style="font-size:10px;font-weight:400;opacity:.7;margin-top:2px;">padding: 32px</div>
          </div>
          <div style="padding:20px;border-bottom:1px solid ${border};">
            <div style="font-size:13px;font-weight:600;color:${dark};">Body Content</div>
            <div style="font-size:11px;color:var(--aap-text-muted);margin-top:4px;">padding: 32px all sides (20px on mobile)</div>
            <div style="margin-top:12px;background:${bgMuted};border-left:4px solid ${accent};padding:10px 12px;border-radius:0 6px 6px 0;font-size:11px;">Callout box — emailCallout()</div>
            <div style="margin-top:12px;text-align:center;">
              <span style="display:inline-block;background:${accent};color:#fff;padding:8px 24px;border-radius:8px;font-size:12px;font-weight:600;">CTA Button</span>
            </div>
          </div>
          <div style="background:${bgMuted};padding:12px;text-align:center;font-size:10px;color:var(--aap-text-muted);">
            Footer — address + tagline
            <div style="margin-top:2px;">padding: 20px 32px</div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--aap-text-muted);margin-top:8px;">max-width: 600px (centered container)</div>
      </div>
    </div>
    <details style="margin-top:16px;">
      <summary style="cursor:pointer;font-weight:500;font-size:14px;color:var(--aap-text-muted);">View full property reference</summary>
      <div style="margin-top:8px;">
        ${guideTable(
          ['Property', 'Value', 'Why'],
          [
            ['Max width', '<code>600px</code>', 'Fits all preview panes; clean retina math (600/2 = 300px mobile)'],
            ['Outer wrapper', '<code>width:100%</code>', 'Fluid background fills viewport on all screen sizes'],
            ['Inner container', '<code>max-width:600px; width:100%</code>', 'Centered, capped — scales down on mobile without media queries'],
            ['Layout method', 'Table-based (<code>&lt;table role="presentation"&gt;</code>)', 'Required for Outlook desktop (Word rendering engine ignores div layout)'],
            ['Column approach', 'Single-column preferred', '70%+ opens are mobile — multi-column requires complex stacking logic'],
            ['Table attributes', '<code>cellpadding="0" cellspacing="0" border="0"</code>', 'Reset all default table spacing; set on every table element'],
            ['Container radius', '<code>border-radius:12px</code>', 'Gracefully degrades to square in Outlook; looks polished elsewhere'],
            ['Gmail size limit', '<code>&lt; 102KB</code> total HTML', 'Gmail clips emails over 102KB — includes all HTML + inline CSS'],
          ]
        )}
      </div>
    </details>`;
}

function renderGuideTypography() {
  const el = document.getElementById('guideTypography');
  if (!el) return;
  const c = brandConfig.colors?.primary || {};
  const text = c.text || '#2a1f23';
  const muted = c.text_muted || '#7d6f74';
  const accent = c.accent || '#d4883a';
  const samples = [
    { label: 'H1 / Title', size: '28px', weight: 700, lh: '34px', mobile: '24px' },
    { label: 'H2 / Subtitle', size: '22px', weight: 600, lh: '28px', mobile: '20px' },
    { label: 'H3 / Section', size: '18px', weight: 600, lh: '24px', mobile: '18px' },
    { label: 'Body', size: '16px', weight: 400, lh: '26px', mobile: '16px' },
    { label: 'Small', size: '13px', weight: 400, lh: '20px', mobile: '13px' },
    { label: 'Footer', size: '12px', weight: 400, lh: '18px', mobile: '12px' },
  ];
  el.innerHTML = `
    <div class="guide-type-samples">
      ${samples.map(s => `
        <div class="guide-type-row">
          <div class="guide-type-meta">
            <span class="guide-type-label">${s.label}</span>
            <span class="guide-type-spec">${s.size} / ${s.weight} / ${s.lh}</span>
          </div>
          <div class="guide-type-preview" style="font-size:${s.size};font-weight:${s.weight};line-height:${s.lh};color:${text};">
            The quick brown property jumps over the lazy fence
          </div>
        </div>
      `).join('')}
      <div class="guide-type-row">
        <div class="guide-type-meta">
          <span class="guide-type-label">Link</span>
          <span class="guide-type-spec">16px / 400 / underline</span>
        </div>
        <div class="guide-type-preview" style="font-size:16px;font-weight:400;line-height:26px;">
          Regular text with a <span style="color:${accent};text-decoration:underline;">branded link</span> inline
        </div>
      </div>
      <div class="guide-type-row">
        <div class="guide-type-meta">
          <span class="guide-type-label">Muted</span>
          <span class="guide-type-spec">13px / 400 / ${muted}</span>
        </div>
        <div class="guide-type-preview" style="font-size:13px;font-weight:400;line-height:20px;color:${muted};">
          Secondary text, captions, and metadata use the muted color
        </div>
      </div>
    </div>
    <details style="margin-top:16px;">
      <summary style="cursor:pointer;font-weight:500;font-size:14px;color:var(--aap-text-muted);">View font stack details</summary>
      <div style="margin-top:8px;">
        ${guideTable(
          ['Property', 'Value'],
          [
            ['Primary font stack', "<code>'DM Sans', Arial, Helvetica, sans-serif</code>"],
            ['Outlook fallback', '<code>Arial, Helvetica, sans-serif</code> (forced via mso conditional)'],
            ['Minimum font size', '<code>13px</code> — iOS auto-zooms text below 13px'],
            ['Line height units', 'Always use <code>px</code> values — most consistent across clients'],
          ]
        )}
      </div>
    </details>`;
}

function renderGuideSpacing() {
  const el = document.getElementById('guideSpacing');
  if (!el) return;
  const c = brandConfig.colors?.primary || {};
  const bg = c.background || '#faf9f6';
  const bgMuted = c.background_muted || '#f2f0e8';
  const dark = c.dark || '#1c1618';
  const accent = c.accent || '#d4883a';
  const border = c.border || '#e6e2d9';
  el.innerHTML = `
    <div class="guide-spacing-visual">
      <div style="max-width:420px;margin:0 auto;border:2px solid ${border};border-radius:12px;overflow:hidden;font-family:'DM Sans',sans-serif;background:${bg};">
        <div style="background:${dark};padding:32px;text-align:center;position:relative;">
          <div style="color:${bg};font-size:13px;font-weight:600;">Header</div>
          <div class="guide-spacing-tag" style="right:4px;top:4px;">32px</div>
        </div>
        <div style="padding:32px;position:relative;">
          <div class="guide-spacing-tag" style="left:4px;top:4px;">32px</div>
          <div style="font-size:20px;font-weight:700;color:${dark};margin:0 0 8px;">Heading</div>
          <div class="guide-spacing-gap" style="margin:0 0 16px;">
            <span class="guide-spacing-tag" style="position:static;display:inline-block;">margin 8px</span>
          </div>
          <div style="font-size:14px;color:${dark};line-height:22px;margin:0 0 16px;">Body paragraph text with a comfortable 16px bottom margin between paragraphs.</div>
          <div class="guide-spacing-gap">
            <span class="guide-spacing-tag" style="position:static;display:inline-block;">16px gap</span>
          </div>
          <div style="background:${bgMuted};border-left:4px solid ${accent};padding:20px 24px;border-radius:0 8px 8px 0;margin:16px 0;font-size:12px;color:${dark};position:relative;">
            Callout box
            <div class="guide-spacing-tag" style="right:4px;top:4px;">20px 24px</div>
          </div>
          <div style="text-align:center;margin:24px auto;position:relative;">
            <span style="display:inline-block;background:${accent};color:#fff;padding:14px 36px;border-radius:8px;font-size:14px;font-weight:600;">CTA Button</span>
            <div class="guide-spacing-tag" style="right:-8px;top:-8px;">24px margin</div>
          </div>
        </div>
        <div style="background:${bgMuted};padding:20px 32px;text-align:center;font-size:11px;color:var(--aap-text-muted);position:relative;">
          Footer
          <div class="guide-spacing-tag" style="right:4px;top:4px;">20px 32px</div>
        </div>
      </div>
    </div>
    <details style="margin-top:16px;">
      <summary style="cursor:pointer;font-weight:500;font-size:14px;color:var(--aap-text-muted);">View all spacing values</summary>
      <div style="margin-top:8px;">
        ${guideTable(
          ['Area', 'Padding', 'Notes'],
          [
            ['Body content', '<code>32px</code> all sides', '536px content area. Reduces to 20px on mobile'],
            ['Header', '<code>32px</code>', 'Reduces to 24px on mobile'],
            ['Footer', '<code>20px 32px</code>', 'Reduces to 16px 20px on mobile'],
            ['Between paragraphs', '<code>margin:0 0 16px</code>', 'Bottom margin only'],
            ['Above headings', '<code>margin:24px 0 8px</code>', '24px above, 8px below'],
            ['Callout internal', '<code>20px 24px</code>', 'Comfortable reading space'],
            ['Above/below CTA', '<code>margin:24px auto</code>', 'Generous whitespace'],
          ]
        )}
      </div>
    </details>`;
}

function renderGuideButtons() {
  const el = document.getElementById('guideButtons');
  if (!el) return;
  const btn = brandConfig.email?.button || {};
  const btnBg = btn.background || '#d4883a';
  const btnText = btn.text_color || '#ffffff';
  const btnRadius = btn.border_radius || '8px';
  const btnPad = btn.padding || '14px 36px';
  const btnShadow = btn.shadow || '0 2px 8px rgba(212,136,58,0.30)';
  el.innerHTML = `
    <div class="guide-buttons-demo">
      <div class="guide-buttons-row">
        <div class="guide-button-example">
          <div style="text-align:center;">
            <a href="#" onclick="return false" style="display:inline-block;background:${btnBg};color:${btnText};padding:${btnPad};border-radius:${btnRadius};font-size:16px;font-weight:600;letter-spacing:0.02em;text-decoration:none;box-shadow:${btnShadow};font-family:'DM Sans',sans-serif;">View Your Space</a>
          </div>
          <div class="guide-button-label">Primary CTA (default)</div>
        </div>
        <div class="guide-button-example">
          <div style="text-align:center;">
            <a href="#" onclick="return false" style="display:inline-block;background:${btnBg};color:${btnText};padding:${btnPad};border-radius:0;font-size:16px;font-weight:600;letter-spacing:0.02em;text-decoration:none;font-family:'DM Sans',sans-serif;">Pay Now</a>
          </div>
          <div class="guide-button-label">Outlook fallback (no border-radius)</div>
        </div>
      </div>
      <div class="guide-button-specs">
        <div class="guide-button-spec"><strong>Background:</strong> <code>${btnBg}</code></div>
        <div class="guide-button-spec"><strong>Text:</strong> <code>${btnText}</code> / 16px / 600</div>
        <div class="guide-button-spec"><strong>Padding:</strong> <code>${btnPad}</code> (~48px height)</div>
        <div class="guide-button-spec"><strong>Radius:</strong> <code>${btnRadius}</code></div>
        <div class="guide-button-spec"><strong>Shadow:</strong> <code>${btnShadow}</code></div>
      </div>
    </div>
    <p style="margin-top:12px;font-size:13px;color:var(--aap-text-muted);">Use <code>emailButton(text, url)</code> from <code>email-brand-wrapper.ts</code> — it generates the table-based pattern with Outlook compatibility automatically.</p>`;
}

function renderGuideImages() {
  const el = document.getElementById('guideImages');
  if (!el) return;
  const c = brandConfig.colors?.primary || {};
  el.innerHTML = `
    <div class="guide-images-dodont">
      <div class="guide-dodont-card guide-dodont--do">
        <div class="guide-dodont-header">Do</div>
        <div class="guide-dodont-body">
          <div style="background:#ddd;height:80px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#666;margin-bottom:8px;">
            <code>width="600" style="width:100%;max-width:600px;height:auto;display:block"</code>
          </div>
          <ul class="guide-dodont-list">
            <li>Set both HTML <code>width</code> attribute AND CSS styles</li>
            <li>Upload at 2x resolution (1200px for 600px display)</li>
            <li>Use PNG with transparency for logos</li>
            <li>Always include meaningful <code>alt</code> text</li>
            <li>Keep each image under 200KB</li>
          </ul>
        </div>
      </div>
      <div class="guide-dodont-card guide-dodont--dont">
        <div class="guide-dodont-header">Don't</div>
        <div class="guide-dodont-body">
          <div style="background:#ddd;height:80px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#666;margin-bottom:8px;">
            <code style="text-decoration:line-through;">background-image: url(...)</code>
          </div>
          <ul class="guide-dodont-list">
            <li>Use CSS <code>background-image</code> — Gmail strips entire style block</li>
            <li>Skip <code>alt</code> text — corporate Outlook blocks images by default</li>
            <li>Omit HTML <code>width</code> attribute — Outlook ignores CSS width</li>
            <li>Exceed 800KB total images per email</li>
            <li>Use 1x resolution images — blurry on retina screens</li>
          </ul>
        </div>
      </div>
    </div>`;
}

function renderGuideColors() {
  const el = document.getElementById('guideColors');
  if (!el) return;
  const c = brandConfig.colors?.primary || {};
  const text = c.text || '#2a1f23';
  const bg = c.background || '#faf9f6';
  const bgMuted = c.background_muted || '#f2f0e8';
  const muted = c.text_muted || '#7d6f74';
  const accent = c.accent || '#d4883a';
  const border = c.border || '#e6e2d9';
  const colorChecks = [
    { label: 'Body text on cream', fg: text, bg: bg, min: 4.5, type: 'AA' },
    { label: 'Muted text on cream', fg: muted, bg: bg, min: 4.5, type: 'AA' },
    { label: 'Button text on accent', fg: '#ffffff', bg: accent, min: 4.5, type: 'AA' },
    { label: 'Footer text on muted bg', fg: muted, bg: bgMuted, min: 3, type: 'AA Large' },
    { label: 'Accent link on cream', fg: accent, bg: bg, min: 3, type: 'AA Large' },
  ];
  el.innerHTML = `
    <div class="guide-color-checks">
      ${colorChecks.map(ch => {
        const ratio = getContrastRatio(ch.fg, ch.bg);
        const passes = ratio >= ch.min;
        return `<div class="guide-color-check">
          <div class="guide-color-swatch" style="background:${ch.bg};color:${ch.fg};font-size:16px;font-weight:500;padding:16px 20px;border-radius:8px;border:1px solid ${border};">
            ${ch.label}
          </div>
          <div class="guide-color-info">
            <code>${ch.fg}</code> on <code>${ch.bg}</code>
            <span class="brand-contrast-badge ${passes ? (ratio >= 7 ? 'brand-contrast-badge--aaa' : 'brand-contrast-badge--aa') : 'brand-contrast-badge--fail'}">
              ${ratio.toFixed(1)}:1 ${passes ? (ratio >= 7 ? 'AAA' : ch.type) : 'FAIL'}
            </span>
          </div>
        </div>`;
      }).join('')}
    </div>
    <h4 style="margin:20px 0 8px;">Color Usage Rules</h4>
    <div class="guide-color-rules">
      <div class="guide-rule"><span class="guide-rule-icon" style="color:var(--aap-error);">✗</span> Never use pure <code>#000000</code> — use <code>${text}</code> instead</div>
      <div class="guide-rule"><span class="guide-rule-icon" style="color:var(--aap-error);">✗</span> Never rely on color alone to convey meaning</div>
      <div class="guide-rule"><span class="guide-rule-icon" style="color:var(--aap-success);">✓</span> Links: <code>${accent}</code> with underline</div>
      <div class="guide-rule"><span class="guide-rule-icon" style="color:var(--aap-success);">✓</span> Dividers: <code>${border}</code> (subtle warm border)</div>
    </div>`;
}

function renderGuideMobile() {
  const el = document.getElementById('guideMobile');
  if (!el) return;
  el.innerHTML = `
    ${guideTable(
      ['Property', 'Value', 'Notes'],
      [
        ['Breakpoint', '<code>@media screen and (max-width:480px)</code>', 'Primary mobile breakpoint; desktop Gmail ignores @media entirely'],
        ['Body padding (mobile)', '<code>24px 20px</code>', 'Reduced from 32px to give more content width on small screens'],
        ['Minimum body font', '<code>16px</code>', 'iOS auto-zooms anything below 13px; 16px is comfortable reading size'],
        ['Minimum any text', '<code>13px</code>', 'Never go below this — iOS zoom will break layout'],
        ['Touch targets', '<code>44&times;44px</code> minimum', 'All tappable elements (buttons, links) — add padding around inline links'],
        ['Layout approach', 'Fluid hybrid (no media query needed)', '<code>max-width</code> on inner container scales down naturally; @media adds refinements'],
        ['Stacking pattern', '<code>width:100% !important; display:block !important</code>', 'Multi-column layouts should stack to single-column on mobile'],
        ['Text size adjust', '<code>-webkit-text-size-adjust:100%</code>', 'Prevents iOS Mail from auto-resizing text; set on body'],
      ]
    )}
    <p style="margin-top:12px;font-size:13px;color:var(--aap-text-muted);"><strong>Our wrapper handles this automatically.</strong> The <code>wrapEmailHtml()</code> function includes responsive <code>@media</code> rules that reduce padding on mobile and the fluid-hybrid container that scales without media queries.</p>`;
}

function renderGuideDarkMode() {
  const el = document.getElementById('guideDarkMode');
  if (!el) return;
  const c = brandConfig.colors?.primary || {};
  const bg = c.background || '#faf9f6';
  const bgMuted = c.background_muted || '#f2f0e8';
  const dark = c.dark || '#1c1618';
  const text = c.text || '#2a1f23';
  const accent = c.accent || '#d4883a';
  el.innerHTML = `
    <div class="guide-darkmode-compare">
      <div class="guide-darkmode-panel">
        <div class="guide-darkmode-label">Light Mode (original)</div>
        <div style="background:${bg};border:1px solid #e6e2d9;border-radius:8px;overflow:hidden;font-family:'DM Sans',sans-serif;">
          <div style="background:${dark};padding:16px;text-align:center;">
            <span style="color:${bg};font-size:13px;font-weight:600;">YOUR_PROPERTY_NAME</span>
          </div>
          <div style="padding:16px;">
            <div style="font-size:14px;font-weight:600;color:${text};margin-bottom:6px;">Welcome home!</div>
            <div style="font-size:12px;color:${text};line-height:18px;margin-bottom:12px;">Your space is ready and waiting.</div>
            <div style="text-align:center;">
              <span style="display:inline-block;background:${accent};color:#fff;padding:8px 20px;border-radius:6px;font-size:12px;font-weight:600;">View Details</span>
            </div>
          </div>
          <div style="background:${bgMuted};padding:10px;text-align:center;font-size:10px;color:#7d6f74;">Footer text</div>
        </div>
      </div>
      <div class="guide-darkmode-panel">
        <div class="guide-darkmode-label">Dark Mode (inverted by client)</div>
        <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;overflow:hidden;font-family:'DM Sans',sans-serif;">
          <div style="background:#2a2a2a;padding:16px;text-align:center;">
            <span style="color:#e0e0e0;font-size:13px;font-weight:600;">YOUR_PROPERTY_NAME</span>
          </div>
          <div style="padding:16px;">
            <div style="font-size:14px;font-weight:600;color:#e0e0e0;margin-bottom:6px;">Welcome home!</div>
            <div style="font-size:12px;color:#ccc;line-height:18px;margin-bottom:12px;">Your space is ready and waiting.</div>
            <div style="text-align:center;">
              <span style="display:inline-block;background:${accent};color:#fff;padding:8px 20px;border-radius:6px;font-size:12px;font-weight:600;">View Details</span>
            </div>
          </div>
          <div style="background:#2a2a2a;padding:10px;text-align:center;font-size:10px;color:#888;">Footer text</div>
        </div>
      </div>
    </div>
    <div class="guide-darkmode-tips">
      <div class="guide-rule"><span class="guide-rule-icon" style="color:var(--aap-success);">✓</span> Use PNG with transparency for logos — adapts to any bg color</div>
      <div class="guide-rule"><span class="guide-rule-icon" style="color:var(--aap-success);">✓</span> Use <code>rgba()</code> for button bg — Office 365 won't invert it</div>
      <div class="guide-rule"><span class="guide-rule-icon" style="color:var(--aap-success);">✓</span> Include <code>&lt;meta name="color-scheme" content="light dark"&gt;</code></div>
      <div class="guide-rule"><span class="guide-rule-icon" style="color:var(--aap-error);">✗</span> Don't rely on background color alone to convey meaning</div>
    </div>
    <details style="margin-top:16px;">
      <summary style="cursor:pointer;font-weight:500;font-size:14px;color:var(--aap-text-muted);">View client behavior matrix</summary>
      <div style="margin-top:8px;">
        ${guideTable(
          ['Client', 'Behavior', 'CSS Control'],
          [
            ['Apple Mail', 'Partial inversion; respects <code>prefers-color-scheme</code>', 'Full control'],
            ['Gmail (app)', 'Aggressive full inversion', 'Very limited'],
            ['Gmail (web)', 'No inversion', 'N/A'],
            ['Outlook (iOS)', 'Full inversion', 'Limited'],
            ['Outlook (desktop)', 'Injects <code>data-ogsc/data-ogsb</code>', 'Attribute selectors'],
          ]
        )}
      </div>
    </details>`;
}

function renderGuideClientQuirks() {
  const el = document.getElementById('guideClientQuirks');
  if (!el) return;
  el.innerHTML = `
    <h4 style="margin:0 0 8px;">Outlook Desktop (Word Engine)</h4>
    ${guideTable(
      ['Status', 'CSS Property'],
      [
        ['<span style="color:var(--aap-error);">Not supported</span>', '<code>border-radius</code>, <code>background-image</code> (CSS), <code>max-width</code>, <code>float</code>, <code>flexbox</code>, <code>grid</code>, <code>box-shadow</code>, <code>opacity</code>, CSS <code>width/height</code> on images'],
        ['<span style="color:var(--aap-warning);">Requires workaround</span>', 'Padding (only works on <code>&lt;td&gt;</code>), margins on divs/images, VML for rounded corners'],
        ['<span style="color:var(--aap-success);">Works</span>', 'HTML <code>width/height</code> attributes, <code>background-color</code>, <code>font-*</code>, <code>color</code>, <code>text-align</code>, <code>border</code>'],
      ]
    )}
    <h4 style="margin:16px 0 8px;">Gmail</h4>
    ${guideTable(
      ['Limit', 'Detail'],
      [
        ['HTML size', '<code>102KB</code> — clips email with "Message clipped" link. Includes all HTML + inline CSS, not images'],
        ['<code>&lt;style&gt;</code> block', '<code>8,192</code> characters max. A single syntax error invalidates all styles'],
        ['Stripped properties', '<code>position</code>, <code>float</code>, transforms, animations, <code>box-shadow</code>, <code>filter</code>'],
        ['Background image gotcha', 'If ANY rule in <code>&lt;style&gt;</code> contains <code>background-image:url(...)</code>, Gmail strips the ENTIRE style block'],
        ['Media queries', 'Supported on mobile Gmail apps. Ignored on desktop Gmail web'],
      ]
    )}
    <h4 style="margin:16px 0 8px;">Other Clients</h4>
    ${guideTable(
      ['Client', 'Quirk'],
      [
        ['Apple Mail', 'Most standards-compliant. Supports @font-face, CSS animations, flexbox. Design here first, degrade for others'],
        ['Yahoo Mail', 'Converts <code>height</code> to <code>min-height</code>. Strips <code>!important</code> if there is a space before the <code>!</code>'],
        ['Samsung Mail', 'Respects HTML <code>width</code> attribute literally (ignores CSS <code>max-width</code> on images). Fix: use both HTML and CSS width attributes'],
      ]
    )}`;
}

function renderGuideHelpers() {
  const el = document.getElementById('guideHelpers');
  if (!el) return;
  el.innerHTML = `
    ${guideTable(
      ['Function', 'Usage', 'Description'],
      [
        ['<code>wrapEmailHtml(html, options)</code>', '<code>import { wrapEmailHtml } from "../_shared/email-brand-wrapper.ts";</code>', 'Wraps inner HTML in full branded shell (header, body, footer). Options: <code>showHeader</code>, <code>showFooter</code>, <code>preheader</code>, <code>accentColor</code>'],
        ['<code>emailButton(text, url)</code>', '<code>import { emailButton } from "../_shared/email-brand-wrapper.ts";</code>', 'Generates a table-based CTA button with brand styling and Outlook compatibility. Use inside email body content'],
        ['<code>emailCallout(html)</code>', '<code>import { emailCallout } from "../_shared/email-brand-wrapper.ts";</code>', 'Generates a callout/info box with muted background and border. Use for key information, instructions, or summaries'],
      ]
    )}
    <h4 style="margin:16px 0 8px;">Templates That Skip the Wrapper</h4>
    <p style="font-size:13px;color:var(--aap-text-muted);margin-bottom:8px;">These 4 email types have their own complete HTML layouts and are NOT wrapped by <code>wrapEmailHtml()</code>:</p>
    ${guideTable(
      ['Template', 'Reason'],
      [
        ['<code>custom</code>', 'Raw HTML passthrough — admin provides complete HTML'],
        ['<code>staff_invitation</code>', 'Has its own full branded layout with different header design'],
        ['<code>pai_email_reply</code>', 'PAI-branded layout with PAI-specific styling'],
        ['<code>payment_statement</code>', 'Complex table-heavy layout with gradient header for financial data'],
      ]
    )}
    <p style="font-size:13px;color:var(--aap-text-muted);margin-top:12px;"><strong>All other email types use the wrapper.</strong> When creating a new email template, always use <code>wrapEmailHtml()</code> unless you have a specific reason to build a custom layout.</p>`;
}

function renderGuideChecklist() {
  const el = document.getElementById('guideChecklist');
  if (!el) return;
  const STORAGE_KEY = 'brand-checklist-state';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch(e) {}
  const checks = [
    ['html-size', 'Total HTML under 102KB', 'Gmail clips emails over this limit'],
    ['alt-text', 'All images have alt text', 'Shown when images are blocked (corporate Outlook)'],
    ['img-dims', 'All images have explicit width/height', 'HTML attributes for Outlook, CSS for responsive'],
    ['font-min', 'No font size below 13px', 'iOS auto-zooms small text, breaking layout'],
    ['td-padding', 'All padding on &lt;td&gt; elements only', 'Outlook strips padding from divs/p/a'],
    ['table-reset', 'Tables have cellpadding/cellspacing/border reset', 'Prevents default browser spacing'],
    ['table-role', 'Tables have role="presentation"', 'Screen readers skip table structure'],
    ['btn-table', 'CTA uses table-based button pattern', 'emailButton() handles Outlook compat'],
    ['link-style', 'Links underlined with accent color', 'Distinguishable without color vision'],
    ['preheader', 'Preheader text is 70-100 characters', 'Too short pulls body text into preview'],
    ['mobile-test', 'Tested on mobile viewport (375px)', 'Resize browser to verify layout'],
    ['touch-target', 'Touch targets &ge; 44px', 'WCAG minimum for mobile tapping'],
    ['no-bg-img', 'No background-image in &lt;style&gt; block', 'Gmail strips entire style block'],
    ['contrast', 'Colors pass WCAG AA contrast', '4.5:1 normal, 3:1 large text'],
    ['footer', 'Footer has address + platform name', 'CAN-SPAM compliance'],
  ];
  const total = checks.length;
  const checkedCount = checks.filter(([id]) => saved[id]).length;
  el.innerHTML = `
    <div class="guide-checklist-progress">
      <div class="guide-checklist-bar">
        <div class="guide-checklist-bar-fill" style="width:${(checkedCount/total*100).toFixed(0)}%"></div>
      </div>
      <span class="guide-checklist-count">${checkedCount}/${total} checked</span>
      ${checkedCount > 0 ? '<button class="guide-checklist-reset" data-action="reset-checklist">Reset</button>' : ''}
    </div>
    <div class="brand-checklist">${checks.map(([id, item, detail]) => {
      const checked = saved[id] ? 'checked' : '';
      return `<label class="brand-checklist-item brand-checklist-item--interactive ${checked ? 'brand-checklist-item--checked' : ''}" data-check-id="${id}">
        <input type="checkbox" ${checked} style="display:none">
        <div class="brand-checklist-check">
          ${checked
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--aap-success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3" ry="3" fill="var(--aap-success)" fill-opacity="0.1"/><polyline points="9 11 12 14 22 4" stroke="var(--aap-success)"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3" ry="3"/></svg>'
          }
        </div>
        <div>
          <div style="font-weight:500;${checked ? 'text-decoration:line-through;opacity:0.6;' : ''}">${item}</div>
          <div style="font-size:12px;color:var(--aap-text-muted);">${detail}</div>
        </div>
      </label>`;
    }).join('')}</div>`;

  // Wire up click handlers
  el.querySelectorAll('.brand-checklist-item--interactive').forEach(label => {
    label.addEventListener('click', (e) => {
      e.preventDefault();
      const id = label.dataset.checkId;
      saved[id] = !saved[id];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      renderGuideChecklist();
    });
  });
  // Wire up reset button
  const resetBtn = el.querySelector('[data-action="reset-checklist"]');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY);
      renderGuideChecklist();
    });
  }
}

// =============================================
// UI COMPONENTS (Slack-inspired patterns)
// =============================================

function renderUIComponents() {
  const accent = brandConfig.colors?.primary?.accent || '#d4883a';
  const dark   = brandConfig.colors?.primary?.dark   || '#1c1618';
  const cream  = brandConfig.colors?.primary?.cream  || '#faf9f6';
  const border = brandConfig.colors?.primary?.border || '#e6e2d9';
  const muted  = brandConfig.colors?.primary?.['text-muted'] || '#7d6f74';

  // ── Settings Cards ──────────────────────────────────────────────
  const elSettings = document.getElementById('settingsCardDemo');
  if (elSettings) {
    const items = [
      { color: '#3b82f6', icon: '<path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>', label: 'Account settings', desc: 'Email, password, and two-factor authentication' },
      { color: accent, icon: '<circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>', label: 'Notifications', desc: 'Configure how and when you receive alerts' },
      { color: '#14b8a6', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>', label: 'Billing & plan', desc: 'Manage your subscription and payment methods' },
      { color: '#8b5cf6', icon: '<circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/>', label: 'Team members', desc: 'Invite people and manage roles' },
    ];
    elSettings.innerHTML = `<div style="display:flex;flex-direction:column;gap:2px;border-radius:12px;overflow:hidden;border:1px solid ${border};">
      ${items.map((item, i) => `
        <div style="display:flex;align-items:center;gap:14px;padding:14px 16px;background:#fff;cursor:pointer;transition:background 0.15s;"
             onmouseover="this.style.background='${cream}'" onmouseout="this.style.background='#fff'">
          <div style="flex-shrink:0;width:36px;height:36px;border-radius:9px;background:${item.color};display:flex;align-items:center;justify-content:center;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:14px;color:${dark};">${item.label}</div>
            <div style="font-size:12px;color:${muted};margin-top:1px;">${item.desc}</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${muted}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
        ${i < items.length - 1 ? `<div style="height:1px;background:${border};margin-left:66px;"></div>` : ''}
      `).join('')}
    </div>
    <p style="font-size:12px;color:${muted};margin-top:10px;">36px icon tile · 9px radius · 14px label bold · 12px desc muted · full-row chevron hit-target</p>`;
  }

  // ── Icon Tiles ──────────────────────────────────────────────────
  const elTiles = document.getElementById('iconTileDemo');
  if (elTiles) {
    const tiles = [
      { color: '#3b82f6', label: 'Settings',     icon: '<circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>' },
      { color: '#14b8a6', label: 'Residents',    icon: '<circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/>' },
      { color: '#22c55e', label: 'Payments',     icon: '<rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/>' },
      { color: dark,      label: 'Analytics',    icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>' },
      { color: accent,    label: 'Notifications',icon: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>' },
      { color: '#8b5cf6', label: 'Media',        icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>' },
      { color: '#ef4444', label: 'Alerts',       icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' },
      { color: '#f59e0b', label: 'Schedule',     icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
    ];
    elTiles.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:16px;">
      ${tiles.map(t => `
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px;width:64px;">
          <div style="width:48px;height:48px;border-radius:12px;background:${t.color};display:flex;align-items:center;justify-content:center;cursor:pointer;transition:opacity 0.15s;"
               onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>
          </div>
          <span style="font-size:11px;color:${muted};text-align:center;line-height:1.3;">${t.label}</span>
        </div>
      `).join('')}
    </div>
    <p style="font-size:12px;color:${muted};margin-top:14px;">48px tile · 12px radius · 22px icon · one color per functional area</p>`;
  }

  // ── Section Headers ─────────────────────────────────────────────
  const elHeaders = document.getElementById('sectionHeaderDemo');
  if (elHeaders) {
    const headers = [
      { emoji: '🏠', title: 'Property Overview', desc: 'Current occupancy, availability, and space status across all units.' },
      { emoji: '💳', title: 'Payments & Billing', desc: 'Recent transactions, outstanding balances, and payment history.' },
      { emoji: '⚡', title: 'Integrations', desc: 'Connected services and third-party apps syncing with your workspace.' },
    ];
    elHeaders.innerHTML = `<div style="display:flex;flex-direction:column;gap:24px;">
      ${headers.map(h => `
        <div style="padding-bottom:20px;border-bottom:1px solid ${border};">
          <h3 style="font-size:18px;font-weight:700;color:${dark};margin:0 0 4px;display:flex;align-items:center;gap:8px;">
            <span>${h.emoji}</span>${h.title}
          </h3>
          <p style="font-size:14px;color:${muted};margin:0;">${h.desc}</p>
        </div>
      `).join('')}
    </div>
    <p style="font-size:12px;color:${muted};margin-top:14px;">18px bold title · optional emoji prefix · 14px muted description · bottom border divider</p>`;
  }

  // ── Navigation List ─────────────────────────────────────────────
  const elNav = document.getElementById('navListDemo');
  if (elNav) {
    const navItems = [
      { icon: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>', label: 'Overview',   badge: null,  active: false },
      { icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>', label: 'Spaces', badge: null,  active: false },
      { icon: '<circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/>', label: 'Residents',   badge: '3',   active: true  },
      { icon: '<rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/>',                 label: 'Payments',    badge: null,  active: false },
      { icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',                                  label: 'Reports',     badge: null,  active: false },
    ];
    elNav.innerHTML = `<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start;">
      <div style="width:220px;background:${cream};border-radius:12px;padding:8px;border:1px solid ${border};">
        ${navItems.map(item => `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 10px 10px ${item.active ? '7px' : '10px'};border-radius:8px;cursor:pointer;transition:background 0.15s;
               border-left:${item.active ? `3px solid ${accent}` : '3px solid transparent'};
               background:${item.active ? '#fff' : 'transparent'};"
               onmouseover="this.style.background='${item.active ? '#fff' : '#f0ede7'}'" onmouseout="this.style.background='${item.active ? '#fff' : 'transparent'}'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${item.active ? accent : muted}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>
            <span style="flex:1;font-size:14px;font-weight:${item.active ? '600' : '400'};color:${item.active ? dark : muted};">${item.label}</span>
            ${item.badge ? `<span style="background:${accent};color:#fff;font-size:11px;font-weight:700;padding:1px 6px;border-radius:10px;">${item.badge}</span>` : ''}
          </div>
        `).join('')}
      </div>
      <div style="flex:1;min-width:200px;padding:12px 0;">
        <p style="font-size:13px;color:${muted};line-height:1.6;margin:0;">
          Active item: <strong>3px accent left border</strong>, white background, bold label, colored icon.<br>
          Inactive items: transparent bg, muted icon + label.<br>
          Badge: amber pill, white text, 11px bold.
        </p>
      </div>
    </div>`;
  }

  // ── App / Integration Tiles ──────────────────────────────────────
  const elApps = document.getElementById('appTileDemo');
  if (elApps) {
    const apps = [
      { name: 'Slack',    bg: '#611f69', letter: 'S' },
      { name: 'Stripe',   bg: '#635bff', letter: 'St' },
      { name: 'Resend',   bg: '#000',    letter: 'R' },
      { name: 'Square',   bg: '#3e4348', letter: 'Sq' },
      { name: 'Govee',    bg: '#ff6c00', letter: 'G' },
      { name: 'Tesla',    bg: '#cc0000', letter: 'T' },
      { name: 'Nest',     bg: '#1fa866', letter: 'N' },
      { name: 'Vapi',     bg: '#7c3aed', letter: 'V' },
    ];
    elApps.innerHTML = `<div style="display:flex;flex-direction:column;gap:20px;">
      <div>
        <p style="font-size:12px;font-weight:600;color:${muted};text-transform:uppercase;letter-spacing:0.06em;margin:0 0 10px;">Connected Integrations</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${apps.map(app => `
            <div title="${app.name}" style="width:40px;height:40px;border-radius:50%;background:${app.bg};display:flex;align-items:center;justify-content:center;
                 border:2px solid #fff;outline:1px solid ${border};cursor:pointer;transition:transform 0.15s;flex-shrink:0;"
                 onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'">
              <span style="color:#fff;font-size:12px;font-weight:700;">${app.letter}</span>
            </div>
          `).join('')}
          <div style="width:40px;height:40px;border-radius:50%;border:2px dashed ${border};display:flex;align-items:center;justify-content:center;cursor:pointer;color:${muted};font-size:20px;font-weight:300;line-height:1;"
               onmouseover="this.style.borderColor='${accent}';this.style.color='${accent}'" onmouseout="this.style.borderColor='${border}';this.style.color='${muted}'">+</div>
        </div>
      </div>
      <div>
        <p style="font-size:12px;font-weight:600;color:${muted};text-transform:uppercase;letter-spacing:0.06em;margin:0 0 10px;">Rounded Square Variant</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${apps.slice(0,4).map(app => `
            <div title="${app.name}" style="width:40px;height:40px;border-radius:10px;background:${app.bg};display:flex;align-items:center;justify-content:center;
                 border:1px solid rgba(0,0,0,0.1);cursor:pointer;transition:transform 0.15s;flex-shrink:0;"
                 onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'">
              <span style="color:#fff;font-size:12px;font-weight:700;">${app.letter}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
    <p style="font-size:12px;color:${muted};margin-top:14px;">40px icons · circular or 10px-radius square · 8px gap · hover scale(1.1) · "+" add button with dashed border</p>`;
  }
}

// =============================================
// RAW JSON
// =============================================

function renderRawJson() {
  const el = document.getElementById('rawJson');
  if (!el || !brandConfig) return;
  el.textContent = JSON.stringify(brandConfig, null, 2);
}

/* ===================================================================
   DESIGN TOKENS — live CSS custom property demos
   =================================================================== */

function renderSpacingScale() {
  const el = document.getElementById('spacingScale');
  if (!el) return;
  const stops = [
    ['--aap-space-0', '0'],
    ['--aap-space-1', '4 px'],
    ['--aap-space-2', '8 px'],
    ['--aap-space-3', '12 px'],
    ['--aap-space-4', '16 px'],
    ['--aap-space-5', '20 px'],
    ['--aap-space-6', '24 px'],
    ['--aap-space-8', '32 px'],
    ['--aap-space-10', '40 px'],
    ['--aap-space-12', '48 px'],
    ['--aap-space-16', '64 px'],
    ['--aap-space-20', '80 px'],
    ['--aap-space-24', '96 px'],
  ];
  el.innerHTML = stops.map(([token, label]) => {
    const val = getCSSVar(token) || '0';
    return `<div class="flex items-center gap-3 py-1">
      <code class="text-xs w-36 shrink-0">${token}</code>
      <span class="text-xs text-aap-text-muted w-12 shrink-0 text-right">${label}</span>
      <div class="h-3 rounded-sm" style="width:${val};background:var(--aap-accent);min-width:2px"></div>
    </div>`;
  }).join('');
}

function renderSpacingAliases() {
  const el = document.getElementById('spacingAliases');
  if (!el) return;
  const aliases = [
    ['--aap-space-xs', '--aap-space-2', '8 px'],
    ['--aap-space-sm', '--aap-space-4', '16 px'],
    ['--aap-space-md', '--aap-space-6', '24 px'],
    ['--aap-space-lg', '--aap-space-8', '32 px'],
    ['--aap-space-xl', '--aap-space-12', '48 px'],
    ['--aap-space-2xl', '--aap-space-16', '64 px'],
    ['--aap-space-3xl', '--aap-space-24', '96 px'],
  ];
  el.innerHTML = `<div class="grid grid-cols-[auto_auto_auto_1fr] gap-x-4 gap-y-1 items-center">
    ${aliases.map(([alias, maps, label]) => `
      <code class="text-xs">${alias}</code>
      <span class="text-xs text-aap-text-muted">&rarr;</span>
      <code class="text-xs text-aap-text-muted">${maps}</code>
      <span class="text-xs text-aap-text-muted">${label}</span>
    `).join('')}
  </div>`;
}

function renderTokenTypeScale() {
  const el = document.getElementById('tokenTypeScale');
  if (!el) return;
  const sizes = [
    ['--aap-text-xs', '0.75rem', '12 px'],
    ['--aap-text-sm', '0.875rem', '14 px'],
    ['--aap-text-base', '1rem', '16 px'],
    ['--aap-text-lg', '1.125rem', '18 px'],
    ['--aap-text-xl', '1.25rem', '20 px'],
    ['--aap-text-2xl', '1.5rem', '24 px'],
    ['--aap-text-3xl', '2rem', '32 px'],
  ];
  el.innerHTML = sizes.map(([token, rem, px]) =>
    `<div class="flex items-baseline gap-4 py-2 border-b border-aap-border last:border-0">
      <code class="text-xs w-32 shrink-0">${token}</code>
      <span class="text-xs text-aap-text-muted w-16 shrink-0">${px}</span>
      <span style="font-size:var(${token});line-height:1.3">The quick brown property</span>
    </div>`
  ).join('');
}

function renderMotionTokens() {
  const el = document.getElementById('motionTokens');
  if (!el) return;
  const durations = [
    ['--aap-duration-fast', '150 ms'],
    ['--aap-duration', '200 ms'],
    ['--aap-duration-slow', '400 ms'],
  ];
  const easings = [
    ['--aap-ease', 'ease'],
    ['--aap-ease-out', 'cubic-bezier(0.16, 1, 0.3, 1)'],
  ];
  el.innerHTML = `
    <div class="mb-6">
      <h4 class="text-sm font-semibold mb-3">Durations</h4>
      <div class="flex gap-6 flex-wrap">
        ${durations.map(([token, label]) => `
          <div class="flex flex-col items-center gap-2">
            <div class="w-14 h-14 rounded-aap bg-aap-accent-light flex items-center justify-center cursor-pointer motion-demo-box"
                 style="transition:transform var(${token}) var(--aap-ease),background var(${token}) var(--aap-ease)"
                 onmouseenter="this.style.transform='scale(1.3)';this.style.background='var(--aap-accent)'"
                 onmouseleave="this.style.transform='scale(1)';this.style.background='var(--aap-accent-light)'">
              <span class="text-xs font-semibold" style="pointer-events:none">${label}</span>
            </div>
            <code class="text-xs">${token}</code>
          </div>
        `).join('')}
      </div>
    </div>
    <div>
      <h4 class="text-sm font-semibold mb-3">Easing Curves</h4>
      <div class="flex gap-6 flex-wrap">
        ${easings.map(([token, label]) => `
          <div class="flex flex-col items-center gap-2">
            <div class="w-14 h-14 rounded-aap bg-aap-accent-light flex items-center justify-center cursor-pointer"
                 style="transition:transform var(--aap-duration-slow) ${label},background var(--aap-duration-slow) ${label}"
                 onmouseenter="this.style.transform='scale(1.3)';this.style.background='var(--aap-accent)'"
                 onmouseleave="this.style.transform='scale(1)';this.style.background='var(--aap-accent-light)'">
              <span class="text-xs font-semibold text-center leading-tight" style="pointer-events:none">${token.replace('--aap-','')}</span>
            </div>
            <code class="text-xs">${token}</code>
            <span class="text-xs text-aap-text-muted">${label}</span>
          </div>
        `).join('')}
      </div>
    </div>`;
}

function renderZIndexTokens() {
  const el = document.getElementById('zIndexTokens');
  if (!el) return;
  const layers = [
    ['--aap-z-toast', 500, '#c53030'],
    ['--aap-z-modal', 400, '#d4883a'],
    ['--aap-z-overlay', 300, '#2d8a4e'],
    ['--aap-z-sticky', 200, '#3182ce'],
    ['--aap-z-dropdown', 100, '#7d6f74'],
  ];
  el.innerHTML = `<div class="relative h-52 flex items-end gap-1">
    ${layers.map(([token, val, color], i) => {
      const h = 30 + (layers.length - i) * 20;
      const left = i * 28;
      return `<div class="absolute rounded-aap-sm px-3 py-2 text-white text-xs font-semibold shadow-aap flex flex-col justify-end"
                   style="background:${color};height:${h}%;left:${left}px;right:${(layers.length - 1 - i) * 28}px;z-index:${i + 1}">
        <code class="text-white/90">${token}</code>
        <span class="text-white/70">${val}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderLayoutTokens() {
  const el = document.getElementById('layoutTokens');
  if (!el) return;
  const widths = [
    ['--aap-max-width', '1200px'],
    ['--aap-max-width-lg', '1024px'],
    ['--aap-max-width-md', '768px'],
    ['--aap-max-width-sm', '640px'],
    ['--aap-header-height', '44px'],
  ];
  const maxVal = 1200;
  el.innerHTML = widths.map(([token, label]) => {
    const px = parseInt(label);
    const pct = token.includes('header') ? null : Math.round((px / maxVal) * 100);
    return `<div class="flex items-center gap-3 py-2">
      <code class="text-xs w-40 shrink-0">${token}</code>
      <span class="text-xs text-aap-text-muted w-16 shrink-0 text-right">${label}</span>
      ${pct !== null
        ? `<div class="h-3 rounded-sm bg-aap-info" style="width:${pct}%"></div>`
        : `<div class="h-6 rounded-sm bg-aap-warning flex items-center px-2" style="width:${px}px"><span class="text-xs text-white font-semibold" style="pointer-events:none">header</span></div>`
      }
    </div>`;
  }).join('');
}
