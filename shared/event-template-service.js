/**
 * Event Template Service
 * Handles event agreement template storage, parsing, and placeholder substitution
 */

import { supabase } from './supabase.js';

// All supported placeholders and their descriptions
const PLACEHOLDERS = {
  // Client info
  client_name: 'Full name of the client',
  client_email: 'Client email address',
  client_phone: 'Client phone number',

  // Event details
  event_date: 'Date of the event (e.g., "Saturday, September 13, 2025")',
  event_start_time: 'Event start time (e.g., "6:00 PM")',
  event_end_time: 'Event end time (e.g., "1:30 AM")',
  max_guests: 'Maximum number of guests allowed',

  // Financial
  rental_fee: 'Venue rental fee (e.g., "$295")',
  reservation_fee: 'Refundable reservation deposit (e.g., "$95")',
  cleaning_deposit: 'Refundable cleaning/damage deposit (e.g., "$195")',
  total_due: 'Total amount due (sum of all fees)',
  reservation_fee_paid: 'Reservation deposit already paid (e.g., "$200")',
  reservation_fee_credit: 'Text describing reservation deposit credit toward rental fee',
  rental_fee_due: 'Amount due for rental fee after reservation credit',

  // Venue
  included_spaces: 'List of spaces included in the rental',
  excluded_spaces: 'List of spaces NOT included',

  // Meta
  agreement_date: 'Date the agreement is generated',
  additional_terms: 'Custom additional terms for this event',
};

/**
 * Get all available placeholders with descriptions
 */
function getAvailablePlaceholders() {
  return PLACEHOLDERS;
}

/**
 * Get the active event agreement template
 */
async function getActiveTemplate() {
  const { data, error } = await supabase
    .from('event_agreement_templates')
    .select('*')
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
    console.error('Error fetching active template:', error);
    throw error;
  }

  return data;
}

/**
 * Get all templates
 */
async function getAllTemplates() {
  const { data, error } = await supabase
    .from('event_agreement_templates')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching templates:', error);
    throw error;
  }

  return data || [];
}

/**
 * Save a new template or update existing
 */
async function saveTemplate(content, name, makeActive = false) {
  // Validate template first
  const validation = validateTemplate(content);
  if (!validation.isValid) {
    throw new Error(`Invalid template: ${validation.errors.join(', ')}`);
  }

  // If making active, deactivate all others first
  if (makeActive) {
    await supabase
      .from('event_agreement_templates')
      .update({ is_active: false })
      .eq('is_active', true);
  }

  // Get current max version for this name
  const { data: existing } = await supabase
    .from('event_agreement_templates')
    .select('version')
    .eq('name', name)
    .order('version', { ascending: false })
    .limit(1);

  const newVersion = existing && existing.length > 0 ? existing[0].version + 1 : 1;

  const { data, error } = await supabase
    .from('event_agreement_templates')
    .insert({
      name,
      content,
      version: newVersion,
      is_active: makeActive,
    })
    .select()
    .single();

  if (error) {
    console.error('Error saving template:', error);
    throw error;
  }

  return data;
}

/**
 * Set a template as active
 */
async function setActiveTemplate(templateId) {
  // Deactivate all
  await supabase
    .from('event_agreement_templates')
    .update({ is_active: false })
    .eq('is_active', true);

  // Activate selected
  const { data, error } = await supabase
    .from('event_agreement_templates')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq('id', templateId)
    .select()
    .single();

  if (error) {
    console.error('Error setting active template:', error);
    throw error;
  }

  return data;
}

/**
 * Validate a template for correct placeholders
 */
