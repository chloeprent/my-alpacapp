-- Migration: Event Hosting Request System
-- Version: 009
-- Description: Creates tables for event hosting requests, paralleling the rental application workflow

BEGIN;

-- ============================================
-- 1. EVENT HOSTING REQUESTS TABLE
-- ============================================
-- Central tracking for event hosting requests through the workflow

CREATE TABLE IF NOT EXISTS event_hosting_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Client link
  person_id UUID REFERENCES people(id) ON DELETE CASCADE,
  organization_name TEXT,                -- If renting on behalf of an org
  has_hosted_before BOOLEAN DEFAULT false,

  -- Event details
  event_name TEXT NOT NULL,
  event_description TEXT,
  event_type TEXT,                       -- party, workshop, retreat, ceremony, etc.
  event_date DATE NOT NULL,
  event_start_time TIME NOT NULL,
  event_end_time TIME NOT NULL,          -- Can be next day (e.g., 1:30 AM)
  expected_guests INTEGER NOT NULL,
  is_ticketed BOOLEAN DEFAULT false,
  marketing_materials_link TEXT,
  special_requests TEXT,

  -- Staffing contacts (required)
  setup_staff_name TEXT,
  setup_staff_phone TEXT,
  cleanup_staff_name TEXT,
  cleanup_staff_phone TEXT,
  parking_manager_name TEXT,
  parking_manager_phone TEXT,

  -- Acknowledgments (all must be true to submit)
  ack_no_address_posting BOOLEAN DEFAULT false,
  ack_parking_management BOOLEAN DEFAULT false,
  ack_noise_curfew BOOLEAN DEFAULT false,
  ack_no_alcohol_inside BOOLEAN DEFAULT false,
  ack_no_meat_inside BOOLEAN DEFAULT false,
  ack_no_rvs BOOLEAN DEFAULT false,
  ack_no_animals_inside BOOLEAN DEFAULT false,
  ack_cleaning_responsibility BOOLEAN DEFAULT false,
  ack_linens_furniture BOOLEAN DEFAULT false,
  ack_propane_reimbursement BOOLEAN DEFAULT false,

  -- Request status
  request_status TEXT NOT NULL DEFAULT 'submitted',
  -- Values: submitted, under_review, approved, denied, delayed, withdrawn

  submitted_at TIMESTAMPTZ DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,                      -- Admin who reviewed

  -- Approval details (filled when approved)
  approved_max_guests INTEGER,
  rental_fee DECIMAL(10,2) DEFAULT 295,
  reservation_fee DECIMAL(10,2) DEFAULT 95,
  cleaning_deposit DECIMAL(10,2) DEFAULT 195,
  additional_terms TEXT,

  -- Agreement workflow
  agreement_status TEXT DEFAULT 'pending',
  -- Values: pending, generated, sent, signed

  agreement_document_url TEXT,           -- Link to generated PDF
  agreement_generated_at TIMESTAMPTZ,
  agreement_sent_at TIMESTAMPTZ,
  agreement_signed_at TIMESTAMPTZ,
  signwell_document_id TEXT,             -- SignWell tracking ID
  signed_pdf_url TEXT,                   -- URL to signed PDF

  -- Deposit tracking
  deposit_status TEXT DEFAULT 'pending',
  -- Values: pending, requested, partial, received, confirmed, refunded

  reservation_fee_paid BOOLEAN DEFAULT false,
  reservation_fee_paid_at TIMESTAMPTZ,
  reservation_fee_method TEXT,

  cleaning_deposit_paid BOOLEAN DEFAULT false,
  cleaning_deposit_paid_at TIMESTAMPTZ,
  cleaning_deposit_method TEXT,

  rental_fee_paid BOOLEAN DEFAULT false,
  rental_fee_paid_at TIMESTAMPTZ,
  rental_fee_method TEXT,

  deposit_requested_at TIMESTAMPTZ,
  deposit_confirmed_at TIMESTAMPTZ,
  deposit_refunded_at TIMESTAMPTZ,
  deposit_refund_amount DECIMAL(10,2),
  deposit_refund_notes TEXT,

  -- Event completion
  event_completed_at TIMESTAMPTZ,
  cleaning_verified_at TIMESTAMPTZ,
  cleaning_photos_submitted BOOLEAN DEFAULT false,

  -- Notes and reasons
  admin_notes TEXT,
  denial_reason TEXT,
  delay_reason TEXT,
  delay_revisit_date DATE,               -- When to revisit delayed request

  -- Flags
  is_archived BOOLEAN DEFAULT false,
  is_test BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- 2. EVENT REQUEST SPACES (Junction Table)
