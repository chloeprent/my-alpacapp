/**
 * Email Brand Wrapper
 *
 * Wraps email HTML content in a consistent branded shell with:
 * - Branded header (dark background, property icon + wordmark)
 * - Consistent body styling (fonts, colors, spacing)
 * - Branded footer (address, tagline)
 * - Inline styles for email client compatibility
 *
 * Usage in send-email/index.ts:
 *   import { wrapEmailHtml } from '../_shared/email-brand-wrapper.ts';
 *   const wrappedHtml = wrapEmailHtml(innerHtml, { showHeader: true });
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// In-memory cache for brand config + gallery images
let _brandCache: { config: any; fetchedAt: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

// Hardcoded fallback (matches DB seed)
const FALLBACK = {
  brand: {
    primary_name: 'YOUR_PROPERTY_NAME',
    full_name: 'YOUR_PROPERTY_NAME Austin',
    platform_name: 'YOUR_APP_NAME',
    tagline: 'We put the AI into Propertys',
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
      border: '#e6e2d9',
    },
  },
  typography: {
    font_family: 'DM Sans',
    font_stack: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  logos: {
    base_url: 'YOUR_SUPABASE_URL/storage/v1/object/public/housephotos/logos',
    icon_light: 'logo-white-transparent.png',
    wordmark_light: 'wordmark-white-transparent.png',
  },
  email: {
    max_width: '600px',
    header: { background: '#2d2225', text_color: '#faf9f6', padding: '20px', logo_height: '40px', wordmark_height: '20px' },
    body: { background: '#faf9f6', text_color: '#2a1f23', text_muted: '#7d6f74', padding: '32px', line_height: '1.6' },
    callout: { background: '#f2f0e8', border_color: '#e6e2d9', border_radius: '8px', padding: '20px 24px' },
    button: { background: '#d4883a', text_color: '#ffffff', border_radius: '8px', padding: '14px 36px', font_weight: '600', shadow: '0 2px 8px rgba(212, 136, 58, 0.30)' },
    footer: { background: '#f2f0e8', text_color: '#7d6f74', border_top: '1px solid #e6e2d9', padding: '20px 32px' },
  },
};

/**
 * Load brand config from DB (cached).
 */
async function loadBrandConfig(): Promise<any> {
  if (_brandCache && Date.now() - _brandCache.fetchedAt < CACHE_TTL) {
    return _brandCache.config;
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await sb
      .from("brand_config")
      .select("config")
      .eq("id", 1)
      .single();

    if (data && !error) {
      _brandCache = { config: data.config, fetchedAt: Date.now() };
      return data.config;
    }
  } catch (e) {
    console.warn("Failed to load brand_config, using fallback:", e);
  }

  _brandCache = { config: FALLBACK, fetchedAt: Date.now() };
  return FALLBACK;
}

/**
 * Load 1 random property image for email footer (no cache — pick fresh each call).
 * Prefers images tagged "email footer"; falls back to any mktg image.
 */
async function loadGalleryImages(): Promise<string[]> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // First: try images tagged "pai-email-art" (property artwork for emails)
    const { data: tagRow } = await sb
      .from("media_tags")
      .select("id")
      .ilike("name", "pai-email-art")
      .limit(1)
      .single();

    if (tagRow?.id) {
      const { data: taggedMedia } = await sb
        .from("media_tag_assignments")
        .select("media:media_id(url, uploaded_at, is_archived)")
        .eq("tag_id", tagRow.id)
        .limit(50);

      const candidates = taggedMedia
        ?.map((r: any) => r.media)
        .filter((m: any) => m?.url && !m.is_archived) ?? [];

      if (candidates.length >= 2) {
        // Pick 2 distinct random images
        const shuffled = [...candidates].sort(() => Math.random() - 0.5);
        return [shuffled[0].url, shuffled[1].url];
      }
      if (candidates.length === 1) {
        return [candidates[0].url];
      }
    }

    // Fallback: random mktg category images
    const { data, error } = await sb
      .from("media")
      .select("url")
      .eq("category", "mktg")
      .eq("is_archived", false)
      .limit(50);

    if (data && !error && data.length >= 2) {
      const shuffled = [...data].sort(() => Math.random() - 0.5);
      return [shuffled[0].url, shuffled[1].url];
    }
    if (data && !error && data.length === 1) {
      return [data[0].url];
    }
  } catch (e) {
    console.warn("Failed to load gallery images:", e);
  }

  return [];
}

