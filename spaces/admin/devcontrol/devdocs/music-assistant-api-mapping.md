# Music Assistant API Mapping (sonos-control)

This document maps existing `sonos-control` actions to Music Assistant (MA) API commands.

## Context

- Edge function: `supabase/functions/sonos-control/index.ts`
- MA URL secret: `MUSIC_ASSISTANT_URL` (example: `https://alpaclaw.cloud/ma-api`)
- MA token secret: `MUSIC_ASSISTANT_TOKEN` (optional if proxy injects auth)
- Feature flag: `USE_MUSIC_ASSISTANT` (`true` by default)

## Routing strategy

- **MA first** for transport/state/library actions.
- **Sonos proxy fallback** if MA command fails or MA is unavailable.
- **Sonos-only path** remains for announce + EQ actions (`announce`, `bass`, `treble`, `loudness`, `balance`, `tts_preview`, `musicsearch`).

## Action mapping

| Existing action | MA command attempts (in order) | Notes |
|---|---|---|
| `getZones` | `players/all`, `players/list`, `config/players/get` | Normalized into Sonos-like `[{ coordinator, members }]` response. |
| `getState` | `players/get`, `player/get`, `config/players/get` | Uses room name -> player lookup from current MA players list. |
| `play` | `player_queues/play`, `players/cmd/play`, `players/play` | `player_id` and `queue_id` variants attempted. |
| `pause` | `player_queues/pause`, `players/cmd/pause`, `players/pause` | Same fallback pattern as play. |
| `playpause` | `player_queues/play_pause`, `players/cmd/play_pause`, `players/play_pause` | Toggle behavior. |
| `next` | `player_queues/next`, `players/cmd/next`, `players/next` | Track skip forward. |
| `previous` | `player_queues/previous`, `players/cmd/previous`, `players/previous` | Track skip back. |
| `volume` | `players/cmd/volume_set`, `players/set_volume`, `player_queues/set_volume` | Volume 0-100. |
| `mute`/`unmute` | `players/cmd/mute`, `players/set_mute` | Uses boolean mute value. |
| `pauseall`/`resumeall` | player list + per-player play/pause commands | Runs in parallel across all discovered players. |
| `join` | `players/cmd/sync`, `players/cmd/join`, `players/join` | `room` joins `other` target coordinator. |
| `leave` | `players/cmd/unsync`, `players/cmd/leave`, `players/leave` | Removes from sync group. |
| `playlists` | `music/playlists`, `music/library/playlists`, `playlists/list` | Returned as string names array for existing clients. |
| `favorites` | `music/favorites`, `music/library/favorites`, `favorites/list` | Returned as string names array for existing clients. |
| `playlist`/`favorite` | list playlists/favorites then `player_queues/play_media` variants | Resolves by name first, then falls back to raw provided name. |
| `spotify-play` | `player_queues/play_media` variants, `players/cmd/play_media`, `music/play_uri` | Direct MA URI play path (supports enqueue). |

## Room-name to player-id resolution

- MA players are fetched and cached briefly.
- Lookup precedence:
  1. exact room name match (`display_name` / `name` / `room_name`)
  2. case-insensitive contains match

## Response compatibility contract

`getZones` response is adapted to match the existing Sonos page/mobile expectations:

- Group shape: `{ coordinator, members }`
- Coordinator fields include:
  - `roomName`
  - `state.playbackState`
  - `state.elapsedTime`
  - `state.elapsedTimeFormatted`
  - `state.currentTrack`
  - `groupState.volume`, `groupState.mute`
- Member fields include:
  - `roomName`
  - `state.volume`, `state.mute`, `state.equalizer`

This allows `shared/services/sonos-data.js`, `residents/sonos.js`, and `mobile/app/tabs/music-tab.js` to keep their current contracts.
