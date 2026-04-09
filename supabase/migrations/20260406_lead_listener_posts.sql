-- Lead Listener: stores Reddit posts that match Swoon coaching keywords
-- so the daily digest never shows duplicates.

create table if not exists lead_listener_posts (
  id            bigint primary key generated always as identity,
  reddit_id     text unique not null,          -- Reddit's post ID (e.g. "t3_abc123")
  subreddit     text not null,                 -- which subreddit it came from
  title         text not null,                 -- post title
  body          text,                          -- post body / selftext
  author        text,                          -- Reddit username (nullable if deleted)
  permalink     text not null,                 -- direct link to the post
  score         int default 0,                 -- Reddit upvote score
  num_comments  int default 0,                 -- number of comments at scan time
  match_score   int default 0,                 -- 1-10 relevance score
  summary       text,                          -- 2-sentence summary
  suggested_reply text,                        -- compassionate opening line
  matched_keywords text[],                     -- which keyword phrases matched
  created_utc   timestamptz not null,          -- when the post was created on Reddit
  scanned_at    timestamptz default now(),     -- when our script found it
  emailed_at    timestamptz                    -- when it was included in a digest
);

-- Index for quick duplicate checks
create index if not exists idx_lead_listener_reddit_id on lead_listener_posts (reddit_id);

-- Index for fetching un-emailed posts
create index if not exists idx_lead_listener_not_emailed on lead_listener_posts (emailed_at) where emailed_at is null;

-- RLS: only service role can access this table (no public access)
alter table lead_listener_posts enable row level security;
