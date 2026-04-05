import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getAppUserWithPermission } from "../_shared/permissions.ts";
import { logApiUsage } from "../_shared/api-usage-log.ts";

interface SonosRequest {
  action:
    | "getZones"
    | "getState"
    | "play"
    | "pause"
    | "playpause"
    | "next"
    | "previous"
    | "volume"
    | "mute"
    | "unmute"
    | "favorite"
    | "favorites"
    | "playlists"
    | "playlist"
    | "pauseall"
    | "resumeall"
    | "join"
    | "leave"
    | "bass"
    | "treble"
    | "loudness"
    | "balance"
    | "announce"
    | "tts_preview"
    | "musicsearch"
    | "spotify-search"
    | "spotify-play"
    | "run-schedules";
  room?: string;
  value?: number | string;
  name?: string;
  other?: string;
  text?: string;
  voice?: string;
  volume?: number;
  service?: string;
  searchType?: string;
  query?: string;
  limit?: number;
  uri?: string;
  enqueue?: boolean;
}

// =============================================
// TTS Helpers
// =============================================

const GEMINI_TTS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent";

const STORAGE_BUCKET = "housephotos";
const TTS_PREFIX = "tts-announce";

/** Build a WAV header for raw PCM data (24kHz, 16-bit, mono) */
function buildWavHeader(pcmByteLength: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  // "RIFF" chunk
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + pcmByteLength, true); // file size - 8
  view.setUint32(8, 0x57415645, false); // "WAVE"
  // "fmt " sub-chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true); // sub-chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // "data" sub-chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, pcmByteLength, true);

  return new Uint8Array(header);
}

/** Decode base64 string to Uint8Array */
function base64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// =============================================
// Spotify API Helpers
// =============================================

let spotifyToken: string | null = null;
let spotifyTokenExpiresAt = 0;
let spotifyClientId: string | null = null;
let spotifyClientSecret: string | null = null;

async function getSpotifyToken(supabase: any): Promise<string> {
  if (spotifyToken && Date.now() < spotifyTokenExpiresAt - 60_000) {
    return spotifyToken;
  }
  // Load credentials from spotify_config table if not cached
  if (!spotifyClientId || !spotifyClientSecret) {
    const { data: config, error } = await supabase
      .from("spotify_config")
      .select("client_id, client_secret, is_active")
      .eq("id", 1)
      .single();
    if (error || !config) {
      throw new Error("Spotify config not found in database");
    }
    if (!config.is_active) {
      throw new Error("Spotify integration is disabled");
    }
    spotifyClientId = config.client_id;
    spotifyClientSecret = config.client_secret;
  }
  if (!spotifyClientId || !spotifyClientSecret) {
    throw new Error("Spotify API credentials not configured");
  }
  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${spotifyClientId}:${spotifyClientSecret}`)}`,
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Spotify token error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  spotifyToken = data.access_token;
  spotifyTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return spotifyToken!;
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

const MA_PLAYER_CACHE_MS = 8_000;
let maPlayersCache: { fetchedAt: number; players: any[] } = { fetchedAt: 0, players: [] };

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function makeMessageId(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeMaEnvelope(payload: any) {
  if (payload == null) return payload;
  if (typeof payload !== "object") return payload;
  if ("result" in payload) return payload.result;
  if ("data" in payload) return payload.data;
  if ("items" in payload) return payload.items;
  if ("payload" in payload) return payload.payload;
  return payload;
}

function asArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && Array.isArray(value.results)) return value.results;
  if (value && Array.isArray(value.players)) return value.players;
  if (value && Array.isArray(value.data)) return value.data;
  return [];
}

