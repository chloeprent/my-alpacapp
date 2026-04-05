/**
 * iCal Feed Edge Function
 *
 * Generates iCal (.ics) files for spaces to sync with Airbnb and other platforms.
 *
 * Usage: GET /functions/v1/ical?space=spartan-fishbowl
 *
 * Deploy with: supabase functions deploy ical
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Map URL slugs to space names
const SLUG_TO_NAME: Record<string, string> = {
  'spartan-fishbowl': 'Spartan Fishbowl',
  'spartan-trailer': 'Spartan Trailer',
  'cabinearo': 'Cabinearo',
  'cabinfever': 'CabinFever',
  'canvas-tent-one': 'Canvas Tent One',
  'canvas-tent-two': 'Canvas Tent Two',
  'cedar-chamber': 'Cedar Chamber',
  'fuego-trailer': 'Fuego Trailer',
  'jons-room': "Jon's Room",
  'magic-bus': 'Magic Bus',
  'master-pasture-suite': 'Master Pasture Suite',
  'odyssey-of-static-van-life': 'Odyssey of Static Van Life',
  'pequneo-largo-suite': 'Pequneo Largo Suite',
  'playhouse': 'Playhouse',
  'skyloft': 'Skyloft',
  'skyloft-bed-1': 'Skyloft Bed 1',
  'skyloft-bed-2': 'Skyloft Bed 2',
  'skyloft-bed-3': 'Skyloft Bed 3',
  'skyloft-bed-4': 'Skyloft Bed 4',
  'skyloft-bed-5': 'Skyloft Bed 5',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const spaceSlug = url.searchParams.get('space');

    if (!spaceSlug) {
      return new Response('Missing space parameter', {
        status: 400,
        headers: corsHeaders
      });
    }

    const spaceName = SLUG_TO_NAME[spaceSlug];
    if (!spaceName) {
      return new Response(`Unknown space: ${spaceSlug}`, {
        status: 404,
        headers: corsHeaders
      });
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get space ID
    const { data: space, error: spaceError } = await supabase
      .from('spaces')
      .select('id, name')
      .eq('name', spaceName)
      .single();

    if (spaceError || !space) {
      return new Response(`Space not found: ${spaceName}`, {
        status: 404,
        headers: corsHeaders
      });
    }

    // Check if this space has child spaces (is a parent)
    const { data: childSpaces } = await supabase
      .from('spaces')
      .select('id')
      .eq('parent_id', space.id);

    const childIds = (childSpaces || []).map(c => c.id);

    // Get assignments for this space (active, pending_contract, contract_sent)
    // These are bookings that should block availability
    const { data: assignments, error: assignmentsError } = await supabase
      .from('assignments')
      .select(`
        id,
        start_date,
        end_date,
        status,
        airbnb_uid,
        assignment_spaces!inner(space_id)
      `)
      .eq('assignment_spaces.space_id', space.id)
      .in('status', ['active', 'pending_contract', 'contract_sent'])
      .not('start_date', 'is', null);

    if (assignmentsError) {
      console.error('Error fetching assignments:', assignmentsError);
      return new Response('Error fetching assignments', {
        status: 500,
        headers: corsHeaders
      });
    }

    let filteredAssignments = assignments || [];

    // For parent spaces: exclude Airbnb-imported assignments that are duplicates
    // of bookings already on a child space (same dates). This prevents a child
    // room's booking from blocking the parent's iCal feed and cascading to
    // other Airbnb listings that import the parent's calendar.
    if (childIds.length > 0 && filteredAssignments.length > 0) {
      const airbnbAssignments = filteredAssignments.filter(a => a.airbnb_uid);
      if (airbnbAssignments.length > 0) {
        // Get all child space Airbnb assignments
        const { data: childAssignments } = await supabase
          .from('assignments')
          .select('start_date, end_date, assignment_spaces!inner(space_id)')
          .not('airbnb_uid', 'is', null)
          .in('assignment_spaces.space_id', childIds)
          .in('status', ['active', 'pending_contract', 'contract_sent']);

        if (childAssignments && childAssignments.length > 0) {
          const childDatePairs = new Set(
            childAssignments.map(a => `${a.start_date}|${a.end_date}`)
          );

          filteredAssignments = filteredAssignments.filter(a => {
            if (!a.airbnb_uid) return true; // Keep non-Airbnb assignments
            const key = `${a.start_date}|${a.end_date}`;
            return !childDatePairs.has(key); // Skip if child has same dates
          });
        }
      }
    }

    // Generate iCal content
    const icalContent = generateIcal(space.name, spaceSlug, filteredAssignments);

    return new Response(icalContent, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${spaceSlug}.ics"`,
      },
    });

  } catch (err) {
    console.error('Error generating iCal:', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});

interface Assignment {
  id: string;
  start_date: string;
  end_date: string | null;
  status: string;
}

function generateIcal(spaceName: string, spaceSlug: string, assignments: Assignment[]): string {
  const now = new Date();
  const lines: string[] = [
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

    // For end date: use end_date if available, otherwise assume ongoing (1 year from now)
    let endDate: Date;
    if (assignment.end_date) {
      endDate = new Date(assignment.end_date);
      // Add 1 day because iCal DTEND is exclusive for all-day events
      endDate.setDate(endDate.getDate() + 1);
    } else {
      // No end date = ongoing, block for 1 year
      endDate = new Date(startDate);
      endDate.setFullYear(endDate.getFullYear() + 1);
    }

    // Skip past assignments (ended before today)
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
