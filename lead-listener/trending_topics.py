"""
Swoon Trending Topics — Reddit Trend Scanner for Content Planning

This script scans relationship-focused subreddits for recurring themes
and trending topics over the past 7 days. It groups posts by theme,
scores them by engagement, and sends a beautiful weekly email digest
with content ideas Chloe can use for Instagram.

No AI/LLM calls — everything is keyword/pattern based.

Run it:  python trending_topics.py
"""

import os
import re
import time
from datetime import datetime, timezone, timedelta
from collections import defaultdict

import praw
from supabase import create_client
from dotenv import load_dotenv

# ── Load environment variables from .env file ──
load_dotenv()


# ══════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════

# Same subreddits as the lead listener
SUBREDDITS = [
    "nonmonogamy",
    "openrelationships",
    "relationship_advice",
    "sex",
    "polyamory",
    "Marriage",
]

# How far back to look (7 days)
LOOKBACK_DAYS = 7

# How many posts to pull from each subreddit (hot + top combined)
POSTS_PER_SUB = 200


# ══════════════════════════════════════════════════════════════
# THEME DEFINITIONS
#
# Each theme has a name, a list of keywords/phrases to match on,
# and a set of ready-to-use content ideas for Chloe.
#
# Posts are matched against these themes by scanning titles and
# bodies for keyword hits. A single post can match multiple themes.
# ══════════════════════════════════════════════════════════════

