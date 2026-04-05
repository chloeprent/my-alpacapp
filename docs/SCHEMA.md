# Database Schema Reference
## Database Schema (Supabase)

### Core Tables
```
spaces          - Rental units (name, rates, beds, baths, visibility flags)
people          - Tenants/guests (name, contact, type, residence_location)
assignments     - Bookings (person_id, dates, rate, status)
assignment_spaces - Junction: which spaces are in which assignments
```

### Multi-Location Support
```
people.residence_location - Segregates tenants by property location
  Values: 'default_location' (default, YOUR_PROPERTY_NAME), 'secondary_location' (Secondary City WA)

spaces.location           - Matches residence_location for filtering

NOTE: Secondary Location is a SEPARATE tax entity from YOUR_PROPERTY_NAME.
      YOUR_APP_NAME only manages late rent email tracking for Secondary Location.
      Accounting is handled elsewhere (Finleg). Forward payment notifications
      to agent@finleg.net.
```

### Media System (New - use this, not legacy photos)
```
media           - All media files (url, dimensions, caption, category)
media_spaces    - Junction: media ↔ spaces (with display_order, is_primary)
media_tags      - Tag definitions (name, color)
media_tag_assignments - Junction: media ↔ tags
```

### SMS System
```
telnyx_config        - Telnyx API configuration (single row, id=1)
                      (api_key, messaging_profile_id, phone_number, is_active, test_mode)
sms_messages         - Log of all SMS sent/received
                      (person_id, direction, from/to_number, body, sms_type, telnyx_id, status)
```

### Inbound Email System
```
inbound_emails       - Log of all inbound emails received via Resend
                      (resend_email_id, from_address, to_address, cc, subject,
                       body_html, body_text, attachments, route_action,
                       forwarded_to, forwarded_at, special_logic_type,
                       processed_at, raw_payload)
```

### Email Approval System
```
email_type_approval_config - Per-type flag for whether emails need admin approval
                            (email_type PK, requires_approval bool,
                             auto_approved_at, auto_approved_by, updated_at)
pending_email_approvals    - Held emails waiting for admin approval
                            (id uuid PK, email_type, to_addresses[], from_address,
                             reply_to, cc[], bcc[], subject, html, text_content,
                             status enum(pending/approved/rejected/expired),
                             approval_token unique, created_at, approved_at,
                             approved_by, expires_at default +7 days)
```

### Lease Agreement System
```
lease_templates      - Markdown templates with {{placeholders}}
                      (name, content, version, is_active)
signwell_config      - SignWell API configuration (single row)
                      (api_key, webhook_secret, test_mode)
```

Key columns added to `rental_applications`:
- `generated_pdf_url` - URL to generated lease PDF in Supabase storage
- `signwell_document_id` - SignWell document tracking ID
- `signed_pdf_url` - URL to signed lease PDF after e-signature

### Govee Lighting System
```
govee_config         - Govee Cloud API configuration (single row, id=1)
                      (api_key, api_base, is_active, test_mode, last_synced_at)
govee_devices        - All Govee/AiDot smart lights (63 devices)
                      (device_id, sku, name, area, device_type, is_group,
                       capabilities, online, last_state, is_active, notes,
                       parent_group_id, display_order, space_id)
govee_models         - SKU → friendly model name lookup (16 rows)
                      (sku [PK], model_name, category)
```

### Nest Thermostat System
```
nest_config          - Google SDM API OAuth credentials (single row, id=1)
                      (google_client_id, google_client_secret, sdm_project_id,
                       refresh_token, access_token, token_expires_at,
                       is_active, test_mode)
nest_devices         - Cached thermostat info (3 devices: Master, Kitchen, Skyloft)
                      (sdm_device_id, room_name, device_type, display_order,
                       is_active, last_state [jsonb], lan_ip)
thermostat_rules     - Future rules engine (schema only, not yet implemented)
                      (name, device_id [FK→nest_devices], rule_type,
                       conditions [jsonb], actions [jsonb], is_active, priority)
```

### Weather System
```
weather_config       - OpenWeatherMap API configuration (single row, id=1)
                      (owm_api_key, latitude, longitude, location_name, is_active)
```

