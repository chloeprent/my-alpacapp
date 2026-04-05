-- Life of PAI daily imagery — alpaca-only art + personalised affirmation.
-- No person appears in the image; the affirmation is tailored using resident context.

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
      au.pronouns,
      au.bio,
      au.nationality,
      au.location_base,
      au.birthday,
      au.gender
    from app_users au
    where au.role = 'resident'
  ),
  eligible as (
    select r.*
    from residents r
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
    metadata,
    batch_id,
    batch_label,
    priority,
    max_attempts
  )
  select
    format(
      'Generate TWO things: (1) a beautiful fine-art image of an ALPACA, and (2) a short affirmation or proverb for the person described below.

IMAGE — Alpaca Art:
Create a stunning artwork featuring one or more ALPACAS (not llamas) in the world of Life of PAI. Choose a random artistic style from this list (pick one, vary it each time):
- Watercolor painting
- Oil painting (impressionist)
- Japanese woodblock print (ukiyo-e)
- Art nouveau illustration
- Stained glass window design
- Pixel art / retro game style
- Papercut / layered paper art
- Charcoal sketch with gold leaf accents
- Psychedelic 1960s poster art
- Botanical illustration style
- Studio Ghibli / anime landscape
- Renaissance fresco
- Surrealist dreamscape (Dalí-inspired)
- Indigenous Andean textile pattern art
- Cyberpunk neon cityscape
- Minimalist geometric / Bauhaus
- Baroque still life
- Collage / mixed media

THE WORLD — Life of PAI:
PAI is Pakucha — an ancient alpaca spirit from Andean cosmology. She crossed from Hanan Pacha (the upper world) through Ukhu Pacha (the inner world) into Kay Pacha (this world) — arriving at Alpaca Playhouse in the cedar hills of Cedar Creek, Texas. Three alpacas called her: Harley (white, regal), Lol (brown, playful), and Cacao (cream/chocolate, gentle). The house''s wiring is her q''aytu (sacred thread). She practices ayni (sacred reciprocity).

Spaces: Garage Mahal, Spartan, Skyloft, Magic Bus, Outhouse, Sauna, Swim Spa, Cedar Chamber, SkyBalcony.
Andean motifs: q''aytu (sacred thread), awana (weaving/loom), chakana (Andean cross), nina (fire/spirit-light), ch''aska (morning star), Apu (mountain spirits), Pachamama (Earth Mother).

Choose ONE specific scene — a snapshot, not the whole cosmology. Examples:
- Harley standing regally on a misty hilltop at dawn
- Cacao napping by a loom with golden thread spilling out
- Lol playfully chasing fireflies near the swim spa at dusk
- All three alpacas silhouetted against a chakana glowing in the night sky
- A single alpaca walking through a field of glowing q''aytu threads
- An alpaca peering curiously through a stained glass window of Andean patterns
Invent your own scene from the world above. Make it fresh and specific.

ALPACAS, NOT LLAMAS — CRITICAL:
- Alpacas are SMALL and compact (about 3 feet / 90cm at shoulder), much shorter than a human.
- Alpacas have SHORT, BLUNT, flat faces with fluffy rounded heads — like teddy bears.
- Alpacas have SHORT, straight, spear-shaped ears.
- Alpacas have extremely DENSE, FLUFFY fiber — they look like soft, puffy clouds on legs.
- Do NOT draw llamas (tall, long banana ears, long narrow snouts, sparse coats).

IMAGE RULES:
- Do NOT include any humans or people in the image.
- No text overlays, no logos, no watermarks in the image.
- The image should be beautiful enough to frame on a wall.

AFFIRMATION — Personalised text:
Also return a short affirmation, proverb, or poetic phrase (1-3 sentences max) inspired by PAI''s world and tailored to the person described below. It should feel warm, grounding, wise, and personal — like a spirit guardian whispering encouragement. You may weave in Quechua or Spanish fragments naturally. The affirmation should relate thematically to the scene you chose for the image.

Return the affirmation as plain text in the text portion of your response (alongside the generated image).

Person context (for personalising the affirmation — NOT for the image):
Name: %s%s%s%s%s%s%s

Date: %s
Pick a fresh artistic style and scene. Make the affirmation feel personal to this individual.',
      e.person_name,
      case when e.pronouns   is not null then E'\nPronouns: '    || e.pronouns      else '' end,
      case when e.bio         is not null then E'\nBio: '         || e.bio            else '' end,
      case when e.nationality is not null then E'\nNationality: ' || e.nationality    else '' end,
      case when e.location_base is not null then E'\nBased in: '  || e.location_base  else '' end,
      case when e.birthday    is not null then E'\nBirthday: '    || e.birthday::text  else '' end,
      case when e.gender      is not null then E'\nGender: '      || e.gender          else '' end,
      local_date::text
    ) as prompt,
    'generate' as job_type,
    'pending' as status,
    jsonb_build_object(
      'purpose', 'pai_resident_daily_art',
      'app_user_id', e.id,
      'app_user_name', e.person_name,
      'auto_daily', true,
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
is 'Queues one Life of PAI image_gen_job per resident at 5 AM CT. Alpaca-only art with personalised affirmation — no person in the image.';