THEME_DEFINITIONS = [
    {
        "name": "Opening up the conversation",
        "keywords": [
            "how do i bring it up", "how to bring up", "how to start the conversation",
            "want to open our relationship", "thinking about opening", "bring up open relationship",
            "how to have the conversation", "want to suggest open", "how do i ask my partner",
            "how to tell my partner", "considering opening", "want to try opening",
            "thinking about non-monogamy", "exploring the idea", "how to approach",
            "want to discuss opening", "starting the conversation",
        ],
        "content_ideas": [
            "Reel: '5 signs you're ready to have The Conversation (and 3 signs you're not)'",
            "Carousel: 'The exact script I give my clients for opening the conversation'",
            "Story prompt: 'What's the ONE thing holding you back from talking to your partner?'",
        ],
    },
    {
        "name": "Dealing with jealousy",
        "keywords": [
            "jealous", "jealousy", "envious", "envy", "insecure about",
            "can't stop thinking about them with", "comparing myself", "feeling left out",
            "fear of being replaced", "not good enough", "feeling inadequate",
            "green-eyed", "compersion", "struggling with jealousy",
        ],
        "content_ideas": [
            "Reel: 'Jealousy isn't the enemy -- here's what it's actually trying to tell you'",
            "Carousel: '4 jealousy triggers and what to do with each one'",
            "Story poll: 'What triggers jealousy most for you? A) time B) attention C) intimacy D) comparison'",
        ],
    },
    {
        "name": "Setting boundaries",
        "keywords": [
            "boundaries", "boundary", "rules", "agreements", "limits",
            "where to draw the line", "what's off limits", "ground rules",
            "broken a rule", "broke our agreement", "renegotiate", "hard limit",
            "soft limit", "deal breaker", "dealbreaker", "non-negotiable",
        ],
        "content_ideas": [
            "Reel: 'Boundaries aren't walls -- they're bridges (here's the difference)'",
            "Carousel: 'The 6 boundaries every open couple needs on day one'",
            "Story prompt: 'What boundary has been hardest for you to set? Share below.'",
        ],
    },
    {
        "name": "Trust after opening up",
        "keywords": [
            "trust", "trusting", "broken trust", "rebuild trust", "lost trust",
            "can i trust", "don't trust", "trust issues", "betrayed",
            "lied about", "hiding", "secret", "sneaking", "went behind my back",
            "violated our agreement", "transparency",
        ],
        "content_ideas": [
            "Reel: 'Trust in open relationships looks different -- here's what healthy trust actually means'",
            "Carousel: '5 trust-building rituals for couples in open relationships'",
            "Story prompt: 'What does trust look like in YOUR relationship? One word.'",
        ],
    },
    {
        "name": "One partner wants it, the other doesn't",
        "keywords": [
            "partner doesn't want", "partner isn't interested", "they said no",
            "partner refuses", "one-sided", "i want it but", "they don't want",
            "not on the same page", "disagree about", "forced into",
            "pressured", "reluctant partner", "dragging them into",
            "my partner wants but i don't", "only one of us wants",
        ],
        "content_ideas": [
            "Reel: 'When one of you wants to open up and the other doesn't -- what now?'",
            "Carousel: '3 things to NEVER do when your partner says no to opening up'",
            "Story prompt: 'Have you been the one wanting it or the hesitant partner?'",
        ],
    },
    {
        "name": "How to bring it up",
        "keywords": [
            "scared to tell", "afraid to ask", "nervous to bring up",
            "don't know how to say", "terrified to tell", "anxious about telling",
            "worried about their reaction", "fear of rejection",
            "what if they leave", "will they think i'm", "timing",
            "when is the right time", "how to word it",
        ],
        "content_ideas": [
            "Reel: 'The #1 mistake people make when bringing up open relationships'",
            "Carousel: 'When, where, and how: the 3 keys to timing The Talk'",
            "Story prompt: 'Rate your nervousness about having The Conversation: 1-10'",
        ],
    },
    {
        "name": "Kids and non-monogamy",
        "keywords": [
            "kids", "children", "parenting", "co-parenting", "family",
            "what about the kids", "our children", "custody",
            "telling the kids", "kids find out", "school", "babysitter",
            "mom", "dad", "parent",
        ],
        "content_ideas": [
            "Reel: 'Yes, you can be non-monogamous AND a great parent -- here's what I've seen'",
            "Carousel: 'Navigating family life and open relationships: 5 real-world tips'",
            "Story prompt: 'Biggest worry about kids and non-monogamy? Drop it below.'",
        ],
    },
    {
        "name": "Therapy and professional help",
        "keywords": [
            "therapist", "therapy", "counselor", "counseling", "couples therapy",
            "marriage counselor", "coach", "professional help", "seeing someone",
            "recommend a therapist", "need help", "support group",
            "books", "resources", "podcast", "workshop",
        ],
        "content_ideas": [
            "Reel: 'When to DIY vs. when to get a coach (honest take from a coach)'",
            "Carousel: '5 signs it's time to bring in a professional for your relationship'",
            "Story prompt: 'What resource has helped you most? Book, podcast, therapist?'",
        ],
    },
    {
        "name": "Success stories and encouragement",
        "keywords": [
            "success", "it worked", "going great", "happy", "thriving",
            "best decision", "love being open", "grateful", "positive experience",
            "years in", "still going strong", "better than ever", "closer than ever",
            "improved our relationship", "strengthened", "growth",
        ],
        "content_ideas": [
            "Reel: 'What people don't tell you about the OTHER side of opening up (the good stuff)'",
            "Carousel: 'Real stories: 3 couples who opened up and got CLOSER'",
            "Story prompt: 'Share your win this week -- big or small!'",
        ],
    },
    {
        "name": "Dating while partnered",
        "keywords": [
            "dating", "first date", "apps", "tinder", "hinge", "bumble",
            "dating profile", "meeting people", "new partner", "metamour",
            "date night", "scheduling", "time management", "nesting partner",
            "primary partner", "secondary", "new relationship energy", "nre",
        ],
        "content_ideas": [
            "Reel: 'The unspoken etiquette of dating while partnered'",
            "Carousel: 'How to write a dating profile when you're ethically non-monogamous'",
            "Story poll: 'Hardest part of dating while partnered? A) time B) guilt C) apps D) logistics'",
        ],
    },
    {
        "name": "Communication struggles",
        "keywords": [
            "communication", "communicate", "talking", "conversation",
            "fight about", "argument", "conflict", "misunderstanding",
            "not listening", "stonewalling", "shutting down", "defensive",
            "can't talk about", "avoid the topic", "check-in", "check in",
        ],
        "content_ideas": [
            "Reel: 'The 30-second check-in that saves open relationships'",
            "Carousel: '6 phrases that de-escalate ANY relationship argument'",
            "Story prompt: 'What's your go-to communication hack with your partner?'",
        ],
    },
    {
        "name": "Emotional processing",
        "keywords": [
            "overwhelmed", "anxious", "anxiety", "depressed", "sad",
            "crying", "confused", "conflicted", "torn", "guilt", "guilty",
            "shame", "emotional rollercoaster", "can't handle", "too much",
            "feeling lost", "identity", "who am i",
        ],
        "content_ideas": [
            "Reel: 'It's okay to feel ALL the feelings -- here's how to ride the wave'",
            "Carousel: 'The emotional timeline of opening up (month by month)'",
            "Story prompt: 'One word for how you're feeling about your relationship right now.'",
        ],
    },
    {
        "name": "Sexual exploration and desire",
        "keywords": [
            "sexual", "desire", "fantasy", "fantasies", "libido", "sex life",
            "bedroom", "intimacy", "physical", "attraction", "kink",
            "monogamish", "swinging", "threesome", "experimentation",
            "sexual compatibility", "dead bedroom",
        ],
        "content_ideas": [
            "Reel: 'The difference between wanting variety and wanting out'",
            "Carousel: 'How to talk about desire without your partner feeling not enough'",
            "Story prompt: 'Has opening up changed your intimate life? Better, worse, or different?'",
        ],
    },
    {
        "name": "Friends and social circles",
        "keywords": [
            "friends", "social", "coming out", "tell people", "judgment",
            "stigma", "family knows", "parents", "coworkers", "out as",
            "closeted", "hiding it", "what will people think", "support system",
        ],
        "content_ideas": [
            "Reel: 'Coming out as non-monogamous: who to tell, when, and how'",
            "Carousel: '5 ways to handle the judgment (and find your people)'",
            "Story prompt: 'Who was the first person you told? How did it go?'",
        ],
    },
    {
        "name": "Reconnecting after conflict",
        "keywords": [
            "make up", "reconnect", "repair", "after a fight", "recovery",
            "moving forward", "forgiveness", "forgive", "getting past",
            "heal", "healing", "closure", "working through",
        ],
        "content_ideas": [
            "Reel: 'The repair conversation nobody teaches you (but everyone needs)'",
            "Carousel: 'After the fight: 4 steps to reconnect without sweeping it under the rug'",
            "Story prompt: 'What helps you reconnect after a hard conversation?'",
        ],
    },
]


