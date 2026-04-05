-- Switch display_version from generated r-format (r000000001) to date-based vYYMMDD.NN H:MMa format.
-- All timestamps are in Austin local time (America/Chicago) for consistency.
-- The daily counter NN resets each day. The seq column guarantees absolute ordering.

-- 1) Drop the GENERATED expression so we can write to display_version directly.
ALTER TABLE release_events ALTER COLUMN display_version DROP EXPRESSION;

-- 2) Backfill existing rows to the new date format.
WITH numbered AS (
  SELECT
    seq,
    'v' || to_char(pushed_at AT TIME ZONE 'America/Chicago', 'YYMMDD')
      || '.' || lpad(
        (ROW_NUMBER() OVER (
          PARTITION BY to_char(pushed_at AT TIME ZONE 'America/Chicago', 'YYMMDD')
          ORDER BY seq
        ))::text, 2, '0')
      || ' ' || to_char(pushed_at AT TIME ZONE 'America/Chicago', 'FMHH12:MI')
      || CASE WHEN EXTRACT(HOUR FROM (pushed_at AT TIME ZONE 'America/Chicago')) < 12 THEN 'a' ELSE 'p' END
    AS new_display
  FROM release_events
)
UPDATE release_events re
SET display_version = n.new_display
FROM numbered n
WHERE re.seq = n.seq;

-- 3) Replace record_release_event to compute vYYMMDD.NN H:MMa display_version.
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
  text, text, text, text, timestamptz,
  text, text, text, text, text, jsonb, jsonb
) FROM PUBLIC;
