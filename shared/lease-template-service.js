/**
 * Lease Template Service
 * Handles lease template storage, parsing, and placeholder substitution
 * Supports multiple template types: lease, renter_waiver, event_waiver
 */

import { supabase } from './supabase.js';

// All supported placeholders and their descriptions
const PLACEHOLDERS = {
  tenant_name: 'Full name of the tenant',
  tenant_email: 'Tenant email address',
  tenant_phone: 'Tenant phone number',
  signing_date: 'Current date formatted (e.g., "2nd day of February 2026")',
  lease_start_date: 'Move-in date (e.g., "February 15, 2026")',
  lease_end_date: 'Lease end date or "Open-ended"',
  dwelling_description: 'Name of the rental space',
  dwelling_location: 'Location/area of the space',
  rate: 'Rent amount (e.g., "$1,500")',
  rate_term: 'Payment frequency (month, week, night)',
  rate_display: 'Combined rate display (e.g., "$1,500/month")',
  security_deposit: 'Security deposit amount',
  move_in_deposit: 'Move-in deposit amount (first month rent)',
  reservation_deposit: 'Reservation deposit amount due after signing',
  application_fee_paid: 'Application fee amount paid (e.g., "$35")',
  application_fee_credit: 'Text describing application fee credit toward first month rent',
  reservation_deposit_credit: 'Text describing reservation deposit credit toward first month rent',
  total_credits: 'Total credits toward first month (app fee + reservation deposit)',
  first_month_due: 'Amount due for first month after all credits applied',
  notice_period: 'Notice period code (e.g., "30_days")',
  notice_period_display: 'Formatted notice period (e.g., "30 days notice required")',
  lease_term_block: 'Full lease term section (auto-generated based on fixed vs continuous)',
  additional_terms: 'Custom additional terms',
};

// Placeholders for waiver templates (subset of lease + waiver-specific)
const WAIVER_PLACEHOLDERS = {
  tenant_name: 'Full name of the signer',
  tenant_email: 'Email address of the signer',
  tenant_phone: 'Phone number of the signer',
  signing_date: 'Current date formatted (e.g., "2nd day of February 2026")',
  dwelling_description: 'Name of the rental space (renter waiver only)',
};

// Placeholders for event waiver templates
const EVENT_WAIVER_PLACEHOLDERS = {
  client_name: 'Full name of the guest/attendee',
  client_email: 'Email address of the guest/attendee',
  client_phone: 'Phone number of the guest/attendee',
  event_date: 'Date of the event',
  signing_date: 'Current date formatted',
};

// Placeholders for vehicle rental agreement templates
const VEHICLE_RENTAL_PLACEHOLDERS = {
  owner_name: 'Full name of the vehicle owner',
  owner_address: 'Owner mailing address',
  owner_phone: 'Owner phone number',
  owner_email: 'Owner email address',
  renter_name: 'Full name of the renter',
  renter_address: 'Renter mailing address',
  renter_phone: 'Renter phone number',
  renter_email: 'Renter email address',
  renter_dl_number: 'Renter driver\'s license number',
  renter_dl_state: 'Renter driver\'s license state',
  vehicle_make: 'Vehicle make (e.g., Tesla)',
  vehicle_model: 'Vehicle model (e.g., Model Y)',
  vehicle_year: 'Vehicle year (e.g., 2023)',
  vehicle_color: 'Vehicle color',
  vehicle_vin: 'Vehicle Identification Number',
  vehicle_license_plate: 'License plate number',
  starting_mileage: 'Odometer reading at rental start',
  monthly_mileage_limit: 'Monthly mileage allowance (e.g., 1,000 miles)',
  mileage_overage_rate: 'Per-mile charge for overage (e.g., $0.25)',
  rental_start_date: 'Rental period start date',
  rental_end_date: 'Rental period end date',
  monthly_rate: 'Monthly rental rate (e.g., $800)',
  fsd_rate: 'FSD subscription rate (e.g., $99/month)',
  security_deposit: 'Security deposit amount',
  late_return_hourly_rate: 'Late return fee per hour (e.g., $40)',
  late_return_daily_rate: 'Late return fee per day (e.g., $150)',
  insurance_requirements: 'Insurance coverage requirements',
  signing_date: 'Date the agreement is signed',
  additional_terms: 'Any additional terms or conditions',
};

