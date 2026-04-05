# Alexa Master Pasture Lighting Skill

This adds a custom Alexa skill backend using Supabase edge function
`alexa-room-control` to control Master Pasture lights.

## What this does

- Adds intents for:
  - turn lights on
  - turn lights off
  - set brightness
- Routes those intents to existing `govee-control` for actual light control.
- Uses `ALEXA_MASTER_PASTURE_GROUP_IDS` (comma-separated Govee group IDs) as
  the room mapping.
- Supports DB-backed room/device mapping:
  - `alexa_room_targets` = per-room targets (WiZ IPs, Govee group IDs)
  - `alexa_device_room_map` = Alexa `deviceId` to `room_key`

## Limitations

- Custom skills require invocation (for example:
  `Alexa, ask Alpaca Home to turn master pasture lights on`).
- This does **not** replace Alexa's built-in room default-light mapping.

To mimic "turn lights on" with no invocation, create an Alexa Routine bound to
the specific Echo device and have it run a custom command that invokes this
skill.

## Deploy

```bash
supabase functions deploy alexa-room-control --no-verify-jwt
```

## Required secrets

Set these in Supabase project secrets:

- `ALEXA_SKILL_ID` = your Alexa skill ID (optional but recommended)
- `ALEXA_MASTER_PASTURE_GROUP_IDS` = comma-separated Govee group IDs
  (example: `12345678,87654321`)
- `ALEXA_MASTER_PASTURE_WIZ_IPS` = comma-separated WiZ bulb IPs for Master
  Pasture (if using WiZ instead of Govee)
- `WIZ_PROXY_URL` = HTTPS URL to WiZ proxy (for example
  `https://alpaclaw.cloud/wiz`)
- `WIZ_PROXY_TOKEN` = bearer token shared by `alexa-room-control` and proxy

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` already exist for edge functions.

## Alexa developer console setup

1. Create a **Custom** skill.
2. Invocation name: `pai bot` (or your preferred name).
3. Create intents from `integrations/alexa/master-pasture-interaction-model.json`.
4. Endpoint type: HTTPS
   - URL:
     `https://aphrrfprbixmhissnjfn.supabase.co/functions/v1/alexa-room-control`
5. Build model and test in Alexa simulator.

## Testing utterances

- "ask pai bot to turn master pasture lights on"
- "ask pai bot to turn master pasture lights off"
- "ask pai bot to set master pasture lights to 30 percent"

## Notes for this pilot

- Current implementation only targets Master Pasture aliases.
- Control path priority:
  1. DB room target (`alexa_room_targets`) for selected room
  2. Legacy env fallback for `master_pasture`
- Expand by adding additional room mappings in the function and configuring
  per-room group IDs.

## Mapping tables (recommended)

Create and seed targets:

```sql
insert into public.alexa_room_targets
  (room_key, room_name, wiz_ips, govee_group_ids, is_active)
values
  ('master_pasture', 'Master Pasture Bedroom', array['192.168.1.132','192.168.1.128','192.168.1.55','192.168.1.169'], '{}', true)
on conflict (room_key) do update
set room_name = excluded.room_name,
    wiz_ips = excluded.wiz_ips,
    govee_group_ids = excluded.govee_group_ids,
    is_active = excluded.is_active,
    updated_at = now();
```

Map an Echo device to that room:

```sql
insert into public.alexa_device_room_map
  (alexa_device_id, room_key, is_active)
values
  ('YOUR_ALEXA_DEVICE_ID', 'master_pasture', true)
on conflict (alexa_device_id) do update
set room_key = excluded.room_key,
    is_active = excluded.is_active,
    updated_at = now();
```

With that mapping in place, users can say generic phrases like "turn the lights on"
from that Echo and the backend can resolve the room by `deviceId`.

## WiZ proxy deployment (new)

File: `scripts/wiz-proxy/server.js`

Run on a host that can reach the WiZ LAN bulbs:

```bash
export PORT=8910
export WIZ_PROXY_TOKEN='replace-with-strong-token'
node scripts/wiz-proxy/server.js
```

Expose routes:
- `POST /group/power` with `{ ips: string[], on: boolean }`
- `POST /group/brightness` with `{ ips: string[], brightness: number }`
