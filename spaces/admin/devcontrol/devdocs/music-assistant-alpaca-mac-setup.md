# Music Assistant on Almaca — Setup & Home Music Automation

Review and configuration guide for Music Assistant (MA) on the Almaca: Docker setup, local/hard-drive music, and scheduled playback for home music automation.

**Related:** [MUSIC-ASSISTANT-EVALUATION.md](./MUSIC-ASSISTANT-EVALUATION.md), [music-assistant-api-mapping.md](./music-assistant-api-mapping.md), [instructions/music-assistant-implementation-plan.md](../instructions/music-assistant-implementation-plan.md).

---

## 1. Current Architecture

| Layer | Role |
|-------|------|
| **Alpuca** | Runs node-sonos-http-api (:5005). Same LAN as Sonos. Music Assistant removed 2026-03-25. |
| **Hostinger** | HTTPS proxy: `/sonos/*` → Sonos API. Reaches Alpuca via Tailscale. |
| **Supabase** | Edge function `sonos-control` routes playback/grouping to MA first, fallback to Sonos proxy; announce/EQ stay on Sonos. |

---

## 2. Music Assistant on Almaca — Checklist

### 2.1 Native install (Python 3.12 venv — no Docker)

- [x] **Python 3.12** installed via Homebrew (`/usr/local/bin/python3.12`)
- [x] **ffmpeg** installed via Homebrew (`/usr/local/bin/ffmpeg` v8.0.1)
- [x] **MA venv:** `~/music-assistant-venv-312/` with `music-assistant[server]` 2.6.0
- [x] **Data dir:** `~/music-assistant-data/`
- [x] **Auto-start:** LaunchAgent `~/Library/LaunchAgents/com.music-assistant.server.plist` — starts on boot, auto-restarts on crash
- [x] **Logs:** `/tmp/music-assistant.log`
- [x] **Web UI:** `http://192.168.1.200:8095` — verified accessible from dev machine
- [x] **Stream server:** port 8097 (auto-detected LAN IP)

> **Why native, not Docker?** macOS 12 on this Intel Mac can't run Docker (QEMU/Colima fails due to missing llvm). Native pip install works fine and uses less resources.

### 2.2 First-run and Sonos provider (MANUAL)

- [ ] Open MA UI: `http://192.168.1.200:8095`. Complete first-run setup (admin user if prompted).
- [ ] **Settings → Player providers:** Add **Sonos S1** (or **Sonos** for S2). Confirm all zones appear with correct names.
- [ ] **Settings:** Create a long-lived **API token**. Store in Supabase secret `MUSIC_ASSISTANT_TOKEN` and (if needed) on Hostinger for Caddy injection.

### 2.3 Proxy and edge function

- [ ] Hostinger Caddy: `https://alpaclaw.cloud/ma-api` → `http://<alpaca-mac-tailscale-ip>:8095/api`, with Bearer token if not sent by edge.
- [ ] Supabase secrets: `MUSIC_ASSISTANT_URL` (e.g. `https://alpaclaw.cloud/ma-api`), `MUSIC_ASSISTANT_TOKEN`, `USE_MUSIC_ASSISTANT=true`.
- [ ] From resident Sonos page: zones load, play/pause/volume work via MA.

---

## 3. Local Music (Hard Drives / Filesystem)

Music Assistant can serve music from local folders or mounted drives so residents can use library content and playlists from disk.

### 3.1 Add a local music source in MA

1. In MA UI: **Settings → Music providers**.
2. Add **Filesystem** (local) or **Filesystem (remote share)** for NAS/SMB.
3. **Local path (Docker):** The container must see the path. Use a bind mount when starting the container, e.g.:

   ```bash
   docker run -d \
     --name music-assistant \
     --restart unless-stopped \
     -p 8095:8095 \
     -v music-assistant-data:/data \
     -v /Volumes/YourMusic:/music:ro \
     ghcr.io/music-assistant/server:latest
   ```

   Then in MA add a **Filesystem** provider and set the path to `/music` (inside the container). Replace `/Volumes/YourMusic` with the actual path on the Mac (e.g. external drive mount point).

4. **Multiple drives/folders:** Add multiple Filesystem providers or multiple paths under one provider if supported (see MA docs).
5. **Sync:** MA will scan and catalog; configure sync interval in provider settings if needed.

