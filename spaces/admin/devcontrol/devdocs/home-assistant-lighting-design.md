# Home Assistant Unified Lighting Design

## Goal

Use Home Assistant (HA) as the single control plane for all lighting so residents and PAI can control lights without vendor apps (WiZ, Linkind, Govee Home, Alexa app).

Scope includes:
- WiZ bulbs (existing kitchen/living/master groups)
- Matter bulbs (Linkind + Govee Matter + other Matter lights)
- Existing non-Matter Govee devices (via HA integrations where possible, or temporary fallback path)

---

## Current State (as of 2026-03-27)

### Implemented
- **HAOS is live** on Alpuca (192.168.1.200), running at `192.168.1.39:8123`. All WiZ, OREIN Matter, Leedarson Matter, and TP-Link lights are controllable via HAOS.
- **WiZ Proxy is deprecated** — all WiZ bulbs now in HAOS. `scripts/wiz-proxy/server.js` remains but is no longer the control path.
- **DB tables live**: `lighting_devices` (per-bulb inventory), `lighting_groups` (room groups), `lighting_group_targets` (backend mappings). Seeded with all known rooms. `lighting_devices` has per-bulb HA entity IDs, MAC addresses, brands.
- `govee-control` edge function still controls Govee (~63 devices) via cloud API — not yet in HAOS.
- Tuya/SmartLife (~32 devices) still cloud-only via SmartLife app — not yet in HAOS.
- Current command path: SSH to Alpuca → `~/ha-cmd.sh` → HAOS REST API. See `devdocs/LIGHTINGAUTOMATION.md`.

### Not yet implemented
- No `home-assistant-control` edge function — app/PAI cannot call HA without SSH.
- No unified resident lighting UI — `residents/lighting.js` still Govee-only.
- Govee and Tuya devices not yet in HAOS (cloud-only).
- `shared/services/unified-lighting-data.js` not yet created.
- PAI still uses direct vendor tool paths, not a unified group-based tool.

---

## Recommended Architecture (Best Model)

### Control model

Use a **Room-Oriented Entity Model**:
- Product layer controls rooms/groups (Kitchen, Living Room, Master Pasture).
- Integration layer resolves each room to one or more HA entities.
- Adapter layer translates commands into HA service calls.

This is the best fit because user intent is room-first, not device-ID-first.

### System model

1. **Home Assistant as Source of Truth**
   - HA owns devices, entities, groups/scenes, and Matter commissioning.
   - App stops doing direct vendor device discovery over time.

2. **Supabase as Policy + UX Index**
   - Keep auth, role checks, and app-facing metadata in Supabase.
   - Store a lightweight mapping of app room/group -> HA entity IDs.

3. **Edge Function as Secure HA Gateway**
   - Add `home-assistant-control` edge function.
   - Frontend/PAI call edge function, never HA directly.
   - Function enforces permissions and logs command events.

4. **Fallback adapters during migration**
   - WiZ path can remain via `wiz-proxy` while HA entities are being validated.
   - Existing `govee-control` can remain for non-Matter Govee until moved to HA.

---

## Data Design

## Tables (all exist in Supabase as of 2026-03-27)

### `lighting_devices` ✅ live
Per-bulb inventory: `device_name`, `room`, `ha_entity_id`, `device_brand`, `device_model`, `protocol`, `mac_address`, `ip_address`, `matter_setup_code`, `matter_qr_url`, `is_active`.

### `lighting_groups` ✅ live
Room groups: `key` (`kitchen`, `living_room`, etc.), `name`, `area`, `display_order`, `space_id`, `is_active`.

### `lighting_group_targets` ✅ live
- `group_id` fk → `lighting_groups`
- `backend` text: `home_assistant` | `govee_cloud` | `tuya_cloud` | `wiz_proxy` (deprecated)
- `target_id` (HA entity ID, Govee group ID, Tuya device ID)
- `metadata` jsonb, `mac_address`, `is_active`

