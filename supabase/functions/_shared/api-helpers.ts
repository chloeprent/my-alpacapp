/**
 * API Helpers — shared utilities for the YOUR_APP_NAME Internal REST API.
 *
 * Auth resolution, response builders, query helpers, and smart lookups.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { ROLE_LEVELS, PERMISSIONS, type ApiAction, type PermissionEntry } from "./api-permissions.ts";

// ─── Types ──────────────────────────────────────────────────────────

export interface ApiRequest {
  resource: string;
  action: ApiAction;
  id?: string;
  data?: Record<string, any>;
  filters?: Record<string, any>;
  limit?: number;
  offset?: number;
  order_by?: string;
  order_dir?: "asc" | "desc";
}

export interface ResolvedAuth {
  appUser: any | null;
  userLevel: number;
  authMethod: "jwt" | "service_key" | "api_key" | "none";
  /** API-key-only: whitelist of allowed resources (null = all) */
  allowedResources?: string[] | null;
  /** API-key-only: whitelist of allowed actions (null = all) */
  allowedActions?: string[] | null;
  /** API-key-only: per-resource columns to strip from response */
  excludedColumns?: Record<string, string[]>;
}

// ─── CORS ───────────────────────────────────────────────────────────

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Response builders ──────────────────────────────────────────────

export function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function success(data: any, count?: number): Response {
  const body: any = { data, error: null };
  if (count !== undefined) body.count = count;
  return jsonResponse(body);
}

export function error(message: string, code: number): Response {
  return jsonResponse({ data: null, error: message, code }, code);
}

// ─── Auth resolution ────────────────────────────────────────────────

/**
 * Resolve the caller to an app_user and role level.
 * Supports: Bearer JWT, service role key, future X-API-Key.
 */
export async function resolveAuth(
  req: Request,
  supabase: SupabaseClient
): Promise<ResolvedAuth> {
  const authHeader = req.headers.get("Authorization");
  const apiKeyHeader = req.headers.get("X-API-Key");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1. Service role key → oracle level (internal callers like PAI, workers)
  const token = authHeader?.replace("Bearer ", "") ?? "";
  if (token === serviceKey) {
    return {
      appUser: { id: "__service__", role: "oracle", display_name: "Service" },
      userLevel: 4,
      authMethod: "service_key",
    };
  }

  // 2. X-API-Key header → look up api_keys table (hashed)
  if (apiKeyHeader) {
    const keyHash = await sha256(apiKeyHeader);
    const { data: apiKey } = await supabase
      .from("api_keys")
      .select("id, name, permission_level, allowed_resources, allowed_actions, excluded_columns, is_active")
      .eq("key_hash", keyHash)
      .maybeSingle();

    if (!apiKey || !apiKey.is_active) {
      return { appUser: null, userLevel: -1, authMethod: "api_key" };
    }

    // Update last_used_at (non-blocking)
    supabase.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", apiKey.id).then();

    return {
      appUser: { id: `__apikey_${apiKey.id}__`, role: "api_key", display_name: apiKey.name },
      userLevel: apiKey.permission_level,
      authMethod: "api_key",
      allowedResources: apiKey.allowed_resources || null,
      allowedActions: apiKey.allowed_actions || null,
      excludedColumns: apiKey.excluded_columns || {},
    };
  }

  // 3. Bearer JWT → resolve user
  if (authHeader && token) {
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return { appUser: null, userLevel: -1, authMethod: "jwt" };
    }

    const { data: appUser } = await supabase
      .from("app_users")
      .select("id, auth_user_id, role, display_name, email, person_id, first_name, last_name, phone")
      .eq("auth_user_id", user.id)
      .single();

    if (!appUser) {
      return { appUser: null, userLevel: -1, authMethod: "jwt" };
    }

    return {
      appUser,
      userLevel: ROLE_LEVELS[appUser.role] ?? 0,
      authMethod: "jwt",
    };
  }

  // 4. No auth → level 0 (public)
  return { appUser: null, userLevel: 0, authMethod: "none" };
}

// ─── Permission check ───────────────────────────────────────────────

export function checkPermission(
  resource: string,
  action: string,
  userLevel: number
): { allowed: boolean; permission?: PermissionEntry } {
  const resourcePerms = PERMISSIONS[resource];
  if (!resourcePerms) return { allowed: false };

  const perm = resourcePerms[action];
  if (!perm) return { allowed: false };

  return { allowed: userLevel >= perm.minLevel, permission: perm };
}

// ─── Smart lookup helpers ───────────────────────────────────────────

/**
 * Fuzzy-match a person name → people record.
 * Tries exact match first, then ilike prefix, then word-boundary search.
 */
export async function fuzzyPersonLookup(
  supabase: SupabaseClient,
  name: string
): Promise<any | null> {
  if (!name?.trim()) return null;
  const normalized = name.trim();

  // Try exact full-name match
  const { data: exact } = await supabase
    .from("people")
    .select("id, first_name, last_name, email, phone")
    .ilike("first_name", normalized)
    .limit(1)
    .maybeSingle();
  if (exact) return exact;

  // Try first_name || ' ' || last_name ilike
  const { data: fullMatch } = await supabase
    .from("people")
    .select("id, first_name, last_name, email, phone")
    .or(`first_name.ilike.%${normalized}%,last_name.ilike.%${normalized}%`)
    .limit(5);

  if (fullMatch?.length === 1) return fullMatch[0];
  if (fullMatch?.length) {
    // Prefer best match
    const best = fullMatch.find((p: any) =>
      `${p.first_name} ${p.last_name}`.toLowerCase().includes(normalized.toLowerCase())
    );
    return best || fullMatch[0];
  }

  return null;
}

