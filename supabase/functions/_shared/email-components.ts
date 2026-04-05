/**
 * Shared Email Components
 *
 * Reusable HTML building blocks for email templates. These ensure consistency
 * across all outbound emails for:
 *   - Payment methods (branded badges with account identifiers)
 *   - Data tables with alternating row shading
 *   - Footer image templates
 *   - Section headers
 *
 * Usage:
 *   import { paymentMethodsBlock, dataTable, emailSection } from '../_shared/email-components.ts';
 */

// =============================================
// BRAND TOKENS (match email-brand-wrapper.ts)
// =============================================

export const B = {
  bg: '#faf9f6',
  bgMuted: '#f2f0e8',
  dark: '#1c1618',
  text: '#2a1f23',
  textMuted: '#7d6f74',
  accent: '#d4883a',
  border: '#e6e2d9',
  success: '#54a326',
  danger: '#c62828',
  warning: '#e65100',
  info: '#2563eb',
};

// =============================================
// PAYMENT METHOD BADGES
// =============================================

/** Branded badge config for each payment method type */
export const PAYMENT_BADGES: Record<string, { bg: string; label: string }> = {
  venmo:    { bg: '#3d95ce', label: 'Venmo' },
  zelle:    { bg: '#6c1cd3', label: 'Zelle' },
  cashapp:  { bg: '#00D632', label: 'Cash App' },
  paypal:   { bg: '#003087', label: 'PayPal' },
  bank_ach: { bg: '#333333', label: 'Bank' },
  square:   { bg: '#1a1a1a', label: 'Square' },
  stripe:   { bg: '#635bff', label: 'Stripe' },
  cash:     { bg: '#2e7d32', label: 'Cash' },
  check:    { bg: '#555',    label: 'Check' },
  other:    { bg: '#888',    label: 'Other' },
};

/** Default payment methods when _payment_methods_raw is not available */
const DEFAULT_METHODS = [
  { method_type: 'venmo', account_identifier: '@PropertyPlayhouse' },
  { method_type: 'zelle', account_identifier: 'admin@YOUR_DOMAIN' },
];

export interface PaymentMethod {
  method_type: string;
  name?: string;
  account_identifier?: string;
  instructions?: string;
}

export interface PaymentBlockOptions {
  /** Section heading (default: "Payment Methods") */
  heading?: string;
  /** Optional pay-online URL for Stripe button */
  payUrl?: string;
  /** Fee disclosure text */
  feeText?: string;
  /** Whether to include the memo reminder */
  showMemoReminder?: boolean;
  /** Custom memo text (default: "rent") */
  memoText?: string;
}

/**
 * Generate a standardized payment methods block.
 *
 * Always renders the same branded badge layout. Use this everywhere payment
 * methods appear — move_in_confirmed, deposit_requested, payment_reminder,
 * payment_overdue, payment_statement, lease_signed, etc.
 *
 * @param methods - Array of payment method objects (from `_payment_methods_raw` or default)
 * @param options - Display options
 * @returns HTML string for the payment methods section
 */
