-- Trending Topics: stores weekly trending relationship themes from Reddit
-- Used by trending_topics.py to power Chloe's content planning.

create table if not exists swoon_trending_topics (
  id                bigint primary key generated always as identity,
  topic_name        text not null,                 -- e.g. "Dealing with jealousy"
  summary           text,                          -- 1-sentence summary of what people are saying
  content_ideas     text[],                        -- 2-3 content ideas (reel, carousel, story)
  engagement_score  int default 0,                 -- total upvotes + comments across matched posts
  example_posts     text[],                        -- sample post titles representing the theme
  subreddits        text[],                        -- which subreddits the theme appeared in
  post_count        int default 0,                 -- how many posts matched this theme
  scanned_at        timestamptz default now(),     -- when this scan ran
  emailed_at        timestamptz                    -- when it was included in a digest
);

-- Index for fetching un-emailed topics
create index if not exists idx_trending_topics_not_emailed
  on swoon_trending_topics (emailed_at) where emailed_at is null;

-- Index for time-based lookups
create index if not exists idx_trending_topics_scanned
  on swoon_trending_topics (scanned_at desc);

-- RLS with public access policy (matches spec)
alter table swoon_trending_topics enable row level security;

create policy "Allow public read access on swoon_trending_topics"
  on swoon_trending_topics for select using (true);

create policy "Allow public insert access on swoon_trending_topics"
  on swoon_trending_topics for insert with check (true);

create policy "Allow public update access on swoon_trending_topics"
  on swoon_trending_topics for update using (true) with check (true);
