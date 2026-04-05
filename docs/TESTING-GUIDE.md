# Testing Guide

## Test Account

| Field | Value |
|-------|-------|
| Email | `testuser@alpacaplayhouse.com` |
| Password | `test1234` |
| Role | `admin` |
| Auth User ID | `4b530cac-261e-4087-bb73-4258a8f6f91e` |
| App User ID | `bd46c13d-c579-48e2-b90b-c26742812eda` |

This account has full admin access to all admin pages, DevControl, and staff views.

### How to sign in

1. Navigate to `/login/`
2. Enter email and password above
3. Click **Sign in**
4. You'll be redirected to the page you came from (or `/spaces/admin/` by default)

### Programmatic sign-in (preview tools)

The Supabase auth session must be established through the site's own login page at `/login/`. Direct `signInWithPassword` calls from injected scripts won't persist because the page's ES-module Supabase client uses its own storage context.

**Workflow for headless preview testing:**
```
1. Navigate to /login/?redirect=/spaces/admin/devcontrol.html
2. Fill email input with testuser@alpacaplayhouse.com
3. Fill password input with test1234
4. Click the "Sign in" button
5. Wait for redirect to complete (~3s)
```

## Auth Architecture

1. **Supabase Auth** (`auth.users`) — handles email/password login, issues JWT
2. **`app_users` table** — maps `auth_user_id` to a role (`oracle`, `admin`, `staff`, `demo`, `resident`, `associate`, `public`, `prospect`)
3. **`role_permissions` + `permissions`** — fine-grained tab-level access control
4. **`initAdminPage()`** in `shared/admin-shell.js` — checks auth, resolves role, renders tab nav, redirects to `/login/` if unauthenticated

### Role hierarchy

| Role | Level | Access |
|------|-------|--------|
| `oracle` | 4 | Everything |
| `admin` | 3 | All admin + DevControl |
| `staff` | 2 | Staff tabs |
| `demo` | 2 | Staff tabs (read-only banner) |
| `resident` | 1 | Resident pages |
| `associate` | 1 | Associate pages |

### Creating a new test user

```bash
# 1. Create auth user via GoTrue Admin API (needs service_role key)
curl -X POST "https://aphrrfprbixmhissnjfn.supabase.co/auth/v1/admin/users" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"newuser@example.com","password":"password123","email_confirm":true}'

# 2. Create app_users record (via Management API)
# Use the auth_user_id from step 1
INSERT INTO app_users (auth_user_id, email, display_name, role)
VALUES ('<auth-user-id>', 'newuser@example.com', 'New User', 'staff');
```

> **Important:** Do NOT insert directly into `auth.users` — use the GoTrue Admin API. Direct SQL inserts cause "Database error querying schema" on login.

## Testing Admin Pages

All admin pages live under `/spaces/admin/`. Each page calls `initAdminPage()` which:
- Checks for an active Supabase session
- Looks up the user's `app_users` record and role
- Redirects to `/login/` if unauthenticated
- Shows "unauthorized" overlay if role is insufficient

### Key admin pages

| Page | Hash/Tab | Required Role |
|------|----------|---------------|
| DevControl | `devcontrol.html#overview` | admin |
| Backups | `devcontrol.html#backups` | admin |
| Releases | `devcontrol.html#releases` | admin |
| Spaces | `spaces.html` | staff |
| Users | `users.html` | staff |
| Inventory | `inventory.html` | staff |
