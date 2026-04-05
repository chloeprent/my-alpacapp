# Lighting Automation — Alpaca Playhouse

> Reference for all smart light devices, control commands, entity names, and backends.
> For HAOS setup, SSH access, and non-lighting devices see `devdocs/HOMEAUTOMATION.md`.
> **Per-bulb inventory lives in Supabase** (`lighting_devices`, `lighting_groups`, `lighting_group_targets`) — query DB for current state.

---

## How to Run Commands

Three ways to control lights, from simplest to lowest-level:

### 1. `lights.sh` — Human-friendly CLI (recommended)

On Alpuca or via SSH. No entity IDs needed.

```bash
# On Alpuca directly
~/lights.sh kitchen,living red
~/lights.sh all off
~/lights.sh skyloft 2700k 50%

# From another LAN machine
ssh paca@192.168.1.200 "~/lights.sh kitchen,living red"
```

**Rooms:** `kitchen`, `kitchen-nook`, `living`, `skyloft`, `skyloft-bath`, `master-bath`, `stairs`, `cabin`, `nook`, `facade`, `sauna`, `cabins-fence`, `garage`, `garage-ceiling`, `garage-dj`, `garage-dj-strip`, `garage-opener`, `outhouse`, `cedar`, `fishbowl`, `tea-lounge`, `spartan`, `all`
**Colors:** `red`, `green`, `blue`, `purple`, `magenta`, `pink`, `cyan`, `orange`, `amber`, `white`, `daylight`, `soft`, `warm`, `on`, `off`, `NNNNk` (e.g. `2700k`), or `#RRGGBB` hex
**Brightness:** Optional percentage, e.g. `50%`. Default is 100%.

### 2. Light API — HTTP endpoint (for cloud, mobile apps, edge functions)

Public URL via Cloudflare Tunnel. Works from anywhere — cloud services, mobile apps, PAI agent.

- **URL:** `https://lights.alpacaplayhouse.com`
- **Auth:** Bearer token (stored in Bitwarden: "Light API — Alpuca")
- **LAN URL:** `http://192.168.1.200:8100` (no tunnel, faster)

```bash
# Control lights
curl -X POST https://lights.alpacaplayhouse.com/lights \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"rooms":"kitchen,living","color":"red","brightness":"50%"}'

# Health check (no auth)
curl https://lights.alpacaplayhouse.com/health

# List rooms/colors (auth required)
curl -H "Authorization: Bearer <token>" https://lights.alpacaplayhouse.com/lights/rooms
curl -H "Authorization: Bearer <token>" https://lights.alpacaplayhouse.com/lights/colors
```

**Response:** `{"status":"ok","rooms":"kitchen,living","color":"red","brightness":"50%"}`

**Service:** Python HTTP server at `~/light-api/server.py` on Alpuca, port 8100.
**LaunchAgent:** `com.alpacapps.light-api` (auto-start, keep-alive).
**Token file:** `~/light-api/.token` on Alpuca.
**Logs:** `/tmp/light-api.log`, `/tmp/light-api.err`

### 3. `ha-cmd.sh` — Raw HAOS service calls (low-level)

For entity-level control when `lights.sh` doesn't cover it (e.g. individual bulbs, non-light entities).

```bash
~/ha-cmd.sh 'light/turn_off' '{"entity_id":"light.living_room_lights"}'
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.kitchen_lights","color_temp_kelvin":4000,"brightness":255}'
```

Uses a long-lived HAOS API token (expires 2036). Token in `devdocs/HOMEAUTOMATION.md` §1.

### Access matrix

| Caller | Use | Latency |
|--------|-----|---------|
| Claude Code (LAN) | `ssh paca@... "~/lights.sh ..."` | ~0.7s |
| Claude Desktop (Alpuca) | `~/lights.sh ...` | ~0.5s |
| PAI agent / edge functions | `POST https://lights.alpacaplayhouse.com/lights` | ~0.7s |
| Mobile apps | Same HTTP API | ~0.7s |
| Hostinger workers | Same HTTP API | ~0.7s |
| Alexa | Native HA Alexa integration (separate) | varies |

**DB query for current inventory:**
```sql
SELECT room, device_name, ha_entity_id, device_brand, protocol
FROM lighting_devices WHERE is_active ORDER BY room, socket_number;
```

### Database Schema

Three tables in Supabase track all lighting state. Query via Management API (see Step 6 in the checklist below).

**`lighting_devices`** — one row per physical bulb/strip

| Column | Type | Required | Notes |
|--------|------|----------|-------|
| `id` | uuid | auto | PK, `gen_random_uuid()` |
| `device_name` | text | **yes** | Human name, e.g. "Dining Room Light 5" |
| `room` | text | **yes** | Room name, e.g. "Dining Room" |
| `socket_label` | text | no | Physical socket label if applicable |
| `socket_number` | int | no | Position in room (for ordering) |
| `ha_entity_id` | text | no | HAOS entity, e.g. `light.smart_rgbtw_bulb_17` |
| `device_brand` | text | no | e.g. "OREIN", "WiZ", "Govee" |
| `device_model` | text | no | e.g. "Smart RGBTW Bulb", "H601F" |
| `protocol` | text | no | "Matter", "WiZ", "Govee Cloud", "Tuya", "LocalTuya" |
| `matter_support` | bool | default false | True if Matter-capable |
| `mac_address` | text | no | e.g. "A8:BB:50:81:51:AF" |
| `ip_address` | text | no | LAN IP (WiZ bulbs have static IPs) |
| `local_key` | text | no | Tuya local key (for LocalTuya) |
| `cloud_device_id` | text | no | Govee/Tuya cloud device ID |
| `sku` | text | no | Product SKU |
| `form_factor` | text | no | "A19", "BR30", "GU10", "LED Bar", "LED Strip" |
| `matter_setup_code` | text | no | Matter pairing code from bulb label |
| `matter_qr_url` | text | no | QR code URL for Matter commissioning |
| `space_id` | uuid | no | FK to `spaces` table |
| `ai_control` | bool | default false | **true** = reachable via HAOS/API; **false** = cloud-only or unreachable |
| `notes` | text | no | **Unlimited length.** Put ALL extra info here: commissioning date, physical socket location, firmware quirks, Alexa group membership, wiring notes, anything an LLM or future-you needs to know. |
| `is_active` | bool | default true | Set false to soft-delete |
| `created_at` | timestamptz | auto | |
| `updated_at` | timestamptz | auto | |