### Tesla & Vehicle System
```
tesla_accounts  - Tesla account credentials + Fleet API config
                  (owner_name, tesla_email, refresh_token, access_token,
                   token_expires_at, is_active, last_error,
                   last_token_refresh_at, fleet_client_id, fleet_client_secret,
                   fleet_api_base, created_at, updated_at)
vehicles        - All vehicles
                  (account_id [FK→tesla_accounts], vehicle_api_id, vin,
                   name, make, model, year, color, color_hex, svg_key, image_url,
                   owner_name, display_order, is_active,
                   vehicle_state [online/asleep/offline/unknown],
                   last_state [jsonb], last_synced_at, created_at, updated_at)
vehicle_drivers - Junction: vehicles ↔ people (who can drive which vehicle)
                  (vehicle_id [FK→vehicles], person_id [FK→people])
vehicle_rentals - Car rental agreements with rate schedules
                  (vehicle_id [FK→vehicles INT], person_id [FK→people],
                   renter_name, renter_email, renter_phone, renter_address,
                   renter_dl_number, renter_dl_state,
                   vehicle_vin, vehicle_make, vehicle_model, vehicle_year, vehicle_color,
                   starting_mileage, start_date, end_date, auto_renew, cancel_notice_days,
                   status [draft/active/ended/cancelled],
                   rate_schedule [jsonb array: {from, to, rate}],
                   current_monthly_rate, security_deposit_amount,
                   security_deposit_paid, security_deposit_returned,
                   deposit_deductions, deposit_deduction_notes,
                   insurance_provider, insurance_policy_number, insurance_verified,
                   monthly_mileage_limit, mileage_overage_rate, current_mileage,
                   late_return_hourly_rate, accident_deductible_max,
                   existing_damage, contract_pdf_url, contract_signed_at,
                   signwell_document_id, admin_notes, additional_terms,
                   created_at, updated_at, ended_at)
```

### Camera Streaming System
```
camera_streams  - go2rtc HLS stream configuration (9 rows: 3 cameras × 3 qualities)
                  (camera_name, quality [low/med/high], stream_name,
                   proxy_base_url, location, protect_share_url, is_active)
```

### LG Laundry System
```
lg_config           - LG ThinQ API configuration (single row, id=1)
                      (pat, api_base, country_code, client_id, is_active, test_mode, last_error)
lg_appliances       - LG washer/dryer devices with cached state
                      (lg_device_id, device_type [washer/dryer], name, model, lan_ip,
                       display_order, is_active, last_state [jsonb], last_synced_at)
push_tokens         - FCM push notification tokens per user (shared, not LG-specific)
                      (app_user_id [FK→app_users], token, platform [ios/android],
                       device_info, is_active)
laundry_watchers    - Who is watching which appliance for cycle-end notification
                      (app_user_id [FK→app_users], appliance_id [FK→lg_appliances])
```

### Anova Precision Oven System
```
anova_config        - Anova Developer API configuration (single row, id=1)
                      (pat, ws_url, is_active, test_mode, last_error, last_synced_at)
anova_ovens         - Anova oven devices with cached state
                      (cooker_id [unique], name, oven_type, firmware_version,
                       hardware_version, space_id [FK→spaces], display_order,
                       is_active, last_state [jsonb], last_synced_at, lan_ip, notes)
```

### Glowforge Laser Cutter System
```
glowforge_config    - Glowforge Cloud API configuration (single row, id=1)
                      (email, session_cookies, session_expires_at,
                       is_active, test_mode, last_error, last_synced_at)
glowforge_machines  - Glowforge machines with cached state
                      (machine_id [unique], name, machine_type,
                       space_id [FK→spaces], display_order,
                       is_active, last_state [jsonb], last_synced_at, lan_ip, notes)
```

### FlashForge 3D Printer System
```
printer_config      - FlashForge printer proxy configuration (single row, id=1)
                      (proxy_url, proxy_secret, is_active, test_mode,
                       last_error, last_synced_at)
printer_devices     - 3D printer devices with cached state
                      (serial_number [unique], name, machine_type, firmware_version,
                       lan_ip, camera_port, tcp_port, space_id [FK→spaces],
                       display_order, is_active, last_state [jsonb], last_synced_at, notes)
```

### Cloudflare R2 & Document Storage
```
r2_config       - Cloudflare R2 configuration (single row, id=1)
                  (account_id, bucket_name, public_url, is_active)
document_index  - Documents stored in R2 for PAI lookup
                  (title, description, keywords [text[]], source_url,
                   file_type, file_size_bytes, storage_backend [supabase/r2],
                   is_active, uploaded_by, created_at, updated_at)
```

### Spotify Integration
```
spotify_config  - Spotify API configuration (singleton row, id=1)
                  (client_id, client_secret, refresh_token, access_token,
                   token_expires_at, is_active, test_mode,
                   created_at, updated_at)
```

### AI Image Generation
```
image_gen_jobs  - Async image generation job queue
                  (prompt, job_type, status, metadata [jsonb],
                   result_media_id [FK→media], result_url,
                   input_tokens, output_tokens, estimated_cost_usd,
                   batch_id, batch_label, attempt_count, max_attempts,
                   priority, created_at, started_at, completed_at)
```

