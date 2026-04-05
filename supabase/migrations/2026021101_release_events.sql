-- Canonical release ledger for main pushes.
-- One immutable release event per push SHA, with strict global sequence ordering.

CREATE SEQUENCE IF NOT EXISTS release_event_seq AS bigint;

CREATE TABLE IF NOT EXISTS release_events (
  seq bigint PRIMARY KEY DEFAULT nextval('release_event_seq'),
  display_version text,  -- computed by record_release_event() as vYYMMDD.NN H:MMa
  push_sha text NOT NULL UNIQUE,
  branch text NOT NULL DEFAULT 'main',
  compare_from_sha text,
  compare_to_sha text NOT NULL,
  pushed_at timestamptz NOT NULL,
  actor_login text NOT NULL,
  actor_id text,
  source text NOT NULL DEFAULT 'unknown',
  model_code text,
  machine_name text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS release_event_commits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_seq bigint NOT NULL REFERENCES release_events(seq) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  commit_sha text NOT NULL,
  commit_short text NOT NULL,
  author_name text,
  author_email text,
  committed_at timestamptz,
  message text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_seq, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_release_events_pushed_at ON release_events (pushed_at DESC);
CREATE INDEX IF NOT EXISTS idx_release_events_branch_seq ON release_events (branch, seq DESC);
CREATE INDEX IF NOT EXISTS idx_release_event_commits_release_seq ON release_event_commits (release_seq, ordinal);

ALTER TABLE release_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_event_commits ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'release_events'
      AND policyname = 'Service role full access on release_events'
  ) THEN
    CREATE POLICY "Service role full access on release_events"
      ON release_events
      FOR ALL
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'release_event_commits'
      AND policyname = 'Service role full access on release_event_commits'
  ) THEN
    CREATE POLICY "Service role full access on release_event_commits"
      ON release_event_commits
      FOR ALL
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION set_updated_at_release_events()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_release_events_updated_at ON release_events;
CREATE TRIGGER trg_release_events_updated_at
BEFORE UPDATE ON release_events
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_release_events();

CREATE OR REPLACE FUNCTION record_release_event(
  p_push_sha text,
  p_branch text DEFAULT 'main',
  p_compare_from_sha text DEFAULT NULL,
  p_compare_to_sha text DEFAULT NULL,
  p_pushed_at timestamptz DEFAULT now(),
  p_actor_login text DEFAULT 'unknown',
  p_actor_id text DEFAULT NULL,
  p_source text DEFAULT 'unknown',
  p_model_code text DEFAULT NULL,
  p_machine_name text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_commits jsonb DEFAULT '[]'::jsonb
)
RETURNS release_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event release_events;
  v_commit jsonb;
  v_idx integer := 0;
  v_austin_ts timestamp;
  v_date_str text;
  v_day_count integer;
  v_time_str text;
  v_display text;