**`lighting_groups`** — one row per logical group (maps to HAOS groups, Govee groups, or `lights.sh` room keys)

| Column | Type | Required | Notes |
|--------|------|----------|-------|
| `id` | uuid | auto | PK |
| `key` | text | **yes** | Machine key, e.g. "dining_room", "garage" |
| `name` | text | **yes** | Display name, e.g. "Dining Room" |
| `area` | text | no | Building area, e.g. "Main House", "Spartan" |
| `display_order` | int | default 0 | Sort order in UI |
| `space_id` | uuid | no | FK to `spaces` table |
| `notes` | text | no | |
| `is_active` | bool | default true | |

**`lighting_group_targets`** — junction table linking groups to their backend targets

| Column | Type | Required | Notes |
|--------|------|----------|-------|
| `id` | uuid | auto | PK |
| `group_id` | uuid | **yes** | FK to `lighting_groups.id` |
| `backend` | text | **yes** | "haos", "govee", "wiz", "tuya" |
| `target_id` | text | **yes** | Entity/device ID for that backend |
| `mac_address` | text | no | MAC of target device |
| `metadata` | jsonb | default {} | Backend-specific config |
| `is_active` | bool | default true | |

---

## Room Command Reference

> All commands below use `~/ha-cmd.sh` directly (assumes running on Alpuca).
> From another machine, wrap with: `ssh -o StrictHostKeyChecking=no paca@192.168.1.200 "~/ha-cmd.sh '...' '{...}'"` (escape inner quotes).
> **Prefer `~/lights.sh` or the HTTP API** for standard room+color control.

### Living Room

**Entities:** `light.living_room_lights` (4 WiZ ceiling + 1 WiZ Printer Nook + 2 Pequeno Nook), `light.livingroom_strip_light` (Govee LED strip)