### Prompt Library
```
prompts         - Versioned prompt library (multiple versions per name)
                  (name, version, content, category, description,
                   metadata [jsonb], is_active, created_by [FK→app_users],
                   created_at, updated_at)
                  Unique: (name, version); unique partial index on (name) WHERE is_active
                  Helper functions: get_prompt(name), create_prompt_version(name, content, ...)
                  Categories: image_gen, email, pai, marketing, general
                  Seeded prompts: pai_daily_art (v1+v2), home-server_trio_tech (v1)
```

### User & Auth System
```
app_users       - Application users with roles and profiles
                  (supabase_auth_id, email, role [admin/staff/resident/associate],
                   display_name, first_name, last_name, phone, phone2,
                   avatar_url, bio, person_id [FK→people],
                   nationality, location_base, gender,
                   privacy_phone, privacy_email, privacy_bio [public/residents/private],
                   facebook_url, instagram_url, linkedin_url, x_url,
                   created_at, last_sign_in_at)
user_invitations - Pending user invitations (email, role, invited_by, expires_at)
```

### Property & Brand Configuration
```
property_config - Singleton (id=1) operational identity stored as JSONB
                  (config [jsonb], updated_at, updated_by [FK→app_users])
                  Contains: property name/address/timezone, domain, email senders,
                  payment handles, AI assistant identity, WiFi, mobile app config
                  Readable by all (anon), writable by admin only
                  Client loader: shared/config-loader.js
                  Edge function loader: supabase/functions/_shared/property-config.ts
brand_config    - Singleton (id=1) brand configuration stored as JSONB
                  (config [jsonb], updated_at, updated_by [FK→app_users])
                  Contains: brand names, color palette, typography, logos,
                  visual elements, email template tokens
                  Readable by all (anon), writable by admin only
```

### Associate Hours & Payouts
```
associate_profiles   - Associate metadata
                      (app_user_id [FK→app_users], person_id [FK→people],
                       hourly_rate, payment_method, payment_handle,
                       identity_verification_status [pending/link_sent/verified/flagged/rejected],
                       setup_completed_at)
time_entries         - Clock in/out records
                      (associate_id [FK→associate_profiles], space_id [FK→spaces],
                       clock_in, clock_out, duration_minutes,
                       is_manual, manual_reason, notes,
                       latitude, longitude, status [active/completed/paid],
                       paid_at, payout_id [FK→payouts])
work_photos          - Before/during/after work photos
                      (time_entry_id [FK→time_entries], associate_id,
                       photo_url, photo_type [before/progress/after], caption)
paypal_config        - PayPal API credentials (single row, id=1)
                      (client_id, client_secret, sandbox_client_id, sandbox_client_secret,
                       webhook_id, sandbox_webhook_id, is_active, test_mode)
payouts              - Payout records for associate payments
                      (associate_id, person_id, amount, payment_method,
                       external_payout_id, status [pending/processing/completed/failed/returned],
                       time_entry_ids [uuid[]], created_at, completed_at)
```

### Identity Verification
```
upload_tokens        - Secure tokenized upload links for ID verification
                      (token, person_id [FK→people], app_user_id [FK→app_users],
                       purpose, expires_at, used_at)
identity_verifications - Extracted DL data from Gemini Vision API
                      (person_id, app_user_id, photo_url,
                       extracted_name, extracted_dob, extracted_dl_number,
                       extracted_address, match_status [auto_approved/flagged/rejected],
                       verified_at, reviewed_by)
```

### Vapi Voice Calling System
```
vapi_config          - Vapi API configuration (single row, id=1)
                      (api_key, phone_number_id, is_active, test_mode)
voice_assistants     - Configurable AI voice assistants
                      (name, system_prompt, model, voice, temperature,
                       tools [jsonb], is_active)
voice_calls          - Call log
                      (vapi_call_id, caller_phone, person_id [FK→people],
                       assistant_id [FK→voice_assistants], duration_seconds,
                       cost_usd, transcript [jsonb], recording_url,
                       status, created_at)
```

### Stripe Payment System
```
stripe_config       - Stripe API credentials + webhook secrets (single row, id=1)
                      (publishable_key, secret_key, sandbox_publishable_key, sandbox_secret_key,
                       webhook_secret, sandbox_webhook_secret, connect_enabled, is_active, test_mode)
stripe_payments     - Inbound payment records linked to PaymentIntents
                      (payment_type, reference_type, reference_id, amount, original_amount,
                       fee_code_used, status [pending/completed/failed/refunded],
                       stripe_payment_intent_id, stripe_charge_id, receipt_url,
                       error_message, person_id, person_name, ledger_id [FK→ledger],
                       is_test, created_at, updated_at)
payment_methods     - Display methods on pay page (Zelle, Venmo, PayPal, ACH)
                      (name, method_type, account_identifier, account_name,
                       qr_code_media_id [FK→media], display_order, is_active, instructions)
```