-- ============================================
-- Links event requests to requested/approved spaces

CREATE TABLE IF NOT EXISTS event_request_spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_request_id UUID NOT NULL REFERENCES event_hosting_requests(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,

  -- Whether this is a requested space or approved/excluded
  space_type TEXT NOT NULL DEFAULT 'requested',
  -- Values: requested, approved, excluded

  created_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE(event_request_id, space_id, space_type)
);

-- ============================================
-- 3. EVENT AGREEMENT TEMPLATES TABLE
-- ============================================
-- Stores markdown templates for event agreements

CREATE TABLE IF NOT EXISTS event_agreement_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  content TEXT NOT NULL,                 -- Markdown with {{placeholders}}
  version INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- 4. EVENT PAYMENTS TABLE
-- ============================================
-- Tracks all payments for event hosting

CREATE TABLE IF NOT EXISTS event_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  event_request_id UUID NOT NULL REFERENCES event_hosting_requests(id) ON DELETE CASCADE,

  -- Payment type
  payment_type TEXT NOT NULL,
  -- Values: reservation_fee, cleaning_deposit, rental_fee, damage_deduction, refund

  -- Amounts
  amount_due DECIMAL(10,2) NOT NULL,
  amount_paid DECIMAL(10,2) DEFAULT 0,

  -- Dates
  due_date DATE,
  paid_date DATE,

  -- Payment details
  payment_method TEXT,                   -- venmo, zelle, paypal, bank_ach, cash, check
  transaction_id TEXT,                   -- External reference

  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- 5. CREATE INDEXES
-- ============================================

CREATE INDEX IF NOT EXISTS idx_event_requests_status
  ON event_hosting_requests(request_status, agreement_status, deposit_status);

CREATE INDEX IF NOT EXISTS idx_event_requests_person
  ON event_hosting_requests(person_id);

CREATE INDEX IF NOT EXISTS idx_event_requests_date
  ON event_hosting_requests(event_date);

CREATE INDEX IF NOT EXISTS idx_event_request_spaces_request
  ON event_request_spaces(event_request_id);

CREATE INDEX IF NOT EXISTS idx_event_request_spaces_space
  ON event_request_spaces(space_id);

CREATE INDEX IF NOT EXISTS idx_event_payments_request
  ON event_payments(event_request_id);

CREATE INDEX IF NOT EXISTS idx_event_agreement_templates_active
  ON event_agreement_templates(is_active);

-- ============================================
-- 6. ROW LEVEL SECURITY
-- ============================================

ALTER TABLE event_hosting_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_request_spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_agreement_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_payments ENABLE ROW LEVEL SECURITY;

-- Public read access (matches existing pattern)
CREATE POLICY "Public read event_hosting_requests" ON event_hosting_requests
  FOR SELECT USING (true);
CREATE POLICY "Public read event_request_spaces" ON event_request_spaces
  FOR SELECT USING (true);
CREATE POLICY "Public read event_agreement_templates" ON event_agreement_templates
  FOR SELECT USING (true);
CREATE POLICY "Public read event_payments" ON event_payments
  FOR SELECT USING (true);

-- Allow all operations (can restrict later with auth)
CREATE POLICY "Allow all event_hosting_requests" ON event_hosting_requests
  FOR ALL USING (true);
