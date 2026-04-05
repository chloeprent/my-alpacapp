import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { getCorsHeaders } from "../_shared/api-helpers.ts";
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: getCorsHeaders(req) });
  }

  if (req.method !== 'GET') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({ error: 'Missing Supabase env configuration' }),
        { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const limitParam = new URL(req.url).searchParams.get('limit');
    const historyLimit = Math.max(1, Math.min(50, Number(limitParam || 20)));

    const { data: latestRaw, error: latestError } = await supabase.rpc('get_latest_release_event');
    if (latestError) throw latestError;

    const { data: historyRows, error: historyError } = await supabase
      .from('release_events')
      .select('seq, display_version, push_sha, branch, pushed_at, actor_login, actor_id, source, compare_from_sha, compare_to_sha, model_code, machine_name, metadata')
      .order('seq', { ascending: false })
      .limit(historyLimit);
    if (historyError) throw historyError;

    return new Response(
      JSON.stringify({
        latest: latestRaw || {},
        history: historyRows || [],
      }),
      { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});