export interface WrapOptions {
  /** Show the branded header with logo (default: true) */
  showHeader?: boolean;
  /** Show the branded footer with address (default: true) */
  showFooter?: boolean;
  /** Show the property image gallery above footer (default: true) */
  showGallery?: boolean;
  /** Show the PAI signature block (default: true) */
  showSignature?: boolean;
  /** Show the feedback/question CTA (default: true) */
  showFeedback?: boolean;
  /** Email subject for feedback mailto context */
  emailSubject?: string;
  /** Custom preheader text (hidden preview text in email clients) */
  preheader?: string;
  /** Override accent color for the CTA button */
  accentColor?: string;
  /** Extra images to show above the property gallery (e.g. space photo) */
  extraImages?: string[];
}

/**
 * Wrap inner HTML content in the branded email shell.
 *
 * @param innerHtml - The email body content (already rendered with data)
 * @param options - Display options
 * @returns Full HTML document string for the email
 */
export async function wrapEmailHtml(
  innerHtml: string,
  options: WrapOptions = {}
): Promise<string> {
  const { showHeader = true, showFooter = true, showGallery = true, showSignature = true, showFeedback = true, emailSubject = '', preheader = '', accentColor, extraImages } = options;
  const [b, galleryImages] = await Promise.all([
    loadBrandConfig(),
    showGallery ? loadGalleryImages() : Promise.resolve([]),
  ]);

  const c = b.colors?.primary || FALLBACK.colors.primary;
  const e = b.email || FALLBACK.email;
  const logos = b.logos || FALLBACK.logos;
  const brand = b.brand || FALLBACK.brand;
  const typo = b.typography || FALLBACK.typography;

  const logoBase = logos.base_url;
  const iconUrl = `${logoBase}/${logos.icon_light}`;
  const wordmarkUrl = `${logoBase}/${logos.wordmark_light}`;
  const fontFamily = typo.font_stack || FALLBACK.typography.font_stack;

  const accent = accentColor || c.accent;

  const siteUrl = brand.website || 'https://YOUR_DOMAIN';
  const headerHtml = showHeader ? `
    <!-- Header -->
    <tr>
      <td class="email-header-td" style="background:${e.header.background};padding:${e.header.padding};text-align:center;">
        <a href="${siteUrl}" style="text-decoration:none;" target="_blank">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
            <tr>
              <td style="padding-right:12px;vertical-align:middle;">
                <img src="${iconUrl}" alt="" width="40" height="40" style="display:block;height:${e.header.logo_height};width:auto;" />
              </td>
              <td style="vertical-align:middle;">
                <img src="${wordmarkUrl}" alt="${brand.full_name}" height="20" style="display:block;height:${e.header.wordmark_height};width:auto;" />
              </td>
            </tr>
          </table>
        </a>
      </td>
    </tr>` : '';

  const footerHtml = showFooter ? `
    <!-- Footer -->
    <tr>
      <td class="email-footer-td" style="background:${e.footer.background};padding:${e.footer.padding};text-align:center;border-top:${e.footer.border_top};">
        <p style="margin:0 0 6px;color:${e.footer.text_color};font-size:12px;line-height:18px;font-family:${fontFamily};">${brand.address || ''}</p>
        <p style="margin:0;color:${e.footer.text_color};font-size:11px;line-height:16px;font-family:${fontFamily};opacity:0.7;">${brand.platform_name} &bull; ${brand.tagline}</p>
      </td>
    </tr>` : '';

  // Signature block — centralized so all emails get the same sign-off
  const signatureHtml = showSignature ? `
    <!-- Signature -->
    <tr>
      <td style="padding:16px ${e.body.padding} 0;font-family:${fontFamily};">
        <p style="margin:0;color:${c.text_muted};font-size:15px;line-height:1.6;font-style:italic;">Yours generatively,</p>
        <p style="margin:4px 0 0;color:${c.text};font-size:15px;line-height:1.6;font-weight:600;">PAI</p>
        <p style="margin:2px 0 0;color:${c.text_muted};font-size:13px;line-height:1.4;">the YOUR_PROPERTY_NAME property AI agent</p>
      </td>
    </tr>` : '';

  // Feedback box — encourages replies/questions
  const feedbackSubject = encodeURIComponent(emailSubject ? `Re: ${emailSubject}` : 'Question / Feedback');
  const feedbackBoxHtml = showFeedback ? `
    <!-- Feedback Box -->
    <tr>
      <td style="padding:20px ${e.body.padding} 8px;font-family:${fontFamily};">
        <div style="background:${c.background_muted};border:1px solid ${c.border};border-radius:8px;padding:16px 20px;text-align:center;">
          <p style="margin:0 0 10px;color:${c.text};font-size:14px;font-weight:600;">Any questions or feedback?</p>
          <a href="mailto:pai@YOUR_DOMAIN?subject=${feedbackSubject}" style="display:inline-block;background:${accent};color:#ffffff;padding:10px 24px;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;font-family:${fontFamily};">Send PAI a Message</a>
          <p style="margin:10px 0 0;color:${c.text_muted};font-size:12px;">Or just reply to this email</p>
        </div>
      </td>
    </tr>` : '';

  // Build gallery: extra images (e.g. space photo) + property imagery, stacked vertically
  const allGalleryImages = [...(extraImages || []), ...galleryImages];
  const galleryHtml = allGalleryImages.length > 0 ? `
    <!-- Image Gallery -->
    <tr>
      <td style="padding:0 ${e.body.padding} 8px;">
        ${allGalleryImages.map(url => `
          <img src="${url}" alt="" width="536" style="display:block;width:100%;max-width:536px;height:auto;border-radius:8px;border:1px solid ${c.border};margin-bottom:8px;" />
        `).join('')}
      </td>
    </tr>` : '';

  const preheaderHtml = preheader
    ? `<div style="display:none;font-size:1px;color:${c.background_muted};line-height:1px;max-height:0;overflow:hidden;mso-hide:all;">${preheader}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${brand.full_name}</title>
  <!--[if gte mso 9]>
  <xml>
    <o:OfficeDocumentSettings>
      <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings>
  </xml>
  <![endif]-->
  <!--[if mso]><style>body,table,td,p,a,h1,h2,h3,h4{font-family:Arial,Helvetica,sans-serif!important}a{color:${accent}}</style><![endif]-->
  <style>
    :root { color-scheme: light dark; }
    body { margin:0; padding:0; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table { border-collapse:collapse; mso-table-lspace:0; mso-table-rspace:0; }
    img { border:0; -ms-interpolation-mode:bicubic; display:block; }
    a { color:${accent}; text-decoration:underline; }
    h1, h2, h3, h4, p { margin:0; }
    @media screen and (max-width:480px) {
      .email-body-td { padding:24px 20px !important; }
      .email-header-td { padding:24px 20px !important; }
      .email-footer-td { padding:16px 20px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${c.background_muted};font-family:${fontFamily};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;">
  ${preheaderHtml}
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${c.background_muted};">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <!-- Email Container -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:${e.max_width};width:100%;background:${c.background};border-radius:12px;overflow:hidden;box-shadow:${FALLBACK.email.body.background === c.background ? '0 2px 12px rgba(42,31,35,0.06)' : 'none'};">
          ${headerHtml}
          <!-- Body -->
          <tr>
            <td class="email-body-td" style="padding:${e.body.padding};color:${e.body.text_color};font-size:16px;line-height:${e.body.line_height};font-family:${fontFamily};">
              ${innerHtml}
            </td>
          </tr>
          ${signatureHtml}
          ${feedbackBoxHtml}
          ${galleryHtml}
          ${footerHtml}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Generate a branded CTA button HTML string.
 * Use inside email body content.
 */
export function emailButton(text: string, url: string, config?: any): string {
  const e = config?.email?.button || FALLBACK.email.button;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px auto;text-align:center;">
    <tr>
      <td style="background:${e.background};border-radius:${e.border_radius};box-shadow:${e.shadow};mso-padding-alt:14px 36px;">
        <a href="${url}" style="display:inline-block;padding:${e.padding};color:${e.text_color};text-decoration:none;font-weight:${e.font_weight};font-size:16px;line-height:1;font-family:'DM Sans',Arial,Helvetica,sans-serif;letter-spacing:0.02em;-webkit-text-size-adjust:none;" target="_blank">${text}</a>
      </td>
    </tr>
  </table>`;
}

/**
 * Generate a branded callout/info box HTML string.
 * Use inside email body content.
 */
export function emailCallout(innerHtml: string, config?: any): string {
  const e = config?.email?.callout || FALLBACK.email.callout;
  return `<div style="background:${e.background};border:1px solid ${e.border_color};border-radius:${e.border_radius};padding:${e.padding};margin:16px 0;">
    ${innerHtml}
  </div>`;
}

/**
 * Get the brand config synchronously (from cache or fallback).
 * Call loadBrandConfig() first if you need fresh data.
 */
export function getBrandConfigSync(): any {
  return _brandCache?.config || FALLBACK;
}

export { loadBrandConfig };