export function paymentMethodsBlock(
  methods?: PaymentMethod[] | null,
  options: PaymentBlockOptions = {}
): string {
  const {
    heading = 'Payment Methods',
    payUrl,
    feeText = 'Credit card, debit card, or bank transfer (ACH) — 0.8% processing fee, max $5',
    showMemoReminder = true,
    memoText = 'rent',
  } = options;

  const items = methods && methods.length > 0 ? methods : DEFAULT_METHODS;

  // Card-type methods that get separated with a divider and fee disclosure
  const CARD_TYPES = new Set(['stripe', 'square', 'bank_ach']);

  // Split into free methods (top) and card methods (below divider)
  const freeMethods = items.filter(m => !CARD_TYPES.has(m.method_type));
  const cardMethods = items.filter(m => CARD_TYPES.has(m.method_type));

  const renderRow = (m: PaymentMethod) => {
    const badge = PAYMENT_BADGES[m.method_type] || PAYMENT_BADGES.other;
    const id = m.account_identifier
      ? `<strong style="margin-left:8px;">${m.account_identifier}</strong>`
      : '';
    const instr = m.instructions
      ? `<span style="color:${B.textMuted};font-size:12px;margin-left:4px;">(${m.instructions.split('\\n')[0]})</span>`
      : '';

    return `<tr>
      <td style="padding:6px 0;border-bottom:1px solid ${B.border};">
        <span style="display:inline-block;background:${badge.bg};color:white;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;width:55px;text-align:center;">${badge.label}</span>
        ${id}${instr}
      </td>
    </tr>`;
  };

  const freeRows = freeMethods.map(renderRow).join('\n');

  // Card section with divider and fee text
  const cardSection = cardMethods.length > 0 ? `
    <tr><td style="padding:8px 0 4px;border-bottom:none;">
      <div style="border-top:1px dashed ${B.border};margin:4px 0;"></div>
      <p style="margin:4px 0 2px;font-size:11px;color:${B.textMuted};text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Online Payment</p>
    </td></tr>
    ${cardMethods.map(renderRow).join('\n')}
    <tr><td style="padding:4px 0 0;">
      <p style="margin:0;font-size:12px;color:${B.textMuted};">${feeText}</p>
    </td></tr>` : '';

  const payButton = payUrl
    ? `<div style="text-align:center;margin-top:12px;">
        <a href="${payUrl}" style="display:inline-block;background:${B.accent};color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.3px;">Pay Online</a>
      </div>`
    : '';

  const memoReminder = showMemoReminder
    ? `<p style="margin:8px 0 0;font-size:12px;color:${B.textMuted};">Please include your name and "${memoText}" in the payment memo.</p>`
    : '';

  return `<div style="background:${B.bgMuted};border:1px solid ${B.border};border-radius:8px;padding:16px;margin:16px 0;">
    <p style="margin:0 0 8px;font-weight:600;color:${B.text};font-size:14px;">${heading}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${freeRows}${cardSection}</table>
    ${payButton}
    ${memoReminder}
  </div>`;
}

/**
 * Generate plain text payment methods list.
 */
export function paymentMethodsText(
  methods?: PaymentMethod[] | null,
  options: { memoText?: string } = {}
): string {
  const items = methods && methods.length > 0 ? methods : DEFAULT_METHODS;
  const lines = items.map((m) => {
    const badge = PAYMENT_BADGES[m.method_type] || PAYMENT_BADGES.other;
    const id = m.account_identifier ? `: ${m.account_identifier}` : '';
    return `- ${badge.label}${id}`;
  });

  lines.push('');
  lines.push(`Please include your name and "${options.memoText || 'rent'}" in the payment memo.`);
  return lines.join('\n');
}

// =============================================
// DATA TABLE WITH ALTERNATING ROW SHADING
// =============================================

export interface DataRow {
  label: string;
  value: string;
  /** Optional inline styles for the value cell */
  valueStyle?: string;
}

export interface DataTableOptions {
  /** Table heading shown in a dark header row (optional) */
  heading?: string;
  /** Label column width (default: '120px') */
  labelWidth?: string;
  /** Whether to add border around the table (default: true) */
  bordered?: boolean;
}

/**
 * Generate a data table with alternating row shading.
 *
 * Every email that shows key-value pairs (reservation details, applicant info,
 * event details, etc.) should use this for visual consistency.
 *
 * @param rows - Array of { label, value, valueStyle? }
 * @param options - Display options
 * @returns HTML string for the styled table
 */
