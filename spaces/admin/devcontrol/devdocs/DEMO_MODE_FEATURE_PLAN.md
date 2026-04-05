# Demo Mode Feature Plan

**Goal:** Let invited users experience AlpacaApps in a **demo** role: they see all non-sensitive screens and features (cameras, Tesla cars, lighting, etc.) but cannot modify anything except their own profile. Sensitive data is **redacted** with plausible fake data and a visible “demo” style (bold, boxy font; every 3rd–5th character replaced with a black box) so it’s obvious the data is not real.

**Version:** v260210.88 9:00a

---

## 1. Role: Demo (optional display name “Demon”)

- **Role value:** `demo` (DB and code).
- **Display label:** “Demo” or “Demon” in UI and invite copy.
- **Placement in hierarchy:** Below staff; can see resident + admin-style **views** but with read-only + redaction rules.

### 1.1 Capabilities

| Capability | Demo user |
|------------|-----------|
| See resident area (cameras, climate, lighting, sonos, laundry, cars, profile, PAI) | ✅ Full access (real data where non-sensitive) |
| See admin dashboard tabs (Spaces, Rentals, Events, Media, SMS, Hours, FAQ, Voice, Todo, Users, Settings, etc.) | ✅ **View only** – same layout, redacted data |
| Modify anything (spaces, rentals, users, settings, etc.) | ❌ No |
| Modify own profile (display name, avatar, bio, privacy) | ✅ Yes |
| Ask PAI questions in chat | ✅ Yes |
| Camera feeds | ✅ Real (non-sensitive) |
| Tesla car status / lock-unlock | ✅ Real (or redacted if you later decide car ownership is sensitive) |
| View directory / people profiles | ✅ With redaction (see below) |
| View accounting, payments, payouts, W9, identity docs | ✅ Redacted only (or hide entire sections – TBD) |

### 1.2 What we redact (narrow scope)

**Redact / substitute:** Names, **$ amounts**, **passwords**, **codes** (access codes, API keys, tokens, etc.). These get plausible fakes + character mask so it’s obvious they’re not real.

**Leave as-is:** Most other items (emails, phones, addresses, dates, labels, space names, etc.) stay real unless there is a **clear downside** to exposing them. When in doubt, don’t redact.

- **Names:** Display names, first/last, applicant names → redact.
- **$ amounts:** Any money (rent, payouts, ledger, fees) → redact.
- **Passwords / codes:** Never show; use “••••••” or redacted placeholder.
- **Non-sensitive (show real):** Camera streams, thermostat, Tesla state, space names, UI layout, emails/phones if no clear downside, etc.

---

## 2. Redaction UX

- **Plausible fake data:** Names → “Jane Doe” (+ mask); $ amounts → “$1,234.56” (+ mask); passwords/codes → “••••••”.
- **Visual “this is demo” treatment:**
  - **Bold, boxy font** (e.g. `font-weight: 700`, monospace or rounded sans, distinct from normal body font).
  - **Character masking:** Every 3rd to 5th character (configurable) replaced by a **black box** (e.g. `▇` or small solid block) so the string looks partially redacted even when fake.
- **Consistent styling:** One CSS class (e.g. `.demo-redacted`) used everywhere so you can tune the look in one place.
- **Optional:** Small “Demo data” or “Not real” badge/tooltip near redacted blocks.

Example:

- Real: `Rahul Sonnad`  
- Demo: **R▇h▇l S▇n▇a▇** (fake name + black boxes every 3rd character, bold/boxy font).

---

## 3. Invitation flow

- **Invite role:** Add `demon` to the invite dropdown in **Users** admin (`spaces/admin/users.html` + `users.js`).
- **DB:** Allow `demon` in `app_users.role` and `user_invitations.role` (migration to extend role check).
- **Email:** Reuse existing staff-invitation flow; add `demon` to role label/description so the email says they’re invited as a “Demo” (or “Demon”) user and will see the product with demo data where sensitive.
- **Sign-up:** Same as today: invitee signs in with the invited email → `handleAuthChange` in `auth.js` finds pending invitation and creates `app_users` with `role: 'demon'`.

---

## 4. Implementation areas (checklist)

### 4.1 Auth & role

- [x] **Migration:** Extend `app_users.role` and `user_invitations.role` checks to include `'demon'` (and `'oracle'`/`'public'` if not already).
- [x] **auth.js:** Include `'demon'` in cached role list and in any role-based redirects so demo users get the same shell as residents + staff (resident shell + context switcher to admin).
- [x] **Permissions:** Define `role_permissions` for `demo`: grant **view-only** permissions for all admin tabs (view_spaces, view_rentals, view_events, view_media, view_sms, view_hours, view_faq, view_voice, view_todo, view_users, view_settings, view_templates, view_accounting, etc.) and resident tabs; **no** edit permissions (no edit_spaces, edit_rentals, etc.).
- [ ] **RLS / Edge functions:** Where today you check `role IN ('admin','staff')` for write access, keep writes for admin/staff only; demo never gets write. For read, allow demo where staff can read, but optionally have edge functions return redacted payloads for demo (or rely on client-side redaction only – see below).

### 4.2 Shell & navigation

