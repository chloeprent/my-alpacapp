# OpenClaw: Safe Environment & Partitioned (Including Optional Resident Exposure)

You can run OpenClaw in a safer, partitioned way and still decide later whether to expose a limited version to residents. Below is a 3-column view: **approach**, **what it gives you**, and **how**.

---

## 3-column overview

| Approach | What you get | How |
|----------|--------------|-----|
| **Discord partitioning** | One bot, different permissions by channel/server — staff get full features, residents get only what you allow | Put staff in a private server/channels; put residents in a separate server or channel. Bot checks channel/server and switches to “staff mode” vs “resident mode” and limits commands in resident mode. No new infra. |
| **API partitioning** | Bot can’t do everything even if compromised; resident path only calls allowed operations | Use a **restricted Supabase key** or **only call edge functions** for resident mode (e.g. a dedicated `openclaw-resident` or `ask-question`). Staff mode keeps current anon key or a dedicated staff key. Two code paths in the bot. |
| **Process / VM partitioning** | OpenClaw isolated from other workers (Bug Scout, Feature Builder, pollers); no shared env or disk | Run OpenClaw in a **separate process** (different user + env file), or a **separate container** (Docker on same host), or a **separate small VM** ($5–6/mo). Only OpenClaw’s credentials on that process/VM. |

You can combine them: e.g. **Discord + API partitioning** (staff vs resident mode with different keys or endpoints) and optionally **process/VM partitioning** (OpenClaw on its own box).

---

## 1. Discord-side partitioning (easiest — no infra change)

- **Staff-only:** Use a private Discord server (or private channels) where only staff are members. OpenClaw in those channels uses full SKILL.md (occupancy, payments, bookings, photo uploads, record-payment).
- **Residents (optional):** Add a separate server or channel for residents. In that context the bot runs in **resident mode**: only commands you implement (e.g. “Who’s in Skyloft?”, “What spaces are available?”, FAQ). No payments, no booking creation, no PII of other residents, no photo uploads.
- **Implementation:** Bot checks `channel.id` or `guild.id` against a config list (e.g. “staff channels” vs “resident channels”) and toggles staff vs resident mode; in resident mode it only responds to a whitelist of commands and/or forwards to a single edge function (see below).

This gives you **partitioning by audience** and the option to **expose to residents later** by adding a resident server/channel and turning on resident mode there.

---

## 2. API-side partitioning (safe environment at the data layer)

- **Today:** OpenClaw uses the **anon key** and direct Supabase REST (RLS applies) and calls `record-payment` for bank notifications. So it already has broad read/write within RLS.
- **Safer options:**
  - **Resident path only via edge function:** For resident mode, don’t call Supabase directly. Have the bot call a single edge function (e.g. `openclaw-resident` or reuse `ask-question`) that:
    - Accepts the question and optional Discord channel/user id.
    - Returns only allowed data (e.g. space names, “who’s in X” with policy you define, availability, FAQ). No payments, no bookings, no raw DB.
  - **Dedicated keys:** Use a **restricted anon key** (or custom JWT) for resident mode that hits only tables/policies you’re comfortable with, and keep the current (or a staff-only) key for staff mode. Two keys in the bot, chosen by staff vs resident context.
- **record-payment:** Keep it staff-only: only call it when the request comes from a **staff** Discord context (staff server/channel). Resident mode never calls it.

So you get a **partitioned API**: staff path = current capabilities; resident path = limited, auditable, and optionally only via edge functions.

---

## 3. Process / VM partitioning (safe environment at the host)

- **Same droplet, separate process:** Run OpenClaw under a dedicated user (e.g. `openclaw`) with its own env file (only Supabase URL + key(s), Discord token). No access to Bug Scout / Feature Builder tokens or repo. Reduces blast radius if the bot is compromised.
- **Same droplet, container:** Run OpenClaw in a Docker container with only the env it needs; same idea, stronger isolation.
- **Separate VM:** Run OpenClaw on a small second VM (e.g. $6 DO or $5 Lightsail). No shared processes or env with the main droplet. Most isolated; a bit more to maintain (two boxes, updates, monitoring).

So you can run OpenClaw in a **somewhat partitioned** way (process/container) or **fully partitioned** (separate VM) while still using Discord + API partitioning for staff vs resident.

---

## 4. “Maybe expose to residents” — suggested path

| Step | Action |
|------|--------|
| 1 | **Discord partitioning:** Define staff-only server/channels; in the bot, treat those as “staff mode” and everything else (or an explicit list) as “resident mode”. |
| 2 | **Resident mode = limited:** In resident mode, only allow read-only, safe commands. Implement by either: (a) calling a single edge function (e.g. `openclaw-resident` or `ask-question`) that returns only allowed answers, or (b) using a restricted key + RLS so resident path can only read what you allow. |
| 3 | **Don’t expose resident server yet:** You can ship the bot with resident mode in code but **only invite it to the staff server**. When you’re ready, add a “Residents” server and invite the same bot; it will automatically run in resident mode there. |
| 4 | **Optional:** Move OpenClaw to a separate process/container/VM so its credentials and runtime are isolated from other workers. |

That way you get a **safe, partitioned setup** (staff vs resident, and optionally process/VM) and can **expose to residents later** by adding a Discord server/channel without changing architecture.

---

## 5. Summary table

| Goal | DigitalOcean / current | Partitioned / safe approach |
|------|-------------------------|-----------------------------|
| **Staff-only OpenClaw** | One bot, one server; uses anon key + record-payment | Same, but restrict which channels are “staff” and run bot in a separate process/VM if you want isolation. |
| **Resident-safe OpenClaw** | N/A (not exposed) | Resident server/channel → bot in “resident mode” → only edge function or restricted key; no payments, no bookings, no PII. |
| **Safe environment** | Same droplet as other workers, shared env | Separate process (own user + env), or container, or separate small VM; only OpenClaw’s credentials there. |
| **Maybe expose later** | — | Implement resident mode now; only add the bot to a resident server when you’re ready. |

If you tell me whether you prefer “same droplet, separate process” vs “separate small VM” and “resident via edge function” vs “resident via restricted key,” I can outline concrete config and code changes next (e.g. env layout, channel allowlist, and a minimal `openclaw-resident` or `ask-question` contract).