Individual WiZ: `light.wiz_rgbw_tunable_81d231` (#1), `_816330` (#2), `_8206c2` (#3), `_819eee` (#4), `_81ab69` (Printer Nook)
Pequeno Nook: `light.smart_rgbtw_bulb_15` (Pequeno Nook Light 1), `light.smart_rgbtw_bulb_16` (Pequeno Nook Light 2)

```bash
# Soft white
~/ha-cmd.sh 'light/turn_on' '{"entity_id":["light.living_room_lights","light.livingroom_strip_light"],"color_temp_kelvin":2700,"brightness":200}'

# RGB color (warm amber)
~/ha-cmd.sh 'light/turn_on' '{"entity_id":["light.living_room_lights","light.livingroom_strip_light"],"rgb_color":[255,147,41],"brightness":200}'

# Off
~/ha-cmd.sh 'light/turn_off' '{"entity_id":["light.living_room_lights","light.livingroom_strip_light"]}'
```

---

### Master Bathroom

**Entity:** `light.master_bathroom_lights` (5 OREIN Matter bulbs)

```bash
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.master_bathroom_lights","color_temp_kelvin":3000,"brightness":180}'
~/ha-cmd.sh 'light/turn_off' '{"entity_id":"light.master_bathroom_lights"}'
```

Individual: `light.smart_rgbtw_bulb` (Tub), `_2` (Shower), `_3` (Frig), `_4` (Closet), `_5` (Toilet)

---

### Skyloft Ceiling

**Entity:** `light.skyloft_ceiling` (6 WiZ BR30 Color bulbs)

```bash
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.skyloft_ceiling","color_temp_kelvin":3000,"brightness":200}'
~/ha-cmd.sh 'light/turn_off' '{"entity_id":"light.skyloft_ceiling"}'
```

Individual bulbs (numbered by physical socket position):

| Pos | Entity | Friendly Name | IP | MAC |
|-----|--------|---------------|-----|-----|
| 1 | `light.wiz_rgbww_tunable_08d7cb` | Skyloft Ceiling 1 | .104 | a8bb5008d7cb |
| 2 | `light.wiz_rgbww_tunable_08d763` | Skyloft Ceiling 2 | .251 | a8bb5008d763 |
| 3 | `light.wiz_rgbww_tunable_09ffc8` | Skyloft Ceiling 3 | .34 | a8bb5009ffc8 |
| 4 | `light.wiz_rgbww_tunable_09b70b` | Skyloft Ceiling 4 | .245 | a8bb5009b70b |
| 5 | `light.wiz_rgbw_tunable_8175e4` | Skyloft Ceiling 5 | .92 | a8bb508175e4 |
| 6 | `light.wiz_rgbww_tunable_0a6817` | Skyloft Ceiling 6 | .58 | a8bb500a6817 |

> Note: Bulb 5 is RGBW (not RGBWW) — slightly different WiZ model than the other 5.

---

### Skyloft Bathroom

**Entity:** `light.skyloft_bathroom` (2 OREIN Matter RGBTW bulbs)

```bash
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.skyloft_bathroom","color_temp_kelvin":3000,"brightness":200}'
~/ha-cmd.sh 'light/turn_off' '{"entity_id":"light.skyloft_bathroom"}'
```

Individual: `light.smart_rgbtw_bulb_11` (Left), `light.smart_rgbtw_bulb_10` (Right)

---

### Skyloft Bar

**Entity:** `light.skyloft_bar` (3 Tuya/SmartLife GU10 spotlights via LocalTuya)

```bash
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.skyloft_bar","color_temp_kelvin":3000,"brightness":200}'
~/ha-cmd.sh 'light/turn_off' '{"entity_id":"light.skyloft_bar"}'
```

Individual: `light.skyloft_bar_light_1` (Left), `light.skyloft_bar_light_2` (Middle), `light.skyloft_bar_light_3` (Right)

| Pos | Device ID | Local Key | MAC | LAN IP |
|-----|-----------|-----------|-----|--------|
| L | `ebf88bedf1475f7186vj9p` | `WgoX04Glqf43cW^2` | `18:de:50:5f:66:90` | .162 |
| M | `eb7c2e2652329ff6cfuzvd` | `SP!'9GC5[aYY3)~t` | `18:de:50:5f:67:4c` | .211 |
| R | `eb0a46324e9dd058fcc0ez` | `.dz~?/yR6R2W85j8` | `38:a5:c9:7c:3c:de` | .22 |

Brand: Lightinginside LED-GU10-SM. Protocol: Tuya WiFi v3.3 (SmartLife app).

> **Status (2026-03-28):** LocalTuya port 6668 closed even when lights are on — currently unavailable in HAOS. Controllable via SmartLife app / Tuya Cloud API.

---

### Skyloft — All Lights

**Entity:** `light.skyloft_lights` (all 11 Skyloft lights — ceiling + bathroom + bar)

```bash
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.skyloft_lights","color_temp_kelvin":3000,"brightness":200}'
~/ha-cmd.sh 'light/turn_off' '{"entity_id":"light.skyloft_lights"}'
```

---

### Kitchen

**Entity:** `light.kitchen_lights` (5 WiZ + 1 Leedarson Matter + 4 Govee BR30 H6013)

Individual Govee BR30s: `light.kitchen_ceiling_5`, `light.kitchen_ceiling_6`, `light.kitchen_ceiling_7`, `light.kitchen_ceiling_8`

```bash
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.kitchen_lights","color_temp_kelvin":4000,"brightness":255}'
~/ha-cmd.sh 'light/turn_off' '{"entity_id":"light.kitchen_lights"}'
```

---

### Kitchen Nook

**Entities:** `light.smart_rgbtw_bulb_12` (Kitchen Nook 1), `light.smart_rgbtw_bulb_13` (Kitchen Nook 2), `light.smart_rgbtw_bulb_14` (Kitchen Nook 3) — 3 Linkind Matter RGBTW bulbs

```bash
# All 3 nook bulbs
~/ha-cmd.sh 'light/turn_on' '{"entity_id":["light.smart_rgbtw_bulb_12","light.smart_rgbtw_bulb_13","light.smart_rgbtw_bulb_14"],"color_temp_kelvin":3000,"brightness":200}'
~/ha-cmd.sh 'light/turn_off' '{"entity_id":["light.smart_rgbtw_bulb_12","light.smart_rgbtw_bulb_13","light.smart_rgbtw_bulb_14"]}'

# Or use lights.sh
~/lights.sh kitchen-nook warm 80%
```

---

### Garage Mahal

**Entities:** `light.garage_all` (all 16 Govee H601F bars), `light.garage_ceiling` (12 ceiling bars), `light.garage_dj` (4 DJ booth bars)

```bash
# All 16 bars
~/lights.sh garage red
~/lights.sh garage off

# Sub-groups
~/lights.sh garage-ceiling blue 80%
~/lights.sh garage-dj purple

# Opener lights (separate)
~/lights.sh garage-opener on
```

**Layout (4 rows × 4 columns, numbered left-to-right, front-to-back):**

| Pos | Physical Name | Govee Name | HAOS Entity | MAC |
|-----|--------------|------------|-------------|-----|
| 1 | Garage Ceiling 1 | Garage Mahal 12 | `light.garage_mahal_12` | 32:EF:DC:B4:D9:5A:07:7C |
| 2 | Garage Ceiling 2 | Garage Mahal 11 | `light.garage_mahal_11` | 8C:4B:DC:B4:D9:5A:06:C8 |
| 3 | Garage Ceiling 3 | Garage Mahal 10 | `light.garage_mahal_10` | 18:EB:DC:06:75:48:DC:98 |
| 4 | Garage Ceiling 4 | Garage Mahal 13 | `light.garage_mahal_13` | 1C:90:DC:06:75:4D:C1:E8 |
| 5 | Garage Ceiling 5 | Garage Mahal 3 | `light.garage_mahal_3` | 26:E2:DC:B4:D9:58:39:5C |
| 6 | Garage Ceiling 6 | Garage Mahal 5 | `light.garage_mahal_5` | 2B:D0:DC:B4:D9:58:3A:C8 |
| 7 | Garage Ceiling 7 | Garage Mahal 2 | `light.garage_mahal_2` | 0C:EC:DC:B4:D9:59:46:E8 |
| 8 | Garage Ceiling 8 | Garage Mahal 4 | `light.garage_mahal_4` | 7F:85:98:88:E0:FB:90:F0 |
| 9 | Garage Ceiling 9 | Garage Mahal 8 | `light.garage_mahal_8` | 0E:46:DC:B4:D9:58:24:2C |
| 10 | Garage Ceiling 10 | Garage Mahal 6 | `light.garage_mahal_6` | C1:61:DC:B4:D9:58:1A:88 |
| 11 | Garage Ceiling 11 | Garage Mahal 1 | `light.garage_mahal_1` | 2A:D4:DC:B4:D9:58:3A:8C |
| 12 | Garage Ceiling 12 | Garage Mahal 7 | `light.garage_mahal_7` | 16:45:DC:B4:D9:58:48:28 |
| DJ1 | Garage DJ 1 | Garage Mahal 9 | `light.garage_mahal_9` | D9:83:DC:B4:D9:56:91:24 |
| DJ2 | Garage DJ 2 | Garage Mahal R3 | `light.garage_mahal_r3` | 1D:28:DC:B4:D9:56:8D:EC |
| DJ3 | Garage DJ 3 | Garage Mahal R2 | `light.garage_mahal_r2` | 79:A5:DC:B4:D9:5A:12:14 |
| DJ4 | Garage DJ 4 | Garage Mahal R1 | `light.garage_mahal_r1` | E9:59:DC:B4:D9:59:42:50 |

**Opener lights:** `light.garage_opener_1`, `light.garage_opener_2` (separate from bars, already in HAOS)

> All 16 bars are Govee H601F (7-segment RGBIC). Controlled via HAOS Govee integration (not cloud API) for reliable group control.

---

### Outhouse

**Entities:** `light.outhouse_all` (all 7 Govee H601F bars), `light.outhouse_ceiling` (5: 4 main + changing room), `light.outhouse_stalls` (2 stall bars)

```bash
# All 7 bars
~/lights.sh outhouse red
~/lights.sh outhouse off

# Sub-groups (via ha-cmd.sh)
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.outhouse_ceiling","rgb_color":[0,0,255],"brightness":200}'
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.outhouse_stalls","rgb_color":[255,0,255],"brightness":200}'
```

**Layout:**

| Pos | Physical Name | Govee Name | HAOS Entity | MAC |
|-----|--------------|------------|-------------|-----|
| 1 | Outhouse Main 1 | outhousemain1 | `light.outhousemain1` | 73:E5:DC:B4:D9:4D:29:88 |
| 2 | Outhouse Main 2 | outhousemain2 | `light.outhousemain2` | 12:DC:DC:B4:D9:4C:A4:84 |
| 3 | Outhouse Main 3 | outhousemain3 | `light.outhousemain3` | 13:BC:DC:B4:D9:4D:47:D4 |
| 4 | Outhouse Main 4 | outhousemain4 | `light.outhousemain4` | 43:F2:DC:B4:D9:4D:1C:DC |
| C | Outhouse Changing | outhouse changing | `light.outhouse_changing` | — |
| S-L | Outhouse Stall Left | outhouse stall left | `light.outhouse_stall_left` | 4B:F5:DC:B4:D9:59:28:10 |
| S-R | Outhouse Stall Right | outhouse stall right | `light.outhouse_stall_right` | 1E:D4:DC:B4:D9:5A:11:34 |

**Sink lights:** `light.outhouse_sink_lights` (group), `light.h600b` (Sink Left), `light.h600b_2` (Sink Right) — 2 Govee H600B strip lights

```bash
# Sink lights — soft white
~/ha-cmd.sh 'light/turn_on' '{"entity_id":["light.h600b","light.h600b_2"],"color_temp_kelvin":2700,"brightness":255}'
```

> All 7 bars are Govee H601F (7-segment RGBIC). Sink lights are Govee H600B. All controlled via HAOS Govee integration (not cloud API).

---

### Spartan Trailer

Three spaces with 12 Govee H601F bars total, plus 2 strip lights and 2 porch lights.

**Entities:**
- `light.spartan_all` (12 bars + roof strip = 13 entities)
- `light.spartan_tea_lounge` (6 bars — Tea Lounge / main living area)
- `light.spartan_fishbowl` (2 bars — Fishbowl / small bedroom)
- `light.spartan_cedar_chamber` (4 bars — Cedar Chamber / big bedroom)

```bash
# All 12 bars
~/lights.sh spartan red
~/lights.sh spartan off

# Individual rooms
~/lights.sh tea-lounge warm 80%
~/lights.sh fishbowl blue
~/lights.sh cedar purple 80%

# Sub-groups (via ha-cmd.sh)
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.spartan_tea_lounge","rgb_color":[255,180,100],"brightness":200}'
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.spartan_cedar_chamber","rgb_color":[128,0,255],"brightness":200}'
```

**Layout:**

| Space | Pos | Govee Name | HAOS Entity |
|-------|-----|-----------|-------------|
| Tea Lounge | 1 | Spartan Main 1 | `light.spartan_main_1` |
| Tea Lounge | 2 | Spartan Main 2 | `light.spartan_main_2` |
| Tea Lounge | 3 | Spartan Main 3 | `light.spartan_main_3` |
| Tea Lounge | 4 | Spartan Main 4 | `light.spartan_main_4` |
| Tea Lounge | 5 | Spartan Main 5 | `light.spartan_main_5` |
| Tea Lounge | 6 | Spartan Main 6 | `light.spartan_main_6` |
| Fishbowl | 1 | Spartan Lilbed 1 | `light.spartan_lilbed_1` |
| Fishbowl | 2 | Spartan Lilbed 2 | `light.spartan_lilbed_2` |
| Cedar Chamber | 1 | Spartan Bigbed 1 | `light.spartan_bigbed_1` |
| Cedar Chamber | 2 | Spartan Bigbed 2 | `light.spartan_bigbed_2` |
| Cedar Chamber | 3 | Spartan Bigbed 3 | `light.spartan_bigbed_3` |
| Cedar Chamber | 4 | Spartan Bigbed 4 | `light.spartan_bigbed_4` |

**Strip lights** (roof is in spartan_all group; wall controlled separately):
- `light.spartan_roof` — 15-segment RGBIC strip (roof) — in `spartan_all` group
- `light.spartan_updown_wall` — 15-segment RGBIC strip (wall)

**Porch lights** (controlled separately, not in room groups):
- `light.spartan_porch_right` — 15-segment RGBIC strip
- `light.spartan_porch_left` — 15-segment RGBIC strip (pending WiFi pairing)

> All 12 bars are Govee H601F (7-segment RGBIC). Strip/porch lights are Govee H6061. All controlled via HAOS Govee integration (not cloud API).

---

### Stairs

**Entity:** `light.stairs_lights` (2 Linkind Matter bulbs)

```bash
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.stairs_lights","color_temp_kelvin":3000,"brightness":200}'
~/ha-cmd.sh 'light/turn_off' '{"entity_id":"light.stairs_lights"}'
```

Individual: `light.smart_rgbtw_bulb_6` (Top), `light.smart_rgbtw_bulb_7` (Bottom)

---

### Garage Mahal

**HAOS groups:** `light.garage_all` (all garage lights), `light.garage_ceiling` (ceiling bars), `light.garage_dj` (DJ area bars)

**Garage DJ Strip:** Enbrighten Vibe Neon Rope Light 24ft (model 58088, Tuya protocol v3.4)
- HAOS entity: `light.garage_dj_strip` (LocalTuya — currently unavailable due to QEMU VM networking)
- **Control via lights.sh** (bypasses HAOS, uses tinytuya directly):
  - Tuya device ID: `eb6d4495b4b05cfde8dnf3`
  - IP: `192.168.1.105`, MAC: `10:5a:17:c6:2d:d5`
  - 15 RGB segments (DP104), brightness (DP106), power (DP20)
- Web UI: controlled via `light_api` backend in `home-assistant-control` edge function

```bash
# Via lights.sh
~/lights.sh garage-dj-strip red
~/lights.sh garage-dj-strip "#FF00FF" 50%
~/lights.sh garage-dj-strip off

# Via Light API
curl -X POST https://lights.alpacaplayhouse.com/lights \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"rooms":"garage-dj-strip","color":"purple","brightness":"60%"}'

# Garage opener lights (2 individual Govee bars)
~/lights.sh garage-opener red
```

**lights.sh rooms:** `garage` / `garage-mahal` (all), `garage-ceiling` / `gc`, `garage-dj` / `gdj`, `garage-dj-strip` / `gstrip` / `dj-strip`, `garage-opener` / `gopener`

---

### Other Lights

| Room | Entity | Type |
|------|--------|------|
| Cabin 1 | `light.cabin_1` | TP-Link KL135 |
| Nook | `light.nook` | TP-Link HS220 dimmer |
| Stair Landing | `switch.stair_landing` | TP-Link HS210 |

```bash
~/ha-cmd.sh 'light/turn_on' '{"entity_id":"light.nook","brightness":150}'
~/ha-cmd.sh 'switch/turn_on' '{"entity_id":"switch.stair_landing"}'
```

---

## Quick Entity Cheat Sheet

| Room | Entity | Turn off |
|------|--------|----------|
| Living Room | `light.living_room_lights` | `~/ha-cmd.sh 'light/turn_off' '{"entity_id":"light.living_room_lights"}'` |
| Living Strip | `light.livingroom_strip_light` | same pattern |
| Master Bath | `light.master_bathroom_lights` | same pattern |
| Skyloft All | `light.skyloft_lights` | same pattern |
| Skyloft Ceil | `light.skyloft_ceiling` | same pattern |
| Skyloft Bath | `light.skyloft_bathroom` | same pattern |
| Skyloft Bar | `light.skyloft_bar` | same pattern |
| Kitchen | `light.kitchen_lights` | same pattern |
| Kitchen Nook | `light.smart_rgbtw_bulb_12`, `_13`, `_14` | use array |
| Stairs | `light.stairs_lights` | same pattern |
| Cabin 1 | `light.cabin_1` | same pattern |
| Nook | `light.nook` | same pattern |
| Garage All | `light.garage_all` | `~/lights.sh garage off` |
| Garage Ceiling | `light.garage_ceiling` | `~/lights.sh garage-ceiling off` |
| Garage DJ | `light.garage_dj` | `~/lights.sh garage-dj off` |
| Garage Opener | `light.garage_opener_1`, `_2` | `~/lights.sh garage-opener off` |
| Outhouse All | `light.outhouse_all` | `~/lights.sh outhouse off` |
| Outhouse Ceiling | `light.outhouse_ceiling` | same pattern |
| Outhouse Stalls | `light.outhouse_stalls` | same pattern |
| Spartan All | `light.spartan_all` | `~/lights.sh spartan off` |
| Tea Lounge | `light.spartan_tea_lounge` | `~/lights.sh tea-lounge off` |
| Fishbowl | `light.spartan_fishbowl` | `~/lights.sh fishbowl off` |
| Cedar Chamber | `light.spartan_cedar_chamber` | `~/lights.sh cedar off` |
| Stair Landing | `switch.stair_landing` | use `switch/turn_off` |
| Facade Lights | `light.facade_lights` (3x Tuya flood) | `~/lights.sh facade off` |
| Sauna Lights | `light.sauna_lights` (2x Tuya flood) | `~/lights.sh sauna off` |
| Cabins Fence | `light.cabins_fence` (Tuya string) | `~/lights.sh cabins-fence off` |
| Garage DJ Strip | `light.garage_dj_strip` (Tuya) | `~/lights.sh garage-dj-strip off` |

---

## Color Reference

### Color temperature (use `color_temp_kelvin`)

| Kelvin | Name |
|--------|------|
| 2200 | Candlelight |
| 2700 | Soft white |
| 3000 | Warm white |
| 4000 | Neutral white |
| 5000 | Bright white |
| 6500 | Daylight |

### Common RGB values (use `rgb_color: [R, G, B]`)

| Color | RGB |
|-------|-----|
| Warm amber | [255, 147, 41] |
| Red | [255, 0, 0] |
| Green | [0, 255, 0] |
| Blue | [0, 0, 255] |
| Purple | [128, 0, 255] |
| Pink | [255, 105, 180] |
| Cyan | [0, 255, 255] |

`brightness`: 0-255. Both `color_temp_kelvin` and `rgb_color` turn the light on if off.

---

## Device Inventory by Backend

### HAOS (via `~/ha-cmd.sh` on Alpuca)

| Room | Entity | Bulbs | Brand |
|------|--------|-------|-------|
| Living Room | `light.living_room_lights` | 4 WiZ ceiling + 1 WiZ nook + 2 Pequeno Nook | WiZ/Matter |
| Living Room strip | `light.livingroom_strip_light` | 15-segment LED | Govee |
| Master Bathroom | `light.master_bathroom_lights` | 5 | OREIN Matter |
| Skyloft All | `light.skyloft_lights` | 11 (6+2+3) | WiZ/OREIN/Tuya |
| Skyloft Ceiling | `light.skyloft_ceiling` | 6 | WiZ BR30 Color |
| Skyloft Bathroom | `light.skyloft_bathroom` | 2 | OREIN Matter |
| Skyloft Bar | `light.skyloft_bar` | 3 (unavailable) | Tuya GU10 (LocalTuya) |
| Kitchen | `light.kitchen_lights` | 5 WiZ + 1 Matter + 4 Govee BR30 | WiZ/Leedarson/Govee |
| Kitchen Nook | `light.smart_rgbtw_bulb_12`, `_13`, `_14` | 3 | Linkind Matter |
| Stairs | `light.stairs_lights` | 2 | Linkind Matter |
| Cabin 1 | `light.cabin_1` | 1 | TP-Link KL135 |
| Nook | `light.nook` | 1 | TP-Link HS220 |
| Garage All | `light.garage_all` | 16 | Govee H601F (via HACS) |
| Garage Ceiling | `light.garage_ceiling` | 12 | Govee H601F (via HACS) |
| Garage DJ | `light.garage_dj` | 4 | Govee H601F (via HACS) |
| Garage Opener | `light.garage_opener_1`, `_2` | 2 | (already provisioned) |
| Outhouse All | `light.outhouse_all` | 7 | Govee H601F (via HACS) |
| Outhouse Ceiling | `light.outhouse_ceiling` | 5 | Govee H601F (via HACS) |
| Outhouse Stalls | `light.outhouse_stalls` | 2 | Govee H601F (via HACS) |
| Spartan All | `light.spartan_all` | 13 | Govee H601F + roof strip (via HACS) |
| Spartan Tea Lounge | `light.spartan_tea_lounge` | 6 | Govee H601F (via HACS) |
| Spartan Fishbowl | `light.spartan_fishbowl` | 2 | Govee H601F (via HACS) |
| Spartan Cedar Chamber | `light.spartan_cedar_chamber` | 4 | Govee H601F (via HACS) |
| Stair Landing | `switch.stair_landing` | - | TP-Link HS210 |
| Facade Lights | `light.facade_lights` | 3 (Facade 1/2/3) | Tuya flood (LocalTuya v3.3) |
| Sauna Lights | `light.sauna_lights` | 2 (Sauna Left/Right) | Tuya flood (LocalTuya v3.3) |
| Cabins Fence | `light.cabins_fence` | 1 (string lights) | Tuya string (LocalTuya v3.3) |
| Garage DJ Strip | `light.garage_dj_strip` | 1 (24ft neon rope, 15 segments) | Enbrighten (Jasco) 58088 / Tuya v3.4 |
| Dining Room | `light.dining_room_lights` | 2 (OREIN _17, _18) + 4 Tuya/SmartLife | OREIN Matter / Tuya |
| Garage Opener | `light.garage_opener_lights` | 2 (OREIN _19, _20) | OREIN Matter |
| Outhouse Porch | `light.outhouse_porch_lights` | 2 (OREIN _21, _22) | OREIN Matter |
| Outhouse Sink | `light.outhouse_sink_lights` | 2 (Govee H600B) | Govee Matter |
| Outhouse All | `light.outhouse_lights` | 4 (2 porch + 2 sink) | OREIN/Govee |

### Tuya Local (via `~/lights.sh` on Alpuca — tinytuya)

LocalTuya HAOS entities are unavailable (QEMU VM networking limitation). Controlled via `lights.sh` → `tuya-light.sh` → tinytuya directly from host.

| Room | Device | Tuya ID | IP | DPs |
|------|--------|---------|----|-----|
| Garage DJ Strip | Enbrighten Vibe Neon 24ft | `eb6d4495b4b05cfde8dnf3` | 192.168.1.105 | DP20 power, DP104 color (15 segs), DP106 brightness |

### WiZ Proxy — DEPRECATED

All WiZ bulbs are now in HAOS. Do not use the WiZ Proxy for new control.

### Govee (~63 devices — cloud API via `lights.sh` + HTTP API)

Controlled via Govee cloud API. Groups accessible through `lights.sh`, HTTP API, and `home-assistant-control` edge function.

> **Garage Mahal**, **Outhouse**, and **Spartan** (Cedar, Fishbowl, Tea Lounge) moved to HAOS (via Govee HACS integration) for reliable group control. `lights.sh` routes all through HAOS.

| Area | Room key | Backend | Count | Types |
|------|----------|---------|-------|-------|
| Garage Mahal | `garage` | HAOS (Govee integration) | 16 H601F | Light bars — see Garage Mahal section |
| Outhouse | `outhouse` | HAOS (Govee integration) | 7 H601F | Light bars — see Outhouse section |
| Spartan Cedar | `cedar` | HAOS (Govee integration) | 4 H601F | Light bars — see Spartan section |
| Spartan Fishbowl | `fishbowl` | HAOS (Govee integration) | 2 H601F | Light bars — see Spartan section |
| Spartan Lounge | `tea-lounge` | HAOS (Govee integration) | 6 H601F | Light bars — see Spartan section |
| Outdoor | — | Govee Cloud | 12 | String lights, fence, floods, pathway |
| Interior | — | Govee Cloud | 5 | LED strips, star projector |

**Govee CLI examples:**
```bash
~/lights.sh garage red
~/lights.sh outhouse blue 50%
~/lights.sh spartan purple          # all 3 Spartan rooms
~/lights.sh cedar,fishbowl off
```

**Govee API key:** stored at `~/.govee-api-key` on Alpuca and in `govee_config` table (id=1).

**Alexa:** Enable the **Govee Home** Alexa skill. Groups from the Govee app (Garage Mahal, Outhouse, etc.) will appear as Alexa devices.

### Tuya/SmartLife (~32 devices — mixed LocalTuya + cloud)

Devices in HAOS via LocalTuya (LAN, v3.3):

| Device | Entity ID | IP | Tuya ID |
|--------|-----------|-----|---------|
| Facade 1 | `light.facade_1` | 192.168.1.49 | `ebe0b2b6fe9780ac6ejwdm` |
| Facade 2 | `light.facade_2` | 192.168.1.198 | `eba4b07cc7b3a42b15zxnl` |
| Facade 3 | `light.facade_3` | 192.168.1.187 | `eb6f01e655c19e10ebyfq4` |
| Sauna Right | `light.sauna_right` | 192.168.1.69 | `eb5675c98829e89548zvya` |
| Sauna Left | `light.sauna_left` | 192.168.1.208 | `eb6db4252afdfae0c2ehlz` |
| Cabins Fence | `light.cabins_fence` | 192.168.1.11 | `eb95d4ef003750afbckg9w` |
| Skyloft Bar 1-3 | `light.skyloft_bar_light_1/2/3` | varies | see Skyloft section |

Remaining devices (SmartLife app / Tuya Cloud API only, not yet in HAOS):
- Outdoor floods (Spa, Gate, Pond, Spartan, Grill), string lights, dining bulbs

**Tuya Cloud credentials:** Access ID `c9rxjqkkc3wevmpm394c` · Secret `69a76a01c1b543ab93cd5ffdc13d9e95` · Data Center: Western America

---

## Alexa Voice Control

### How it works

HAOS → Nabu Casa (Home Assistant Cloud) → Amazon Alexa Smart Home Skill

All `light` entities in HAOS are automatically exposed to Alexa via Nabu Casa. No per-entity configuration needed.

- **Nabu Casa account:** active (trial subscription)
- **Alexa enabled:** `true` (in `.storage/cloud` on HAOS)
- **Remote URL:** `7nwydzudzhis82jcmf1mfzezaaw3hvgu.ui.nabu.casa`

### Voice commands

| Command | What it does |
|---------|-------------|
| "Alexa, turn on Skyloft Lights" | All 11 Skyloft lights (ceiling + bathroom + bar) |
| "Alexa, turn on Skyloft Ceiling" | 6 ceiling WiZ bulbs |
| "Alexa, turn on Skyloft Bathroom" | 2 bathroom OREIN bulbs |
| "Alexa, set Skyloft Ceiling to 50%" | Dim ceiling to 50% |
| "Alexa, turn Skyloft Lights red" | Set all Skyloft lights to red |
| "Alexa, turn on lights" | Controls lights in the Echo's assigned room |

### Room-aware control ("Alexa, turn on lights")

When an Echo device and lights are in the same Alexa room, "Alexa, turn on lights" (no room name) controls just that room's lights from that specific Echo.

**Setup in Alexa app:**
1. Discover devices: say "Alexa, discover devices" (or Alexa app → Devices → + → scan)
2. Create room: Devices → + → Add Room → name it (e.g., "Skyloft")
3. Add the Echo device in that room to the Alexa room
4. Add the light groups (e.g., "Skyloft Ceiling", "Skyloft Bathroom") to that room
5. Now "Alexa, turn on lights" from that Echo = only that room's lights

### Adding new HAOS lights to Alexa

1. Add the light entity to HAOS (via integration or configuration.yaml group)
2. Say "Alexa, discover devices" — Nabu Casa auto-exposes all `light` entities
3. Assign the new device to the correct Alexa room

### Govee lights on Alexa

Govee devices use the **Govee Home** Alexa skill (separate from HAOS/Nabu Casa).

1. Install "Govee Home" skill in Alexa app
2. Link Govee account (same credentials as Govee app)
3. Say "Alexa, discover devices" — all Govee groups appear (Garage Mahal, Outhouse, Cedar Chamber, Fishbowl, Spartan Tea Lounge)
4. Assign each to the correct Alexa room

| Voice command | What it does |
|--------------|-------------|
| "Alexa, turn on Garage Mahal" | All 16 light bars on |
| "Alexa, turn Outhouse red" | 6 light bars → red |
| "Alexa, set Garage Mahal to 50%" | Dim to 50% |
| "Alexa, turn off Cedar Chamber" | Cedar Chamber off |

---

## How to Add a New Light — Full Checklist

> **For LLM use:** Follow every step in order. Each step includes the exact commands. Skip steps only where noted.

### Step 1: Commission the bulb

**Matter/OREIN bulbs:** Open the HA iOS app → Settings → Devices → Add Device → Matter → scan the QR code on the bulb (power it on first — it enters pairing mode for ~3 seconds after factory reset). The bulb appears as `light.smart_rgbtw_bulb_N` where N auto-increments.

**Govee bulbs:** Add via Govee Home app first, then HAOS discovers via Govee integration. They appear as `light.h600b`, `light.h600b_2`, etc.

**WiZ bulbs:** Auto-discovered by HAOS WiZ integration if on the same subnet. No manual commissioning needed.

### Step 2: Identify the new entity ID

Poll the HAOS API for new entities:

```bash
# From Alpuca (192.168.1.200)
TOKEN=$(grep 'TOKEN=' ~/ha-cmd.sh | head -1 | cut -d'"' -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://192.168.1.39:8123/api/states | \
  python3 -c "import sys,json; [print(e['entity_id'],e['attributes'].get('friendly_name','')) for e in json.load(sys.stdin) if e['entity_id'].startswith('light.') and 'smart_rgbtw' in e['entity_id']]"
```

Or check the HA iOS app → Settings → Devices for the new entry.

### Step 3: Rename the entity in HAOS

**CRITICAL:** You must stop HA core before editing the entity registry — otherwise HA overwrites your changes from memory on restart.

```bash
# SSH to HAOS
sshpass -p "playhouse" ssh root@192.168.1.39

# Stop HA core (prevents overwrite)
ha core stop

# Download entity registry
cat /config/.storage/core.entity_registry > /tmp/entity_reg.json

# Edit with python3 — example: rename smart_rgbtw_bulb_17 → "Dining Room Light 5"
python3 -c "
import json
with open('/tmp/entity_reg.json') as f: data = json.load(f)
for e in data['data']['entities']:
    if e['entity_id'] == 'light.smart_rgbtw_bulb_17':
        e['name'] = 'Dining Room Light 5'
        e['original_name'] = 'Dining Room Light 5'
with open('/tmp/entity_reg.json','w') as f: json.dump(data, f)
"

# Upload edited registry
cat /tmp/entity_reg.json > /config/.storage/core.entity_registry

# Start HA core
ha core start
```

### Step 4: Create or update a HAOS group

Edit `/config/configuration.yaml` on HAOS to add the bulb to an existing group or create a new one:

```yaml
# Under the existing light: section
light:
  # ... existing groups ...
  - platform: group
    name: "Room Name Lights"
    unique_id: room_name_lights
    entities:
      - light.smart_rgbtw_bulb_17
      - light.smart_rgbtw_bulb_18
```

After editing, reload config: `ha core restart` (or call `configuration.reload` via API).

### Step 5: Hide junk entities from Alexa (if needed)

Govee devices expose 7 segment entities each. Hide them in `/config/.storage/cloud`:

```bash
# On HAOS
python3 -c "
import json
with open('/config/.storage/cloud') as f: data = json.load(f)
cfg = data['data']['alexa_entity_configs']
# Hide segment entities
for entity_id in ['light.h600b_segment_1', 'light.h600b_segment_2']:  # etc
    cfg[entity_id] = {'should_expose': False}
with open('/config/.storage/cloud','w') as f: json.dump(data, f)
"
ha core restart
```

### Step 6: Insert into Supabase `lighting_devices`

```sql
INSERT INTO lighting_devices (
  device_name, ha_entity_id, room, protocol, device_brand, device_model,
  form_factor, mac_address, ip_address, ai_control, matter_support, notes
) VALUES (
  'Dining Room Light 5',           -- device_name (required)
  'light.smart_rgbtw_bulb_17',     -- ha_entity_id
  'Dining Room',                   -- room (required)
  'Matter',                        -- protocol
  'OREIN',                         -- device_brand
  'Smart RGBTW Bulb',              -- device_model
  'A19',                           -- form_factor
  NULL,                            -- mac_address (if known)
  NULL,                            -- ip_address (WiZ bulbs have static IPs)
  true,                            -- ai_control: true = reachable via HAOS/API
  true,                            -- matter_support
  'Commissioned 2026-03-29 via HA iOS Matter. Socket is left of entry door.'
  -- notes: put ALL extra info here — arbitrary length text field.
  -- Include: commissioning date, physical location detail, quirks,
  -- Alexa group membership, firmware issues, anything future-you needs.
);
```

Run via Management API:
```bash
export BW_SESSION=$(~/bin/bw-unlock)
MGMT_TOKEN=$(bw list items --search "Supabase — AlpacApps Project" 2>/dev/null | python3 -c "import sys,json; [print(f['value']) for i in json.load(sys.stdin) if 'AlpacApps' in i['name'] for f in i.get('fields',[]) if 'Management' in f['name']]")
curl -s -X POST \
  -H "Authorization: Bearer $MGMT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"INSERT INTO lighting_devices ..."}' \
  "https://api.supabase.com/v1/projects/aphrrfprbixmhissnjfn/database/query"
```

### Step 7: Add to `lighting_groups` / `lighting_group_targets` (if new group)

```sql
-- Create the group
INSERT INTO lighting_groups (group_name, room, protocol, notes)
VALUES ('dining_room', 'Dining Room', 'HAOS Group', 'OREIN Matter bulbs 17+18');

-- Link devices to group (use device IDs from lighting_devices)
INSERT INTO lighting_group_targets (group_id, device_id)
SELECT g.id, d.id
FROM lighting_groups g, lighting_devices d
WHERE g.group_name = 'dining_room'
  AND d.entity_id IN ('light.smart_rgbtw_bulb_17', 'light.smart_rgbtw_bulb_18');
```

### Step 8: Expose to Alexa

1. Say **"Alexa, discover devices"** (or Alexa app → Devices → + → scan)
2. In Alexa app, assign the new device/group to the correct room
3. Test: "Alexa, turn on [device name]"

**Note:** Matter bulbs via HAOS → Nabu Casa → Alexa have 10-20s lag. Govee/Tuya cloud-to-cloud is faster.

### Step 9: Verify with test color

```bash
# Via lights.sh
ssh paca@192.168.1.200 "~/lights.sh dining red"

# Or via HAOS API
TOKEN=$(grep 'TOKEN=' ~/ha-cmd.sh | head -1 | cut -d'"' -f2)
curl -X POST http://192.168.1.39:8123/api/services/light/turn_on \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"light.smart_rgbtw_bulb_17","rgb_color":[255,0,0]}'
```

### Step 10: Update this document

Add the new room/device to the relevant sections above:
- Room table (entity IDs, protocols)
- Alexa voice commands table
- `lights.sh` room list (if a new room alias was added)

### Quick-add checklist (copy-paste)

```
[ ] Bulb commissioned in HA (entity ID: ___)
[ ] Entity renamed in registry (stop→edit→start)
[ ] Added to configuration.yaml group
[ ] Junk entities hidden from Alexa (if Govee)
[ ] Inserted into lighting_devices table
[ ] Group created/updated in lighting_groups
[ ] Alexa discovered + assigned to room
[ ] Test color verified
[ ] LIGHTINGAUTOMATION.md updated
```

---

## Troubleshooting

**WiZ bulbs not discovering in HAOS:**
- Bulbs use UDP broadcast on port 38899
- HAOS VM must be on same subnet (bridged networking)
- `nmap -sU -p 38899 192.168.1.0/24` to find them

**OREIN/Matter bulbs blocked (new commissioning):**
- After factory reset, bulbs enter pairing mode for only 2-3s before reconnecting to AiDot cloud
- Fix: block MACs from internet via UDM, factory reset, commission via HA Matter add-on

**SSH to Alpuca not working:**
- Key auth: `ssh paca@192.168.1.200` (preferred, tested working)
- If key auth fails, check `~/.ssh/authorized_keys` on Alpuca

---

## Planned / Future

- Fix Skyloft Bar GU10 LocalTuya connection — port 6668 stays closed. May need Tuya Cloud integration instead of LocalTuya
- Add `tuya_cloud` backend to `home-assistant-control` edge function
- HACS Govee LAN integration — local control without cloud (fallback for API outages)
- Set up Alexa rooms for all areas (Kitchen, Living Room, Master Bathroom, Stairs, Skyloft, Garage Mahal)
- Add outdoor Govee groups (string lights, fence, floods) to `lights.sh` once needed
- ~~Migrate Spartan (Cedar, Fishbowl, Tea Lounge) to HAOS Govee integration~~ ✅ Done 2026-03-29