### 3.2 Paths on Almaca

- Internal disk: e.g. `/Users/alpaca/Music` or a dedicated volume.
- External USB drive: typically `/Volumes/DriveName`; ensure the drive is mounted before Docker (and MA) starts, or use a LaunchAgent to start MA after mounts are available.
- **Reboot behavior:** External drives may mount after login. If MA starts at login, either use a path that exists at boot (internal) or delay MA start until after the drive is mounted.

### 3.3 Using local music in the app

- Playlists and library from MA (including filesystem) are exposed via the existing `playlists` / `favorites` and play actions; the edge function already routes play to MA. Residents can pick MA playlists/favorites that include local files.
- If you use **playlist by name** in schedules, ensure the playlist exists in MA (created from local library or synced).

---

## 4. Schedules (Home Music Automation)

### 4.1 Current state

- **DB:** Table `sonos_schedules` stores: `name`, `room`, `time_of_day` (HH:MM:00), `recurrence` (daily / weekdays / weekends / custom / once), `custom_days`, `one_time_date`, `playlist_name`, `source_type` (playlist | favorite), `volume`, `keep_grouped`, `is_active`, `updated_at`.
- **UI:** Resident Sonos page → “Schedules” section: add/edit/delete/toggle active. Data is read/written via Supabase client.
- **Implemented:** `run-schedules` action in `sonos-control` edge function + pg_cron job (every 5 min).

### 4.2 How the schedule runner works

**Option A — Supabase pg_cron + Edge function (implemented)**

1. **pg_cron** job `sonos-schedule-runner` runs every 5 minutes (`*/5 * * * *`).
2. Calls `sonos-control` with `{ action: “run-schedules” }` authenticated via `X-Cron-Secret` header.
3. The handler:
   - Gets current time in America/Chicago.
   - Queries `sonos_schedules WHERE is_active = true`.
   - For each schedule, checks if `time_of_day` is within ±7 minutes of now and recurrence matches today.
   - **Idempotency:** Skips if `last_fired_at` is within the last 30 minutes.
   - Sets volume (if specified) then plays playlist/favorite via MA (fallback to Sonos proxy).
   - Updates `last_fired_at`; deactivates one-time schedules after firing.

**Option B — Hostinger cron script (alternative)**

- Cron on Hostinger queries Supabase for due schedules and curls the proxy. Not needed now that Option A is live.

**Option C — Manual cron (still available)**

- Static cron lines on Hostinger for fixed alarms (e.g. pauseall at midnight). Does not use the `sonos_schedules` table.

---

## 5. Configuration Summary

| Item | Where | Purpose |
|------|--------|---------|
| MA native (Python 3.12 venv) | Almaca | MA server, port 8095 — LaunchAgent auto-starts |
| MA data dir | Almaca `~/music-assistant-data/` | Persistent config + database |
| Music folders | Almaca filesystem | Local/hard-drive music → MA Filesystem provider (no Docker bind mount needed) |
| MA API token | Supabase `MUSIC_ASSISTANT_TOKEN`, optionally Hostinger | Auth for MA API |
| Sonos proxy | Hostinger Caddy | `/sonos/*` → Alpuca :5005 |
| MA proxy | Hostinger Caddy | `/ma-api` → removed (MA deleted 2026-03-25) |
| Schedule runner | pg_cron job #31 (`*/5 * * * *`) | Calls `sonos-control` `run-schedules` action → checks due `sonos_schedules` → MA/Sonos |

---

## 6. Quick verification

1. **MA and Sonos:** Resident Sonos page → zones load, play/pause/volume on one zone.
2. **Local library:** In MA UI, add Filesystem provider, point to mounted path, run sync; in app, play a track/playlist from that source.
3. **Schedules (manual):** Create a schedule in the UI, note time; when the runner is implemented, confirm it fires at that time and playback starts in the chosen room.

---

## 7. References

- MA installation: https://music-assistant.io/installation/
- MA Filesystem provider: https://www.music-assistant.io/music-providers/filesystem/
- MA API: https://www.music-assistant.io/api/
- Sonos player support: https://www.music-assistant.io/player-support/sonos/
