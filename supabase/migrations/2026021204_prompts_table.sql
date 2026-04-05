-- Prompts library with version history.
-- Each row is one version of a prompt, grouped by `name`.
-- Only one version per name should have is_active = true (enforced by unique partial index).

create table if not exists public.prompts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                          -- stable key, e.g. 'pai_daily_art'
  version     int  not null default 1,                -- increments per name
  content     text not null,                          -- the full prompt text
  category    text not null default 'general',        -- grouping: image_gen, email, pai, marketing, etc.
  description text,                                   -- human summary of what this prompt does
  metadata    jsonb default '{}'::jsonb,              -- style tags, aspect ratio hints, model, etc.
  is_active   boolean not null default true,          -- only one active version per name
  created_by  uuid references public.app_users(id),   -- who created this version
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- No duplicate versions for the same prompt name
  constraint prompts_name_version_unique unique (name, version)
);

-- Only one active version per prompt name
create unique index if not exists prompts_one_active_per_name
  on public.prompts (name)
  where is_active = true;

-- Fast lookups
create index if not exists prompts_category_idx on public.prompts (category);
create index if not exists prompts_name_idx on public.prompts (name);

-- Auto-update updated_at
create or replace function public.prompts_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger prompts_set_updated_at
  before update on public.prompts
  for each row execute function public.prompts_updated_at();

-- RLS
alter table public.prompts enable row level security;

-- Anyone authenticated can read prompts
create policy "prompts_select_authenticated"
  on public.prompts for select
  to authenticated
  using (true);

-- Admin/staff can insert, update, delete
create policy "prompts_insert_admin"
  on public.prompts for insert
  to authenticated
  with check (
    exists (
      select 1 from public.app_users
      where auth_user_id = auth.uid()
        and role in ('admin', 'staff')
    )
  );

create policy "prompts_update_admin"
  on public.prompts for update
  to authenticated
  using (
    exists (
      select 1 from public.app_users
      where auth_user_id = auth.uid()
        and role in ('admin', 'staff')
    )
  );

create policy "prompts_delete_admin"
  on public.prompts for delete
  to authenticated
  using (
    exists (
      select 1 from public.app_users
      where auth_user_id = auth.uid()
        and role in ('admin', 'staff')
    )
  );

-- Helper: get the active version of a prompt by name
create or replace function public.get_prompt(prompt_name text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select content
  from prompts
  where name = prompt_name
    and is_active = true
  limit 1;
$$;

comment on function public.get_prompt(text)
is 'Returns the active version content for a given prompt name.';

-- Helper: create a new version of a prompt (deactivates previous active)
create or replace function public.create_prompt_version(
  p_name text,
  p_content text,
  p_category text default null,
  p_description text default null,
  p_metadata jsonb default null,
  p_created_by uuid default null
)
returns public.prompts
language plpgsql
security definer
set search_path = public
as $$
declare
  next_version int;
  prev_category text;
  prev_description text;
  prev_metadata jsonb;
  result public.prompts;
begin
  -- Get next version number and carry forward category/description from previous
  select
    coalesce(max(version), 0) + 1,
    (select p2.category from prompts p2 where p2.name = p_name and p2.is_active order by p2.version desc limit 1),
    (select p2.description from prompts p2 where p2.name = p_name and p2.is_active order by p2.version desc limit 1),
    (select p2.metadata from prompts p2 where p2.name = p_name and p2.is_active order by p2.version desc limit 1)
  into next_version, prev_category, prev_description, prev_metadata
  from prompts
  where name = p_name;

  -- Deactivate all previous versions
  update prompts set is_active = false where name = p_name and is_active = true;

  -- Insert new version
  insert into prompts (name, version, content, category, description, metadata, is_active, created_by)
  values (
    p_name,
    next_version,
    p_content,
    coalesce(p_category, prev_category, 'general'),
    coalesce(p_description, prev_description),
    coalesce(p_metadata, prev_metadata, '{}'::jsonb),
    true,
    p_created_by
  )
  returning * into result;

  return result;
end;
$$;

comment on function public.create_prompt_version(text, text, text, text, jsonb, uuid)
is 'Creates a new version of a prompt, deactivating the previous active version. Carries forward category/description/metadata if not provided.';

--------------------------------------------------------------------
-- Seed: existing prompts from the codebase
--------------------------------------------------------------------

-- 1. PAI Daily Art prompt (v1 = original, v2 = current active)
insert into prompts (name, version, content, category, description, metadata, is_active) values
(
  'pai_daily_art',
  1,
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
  'image_gen',
  'PAI daily resident art — cinematic portrait with alpaca companion (v1, person in image)',
  '{"model": "gemini-2.5-flash-image", "use_case": "pai_resident_daily_art", "format_args": ["person_name", "local_date"]}',
  false
),
(
  'pai_daily_art',
  2,
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
  'image_gen',
  'PAI daily resident art — alpaca-only with random artistic style + personalised affirmation (v2, no person in image)',
  '{"model": "gemini-2.5-flash-image", "use_case": "pai_resident_daily_art", "format_args": ["person_name", "pronouns?", "bio?", "nationality?", "location_base?", "birthday?", "gender?", "local_date"], "artistic_styles": ["Watercolor", "Oil painting (impressionist)", "Ukiyo-e", "Art nouveau", "Stained glass", "Pixel art", "Papercut", "Charcoal + gold leaf", "Psychedelic 60s", "Botanical illustration", "Studio Ghibli", "Renaissance fresco", "Surrealist dreamscape", "Andean textile", "Cyberpunk neon", "Bauhaus geometric", "Baroque still life", "Collage / mixed media"]}',
  true
),

-- 2. Alpaca Trio Tech — the 3 alpacas: coding, datacenter, sleeping
(
  'alpaca_trio_tech',
  1,
  'Three alpacas (NOT llamas — short blunt teddy-bear faces, extremely fluffy dense fiber, small straight spear-shaped ears, compact bodies about 3 feet at shoulder). Each alpaca has a distinct color and activity:

1. HARLEY (white, regal) — sitting at a desk coding on a glowing laptop, lines of code visible on screen, focused expression, wearing tiny reading glasses
2. LOL (brown, playful) — standing in a miniature AI datacenter surrounded by blinking server racks, monitoring screens with neural network visualizations, looking proud and busy
3. CACAO (cream/chocolate, gentle) — peacefully sleeping curled up on a soft cushion, dreaming with a subtle smile, a tiny thought bubble with alpaca dreams

Choose a random highly artistic style — be bold and unexpected. Examples: ukiyo-e woodblock, psychedelic 60s poster, Studio Ghibli anime, stained glass, pixel art, art nouveau, surrealist dreamscape, cyberpunk neon, Renaissance fresco, papercut art, botanical illustration, Bauhaus geometric, baroque still life, collage/mixed media, charcoal + gold leaf, indigenous Andean textile. Pick ONE and commit fully to that style.

RULES:
- Wide banner composition (2:1 aspect ratio, 1200x600 pixels)
- No humans or people in the image
- No text overlays, no logos, no watermarks
- Beautiful enough to frame on a wall
- The three alpacas should be clearly distinct in their activities and colors',
  'image_gen',
  'Three alpacas — one coding, one managing AI datacenter, one sleeping. Random artistic style. 2:1 banner.',
  '{"use_case": "invitation_banner", "aspect_ratio": "2:1", "dimensions": "1200x600", "characters": ["Harley (white, coding)", "Lol (brown, datacenter)", "Cacao (cream, sleeping)"]}',
  true
);

comment on table public.prompts is 'Versioned prompt library. Each prompt has a stable name and multiple versions; only one version per name is active.';