/**
 * Get all available placeholders with descriptions
 * @param {string} type - Template type: 'lease', 'renter_waiver', 'event_waiver'
 */
function getAvailablePlaceholders(type = 'lease') {
  if (type === 'renter_waiver') return WAIVER_PLACEHOLDERS;
  if (type === 'event_waiver') return EVENT_WAIVER_PLACEHOLDERS;
  if (type === 'vehicle_rental') return VEHICLE_RENTAL_PLACEHOLDERS;
  return PLACEHOLDERS;
}

/**
 * Get the active template of a given type
 * @param {string} type - Template type: 'lease', 'renter_waiver', 'event_waiver'
 */
async function getActiveTemplate(type = 'lease') {
  const { data, error } = await supabase
    .from('lease_templates')
    .select('*')
    .eq('is_active', true)
    .eq('type', type)
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
 * Get all templates of a given type
 * @param {string} type - Template type: 'lease', 'renter_waiver', 'event_waiver'
 */
async function getAllTemplates(type = 'lease') {
  const { data, error } = await supabase
    .from('lease_templates')
    .select('*')
    .eq('type', type)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching templates:', error);
    throw error;
  }

  return data || [];
}

/**
 * Save a new template or update existing
 * @param {string} type - Template type: 'lease', 'renter_waiver', 'event_waiver'
 */