# ══════════════════════════════════════════════════════════════
# CONNECT TO SERVICES
# ══════════════════════════════════════════════════════════════

def create_reddit_client():
    """Connect to the Reddit API using your credentials from .env."""
    return praw.Reddit(
        client_id=os.environ["REDDIT_CLIENT_ID"],
        client_secret=os.environ["REDDIT_CLIENT_SECRET"],
        user_agent=os.environ.get("REDDIT_USER_AGENT", "swoon-trending-topics/1.0"),
    )


def create_supabase_client():
    """Connect to your Supabase database."""
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )


# ══════════════════════════════════════════════════════════════
# POST COLLECTION — Gather posts from the last 7 days
# ══════════════════════════════════════════════════════════════

def collect_posts(reddit):
    """
    Pull hot and top posts from each subreddit for the past 7 days.
    Returns a list of simplified post dicts (no PRAW objects, just data).
    De-duplicates by Reddit post ID.
    """
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    seen_ids = set()
    all_posts = []

    for sub_name in SUBREDDITS:
        print(f"  Collecting posts from r/{sub_name}...")
        try:
            subreddit = reddit.subreddit(sub_name)

            # Pull from both hot and top (weekly) to get a good cross-section
            post_sources = [
                subreddit.hot(limit=POSTS_PER_SUB // 2),
                subreddit.top(time_filter="week", limit=POSTS_PER_SUB // 2),
            ]

            for source in post_sources:
                for post in source:
                    # Skip if we already saw this post
                    if post.id in seen_ids:
                        continue
                    seen_ids.add(post.id)

                    # Skip if older than our lookback window
                    post_time = datetime.fromtimestamp(post.created_utc, tz=timezone.utc)
                    if post_time < cutoff:
                        continue

                    # Save just the data we need (no PRAW objects)
                    all_posts.append({
                        "id": post.id,
                        "subreddit": post.subreddit.display_name,
                        "title": post.title,
                        "body": post.selftext or "",
                        "score": post.score,
                        "num_comments": post.num_comments,
                        "permalink": f"https://reddit.com{post.permalink}",
                    })

        except Exception as e:
            print(f"    Error collecting from r/{sub_name}: {e}")
            continue

        # Be polite to Reddit's API
        time.sleep(2)

    print(f"\n  Collected {len(all_posts)} total posts from the past {LOOKBACK_DAYS} days.\n")
    return all_posts


# ══════════════════════════════════════════════════════════════
# THEME MATCHING — Match posts to predefined themes
#
# For each post, we check if any theme keywords appear in the
# title or body. A post can match multiple themes. We track
# which posts matched which themes, the total engagement
# (upvotes + comments), and which subreddits contributed.
# ══════════════════════════════════════════════════════════════

def match_posts_to_themes(posts):
    """
    Go through every post and check it against every theme's keyword list.
    Returns a dict keyed by theme name with match stats.
    """
    # Initialize tracking for each theme
    theme_results = {}
    for theme in THEME_DEFINITIONS:
        theme_results[theme["name"]] = {
            "name": theme["name"],
            "content_ideas": theme["content_ideas"],
            "post_count": 0,
            "engagement_score": 0,
            "example_posts": [],       # list of post titles
            "subreddits": set(),       # which subs had matches
        }

    # Check every post against every theme
    for post in posts:
        # Combine title and body for searching (lowercase for case-insensitive match)
        full_text = f"{post['title']} {post['body']}".lower()

        for theme in THEME_DEFINITIONS:
            # Check if ANY keyword from this theme appears in the post
            matched = False
            for keyword in theme["keywords"]:
                if keyword.lower() in full_text:
                    matched = True
                    break  # one match is enough, move on

            if matched:
                result = theme_results[theme["name"]]
                result["post_count"] += 1
                result["engagement_score"] += post["score"] + post["num_comments"]
                result["subreddits"].add(post["subreddit"])

                # Keep up to 5 example post titles
                if len(result["example_posts"]) < 5:
                    result["example_posts"].append(post["title"])

    # Convert subreddit sets to sorted lists (sets aren't JSON-friendly)
    for name in theme_results:
        theme_results[name]["subreddits"] = sorted(theme_results[name]["subreddits"])

    return theme_results


def rank_themes(theme_results):
    """
    Sort themes by a combined score: weighted post count + engagement.
    Only include themes that actually had matching posts.

    The score formula gives weight to both frequency (how many posts)
    and engagement (how much attention those posts got).
    """
    active_themes = [t for t in theme_results.values() if t["post_count"] > 0]

    for theme in active_themes:
        # Weighted score: post count matters a lot, engagement is a bonus
        theme["rank_score"] = (theme["post_count"] * 10) + (theme["engagement_score"] // 10)

    # Sort by rank score descending (most trending first)
    active_themes.sort(key=lambda t: t["rank_score"], reverse=True)
    return active_themes


def generate_theme_summary(theme):
    """
    Create a 1-sentence summary of what people are saying about this theme.
    Uses the theme name and stats to craft a descriptive sentence.
    """
    count = theme["post_count"]
    subs = theme["subreddits"]
    sub_list = ", ".join(f"r/{s}" for s in subs[:3])

    if count >= 20:
        intensity = "a major topic of discussion"
    elif count >= 10:
        intensity = "a frequently discussed topic"
    elif count >= 5:
        intensity = "a recurring conversation"
    else:
        intensity = "coming up in several posts"

    return (
        f"\"{theme['name']}\" is {intensity} across {sub_list}, "
        f"with {count} posts and {theme['engagement_score']:,} combined engagement this week."
    )


# ══════════════════════════════════════════════════════════════
# SAVE TO SUPABASE — Store trending topics for reference
# ══════════════════════════════════════════════════════════════

def save_to_supabase(supabase, ranked_themes):
    """
    Save each trending topic to the swoon_trending_topics table.
    This creates a historical record of what was trending each week.
    """
    now = datetime.now(tz=timezone.utc).isoformat()
    saved_count = 0

    for theme in ranked_themes:
        summary = generate_theme_summary(theme)

        row = {
            "topic_name": theme["name"],
            "summary": summary,
            "content_ideas": theme["content_ideas"],
            "engagement_score": theme["engagement_score"],
            "example_posts": theme["example_posts"],
            "subreddits": theme["subreddits"],
            "post_count": theme["post_count"],
            "scanned_at": now,
        }

        try:
            supabase.table("swoon_trending_topics").insert(row).execute()
            saved_count += 1
        except Exception as e:
            print(f"    Error saving theme '{theme['name']}': {e}")

    print(f"  Saved {saved_count} trending topics to Supabase.")
    return saved_count


# ══════════════════════════════════════════════════════════════
# EMAIL DIGEST — Beautiful weekly trending topics email
# ══════════════════════════════════════════════════════════════

def build_email_html(ranked_themes):
    """
    Build a beautiful HTML email showing the top 10 trending topics.
    Matches the Swoon brand: warm cream tones, Georgia font, earthy accents.
    """
    today = datetime.now().strftime("%B %d, %Y")
    top_themes = ranked_themes[:10]  # Only the top 10

    html = f"""
    <html>
    <head>
      <style>
        body {{
          font-family: 'Georgia', serif;
          background: #faf8f5;
          color: #2d2926;
          padding: 0;
          margin: 0;
        }}
        .container {{
          max-width: 680px;
          margin: 0 auto;
          padding: 32px 24px;
        }}

        /* ── Header ── */
        .header {{
          text-align: center;
          padding-bottom: 24px;
          border-bottom: 2px solid #e8e0d8;
          margin-bottom: 32px;
        }}
        .header h1 {{
          font-size: 28px;
          color: #8b6f5e;
          margin: 0 0 4px 0;
          font-weight: 500;
        }}
        .header p {{
          font-size: 14px;
          color: #a09080;
          margin: 4px 0 0 0;
        }}

        /* ── Intro ── */
        .intro {{
          background: #fff;
          border-radius: 12px;
          padding: 20px 24px;
          margin-bottom: 28px;
          box-shadow: 0 1px 4px rgba(0,0,0,0.06);
          font-size: 15px;
          line-height: 1.6;
          color: #5a4a3a;
        }}

        /* ── Topic card ── */
        .topic-card {{
          background: #fff;
          border-radius: 12px;
          padding: 24px;
          margin-bottom: 20px;
          box-shadow: 0 1px 4px rgba(0,0,0,0.06);
          border-left: 4px solid #c4956a;
        }}
        .topic-card.top-3 {{
          border-left-color: #8b6f5e;
        }}

        /* ── Topic header row ── */
        .topic-header {{
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }}
        .topic-rank {{
          display: inline-block;
          width: 28px;
          height: 28px;
          line-height: 28px;
          text-align: center;
          border-radius: 50%;
          background: #8b6f5e;
          color: #fff;
          font-size: 13px;
          font-weight: 700;
          margin-right: 10px;
        }}
        .topic-rank.lower {{
          background: #c4956a;
        }}
        .topic-name {{
          font-size: 18px;
          font-weight: 600;
          color: #2d2926;
        }}

        /* ── Stats row ── */
        .stats {{
          display: flex;
          gap: 16px;
          margin-bottom: 12px;
          font-size: 12px;
          color: #a09080;
        }}
        .stat {{
          display: inline-block;
        }}
        .stat strong {{
          color: #8b6f5e;
        }}

        /* ── Summary ── */
        .summary {{
          font-size: 14px;
          color: #5a4a3a;
          line-height: 1.6;
          margin-bottom: 16px;
        }}

        /* ── Content ideas ── */
        .ideas {{
          background: #f5f0eb;
          border-radius: 8px;
          padding: 16px;
          margin-bottom: 14px;
        }}
        .ideas .label {{
          font-size: 11px;
          color: #a09080;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        }}
        .ideas ul {{
          margin: 0;
          padding: 0 0 0 18px;
          font-size: 13px;
          color: #3d3530;
          line-height: 1.7;
        }}

        /* ── Example posts ── */
        .examples {{
          font-size: 12px;
          color: #b0a090;
          line-height: 1.6;
        }}
        .examples .label {{
          font-size: 11px;
          color: #a09080;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 4px;
        }}
        .examples ul {{
          margin: 0;
          padding: 0 0 0 18px;
        }}

        /* ── Footer ── */
        .footer {{
          text-align: center;
          padding-top: 24px;
          border-top: 1px solid #e8e0d8;
          margin-top: 12px;
        }}
        .footer p {{
          font-size: 12px;
          color: #b0a090;
        }}
      </style>
    </head>
    <body>
      <div class="container">

        <div class="header">
          <h1>Swoon Trending Topics</h1>
          <p>Weekly Content Radar &middot; {today}</p>
        </div>

        <div class="intro">
          Here are the top trending relationship topics on Reddit this week.
          Use these to create timely, relevant content that speaks directly
          to what your audience is thinking about right now.
        </div>
    """

    if not top_themes:
        html += """
        <div style="text-align:center; padding: 48px 0; color: #a09080;">
          <p style="font-size: 18px;">No trending topics found this week.</p>
          <p style="font-size: 14px;">Try again next week, or expand the subreddit list.</p>
        </div>
        """
    else:
        for i, theme in enumerate(top_themes):
            rank = i + 1
            card_class = "topic-card top-3" if rank <= 3 else "topic-card"
            rank_class = "topic-rank" if rank <= 3 else "topic-rank lower"
            summary = generate_theme_summary(theme)
            sub_list = ", ".join(f"r/{s}" for s in theme["subreddits"][:4])

            # Build content ideas list items
            ideas_html = ""
            for idea in theme["content_ideas"]:
                ideas_html += f"<li>{idea}</li>\n"

            # Build example posts list items (up to 3 for the email)
            examples_html = ""
            for title in theme["example_posts"][:3]:
                # Truncate long titles
                display_title = title[:80] + "..." if len(title) > 80 else title
                examples_html += f"<li>{display_title}</li>\n"

            html += f"""
        <div class="{card_class}">
          <div class="topic-header">
            <div>
              <span class="{rank_class}">{rank}</span>
              <span class="topic-name">{theme['name']}</span>
            </div>
          </div>

          <div class="stats">
            <span class="stat"><strong>{theme['post_count']}</strong> posts</span>
            <span class="stat"><strong>{theme['engagement_score']:,}</strong> engagement</span>
            <span class="stat">{sub_list}</span>
          </div>

          <div class="summary">{summary}</div>

          <div class="ideas">
            <div class="label">Content Ideas for You</div>
            <ul>
              {ideas_html}
            </ul>
          </div>

          <div class="examples">
            <div class="label">Example Posts This Week</div>
            <ul>
              {examples_html}
            </ul>
          </div>
        </div>
            """

    html += """
        <div class="footer">
          <p>These topics are based on keyword analysis of Reddit posts from the past 7 days.</p>
          <p>Swoon Trending Topics &middot; Built with care</p>
        </div>
      </div>
    </body>
    </html>
    """

    return html


def send_digest_email(ranked_themes, supabase):
    """
    Send the weekly trending topics digest via Gmail SMTP.
    Uses the same Gmail credentials as the lead listener.
    Marks all included topics as emailed so they don't repeat.
    """
    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    html_content = build_email_html(ranked_themes)
    today = datetime.now().strftime("%b %d")
    count = min(len(ranked_themes), 10)

    # Build the email message
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"Swoon Trending Topics — Top {count} this week ({today})"
    msg["From"] = os.environ["GMAIL_ADDRESS"]
    msg["To"] = os.environ.get("DIGEST_TO_EMAIL", os.environ["GMAIL_ADDRESS"])
    msg.attach(MIMEText(html_content, "html"))

    try:
        # Connect to Gmail's SMTP server and send
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(os.environ["GMAIL_ADDRESS"], os.environ["GMAIL_APP_PASSWORD"])
            server.send_message(msg)
        print(f"\n  Digest email sent via Gmail!")

        # Mark all topics as emailed in Supabase so we know they were sent
        now = datetime.now(tz=timezone.utc).isoformat()
        unemailed = (
            supabase.table("swoon_trending_topics")
            .select("id")
            .is_("emailed_at", "null")
            .execute()
        )
        for row in unemailed.data:
            supabase.table("swoon_trending_topics").update(
                {"emailed_at": now}
            ).eq("id", row["id"]).execute()

    except Exception as e:
        print(f"\n  Failed to send email: {e}")
        raise


# ══════════════════════════════════════════════════════════════
# RUN IT — This is what happens when the script executes
# ══════════════════════════════════════════════════════════════

def main():
    print("=" * 55)
    print("  Swoon Trending Topics — Weekly Content Radar")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 55)

    # Step 1: Connect to Reddit and Supabase
    print("\n-> Connecting to Reddit...")
    reddit = create_reddit_client()

    print("-> Connecting to Supabase...")
    supabase = create_supabase_client()

    # Step 2: Collect posts from the past 7 days across all subreddits
    print("\n-> Collecting posts from the past 7 days...\n")
    posts = collect_posts(reddit)

    if not posts:
        print("  No posts collected. Check your Reddit credentials or try again later.")
        return

    # Step 3: Match posts to predefined themes using keyword lists
    print("-> Matching posts to themes...\n")
    theme_results = match_posts_to_themes(posts)

    # Step 4: Rank themes by frequency + engagement
    ranked_themes = rank_themes(theme_results)
    print(f"  Found {len(ranked_themes)} active themes this week.\n")

    # Print a quick preview to the console
    print("  Top themes:")
    for i, theme in enumerate(ranked_themes[:10]):
        print(f"    {i+1}. {theme['name']} ({theme['post_count']} posts, "
              f"{theme['engagement_score']:,} engagement)")

    # Step 5: Save to Supabase for historical tracking
    print("\n-> Saving to Supabase...")
    save_to_supabase(supabase, ranked_themes)

    # Step 6: Send the weekly digest email
    if ranked_themes:
        print(f"\n-> Sending digest email with top {min(len(ranked_themes), 10)} topics...")
        send_digest_email(ranked_themes, supabase)
    else:
        print("\n-> No active themes to email. Skipping digest.")

    print("\n  Done! Check your inbox for this week's trending topics.")
    print("=" * 55)


if __name__ == "__main__":
    main()