- [x] **admin-shell.js:** Demo users see all the same tabs as staff (or a subset you choose) but every admin page runs in "demo mode" (read-only UI + redaction).
- [x] **resident-shell.js:** Demo already has resident permissions; ensure they see resident tabs and can use PAI.
- [x] **Context switcher:** Show "Resident" and "Admin" (or "Dashboard") for demo; no "Staff" actions, only view.

### 4.3 Redaction

- [x] **Shared redaction helper:** e.g. `shared/demo-redact.js`:
  - `isDemoUser()` (from auth state).
  - `redactString(value, type?)` → returns plausible fake + applies character-mask pattern (every 3rd–5th char → black box).
  - `redactObject(obj, schema)` for common shapes (person, payment, assignment, etc.) so each page doesn’t reimplement.
- [x] **CSS:** `.demo-redacted` (bold, boxy font, optional border/background so it looks intentionally fake).
- [x] **Per-page:** On every admin (and optionally directory) page, when `isDemoUser()`:
  - Replace sensitive fields in the data with `redactString` / `redactObject` before rendering.
  - Disable all create/update/delete buttons or hide them.
  - Optionally show a slim banner: “You’re viewing the app in demo mode. Sensitive data is replaced with sample data.”

### 4.4 Pages: what to redact (names, $ amounts, passwords, codes only)

- **Directory:** Names → redact; roles/structure real. Emails, phones, etc. stay unless clear downside.
- **Admin – Users:** Names → redact; roles and structure real.
- **Admin – Rentals:** Applicant names, $ amounts → redact.
- **Admin – Events:** Organizer names, $ amounts → redact.
- **Admin – Spaces:** Access codes only → redact; space names/structure stay.
- **Admin – Media:** Only redact if captions contain names/$; otherwise leave as-is.
- **Admin – SMS:** Optional: redact only if clear downside; otherwise leave as-is.
- **Admin – Hours / Work tracking:** Names, $ amounts → redact.
- **Admin – Accounting:** $ amounts, payer/payee names → redact.
- **Admin – Settings / Templates:** Passwords, API keys, secrets → hide (••••••).
- **Admin – Voice / FAQ:** Redact only if clear downside (e.g. caller names).
- **Resident – Profile:** Demo can edit own profile; when viewing others (e.g. directory), redact names only.

### 4.5 Invite UI & email

- [x] **users.html:** Add `<option value="demo">Demo (view product with sample data)</option>` (or "Demon" if you prefer).
- [x] **users.js:** Include `demo` in `roleDescriptions` and `roleLabels` for invite modal and copy.
- [ ] **send-email (staff_invitation):** Map `demo` to a friendly label and short description (e.g. "demo access – explore the product with sample data where sensitive").

### 4.6 PAI / Chat

- [ ] **alpaca-pai:** Demo users can send messages and get answers; avoid including real PII in context for demo users (e.g. strip or redact person names/emails from tool results when caller is demo).
- [x] **pai-widget:** No change needed beyond auth; demo user already "resident+" for chat.

### 4.7 Optional: RLS redaction

- [ ] For maximum safety, you could add a Postgres role or view that returns redacted columns when the requesting user is `demo`. That’s more work and may be overkill if client-side redaction is sufficient for your risk tolerance.

---

## 5. Rollout order (suggested)

1. **Migration + auth:** Add `demo` role, permissions (view-only), invite dropdown + email copy.
2. **Redaction helper + CSS:** `shared/demo-redact.js` + `.demo-redacted`, and “Demo mode” banner in shell.
3. **Admin shell:** Demo sees all tabs, all buttons disabled or hidden for write actions.
4. **Page-by-page redaction:** Start with Users, Rentals, Accounting, Directory (highest sensitivity), then Spaces, Events, Media, SMS, Hours, Settings, Voice, FAQ.
5. **PAI:** Redact or omit PII in context for demo users.
6. **Polish:** “Demon” label in one place if you want the pun, and a short in-app “What is demo mode?” link.

---

## 6. Edge cases & notes

- **Demo user and “current resident”:** Demo users don’t need `is_current_resident`; they’re not real tenants. Don’t show them resident-only actions (e.g. certain PAI tools) if those assume a real assignment.
- **Logout / re-invite:** If you revoke a demo invite, they’re just a public user after next login unless you add a “demo expired” path.
- **Mobile app:** Same rules: if the app uses the same auth and shells, treat demo the same (view + redact, no writes except own profile).
- **Character mask pattern:** “Every 3rd to 5th” can be implemented as a fixed step (e.g. every 4th) or random in that range; document the choice so it’s consistent.

---

## 7. Summary

| Item | Action |
|------|--------|
| New role | `demo` (display: “Demo” or “Demon”) |
| Permissions | All view_* for resident + admin; no edit_* |
| Redact | **Names**, **$ amounts**, **passwords**, **codes** only; most other data stays as-is |
| Invite | Add demo to Users invite dropdown + email copy |
| Writes | Only own profile; everything else read-only |
| PAI | Allowed; strip/redact names and amounts in context for demo users |

This plan gives you a **demo link** in the form of “invite someone as demo”: they get the email, sign in, and see the full product with clear, non-real data wherever it’s sensitive.