export function dataTable(rows: DataRow[], options: DataTableOptions = {}): string {
  const {
    heading,
    labelWidth = '120px',
    bordered = true,
  } = options;

  if (rows.length === 0) return '';

  const headerRow = heading
    ? `<thead>
        <tr style="background:${B.dark};">
          <th colspan="2" style="padding:10px 12px;text-align:left;color:#faf9f6;font-weight:600;font-size:14px;letter-spacing:0.3px;">${heading}</th>
        </tr>
      </thead>`
    : '';

  const bodyRows = rows.map((row, i) => {
    const rowBg = i % 2 === 0 ? B.bg : B.bgMuted;
    return `<tr style="background:${rowBg};">
      <td style="padding:10px 12px;color:${B.textMuted};font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;width:${labelWidth};vertical-align:top;">${row.label}</td>
      <td style="padding:10px 12px;color:${B.text};font-size:15px;${row.valueStyle || ''}">${row.value}</td>
    </tr>`;
  }).join('\n');

  const borderStyle = bordered
    ? `border:1px solid ${B.border};border-radius:8px;overflow:hidden;`
    : '';

  return `<table style="border-collapse:collapse;width:100%;margin:0 0 16px;font-size:14px;${borderStyle}">
    ${headerRow}
    <tbody>
      ${bodyRows}
    </tbody>
  </table>`;
}

/**
 * Generate a plain text data table (for text/plain email versions).
 */
export function dataTableText(rows: DataRow[]): string {
  return rows.map(r => `- ${r.label}: ${r.value.replace(/<[^>]*>/g, '')}`).join('\n');
}

// =============================================
// LEDGER / STATEMENT TABLE
// =============================================

export interface LedgerRow {
  date: string;
  description: string;
  amount: number;
  status: string; // 'Paid' | 'Overdue' | 'Due' | 'Pending'
}

/**
 * Generate a ledger table with status badges and conditional row styling.
 * Used in payment_statement emails.
 */
export function ledgerTable(items: LedgerRow[]): string {
  if (items.length === 0) return '';

  const statusColors: Record<string, { bg: string; text: string }> = {
    Paid:    { bg: '#e8f5e9', text: '#2e7d32' },
    Overdue: { bg: '#ffebee', text: '#c62828' },
    Due:     { bg: '#fff3e0', text: '#e65100' },
    Pending: { bg: '#f3e5f5', text: '#7b1fa2' },
  };

  const rows = items.map((item, i) => {
    const sc = statusColors[item.status] || statusColors.Due;
    const isOverdue = item.status === 'Overdue';
    const isPaid = item.status === 'Paid';
    const rowBg = i % 2 === 0 ? '' : `background:${B.bgMuted};`;
    const overdueBg = isOverdue ? 'background:#fff8f8;' : '';
    const amtColor = isOverdue ? `color:${B.danger};font-weight:600;` : isPaid ? `color:${B.text};` : `color:${B.textMuted};`;
    const txtColor = isPaid ? `color:${B.text};` : `color:${B.textMuted};`;

    return `<tr style="${overdueBg || rowBg}">
      <td style="padding:12px 8px;border-bottom:1px solid ${B.border};${txtColor}">${item.date}</td>
      <td style="padding:12px 8px;border-bottom:1px solid ${B.border};${txtColor}">${item.description}</td>
      <td style="padding:12px 8px;border-bottom:1px solid ${B.border};text-align:right;${amtColor}">$${item.amount.toFixed(2)}</td>
      <td style="padding:12px 8px;border-bottom:1px solid ${B.border};text-align:center;">
        <span style="background:${sc.bg};color:${sc.text};padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;">${item.status}</span>
      </td>
    </tr>`;
  }).join('\n');

  return `<table style="border-collapse:collapse;width:100%;margin:24px 0;font-size:14px;">
    <thead>
      <tr>
        <th style="padding:12px 8px;text-align:left;border-bottom:2px solid ${B.border};color:${B.textMuted};font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Date</th>
        <th style="padding:12px 8px;text-align:left;border-bottom:2px solid ${B.border};color:${B.textMuted};font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Description</th>
        <th style="padding:12px 8px;text-align:right;border-bottom:2px solid ${B.border};color:${B.textMuted};font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Amount</th>
        <th style="padding:12px 8px;text-align:center;border-bottom:2px solid ${B.border};color:${B.textMuted};font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`;
}

// =============================================
// SECTION HELPERS
// =============================================

/**
 * Generate a styled section with optional heading.
 */
