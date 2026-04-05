// Claude Sessions API — Cloudflare Worker + D1
// Stores and retrieves Claude Code session transcripts.
// Auth: Bearer token — change AUTH_TOKEN below before deploying.

const AUTH_TOKEN = 'CHANGE_ME_TO_A_SECRET';

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Auth check
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${AUTH_TOKEN}`) {
      return json({ error: 'unauthorized' }, 401);
    }

    const url = new URL(request.url);

    // POST /sessions — save a session (INSERT OR REPLACE — idempotent)
    if (request.method === 'POST' && url.pathname === '/sessions') {
      const body = await request.json();
      const id = body.id || crypto.randomUUID();

      await env.DB.prepare(`
        INSERT OR REPLACE INTO sessions (id, project, model, started_at, ended_at, duration_mins, summary, transcript, token_count, cost_usd, tags)
        VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        body.project || null,
        body.model || null,
        body.started_at || null,
        body.ended_at || null,
        body.duration_mins || null,
        body.summary || null,
        body.transcript || null,
        body.token_count || null,
        body.cost_usd || null,
        body.tags || null
      ).run();

      return json({ ok: true, id });
    }

    // GET /sessions — list sessions
    if (request.method === 'GET' && url.pathname === '/sessions') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const project = url.searchParams.get('project');
      const search = url.searchParams.get('search');
      const dateFrom = url.searchParams.get('from');
      const dateTo = url.searchParams.get('to');

      let query = 'SELECT id, project, model, started_at, ended_at, duration_mins, summary, token_count, cost_usd, tags FROM sessions';
      let countQuery = 'SELECT COUNT(*) as total FROM sessions';
      const params = [];
      const countParams = [];
      const conditions = [];

      if (project) {
        conditions.push('project = ?');
        params.push(project);
        countParams.push(project);
      }
      if (search) {
        conditions.push('(summary LIKE ? OR transcript LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
        countParams.push(`%${search}%`, `%${search}%`);
      }
      if (dateFrom) {
        conditions.push("COALESCE(started_at, ended_at) >= ?");
        params.push(dateFrom);
        countParams.push(dateFrom);
      }
      if (dateTo) {
        conditions.push("COALESCE(started_at, ended_at) <= ?");
        params.push(dateTo + ' 23:59:59');
        countParams.push(dateTo + ' 23:59:59');
      }

      const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
      query += where + ' ORDER BY COALESCE(started_at, ended_at) DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      countQuery += where;

      const [result, countResult] = await Promise.all([
        env.DB.prepare(query).bind(...params).all(),
        env.DB.prepare(countQuery).bind(...countParams).all()
      ]);
      const total = countResult.results[0]?.total || 0;
      return json({ sessions: result.results, count: result.results.length, total, limit, offset });
    }

    // GET /sessions/:id — get full session with transcript
    if (request.method === 'GET' && url.pathname.startsWith('/sessions/')) {
      const id = url.pathname.split('/sessions/')[1];
      const result = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
      if (!result) return json({ error: 'not found' }, 404);
      return json(result);
    }

    // GET /stats — aggregate stats (cap durations at < 1440 to exclude outliers)
    if (request.method === 'GET' && url.pathname === '/stats') {
      const result = await env.DB.prepare(`
        SELECT
          COUNT(*) as total_sessions,
          SUM(token_count) as total_tokens,
          SUM(cost_usd) as total_cost,
          SUM(CASE WHEN duration_mins < 1440 THEN duration_mins ELSE 0 END) as total_minutes,
          AVG(token_count) as avg_tokens,
          AVG(CASE WHEN duration_mins < 1440 THEN duration_mins ELSE NULL END) as avg_duration
        FROM sessions
      `).first();
      return json(result);
    }

    // POST /fix-timestamps — repair ended_at for bulk-imported sessions
    if (request.method === 'POST' && url.pathname === '/fix-timestamps') {
      const body = await request.json();
      if (!body.import_time || !body.import_end) {
        return json({ error: 'import_time and import_end required' }, 400);
      }

      // For sessions with valid duration, set ended_at = started_at + duration
      const withDuration = await env.DB.prepare(`
        UPDATE sessions
        SET ended_at = datetime(started_at, '+' || duration_mins || ' minutes')
        WHERE ended_at BETWEEN ? AND ?
          AND started_at IS NOT NULL
          AND duration_mins IS NOT NULL
          AND duration_mins > 0
      `).bind(body.import_time, body.import_end).run();

      // For sessions without duration, set ended_at = started_at
      const withoutDuration = await env.DB.prepare(`
        UPDATE sessions
        SET ended_at = started_at
        WHERE ended_at BETWEEN ? AND ?
          AND started_at IS NOT NULL
          AND (duration_mins IS NULL OR duration_mins = 0)
      `).bind(body.import_time, body.import_end).run();

      return json({
        ok: true,
        fixed_with_duration: withDuration.meta?.changes || 0,
        fixed_without_duration: withoutDuration.meta?.changes || 0
      });
    }

    return json({ error: 'not found' }, 404);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}