function validateTemplate(content) {
  const errors = [];
  const warnings = [];
  const foundPlaceholders = [];

  // Find all placeholders in the template
  const placeholderRegex = /\{\{(\w+)\}\}/g;
  let match;

  while ((match = placeholderRegex.exec(content)) !== null) {
    const placeholder = match[1];
    foundPlaceholders.push(placeholder);

    if (!PLACEHOLDERS[placeholder]) {
      errors.push(`Unknown placeholder: {{${placeholder}}}`);
    }
  }

  // Check for required placeholders (warnings only)
  const requiredPlaceholders = ['client_name', 'event_date', 'rental_fee'];
  for (const required of requiredPlaceholders) {
    if (!foundPlaceholders.includes(required)) {
      warnings.push(`Missing recommended placeholder: {{${required}}}`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    foundPlaceholders: [...new Set(foundPlaceholders)],
  };
}

/**
 * Parse template and substitute placeholders with event data
 * @param {string} templateContent - Markdown template with {{placeholders}}
 * @param {Object} agreementData - Data from eventService.getAgreementData()
 * @returns {string} - Parsed template with values substituted
 */
function parseTemplate(templateContent, agreementData) {
  // Map agreement data keys to placeholder names (handle camelCase to snake_case)
  const dataMap = {
    client_name: agreementData.clientName,
    client_email: agreementData.clientEmail,
    client_phone: agreementData.clientPhone,
    event_date: agreementData.eventDate,
    event_start_time: agreementData.eventStartTime,
    event_end_time: agreementData.eventEndTime,
    max_guests: agreementData.maxGuests,
    rental_fee: agreementData.rentalFee,
    reservation_fee: agreementData.reservationFee,
    cleaning_deposit: agreementData.cleaningDeposit,
    total_due: agreementData.totalDue,
    reservation_fee_paid: agreementData.reservationFeePaid,
    reservation_fee_credit: agreementData.reservationFeeCredit,
    rental_fee_due: agreementData.rentalFeeDue,
    included_spaces: agreementData.includedSpaces,
    excluded_spaces: agreementData.excludedSpaces,
    agreement_date: agreementData.agreementDate,
    additional_terms: agreementData.additionalTerms || '',
  };

  // Replace all placeholders
  let parsed = templateContent;

  // Special handling for additional_terms - add conditional intro text
  const additionalTerms = agreementData.additionalTerms?.trim();
  if (additionalTerms) {
    parsed = parsed.replace(
      /\{\{additional_terms\}\}/g,
      additionalTerms
    );
  } else {
    parsed = parsed.replace(/\{\{additional_terms\}\}/g, 'None.');
  }

  // Replace all other placeholders
  for (const [placeholder, value] of Object.entries(dataMap)) {
    if (placeholder === 'additional_terms') continue; // Already handled above
    const regex = new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g');
    parsed = parsed.replace(regex, value ?? '');
  }

  // Handle any remaining unmatched placeholders (replace with empty or keep)
  parsed = parsed.replace(/\{\{\w+\}\}/g, '');

  return parsed;
}

/**
 * Get a preview of the template with sample data
 */
function getTemplatePreview(templateContent) {
  const sampleData = {
    clientName: 'Jane Smith',
    clientEmail: 'jane.smith@email.com',
    clientPhone: '555-555-5555',
    eventDate: 'Saturday, September 13, 2025',
    eventStartTime: '6:00 PM',
    eventEndTime: '1:30 AM',
    maxGuests: '25',
    rentalFee: '$295',
    reservationFee: '$200',
    cleaningDeposit: '$100',
    totalDue: '$395',
    reservationFeePaid: '$200',
    reservationFeeCredit: 'Reservation deposit of $200 has been received and will be credited toward the rental fee.',
    rentalFeeDue: '$95',
    includedSpaces: '- Living Room (semi-common)\n- Kitchen (semi-common)\n- Dining Room (semi-common)\n- Garage & Cold plunge\n- Back Yard\n- Front Yard (clothed)\n- Sauna and deck\n- Common Bathroom near kitchen',
    excludedSpaces: '- Master Bedroom\n- Trailers\n- Dog House Cabins\n- Front Pequeno Room\n- Jon\'s Room by Common Bathroom\n- Penthouse Upstairs Level and bathroom',
    agreementDate: 'February 3, 2026',
    additionalTerms: 'Client agrees to provide their own DJ equipment.',
  };

  return parseTemplate(templateContent, sampleData);
}

/**
 * Get the default template content (fallback)
 */
function getDefaultTemplate() {
  return `# YOUR_PROPERTY_NAME Event RENTAL AGREEMENT

**Last Updated: {{agreement_date}}**

---

This Rental Agreement (hereinafter, "Agreement") is made by and between the Revocable Trust of Subhash Sonnad (dba YOUR_PROPERTY_NAME), (hereinafter, "Company"), and the person(s)/company/organization renting the venue (hereinafter, "Client" or "Renter"), **{{client_name}}**.

- **Email:** {{client_email}}
- **Phone:** {{client_phone}}

---

## RENTAL VENUE

Company agrees to rent to Client the following spaces at 123 Main Stive (aka the Austin YOUR_PROPERTY_NAME):

{{included_spaces}}

The following areas will NOT be included for use by the event:

{{excluded_spaces}}

## RENTAL PERIOD

The rental period is **{{event_date}}** from **{{event_start_time}}** to **{{event_end_time}}**.

## FEES

**Rental Fee:** Company agrees the venue will be offered for a single event on **{{event_date}}** for a cost of **{{rental_fee}}**.

**Reservation Deposit:** A **{{reservation_fee}}** reservation deposit is due at time of reservation to secure your booking. This deposit will be credited toward the rental fee.

{{reservation_fee_credit}}

**Rental Fee Due:** {{rental_fee_due}} (rental fee minus reservation deposit credit)


**Cleaning & Damage Deposit:** A refundable damage waiver fee of **{{cleaning_deposit}}** is due upon booking, at least two weeks before the event. This will be refunded after the event if the venue is left in good condition.

## GUEST LIMIT

Client agrees no more than **{{max_guests}} people** including volunteers and paid attendees will be attending.

---

## SIGNATURES

|                          | **Owner's Signature**                           |
|--------------------------|------------------------------------------------|
|                          |                                                |
| **{{client_name}}**      | Rahul Sonnad                                   |
| Date:                    | Date:                                          |

---

# EXHIBIT A - Event Details Summary

| Field | Value |
|-------|-------|
| **Client** | {{client_name}} |
| **Event Date** | {{event_date}} |
| **Event Time** | {{event_start_time}} to {{event_end_time}} |
| **Maximum Guests** | {{max_guests}} |
| **Total Due** | {{total_due}} |

## Additional Terms

{{additional_terms}}
`;
}

export const eventTemplateService = {
  getAvailablePlaceholders,
  getActiveTemplate,
  getAllTemplates,
  saveTemplate,
  setActiveTemplate,
  validateTemplate,
  parseTemplate,
  getTemplatePreview,
  getDefaultTemplate,
};
