/**
 * API Permission Matrix & Role Levels
 *
 * Centralized permission definitions for the YOUR_APP_NAME Internal REST API.
 * Every resource/action combination maps to a minimum role level.
 *
 * Levels:
 *   0 = unauthenticated / demo (public)
 *   1 = resident / associate
 *   2 = staff
 *   3 = admin
 *   4 = oracle
 */

// ─── Role → Level mapping ───────────────────────────────────────────

export const ROLE_LEVELS: Record<string, number> = {
  oracle: 4,
  admin: 3,
  staff: 2,
  resident: 1,
  associate: 1,
  demo: 0,
};

// ─── Valid actions ──────────────────────────────────────────────────

export type ApiAction = "list" | "get" | "create" | "update" | "delete";

// ─── Permission entry ───────────────────────────────────────────────

export interface PermissionEntry {
  minLevel: number;
  /** If true, handler must filter rows by caller identity */
  rowScoped?: boolean;
  /** Fields that staff can update (admin can update all) */
  staffFields?: string[];
}

// ─── Master permission matrix ───────────────────────────────────────
// Resources are grouped by feature category for the setup wizard.
// When generating a template for cloners, only include resources
// for enabled features. See feature-manifest.json for mappings.

export const PERMISSIONS: Record<string, Record<string, PermissionEntry>> = {

  // ══════════════════════════════════════════════════════════════════
  // CORE — always included regardless of feature selection
  // ══════════════════════════════════════════════════════════════════

  // ── spaces ──────────────────────────────────────────────────────
  spaces: {
    list:   { minLevel: 0 },
    get:    { minLevel: 0 },
    create: { minLevel: 3 },
    update: { minLevel: 2, staffFields: [
      "description", "monthly_rate", "weekly_rate", "nightly_rate",
      "airbnb_ical_url", "airbnb_link", "airbnb_rate",
    ]},
    delete: { minLevel: 3 },
  },

  // ── people ──────────────────────────────────────────────────────
  people: {
    list:   { minLevel: 2 },
    get:    { minLevel: 2 },
    create: { minLevel: 2 },
    update: { minLevel: 2 },
    delete: { minLevel: 3 },
  },

  // ── assignments ─────────────────────────────────────────────────
  assignments: {
    list:   { minLevel: 1, rowScoped: true },
    get:    { minLevel: 1, rowScoped: true },
    create: { minLevel: 2 },
    update: { minLevel: 2 },
    delete: { minLevel: 3 },
  },

  // ── tasks ───────────────────────────────────────────────────────
  tasks: {
    list:   { minLevel: 1 },
    get:    { minLevel: 1 },
    create: { minLevel: 1 },
    update: { minLevel: 1 },
    delete: { minLevel: 2 },
  },

  // ── users (app_users) ──────────────────────────────────────────
  users: {
    list:   { minLevel: 2 },
    get:    { minLevel: 2 },
    create: { minLevel: 3 },
    update: { minLevel: 3 },
    delete: { minLevel: 4 },
  },

  // ── profile (self-service, scoped to self) ─────────────────────
  profile: {
    get:    { minLevel: 1 },
    update: { minLevel: 1 },
  },

  // ══════════════════════════════════════════════════════════════════
  // FEATURE: vehicles — Tesla Fleet API integration
  // ══════════════════════════════════════════════════════════════════

  // ── vehicles ────────────────────────────────────────────────────
  vehicles: {
    list:   { minLevel: 1 },
    get:    { minLevel: 1 },
    create: { minLevel: 3 },
    update: { minLevel: 2 },
    delete: { minLevel: 3 },
  },

  // ── media ───────────────────────────────────────────────────────
  media: {
    list:   { minLevel: 0 },
    get:    { minLevel: 0 },
    create: { minLevel: 2 },
    update: { minLevel: 2 },
    delete: { minLevel: 2 },
  },

  // ── payments ────────────────────────────────────────────────────
  payments: {
    list:   { minLevel: 2 },
    get:    { minLevel: 2 },
    create: { minLevel: 2 },
    update: { minLevel: 3 },
    delete: { minLevel: 4 },
  },

  // ── bug_reports ─────────────────────────────────────────────────
  bug_reports: {
    list:   { minLevel: 2 },
    get:    { minLevel: 2 },
    create: { minLevel: 1 },
    update: { minLevel: 2 },
    delete: { minLevel: 3 },
  },

  // ══════════════════════════════════════════════════════════════════
  // FEATURE: associates — Staff/associate hour tracking & payouts
  // ══════════════════════════════════════════════════════════════════

  // ── time_entries ────────────────────────────────────────────────
  time_entries: {
    list:   { minLevel: 1, rowScoped: true },
    get:    { minLevel: 1, rowScoped: true },
    create: { minLevel: 1 },
    update: { minLevel: 1, rowScoped: true },
    delete: { minLevel: 2 },
  },

  // ══════════════════════════════════════════════════════════════════
  // FEATURE: events — Event hosting pipeline
  // ══════════════════════════════════════════════════════════════════

  // ── events (event_hosting_requests) ─────────────────────────────
  events: {
    list:   { minLevel: 1, rowScoped: true },
    get:    { minLevel: 1 },
    create: { minLevel: 1 },
    update: { minLevel: 2 },
    delete: { minLevel: 3 },
  },

  // ── documents (document_index) ──────────────────────────────────
  documents: {
    list:   { minLevel: 1 },
    get:    { minLevel: 1 },
    create: { minLevel: 2 },
    update: { minLevel: 2 },
    delete: { minLevel: 3 },
  },

  // ══════════════════════════════════════════════════════════════════
  // FEATURE: sms — Telnyx SMS messaging
  // ══════════════════════════════════════════════════════════════════

  // ── sms (sms_messages) ──────────────────────────────────────────
  sms: {
    list:   { minLevel: 2 },
    get:    { minLevel: 2 },
    create: { minLevel: 2 },
  },

  // ══════════════════════════════════════════════════════════════════
  // FEATURE: pai — AI assistant (PAI)
  // ══════════════════════════════════════════════════════════════════

  // ── faq (faq_context_entries) ───────────────────────────────────
  faq: {
    list:   { minLevel: 0 },
    get:    { minLevel: 0 },
    create: { minLevel: 3 },
    update: { minLevel: 3 },
    delete: { minLevel: 3 },
  },

  // ── invitations (user_invitations) ──────────────────────────────
  invitations: {
    list:   { minLevel: 2 },
    get:    { minLevel: 2 },
    create: { minLevel: 2 },
    update: { minLevel: 3 },
    delete: { minLevel: 3 },
  },

  // ── password_vault ──────────────────────────────────────────────
  password_vault: {
    list:   { minLevel: 1 },
    get:    { minLevel: 1 },
    create: { minLevel: 3 },
    update: { minLevel: 3 },
    delete: { minLevel: 3 },
  },

  // ── feature_requests ────────────────────────────────────────────
  feature_requests: {
    list:   { minLevel: 2 },
    get:    { minLevel: 2 },
    create: { minLevel: 2 },
    update: { minLevel: 2 },
    delete: { minLevel: 3 },
  },

  // ── pai_config ──────────────────────────────────────────────────
  pai_config: {
    get:    { minLevel: 3 },
    update: { minLevel: 3 },
  },

  // ══════════════════════════════════════════════════════════════════
  // FEATURE: vehicles — Tesla account management
  // ══════════════════════════════════════════════════════════════════

  // ── tesla_accounts ──────────────────────────────────────────────
  tesla_accounts: {
    list:   { minLevel: 3 },
    get:    { minLevel: 3 },
    update: { minLevel: 3 },
  },
};

// ─── Self-editable profile fields ───────────────────────────────────

export const PROFILE_EDITABLE_FIELDS = [
  "display_name", "first_name", "last_name", "phone", "phone2",
  "bio", "avatar_url", "nationality", "location_base", "gender",
  "privacy_phone", "privacy_email", "privacy_bio",
  "facebook_url", "instagram_url", "linkedin_url", "x_url",
];
