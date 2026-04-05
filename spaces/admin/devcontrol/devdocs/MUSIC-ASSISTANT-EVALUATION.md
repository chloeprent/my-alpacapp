# Music Assistant as Core Sonos Controller — Evaluation

**Purpose:** Evaluate switching from the current Sonos page (node-sonos-http-api + `sonos-control` edge function) to using [Music Assistant](https://music-assistant.io) as the core controller for Sonos devices.

**References:**
- Official site: https://music-assistant.io  
- GitHub org: https://github.com/music-assistant  
- Server repo: https://github.com/music-assistant/server  
- Sonos player support: https://www.music-assistant.io/player-support/sonos/  
- API docs: https://www.music-assistant.io/api/  
- User docs: https://music-assistant.io/docs (site structure; some paths 404)

---

## 1. Current Setup (Summary)

| Layer | What we have |
|-------|----------------|
| **LAN** | 12 Sonos zones on property; node-sonos-http-api on **Alpaca Mac** (port 5005). |
| **Proxy** | DO droplet → Tailscale → Alpaca Mac; nginx on droplet port 8055 forwards to Sonos API. *(Planned: move proxy to Hostinger VPS after Tailscale is configured there; see §5.)* |
| **Edge** | `sonos-control` Supabase edge function: auth (resident+), then forwards requests to proxy (DO today; Hostinger VPS once DO is retired). |
| **Client** | `residents/sonos.html` + `sonos.js`, `shared/services/sonos-data.js`, mobile `music-tab.js`. |
| **Features** | Zones, play/pause/next/prev, volume, mute, favorites, playlists, join/leave, bass/treble/balance, **TTS announce** (Gemini → WAV → Sonos), **Spotify search/play** (Spotify API + Sonos URI), **scenes** (DB: `sonos_scenes`, `sonos_scene_actions`), **playlist tags** (DB: `sonos_playlist_tags`), schedules. |
| **PAI** | `control_sonos` and `announce` tools call `sonos-control` with service-role. |

So today: **Browser/Mobile/PAI → Supabase edge → DO proxy → Alpaca Mac (node-sonos-http-api) → Sonos.**  
**Target (post–DO retirement):** Same flow with **Hostinger VPS** as the proxy host (see §5).

---

## 2. What Music Assistant Is

- **Server:** Python app in Docker; must run on an always-on host (Raspberry Pi, NAS, NUC, or our Alpaca Mac).
- **Role:** Central “music library manager” that:
  - Connects to **music providers** (Spotify, local files, etc.) and keeps a unified library.
  - Connects to **player providers** (Sonos S1, Sonos S2, AirPlay, etc.) and **controls playback** (play, pause, volume, queue, grouping/sync).
- **Sonos:** Auto-detects Sonos devices; can use native Sonos API or (where supported) AirPlay. S1 and S2 are separate providers; S1 and S2 cannot be in the same sync group (same as our current limitation).
- **API:** REST at `http://MA_SERVER:8095/api` — JSON POST with `message_id`, `command`, `args`. Bearer token auth. Swagger at `http://MA_SERVER:8095/api-docs`.
- **Control:** Commands like `config/players/get`, `config/players/save`, `player_queues/items`, `music/favorites/add_item`, `music/item_by_uri`, etc. Player control (play/pause/volume/queue) is exposed; exact command set is in the server’s auto-generated api-docs.

So MA would sit **between** our app and Sonos: we’d talk to MA (players = Sonos zones), and MA would talk to Sonos (and optionally other players later).

---

## 3. Why Consider Music Assistant

- **Single control plane:** One API for “play this” / “pause” / “volume” / “group” instead of separate Sonos API + Spotify API + custom TTS.
- **Unified library and search:** MA can aggregate Spotify + local + other providers; we could reduce direct Spotify API usage and use MA’s `music/item_by_uri`, search, playlists.
- **Sync groups:** MA handles grouping/sync for Sonos (and AirPlay where applicable); we could potentially replace part of our scene logic with MA’s grouping.
- **Future players:** If we add non-Sonos players (e.g. more WiiM, other AirPlay), MA can manage them from the same API.
- **Community and docs:** Active project, Home Assistant integration, REST API, Python/JS clients.

---

## 4. What We’d Need to Preserve or Reimplement

| Feature | Current implementation | With MA |
|--------|------------------------|--------|
| Zone list | node-sonos `GET /zones` | MA `config/players/get` (or players list command) — map MA players → “zones”. |
| Play/Pause/Next/Prev/Volume/Mute | Sonos HTTP API paths | MA player commands (exact names from api-docs). |
| Favorites / Playlists | Sonos favorites & playlists (from device) | MA has `music/favorites`, playlists; may need to map “Sonos favorites” to MA library or keep dual path during migration. |
| Join/Leave (grouping) | Sonos `join`/`leave` | MA has sync groups / player grouping — use MA API. |
| Bass/Treble/Balance | Sonos HTTP API | MA player settings (`config/players/save`) if MA exposes them; else keep a small Sonos-only path or drop. |
| **TTS Announce** | Gemini TTS → WAV in Storage → Sonos custom action `announceurl` | MA doesn’t do TTS. **Keep:** generate WAV in edge function, then either (a) push URL to MA to play on player(s), or (b) keep one-off call to existing Sonos proxy for announce only. |
| **Spotify search/play** | Edge: Spotify API + Sonos `spotify/now` / `spotify/queue` | Prefer MA: `music/item_by_uri`, search, and “play on player” so MA handles Spotify and Sonos. Reduces Spotify token handling in our edge. |
| **Scenes** | DB `sonos_scenes` + `sonos_scene_actions` (multi-room, playlists, volumes, EQ) | Reimplement with MA: set volumes, create/restore sync groups, start playback per group via MA. No direct 1:1; need a small “scene runner” that calls MA. |
| **Playlist tags** (e.g. starred) | DB `sonos_playlist_tags` | Stay in DB; UI still shows “starred” from our DB; “play” sends MA the right item (MA playlist or URI). |
| **Schedules** | DB + cron on proxy host (DO today; Hostinger when DO retired) | Unchanged; cron calls MA (or Sonos proxy) to start playback at time. |
| **PAI** | `control_sonos` + `announce` → `sonos-control` | Same UX; implementation becomes “call MA-control edge function” (or mixed: announce still Sonos proxy, rest MA). |

So the main design choice is: **MA as the single playback and library backend**, with **announcements** and possibly **EQ** either kept on Sonos API or implemented via MA if it supports them.

---

## 5. Architecture Options

### 5.1 Where to run Music Assistant server

| Option | Pros | Cons |
|--------|------|------|
| **Alpaca Mac** | Same LAN as Sonos; no extra network hop for Sonos; can keep node-sonos as fallback for announce. | Need to run Docker (or native) on Mac; resource use; Mac is “home server” — one machine for Sonos + MA + go2rtc, etc. |
| **Hostinger VPS** | Aligns with post-DO setup (OpenClaw already there). | Sonos is not on Hostinger's network; MA runs on Alpaca Mac; Hostinger is only the *proxy* to reach Alpaca Mac (requires Tailscale, §5.3). |
| **Oracle VM** | Aligns with migration off DO; always-on. | Sonos not on Oracle LAN; would still need proxy/bridge (Alpaca Mac) for Sonos discovery/control. |

**Recommendation:** Run **MA on Alpaca Mac** (Docker). Sonos discovery and control stay local. Use **Hostinger VPS** (not DO droplet) for the public proxy and cron once DO is retired; Hostinger reaches Alpaca Mac over Tailscale (§5.3).

### 5.3 Hostinger VPS + Tailscale (prerequisite for proxy)

To use Hostinger as the proxy host for Sonos and Music Assistant, Hostinger must reach Alpaca Mac (same pattern as the current DO droplet):

- **Install Tailscale** on Hostinger VPS (Ubuntu: `curl -fsSL https://tailscale.com/install.sh | sh`, then `tailscale up --accept-routes`). Use the same Tailnet as Alpaca Mac.
- **Subnet route:** Alpaca Mac advertises `192.168.1.0/24`; Tailnet admin approves it. Hostinger accepts routes so it can reach Alpaca Mac's Tailscale IP.
- **Proxy:** Sonos proxy (today) and MA proxy (later) on Hostinger forward to `http://<alpaca-mac-tailscale-ip>:5005` and `http://<alpaca-mac-tailscale-ip>:8095`. Caddy (or nginx) on Hostinger handles HTTPS; no Sonos/MA ports exposed publicly.

When switching off DO: point `SONOS_PROXY_URL` (and cron) to the Hostinger proxy URL (e.g. `https://alpaclaw.cloud/sonos` or a dedicated subdomain). Edge function and clients stay unchanged.

### 5.4 How the app talks to Music Assistant

MA API is on port 8095 and is **not** public. So we keep a secure proxy:

- **Option A — Edge function only:** New Supabase edge function `ma-control` (or extend `sonos-control`): auth as now, then **forward** to MA. MA URL would be a Supabase secret (e.g. `MUSIC_ASSISTANT_URL` = `http://alpaca-mac-tailscale-ip:8095`). Edge function can’t reach Tailscale IPs unless we add a proxy that forwards to Alpaca Mac.
- **Option B — VPS proxy (recommended):** Same pattern as Sonos today, but with **Hostinger VPS** as the proxy host (replacing DO droplet): **Edge function → Hostinger (Caddy or nginx) → Alpaca Mac:8095**. Hostinger must be on Tailscale with `--accept-routes` so it can reach Alpaca Mac (see §5.3 Hostinger + Tailscale). Add a route like `POST /ma-api` → `http://<alpaca-mac-tailscale-ip>:8095/api`, inject Bearer token from env. Edge function calls `https://alpaclaw.cloud/ma-api` (or a dedicated subdomain) with auth; no MA port exposed to the internet.
- **Option C — WebSocket:** MA supports WebSocket for real-time state. We could add a WebSocket proxy on Hostinger (or a small service on Alpaca Mac) and have the frontend use it for “now playing” and transport events. Initially we can keep polling via REST from the edge function and existing client refresh.

**Recommendation:** **Option B** — new proxy on **Hostinger VPS** for MA API (and optionally WebSocket later). Edge function `sonos-control` is renamed or split: either “music-control” that talks only to MA proxy, or we keep `sonos-control` but have it call MA proxy for most actions and Sonos proxy only for announce (and maybe bass/treble/balance if not in MA). When DO is retired, **Sonos proxy** (and any cron) also move to Hostinger so one VPS handles all bridge-to-Alpaca-Mac traffic.

---

## 6. High-Level Migration Path

1. **Run Music Assistant**
   - Install MA server in Docker on Alpaca Mac (or follow [installation](https://music-assistant.io/installation/)).
   - Configure Sonos provider(s) (S1 and/or S2); let MA discover zones.
   - Create a long-lived API token; store in Supabase secret (e.g. `MUSIC_ASSISTANT_TOKEN`) and in Hostinger proxy env (e.g. `MA_TOKEN`).

2. **Proxy for MA**
   - On Hostinger VPS: add Caddy (or nginx) route that forwards `POST /ma-api` to `http://<alpaca-mac-tailscale-ip>:8095/api`, with `Authorization: Bearer <MA_TOKEN>`. Optionally expose a WebSocket path for `/api` if we want live updates later. Hostinger must be on Tailscale (§5.3).

3. **New edge function or extend sonos-control**
   - Implement a thin “MA client” in the edge function: map our current action names (e.g. `getZones`, `play`, `pause`, `volume`, `playlist`, `favorite`, etc.) to MA commands (`config/players/get`, player command, etc.). Keep **announce** and optionally **bass/treble/balance** on the existing Sonos proxy path until we confirm MA supports them or we decide to drop them.

4. **Client and data layer**
   - `sonos-data.js` and `sonos.js`: keep the same **external API** (same action names and params) but have the edge function call MA instead of Sonos for those actions. Optionally add a “source” (e.g. `ma` vs `sonos`) for debugging. No need to rewrite the whole UI in one go.
   - **Scenes:** Rewrite scene execution to use MA: set sync groups, volumes, then “play playlist/item on group” via MA. Keep `sonos_scenes` and `sonos_scene_actions` in DB; only the “runner” changes from Sonos API to MA API.
   - **Spotify:** Gradually move to MA: e.g. “play Spotify track” → MA `music/item_by_uri` + “play on player”; remove or reduce direct Spotify API usage in the edge function.

5. **PAI**
   - `control_sonos` and `announce`: keep same tool contracts; implementation switches to “music-control” edge (MA) + Sonos-only announce path.

6. **Mobile**
   - `music-tab.js` already uses `sonos-data.js`; once the edge function uses MA, mobile gets MA behavior without code changes (unless we add MA-specific features).

7. **Decommission**
   - When MA covers all use cases: stop using node-sonos-http-api for normal control; keep it only if we still need `announceurl` or raw Sonos for TTS. Alternatively, see if MA can “play URL” on a player so we can drop node-sonos entirely and do announce through MA.

---

## 7. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| MA API changes | Pin MA server version in Docker; test upgrades in staging; keep adapter layer in edge function so only one place maps to MA commands. |
| Sonos S1 vs S2 | We have S1 devices; use “Sonos S1” provider; document that S1/S2 can’t sync together (same as today). |
| TTS / Announce | Keep current path (Gemini → WAV → Sonos `announceurl`) until MA supports “play URL” on Sonos in a way that fits announcements; then migrate. |
| Scenes and EQ | Scenes become “MA sequence of commands”; EQ (bass/treble/balance) either via MA player settings or keep a minimal Sonos proxy for those. |
| Availability | MA runs on Alpaca Mac; if Mac is down, music control is down (same as today with node-sonos). |

---

## 8. Recommended Next Steps

1. **Proof of concept (no app changes yet)**  
   - Install Music Assistant (Docker) on Alpaca Mac.  
   - Add Sonos S1 (and S2 if needed) provider; confirm all 12 zones appear as players.  
   - Get API token; call `http://alpaca-mac:8095/api` from a machine that can reach it (e.g. Hostinger VPS via Tailscale, or DO droplet until it is retired) with a few commands: list players, play/pause, volume.  
   - Confirm MA can “play Spotify URI” on a Sonos player so we can plan deprecating direct Spotify in the edge function.

2. **API mapping doc**  
   - Open `http://MA_SERVER:8095/api-docs` and list the exact commands we need: players list, play, pause, volume, mute, queue, group/sync, “play item/URI on player”.  
   - Write a one-page mapping: “Our action → MA command + args”.

3. **Proxy and edge**  
   - Add MA proxy on Hostinger VPS (e.g. `/ma-api` → Alpaca Mac:8095 via Tailscale, Bearer token). When DO is retired, move Sonos proxy to Hostinger as well (§5.3).  
   - Implement `ma-control` (or extend `sonos-control`) with the mapped commands; keep announce (and optionally EQ) on Sonos proxy.

4. **Scenes and DB**  
   - Implement “activate scene” using only MA (groups, volume, play); keep `sonos_scenes` / `sonos_scene_actions` schema; change only the runner in `sonos-data.js` / edge.

5. **Switchover**  
   - Point `sonos-data.js` (and PAI) to the new edge behavior; test web + mobile + PAI.  
   - Once stable, consider retiring node-sonos-http-api or keeping it only for TTS announce if MA doesn’t support URL playback for that use case.

---

## 9. Summary

- **Feasible:** Yes. Music Assistant can act as the core controller for Sonos; we keep our UI and PAI tools and swap the backend from “Sonos HTTP API” to “MA API” via a proxy and a thin edge adapter.
- **Best placement:** MA server on **Alpaca Mac** (Docker); **Hostinger VPS** (replacing DO droplet) proxies requests to MA and keeps optional Sonos proxy for announce/EQ. Hostinger reaches Alpaca Mac over Tailscale (§5.3).
- **Effort:** Medium: install MA, add proxy, map actions in edge function, reimplement scene runner for MA, then migrate Spotify and optionally TTS to MA where supported.
- **Benefit:** One control plane (MA), unified library and search, easier addition of more players later; less custom glue (e.g. Spotify token) in our edge function.

If you want to proceed, the concrete next step is **Step 1 (PoC)** on Alpaca Mac (and Hostinger or DO for proxy testing), then **Step 2 (API mapping)** from the live api-docs. When retiring DO, configure Tailscale on Hostinger (§5.3) and point proxy URLs and cron there.
