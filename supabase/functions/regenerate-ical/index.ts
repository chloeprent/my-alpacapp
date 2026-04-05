/**
 * Regenerate iCal Edge Function
 *
 * Regenerates static iCal files and pushes to GitHub.
 * Called when rental applications are created/modified to block/unblock
 * dates on Airbnb and other external calendars.
 *
 * Usage: POST /functions/v1/regenerate-ical
 *
 * Requires GITHUB_TOKEN environment variable with repo write access.
 *
 * Deploy with: supabase functions deploy regenerate-ical
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Slug mapping
const NAME_TO_SLUG: Record<string, string> = {
  'Spartan Fishbowl': 'spartan-fishbowl',
  'Spartan Trailer': 'spartan-trailer',
  'Cabinearo': 'cabinearo',
  'CabinFever': 'cabinfever',
  'Canvas Tent One': 'canvas-tent-one',
  'Canvas Tent Two': 'canvas-tent-two',
  'Cedar Chamber': 'cedar-chamber',
  'Fuego Trailer': 'fuego-trailer',
  "Jon's Room": 'jons-room',
  'Magic Bus': 'magic-bus',
  'Master Pasture Suite': 'master-pasture-suite',
  'Odyssey of Static Van Life': 'odyssey-of-static-van-life',
  'Pequneo Largo Suite': 'pequneo-largo-suite',
  'Playhouse': 'playhouse',
  'Skyloft': 'skyloft',
  'Skyloft Bed 1': 'skyloft-bed-1',
  'Skyloft Bed 2': 'skyloft-bed-2',
  'Skyloft Bed 3': 'skyloft-bed-3',
  'Skyloft Bed 4': 'skyloft-bed-4',
  'Skyloft Bed 5': 'skyloft-bed-5',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const GITHUB_TOKEN = Deno.env.get('GITHUB_TOKEN');
    if (!GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN not configured');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch spaces and assignments
    const { data: spaces } = await supabase
      .from('spaces')
      .select('id, name, parent_id')
      .eq('can_be_dwelling', true)
      .eq('is_archived', false);

    const { data: assignments } = await supabase
      .from('assignments')
      .select('id, start_date, end_date, status, airbnb_uid, assignment_spaces(space_id)')
      .in('status', ['prospect', 'active', 'pending_contract', 'contract_sent']);

    // Also fetch approved applications (not yet moved in) to block their dates
    const { data: approvedApps } = await supabase
      .from('rental_applications')
      .select('id, approved_space_id, approved_move_in, approved_lease_end')
      .eq('application_status', 'approved')
      .not('approved_move_in', 'is', null)
      .is('assignment_id', null); // No assignment yet = not moved in

    // Build parent→children map
    const childSpacesByParent: Record<string, string[]> = {};
    for (const s of (spaces || [])) {
      if (s.parent_id) {
        if (!childSpacesByParent[s.parent_id]) {
          childSpacesByParent[s.parent_id] = [];
        }
        childSpacesByParent[s.parent_id].push(s.id);
      }
    }

    // Group assignments by space
    const assignmentsBySpace: Record<string, any[]> = {};
    for (const assignment of (assignments || [])) {
      for (const as of (assignment.assignment_spaces || [])) {
        if (!assignmentsBySpace[as.space_id]) {
          assignmentsBySpace[as.space_id] = [];
        }
        assignmentsBySpace[as.space_id].push(assignment);
      }
    }

    // Add approved applications as pseudo-assignments
    for (const app of (approvedApps || [])) {
      if (app.approved_space_id && app.approved_move_in) {
        if (!assignmentsBySpace[app.approved_space_id]) {
          assignmentsBySpace[app.approved_space_id] = [];
        }
        assignmentsBySpace[app.approved_space_id].push({
          id: `app-${app.id}`,
          start_date: app.approved_move_in,
          end_date: app.approved_lease_end,
        });
      }
    }

    // Generate and update iCal files
    const updates: string[] = [];

    for (const space of (spaces || [])) {
      const slug = NAME_TO_SLUG[space.name];
      if (!slug) continue;

      let spaceAssignments = assignmentsBySpace[space.id] || [];

      // For parent spaces: exclude Airbnb-imported assignments that duplicate
      // bookings already on a child space (same dates). This prevents a child
      // room's booking from appearing in the parent's iCal and cascading to
      // other Airbnb listings that import the parent's calendar.
      const childIds = childSpacesByParent[space.id] || [];
      if (childIds.length > 0) {
        // Collect date pairs from all child space assignments
        const childDatePairs = new Set<string>();
        for (const childId of childIds) {
          for (const a of (assignmentsBySpace[childId] || [])) {
            if (a.airbnb_uid) {
              childDatePairs.add(`${a.start_date}|${a.end_date}`);
            }
          }
        }

        if (childDatePairs.size > 0) {
          spaceAssignments = spaceAssignments.filter((a: any) => {
            if (!a.airbnb_uid) return true; // Keep non-Airbnb assignments
            const key = `${a.start_date}|${a.end_date}`;
            return !childDatePairs.has(key); // Skip if child has same dates
          });
        }
      }

      const icalContent = generateIcal(space.name, spaceAssignments);

      // Update file via GitHub API
      const filePath = `spaces/ical/${slug}.ics`;
      const updated = await updateGitHubFile(GITHUB_TOKEN, filePath, icalContent);
      if (updated) {
        updates.push(slug);
      }
    }

    return new Response(
      JSON.stringify({ success: true, updated: updates }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Error regenerating iCal:', err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function generateIcal(spaceName: string, assignments: any[]): string {
  const now = new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//YOUR_APP_NAME//${spaceName}//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${spaceName}`,
  ];

  for (const assignment of assignments) {
    if (!assignment.start_date) continue;

    const startDate = new Date(assignment.start_date);
    let endDate: Date;

    if (assignment.end_date) {
      endDate = new Date(assignment.end_date);
      endDate.setDate(endDate.getDate() + 1); // DTEND is exclusive
    } else {
      endDate = new Date(startDate);
      endDate.setFullYear(endDate.getFullYear() + 1);
    }

    // Skip past assignments
    if (assignment.end_date && new Date(assignment.end_date) < now) {
      continue;
    }

    const uid = `${assignment.id}@your-project.com`;
    const dtstamp = formatDateUTC(now);
    const dtstart = formatDateOnly(startDate);
    const dtend = formatDateOnly(endDate);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${dtstart}`);
    lines.push(`DTEND;VALUE=DATE:${dtend}`);
    lines.push(`SUMMARY:Booked - ${spaceName}`);
    lines.push('STATUS:CONFIRMED');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function formatDateUTC(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

async function updateGitHubFile(token: string, path: string, content: string): Promise<boolean> {
  const repo = 'USERNAME/REPO';
  const branch = 'main';

  // Get current file SHA (needed for updates)
  const getResponse = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    }
  );

  let sha: string | undefined;
  if (getResponse.ok) {
    const fileData = await getResponse.json();
    sha = fileData.sha;

    // Check if content changed
    const existingContent = atob(fileData.content.replace(/\n/g, ''));
    const normalizedExisting = existingContent.replace(/DTSTAMP:\d+T\d+Z/g, '');
    const normalizedNew = content.replace(/DTSTAMP:\d+T\d+Z/g, '');
    if (normalizedExisting === normalizedNew) {
      return false; // No change needed
    }
  }

  // Update or create file
  const putResponse = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Update ${path} [automated]`,
        content: btoa(content),
        sha,
        branch,
      }),
    }
  );

  if (!putResponse.ok) {
    const errorText = await putResponse.text();
    console.error(`Failed to update ${path}:`, errorText);
    return false;
  }

  return true;
}