async function maRequest(
  maUrl: string,
  maToken: string | null,
  command: string,
  args: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (maToken) {
    headers.Authorization = `Bearer ${maToken}`;
  }
  const response = await fetch(maUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message_id: makeMessageId(),
      command,
      args,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MA command ${command} failed (${response.status}): ${errorText.slice(0, 240)}`);
  }
  const json = await response.json().catch(() => ({}));
  return normalizeMaEnvelope(json);
}

async function maRequestWithFallbackCommands(
  maUrl: string,
  maToken: string | null,
  commandAttempts: Array<{ command: string; args?: Record<string, unknown> }>,
) {
  let lastErr: Error | null = null;
  for (const attempt of commandAttempts) {
    try {
      return await maRequest(maUrl, maToken, attempt.command, attempt.args || {});
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr || new Error("Music Assistant request failed");
}

function normalizePlaybackState(raw: string | undefined): "PLAYING" | "PAUSED_PLAYBACK" | "STOPPED" | "TRANSITIONING" {
  const state = (raw || "").toUpperCase();
  if (state.includes("PLAY")) return "PLAYING";
  if (state.includes("PAUSE")) return "PAUSED_PLAYBACK";
  if (state.includes("TRANS")) return "TRANSITIONING";
  return "STOPPED";
}

function parseTrackDuration(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 10_000) return Math.round(value / 1000);
    return Math.round(value);
  }
  if (typeof value === "string" && value.includes(":")) {
    const parts = value.split(":").map((p) => Number(p));
    if (parts.some((p) => Number.isNaN(p))) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }
  return 0;
}

function normalizeMaPlayer(player: any) {
  const id = String(player.player_id || player.id || player.uuid || "");
  const roomName = String(
    player.display_name ||
      player.name ||
      player.room_name ||
      player.roomName ||
      id,
  );
  const stateSource = player.state || player;
  const playbackState = normalizePlaybackState(
    stateSource.state ||
      stateSource.playback_state ||
      stateSource.player_state ||
      stateSource.status,
  );
  const elapsed = Number(
    stateSource.elapsed_time ||
      stateSource.elapsed ||
      stateSource.position ||
      0,
  );
  const media = stateSource.current_media || stateSource.media_item || stateSource.current_item || {};
  const groupId = player.group_childs?.length
    ? String(player.player_id || player.id || roomName)
    : String(player.group_id || player.sync_group || player.group || player.synced_to || id);
  return {
    id,
    roomName,
    groupId,
    isCoordinator: !!(player.can_sync || player.group_childs?.length || player.is_group_leader || !player.synced_to),
    volume: Number(
      stateSource.volume_level ??
        stateSource.volume ??
        player.volume_level ??
        player.volume ??
        0,
    ),
    mute: !!(
      stateSource.volume_muted ??
      stateSource.muted ??
      player.volume_muted ??
      player.muted
    ),
    playbackState,
    elapsedTime: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0,
    currentTrack: {
      title: media.name || media.title || stateSource.title || "",
      artist: media.artist || media.artists?.[0]?.name || stateSource.artist || "",
      album: media.album || media.album_name || "",
      duration: parseTrackDuration(media.duration || media.duration_seconds || stateSource.duration),
      absoluteAlbumArtUri:
        media.image?.url ||
        media.image_url ||
        media.album_art ||
        media.artwork_url ||
        stateSource.image_url ||
        "",
      type: media.media_type || media.type || "",
      stationName: media.station || "",
    },
    equalizer: {
      bass: Number(stateSource.bass ?? 0),
      treble: Number(stateSource.treble ?? 0),
    },
  };
}

function buildSonosLikeZonesFromMa(playersRaw: any[]): any[] {
  const players = playersRaw.map(normalizeMaPlayer).filter((p) => p.id);
  const groups = new Map<string, any[]>();
  for (const player of players) {
    const key = player.groupId || player.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(player);
  }
  const zoneGroups: any[] = [];
  for (const memberList of groups.values()) {
    const coordinator = memberList.find((m) => m.isCoordinator) || memberList[0];
    const groupVolume = Math.round(
      memberList.reduce((sum, item) => sum + (Number.isFinite(item.volume) ? item.volume : 0), 0) / Math.max(memberList.length, 1),
    );
    const groupMute = memberList.some((m) => m.mute);
    zoneGroups.push({
      coordinator: {
        roomName: coordinator.roomName,
        state: {
          playbackState: coordinator.playbackState,
          elapsedTime: coordinator.elapsedTime,
          elapsedTimeFormatted: formatDuration(coordinator.elapsedTime),
          currentTrack: coordinator.currentTrack,
          equalizer: coordinator.equalizer,
        },
        groupState: {
          volume: groupVolume,
          mute: groupMute,
        },
      },
      members: memberList.map((member) => ({
        roomName: member.roomName,
        state: {
          volume: member.volume,
          mute: member.mute,
          equalizer: member.equalizer,
        },
      })),
    });
  }
  return zoneGroups;
}

async function getMaPlayers(maUrl: string, maToken: string | null, force = false) {
  if (!force && Date.now() - maPlayersCache.fetchedAt < MA_PLAYER_CACHE_MS && maPlayersCache.players.length) {
    return maPlayersCache.players;
  }
  const result = await maRequestWithFallbackCommands(maUrl, maToken, [
    { command: "players/all" },
    { command: "players/list" },
    { command: "config/players/get" },
  ]);
  const players = asArray(result);
  maPlayersCache = { fetchedAt: Date.now(), players };
  return players;
}

async function resolveMaPlayerByRoom(maUrl: string, maToken: string | null, room: string) {
  const players = await getMaPlayers(maUrl, maToken);
  const target = room.trim().toLowerCase();
  const byName = players.find((p) =>
    String(p.display_name || p.name || p.room_name || p.roomName || "").trim().toLowerCase() === target
  );
  if (byName) return byName;
  const byIncludes = players.find((p) =>
    String(p.display_name || p.name || p.room_name || p.roomName || "").toLowerCase().includes(target)
  );
  if (byIncludes) return byIncludes;
  return null;
}

function normalizeLibraryItems(result: any): Array<{ name: string; uri: string }> {
  const items = asArray(result);
  return items.map((item: any) => ({
    name: String(item.name || item.title || item.label || "").trim(),
    uri: String(item.uri || item.item_id || item.id || "").trim(),
  })).filter((item) => item.name);
}

async function maPlayUri(
  maUrl: string,
  maToken: string | null,
  playerId: string,
  uri: string,
  enqueue = false,
) {
  const attempts: Array<{ command: string; args: Record<string, unknown> }> = [
    { command: "player_queues/play_media", args: { player_id: playerId, uri, enqueue } },
    { command: "player_queues/play_media", args: { queue_id: playerId, media_uri: uri, enqueue } },
    { command: "player_queues/play_media", args: { player_id: playerId, media: [{ uri }], enqueue } },
    { command: "players/cmd/play_media", args: { player_id: playerId, uri, enqueue } },
    { command: "players/play_media", args: { player_id: playerId, uri, enqueue } },
    { command: "music/play_uri", args: { player_id: playerId, uri, enqueue } },
  ];
  return maRequestWithFallbackCommands(maUrl, maToken, attempts);
}

async function tryMusicAssistantAction(
  body: SonosRequest,
  maUrl: string,
  maToken: string | null,
) {
  const room = body.room?.trim();
  const action = body.action;

  if (action === "getZones") {
    const players = await getMaPlayers(maUrl, maToken, true);
    return buildSonosLikeZonesFromMa(players);
  }

  if (action === "getState") {
    if (!room) throw new Error("Missing room");
    const player = await resolveMaPlayerByRoom(maUrl, maToken, room);
    if (!player) throw new Error(`Room not found in MA: ${room}`);
    const stateResult = await maRequestWithFallbackCommands(maUrl, maToken, [
      { command: "players/get", args: { player_id: player.player_id || player.id } },
      { command: "player/get", args: { player_id: player.player_id || player.id } },
      { command: "config/players/get", args: { player_id: player.player_id || player.id } },
    ]).catch(() => player);
    const normalized = normalizeMaPlayer(stateResult);
    return {
      playbackState: normalized.playbackState,
      elapsedTime: normalized.elapsedTime,
      elapsedTimeFormatted: formatDuration(normalized.elapsedTime),
      currentTrack: normalized.currentTrack,
      equalizer: normalized.equalizer,
      volume: normalized.volume,
      mute: normalized.mute,
    };
  }

  if (action === "pauseall" || action === "resumeall") {
    const players = await getMaPlayers(maUrl, maToken, true);
    const command = action === "pauseall" ? "pause" : "play";
    const controlAttempts = command === "pause"
      ? ["player_queues/pause", "players/cmd/pause", "players/pause"]
      : ["player_queues/play", "players/cmd/play", "players/play"];
    const run = players.map((player: any) =>
      maRequestWithFallbackCommands(
        maUrl,
        maToken,
        controlAttempts.map((cmd) => ({
          command: cmd,
          args: { player_id: player.player_id || player.id, queue_id: player.player_id || player.id },
        })),
      ),
    );
    const results = await Promise.allSettled(run);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    return { status: "success", action, total: players.length, succeeded };
  }

  if (
    [
      "play",
      "pause",
      "playpause",
      "next",
      "previous",
      "volume",
      "mute",
      "unmute",
      "join",
      "leave",
      "spotify-play",
      "playlist",
      "favorite",
      "playlists",
      "favorites",
    ].includes(action)
  ) {
    if ((action !== "playlists" && action !== "favorites") && !room) {
      throw new Error("Missing room");
    }
  }

  if (action === "playlists" || action === "favorites") {
    const result = await maRequestWithFallbackCommands(maUrl, maToken, action === "playlists"
      ? [
        { command: "music/playlists" },
        { command: "music/library/playlists" },
        { command: "playlists/list" },
      ]
      : [
        { command: "music/favorites" },
        { command: "music/library/favorites" },
        { command: "favorites/list" },
      ]);
    return normalizeLibraryItems(result).map((item) => item.name);
  }

  if (action === "playlist" || action === "favorite") {
    if (!body.name) throw new Error("Missing name");
    if (!room) throw new Error("Missing room");
    const player = await resolveMaPlayerByRoom(maUrl, maToken, room);
    if (!player) throw new Error(`Room not found in MA: ${room}`);
    const libraryResult = await maRequestWithFallbackCommands(
      maUrl,
      maToken,
      action === "playlist"
        ? [{ command: "music/playlists" }, { command: "music/library/playlists" }]
        : [{ command: "music/favorites" }, { command: "music/library/favorites" }],
    );
    const items = normalizeLibraryItems(libraryResult);
    const targetName = body.name.trim().toLowerCase();
    const match = items.find((item) => item.name.trim().toLowerCase() === targetName);
    const uri = match?.uri || body.name;
    await maPlayUri(maUrl, maToken, String(player.player_id || player.id), uri, false);
    return { status: "ok", played: body.name, room };
  }

  if (action === "spotify-play") {
    if (!room) throw new Error("Missing room");
    if (!body.uri) throw new Error("Missing uri");
    const player = await resolveMaPlayerByRoom(maUrl, maToken, room);
    if (!player) throw new Error(`Room not found in MA: ${room}`);
    await maPlayUri(
      maUrl,
      maToken,
      String(player.player_id || player.id),
      body.uri,
      !!body.enqueue,
    );
    return { status: "ok", room, uri: body.uri, enqueue: !!body.enqueue };
  }

  const player = room ? await resolveMaPlayerByRoom(maUrl, maToken, room) : null;
  const playerId = player ? String(player.player_id || player.id) : "";
  if (room && !playerId) {
    throw new Error(`Room not found in MA: ${room}`);
  }

  switch (action) {
    case "play":
      return maRequestWithFallbackCommands(maUrl, maToken, [
        { command: "player_queues/play", args: { player_id: playerId, queue_id: playerId } },
        { command: "players/cmd/play", args: { player_id: playerId } },
        { command: "players/play", args: { player_id: playerId } },
      ]);
    case "pause":
      return maRequestWithFallbackCommands(maUrl, maToken, [
        { command: "player_queues/pause", args: { player_id: playerId, queue_id: playerId } },
        { command: "players/cmd/pause", args: { player_id: playerId } },
        { command: "players/pause", args: { player_id: playerId } },
      ]);
    case "playpause":
      return maRequestWithFallbackCommands(maUrl, maToken, [
        { command: "player_queues/play_pause", args: { player_id: playerId, queue_id: playerId } },
        { command: "players/cmd/play_pause", args: { player_id: playerId } },
        { command: "players/play_pause", args: { player_id: playerId } },
      ]);
    case "next":
      return maRequestWithFallbackCommands(maUrl, maToken, [
        { command: "player_queues/next", args: { player_id: playerId, queue_id: playerId } },
        { command: "players/cmd/next", args: { player_id: playerId } },
        { command: "players/next", args: { player_id: playerId } },
      ]);
    case "previous":
      return maRequestWithFallbackCommands(maUrl, maToken, [
        { command: "player_queues/previous", args: { player_id: playerId, queue_id: playerId } },
        { command: "players/cmd/previous", args: { player_id: playerId } },
        { command: "players/previous", args: { player_id: playerId } },
      ]);
    case "volume": {
      if (body.value === undefined || body.value === null) throw new Error("Missing value");
      const value = Number(body.value);
      return maRequestWithFallbackCommands(maUrl, maToken, [
        { command: "players/cmd/volume_set", args: { player_id: playerId, volume_level: value } },
        { command: "players/set_volume", args: { player_id: playerId, volume: value } },
        { command: "player_queues/set_volume", args: { player_id: playerId, volume_level: value } },
      ]);
    }
    case "mute":
    case "unmute": {
      const muteVal = action === "mute";
      return maRequestWithFallbackCommands(maUrl, maToken, [
        { command: "players/cmd/mute", args: { player_id: playerId, muted: muteVal } },
        { command: "players/set_mute", args: { player_id: playerId, mute: muteVal } },
      ]);
    }
    case "join": {
      if (!body.other) throw new Error("Missing other");
      const target = await resolveMaPlayerByRoom(maUrl, maToken, body.other);
      if (!target) throw new Error(`Target room not found in MA: ${body.other}`);
      const targetPlayerId = String(target.player_id || target.id);
      return maRequestWithFallbackCommands(maUrl, maToken, [
        { command: "players/cmd/sync", args: { player_id: playerId, target_player: targetPlayerId } },
        { command: "players/cmd/join", args: { player_id: playerId, target_player: targetPlayerId } },
        { command: "players/join", args: { player_id: playerId, target_player: targetPlayerId } },
      ]);
    }
    case "leave":
      return maRequestWithFallbackCommands(maUrl, maToken, [
        { command: "players/cmd/unsync", args: { player_id: playerId } },
        { command: "players/cmd/leave", args: { player_id: playerId } },
        { command: "players/leave", args: { player_id: playerId } },
      ]);
    default:
      throw new Error(`Action not implemented in MA adapter: ${action}`);
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const token = authHeader.replace("Bearer ", "");

    // Allow trusted internal calls from PAI (service role key = already permission-checked)
    const isInternalCall = token === supabaseServiceKey;
    // Allow pg_cron calls with X-Cron-Secret header
    const cronSecret = Deno.env.get("SCHEDULE_CRON_SECRET");
    const cronHeader = req.headers.get("X-Cron-Secret");
    const isCronCall = !!(cronSecret && cronHeader === cronSecret);
    let userId: string | null = null;

    if (!isInternalCall && !isCronCall) {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return jsonResponse({ error: "Invalid token" }, 401);
      }

      // Check granular permission: control_music
      const { appUser, hasPermission } = await getAppUserWithPermission(supabase, user.id, "control_music");
      userId = appUser?.id ?? null;
      if (!hasPermission) {
        return jsonResponse({ error: "Insufficient permissions" }, 403);
      }
    }

    // Proxy config (Sonos fallback + announce/EQ path)
    const proxyUrl = Deno.env.get("SONOS_PROXY_URL");
    const proxySecret = Deno.env.get("SONOS_PROXY_SECRET");
    const maUrl = Deno.env.get("MUSIC_ASSISTANT_URL");
    const maToken = Deno.env.get("MUSIC_ASSISTANT_TOKEN");
    const useMa = parseBooleanEnv(Deno.env.get("USE_MUSIC_ASSISTANT"), true);

    const body: SonosRequest = await req.json();
    const { action } = body;

    // =============================================
    // Schedule Runner (internal only, called by pg_cron)
    // =============================================
    if (action === "run-schedules") {
      if (!isInternalCall && !isCronCall) {
        return jsonResponse({ error: "Forbidden: internal only" }, 403);
      }
      console.log("Schedule runner: checking for due schedules");

      // Get current time in America/Chicago
      const nowChicago = new Date(
        new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })
      );
      const currentHH = String(nowChicago.getHours()).padStart(2, "0");
      const currentMM = String(nowChicago.getMinutes()).padStart(2, "0");
      const currentTime = `${currentHH}:${currentMM}`;
      // JS getDay(): 0=Sun,1=Mon...6=Sat → convert to 1=Mon...7=Sun for custom_days
      const jsDow = nowChicago.getDay();
      const isoDow = jsDow === 0 ? 7 : jsDow; // 1=Mon...7=Sun
      const isWeekday = isoDow >= 1 && isoDow <= 5;
      const todayDate = `${nowChicago.getFullYear()}-${String(nowChicago.getMonth() + 1).padStart(2, "0")}-${String(nowChicago.getDate()).padStart(2, "0")}`;

      // Find active schedules whose time_of_day is within ±7 minutes of now
      const { data: schedules, error: schedErr } = await supabase
        .from("sonos_schedules")
        .select("*")
        .eq("is_active", true);

      if (schedErr) {
        console.error("Schedule runner: query error", schedErr.message);
        return jsonResponse({ error: schedErr.message }, 500);
      }
      if (!schedules || schedules.length === 0) {
        console.log("Schedule runner: no active schedules");
        return jsonResponse({ status: "ok", fired: 0 });
      }

      const results: Array<{ id: number; name: string; status: string; error?: string }> = [];

      for (const sched of schedules) {
        // Parse schedule time (HH:MM:SS → HH:MM)
        const schedTime = (sched.time_of_day || "").substring(0, 5); // "08:00"
        // Check if within ±7 minute window
        const schedMins = parseInt(schedTime.split(":")[0]) * 60 + parseInt(schedTime.split(":")[1]);
        const nowMins = parseInt(currentHH) * 60 + parseInt(currentMM);
        const diff = Math.abs(schedMins - nowMins);
        if (diff > 7 && diff < (24 * 60 - 7)) {
          continue; // Not due
        }

        // Check recurrence
        let matchesDay = false;
        switch (sched.recurrence) {
          case "daily":
            matchesDay = true;
            break;
          case "weekdays":
            matchesDay = isWeekday;
            break;
          case "weekends":
            matchesDay = !isWeekday;
            break;
          case "custom":
            matchesDay = Array.isArray(sched.custom_days) && sched.custom_days.includes(isoDow);
            break;
          case "once":
            matchesDay = sched.one_time_date === todayDate;
            break;
          default:
            matchesDay = false;
        }
        if (!matchesDay) continue;

        // Idempotency: skip if last_fired_at is within the last 30 minutes
        if (sched.last_fired_at) {
          const lastFired = new Date(sched.last_fired_at);
          const msSinceFired = Date.now() - lastFired.getTime();
          if (msSinceFired < 30 * 60 * 1000) {
            console.log(`Schedule runner: skipping "${sched.name}" (fired ${Math.round(msSinceFired / 60000)}m ago)`);
            continue;
          }
        }

        console.log(`Schedule runner: firing "${sched.name}" → ${sched.source_type} "${sched.playlist_name}" in ${sched.room} at vol ${sched.volume}`);

        try {
          // Step 1: Set volume if specified
          if (sched.volume !== null && sched.volume !== undefined) {
            const volBody: SonosRequest = { action: "volume", room: sched.room, value: sched.volume };
            if (useMa && maUrl) {
              try { await tryMusicAssistantAction(volBody, maUrl, maToken); }
              catch { /* fall through to Sonos below if needed */ }
            }
          }

          // Step 2: Play playlist or favorite
          const playAction = sched.source_type === "favorite" ? "favorite" : "playlist";
          const playBody: SonosRequest = {
            action: playAction as SonosRequest["action"],
            room: sched.room,
            name: sched.playlist_name,
          };

          if (useMa && maUrl) {
            try {
              await tryMusicAssistantAction(playBody, maUrl, maToken);
            } catch (maErr) {
              console.warn(`Schedule runner: MA failed for "${sched.name}", trying Sonos proxy`);
              // Fallback to Sonos proxy
              if (proxyUrl && proxySecret) {
                const encodedRoom = encodeURIComponent(sched.room);
                const encodedName = encodeURIComponent(sched.playlist_name);
                await fetch(`${proxyUrl}/${encodedRoom}/${playAction}/${encodedName}`, {
                  headers: { "X-Sonos-Secret": proxySecret },
                });
              }
            }
          } else if (proxyUrl && proxySecret) {
            const encodedRoom = encodeURIComponent(sched.room);
            const encodedName = encodeURIComponent(sched.playlist_name);
            await fetch(`${proxyUrl}/${encodedRoom}/${playAction}/${encodedName}`, {
              headers: { "X-Sonos-Secret": proxySecret },
            });
          }

          // Step 3: Update last_fired_at
          await supabase
            .from("sonos_schedules")
            .update({ last_fired_at: new Date().toISOString() })
            .eq("id", sched.id);

          // Step 4: Deactivate one-time schedules
          if (sched.recurrence === "once") {
            await supabase
              .from("sonos_schedules")
              .update({ is_active: false })
              .eq("id", sched.id);
          }

          results.push({ id: sched.id, name: sched.name, status: "fired" });
        } catch (err) {
          console.error(`Schedule runner: error firing "${sched.name}":`, (err as Error).message);
          results.push({ id: sched.id, name: sched.name, status: "error", error: (err as Error).message });
        }
      }

      console.log(`Schedule runner: done. Fired ${results.filter(r => r.status === "fired").length}/${results.length} schedules`);
      return jsonResponse({ status: "ok", time: currentTime, date: todayDate, fired: results.length, results });
    }

    const maActions = new Set([
      "getZones",
      "getState",
      "play",
      "pause",
      "playpause",
      "next",
      "previous",
      "volume",
      "mute",
      "unmute",
      "favorite",
      "favorites",
      "playlists",
      "playlist",
      "pauseall",
      "resumeall",
      "join",
      "leave",
      "spotify-play",
    ]);

    if (useMa && maUrl && maActions.has(action)) {
      try {
        const maResult = await tryMusicAssistantAction(body, maUrl, maToken);
        return jsonResponse(maResult, 200);
      } catch (maError) {
        console.warn(`MA routing failed for ${action}, falling back to Sonos:`, (maError as Error).message);
      }
    }

    if (!proxyUrl || !proxySecret) {
      return jsonResponse({ error: "Sonos proxy not configured" }, 500);
    }

    // Build Sonos HTTP API path
    let path = "";
    const room = body.room ? encodeURIComponent(body.room) : null;

    switch (action) {
      case "getZones":
        path = "/zones";
        break;
      case "getState":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        path = `/${room}/state`;
        break;
      case "play":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        path = `/${room}/play`;
        break;
      case "pause":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        path = `/${room}/pause`;
        break;
      case "playpause":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        path = `/${room}/playpause`;
        break;
      case "next":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        path = `/${room}/next`;
        break;
      case "previous":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        path = `/${room}/previous`;
        break;
      case "volume": {
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        const vol = body.value;
        if (vol === undefined || vol === null)
          return jsonResponse({ error: "Missing value" }, 400);
        path = `/${room}/volume/${encodeURIComponent(String(vol))}`;
        break;
      }
      case "mute":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        path = `/${room}/mute`;
        break;
      case "unmute":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        path = `/${room}/unmute`;
        break;
      case "favorite":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        if (!body.name) return jsonResponse({ error: "Missing name" }, 400);
        path = `/${room}/favorite/${encodeURIComponent(body.name)}`;
        break;
      case "favorites":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        path = `/${room}/favorites`;
        break;
      case "playlists":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        path = `/${room}/playlists`;
        break;
      case "playlist":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        if (!body.name) return jsonResponse({ error: "Missing name" }, 400);
        path = `/${room}/playlist/${encodeURIComponent(body.name)}`;
        break;
      case "pauseall":
        path = "/pauseall";
        break;
      case "resumeall":
        path = "/resumeall";
        break;
      case "join":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        if (!body.other) return jsonResponse({ error: "Missing other" }, 400);
        path = `/${room}/join/${encodeURIComponent(body.other)}`;
        break;
      case "leave":
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        path = `/${room}/leave`;
        break;
      case "bass": {
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        const bassVal = body.value;
        if (bassVal === undefined || bassVal === null)
          return jsonResponse({ error: "Missing value" }, 400);
        path = `/${room}/bass/${encodeURIComponent(String(bassVal))}`;
        break;
      }
      case "treble": {
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        const trebleVal = body.value;
        if (trebleVal === undefined || trebleVal === null)
          return jsonResponse({ error: "Missing value" }, 400);
        path = `/${room}/treble/${encodeURIComponent(String(trebleVal))}`;
        break;
      }
      case "loudness": {
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        const loudnessVal = body.value;
        if (loudnessVal === undefined || loudnessVal === null)
          return jsonResponse({ error: "Missing value" }, 400);
        path = `/${room}/loudness/${encodeURIComponent(String(loudnessVal))}`;
        break;
      }
      case "balance": {
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        const balVal = body.value;
        if (balVal === undefined || balVal === null)
          return jsonResponse({ error: "Missing value" }, 400);
        path = `/${room}/balance/${encodeURIComponent(String(balVal))}`;
        break;
      }
      case "announce": {
        if (!body.text) return jsonResponse({ error: "Missing text" }, 400);

        const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
        if (!geminiApiKey) {
          return jsonResponse({ error: "Gemini API key not configured" }, 500);
        }

        const voiceName = body.voice || "Kore";

        // 1. Generate TTS audio via Gemini
        console.log(`Announce: generating TTS for "${body.text}" with voice ${voiceName}`);
        const ttsResponse = await fetch(`${GEMINI_TTS_URL}?key=${geminiApiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: body.text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName },
                },
              },
            },
          }),
        });

        if (!ttsResponse.ok) {
          const errBody = await ttsResponse.text();
          console.error("Gemini TTS error:", ttsResponse.status, errBody);
          return jsonResponse({ error: `TTS generation failed: ${ttsResponse.status}`, detail: errBody.substring(0, 500) }, 500);
        }

        const ttsResult = await ttsResponse.json();

        await logApiUsage(supabase, {
          vendor: "gemini",
          category: "sonos_music_control",
          endpoint: "tts/announce",
          input_tokens: ttsResult.usageMetadata?.promptTokenCount,
          output_tokens: ttsResult.usageMetadata?.candidatesTokenCount,
          units: 1,
          unit_type: "tts_requests",
          estimated_cost_usd: ((ttsResult.usageMetadata?.promptTokenCount || 0) * 0.15 + (ttsResult.usageMetadata?.candidatesTokenCount || 0) * 3.5) / 1_000_000,
          metadata: { voice: voiceName, text_length: body.text!.length },
          app_user_id: userId,
        });

        const audioData = ttsResult.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!audioData) {
          console.error("Gemini TTS: no audio data in response", JSON.stringify(ttsResult).substring(0, 500));
          return jsonResponse({ error: "TTS returned no audio data" }, 500);
        }

        // 2. Convert base64 PCM to WAV
        const pcmBytes = base64ToBytes(audioData);
        const wavHeader = buildWavHeader(pcmBytes.length);
        const wavData = new Uint8Array(wavHeader.length + pcmBytes.length);
        wavData.set(wavHeader, 0);
        wavData.set(pcmBytes, wavHeader.length);

        // 3. Upload WAV to Supabase Storage
        const filename = `${Date.now()}.wav`;
        const storagePath = `${TTS_PREFIX}/${filename}`;
        console.log(`Announce: uploading ${wavData.length} bytes to ${storagePath}`);

        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, wavData, {
            contentType: "audio/wav",
            upsert: true,
          });

        if (uploadError) {
          console.error("Storage upload error:", uploadError.message);
          return jsonResponse({ error: `Upload failed: ${uploadError.message}` }, 500);
        }

        const { data: urlData } = supabase.storage
          .from(STORAGE_BUCKET)
          .getPublicUrl(storagePath);

        const audioUrl = urlData.publicUrl;
        console.log(`Announce: audio URL = ${audioUrl}`);

        // 4. Calculate duration from PCM data (24kHz, 16-bit mono)
        const durationSecs = Math.ceil(pcmBytes.length / (24000 * 2)) + 2;

        // 5. Proxy to Sonos custom action (pass just filename, action constructs full URL)
        const announceVolume = body.volume ?? 40;
        const encodedFilename = encodeURIComponent(filename);

        if (room) {
          // Single room
          path = `/${room}/announceurl/${encodedFilename}/${announceVolume}/${durationSecs}`;
          console.log(`Announce: proxying to ${room}, duration=${durationSecs}s`);
        } else {
          // All rooms: fire announceurl on each zone in parallel
          // (announceurlall/sayall broken due to bridge device issue)
          console.log(`Announce: broadcasting to all zones, duration=${durationSecs}s`);
          const zonesResp = await fetch(`${proxyUrl}/zones`, {
            headers: { "X-Sonos-Secret": proxySecret },
          });
          if (!zonesResp.ok) {
            return jsonResponse({ error: "Failed to fetch Sonos zones" }, 500);
          }
          const zones = await zonesResp.json();
          const announcePromises = zones
            .filter((z: any) => z.coordinator && !z.coordinator.roomName.toLowerCase().includes("bridge"))
            .map((z: any) => {
              const zoneRoom = encodeURIComponent(z.coordinator.roomName);
              return fetch(`${proxyUrl}/${zoneRoom}/announceurl/${encodedFilename}/${announceVolume}/${durationSecs}`, {
                headers: { "X-Sonos-Secret": proxySecret },
              });
            });
          const results = await Promise.allSettled(announcePromises);
          const succeeded = results.filter((r) => r.status === "fulfilled").length;
          const failed = results.filter((r) => r.status === "rejected").length;
          console.log(`Announce: broadcast complete, ${succeeded} succeeded, ${failed} failed`);
          return jsonResponse({ status: "success", zones: succeeded, failed });
        }
        break;
      }

      case "spotify-search": {
        const query = body.query;
        if (!query) return jsonResponse({ error: "Missing query" }, 400);
        const searchType = body.searchType || "track";
        const limit = Math.min(body.limit || 10, 20);
        // Map UI types to Spotify API types
        const typeMap: Record<string, string> = {
          song: "track",
          track: "track",
          album: "album",
          playlist: "playlist",
          artist: "artist",
        };
        const spotifyType = typeMap[searchType] || "track";
        try {
          const token = await getSpotifyToken(supabase);
          const params = new URLSearchParams({
            q: query,
            type: spotifyType,
            limit: String(limit),
            market: "US",
          });
          const searchResp = await fetch(
            `https://api.spotify.com/v1/search?${params}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!searchResp.ok) {
            const errText = await searchResp.text();
            console.error("Spotify search error:", searchResp.status, errText);
            return jsonResponse({ error: `Spotify search failed: ${searchResp.status}` }, searchResp.status);
          }
          const searchData = await searchResp.json();
          // Normalize results based on type
          let results: any[] = [];
          if (spotifyType === "track" && searchData.tracks) {
            results = searchData.tracks.items.map((t: any) => ({
              title: t.name,
              artist: t.artists?.map((a: any) => a.name).join(", ") || "",
              album: t.album?.name || "",
              albumArt: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || "",
              duration: formatDuration(t.duration_ms),
              durationMs: t.duration_ms,
              uri: t.uri,
              id: t.id,
            }));
          } else if (spotifyType === "album" && searchData.albums) {
            results = searchData.albums.items.map((a: any) => ({
              title: a.name,
              artist: a.artists?.map((ar: any) => ar.name).join(", ") || "",
              album: a.name,
              albumArt: a.images?.[2]?.url || a.images?.[0]?.url || "",
              duration: `${a.total_tracks} tracks`,
              uri: a.uri,
              id: a.id,
            }));
          } else if (spotifyType === "playlist" && searchData.playlists) {
            results = searchData.playlists.items.map((p: any) => ({
              title: p.name,
              artist: p.owner?.display_name || "",
              album: "",
              albumArt: p.images?.[2]?.url || p.images?.[0]?.url || "",
              duration: `${p.tracks?.total || 0} tracks`,
              uri: p.uri,
              id: p.id,
            }));
          } else if (spotifyType === "artist" && searchData.artists) {
            results = searchData.artists.items.map((ar: any) => ({
              title: ar.name,
              artist: ar.name,
              album: "",
              albumArt: ar.images?.[2]?.url || ar.images?.[0]?.url || "",
              duration: `${(ar.followers?.total || 0).toLocaleString()} followers`,
              uri: ar.uri,
              id: ar.id,
            }));
          }
          await logApiUsage(supabase, {
            vendor: "spotify",
            category: "sonos_music_control",
            endpoint: "search",
            units: 1,
            unit_type: "api_calls",
            estimated_cost_usd: 0,
            metadata: { query, searchType: spotifyType, results_count: results.length },
            app_user_id: userId,
          });
          return jsonResponse({ results, total: results.length });
        } catch (err) {
          console.error("Spotify search error:", err.message);
          return jsonResponse({ error: err.message }, 500);
        }
      }

      case "musicsearch": {
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        const service = body.service || "spotify";
        const searchType = body.searchType || "song";
        const query = body.query;
        if (!query) return jsonResponse({ error: "Missing query" }, 400);
        const allowedServices = ["spotify", "apple", "deezer", "library"];
        const allowedTypes = ["song", "album", "playlist", "station"];
        if (!allowedServices.includes(service))
          return jsonResponse({ error: `Invalid service: ${service}` }, 400);
        if (!allowedTypes.includes(searchType))
          return jsonResponse({ error: `Invalid type: ${searchType}` }, 400);
        path = `/${room}/musicsearch/${encodeURIComponent(service)}/${encodeURIComponent(searchType)}/${encodeURIComponent(query)}`;
        break;
      }

      case "spotify-play": {
        if (!room) return jsonResponse({ error: "Missing room" }, 400);
        const spotifyUri = body.uri;
        if (!spotifyUri) return jsonResponse({ error: "Missing uri" }, 400);
        // Validate it's a spotify URI
        if (!spotifyUri.startsWith("spotify:"))
          return jsonResponse({ error: "Invalid Spotify URI" }, 400);
        // "now" replaces queue, "queue" appends
        const mode = body.enqueue ? "queue" : "now";
        path = `/${room}/spotify/${mode}/${encodeURIComponent(spotifyUri)}`;
        break;
      }

      case "tts_preview": {
        // Generate TTS audio and return the URL — no Sonos playback
        if (!body.text) return jsonResponse({ error: "Missing text" }, 400);

        const previewGeminiKey = Deno.env.get("GEMINI_API_KEY");
        if (!previewGeminiKey) {
          return jsonResponse({ error: "Gemini API key not configured" }, 500);
        }

        const previewVoice = body.voice || "Sulafat";

        console.log(`TTS Preview: generating for "${body.text}" with voice ${previewVoice}`);
        const previewTtsResp = await fetch(`${GEMINI_TTS_URL}?key=${previewGeminiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: body.text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: previewVoice },
                },
              },
            },
          }),
        });

        if (!previewTtsResp.ok) {
          const errBody = await previewTtsResp.text();
          return jsonResponse({ error: `TTS failed: ${previewTtsResp.status}`, detail: errBody.substring(0, 500) }, 500);
        }

        const previewResult = await previewTtsResp.json();
        const previewAudioData = previewResult.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!previewAudioData) {
          return jsonResponse({ error: "TTS returned no audio data" }, 500);
        }

        // Convert PCM to WAV
        const previewPcm = base64ToBytes(previewAudioData);
        const previewWavHeader = buildWavHeader(previewPcm.length);
        const previewWav = new Uint8Array(previewWavHeader.length + previewPcm.length);
        previewWav.set(previewWavHeader, 0);
        previewWav.set(previewPcm, previewWavHeader.length);

        // Upload to storage
        const previewFilename = `preview-${Date.now()}.wav`;
        const previewPath = `${TTS_PREFIX}/${previewFilename}`;

        const { error: previewUploadErr } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(previewPath, previewWav, {
            contentType: "audio/wav",
            upsert: true,
          });

        if (previewUploadErr) {
          return jsonResponse({ error: `Upload failed: ${previewUploadErr.message}` }, 500);
        }

        const { data: previewUrlData } = supabase.storage
          .from(STORAGE_BUCKET)
          .getPublicUrl(previewPath);

        await logApiUsage(supabase, {
          vendor: "gemini",
          category: "sonos_music_control",
          endpoint: "tts/preview",
          input_tokens: previewResult.usageMetadata?.promptTokenCount,
          output_tokens: previewResult.usageMetadata?.candidatesTokenCount,
          units: 1,
          unit_type: "tts_requests",
          estimated_cost_usd: ((previewResult.usageMetadata?.promptTokenCount || 0) * 0.15 + (previewResult.usageMetadata?.candidatesTokenCount || 0) * 3.5) / 1_000_000,
          metadata: { voice: previewVoice, text_length: body.text!.length },
          app_user_id: userId,
        });

        return jsonResponse({
          status: "success",
          audio_url: previewUrlData.publicUrl,
          duration_secs: Math.ceil(previewPcm.length / (24000 * 2)),
        });
      }

      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400);
    }

    // Forward to Sonos proxy on DO droplet
    console.log(`Sonos proxy → ${proxyUrl}${path}`);
    const sonosResponse = await fetch(`${proxyUrl}${path}`, {
      headers: { "X-Sonos-Secret": proxySecret },
    });

    const result = await sonosResponse.text();
    console.log(`Sonos proxy ← ${sonosResponse.status}: ${result.substring(0, 300)}`);

    // Try to parse as JSON, fall back to wrapping as text
    try {
      const json = JSON.parse(result);
      if (!sonosResponse.ok) {
        // Normalize error to a string so clients don't get [object Object]
        const errMsg = typeof json.error === "string" ? json.error
          : json.message || json.response || result.substring(0, 200);
        return jsonResponse({ error: errMsg }, sonosResponse.status);
      }
      return jsonResponse(json, 200);
    } catch {
      return jsonResponse(
        { status: sonosResponse.ok ? "ok" : "error", response: result },
        sonosResponse.ok ? 200 : sonosResponse.status
      );
    }
  } catch (error) {
    console.error("Sonos control error:", error.message);
    return jsonResponse({ error: error.message }, 500);
  }
});
