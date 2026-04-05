/**
 * YOUR_APP_NAME Internal REST API
 *
 * Single edge function that acts as a centralized, permissioned gateway
 * for all entity CRUD operations. Replaces ad-hoc Supabase queries scattered
 * across PAI tools, frontend code, and worker scripts.
 *
 * Deploy: supabase functions deploy api --no-verify-jwt
 *
 * Request:  POST /functions/v1/api
 *   Body:   { resource, action, id?, data?, filters?, limit?, offset?, order_by?, order_dir? }
 *   Auth:   Bearer <JWT> | Bearer <service_role_key> | X-API-Key (future)
 *
 * Response: { data, count?, error?, code? }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  PERMISSIONS,
  PROFILE_EDITABLE_FIELDS,
} from "../_shared/api-permissions.ts";
import {
  type ApiRequest,
  type ResolvedAuth,
  corsHeaders,
  jsonResponse,
  success,
  error,
  resolveAuth,
  checkPermission,
  checkApiKeyRestrictions,
  stripExcludedColumns,
  fuzzyPersonLookup,
  fuzzySpaceLookup,
  resolveAssignee,
  applyPagination,
  logApiUsage,
} from "../_shared/api-helpers.ts";

// ─── Main handler ───────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return error("Method not allowed. Use POST.", 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const body: ApiRequest = await req.json();
    const { resource, action } = body;

    if (!resource || !action) {
      return error("Missing required fields: resource, action", 400);
    }

    // Validate resource exists
    if (!PERMISSIONS[resource]) {
      return error(`Unknown resource: ${resource}`, 400);
    }

    // Validate action exists for this resource
    if (!PERMISSIONS[resource][action]) {
      return error(`Action '${action}' not supported for resource '${resource}'`, 400);
    }

    // Resolve auth
    const auth = await resolveAuth(req, supabase);
    if (auth.userLevel < 0) {
      return error("Invalid or expired authentication token", 401);
    }

    // Check API key resource/action restrictions (before permission check)
    const apiKeyError = checkApiKeyRestrictions(auth, resource, action);
    if (apiKeyError) {
      return error(apiKeyError, 403);
    }

    // Check permission
    const { allowed, permission } = checkPermission(resource, action, auth.userLevel);
    if (!allowed) {
      return error("Forbidden", 403);
    }

    // Route to handler
    const handler = RESOURCE_HANDLERS[resource];
    if (!handler) {
      return error(`Resource handler not implemented: ${resource}`, 501);
    }

    const result = await handler(supabase, body, auth, permission!);

    // Strip excluded columns for API key callers
    if (auth.authMethod === "api_key" && auth.excludedColumns && result.ok) {
      try {
        const originalBody = await result.clone().json();
        if (originalBody?.data) {
          originalBody.data = stripExcludedColumns(
            originalBody.data, resource, auth.excludedColumns
          );
          return jsonResponse(originalBody, result.status);
        }
      } catch (_) {
        // If response parsing fails, return original
      }
    }

    // Log usage (fire-and-forget)
    logApiUsage(supabase, resource, action, auth.appUser);

    return result;
  } catch (err) {
    console.error("API error:", err.message, err.stack);
    return error(err.message || "Internal server error", 500);
  }
});

// ─── Handler type ───────────────────────────────────────────────────

type ResourceHandler = (
  supabase: any,
  req: ApiRequest,
  auth: { appUser: any; userLevel: number },
  permission: { minLevel: number; rowScoped?: boolean; staffFields?: string[] }
) => Promise<Response>;

// ─── Resource handler registry ──────────────────────────────────────

const RESOURCE_HANDLERS: Record<string, ResourceHandler> = {
  spaces: handleSpaces,
  people: handlePeople,
  assignments: handleAssignments,
  tasks: handleTasks,
  users: handleUsers,
  profile: handleProfile,
  vehicles: handleVehicles,
  media: handleMedia,
  payments: handlePayments,
  bug_reports: handleBugReports,
  time_entries: handleTimeEntries,
  events: handleEvents,
  documents: handleDocuments,
  sms: handleSms,
  faq: handleFaq,
  invitations: handleInvitations,
  password_vault: handlePasswordVault,
  feature_requests: handleFeatureRequests,
  pai_config: handlePaiConfig,
  tesla_accounts: handleTeslaAccounts,
};

// =====================================================================
// RESOURCE HANDLERS
// =====================================================================

// ─── spaces ─────────────────────────────────────────────────────────

async function handleSpaces(supabase: any, req: ApiRequest, auth: any, perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("spaces")
        .select("*, media_spaces(display_order, is_primary, media:media_id(id, url, caption))", { count: "exact" })
        .eq("is_archived", false);

      // Public/resident users only see listed, non-secret spaces
      if (auth.userLevel < 2) {
        query = query.eq("is_listed", true).eq("is_secret", false);
      }

      // Filters
      if (req.filters?.type) query = query.eq("type", req.filters.type);
      if (req.filters?.can_be_dwelling !== undefined) query = query.eq("can_be_dwelling", req.filters.can_be_dwelling);
      if (req.filters?.can_be_event !== undefined) query = query.eq("can_be_event", req.filters.can_be_event);
      if (req.filters?.parent_id) query = query.eq("parent_id", req.filters.parent_id);
      if (req.filters?.search) query = query.ilike("name", `%${req.filters.search}%`);

      query = applyPagination(query, req, "name", "asc");

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      let query = supabase
        .from("spaces")
        .select("*, media_spaces(display_order, is_primary, media:media_id(id, url, caption))")
        .eq("id", req.id);

      if (auth.userLevel < 2) {
        query = query.eq("is_listed", true).eq("is_secret", false);
      }

      const { data, error: err } = await query.single();
      if (err) return error("Space not found", 404);
      return success(data);
    }

    case "create": {
      const { data, error: err } = await supabase
        .from("spaces")
        .insert(req.data)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      // Staff can only update certain fields
      let payload = req.data || {};
      if (auth.userLevel < 3 && perm.staffFields) {
        payload = Object.fromEntries(
          Object.entries(payload).filter(([k]) => perm.staffFields!.includes(k))
        );
      }
      const { data, error: err } = await supabase
        .from("spaces")
        .update(payload)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      // Soft delete
      const { data, error: err } = await supabase
        .from("spaces")
        .update({ is_archived: true })
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success(data);
    }
  }
  return error("Unknown action", 400);
}

// ─── people ─────────────────────────────────────────────────────────

async function handlePeople(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("people")
        .select("*", { count: "exact" });

      if (req.filters?.type) query = query.eq("type", req.filters.type);
      if (req.filters?.search) {
        query = query.or(
          `first_name.ilike.%${req.filters.search}%,last_name.ilike.%${req.filters.search}%,email.ilike.%${req.filters.search}%`
        );
      }
      if (req.filters?.phone) {
        const digits = req.filters.phone.replace(/\D/g, "").slice(-10);
        query = query.ilike("phone", `%${digits}%`);
      }
      if (req.filters?.email) {
        query = query.ilike("email", req.filters.email);
      }

      query = applyPagination(query, req, "last_name", "asc");

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("people")
        .select("*")
        .eq("id", req.id)
        .single();
      if (err) return error("Person not found", 404);
      return success(data);
    }

    case "create": {
      if (!req.data?.first_name && !req.data?.last_name) {
        return error("Validation: first_name or last_name is required", 400);
      }

      // Duplicate prevention: check by email, then by exact name match
      if (req.data.email) {
        const { data: emailMatch } = await supabase
          .from("people")
          .select("id, first_name, last_name, email, type")
          .ilike("email", req.data.email)
          .limit(1)
          .maybeSingle();
        if (emailMatch) {
          return error(
            `Duplicate: a person with email "${req.data.email}" already exists (${emailMatch.first_name} ${emailMatch.last_name}, type=${emailMatch.type}, id=${emailMatch.id}). Use action "update" with this id instead.`,
            409
          );
        }
      }
      if (req.data.first_name && req.data.last_name && !req.data.skip_dedup) {
        const { data: nameMatch } = await supabase
          .from("people")
          .select("id, first_name, last_name, email, type")
          .ilike("first_name", req.data.first_name)
          .ilike("last_name", req.data.last_name)
          .limit(1)
          .maybeSingle();
        if (nameMatch) {
          return error(
            `Possible duplicate: a person named "${nameMatch.first_name} ${nameMatch.last_name}" already exists (type=${nameMatch.type}, id=${nameMatch.id}). If this is a different person, pass "skip_dedup": true in data. Otherwise use action "update" with this id.`,
            409
          );
        }
      }

      // Allow explicit bypass for intentional same-name people
      const insertData = { ...req.data };
      delete insertData.skip_dedup;

      const { data, error: err } = await supabase
        .from("people")
        .insert(insertData)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("people")
        .update(req.data)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      const { error: err } = await supabase.from("people").delete().eq("id", req.id);
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success({ deleted: true });
    }
  }
  return error("Unknown action", 400);
}

// ─── assignments ────────────────────────────────────────────────────

async function handleAssignments(supabase: any, req: ApiRequest, auth: any, perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("assignments")
        .select("*, person:person_id(id, first_name, last_name), assignment_spaces(space_id, space:space_id(id, name))", { count: "exact" });

      // Row scoping: residents only see their own assignments
      if (perm.rowScoped && auth.userLevel < 2 && auth.appUser?.person_id) {
        query = query.eq("person_id", auth.appUser.person_id);
      } else if (perm.rowScoped && auth.userLevel < 2) {
        return success([], 0);
      }

      if (req.filters?.status) query = query.eq("status", req.filters.status);
      if (req.filters?.person_id) query = query.eq("person_id", req.filters.person_id);
      if (req.filters?.space_id) {
        // Filter by space via assignment_spaces junction
        const { data: junctionData } = await supabase
          .from("assignment_spaces")
          .select("assignment_id")
          .eq("space_id", req.filters.space_id);
        const assignmentIds = (junctionData || []).map((j: any) => j.assignment_id);
        if (!assignmentIds.length) return success([], 0);
        query = query.in("id", assignmentIds);
      }
      if (req.filters?.active) {
        query = query.in("status", ["active", "pending_contract", "contract_sent"]);
      }

      query = applyPagination(query, req, "start_date", "desc");

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);

      // Compute is_current and available_date
      const today = new Date().toISOString().split("T")[0];
      const enriched = (data || []).map((a: any) => {
        const isCurrent = a.status === "active" && (!a.end_date || a.end_date >= today) && (!a.start_date || a.start_date <= today);
        const availableDate = (a.desired_departure_listed && a.desired_departure_date) || a.end_date;
        return { ...a, is_current: isCurrent, available_date: availableDate };
      });

      return success(enriched, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      let query = supabase
        .from("assignments")
        .select("*, person:person_id(id, first_name, last_name), assignment_spaces(space_id, space:space_id(id, name))")
        .eq("id", req.id);

      if (perm.rowScoped && auth.userLevel < 2 && auth.appUser?.person_id) {
        query = query.eq("person_id", auth.appUser.person_id);
      }

      const { data, error: err } = await query.single();
      if (err) return error("Assignment not found", 404);
      return success(data);
    }

    case "create": {
      const assignmentData = { ...req.data };
      const spaceIds = assignmentData.space_ids;
      delete assignmentData.space_ids;

      const { data: assignment, error: err } = await supabase
        .from("assignments")
        .insert(assignmentData)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);

      // Link spaces
      if (spaceIds?.length) {
        const links = spaceIds.map((sid: string) => ({
          assignment_id: assignment.id,
          space_id: sid,
        }));
        await supabase.from("assignment_spaces").insert(links);
      }

      return success(assignment);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const updateData = { ...req.data };
      const spaceIds = updateData.space_ids;
      delete updateData.space_ids;

      if (Object.keys(updateData).length) {
        const { error: err } = await supabase
          .from("assignments")
          .update(updateData)
          .eq("id", req.id);
        if (err) return error(`Update failed: ${err.message}`, 400);
      }

      // Update space links if provided
      if (spaceIds !== undefined) {
        await supabase.from("assignment_spaces").delete().eq("assignment_id", req.id);
        if (spaceIds?.length) {
          const links = spaceIds.map((sid: string) => ({
            assignment_id: req.id,
            space_id: sid,
          }));
          await supabase.from("assignment_spaces").insert(links);
        }
      }

      // Re-fetch with joins
      const { data } = await supabase
        .from("assignments")
        .select("*, person:person_id(id, first_name, last_name), assignment_spaces(space_id, space:space_id(id, name))")
        .eq("id", req.id)
        .single();
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      await supabase.from("assignment_spaces").delete().eq("assignment_id", req.id);
      const { error: err } = await supabase.from("assignments").delete().eq("id", req.id);
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success({ deleted: true });
    }
  }
  return error("Unknown action", 400);
}

// ─── tasks ──────────────────────────────────────────────────────────

async function handleTasks(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("tasks")
        .select("*, space:space_id(id, name)", { count: "exact" });

      if (req.filters?.status && req.filters.status !== "all") {
        query = query.eq("status", req.filters.status);
      }
      if (req.filters?.priority) query = query.eq("priority", req.filters.priority);
      if (req.filters?.assigned_to) query = query.eq("assigned_to", req.filters.assigned_to);
      if (req.filters?.assigned_name) {
        query = query.ilike("assigned_name", `%${req.filters.assigned_name}%`);
      }
      if (req.filters?.space_id) query = query.eq("space_id", req.filters.space_id);
      if (req.filters?.search) {
        query = query.or(`title.ilike.%${req.filters.search}%,notes.ilike.%${req.filters.search}%,description.ilike.%${req.filters.search}%`);
      }
      // Fuzzy space name filter
      if (req.filters?.space_name) {
        const space = await fuzzySpaceLookup(supabase, req.filters.space_name);
        if (space) query = query.eq("space_id", space.id);
      }

      query = applyPagination(query, req, "created_at", "desc");

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("tasks")
        .select("*, space:space_id(id, name)")
        .eq("id", req.id)
        .single();
      if (err) return error("Task not found", 404);
      return success(data);
    }

    case "create": {
      if (!req.data?.title) return error("Validation: title is required", 400);

      const payload: any = {
        title: req.data.title,
        notes: req.data.notes || null,
        description: req.data.description || null,
        priority: req.data.priority || null,
        status: req.data.status || "open",
        location_label: req.data.location_label || null,
      };

      // Resolve space from name or id
      if (req.data.space_id) {
        payload.space_id = req.data.space_id;
      } else if (req.data.space_name) {
        const space = await fuzzySpaceLookup(supabase, req.data.space_name);
        if (space) payload.space_id = space.id;
      }

      // Resolve assignee from name or id
      if (req.data.assigned_to) {
        payload.assigned_to = req.data.assigned_to;
        payload.assigned_name = req.data.assigned_name || null;
      } else if (req.data.assigned_name) {
        const resolved = await resolveAssignee(supabase, req.data.assigned_name);
        payload.assigned_to = resolved.assigned_to;
        payload.assigned_name = resolved.assigned_name;
      }

      const { data, error: err } = await supabase
        .from("tasks")
        .insert(payload)
        .select("*, space:space_id(id, name)")
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);

      const payload: any = { updated_at: new Date().toISOString() };

      if ("title" in (req.data || {})) payload.title = req.data!.title;
      if ("notes" in (req.data || {})) payload.notes = req.data!.notes || null;
      if ("description" in (req.data || {})) payload.description = req.data!.description || null;
      if ("priority" in (req.data || {})) payload.priority = req.data!.priority || null;
      if ("location_label" in (req.data || {})) payload.location_label = req.data!.location_label || null;

      // Resolve space
      if ("space_id" in (req.data || {})) {
        payload.space_id = req.data!.space_id || null;
      } else if ("space_name" in (req.data || {})) {
        const space = await fuzzySpaceLookup(supabase, req.data!.space_name);
        payload.space_id = space?.id || null;
      }

      // Resolve assignee
      if ("assigned_to" in (req.data || {})) {
        payload.assigned_to = req.data!.assigned_to || null;
        if ("assigned_name" in (req.data || {})) payload.assigned_name = req.data!.assigned_name || null;
      } else if ("assigned_name" in (req.data || {})) {
        const resolved = await resolveAssignee(supabase, req.data!.assigned_name);
        payload.assigned_to = resolved.assigned_to;
        payload.assigned_name = resolved.assigned_name;
      }

      // Status-driven timestamps
      if ("status" in (req.data || {})) {
        payload.status = req.data!.status;
        if (req.data!.status === "done") {
          payload.completed_at = new Date().toISOString();
        } else {
          payload.completed_at = null;
        }
      }

      const { data, error: err } = await supabase
        .from("tasks")
        .update(payload)
        .eq("id", req.id)
        .select("*, space:space_id(id, name)")
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      const { error: err } = await supabase.from("tasks").delete().eq("id", req.id);
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success({ deleted: true });
    }
  }
  return error("Unknown action", 400);
}

// ─── users ──────────────────────────────────────────────────────────

async function handleUsers(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  // Staff sees basic info, admin sees full
  const basicSelect = "id, email, role, display_name, first_name, last_name, avatar_url, created_at, last_sign_in_at";
  const fullSelect = "*";
  const selectFields = auth.userLevel >= 3 ? fullSelect : basicSelect;

  switch (req.action) {
    case "list": {
      let query = supabase.from("app_users").select(selectFields, { count: "exact" });
      if (req.filters?.role) query = query.eq("role", req.filters.role);
      if (req.filters?.search) {
        query = query.or(
          `display_name.ilike.%${req.filters.search}%,email.ilike.%${req.filters.search}%,first_name.ilike.%${req.filters.search}%,last_name.ilike.%${req.filters.search}%`
        );
      }
      query = applyPagination(query, req, "display_name", "asc");
      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("app_users")
        .select(selectFields)
        .eq("id", req.id)
        .single();
      if (err) return error("User not found", 404);
      return success(data);
    }

    case "create": {
      const { data, error: err } = await supabase
        .from("app_users")
        .insert(req.data)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("app_users")
        .update(req.data)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      const { error: err } = await supabase.from("app_users").delete().eq("id", req.id);
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success({ deleted: true });
    }
  }
  return error("Unknown action", 400);
}

// ─── profile (self-service) ─────────────────────────────────────────

async function handleProfile(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  if (!auth.appUser?.id || auth.appUser.id === "__service__") {
    return error("Profile requires user authentication", 401);
  }

  switch (req.action) {
    case "get": {
      const { data, error: err } = await supabase
        .from("app_users")
        .select("*")
        .eq("id", auth.appUser.id)
        .single();
      if (err) return error("Profile not found", 404);
      return success(data);
    }

    case "update": {
      // Filter to only editable fields
      const payload = Object.fromEntries(
        Object.entries(req.data || {}).filter(([k]) => PROFILE_EDITABLE_FIELDS.includes(k))
      );
      if (!Object.keys(payload).length) {
        return error("No editable fields provided", 400);
      }
      const { data, error: err } = await supabase
        .from("app_users")
        .update(payload)
        .eq("id", auth.appUser.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }
  }
  return error("Unknown action", 400);
}

// ─── vehicles ───────────────────────────────────────────────────────

async function handleVehicles(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("vehicles")
        .select("*", { count: "exact" })
        .eq("is_active", true)
        .order("display_order", { ascending: true });

      if (req.filters?.make) query = query.eq("make", req.filters.make);
      if (req.filters?.search) query = query.ilike("name", `%${req.filters.search}%`);

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("vehicles")
        .select("*")
        .eq("id", req.id)
        .single();
      if (err) return error("Vehicle not found", 404);
      return success(data);
    }

    case "create": {
      const { data, error: err } = await supabase
        .from("vehicles")
        .insert(req.data)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("vehicles")
        .update(req.data)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("vehicles")
        .update({ is_active: false })
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success(data);
    }
  }
  return error("Unknown action", 400);
}

// ─── media ──────────────────────────────────────────────────────────

async function handleMedia(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("media")
        .select("*, media_spaces(space_id, display_order, is_primary), media_tag_assignments(tag:tag_id(id, name, color))", { count: "exact" });

      if (req.filters?.category) query = query.eq("category", req.filters.category);
      if (req.filters?.space_id) {
        const { data: links } = await supabase
          .from("media_spaces")
          .select("media_id")
          .eq("space_id", req.filters.space_id);
        const mediaIds = (links || []).map((l: any) => l.media_id);
        if (!mediaIds.length) return success([], 0);
        query = query.in("id", mediaIds);
      }
      if (req.filters?.tag_name) {
        const { data: tagLinks } = await supabase
          .from("media_tag_assignments")
          .select("media_id, tag:tag_id!inner(name)")
          .ilike("tag.name", `%${req.filters.tag_name}%`);
        const mediaIds = (tagLinks || []).map((l: any) => l.media_id);
        if (!mediaIds.length) return success([], 0);
        query = query.in("id", mediaIds);
      }
      if (req.filters?.search) query = query.ilike("caption", `%${req.filters.search}%`);

      query = applyPagination(query, req);

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("media")
        .select("*, media_spaces(space_id, display_order, is_primary), media_tag_assignments(tag:tag_id(id, name, color))")
        .eq("id", req.id)
        .single();
      if (err) return error("Media not found", 404);
      return success(data);
    }

    case "create": {
      const mediaData = { ...req.data };
      const spaceId = mediaData.space_id;
      const tagIds = mediaData.tag_ids;
      delete mediaData.space_id;
      delete mediaData.tag_ids;

      const { data: media, error: err } = await supabase
        .from("media")
        .insert(mediaData)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);

      if (spaceId) {
        await supabase.from("media_spaces").insert({
          media_id: media.id,
          space_id: spaceId,
          display_order: req.data?.display_order || 0,
          is_primary: req.data?.is_primary || false,
        });
      }
      if (tagIds?.length) {
        const links = tagIds.map((tid: string) => ({ media_id: media.id, tag_id: tid }));
        await supabase.from("media_tag_assignments").insert(links);
      }

      return success(media);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const updateData = { ...req.data };
      delete updateData.space_id;
      delete updateData.tag_ids;

      if (Object.keys(updateData).length) {
        const { error: err } = await supabase.from("media").update(updateData).eq("id", req.id);
        if (err) return error(`Update failed: ${err.message}`, 400);
      }

      const { data } = await supabase.from("media").select("*").eq("id", req.id).single();
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      await supabase.from("media_spaces").delete().eq("media_id", req.id);
      await supabase.from("media_tag_assignments").delete().eq("media_id", req.id);
      const { error: err } = await supabase.from("media").delete().eq("id", req.id);
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success({ deleted: true });
    }
  }
  return error("Unknown action", 400);
}

// ─── payments ───────────────────────────────────────────────────────

async function handlePayments(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("ledger")
        .select("*, person:person_id(id, first_name, last_name)", { count: "exact" });

      if (req.filters?.person_id) query = query.eq("person_id", req.filters.person_id);
      if (req.filters?.type) query = query.eq("type", req.filters.type);
      if (req.filters?.payment_method) query = query.eq("payment_method", req.filters.payment_method);
      if (req.filters?.start_date) query = query.gte("payment_date", req.filters.start_date);
      if (req.filters?.end_date) query = query.lte("payment_date", req.filters.end_date);

      query = applyPagination(query, req, "payment_date", "desc");

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("ledger")
        .select("*, person:person_id(id, first_name, last_name)")
        .eq("id", req.id)
        .single();
      if (err) return error("Payment not found", 404);
      return success(data);
    }

    case "create": {
      const { data, error: err } = await supabase
        .from("ledger")
        .insert(req.data)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("ledger")
        .update(req.data)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      const { error: err } = await supabase.from("ledger").delete().eq("id", req.id);
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success({ deleted: true });
    }
  }
  return error("Unknown action", 400);
}

// ─── bug_reports ────────────────────────────────────────────────────

async function handleBugReports(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("bug_reports")
        .select("*", { count: "exact" });

      if (req.filters?.status) query = query.eq("status", req.filters.status);
      if (req.filters?.severity) query = query.eq("severity", req.filters.severity);
      if (req.filters?.search) {
        query = query.or(`title.ilike.%${req.filters.search}%,description.ilike.%${req.filters.search}%`);
      }

      query = applyPagination(query, req);

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("bug_reports")
        .select("*")
        .eq("id", req.id)
        .single();
      if (err) return error("Bug report not found", 404);
      return success(data);
    }

    case "create": {
      if (!req.data?.title) return error("Validation: title is required", 400);
      const payload = {
        ...req.data,
        reported_by: req.data.reported_by || auth.appUser?.display_name || "API",
        status: req.data.status || "pending",
      };
      const { data, error: err } = await supabase
        .from("bug_reports")
        .insert(payload)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("bug_reports")
        .update(req.data)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      const { error: err } = await supabase.from("bug_reports").delete().eq("id", req.id);
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success({ deleted: true });
    }
  }
  return error("Unknown action", 400);
}

// ─── time_entries ───────────────────────────────────────────────────

async function handleTimeEntries(supabase: any, req: ApiRequest, auth: any, perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("time_entries")
        .select("*, associate:associate_id(id, app_user_id, hourly_rate, app_user:app_user_id(display_name)), space:space_id(id, name)", { count: "exact" });

      // Row scoping: associates see only their own
      if (perm.rowScoped && auth.userLevel < 2) {
        // Look up associate profile for current user
        const { data: profile } = await supabase
          .from("associate_profiles")
          .select("id")
          .eq("app_user_id", auth.appUser?.id)
          .maybeSingle();
        if (profile) {
          query = query.eq("associate_id", profile.id);
        } else {
          return success([], 0);
        }
      }

      if (req.filters?.associate_id) query = query.eq("associate_id", req.filters.associate_id);
      if (req.filters?.space_id) query = query.eq("space_id", req.filters.space_id);
      if (req.filters?.status) query = query.eq("status", req.filters.status);
      if (req.filters?.start_date) query = query.gte("clock_in", req.filters.start_date);
      if (req.filters?.end_date) query = query.lte("clock_in", req.filters.end_date);

      query = applyPagination(query, req, "clock_in", "desc");

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("time_entries")
        .select("*, associate:associate_id(id, app_user_id, hourly_rate), space:space_id(id, name), work_photos(*)")
        .eq("id", req.id)
        .single();
      if (err) return error("Time entry not found", 404);

      // Row scoping check
      if (perm.rowScoped && auth.userLevel < 2) {
        const { data: profile } = await supabase
          .from("associate_profiles")
          .select("id")
          .eq("app_user_id", auth.appUser?.id)
          .maybeSingle();
        if (!profile || data.associate_id !== profile.id) {
          return error("Not found", 404);
        }
      }

      return success(data);
    }

    case "create": {
      const payload = { ...req.data };
      // Compute duration if both clock_in and clock_out provided
      if (payload.clock_in && payload.clock_out) {
        payload.duration_minutes = Math.round(
          (new Date(payload.clock_out).getTime() - new Date(payload.clock_in).getTime()) / 60000
        );
      }
      const { data, error: err } = await supabase
        .from("time_entries")
        .insert(payload)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);

      // Row scoping for level 1
      if (perm.rowScoped && auth.userLevel < 2) {
        const { data: existing } = await supabase.from("time_entries").select("associate_id").eq("id", req.id).single();
        const { data: profile } = await supabase
          .from("associate_profiles")
          .select("id")
          .eq("app_user_id", auth.appUser?.id)
          .maybeSingle();
        if (!profile || existing?.associate_id !== profile.id) {
          return error("Forbidden", 403);
        }
      }

      const payload = { ...req.data };
      // Recompute duration if times changed
      if (payload.clock_out || payload.clock_in) {
        const { data: current } = await supabase.from("time_entries").select("clock_in, clock_out").eq("id", req.id).single();
        const clockIn = payload.clock_in || current?.clock_in;
        const clockOut = payload.clock_out || current?.clock_out;
        if (clockIn && clockOut) {
          payload.duration_minutes = Math.round(
            (new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 60000
          );
        }
      }

      const { data, error: err } = await supabase
        .from("time_entries")
        .update(payload)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      const { error: err } = await supabase.from("time_entries").delete().eq("id", req.id);
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success({ deleted: true });
    }
  }
  return error("Unknown action", 400);
}

// ─── events (event_hosting_requests) ────────────────────────────────

async function handleEvents(supabase: any, req: ApiRequest, auth: any, perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("event_hosting_requests")
        .select("*, event_request_spaces(space_id, space:space_id(id, name))", { count: "exact" });

      // Row scoping: residents see own events only
      if (perm.rowScoped && auth.userLevel < 2 && auth.appUser?.email) {
        query = query.eq("contact_email", auth.appUser.email);
      }

      if (req.filters?.status) query = query.eq("status", req.filters.status);
      if (req.filters?.search) {
        query = query.or(`event_name.ilike.%${req.filters.search}%,host_name.ilike.%${req.filters.search}%`);
      }

      query = applyPagination(query, req);

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("event_hosting_requests")
        .select("*, event_request_spaces(space_id, space:space_id(id, name))")
        .eq("id", req.id)
        .single();
      if (err) return error("Event not found", 404);
      return success(data);
    }

    case "create": {
      const { data, error: err } = await supabase
        .from("event_hosting_requests")
        .insert(req.data)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("event_hosting_requests")
        .update(req.data)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      const { error: err } = await supabase.from("event_hosting_requests").delete().eq("id", req.id);
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success({ deleted: true });
    }
  }
  return error("Unknown action", 400);
}

// ─── documents (document_index) ─────────────────────────────────────

async function handleDocuments(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("document_index")
        .select("*", { count: "exact" })
        .eq("is_active", true);

      if (req.filters?.search) {
        query = query.or(`title.ilike.%${req.filters.search}%,description.ilike.%${req.filters.search}%`);
      }
      if (req.filters?.file_type) query = query.eq("file_type", req.filters.file_type);
      if (req.filters?.storage_backend) query = query.eq("storage_backend", req.filters.storage_backend);

      query = applyPagination(query, req, "title", "asc");

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("document_index")
        .select("*")
        .eq("id", req.id)
        .single();
      if (err) return error("Document not found", 404);
      return success(data);
    }

    case "create": {
      if (!req.data?.title) return error("Validation: title is required", 400);
      const payload = {
        ...req.data,
        uploaded_by: auth.appUser?.display_name || "API",
        is_active: req.data.is_active ?? true,
      };
      const { data, error: err } = await supabase
        .from("document_index")
        .insert(payload)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("document_index")
        .update(req.data)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      // Soft delete by deactivating
      const { data, error: err } = await supabase
        .from("document_index")
        .update({ is_active: false })
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success(data);
    }
  }
  return error("Unknown action", 400);
}

// ─── sms (sms_messages) ────────────────────────────────────────────

async function handleSms(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("sms_messages")
        .select("*, person:person_id(id, first_name, last_name)", { count: "exact" });

      if (req.filters?.person_id) query = query.eq("person_id", req.filters.person_id);
      if (req.filters?.direction) query = query.eq("direction", req.filters.direction);
      if (req.filters?.sms_type) query = query.eq("sms_type", req.filters.sms_type);
      if (req.filters?.search) query = query.ilike("body", `%${req.filters.search}%`);

      query = applyPagination(query, req);

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("sms_messages")
        .select("*, person:person_id(id, first_name, last_name)")
        .eq("id", req.id)
        .single();
      if (err) return error("SMS not found", 404);
      return success(data);
    }

    case "create": {
      // Delegate to send-sms edge function for actual sending
      if (!req.data?.to_number || !req.data?.body) {
        return error("Validation: to_number and body are required", 400);
      }
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

      const resp = await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
        body: JSON.stringify({
          to: req.data.to_number,
          body: req.data.body,
          person_id: req.data.person_id,
          sms_type: req.data.sms_type || "general",
        }),
      });

      const result = await resp.json();
      if (!resp.ok) return error(result.error || "SMS send failed", resp.status);
      return success(result);
    }
  }
  return error("Unknown action", 400);
}

// ─── faq (faq_context_entries) ──────────────────────────────────────

async function handleFaq(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("faq_context_entries")
        .select("*", { count: "exact" });

      // Public only sees active entries
      if (auth.userLevel < 3) {
        query = query.eq("is_active", true);
      }

      if (req.filters?.search) {
        query = query.or(`title.ilike.%${req.filters.search}%,content.ilike.%${req.filters.search}%`);
      }

      query = query.order("display_order", { ascending: true });

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("faq_context_entries")
        .select("*")
        .eq("id", req.id)
        .single();
      if (err) return error("FAQ entry not found", 404);
      return success(data);
    }

    case "create": {
      if (!req.data?.title || !req.data?.content) {
        return error("Validation: title and content are required", 400);
      }
      const { data, error: err } = await supabase
        .from("faq_context_entries")
        .insert(req.data)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("faq_context_entries")
        .update(req.data)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      const { error: err } = await supabase.from("faq_context_entries").delete().eq("id", req.id);
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success({ deleted: true });
    }
  }
  return error("Unknown action", 400);
}

// ─── invitations (user_invitations) ─────────────────────────────────

async function handleInvitations(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("user_invitations")
        .select("*", { count: "exact" });

      if (req.filters?.role) query = query.eq("role", req.filters.role);
      if (req.filters?.search) query = query.ilike("email", `%${req.filters.search}%`);

      query = applyPagination(query, req);

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("user_invitations")
        .select("*")
        .eq("id", req.id)
        .single();
      if (err) return error("Invitation not found", 404);
      return success(data);
    }

    case "create": {
      if (!req.data?.email || !req.data?.role) {
        return error("Validation: email and role are required", 400);
      }
      const payload = {
        ...req.data,
        invited_by: auth.appUser?.id || null,
        expires_at: req.data.expires_at || new Date(Date.now() + 7 * 86400000).toISOString(),
      };
      const { data, error: err } = await supabase
        .from("user_invitations")
        .insert(payload)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("user_invitations")
        .update(req.data)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      const { error: err } = await supabase.from("user_invitations").delete().eq("id", req.id);
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success({ deleted: true });
    }
  }
  return error("Unknown action", 400);
}

// ─── password_vault ─────────────────────────────────────────────────

async function handlePasswordVault(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("password_vault")
        .select("*", { count: "exact" })
        .eq("is_active", true);

      // Role-based category filtering
      if (auth.userLevel >= 3) {
        // Admin sees all
      } else if (auth.userLevel >= 2) {
        // Staff sees house, platform, service
        query = query.in("category", ["house", "platform", "service"]);
      } else {
        // Residents see only house category for their spaces
        query = query.eq("category", "house");
        // If user has assigned spaces, filter to those + null space_id
        if (auth.appUser?.person_id) {
          const { data: userAssignments } = await supabase
            .from("assignments")
            .select("assignment_spaces(space_id)")
            .eq("person_id", auth.appUser.person_id)
            .in("status", ["active", "pending_contract", "contract_sent"]);
          const spaceIds = (userAssignments || [])
            .flatMap((a: any) => (a.assignment_spaces || []).map((as: any) => as.space_id));
          if (spaceIds.length) {
            query = query.or(`space_id.in.(${spaceIds.join(",")}),space_id.is.null`);
          } else {
            query = query.is("space_id", null);
          }
        } else {
          query = query.is("space_id", null);
        }
      }

      if (req.filters?.category) query = query.eq("category", req.filters.category);
      if (req.filters?.search) {
        query = query.or(`service.ilike.%${req.filters.search}%,notes.ilike.%${req.filters.search}%`);
      }

      query = applyPagination(query, req, "service", "asc");

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("password_vault")
        .select("*")
        .eq("id", req.id)
        .single();
      if (err) return error("Vault entry not found", 404);
      return success(data);
    }

    case "create": {
      if (!req.data?.service) return error("Validation: service is required", 400);
      const { data, error: err } = await supabase
        .from("password_vault")
        .insert(req.data)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("password_vault")
        .update(req.data)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("password_vault")
        .update({ is_active: false })
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success(data);
    }
  }
  return error("Unknown action", 400);
}

// ─── feature_requests ───────────────────────────────────────────────

async function handleFeatureRequests(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "list": {
      let query = supabase
        .from("feature_requests")
        .select("*", { count: "exact" });

      if (req.filters?.status) query = query.eq("status", req.filters.status);
      if (req.filters?.search) {
        query = query.ilike("description", `%${req.filters.search}%`);
      }

      query = applyPagination(query, req);

      const { data, error: err, count } = await query;
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("feature_requests")
        .select("*")
        .eq("id", req.id)
        .single();
      if (err) return error("Feature request not found", 404);
      return success(data);
    }

    case "create": {
      if (!req.data?.description) return error("Validation: description is required", 400);

      // Rate limiting per user: max 3 active builds per user, max 10 per day per user
      const userId = auth.appUser?.id;
      let activeQuery = supabase
        .from("feature_requests")
        .select("id", { count: "exact", head: true })
        .in("status", ["pending", "building"]);
      if (userId) activeQuery = activeQuery.eq("requester_user_id", userId);
      const { count: activeCount } = await activeQuery;

      if ((activeCount || 0) >= 3) {
        return error("You have too many active feature requests. Wait for current builds to complete.", 429);
      }

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      let dailyQuery = supabase
        .from("feature_requests")
        .select("id", { count: "exact", head: true })
        .gte("created_at", todayStart.toISOString());
      if (userId) dailyQuery = dailyQuery.eq("requester_user_id", userId);
      const { count: dailyCount } = await dailyQuery;

      if ((dailyCount || 0) >= 10) {
        return error("You've reached your daily feature request limit (10/day).", 429);
      }

      const payload = {
        ...req.data,
        requested_by: auth.appUser?.display_name || "API",
        status: "pending",
      };
      const { data, error: err } = await supabase
        .from("feature_requests")
        .insert(payload)
        .select()
        .single();
      if (err) return error(`Create failed: ${err.message}`, 400);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("feature_requests")
        .update(req.data)
        .eq("id", req.id)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }

    case "delete": {
      if (!req.id) return error("id is required", 400);
      const { error: err } = await supabase.from("feature_requests").delete().eq("id", req.id);
      if (err) return error(`Delete failed: ${err.message}`, 400);
      return success({ deleted: true });
    }
  }
  return error("Unknown action", 400);
}

// ─── pai_config ─────────────────────────────────────────────────────

async function handlePaiConfig(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  switch (req.action) {
    case "get": {
      const { data, error: err } = await supabase
        .from("pai_config")
        .select("*")
        .eq("id", 1)
        .single();
      if (err) return error("PAI config not found", 404);
      return success(data);
    }

    case "update": {
      const { data, error: err } = await supabase
        .from("pai_config")
        .update(req.data)
        .eq("id", 1)
        .select()
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }
  }
  return error("Unknown action", 400);
}

// ─── tesla_accounts ─────────────────────────────────────────────────

async function handleTeslaAccounts(supabase: any, req: ApiRequest, auth: any, _perm: any): Promise<Response> {
  // Sensitive: never return full tokens to client
  const safeSelect = "id, owner_name, tesla_email, is_active, last_error, last_token_refresh_at, fleet_api_base, created_at, updated_at";

  switch (req.action) {
    case "list": {
      const { data, error: err, count } = await supabase
        .from("tesla_accounts")
        .select(safeSelect, { count: "exact" });
      if (err) return error(err.message, 500);
      return success(data, count);
    }

    case "get": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("tesla_accounts")
        .select(safeSelect)
        .eq("id", req.id)
        .single();
      if (err) return error("Tesla account not found", 404);
      return success(data);
    }

    case "update": {
      if (!req.id) return error("id is required", 400);
      const { data, error: err } = await supabase
        .from("tesla_accounts")
        .update(req.data)
        .eq("id", req.id)
        .select(safeSelect)
        .single();
      if (err) return error(`Update failed: ${err.message}`, 400);
      return success(data);
    }
  }
  return error("Unknown action", 400);
}
