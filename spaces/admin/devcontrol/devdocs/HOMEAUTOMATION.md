# Home Automation — Alpaca Playhouse

> Comprehensive reference for all smart home devices, Home Assistant setup, and migration plans.
> Last updated: 2026-03-30
>
> **Lighting?** All lighting control commands, entity names, room groups, Tuya/Govee/WiZ credentials, and troubleshooting live in **`LIGHTINGAUTOMATION.md`**. Per-bulb inventory (IPs, MACs, sockets) is in Supabase tables: `lighting_devices`, `lighting_groups`, `lighting_group_targets`, `home_assistant_entities`.
>
> **Machine specs & hardware inventory:** See [Admin Inventory](../../inventory.html) → Devices → "Computers & Kiosks" for full queried specs (chip, RAM, storage, serial, IPs) for Alpuca, AlpineMac, Entry Tablet, and dev MacBook.

---

## Architecture Overview

```
                    ┌─────────────────────────────────────┐
                    │       Home Assistant OS 17.1         │
                    │     http://192.168.1.39:8123         │
                    │  (QEMU VM on Alpuca Mac Mini M4)     │
                    └───┬────┬────┬────┬────┬────┬────┬───┘
                        │    │    │    │    │    │    │
              ┌─────────┘    │    │    │    │    │    └─────────┐
              ▼              ▼    │    ▼    │    ▼              ▼
         WiZ Bulbs      Sonos │  Cast  │  TP-Link      Music Assistant
         (16/26)      (9 speakers)    │        │       (192.168.1.200:8095)
                              │       │        │
                         ┌────┘       │        └────┐
                         ▼            ▼             ▼
                    WiiM Speaker   HP Printer    LinkPlay
                    (Spartan)     (IPP)          (Spartan)
```

**Not yet integrated** (need HACS or credentials):
- Govee lights (non-garage, ~41 devices) — needs HACS + Govee LAN/Cloud
- Nest thermostats (3) — needs Google Device Access API

> **Important:** All lighting group configurations MUST be recorded in `configuration.yaml` on HAOS (`/config/configuration.yaml`). Groups created via `group.set` service calls are non-persistent and will be lost on HAOS restart. Use `light` platform groups with `unique_id` for persistence. See `LIGHTINGAUTOMATION.md` for current groups. SSH access: `sshpass -p "playhouse" ssh root@192.168.1.39`
- LG washer — needs HACS SmartThinQ
- Tesla vehicles (5) — needs HACS Tesla Custom
- UniFi Protect cameras (8) — needs API key from UDM
- VIZIO TV — needs physical PIN from TV screen
- OREIN/AiDot Matter bulbs (5) — blocked, see notes

---

## 0. Alpuca SSH Access

**Machine:** Alpuca — Mac mini M4, `192.168.1.200`, user `alpuca`

### Key-based SSH (preferred)

The `~/.ssh/id_ed25519` key (comment: `claude-dev-machine`) is already in Alpuca's `authorized_keys`.

```bash
ssh alpuca@192.168.1.200
```

No password, no sshpass needed.

### Adding a new machine's key

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub alpuca@192.168.1.200
# or manually:
ssh alpuca@192.168.1.200 "echo 'YOUR_PUBKEY' >> ~/.ssh/authorized_keys"
```

### Password auth fallback (if no key available)

Password is in Bitwarden → `"Alpuca — Primary Home Server (Mac mini M4)"`:

```bash
sshpass -p "$(bw get password 'Alpuca — Primary Home Server (Mac mini M4)')" \
  ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no alpuca@192.168.1.200