### `home_assistant_entities` — not yet created
Optional entity cache table — still in future scope.

### Legacy tables (keep during transition)
- `alexa_room_targets` — not canonical; `lighting_groups` supersedes it
- `govee_devices` — still used by `govee-control` edge fn; migrate to `lighting_devices` eventually

---

## Edge Function Design

## `home-assistant-control`

Actions:
- `list_entities`
- `get_group_state`
- `set_power`
- `set_brightness`
- `set_color`
- `activate_scene`

Request shape:
- `{ action, groupKey?, entityIds?, payload? }`

Behavior:
1. Authenticate user and enforce `control_lighting`.
2. Resolve `groupKey` to one or more targets from `lighting_group_targets`.
3. For `home_assistant` targets:
   - call HA REST API service endpoints (`/api/services/light/turn_on`, `/turn_off`, etc.).
4. For fallback targets:
   - route to existing adapters (`wiz-proxy`, `govee-control`) until migrated.
5. Return normalized state payload to frontend.

Secrets:
- `HA_BASE_URL`
- `HA_TOKEN`
- Optional: `HA_TIMEOUT_MS`, `HA_VERIFY_TLS`

---

## Frontend Design

1. Introduce provider-agnostic lighting data service:
   - `shared/services/unified-lighting-data.js`
2. Render by logical groups (`lighting_groups`) not vendor tables.
3. Keep current card controls (power, brightness, color, scenes).
4. Add status badges for partial backend failures (ex: 5/6 targets succeeded).

Migration approach:
- Keep existing `residents/lighting.js` UI shell.
- Swap data source + control API progressively.

---

## PAI Design

Update PAI lighting tools to call unified group controls:
- Preferred tool: `control_lights` with room/group names.
- Backend resolves to `home-assistant-control`.
- During transition, backend fan-outs to fallback adapters where needed.

This keeps PAI prompt/API stable while infrastructure changes underneath.

---

## Rollout Plan

### Phase 0: Discovery + mapping ✅ DONE
- HAOS live, all rooms mapped to HA entities.
- `lighting_devices`, `lighting_groups`, `lighting_group_targets` tables created and seeded.

### Phase 1: Backend gateway — IN PROGRESS
- `home-assistant-control` edge function **not yet built**.
- Current workaround: SSH to Alpuca → `ha-cmd.sh` directly.
- Next: implement edge function with `set_power`, `set_brightness`, `set_color`, `activate_scene`.
- Add command audit logging.

### Phase 2: Room abstraction ✅ DONE
- `lighting_groups` + `lighting_group_targets` created and seeded.
- Backends: `home_assistant`, `govee_cloud`, `tuya_cloud` (wiz_proxy deprecated).

### Phase 3: Resident UI migration — TODO
- Move `residents/lighting.js` from Govee-only to `unified-lighting-data.js`.
- Render by `lighting_groups` not vendor tables.
- Add partial-failure status badges.

### Phase 4: PAI migration — TODO
- Add unified `control_lights` tool pointing to `home-assistant-control` edge fn.
- Retire per-vendor PAI tool paths.

### Phase 5: Decommission old paths — TODO
- Remove WiZ Proxy (`scripts/wiz-proxy/`) once edge fn is stable.
- Migrate `govee_devices` references to `lighting_devices`.
- Evaluate whether `alexa-room-control` is still needed.

---

## Risks and Mitigations

- **Entity churn in HA** (renamed `entity_id`s): use stable group keys + sync tooling.
- **Partial room failures**: return per-target results; UI shows degraded success.
- **Matter commissioning overhead**: stage by room; do not block WiZ/Govee controls.
- **Latency/timeouts**: apply retry/backoff and command timeout envelopes in edge function.

---

## Success Criteria

- Resident can control every room light from one page without vendor apps.
- PAI can control all room lights with a single tool path.
- Kitchen controls both WiZ and Linkind/Matter from one group action.
- No direct vendor app dependency for routine operations.
