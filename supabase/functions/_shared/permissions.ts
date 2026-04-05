/**
 * Shared permission helpers for Supabase Edge Functions.
 * Checks granular permissions via role_permissions + user_permissions tables.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

/**
 * Get the app_user record and check a specific permission in one call.
 * Checks user_permissions override first, falls back to role_permissions.
 *
 * @returns { appUser, hasPermission }
 */
export async function getAppUserWithPermission(
  supabase: SupabaseClient,
  authUserId: string,
  permissionKey: string
): Promise<{ appUser: any; hasPermission: boolean }> {
  // Get app_user with role
  const { data: appUser } = await supabase
    .from("app_users")
    .select("id, role, display_name, email, person_id")
    .eq("auth_user_id", authUserId)
    .single();

  if (!appUser) return { appUser: null, hasPermission: false };

  // Check for explicit user override first (fastest path)
  const { data: override } = await supabase
    .from("user_permissions")
    .select("granted")
    .eq("app_user_id", appUser.id)
    .eq("permission_key", permissionKey)
    .maybeSingle();

  if (override) return { appUser, hasPermission: override.granted };

  // Fall back to role default
  const { data: roleDefault } = await supabase
    .from("role_permissions")
    .select("permission_key")
    .eq("role", appUser.role)
    .eq("permission_key", permissionKey)
    .maybeSingle();

  return { appUser, hasPermission: !!roleDefault };
}

/**
 * Check if a user has a specific permission (without returning the app_user record).
 */
export async function userHasPermission(
  supabase: SupabaseClient,
  authUserId: string,
  permissionKey: string
): Promise<boolean> {
  const { hasPermission } = await getAppUserWithPermission(
    supabase,
    authUserId,
    permissionKey
  );
  return hasPermission;
}