async function saveTemplate(content, name, makeActive = false, type = 'lease') {
  // Validate template first
  const validation = validateTemplate(content, type);
  if (!validation.isValid) {
    throw new Error(`Invalid template: ${validation.errors.join(', ')}`);
  }

  // If making active, deactivate all others of the same type first
  if (makeActive) {
    await supabase
      .from('lease_templates')
      .update({ is_active: false })
      .eq('is_active', true)
      .eq('type', type);
  }

  // Get current max version for this name and type
  const { data: existing } = await supabase
    .from('lease_templates')
    .select('version')
    .eq('name', name)
    .eq('type', type)
    .order('version', { ascending: false })
    .limit(1);

  const newVersion = existing && existing.length > 0 ? existing[0].version + 1 : 1;

  const { data, error } = await supabase
    .from('lease_templates')
    .insert({
      name,
      content,
      version: newVersion,
      is_active: makeActive,
      type,
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
 * Set a template as active (scoped to same type)
 */
async function setActiveTemplate(templateId) {
  // First, get the template to know its type
  const { data: tmpl } = await supabase
    .from('lease_templates')
    .select('type')
    .eq('id', templateId)
    .single();

  const type = tmpl?.type || 'lease';

  // Deactivate all of the same type
  await supabase
    .from('lease_templates')
    .update({ is_active: false })
    .eq('is_active', true)
    .eq('type', type);

  // Activate selected
  const { data, error } = await supabase
    .from('lease_templates')
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
 * @param {string} type - Template type for placeholder validation
 */
function validateTemplate(content, type = 'lease') {
  const errors = [];
  const warnings = [];
  const foundPlaceholders = [];

  // Use appropriate placeholder set for validation
  const validPlaceholders = type === 'event_waiver'
    ? { ...PLACEHOLDERS, ...EVENT_WAIVER_PLACEHOLDERS }
    : type === 'renter_waiver'
      ? { ...PLACEHOLDERS, ...WAIVER_PLACEHOLDERS }
      : type === 'vehicle_rental'
        ? { ...PLACEHOLDERS, ...VEHICLE_RENTAL_PLACEHOLDERS }
        : PLACEHOLDERS;

  // Find all placeholders in the template
  const placeholderRegex = /\{\{(\w+)\}\}/g;
  let match;

  while ((match = placeholderRegex.exec(content)) !== null) {
    const placeholder = match[1];
    foundPlaceholders.push(placeholder);

    if (!validPlaceholders[placeholder]) {
      errors.push(`Unknown placeholder: {{${placeholder}}}`);
    }
  }

  // Check for required placeholders (warnings only) — varies by type
  const requiredMap = {
    lease: ['tenant_name', 'lease_start_date', 'rate_display'],
    renter_waiver: ['tenant_name', 'signing_date'],
    event_waiver: ['client_name', 'signing_date'],
    vehicle_rental: ['renter_name', 'vehicle_vin', 'monthly_rate'],
  };
  const requiredPlaceholders = requiredMap[type] || requiredMap.lease;
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
 * Parse template and substitute placeholders with application data
 * @param {string} templateContent - Markdown template with {{placeholders}}
 * @param {Object} agreementData - Data from rentalService.getAgreementData()
 * @returns {string} - Parsed template with values substituted
 */
function parseTemplate(templateContent, agreementData) {
  // Map agreement data keys to placeholder names (handle camelCase to snake_case)
  const dataMap = {
    tenant_name: agreementData.tenantName,
    tenant_email: agreementData.tenantEmail,
    tenant_phone: agreementData.tenantPhone,
    signing_date: agreementData.signingDate,
    lease_start_date: agreementData.leaseStartDate,
    lease_end_date: agreementData.leaseEndDate,
    dwelling_description: agreementData.dwellingDescription,
    dwelling_location: agreementData.dwellingLocation,
    rate: agreementData.rate,
    rate_term: agreementData.rateTerm,
    rate_display: agreementData.rateDisplay,
    security_deposit: agreementData.securityDeposit,
    move_in_deposit: agreementData.moveInDeposit,
    reservation_deposit: agreementData.reservationDeposit,
    application_fee_paid: agreementData.applicationFeePaid,
    application_fee_credit: agreementData.applicationFeeCredit,
    reservation_deposit_credit: agreementData.reservationDepositCredit,
    total_credits: agreementData.totalCredits,
    first_month_due: agreementData.firstMonthDue,
    notice_period: agreementData.noticePeriod,
    notice_period_display: agreementData.noticePeriodDisplay,
    lease_term_block: agreementData.leaseTermBlock || '',
    additional_terms: agreementData.additionalTerms || '',
  };

  // Replace all placeholders
  let parsed = templateContent;

  // Special handling for additional_terms - add conditional intro text
  const additionalTerms = agreementData.additionalTerms?.trim();
  if (additionalTerms) {
    // Replace {{additional_terms}} with intro text + the actual terms
    parsed = parsed.replace(
      /\{\{additional_terms\}\}/g,
      `The following additional terms will apply to this rental agreement:\n\n${additionalTerms}`
    );
  } else {
    // Remove the placeholder and any surrounding whitespace/newlines
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
    tenantName: 'John Smith',
    tenantEmail: 'john.smith@email.com',
    tenantPhone: '555-555-5555',
    signingDate: '2nd day of February 2026',
    leaseStartDate: 'February 15, 2026',
    leaseEndDate: 'February 15, 2027',
    dwellingDescription: 'The Cozy Cabin',
    dwellingLocation: 'Back Yard',
    rate: '$1,500',
    rateTerm: 'month',
    rateDisplay: '$1,500/month',
    securityDeposit: '$1,500',
    moveInDeposit: '$1,500',
    reservationDeposit: '$1,500',
    applicationFeePaid: '$35',
    applicationFeeCredit: 'Application fee of $35 has been received and will be credited toward the first month\'s rent.',
    reservationDepositCredit: 'Reservation deposit of $1,500 will be credited toward the first month\'s rent.',
    totalCredits: '$1,535',
    firstMonthDue: '$0',
    noticePeriod: '30_days',
    noticePeriodDisplay: '30 days notice required',
    leaseTermBlock: 'This Lease shall commence on: **February 15, 2026**\n\nand continue on a month-to-month basis until terminated by either party with at least **30 days** written notice, which may be given on any date.',
    additionalTerms: 'Tenant agrees to maintain the garden area.',
  };

  return parseTemplate(templateContent, sampleData);
}

// Default template for initial setup
const DEFAULT_TEMPLATE = `# RESIDENTIAL LEASE AGREEMENT

**YOUR_APP_NAME Residency**
123 Main Stive, Your City, TX 00000

---

This Residential Lease Agreement ("Agreement") is entered into on **{{signing_date}}** between:

**LANDLORD:** YOUR_APP_NAME Residency ("Landlord")

**TENANT:** {{tenant_name}} ("Tenant")
- Email: {{tenant_email}}
- Phone: {{tenant_phone}}

---

## 1. PREMISES

The Landlord agrees to rent to the Tenant the dwelling unit described as:

- **Space:** {{dwelling_description}}
- **Location:** {{dwelling_location}}

Located at 123 Main Stive, Your City, TX 00000 (the "Premises").

## 2. TERM

The lease term shall be:

- **Start Date:** {{lease_start_date}}
- **End Date:** {{lease_end_date}}

## 3. RENT

Tenant agrees to pay rent of **{{rate_display}}**.

- Rent is due on the 1st of each month
- Late payments are subject to a $50 late fee after the 5th day
- Accepted payment methods: Venmo, Zelle, PayPal, or Bank Transfer

## 4. DEPOSITS & PAYMENTS

- **Move-in Deposit:** {{move_in_deposit}} (equivalent to first month's rent)
- **Security Deposit:** {{security_deposit}}

{{application_fee_credit}}

**Amount Due at Move-in:** {{first_month_due}} (first month rent minus any application fee credit)

The security deposit will be returned within 30 days of move-out, less any deductions for damages beyond normal wear and tear.

## 5. EARLY TERMINATION

{{notice_period_display}}

Tenant must provide written notice of intent to vacate. Failure to provide proper notice may result in forfeiture of the security deposit.

## 6. HOUSE RULES

Tenant agrees to:
- Respect quiet hours (10 PM - 8 AM)
- Keep the premises clean and sanitary
- Not disturb other residents
- Report any maintenance issues promptly
- No illegal activities on the premises

## 7. UTILITIES

Unless otherwise specified, Tenant is responsible for their share of utilities including electricity, water, and internet.

## 8. ADDITIONAL TERMS

{{additional_terms}}

---

## SIGNATURES

By signing below, both parties agree to the terms of this Lease Agreement.

**LANDLORD**

Signature: _________________________

Name: YOUR_APP_NAME Residency

Date: _________________________


**TENANT**

Signature: _________________________

Name: {{tenant_name}}

Date: _________________________
`;

// ============================================================
// DEFAULT RENTER WAIVER TEMPLATE
// ============================================================

const DEFAULT_RENTER_WAIVER = `# WAIVER OF LIABILITY, ASSUMPTION OF RISK, AND INDEMNITY AGREEMENT

**PLEASE READ CAREFULLY BEFORE SIGNING. THIS IS A RELEASE OF LIABILITY AND WAIVER OF CERTAIN LEGAL RIGHTS.**

---

**Property Owner:** Revocable Trust of Subhash Sonnad ("Owner")
**Property Address:** 123 Main Stive, Your City, Texas 00000

**Resident/Renter:** {{tenant_name}} ("Participant")

**Date:** {{signing_date}}

---

## 1. ACTIVITIES AND FACILITIES

The Owner makes available certain recreational amenities and facilities on the property at 123 Main Stive, Your City, Texas 00000, including but not limited to:

- **Hot sauna(s)** (dry sauna and/or infrared sauna)
- **Cold plunge pool / ice bath**
- **Swim spa / hydrotherapy pool**
- **Climbing structures** (designed for individuals in strong athletic condition only)
- Outdoor grounds, trails, decks, patios, and common areas
- Other recreational equipment and amenities as may be present on the property

## 2. ACKNOWLEDGMENT OF RISKS

I, **{{tenant_name}}**, acknowledge and understand that participation in or use of the above-described activities and facilities involves **inherent and significant risks of serious bodily injury, disability, and death.** These risks include, but are not limited to:

- **Hot sauna:** Heat exhaustion, heat stroke, dehydration, burns, cardiovascular complications, loss of consciousness, and exacerbation of pre-existing medical conditions
- **Cold plunge / ice bath:** Hypothermia, cold shock response, cardiac arrhythmia, hyperventilation, drowning, and loss of consciousness
- **Swim spa:** Drowning, slips and falls on wet surfaces, entrapment, chemical irritation, and injuries from water jets or currents
- **Climbing structures:** Falls from height, broken bones, sprains, strains, head injuries, spinal injuries, paralysis, and death. **These structures are designed and intended exclusively for individuals in strong athletic condition; use by others significantly increases the risk of serious injury**
- **Outdoor grounds:** Fire ant bites and stings, venomous snake or insect encounters, uneven terrain, exposure to thorns, rocks, and other natural hazards. **Participants should not go barefoot on the property grounds at any time due to the presence of fire ants and other dangers that pose serious risk to bare feet**
- General risks of physical exertion, pre-existing medical conditions, equipment failure, negligence of other participants, and hazards that may not be readily apparent

**I understand that the above list is not exhaustive and that other risks, both known and unknown, may exist.**

## 3. VOLUNTARY ASSUMPTION OF RISK

I voluntarily and freely choose to use the property amenities and facilities described above. **I assume full responsibility for any and all risks of injury, illness, disability, or death** arising from my participation in or use of these facilities, whether caused by the negligence of the Owner, its agents, employees, or otherwise.

## 4. MEDICAL FITNESS REPRESENTATION

I represent and warrant that I am physically fit and sufficiently healthy to participate in the activities described above. I have no medical condition, disability, or other limitation that would prevent or restrict my safe participation. **With respect to climbing structures specifically, I represent that I am in strong athletic condition sufficient for their intended use.** I agree that it is my responsibility to consult with a physician prior to use of any amenity about which I have health or safety concerns.

## 5. WAIVER AND RELEASE OF LIABILITY

**TO THE FULLEST EXTENT PERMITTED BY TEXAS LAW, I HEREBY RELEASE, WAIVE, DISCHARGE, AND COVENANT NOT TO SUE** the Revocable Trust of Subhash Sonnad, its trustees, agents, employees, representatives, successors, and assigns (collectively, the "Released Parties") from **any and all liability, claims, demands, causes of action, costs, and expenses** (including attorneys' fees) arising out of or related to any loss, damage, or injury, including death, that may be sustained by me, or to any property belonging to me, **WHETHER CAUSED BY THE NEGLIGENCE OF THE RELEASED PARTIES OR OTHERWISE,** while participating in or using the facilities and amenities at 123 Main Stive, Your City, Texas 00000.

## 6. INDEMNIFICATION

I agree to **indemnify, defend, and hold harmless** the Released Parties from any and all claims, suits, losses, damages, costs, and expenses (including reasonable attorneys' fees) arising out of or related to my use of the property amenities and facilities, including any claim brought by or on behalf of my family members, heirs, personal representatives, or assigns.

## 7. TEXAS LAW COMPLIANCE

This Agreement is entered into in the State of Texas and shall be governed by and construed in accordance with the laws of the State of Texas. I acknowledge that Texas law recognizes the validity of pre-injury releases and waivers of liability for negligence in recreational activities. **This Agreement is intended to be as broad and inclusive as permitted under Texas law.** Any dispute arising under this Agreement shall be subject to the exclusive jurisdiction of the courts of Your County, Texas.

## 8. ELECTRONIC SIGNATURE

I acknowledge that this document is being executed electronically in compliance with the federal Electronic Signatures in Global and National Commerce Act (ESIGN Act, 15 U.S.C. § 7001 et seq.) and the Texas Uniform Electronic Transactions Act (Texas Business & Commerce Code, Chapter 322). My electronic signature below has the same legal force and effect as a handwritten signature.

## 9. SEVERABILITY

If any provision of this Agreement is held to be invalid or unenforceable, the remaining provisions shall remain in full force and effect. The invalid or unenforceable provision shall be modified to the minimum extent necessary to make it valid and enforceable while preserving the parties' intent.

## 10. ENTIRE AGREEMENT

This Waiver of Liability constitutes the entire agreement between the parties regarding assumption of risk and release of liability for use of property amenities. This waiver is incorporated into and made a part of any residential lease agreement between the parties.

---

## ACKNOWLEDGMENT AND SIGNATURE

**I HAVE READ THIS WAIVER OF LIABILITY, ASSUMPTION OF RISK, AND INDEMNITY AGREEMENT IN ITS ENTIRETY. I FULLY UNDERSTAND ITS TERMS AND UNDERSTAND THAT I AM GIVING UP SUBSTANTIAL LEGAL RIGHTS, INCLUDING THE RIGHT TO SUE. I ACKNOWLEDGE THAT I AM SIGNING THIS AGREEMENT FREELY AND VOLUNTARILY, AND INTEND MY SIGNATURE TO BE A COMPLETE AND UNCONDITIONAL RELEASE OF ALL LIABILITY TO THE GREATEST EXTENT ALLOWED BY TEXAS LAW.**

**PARTICIPANT**

Signature: _________________________

Name: {{tenant_name}}

Date: _________________________
`;

// ============================================================
// DEFAULT EVENT/GUEST WAIVER TEMPLATE
// ============================================================

const DEFAULT_EVENT_WAIVER = `# WAIVER OF LIABILITY, ASSUMPTION OF RISK, AND INDEMNITY AGREEMENT

## FOR GUESTS AND EVENT ATTENDEES

**PLEASE READ CAREFULLY BEFORE SIGNING. THIS IS A RELEASE OF LIABILITY AND WAIVER OF CERTAIN LEGAL RIGHTS.**

---

**Property Owner:** Revocable Trust of Subhash Sonnad ("Owner")
**Property Address:** 123 Main Stive, Your City, Texas 00000

**Guest/Attendee:** {{client_name}} ("Participant")
- **Email:** {{client_email}}

**Date:** {{signing_date}}

**Event Date:** {{event_date}}

---

## 1. ACTIVITIES AND FACILITIES

The Owner makes available certain recreational amenities and facilities on the property at 123 Main Stive, Your City, Texas 00000 (the "YOUR_PROPERTY_NAME"), including but not limited to:

- **Hot sauna(s)** (dry sauna and/or infrared sauna)
- **Cold plunge pool / ice bath**
- **Swim spa / hydrotherapy pool**
- **Climbing structures** (designed for individuals in strong athletic condition only)
- Outdoor grounds, trails, decks, patios, and common areas
- Other recreational equipment and amenities as may be present on the property

## 2. ACKNOWLEDGMENT OF RISKS

I, **{{client_name}}**, acknowledge and understand that my presence at the property and participation in or use of the above-described activities and facilities involves **inherent and significant risks of serious bodily injury, disability, and death.** These risks include, but are not limited to:

- **Hot sauna:** Heat exhaustion, heat stroke, dehydration, burns, cardiovascular complications, loss of consciousness, and exacerbation of pre-existing medical conditions
- **Cold plunge / ice bath:** Hypothermia, cold shock response, cardiac arrhythmia, hyperventilation, drowning, and loss of consciousness
- **Swim spa:** Drowning, slips and falls on wet surfaces, entrapment, chemical irritation, and injuries from water jets or currents
- **Climbing structures:** Falls from height, broken bones, sprains, strains, head injuries, spinal injuries, paralysis, and death. **These structures are designed and intended exclusively for individuals in strong athletic condition; use by others significantly increases the risk of serious injury**
- **Outdoor grounds:** Fire ant bites and stings, venomous snake or insect encounters, uneven terrain, exposure to thorns, rocks, and other natural hazards. **Guests should not go barefoot on the property grounds at any time due to the presence of fire ants and other dangers that pose serious risk to bare feet**
- General risks of physical exertion, pre-existing medical conditions, equipment failure, negligence of other participants, and hazards that may not be readily apparent

**I understand that the above list is not exhaustive and that other risks, both known and unknown, may exist.**

## 3. VOLUNTARY ASSUMPTION OF RISK

I voluntarily and freely choose to enter the property and use any amenities and facilities available to me. **I assume full responsibility for any and all risks of injury, illness, disability, or death** arising from my presence at or use of the property, whether caused by the negligence of the Owner, its agents, employees, event organizers, or otherwise.

## 4. MEDICAL FITNESS REPRESENTATION

I represent and warrant that I am physically fit and sufficiently healthy to participate in any activities I choose to engage in while at the property. I have no medical condition, disability, or other limitation that would prevent or restrict my safe participation. **With respect to climbing structures specifically, I represent that I am in strong athletic condition sufficient for their intended use.** I agree that it is my sole responsibility to refrain from using any amenity for which I am not physically qualified.

## 5. WAIVER AND RELEASE OF LIABILITY

**TO THE FULLEST EXTENT PERMITTED BY TEXAS LAW, I HEREBY RELEASE, WAIVE, DISCHARGE, AND COVENANT NOT TO SUE** the Revocable Trust of Subhash Sonnad, its trustees, agents, employees, representatives, event hosts, event organizers, successors, and assigns (collectively, the "Released Parties") from **any and all liability, claims, demands, causes of action, costs, and expenses** (including attorneys' fees) arising out of or related to any loss, damage, or injury, including death, that may be sustained by me, or to any property belonging to me, **WHETHER CAUSED BY THE NEGLIGENCE OF THE RELEASED PARTIES OR OTHERWISE,** while present at or using the facilities and amenities at 123 Main Stive, Your City, Texas 00000.

## 6. INDEMNIFICATION

I agree to **indemnify, defend, and hold harmless** the Released Parties from any and all claims, suits, losses, damages, costs, and expenses (including reasonable attorneys' fees) arising out of or related to my presence at the property or use of the property amenities and facilities, including any claim brought by or on behalf of my family members, heirs, personal representatives, or assigns.

## 7. TEXAS LAW COMPLIANCE

This Agreement is entered into in the State of Texas and shall be governed by and construed in accordance with the laws of the State of Texas. I acknowledge that Texas law recognizes the validity of pre-injury releases and waivers of liability for negligence in recreational activities. **This Agreement is intended to be as broad and inclusive as permitted under Texas law.** Any dispute arising under this Agreement shall be subject to the exclusive jurisdiction of the courts of Your County, Texas.

## 8. ELECTRONIC SIGNATURE

I acknowledge that this document is being executed electronically in compliance with the federal Electronic Signatures in Global and National Commerce Act (ESIGN Act, 15 U.S.C. § 7001 et seq.) and the Texas Uniform Electronic Transactions Act (Texas Business & Commerce Code, Chapter 322). My electronic signature below has the same legal force and effect as a handwritten signature.

## 9. SEVERABILITY

If any provision of this Agreement is held to be invalid or unenforceable, the remaining provisions shall remain in full force and effect. The invalid or unenforceable provision shall be modified to the minimum extent necessary to make it valid and enforceable while preserving the parties' intent.

## 10. ENTIRE AGREEMENT

This Waiver of Liability constitutes the entire agreement between the parties regarding assumption of risk and release of liability for presence at and use of the property. This waiver is binding regardless of whether the Participant is attending a hosted event, visiting as an invited guest, or present on the property for any other lawful purpose.

---

## ACKNOWLEDGMENT AND SIGNATURE

**I HAVE READ THIS WAIVER OF LIABILITY, ASSUMPTION OF RISK, AND INDEMNITY AGREEMENT IN ITS ENTIRETY. I FULLY UNDERSTAND ITS TERMS AND UNDERSTAND THAT I AM GIVING UP SUBSTANTIAL LEGAL RIGHTS, INCLUDING THE RIGHT TO SUE. I ACKNOWLEDGE THAT I AM SIGNING THIS AGREEMENT FREELY AND VOLUNTARILY, AND INTEND MY SIGNATURE TO BE A COMPLETE AND UNCONDITIONAL RELEASE OF ALL LIABILITY TO THE GREATEST EXTENT ALLOWED BY TEXAS LAW.**

**PARTICIPANT**

Signature: _________________________

Name: {{client_name}}

Date: _________________________
`;

// ============================================================
// DEFAULT VEHICLE RENTAL AGREEMENT TEMPLATE
// ============================================================

const DEFAULT_VEHICLE_RENTAL = `# VEHICLE RENTAL AGREEMENT

**YOUR_APP_NAME Residency**
123 Main Stive, Your City, TX 00000

---

This Vehicle Rental Agreement ("Agreement") is entered into on **{{signing_date}}** between:

**OWNER:** {{owner_name}} ("Owner")
- Address: {{owner_address}}
- Phone: {{owner_phone}}
- Email: {{owner_email}}

**RENTER:** {{renter_name}} ("Renter")
- Address: {{renter_address}}
- Phone: {{renter_phone}}
- Email: {{renter_email}}
- Driver's License: {{renter_dl_number}} (State: {{renter_dl_state}})

---

## 1. VEHICLE INFORMATION

The Owner agrees to rent the following vehicle to the Renter:

- **Year:** {{vehicle_year}}
- **Make:** {{vehicle_make}}
- **Model:** {{vehicle_model}}
- **Color:** {{vehicle_color}}
- **VIN:** {{vehicle_vin}}
- **License Plate:** {{vehicle_license_plate}}
- **Starting Mileage:** {{starting_mileage}}

## 2. RENTAL PERIOD

- **Start Date:** {{rental_start_date}}
- **End Date:** {{rental_end_date}}

The vehicle must be returned by 11:59 PM on the end date unless otherwise agreed in writing.

## 3. RENTAL RATE & PAYMENT

- **Monthly Rental Rate:** {{monthly_rate}}
- **FSD (Full Self-Driving) Subscription:** {{fsd_rate}} (if applicable)
- **Security Deposit:** {{security_deposit}}

Rent is due on the 1st of each month. Accepted payment methods: Venmo, Zelle, PayPal, or Bank Transfer.

The security deposit will be returned within 30 days of vehicle return, less any deductions for damages, excess mileage, cleaning, or other charges as outlined in this Agreement.

## 4. MILEAGE

- **Monthly Mileage Allowance:** {{monthly_mileage_limit}}
- **Overage Rate:** {{mileage_overage_rate}} per mile over the monthly allowance

Mileage will be tracked via the vehicle's odometer. Overage charges will be calculated at the end of each rental month and added to the following month's payment.

## 5. INSURANCE

{{insurance_requirements}}

Renter must maintain valid auto insurance coverage for the duration of the rental period. Proof of insurance must be provided before taking possession of the vehicle. Renter's insurance must be primary coverage.

## 6. USE OF VEHICLE

The Renter agrees to:
- Use the vehicle only for lawful purposes
- Not allow any unlicensed or unauthorized drivers to operate the vehicle
- Not use the vehicle for commercial purposes (rideshare, delivery, etc.) without written consent
- Not smoke or vape in the vehicle
- Not transport pets without prior written approval
- Maintain the vehicle in clean condition
- Not modify the vehicle in any way
- Follow all traffic laws and regulations
- Not take the vehicle outside of the State of Texas without prior written consent

## 7. CHARGING (ELECTRIC VEHICLES)

- Renter is responsible for keeping the vehicle charged
- Home charging costs are included in the rental rate
- Supercharger and public charging costs are the Renter's responsibility
- Renter must not let the battery level drop below 10%

## 8. MAINTENANCE & REPAIRS

- Routine maintenance (tire rotations, wiper fluid, etc.) is the Owner's responsibility
- Renter must promptly report any mechanical issues, warning lights, or damage
- Renter is responsible for tire damage caused by road hazards, curbing, or negligence
- Owner will handle all scheduled service appointments

## 9. DAMAGE & LIABILITY

- Renter is responsible for all damage to the vehicle during the rental period, including damage caused by third parties
- Renter must report any accident or damage within 24 hours
- Renter is liable for the insurance deductible amount in the event of a claim
- Owner is not responsible for personal property left in the vehicle

## 10. LATE RETURNS

If the vehicle is not returned by the agreed-upon end date:

- **Hourly late fee:** {{late_return_hourly_rate}} per hour for the first 24 hours
- **Daily late fee:** {{late_return_daily_rate}} per day after the first 24 hours

If the vehicle is not returned within 72 hours of the end date without prior arrangement, the Owner reserves the right to report the vehicle as stolen and pursue all available legal remedies.

## 11. EARLY TERMINATION

Either party may terminate this Agreement with 30 days written notice. In the event of early termination:

- Renter must return the vehicle in the same condition as received (normal wear and tear excepted)
- Security deposit will be returned per the terms of Section 3
- No penalty for early termination with proper notice

## 12. RETURN CONDITION

Upon return, the vehicle must be:
- Clean (interior and exterior) — a $150 cleaning fee will be charged otherwise
- Charged to at least 80% battery (electric vehicles)
- Free of personal belongings
- In the same mechanical condition as received (normal wear and tear excepted)

## 13. GOVERNING LAW

This Agreement shall be governed by and construed in accordance with the laws of the State of Texas. Any disputes arising under this Agreement shall be subject to the exclusive jurisdiction of the courts of Your County, Texas.

## 14. ADDITIONAL TERMS

{{additional_terms}}

---

## SIGNATURES

By signing below, both parties agree to the terms of this Vehicle Rental Agreement.

**OWNER**

Signature: _________________________

Name: {{owner_name}}

Date: _________________________


**RENTER**

Signature: _________________________

Name: {{renter_name}}

Date: _________________________
`;

/**
 * Get the default template content
 * @param {string} type - Template type: 'lease', 'renter_waiver', 'event_waiver', 'vehicle_rental'
 */
function getDefaultTemplate(type = 'lease') {
  if (type === 'renter_waiver') return DEFAULT_RENTER_WAIVER;
  if (type === 'event_waiver') return DEFAULT_EVENT_WAIVER;
  if (type === 'vehicle_rental') return DEFAULT_VEHICLE_RENTAL;
  return DEFAULT_TEMPLATE;
}

export const leaseTemplateService = {
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