```

### Quick wrapper (`~/bin/alpuca` on your local Mac)

```bash
alpuca ssh                    # Interactive shell on Alpuca
alpuca monitor-off            # Sleep display
alpuca monitor-on             # Wake display
alpuca mb-off                 # Master bathroom lights off
alpuca mb-on [brightness]     # Master bathroom lights on (0–255)
alpuca ha <endpoint> '<json>' # Raw Home Assistant service call
```

### Screen Sharing / VNC

**Use RealVNC Viewer** (free) — not macOS Screen Sharing.app. macOS Screen Sharing forces ARD mode (always prompts for username+password via a SecureToken-gated path). RealVNC Viewer uses standard VNC protocol which reads the VNC-only password.

- Connect to: `192.168.1.200`
- Password: `alpaca` (no username field)

---

## 1. Home Assistant OS — VM Setup

### Current Host: Alpuca (Mac Mini M4)

| Setting | Value |
|---------|-------|
| **HAOS Version** | 17.1 |
| **VM IP** | `192.168.1.39` (bridged on en1 via vmnet) |
| **Web UI** | http://192.168.1.39:8123 |
| **Login** | `alpacaadmin` / `playhouse` |
| **Host Machine** | Alpuca — Mac mini M4 (Apple Silicon), 24 GB RAM |
| **Host IP** | `192.168.1.200` |
| **Host SSH** | `ssh alpuca@192.168.1.200` (key auth — see §0 below) |
| **Hypervisor** | Raw QEMU with `vmnet-bridged` on en1 (NOT UTM — UTM can't do bridged networking in QEMU mode) |
| **Start Script** | `sudo ~/homeassistant-vm/start-ha.sh` |
| **Auto-start** | LaunchDaemon at `/Library/LaunchDaemons/com.alpacapps.homeassistant-vm.plist` |
| **Migrated from** | Rahul M4 Airtop (2026-03-25) |
| **API Token (long-lived)** | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIxN2FlNmMyNTdhYWY0NGMxODBjZmMxOWU3ZDBiZWExMiIsImlhdCI6MTc3NDE1NTUzNSwiZXhwIjoyMDg5NTE1NTM1fQ.MdIZq95i9pJBKuKxn_aeyrK1O55JbMhsgtnM7GcTkXQ` |
| **Token Name** | `claude-automation` |

### API Usage

```bash
# Health check
curl -s http://192.168.1.39:8123/api/ \
  -H "Authorization: Bearer $HA_TOKEN"

# Get all states
curl -s http://192.168.1.39:8123/api/states \
  -H "Authorization: Bearer $HA_TOKEN"

# Control a light
curl -s -X POST http://192.168.1.39:8123/api/services/light/turn_on \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "light.wiz_rgbw_tunable_81ab69"}'

# Control a media player
curl -s -X POST http://192.168.1.39:8123/api/services/media_player/media_play \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "media_player.living_sound"}'
```

### UEFI First Boot

If the UEFI shell appears instead of booting:
```
FS0:
EFI\BOOT\BOOTAA64.EFI
```

### Previous HA Core (Almaca)

The old HA Core instance on Almaca (192.168.1.200:8123) is still running as reference. It's a venv-based install under `~/homeassistant-venv/` with config at `~/.homeassistant/`. This will be decommissioned after HAOS migration is complete.

---

## 2. Migration — Completed 2026-03-25

HAOS successfully migrated from Rahul M4 Airtop to Alpuca (Mac mini M4).

### What was done