/**
 * Fuzzy-match a space name → spaces record.
 * Case-insensitive partial match on name.
 */
export async function fuzzySpaceLookup(
  supabase: SupabaseClient,
  name: string
): Promise<any | null> {
  if (!name?.trim()) return null;

  const { data } = await supabase
    .from("spaces")
    .select("id, name, type, parent_id")
    .ilike("name", `%${name.trim()}%`)
    .eq("is_archived", false)
    .limit(5);

  if (!data?.length) return null;
  if (data.length === 1) return data[0];

  // Prefer exact match, then shortest name (most specific)
  const exact = data.find((s: any) =>
    s.name.toLowerCase() === name.trim().toLowerCase()
  );
  if (exact) return exact;

  return data.sort((a: any, b: any) => a.name.length - b.name.length)[0];
}

/**
 * Resolve assigned_name to a person and optionally an app_user.
 */
export async function resolveAssignee(
  supabase: SupabaseClient,
  assignedName: string
): Promise<{ assigned_name: string; assigned_to: string | null }> {
  if (!assignedName?.trim()) {
    return { assigned_name: "", assigned_to: null };
  }

  // Check if it's already a user ID
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(assignedName.trim())) {
    const { data: user } = await supabase
      .from("app_users")
      .select("id, display_name")
      .eq("id", assignedName.trim())
      .single();
    if (user) {
      return { assigned_name: user.display_name, assigned_to: user.id };
    }
  }

  // Try to find an app_user with matching display_name
  const { data: userMatch } = await supabase
    .from("app_users")
    .select("id, display_name")
    .ilike("display_name", `%${assignedName.trim()}%`)
    .limit(1)
    .maybeSingle();

  if (userMatch) {
    return { assigned_name: userMatch.display_name, assigned_to: userMatch.id };
  }

  // Fall back to name-only assignment
  return { assigned_name: assignedName.trim(), assigned_to: null };
}

// ─── Query builder helpers ──────────────────────────────────────────

/**
 * Apply standard pagination, ordering, and common filters to a query.
 */
export function applyPagination(
  query: any,
  req: ApiRequest,
  defaultOrderBy = "created_at",
  defaultDir: "asc" | "desc" = "desc"
): any {
  const orderBy = req.order_by || defaultOrderBy;
  const orderDir = req.order_dir || defaultDir;
  const limit = Math.min(req.limit || 100, 500);
  const offset = req.offset || 0;

  query = query.order(orderBy, { ascending: orderDir === "asc" });
  query = query.range(offset, offset + limit - 1);

  return query;
}

// ─── API usage logging ──────────────────────────────────────────────

export async function logApiUsage(
  supabase: SupabaseClient,
  resource: string,
  action: string,
  appUser: any
): Promise<void> {
  try {
    await supabase.from("api_usage_log").insert({
      vendor: "your-app_api",
      category: `api_${resource}_${action}`,
      endpoint: `${resource}/${action}`,
      units: 1,
      unit_type: "api_calls",
      estimated_cost_usd: 0,
      metadata: {
        caller: appUser?.display_name || "anonymous",
        role: appUser?.role || "none",
      },
      app_user_id: appUser?.id && appUser.id !== "__service__" ? appUser.id : null,
    });
  } catch (_e) {
    // Non-critical — don't fail the request
  }
}

// ─── Crypto helpers ─────────────────────────────────────────────────

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Column filtering for API key restrictions ──────────────────────

/**
 * Strip excluded columns from API response data.
 * Used to enforce API key column-level restrictions.
 */
export function stripExcludedColumns(
  data: any,
  resource: string,
  excludedColumns?: Record<string, string[]>
): any {
  if (!excludedColumns || !excludedColumns[resource]?.length) return data;

  const cols = excludedColumns[resource];

  const stripRow = (row: any) => {
    if (!row || typeof row !== "object") return row;
    const filtered = { ...row };
    for (const col of cols) {
      delete filtered[col];
    }
    return filtered;
  };

  if (Array.isArray(data)) return data.map(stripRow);
  return stripRow(data);
}

/**
 * Check if the API key is allowed to access the given resource/action.
 * Returns an error message if blocked, or null if allowed.
 */
export function checkApiKeyRestrictions(
  auth: ResolvedAuth,
  resource: string,
  action: string
): string | null {
  if (auth.authMethod !== "api_key") return null;

  if (auth.allowedResources && !auth.allowedResources.includes(resource)) {
    return `API key "${auth.appUser?.display_name}" does not have access to resource "${resource}"`;
  }

  if (auth.allowedActions && !auth.allowedActions.includes(action)) {
    return `API key "${auth.appUser?.display_name}" does not have permission for action "${action}"`;
  }

  return null;
}