BEGIN
  IF p_push_sha IS NULL OR length(trim(p_push_sha)) = 0 THEN
    RAISE EXCEPTION 'p_push_sha is required';
  END IF;

  IF p_compare_to_sha IS NULL OR length(trim(p_compare_to_sha)) = 0 THEN
    p_compare_to_sha := p_push_sha;
  END IF;

  -- Compute display version in Austin local time (America/Chicago).
  -- Format: vYYMMDD.NN H:MMa  where NN = daily counter (01, 02, …)
  v_austin_ts := COALESCE(p_pushed_at, now()) AT TIME ZONE 'America/Chicago';
  v_date_str  := to_char(v_austin_ts, 'YYMMDD');

  SELECT COUNT(*) INTO v_day_count
  FROM release_events
  WHERE to_char(pushed_at AT TIME ZONE 'America/Chicago', 'YYMMDD') = v_date_str;

  v_time_str := to_char(v_austin_ts, 'FMHH12:MI')
    || CASE WHEN EXTRACT(HOUR FROM v_austin_ts) < 12 THEN 'a' ELSE 'p' END;

  v_display := 'v' || v_date_str || '.' || lpad((v_day_count + 1)::text, 2, '0') || ' ' || v_time_str;

  -- Upsert: on conflict (same push SHA), keep existing display_version.
  INSERT INTO release_events (
    display_version, push_sha, branch, compare_from_sha, compare_to_sha,
    pushed_at, actor_login, actor_id, source, model_code, machine_name, metadata
  )
  VALUES (
    v_display,
    p_push_sha,
    COALESCE(NULLIF(trim(p_branch), ''), 'main'),
    NULLIF(trim(p_compare_from_sha), ''),
    p_compare_to_sha,
    COALESCE(p_pushed_at, now()),
    COALESCE(NULLIF(trim(p_actor_login), ''), 'unknown'),
    NULLIF(trim(p_actor_id), ''),
    COALESCE(NULLIF(trim(p_source), ''), 'unknown'),
    NULLIF(trim(p_model_code), ''),
    NULLIF(trim(p_machine_name), ''),
    COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (push_sha) DO UPDATE SET
    display_version = release_events.display_version,  -- keep existing on idempotent re-run
    updated_at = now(),
    branch = EXCLUDED.branch,
    compare_from_sha = COALESCE(release_events.compare_from_sha, EXCLUDED.compare_from_sha),
    compare_to_sha = EXCLUDED.compare_to_sha,
    pushed_at = EXCLUDED.pushed_at,
    actor_login = EXCLUDED.actor_login,
    actor_id = COALESCE(release_events.actor_id, EXCLUDED.actor_id),
    source = EXCLUDED.source,
    model_code = COALESCE(EXCLUDED.model_code, release_events.model_code),
    machine_name = COALESCE(EXCLUDED.machine_name, release_events.machine_name),
    metadata = COALESCE(release_events.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING * INTO v_event;

  -- Insert commits (only if none exist yet for this release).
  IF jsonb_typeof(COALESCE(p_commits, '[]'::jsonb)) = 'array' THEN
    IF NOT EXISTS (
      SELECT 1 FROM release_event_commits WHERE release_seq = v_event.seq
    ) THEN
      FOR v_commit IN
        SELECT value FROM jsonb_array_elements(COALESCE(p_commits, '[]'::jsonb))
      LOOP
        v_idx := v_idx + 1;
        INSERT INTO release_event_commits (
          release_seq, ordinal, commit_sha, commit_short,
          author_name, author_email, committed_at, message, metadata
        )
        VALUES (
          v_event.seq,
          v_idx,
          COALESCE(v_commit->>'sha', ''),
          COALESCE(v_commit->>'short', left(COALESCE(v_commit->>'sha', ''), 8)),
          NULLIF(v_commit->>'author_name', ''),
          NULLIF(v_commit->>'author_email', ''),
          CASE
            WHEN (v_commit ? 'committed_at') AND length(COALESCE(v_commit->>'committed_at', '')) > 0
              THEN (v_commit->>'committed_at')::timestamptz
            ELSE NULL
          END,
          COALESCE(v_commit->>'message', ''),
          COALESCE(v_commit->'metadata', '{}'::jsonb)
        )
        ON CONFLICT (release_seq, ordinal) DO NOTHING;
      END LOOP;
    END IF;
  END IF;

  RETURN v_event;
END;
$$;

REVOKE ALL ON FUNCTION record_release_event(
  text,
  text,
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION get_latest_release_event()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH latest AS (
    SELECT *
    FROM release_events
    ORDER BY seq DESC
    LIMIT 1
  ),
  commits AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'sha', c.commit_sha,
        'short', c.commit_short,
        'author_name', c.author_name,
        'author_email', c.author_email,
        'committed_at', c.committed_at,
        'message', c.message
      )
      ORDER BY c.ordinal
    ) AS arr
    FROM release_event_commits c
    JOIN latest l ON l.seq = c.release_seq
  )
  SELECT COALESCE(
    (
      SELECT jsonb_build_object(
        'seq', l.seq,
        'display_version', l.display_version,
        'push_sha', l.push_sha,
        'branch', l.branch,
        'compare_from_sha', l.compare_from_sha,
        'compare_to_sha', l.compare_to_sha,
        'pushed_at', l.pushed_at,
        'actor_login', l.actor_login,
        'actor_id', l.actor_id,
        'source', l.source,
        'model_code', l.model_code,
        'machine_name', l.machine_name,
        'metadata', l.metadata,
        'commits', COALESCE(c.arr, '[]'::jsonb)
      )
      FROM latest l
      CROSS JOIN commits c
    ),
    '{}'::jsonb
  );
$$;

REVOKE ALL ON FUNCTION get_latest_release_event() FROM PUBLIC;