export function emailSection(heading: string, innerHtml: string, style?: string): string {
  return `<div style="margin:16px 0;${style || ''}">
    <p style="margin:0 0 12px;font-weight:700;color:${B.dark};font-size:13px;text-transform:uppercase;letter-spacing:1px;">${heading}</p>
    ${innerHtml}
  </div>`;
}

/**
 * Callout box — info, warning, success, or accent colored.
 */
export function calloutBox(
  innerHtml: string,
  variant: 'info' | 'warning' | 'success' | 'accent' = 'accent'
): string {
  const colors: Record<string, { bg: string; border: string }> = {
    info:    { bg: '#e3f2fd', border: B.info },
    warning: { bg: '#fff8e1', border: '#f9a825' },
    success: { bg: '#e8f5e9', border: B.success },
    accent:  { bg: `linear-gradient(135deg,#fff8f0 0%,#fef3e6 100%)`, border: B.accent },
  };
  const c = colors[variant];
  const bgStyle = c.bg.startsWith('linear') ? `background:${c.bg};` : `background:${c.bg};`;

  return `<div style="${bgStyle}border-left:4px solid ${c.border};padding:14px 20px;margin:16px 0;border-radius:0 8px 8px 0;">
    ${innerHtml}
  </div>`;
}

/**
 * Balance summary box (for payment statements).
 */
export function balanceBox(
  balanceDue: number,
  overdueSince?: string
): string {
  if (balanceDue > 0) {
    return `<div style="background:linear-gradient(135deg,#fff3e0 0%,#ffe0b2 100%);border-left:4px solid ${B.warning};padding:20px;margin:24px 0;border-radius:0 8px 8px 0;">
      <div style="font-size:13px;color:${B.warning};font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Outstanding Balance</div>
      <div style="font-size:28px;font-weight:700;color:#bf360c;">$${balanceDue.toFixed(2)}</div>
      ${overdueSince ? `<div style="font-size:13px;color:${B.warning};margin-top:4px;">Overdue since ${overdueSince}</div>` : ''}
    </div>`;
  }

  return `<div style="background:#e8f5e9;border-left:4px solid ${B.success};padding:20px;margin:24px 0;border-radius:0 8px 8px 0;">
    <strong style="color:${B.success};font-size:16px;">&#10003; All caught up! No outstanding balance.</strong>
  </div>`;
}

// =============================================
// FOOTER IMAGE TEMPLATES
// =============================================

/**
 * Image template types that can be associated with email categories.
 * Configure in brand_config.email_image_templates or email_templates table.
 */
export type ImageTemplateType =
  | 'random_property'     // Random property photo from media library (default)
  | 'space_photo'       // Photo of the specific space being discussed
  | 'welcome_banner'    // Ghibli-style welcome banner
  | 'branded_minimal'   // Just the logo, no gallery image
  | 'seasonal'          // Seasonal/holiday imagery
  | 'none';             // No footer image

/**
 * Map email categories to default image template types.
 * Can be overridden per-template in the email_templates table.
 */
export const CATEGORY_IMAGE_DEFAULTS: Record<string, ImageTemplateType> = {
  rental:        'space_photo',    // Show the space they're renting
  payment:       'random_property',  // Friendly property to soften payment emails
  event:         'random_property',  // Event imagery
  invitation:    'welcome_banner', // Welcoming banner for invites
  admin:         'branded_minimal',// Keep admin emails clean
  system:        'none',           // System emails are functional only
  identity:      'branded_minimal',
  payment_admin: 'branded_minimal',
};

/**
 * Resolve which image template to use for an email.
 * Priority: template-level override > category default > 'random_property'
 */
export function resolveImageTemplate(
  emailCategory?: string,
  templateOverride?: ImageTemplateType
): ImageTemplateType {
  if (templateOverride) return templateOverride;
  if (emailCategory && CATEGORY_IMAGE_DEFAULTS[emailCategory]) {
    return CATEGORY_IMAGE_DEFAULTS[emailCategory];
  }
  return 'random_property';
}
