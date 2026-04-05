# API Permissions Template Guide

When generating the `api-permissions.ts` file for a cloned project, include only the permission blocks needed for the user's enabled features.

## Feature → API Resource Mapping

| Feature | API Resources to Include |
|---------|-------------------------|
| **core** (always) | `spaces`, `people`, `assignments`, `tasks`, `users`, `profile`, `media`, `bug_reports`, `invitations`, `password_vault`, `feature_requests` |
| **vehicles** | `vehicles`, `tesla_accounts` |
| **associates** | `time_entries` |
| **events** | `events` |
| **sms** | `sms` |
| **pai** | `faq`, `pai_config` |
| **documents** | `documents` |
| **payments_stripe** | `payments` |
| **payments_square** | `payments` |

## How to Generate

1. Read `feature-manifest.json` to get enabled features
2. Start with the core resources (always included)
3. For each enabled feature, add its resources from the table above
4. Skip resources for disabled features
5. Always include the `ROLE_LEVELS`, `ApiAction`, `PermissionEntry`, and `PROFILE_EDITABLE_FIELDS` exports

## Example: Small Business (email + payments_stripe)

Include: core resources + `payments`
Skip: `vehicles`, `tesla_accounts`, `time_entries`, `events`, `sms`, `faq`, `pai_config`, `documents`

## Example: Vacation Rental (rentals + events + cameras + lighting)

Include: core resources + `events` + `documents`
Skip: `vehicles`, `tesla_accounts`, `time_entries`, `sms`, `faq`, `pai_config`

## Note on the API Gateway

The `supabase/functions/api/index.ts` edge function reads from the `PERMISSIONS` object to route requests. It doesn't need modification — it automatically handles any resources defined in the permissions matrix. Adding or removing resources from `api-permissions.ts` is all that's needed.