### Airbnb iCal Sync
```
(Uses existing spaces + assignments tables)
Key columns on spaces:
  airbnb_ical_url    - Inbound iCal feed URL from Airbnb listing
  airbnb_link        - Public Airbnb listing URL
  airbnb_rate        - Airbnb listing price
  airbnb_blocked_dates - JSONB array of blocked date ranges
```

### 3D Property Digital Twin (PostGIS-enabled)
```
parcels              - Land parcel: boundaries, legal, zoning, survey info
                      (name, address, legal_description, parcel_number, acreage, area_sqft,
                       boundary_geom [POLYGON 4326], ground_elevation_ft,
                       flood_zone, in_floodplain, houston_toad_habitat, esd_district,
                       survey_date, survey_by, survey_rpls)
parcel_edges         - Boundary edges with per-edge setback rules
                      (parcel_id [FK→parcels], edge_side [N/S/E/W], bearing, length_ft,
                       edge_geom [LINESTRING 4326], is_road_frontage, road_name,
                       road_classification, road_row_ft, has_easement, easement_type,
                       easement_width_ft, setback_required_ft, setback_label)
structures           - Every structure on property with 3D geometry
                      (parcel_id [FK→parcels], name, structure_type [enum], use_type [enum],
                       width_ft, length_ft, height_ft, stories, area_sqft, material,
                       roof_type [enum], footprint_geom [POLYGON 4326],
                       lod0_footprint [POLYGONZ 4326],
                       nearest_edge_side, nearest_edge_distance_ft,
                       setback_required_ft, setback_compliant, setback_surplus_ft,
                       permit_status [enum], is_movable, guest_capacity,
                       bedrooms, bathrooms, has_plumbing, has_electric, has_hvac,
                       photo_urls [text[]], metadata [jsonb], display_order, is_active)
structure_setbacks   - Distance from each structure to each edge (computed compliance)
                      (structure_id [FK→structures], edge_id [FK→parcel_edges],
                       measured_distance_ft, required_distance_ft,
                       is_compliant [GENERATED], surplus_ft [GENERATED],
                       UNIQUE(structure_id, edge_id))
zoning_rules         - Your County setback/coverage regulations
                      (jurisdiction, district_name, rule_source,
                       road setbacks by classification, lodging-specific rules,
                       container rules, impervious limits)
property_utilities   - Water, septic, electric, gas, fire protection
                      (parcel_id [FK→parcels], utility_type, provider, system_type,
                       location_geom [POINT 4326], availability_letter_status)
impervious_cover     - Per-structure/surface impervious area tracking
                      (parcel_id [FK→parcels], structure_id [FK→structures],
                       surface_type, area_sqft, material)
permit_applications  - Permit tracking per structure
                      (parcel_id [FK→parcels], structure_id [FK→structures],
                       permit_type, permit_number, status, estimated_cost,
                       scope_of_work, document_urls [text[]])
inspections          - Inspection sequence per permit
                      (permit_id [FK→permit_applications], inspection_type,
                       scheduled_date, completed_date, inspector_name, result)
permit_documents     - Files linked to permits
                      (permit_id [FK→permit_applications], document_type, file_url)
```

Enum types: `structure_type`, `structure_use`, `permit_status`, `roof_shape`
Extension: PostGIS 3.3 (GEOMETRY columns for spatial queries)
See `docs/CAD.md` for full schema documentation and tool compatibility matrix.

### Legacy (Deprecated - don't use for new features)
```
photos          - DEPRECATED: migrated to media (table retained for historical reference)
photo_spaces    - DEPRECATED: migrated to media_spaces
```

### Key Columns on `spaces`
- `type` - Free-form text field (e.g., "Dwelling", "Amenity", "Event")
- `is_listed` - Show in consumer view
- `is_secret` - Only accessible via direct URL with ?id=
- `can_be_dwelling` - Filter for rental listings
- `can_be_event` - Can be used for events
- `is_archived` - Soft delete (filtered out everywhere)

### Key Columns on `assignments`
- `status` - active, pending_contract, contract_sent, completed, cancelled
- `start_date`, `end_date` - Assignment period
- `desired_departure_date` - Early exit date (tenant wants to leave early)
- `desired_departure_listed` - Boolean, when true the early exit date is shown to consumers for availability