CREATE POLICY "Allow all event_request_spaces" ON event_request_spaces
  FOR ALL USING (true);
CREATE POLICY "Allow all event_agreement_templates" ON event_agreement_templates
  FOR ALL USING (true);
CREATE POLICY "Allow all event_payments" ON event_payments
  FOR ALL USING (true);

-- ============================================
-- 7. INSERT DEFAULT EVENT AGREEMENT TEMPLATE
-- ============================================

INSERT INTO event_agreement_templates (name, content, version, is_active) VALUES
('Default Event Agreement', '# YOUR_PROPERTY_NAME Event RENTAL AGREEMENT

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

**Reservation Fee:** A refundable **{{reservation_fee}}** reservation fee is due at time of reservation. This is not refundable if the event is canceled. If the event happens, this will be refunded along with any cleaning deposits.

**Cleaning & Damage Deposit:** A refundable damage waiver fee of **{{cleaning_deposit}}** is due upon booking, at least two weeks before the event. This fee is used to cover cleaning and maintenance of the rentals after the rental period. If any damage occurs, Company will first use the Cleaning and Maintenance Fee to repair. If the repair costs exceed the Damage Waiver fee, Client will be responsible for the amount in excess of the Cleaning and Maintenance Fee they already paid.

This fee will not be refunded if event is canceled less than 14 days before scheduled date.

After the event, the Client agrees to clean the house according to the following schedule of items for all areas used, and indicate which tasks have been completed afterwards and submit photos of each, prior to receiving the deposit refund.

https://docs.google.com/spreadsheets/d/1YP3fq703lP91rBZ54ba2TSLXrzqgVzxPRCW3w8lzG9M/edit#gid=989989662

If the house is not cleaned, the company will hire a cleaner and deduct from the damage deposit, estimated around $150 but billed at the actual cost @ $30/hour + $30.

## GUEST LIMIT

Client agrees no more than **{{max_guests}} people** including volunteers and paid attendees will be attending, including people attending who live at the house. Client agrees to pay $15 fee per additional person, and agrees to candidly report attendance.

## WARRANTY DISCLAIMER

Client acknowledges that the rental property is of a size, design, and capacity selected by Client, and that Company disclaims all warranties express or implied with respect to the rental property, including any express or implied warranties as to condition, fitness for a particular purpose or durability.

## DAMAGED OR MISSING RENTAL ITEMS

Damages include, but are not limited to chipped, cracked or broken items, stained and dirtied upholstery or fabric that are beyond normal wear and tear, loss or damage due to theft, burglary, misuse, abuse, theft by conversion, intentional damage, disappearance, or loss due to Client''s failure to care for the Rental Items, including damage as a result of leaving Rental Items out in the rain or in a sprinkler system.

If Client discovers damaged or missing rental items prior to the start of the event, Client must notify Company immediately. As appropriate, Company will provide a replacement for any damaged or missing rental items prior to the event start time. If not possible to provide any replacements, the Company will refund the appropriate fee associated with the damaged/missing items. Damaged rental items shall not be used at the event. All damaged rental items remain the property of Company and must be returned to Company.

Any damages occurring after the Rental Items are delivered to Client, including damage occurring as a result of any person other than a Company representative moving the Rental Items from the location where they were placed by Company are the sole responsibility of Client, whether actually caused by Client or by Client''s guests, event venue staff, or third party event vendors.

**Inclement Weather:** Client further agrees to arrange effective provisions so that, in the event of rain or inclement conditions, goods will be shielded from the elements and/or protected from damage. Failure to plan for such contingency may result in Company not placing items outdoors such as furnishings. For any costs owed to the Company for any damage repair, Client shall remit payment to Company within 30 days following Company''s written request.

## PHOTOGRAPHY & BRANDING

Client agrees that any photography of their event at the YOUR_PROPERTY_NAME will not be publicly posted without permission. The name "YOUR_PROPERTY_NAME" will only be used in describing the location and not as a host of the event.

## INDEMNIFICATION

Client hereby voluntarily and expressly releases, indemnifies, forever discharges and holds harmless Company any and all liability, claims, demands, causes or rights of action whether personal to Client, including those allegedly attributed to negligent acts or omissions. Should Company or anyone on behalf of Company be required to incur attorney fees and costs to enforce this agreement, Client expressly agrees to indemnify and hold harmless Company for all such fees and costs. In consideration of being permitted by Company to use its furniture, the undersigned agree to indemnify and hold harmless Company from any and all claims which are brought by the undersigned.

Client acknowledges and certifies that Client has had sufficient opportunity to read the entire Rental Agreement and understands its content, and Client executes it freely and without duress of any kind and agrees to the terms herein stated.

## DISPUTE RESOLUTION & APPLICABLE LAW AND JURISDICTION

If a dispute arises under this Agreement, the parties agree to first try to resolve the dispute with the help of a mutually agreed-upon mediator in Your County, TX. This Agreement shall be governed by the laws of the State of Texas, and any disputes arising from it must be handled exclusively in the federal and state courts located in County of Your County, TX.

## ENTIRE AGREEMENT

This Agreement (including attachments) contains the entire agreement of the parties and there are no other promises or conditions in any other agreement whether oral or written. This Agreement supersedes any prior written or oral agreements between the parties.

## AMENDMENT

This Agreement may be modified or amended if the amendment is made in writing and is signed by all parties.

## HEADINGS

The headings contained in this Agreement are strictly for convenience, and shall not be used to construe meaning or intent.

## SEVERABILITY

If any provision of this Agreement shall be held to be invalid or unenforceable for any reason, the remaining provisions shall continue to be valid and enforceable. If a court finds that any provisions of this Agreement is invalid or unenforceable, but that by limiting such provision it would become valid and enforceable, then such provision shall be deemed to be written, construed, and enforced as so limited.

## WAIVER

The failure of any Party to require strict compliance with the performance of any obligations and/or conditions of this Agreement shall not be deemed a waiver of that Party''s right to require strict compliance in the future, or construed as consent to any breach of the terms of this Agreement.

## FORCE MAJEURE

Both parties shall not be liable for any failure of or delay in the performance of this Agreement if such failure or delay is due to unforeseeable causes beyond its reasonable control, including but not limited to acts of God, war, strikes or labor disputes, embargoes, pandemics, government orders (each a "Force Majeure Event"). Upon occurrence of any force majeure event, the affected party shall give written notice to the other party of its inability to perform or of delay in completing its obligations. A Force Majeure Event cannot be used to excuse Clients breach of its payment obligations or modify the cancellation policies under this contract. However, any amounts paid to Company up to the date of the Force Majeure Event will be available for transfer to another event within the 1 year period following the originally scheduled Rental Date.

## ASSIGNABILITY AND PARTIES OF INTEREST

No Party may assign, directly or indirectly, all or part of its rights or obligations under this Agreement without the prior written consent of the other party. Nothing in this Agreement, expressed or implied, will confer upon any person or entity not a party to this Agreement, or the legal representatives of such person or entity, any rights, remedies, obligations, or liabilities of any nature or kind whatsoever under or by reason of this Agreement, except as expressly provided in this Agreement.

## CONFIDENTIALITY

The parties hereto agree that each shall treat confidentially the terms and conditions of this Agreement and all information provided by each party to the other regarding its business and operations. All confidential information provided by a party hereto shall be used by any other party hereto solely for the purpose of rendering or obtaining services pursuant to this Agreement and, except as may be required in carrying out this Agreement, shall not be disclosed to any third party without the prior consent of such providing party. The foregoing shall not be applicable to any information that is publicly available when provided or thereafter becomes publicly available other than through a breach of this Agreement, or that is required to be disclosed by or to any bank examiner of the Custodian or any Subcustodian, any Regulatory Authority, any auditor of the parties hereto, or by judicial or administrative process or otherwise by Applicable Law.

## COUNTERPARTS, SIGNATURES

This Agreement may be executed in one or more counterparts, each of which shall be deemed an original and which collectively shall constitute one agreement. Use of fax, email and electronic signatures shall have the same force and effect as an original signature.

---

|                          | **Owner''s Signature**                           |
|--------------------------|------------------------------------------------|
|                          |                                                |
| **{{client_name}}**      | Rahul Sonnad                                   |
| Date:                    | Date:                                          |
|                          | Administrator Austin YOUR_PROPERTY_NAME          |
| Address                  | 123 Main St DR                            |
| City, State, Zip Code    | Your City TX 00000                           |
| Phone                    | +1-424-234-1750                                |

---

# EXHIBIT A - Event Details Summary

## Event Information

| Field | Value |
|-------|-------|
| **Client** | {{client_name}} |
| **Email** | {{client_email}} |
| **Phone** | {{client_phone}} |
| **Event Date** | {{event_date}} |
| **Event Time** | {{event_start_time}} to {{event_end_time}} |
| **Maximum Guests** | {{max_guests}} |

## Financial Summary

| Fee | Amount |
|-----|--------|
| **Rental Fee** | {{rental_fee}} |
| **Reservation Fee** (refundable) | {{reservation_fee}} |
| **Cleaning & Damage Deposit** (refundable) | {{cleaning_deposit}} |
| **Total Due** | {{total_due}} |

## Venue - Included Spaces

{{included_spaces}}

## Venue - Excluded Spaces

{{excluded_spaces}}

---

## Client Obligations

1. **Staffing Requirements:**
   - Pre-event Setup to arrive 90 minutes before start of event
   - Post-event Cleaners
   - Pre and during event parking management - Parking must be managed at all times people are arriving, during the event to prevent parking on neighbors property

2. **Guest Limit:** No more than **{{max_guests}} people** including volunteers and paid attendees. $15 fee per additional person applies.

3. **Address Privacy:** Client agrees to NOT post the address of the venue in any distributed materials including texts, emails, social media postings or printed materials. Instead a link to YOUR_DOMAIN/visiting web page will be provided. $100 fee if address is posted.

4. **Marketing Materials:** Client will send links to all marketing materials to +14242341750 on WhatsApp or to specified WhatsApp group or team@YOUR_DOMAIN

5. **Parking Management:** Client agrees to manage parking to ensure no vehicles are parked in front of neighbors houses. $150 penalty for each complaint from neighbors regarding parking on their property.

6. **Noise Levels:** Client agrees to keep noise & music levels outside to a minimum after 9:30pm. $100 fee if neighbors complain about noise after this time. Doors must be kept closed when loud music is playing inside. No PA speakers at high volume after 9:30pm unless entirely inside with doors secured closed.

7. **Cleaning Timeline:** Cleaners arrive at least 90 minutes before event start. All cleaning must be complete by 1:01pm the day after the event. Cleaning not completed by this time will be charged at $30 + $30/hour. Deposits returned within 24 hours after cleaning photos submitted.

8. **Propane Usage:** Any propane used during the event for heating, display propane or hot tubs will be reimbursed from the damage deposit.

9. **No Alcohol or Meat Inside:** No alcohol or meat may be brought into the house or consumed inside. Meat may be grilled outside and stored outside of the kitchen.

10. **No RVs:** No RVs will be parked onsite at any time. $100 fee if this happens. RVs can be parked on frontage road (5 minute walk away).

11. **Linens & Furniture:** Any used linens and towels must be washed and replaced into their closets. Furniture moved must be replaced to original location based on photographs taken before the event (renter''s responsibility).

12. **No Animals:** No animals may be brought into the house or the backyard. $100 fee if this happens. Dogs can be tied in front yard but should not run free (neighbor dogs are aggressive).

---

## Additional Terms

{{additional_terms}}
', 1, true)
ON CONFLICT DO NOTHING;

COMMIT;
