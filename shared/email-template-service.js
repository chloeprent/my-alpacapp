/**
 * Email Template Service
 * Manages email notification templates stored in the email_templates DB table.
 * Each template has subject, HTML body, text body, and placeholder definitions.
 */

import { supabase } from './supabase.js';

// =============================================
// TEMPLATE ENGINE (client-side, mirrors edge function version)
// =============================================

/**
 * Render a template string with data placeholders.
 * Supports:
 *   {{variable}}                          - Simple replacement
 *   {{#if variable}}...{{/if}}            - Conditional block
 *   {{#if variable}}...{{else}}...{{/if}} - If/else
 */
export function renderTemplate(template, data) {
  if (!template) return '';
  let result = template;

  // 1. {{#if var}}...{{else}}...{{/if}}
  result = result.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key, ifBlock, elseBlock) => data[key] ? ifBlock : elseBlock
  );

  // 2. {{#if var}}...{{/if}}
  result = result.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key, block) => data[key] ? block : ''
  );

  // 3. {{variable}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = data[key];
    return value !== undefined && value !== null ? String(value) : '';
  });

  return result;
}

// =============================================
// CATEGORIES
// =============================================

const CATEGORIES = [
  { key: 'rental', label: 'Rental', color: '#3d8b7a' },
  { key: 'payment', label: 'Payment', color: '#2563eb' },
  { key: 'event', label: 'Event', color: '#7c3aed' },
  { key: 'invitation', label: 'Invitation', color: '#059669' },
  { key: 'admin', label: 'Admin', color: '#d97706' },
  { key: 'system', label: 'System', color: '#6b7280' },
  { key: 'identity', label: 'Identity', color: '#dc2626' },
  { key: 'payment_admin', label: 'Payment Admin', color: '#0891b2' },
];

// =============================================
// DATA ACCESS
// =============================================

/**
 * Get all active templates (one per template_key, the active version).
 * Optionally filter by category.
 */
async function getAllTemplates(category = null) {
  let query = supabase
    .from('email_templates')
    .select('id, template_key, version, is_active, category, description, sender_type, subject_template, placeholders, created_at, updated_at')
    .eq('is_active', true)
    .order('category')
    .order('template_key');

  if (category) {
    query = query.eq('category', category);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Error fetching email templates:', error);
    throw error;
  }
  return data || [];
}

/**
 * Get one active template by key, including full content.
 */
async function getActiveTemplate(templateKey) {
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .eq('template_key', templateKey)
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching email template:', error);
    throw error;
  }
  return data;
}

/**
 * Get all versions for a specific template key.
 */
async function getTemplateVersions(templateKey) {
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .eq('template_key', templateKey)
    .order('version', { ascending: false });

  if (error) {
    console.error('Error fetching template versions:', error);
    throw error;
  }
  return data || [];
}

/**
 * Save a new version of an email template.
 */
async function saveTemplate(templateKey, templateData, makeActive = true, userId = null, changeSummary = null) {
  // Deactivate existing versions if making active
  if (makeActive) {
    await supabase
      .from('email_templates')
      .update({ is_active: false })
      .eq('template_key', templateKey)
      .eq('is_active', true);
  }

  // Get current max version
  const { data: existing } = await supabase
    .from('email_templates')
    .select('version')
    .eq('template_key', templateKey)
    .order('version', { ascending: false })
    .limit(1);

  const newVersion = existing && existing.length > 0 ? existing[0].version + 1 : 1;

  const insertData = {
    template_key: templateKey,
    version: newVersion,
    is_active: makeActive,
    category: templateData.category,
    description: templateData.description,
    sender_type: templateData.sender_type,
    subject_template: templateData.subject_template,
    html_template: templateData.html_template,
    text_template: templateData.text_template,
    placeholders: templateData.placeholders || [],
    image_template: templateData.image_template || 'random_property',
  };

  // Add audit trail fields if provided
  if (userId) {
    insertData.created_by = userId;
    insertData.updated_by = userId;
  }
  if (changeSummary) {
    insertData.change_summary = changeSummary;
  }

  const { data, error } = await supabase
    .from('email_templates')
    .insert(insertData)
    .select()
    .single();

  if (error) {
    console.error('Error saving email template:', error);
    throw error;
  }
  return data;
}

/**
 * Set a specific version as active (deactivates others for same key).
 */
async function setActiveVersion(templateId, templateKey, userId = null) {
  // Deactivate all versions for this key
  await supabase
    .from('email_templates')
    .update({ is_active: false })
    .eq('template_key', templateKey)
    .eq('is_active', true);

  // Activate selected version
  const updateData = { is_active: true, updated_at: new Date().toISOString() };
  if (userId) updateData.updated_by = userId;

  const { data, error } = await supabase
    .from('email_templates')
    .update(updateData)
    .eq('id', templateId)
    .select()
    .single();

  if (error) {
    console.error('Error setting active version:', error);
    throw error;
  }
  return data;
}

/**
 * Render a preview of a template using sample data from its placeholders.
 */
function renderPreview(template) {
  const sampleData = {};
  const placeholders = template.placeholders || [];
  for (const p of placeholders) {
    sampleData[p.key] = p.sample_value || `[${p.key}]`;
  }
  return {
    subject: renderTemplate(template.subject_template, sampleData),
    html: renderTemplate(template.html_template, sampleData),
    text: renderTemplate(template.text_template, sampleData),
  };
}

/**
 * Validate a template's content against its declared placeholders.
 * Warns about unknown placeholders found in the template.
 */
function validateTemplate(content, placeholders) {
  const errors = [];
  const warnings = [];

  const knownKeys = new Set((placeholders || []).map(p => p.key));
  const found = new Set();

  // Find {{variable}} placeholders
  const varRegex = /\{\{(\w+)\}\}/g;
  let match;
  while ((match = varRegex.exec(content)) !== null) {
    found.add(match[1]);
  }

  // Find {{#if variable}} conditionals
  const ifRegex = /\{\{#if\s+(\w+)\}\}/g;
  while ((match = ifRegex.exec(content)) !== null) {
    found.add(match[1]);
  }

  // Check for unknown placeholders
  for (const key of found) {
    if (!knownKeys.has(key)) {
      warnings.push(`Unknown placeholder: {{${key}}}`);
    }
  }

  return { isValid: errors.length === 0, errors, warnings, foundPlaceholders: [...found] };
}

/**
 * Get full audit history for a template key, including who made each change.
 * Joins with app_users to get display names.
 */
async function getTemplateHistory(templateKey) {
  const { data, error } = await supabase
    .from('email_templates')
    .select(`
      id, version, is_active, category, description, change_summary,
      image_template, created_at, updated_at,
      created_by_user:created_by(id, display_name, email),
      updated_by_user:updated_by(id, display_name, email)
    `)
    .eq('template_key', templateKey)
    .order('version', { ascending: false });

  if (error) {
    console.error('Error fetching template history:', error);
    throw error;
  }
  return data || [];
}

// =============================================
// EXPORTS
// =============================================

export const emailTemplateService = {
  getAllTemplates,
  getActiveTemplate,
  getTemplateVersions,
  getTemplateHistory,
  saveTemplate,
  setActiveVersion,
  renderPreview,
  validateTemplate,
  getCategories: () => CATEGORIES,
};
