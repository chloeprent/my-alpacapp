/**
 * Resident device access scope helper.
 *
 * Rules:
 * - Staff/admin/oracle: full access.
 * - Residents/associates: access assigned dwelling spaces plus all non-dwelling spaces.
 */

import { supabase } from '../supabase.js';

const STAFF_ROLES = new Set(['staff', 'admin', 'oracle']);
const ASSIGNMENT_ACTIVE_STATUSES = ['active', 'pending_contract', 'contract_sent'];

export async function getResidentDeviceScope(appUser, hasPermission) {
  const role = appUser?.role || null;
  const fullAccess = STAFF_ROLES.has(role) || !!hasPermission?.('view_spaces');

  if (fullAccess) {
    return buildScope({ fullAccess: true, assignedSpaceIds: [], commonSpaces: [], assignedSpaces: [] });
  }

  const personId = await resolvePersonId(appUser);
  if (!personId) {
    return buildScope({ fullAccess: false, assignedSpaceIds: [], commonSpaces: [], assignedSpaces: [] });
  }

  const assignedSpaceIds = await getAssignedSpaceIds(personId);
  const [commonSpaces, assignedSpaces] = await Promise.all([
    getCommonSpaces(),
    getSpacesByIds(assignedSpaceIds),
  ]);

  return buildScope({
    fullAccess: false,
    assignedSpaceIds,
    commonSpaces,
    assignedSpaces,
  });
}

function buildScope({ fullAccess, assignedSpaceIds, commonSpaces, assignedSpaces }) {
  const commonSpaceIds = commonSpaces.map(s => s.id).filter(Boolean);
  const allowedSpaceIds = [...new Set([...commonSpaceIds, ...assignedSpaceIds])];
  const allowedSpaceNames = new Set(
    [...commonSpaces, ...assignedSpaces]
      .map(s => normalizeName(s?.name))
      .filter(Boolean)
  );

  return {
    fullAccess,
    assignedSpaceIds,
    commonSpaceIds,
    allowedSpaceIds,
    canAccessSpaceId(spaceId) {
      if (fullAccess) return true;
      if (!spaceId) return false;
      return allowedSpaceIds.includes(spaceId);
    },
    canAccessSpaceName(spaceName) {
      if (fullAccess) return true;
      const normalized = normalizeName(spaceName);
      if (!normalized) return false;
      return allowedSpaceNames.has(normalized);
    },
  };
}

async function resolvePersonId(appUser) {
  if (appUser?.person_id) return appUser.person_id;
  if (!appUser?.email) return null;

  const { data, error } = await supabase
    .from('people')
    .select('id')
    .eq('email', appUser.email)
    .limit(1);

  if (error || !data?.length) return null;
  return data[0].id;
}

async function getAssignedSpaceIds(personId) {
  const { data, error } = await supabase
    .from('assignments')
    .select('id, assignment_spaces(space_id)')
    .eq('person_id', personId)
    .in('status', ASSIGNMENT_ACTIVE_STATUSES);

  if (error || !data?.length) return [];

  const ids = [];
  for (const assignment of data) {
    for (const relation of assignment.assignment_spaces || []) {
      if (relation.space_id) ids.push(relation.space_id);
    }
  }
  return [...new Set(ids)];
}

async function getCommonSpaces() {
  const { data, error } = await supabase
    .from('spaces')
    .select('id, name, type')
    .neq('type', 'dwelling');

  if (error || !data?.length) return [];
  return data;
}

async function getSpacesByIds(spaceIds) {
  if (!spaceIds.length) return [];

  const { data, error } = await supabase
    .from('spaces')
    .select('id, name, type')
    .in('id', spaceIds);

  if (error || !data?.length) return [];
  return data;
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase() || null;
}
