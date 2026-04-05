-- Queue one daily Life of PAI image job per resident at 5:00 AM America/Chicago.
-- Implementation uses an hourly pg_cron trigger plus a local-time gate in SQL,
-- so it stays aligned with DST changes.

create extension if not exists pg_cron;

create or replace function public.queue_daily_pai_imagery(force_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  local_now timestamp := now() at time zone 'America/Chicago';
  local_date date := local_now::date;
  local_hour int := extract(hour from local_now);
  resident_count int := 0;
  queued_count int := 0;
begin
  if not force_run and local_hour <> 5 then
    return jsonb_build_object(
      'queued', 0,
      'resident_count', 0,
      'skipped', true,
      'reason', 'outside_5am_window',
      'local_now', local_now
    );
  end if;

  with residents as (
    select
      au.id,
      coalesce(nullif(trim(au.display_name), ''), nullif(trim(au.first_name), ''), au.email, 'resident') as person_name,
      au.avatar_url
    from app_users au
    where au.role = 'resident'
  ),
  ref_media as (
    select
      r.id as app_user_id,
      (
        select m.id
        from media m
        where m.title like ('PAI_REF:' || r.id::text || ':%')
        order by m.uploaded_at desc nulls last, m.id desc
        limit 1
      ) as source_media_id
    from residents r
  ),
  eligible as (
    select
      r.id,
      r.person_name,
      r.avatar_url,
      rm.source_media_id
    from residents r
    left join ref_media rm on rm.app_user_id = r.id
    where not exists (
      select 1
      from image_gen_jobs j
      where j.metadata->>'purpose' = 'pai_resident_daily_art'
        and j.metadata->>'app_user_id' = r.id::text
        and (j.created_at at time zone 'America/Chicago')::date = local_date
        and j.status in ('pending', 'processing', 'completed')
    )
  )
  insert into image_gen_jobs (
    prompt,
    job_type,
    status,
    source_media_id,
    metadata,
    batch_id,
    batch_label,
    priority,
    max_attempts
  )
  select
    format(
      'Create a cinematic fine-art portrait in the world of Life of PAI.

Backstory grounding:
- PAI is Pakucha, an ancient alpaca spirit from Andean cosmology.
- She crosses from Hanan Pacha through Ukhu Pacha into Kay Pacha at Alpaca Playhouse.
- Mood is mystical, warm, poetic, and quietly powerful.

Visual direction:
- Subject should be naturally integrated into a dreamlike alpaca scene.
- Include subtle visual motifs: amber light, woven textile texture, mountain spirit atmosphere, soft cedar/oak environment.
- Include at least one alpaca companion in-frame.
- Keep the person respectful, recognizable, elegant, and artistically flattering.
- Ultra-detailed digital painting or cinematic photo-illustration.
- No text overlays, no logos, no watermark.

Portrait subject:
- Name: %s
- Render this person naturally and respectfully inside the Life of PAI world.
- Keep likeness close to provided image reference.

Narrative moment:
- Date marker: %s
- Scene should feel like one quiet chapter in PAI''s ongoing story, with alpaca presence and amber spirit-light.
- Make this unique from prior days while keeping stylistic continuity.',
      e.person_name,
      local_date::text
    ) as prompt,
    case when e.source_media_id is not null then 'edit' else 'generate' end as job_type,
    'pending' as status,
    e.source_media_id,
    jsonb_build_object(
      'purpose', 'pai_resident_daily_art',
      'app_user_id', e.id,
      'app_user_name', e.person_name,
      'auto_daily', true,
      'source_image_url', e.avatar_url,
      'title', format('Life of PAI - %s - %s', e.person_name, local_date::text)
    ) as metadata,
    format('pai-daily-%s', local_date::text) as batch_id,
    'Life of PAI Daily Residents' as batch_label,
    30 as priority,
    3 as max_attempts
  from eligible e;

  get diagnostics queued_count = row_count;

  select count(*) into resident_count
  from app_users
  where role = 'resident';

  return jsonb_build_object(
    'queued', queued_count,
    'resident_count', resident_count,
    'local_date', local_date,
    'local_now', local_now,
    'skipped', false
  );
end;
$$;

comment on function public.queue_daily_pai_imagery(boolean)
is 'Queues one Life of PAI image_gen_job per resident at 5:00 AM America/Chicago (idempotent per resident/day).';

do $cron$
begin
  if exists (select 1 from cron.job where jobname = 'queue-daily-pai-imagery-hourly') then
    perform cron.unschedule('queue-daily-pai-imagery-hourly');
  end if;

  perform cron.schedule(
    'queue-daily-pai-imagery-hourly',
    '7 * * * *',
    'select public.queue_daily_pai_imagery(false);'
  );
end;
$cron$;