1. Installed QEMU on Alpuca via Homebrew (`/opt/homebrew/bin/qemu-system-aarch64`)
2. Copied VM folder `~/homeassistant-vm/` from Airtop to Alpuca via rsync
3. Updated `start-ha.sh` — changed bridge interface from `en0` to `en1` (Alpuca's active Ethernet)
4. Updated LaunchDaemon plist — fixed paths from `/Users/rahulio/` to `/Users/alpuca/`
5. Installed LaunchDaemon on Alpuca at `/Library/LaunchDaemons/com.alpacapps.homeassistant-vm.plist`
6. Started VM — HAOS booted, kept IP 192.168.1.39, all 181 entities loaded

### Key difference from Airtop

- **Network interface:** `en1` on Alpuca (not `en0` — en0 is the inactive WiFi adapter on Mac mini)
- **QEMU path:** `/opt/homebrew/bin/qemu-system-aarch64` (Homebrew on Apple Silicon)
- **User home:** `/Users/alpuca/` (SSH user: `paca`)

### Airtop cleanup (TODO)

- [ ] Disable the LaunchDaemon on Airtop: `sudo launchctl unload /Library/LaunchDaemons/com.alpacapps.homeassistant-vm.plist`
- [ ] Optionally archive or delete `~/homeassistant-vm/` on Airtop after confirming Alpuca is stable

---

## 3. Configured Integrations (35 entries)

| Integration | Count | Status | Notes |
|-------------|-------|--------|-------|
| **WiZ** | 16 bulbs | Loaded | RGBW Tunable, auto-discovered via UDP |
| **Sonos** | 9 speakers | Loaded | All rooms working |
| **Google Cast** | 2 devices | Loaded | Jon + 1 other |
| **TP-Link** | 3 devices | Loaded | Cabin 1 KL135, Nook HS220, Stair Landing HS210 |
| **Music Assistant** | 1 entry | Loaded | Connected to Almaca :8095 |
| **DLNA DMR** | 1 device | Loaded | Spartan WiiM |
| **LinkPlay** | 1 device | Loaded | Spartan WiiM |
| **IPP (Printer)** | 1 device | Loaded | HP ENVY Photo 7800 |
| **Matter** | 1 entry | Loaded | Server running, no devices paired yet |
| **Thread** | 1 entry | Loaded | Border router available |
| **Supervisor** | 1 entry | Loaded | HAOS Supervisor |
| **go2rtc** | 1 entry | Loaded | WebRTC streaming |
| **Others** | 6 | Loaded | Sun, Backup, Met.no weather, Radio Browser, Shopping List, Google TTS |

### Pending Discoveries (3 remaining)

| Device | Integration | Blocker |
|--------|------------|---------|
| Dream-Machine-Pro (192.168.1.1) | UniFi Protect | Needs API key — create local user in UDM console |
| vizio | VIZIO SmartCast | Needs PIN code displayed on TV screen |
| VIZIO TV 9643 | HomeKit Device | Needs PIN code displayed on TV screen |

---

## 4. Device Inventory

### 4.1 WiZ Bulbs (16 discovered / 26 expected)

WiZ RGBW Tunable bulbs communicate via UDP port 38899, auto-discovered by HA. 16 entities currently in HAOS; 10 more expected (Master Pasture ×4, Kitchen ×6).

> **Full entity list, room assignments, and control commands → `docs/LIGHTINGAUTOMATION.md`**

### 4.2 Sonos Speakers (9 speakers, 22 entities)

| Room | Entity | State |
|------|--------|-------|
| Living Sound | `media_player.living_sound` | idle |
| Dining Sound | `media_player.dining_sound` | paused |
| Front Outside Sound | `media_player.front_outside_sound` | paused |
| Skyloft Sound | `media_player.skyloft_sound` | idle |
| Outhouse | `media_player.outhouse` | paused |
| MasterBlaster | `media_player.masterblaster` | paused |
| Pequeno | `media_player.pequeno` | paused |
| DJ | `media_player.dj` | paused |
| garage outdoors | `media_player.garage_outdoors` | paused |

**Full Sonos room list** (from Sonos HTTP API on Alpuca :5005):
Living Sound, Dining Sound, Outhouse, Skyloft Sound, Front Outside Sound, Pequeno, MasterBlaster, DJ, garage outdoors, Kitchen, Office, Bedroom, TV Room, Bathroom

**Sonos HTTP API** (Alpuca only — never Almaca):
```bash
curl http://192.168.1.200:5005/{Room}/musicsearch/spotify/song/{query}
curl http://192.168.1.200:5005/{Room}/{play|pause|stop}
```

### 4.3 TP-Link Smart Home (3 devices)

| Device | IP | Type | Entity |
|--------|-----|------|--------|
| Cabin 1 KL135 | 192.168.1.180 | Smart plug | `light.cabin_1` + power sensors |
| Nook HS220 | 192.168.1.101 | Dimmer switch | `light.nook` |
| Stair Landing HS210 | 192.168.1.230 | 3-way switch | `switch.stair_landing` |

> **Light control commands → `docs/LIGHTINGAUTOMATION.md`**

### 4.4 Govee Lights — NOT YET IN HAOS (~63 devices)

Controlled via `govee-control` Supabase edge function. Full area breakdown and control info → `docs/LIGHTINGAUTOMATION.md`

### 4.5 Nest Thermostats — NOT YET IN HAOS (3 in Supabase)

| Room | IP | Device Type |
|------|-----|-------------|
| Kitchen | 192.168.1.139 | Thermostat |
| Master | 192.168.1.111 | Thermostat |
| Skyloft | 192.168.1.249 | Thermostat |

**Setup requirements:**
1. Google Cloud project with Device Access API enabled
2. Nest Device Access console credentials (check Bitwarden for "Google Nest" or "Google Cloud")
3. OAuth 2.0 consent screen setup
4. One-time $5 fee for Device Access registration

### 4.6 LG Appliances — NOT YET IN HAOS (1 in Supabase)

| Device | Type |
|--------|------|
| Washer | washer |

Needs HACS integration: `SmartThinQ Sensors` or `LG ThinQ`

### 4.7 Tesla Vehicles — NOT YET IN HAOS (5 in Supabase)

| Name | Model | VIN | State |
|------|-------|-----|-------|
| Brisa Branca | Model 3 | 5YJ3E1EB0NF189739 | offline |
| Casper | Model 3 | 5YJ3E1EA3KF431880 | online |
| Cygnus | Model Y | 7SAYGDED0TA462517 | offline |
| Delphi | Model Y | 7SAYGDEE7PF923598 | offline |
| Sloop | Model Y | 7SAYGDED2TA496393 | online |

Needs HACS integration: `Tesla Custom Integration` — requires Tesla auth token.

### 4.8 Camera Streams — NOT YET IN HAOS (8 unique cameras)

| Camera | Location | IP | Model | Stream |
|--------|----------|-----|-------|--------|
| Alpacamera | Backyard/patio | 192.168.1.200 (Protect proxy) | G5 PTZ | RTSP :8554 |
| Front Of House | Front yard/driveway | 192.168.1.200 (Protect proxy) | G5 PTZ | RTSP :8554 |
| Side Yard | Side deck area | 192.168.1.200 (Protect proxy) | G5 PTZ | RTSP :8554 |
| Back Yard | Back yard | 192.168.1.24 | Wansview | RTSP :8554 |
| Front Cam | Front entrance | 192.168.1.132 | Wansview | RTSP :8554 |
| Garage | Garage | 192.168.1.18 | Wansview | RTSP :8554 |
| Patio Cam | Patio | 192.168.1.247 | Wansview | RTSP :8554 |
| Shed Cam | Shed | 192.168.1.28 | Wansview | RTSP :8554 |
| Driveway (Blink) | Driveway | 192.168.1.212 | Blink | RTSP :8554 |

**UniFi Protect integration** needs an API key from the UDM console (192.168.1.1). Create a local-only user with viewer permissions, then generate an API key.

**UDM Credentials:** `alpacaauto` / `StillForest160!auto`

### 4.9 OREIN/AiDot Matter Bulbs

Master Bathroom and Skyloft Bathroom bulbs. Now commissioned and working via HAOS.

> **Entity names, control commands, and commissioning notes → `docs/LIGHTINGAUTOMATION.md`**

### 4.10 Other Devices

| Device | Entity | State |
|--------|--------|-------|
| HP ENVY Photo 7800 | `sensor.hp_envy_photo_7800_series` | idle |
| — Black ink | `sensor.hp_envy_photo_7800_series_black_ink` | 60% |
| — Tri-color ink | `sensor.hp_envy_photo_7800_series_tri_color_ink` | 20% |
| Spartan WiiM | `media_player.spartan_wiim` | off |

---

## 5. HACS Installation (TODO)

HACS (Home Assistant Community Store) is needed for:
- **Govee LAN Control** — local Govee device control
- **Tesla Custom Integration** — Tesla vehicle integration
- **SmartThinQ Sensors** — LG washer/dryer
- **Govee Cloud** — fallback for Govee if LAN doesn't work

### Installation Steps

1. Install **Terminal & SSH** add-on from the add-on store (slug: `core_ssh`)
2. Start the add-on and open the terminal
3. Run: `wget -O - https://get.hacs.xyz | bash -`
4. Restart Home Assistant
5. Go to Settings → Integrations → Add Integration → search "HACS"
6. Follow GitHub OAuth flow to authenticate

---

## 6. Room/Area Assignments (TODO)

Rooms to create in HAOS (matching physical property):

| Room | Devices Expected |
|------|-----------------|
| Master Pasture | 4 WiZ bulbs, Nest thermostat |
| Kitchen | 6 WiZ bulbs, Nest thermostat, Sonos Kitchen |
| Living Room | 2 WiZ bulbs, Sonos Living Sound |
| Master Bathroom | 5 OREIN Matter bulbs |
| Skyloft | Nest thermostat, Sonos Skyloft Sound |
| Garage Mahal | 17 Govee light bars, Sonos garage outdoors |
| Spartan | 14 Govee light bars, WiiM speaker |
| Outhouse | 6 Govee light bars, Sonos Outhouse |
| Front Yard | Govee fence lights, Front Outside Sound |
| Back Yard | Govee string lights, cameras |
| Cabin 1 | TP-Link KL135 |
| Nook | TP-Link HS220 dimmer |
| Stair Landing | TP-Link HS210 switch |
| DJ Room | Sonos DJ |
| Dining Room | Sonos Dining Sound |
| Office | Sonos Office |
| Bedroom | Sonos Bedroom |
| TV Room | Sonos TV Room, VIZIO TV |
| Bathroom | Sonos Bathroom |

---

## 7. Planned Automations

| Automation | Trigger | Action |
|------------|---------|--------|
| Porch lights at sunset | Sun below horizon | Turn on Front fence, back patio lights |
| Porch lights off at sunrise | Sun above horizon | Turn off outdoor lights |
| Thermostat night mode | 10:00 PM daily | Set all thermostats to 68°F |
| Thermostat day mode | 7:00 AM daily | Set all thermostats to 72°F |
| Welcome home | Person arrives (phone GPS) | Turn on entry lights |
| Goodnight | 11:00 PM or voice command | Turn off all lights, lock doors |
| Laundry done | LG washer state → idle | Send notification |

---

## 8. Network Infrastructure

### UniFi Dream Machine Pro

| Setting | Value |
|---------|-------|
| IP | 192.168.1.1 |
| Web UI | https://192.168.1.1/ |
| Credentials | `alpacaauto` / `StillForest160!auto` |
| Firmware | 5.0.12 |
| Network App | 10.1.85 |

### Key Device IPs

| Device | IP | Purpose |
|--------|-----|---------|
| UDM Pro | 192.168.1.1 | Router, UniFi Protect |
| Alpuca | 192.168.1.200 | Sonos API, HAOS VM host, Cloudflare tunnel |
| Almaca | 192.168.1.74 | Legacy — WiZ Proxy, UP-Sense monitor only (avoid for new workloads) |
| HAOS VM | 192.168.1.39 | New Home Assistant OS |
| Nest Kitchen | 192.168.1.139 | Thermostat |
| Nest Master | 192.168.1.111 | Thermostat |
| Nest Skyloft | 192.168.1.249 | Thermostat |
| TP-Link Cabin 1 | 192.168.1.180 | Smart plug |
| TP-Link Nook | 192.168.1.101 | Dimmer |
| TP-Link Stair | 192.168.1.230 | Switch |

---

## 9. Legacy Systems (still running on Almaca)

These services on Almaca (192.168.1.200) will be migrated or deprecated:

| Service | Port | Status | Migrate? |
|---------|------|--------|----------|
| HA Core | 8123 | Running | Replaced by HAOS VM |
| Sonos HTTP API | 5005 | Running | Keep — HA Sonos integration is separate |
| WiZ Proxy | 8902 | Running | Deprecate once all WiZ in HAOS |
| Music Assistant | 8095 | Running | Already connected to HAOS |
| UP-Sense Monitor | cron | Running | Move to HAOS automation |

---

## 10. Troubleshooting

### HAOS VM won't start
```bash
# Check if QEMU process is running
ps aux | grep qemu

# Start manually
sudo ~/homeassistant-vm/start-ha.sh

# Check LaunchDaemon status
sudo launchctl list | grep homeassistant
```

### WiZ bulbs not discovering
- Bulbs use UDP broadcast on port 38899 — HAOS VM must be on same subnet (bridged networking)
- `nmap -sU -p 38899 192.168.1.0/24` to scan for bulbs
- See `docs/LIGHTINGAUTOMATION.md` for full troubleshooting

### Can't connect to HAOS
- Verify VM IP: `arp -a | grep 192.168.1.39`
- Check QEMU process: `ps aux | grep qemu`
- If IP changed: check DHCP leases in UDM → consider static assignment

### Sonos not showing all speakers
- HAOS and Sonos must be on same subnet
- Multicast/mDNS must be enabled on the network
- Check: `dns-sd -B _sonos._tcp` from a machine on the LAN

---

## 11. Quick Reference Commands

> **For all lighting commands → `docs/LIGHTINGAUTOMATION.md`**

### Sonos control via API
```bash
# Play/pause
curl -s -X POST http://192.168.1.39:8123/api/services/media_player/media_play_pause \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "media_player.living_sound"}'

# Set volume (0.0 - 1.0)
curl -s -X POST http://192.168.1.39:8123/api/services/media_player/volume_set \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "media_player.living_sound", "volume_level": 0.3}'
```

### Entity counts (current)
```
light          : 18  (16 WiZ + Cabin 1 + Nook)
media_player   : 22  (9 Sonos × 2 + WiiM × 3 + Jon)
switch         : 38  (Sonos alarms + TP-Link switches)
number         : 43  (Sonos EQ + WiZ effect speeds)
sensor         : 17  (TP-Link power + printer ink + sun + backup)
binary_sensor  :  3  (TP-Link cloud connections)
button         : 11  (Sonos favorites + WiiM controls)
update         :  4  (HA Core, OS, Supervisor, Matter Server)
─────────────────────
TOTAL          : 164 entities
```
