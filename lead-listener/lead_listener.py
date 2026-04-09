"""
Swoon Lead Listener — Reddit Scout for Relationship Coaching Leads

This script scans specific subreddits for people who are thinking about
opening their relationship but haven't had the conversation yet.
It saves matching posts to Supabase and sends you a daily email digest.

YOU review every post before responding. This finds — you decide.
"""

import os
import re
import time
from datetime import datetime, timezone, timedelta

import praw
from supabase import create_client
from dotenv import load_dotenv

# ── Load environment variables from .env file ──
load_dotenv()

# ══════════════════════════════════════════════════════════════
# CONFIGURATION — Edit these if you want to tweak behavior
# ══════════════════════════════════════════════════════════════

# Which subreddits to scan
SUBREDDITS = [
    "nonmonogamy",
    "openrelationships",
    "relationship_advice",
    "sex",
    "polyamory",
    "Marriage",
]

# Keyword phrases that signal someone in the "pre-conversation" moment
# These are checked case-insensitively against both title and body
KEYWORD_PATTERNS = [
    "want to open our relationship",
    "how do i bring this up",
    "scared to tell my partner",
    "how do i ask my partner",
    "thinking about opening",
    "want to be non-monogamous",
    "how to have the conversation",
    "bring up open relationship",
    "afraid to ask",
    "don't know how to tell",
    "don't know how to tell",  # curly quote variant
    "my partner doesn't know",
    "my partner doesn't know",  # curly quote variant
    "haven't told my partner",
    "haven't told my partner",  # curly quote variant
    "nervous to bring up",
    "want to suggest open",
]

# Posts older than this many hours are skipped
MAX_AGE_HOURS = 48

# Posts with more than this many comments are skipped (too crowded)
MAX_COMMENTS = 50

# Words that suggest the post is about cheating or already-open situations
EXCLUDE_PATTERNS = [
    r"\bcheating\b",
    r"\bcheated\b",
    r"\baffair\b",
    r"\binfidelity\b",
    r"\bwe(?:'|')re already open\b",
    r"\bwe opened\b",
    r"\bwe've been open\b",
    r"\bwe(?:'|')ve been open\b",
    r"\balready non-monogamous\b",
    r"\balready poly\b",
]


# ══════════════════════════════════════════════════════════════
# CONNECT TO SERVICES
# ══════════════════════════════════════════════════════════════

def create_reddit_client():
    """Connect to the Reddit API using your credentials."""
    return praw.Reddit(
        client_id=os.environ["REDDIT_CLIENT_ID"],
        client_secret=os.environ["REDDIT_CLIENT_SECRET"],
        user_agent=os.environ.get("REDDIT_USER_AGENT", "swoon-lead-listener/1.0"),
    )


def create_supabase_client():
    """Connect to your Supabase database."""
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )


# ══════════════════════════════════════════════════════════════
# POST ANALYSIS — Decide if a post matches your ideal client
# ══════════════════════════════════════════════════════════════

def find_matching_keywords(text):
    """
    Check if the text contains any of our keyword phrases.
    Returns a list of which phrases matched.
    """
    text_lower = text.lower()
    matched = []
    for phrase in KEYWORD_PATTERNS:
        if phrase.lower() in text_lower:
            matched.append(phrase)
    return matched


def should_exclude(text):
    """
    Returns True if the post is about cheating or an already-open relationship.
    We don't want those — they're not in the pre-conversation moment.
    """
    text_lower = text.lower()
    for pattern in EXCLUDE_PATTERNS:
        if re.search(pattern, text_lower):
            return True
    return False


def is_too_old(created_utc):
    """Check if the post is older than our MAX_AGE_HOURS cutoff."""
    post_time = datetime.fromtimestamp(created_utc, tz=timezone.utc)
    cutoff = datetime.now(tz=timezone.utc) - timedelta(hours=MAX_AGE_HOURS)
    return post_time < cutoff


def calculate_match_score(post, matched_keywords):
    """
    Score from 1-10 how well this post matches the ideal client moment.

    Higher scores mean:
    - More keyword matches (they're clearly in the pre-conversation stage)
    - Title contains keywords (stronger signal than just body)
    - Post is from a more targeted subreddit
    - Post has moderate engagement (someone is reading, but not a mob scene)
    """
    score = 0

    # Base: 1 point per matched keyword, up to 4
    score += min(len(matched_keywords), 4)

    # Bonus: keyword in the title is a stronger signal
    title_lower = post.title.lower()
    if any(kw.lower() in title_lower for kw in matched_keywords):
        score += 2

    # Bonus: more targeted subreddits score higher
    high_signal_subs = ["nonmonogamy", "openrelationships"]
    medium_signal_subs = ["polyamory", "relationship_advice"]
    sub_lower = post.subreddit.display_name.lower()
    if sub_lower in high_signal_subs:
        score += 2
    elif sub_lower in medium_signal_subs:
        score += 1

    # Bonus: some engagement means the person is genuinely seeking help
    if 2 <= post.num_comments <= 15:
        score += 1

    # Cap at 10
    return min(score, 10)


def generate_summary(post):
    """
    Create a 2-sentence summary of what the person is going through.
    This is a simple extraction — not AI-generated.
    """
    # Use the post body if available, otherwise just the title
    text = post.selftext.strip() if post.selftext else post.title

    # Take the first ~300 chars and clean up to sentence boundaries
    snippet = text[:500]
    sentences = re.split(r'(?<=[.!?])\s+', snippet)

    if len(sentences) >= 2:
        summary = f"{sentences[0]} {sentences[1]}"
    elif len(sentences) == 1:
        summary = sentences[0]
    else:
        summary = post.title

    # Trim if too long
    if len(summary) > 300:
        summary = summary[:297] + "..."

    return summary


def generate_suggested_reply(post, matched_keywords):
    """
    Create a warm, compassionate opening line for responding to this post.

    IMPORTANT: These never mention coaching, services, or selling.
    They read like a kind, knowledgeable friend who's been there.
    """
    # Different openers based on the emotional tone of the post
    title_lower = post.title.lower()
    text_lower = (post.selftext or "").lower()
    combined = f"{title_lower} {text_lower}"

    if any(w in combined for w in ["scared", "afraid", "terrified", "anxious", "nervous"]):
        return (
            "The fact that you're even thinking this through so carefully says a lot "
            "about how much you care about your partner and your relationship. That fear "
            "you're feeling? It's not a red flag — it means this matters to you."
        )
    elif any(w in combined for w in ["don't know how", "no idea how", "where do i start"]):
        return (
            "This is one of those conversations where there's no perfect script, but "
            "there are ways to open it that make space for both of you to feel safe. "
            "You don't have to have all the answers before you start talking."
        )
    elif any(w in combined for w in ["how do i bring", "how to bring", "how to have the conversation"]):
        return (
            "Timing and framing matter a lot with conversations like this. In my experience, "
            "the best version of this talk starts with vulnerability, not a proposal — "
            "something like 'I've been reflecting on us and I want to share something.'"
        )
    elif any(w in combined for w in ["my partner doesn", "haven't told", "hasn't told"]):
        return (
            "Holding something like this inside can feel so isolating. It's worth remembering "
            "that wanting to explore this doesn't make you a bad partner — it makes you "
            "someone who's being honest with yourself, which is the first step."
        )
    else:
        return (
            "It takes real courage to even ask this question out loud (even anonymously). "
            "A lot of people sit on this feeling for months or years. The fact that you're "
            "here means you're ready to start figuring this out."
        )


# ══════════════════════════════════════════════════════════════
# MAIN SCANNER — Scan subreddits and save matching posts
# ══════════════════════════════════════════════════════════════

def scan_subreddits(reddit, supabase):
    """
    Go through each subreddit, look at recent posts, and save
    any that match our keywords (and pass our filters) to Supabase.

    Returns a list of newly found posts.
    """
    new_posts = []

    for sub_name in SUBREDDITS:
        print(f"  Scanning r/{sub_name}...")
        try:
            subreddit = reddit.subreddit(sub_name)
            # Look at the 100 newest posts in each subreddit
            for post in subreddit.new(limit=100):

                # ── Filter 1: Skip if too old ──
                if is_too_old(post.created_utc):
                    continue

                # ── Filter 2: Skip if too many comments (crowded) ──
                if post.num_comments > MAX_COMMENTS:
                    continue

                # ── Filter 3: Check if we've already seen this post ──
                existing = (
                    supabase.table("lead_listener_posts")
                    .select("id")
                    .eq("reddit_id", post.id)
                    .execute()
                )
                if existing.data:
                    continue

                # ── Filter 4: Check for matching keywords ──
                full_text = f"{post.title} {post.selftext or ''}"
                matched_keywords = find_matching_keywords(full_text)
                if not matched_keywords:
                    continue

                # ── Filter 5: Exclude cheating/already-open posts ──
                if should_exclude(full_text):
                    continue

                # ── This post matches! Score it and save it. ──
                match_score = calculate_match_score(post, matched_keywords)
                summary = generate_summary(post)
                suggested_reply = generate_suggested_reply(post, matched_keywords)

                post_data = {
                    "reddit_id": post.id,
                    "subreddit": post.subreddit.display_name,
                    "title": post.title,
                    "body": (post.selftext or "")[:5000],  # cap at 5000 chars
                    "author": str(post.author) if post.author else None,
                    "permalink": f"https://reddit.com{post.permalink}",
                    "score": post.score,
                    "num_comments": post.num_comments,
                    "match_score": match_score,
                    "summary": summary,
                    "suggested_reply": suggested_reply,
                    "matched_keywords": matched_keywords,
                    "created_utc": datetime.fromtimestamp(
                        post.created_utc, tz=timezone.utc
                    ).isoformat(),
                }

                # Save to Supabase
                supabase.table("lead_listener_posts").insert(post_data).execute()
                new_posts.append(post_data)
                print(f"    ✓ Found match: {post.title[:60]}... (score: {match_score}/10)")

        except Exception as e:
            print(f"    ✗ Error scanning r/{sub_name}: {e}")
            continue

        # Be polite to Reddit's API — short pause between subreddits
        time.sleep(2)

    return new_posts


# ══════════════════════════════════════════════════════════════
# EMAIL DIGEST — Send a beautiful daily summary
# ══════════════════════════════════════════════════════════════

def build_email_html(posts):
    """
    Build a clean, scannable HTML email with all today's matching posts.
    Sorted by match score (best leads first).
    """
    posts_sorted = sorted(posts, key=lambda p: p["match_score"], reverse=True)
    today = datetime.now().strftime("%B %d, %Y")

    # Start the email HTML
    html = f"""
    <html>
    <head>
      <style>
        body {{ font-family: 'Georgia', serif; background: #faf8f5; color: #2d2926; padding: 0; margin: 0; }}
        .container {{ max-width: 640px; margin: 0 auto; padding: 32px 24px; }}
        .header {{ text-align: center; padding-bottom: 24px; border-bottom: 2px solid #e8e0d8; margin-bottom: 32px; }}
        .header h1 {{ font-size: 28px; color: #8b6f5e; margin: 0 0 4px 0; font-weight: 500; }}
        .header p {{ font-size: 14px; color: #a09080; margin: 0; }}
        .post-card {{ background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); border-left: 4px solid #c4956a; }}
        .post-card.high-score {{ border-left-color: #8b6f5e; }}
        .post-meta {{ display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }}
        .subreddit {{ font-size: 12px; color: #a09080; text-transform: uppercase; letter-spacing: 0.5px; }}
        .score-badge {{ background: #8b6f5e; color: #fff; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 12px; }}
        .score-badge.medium {{ background: #c4956a; }}
        .score-badge.low {{ background: #d4c4b0; color: #5a4a3a; }}
        .post-title {{ font-size: 17px; font-weight: 600; margin-bottom: 8px; line-height: 1.4; }}
        .post-title a {{ color: #2d2926; text-decoration: none; }}
        .post-title a:hover {{ color: #8b6f5e; }}
        .summary {{ font-size: 14px; color: #5a4a3a; line-height: 1.6; margin-bottom: 16px; }}
        .suggested-reply {{ background: #f5f0eb; border-radius: 8px; padding: 16px; margin-bottom: 12px; }}
        .suggested-reply .label {{ font-size: 11px; color: #a09080; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }}
        .suggested-reply p {{ font-size: 14px; color: #3d3530; line-height: 1.6; margin: 0; font-style: italic; }}
        .keywords {{ font-size: 12px; color: #b0a090; }}
        .footer {{ text-align: center; padding-top: 24px; border-top: 1px solid #e8e0d8; margin-top: 12px; }}
        .footer p {{ font-size: 12px; color: #b0a090; }}
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Swoon Lead Listener</h1>
          <p>{today} &middot; {len(posts_sorted)} new lead{"s" if len(posts_sorted) != 1 else ""} found</p>
        </div>
    """

    if not posts_sorted:
        html += """
        <div style="text-align:center; padding: 48px 0; color: #a09080;">
          <p style="font-size: 18px;">No new leads today.</p>
          <p style="font-size: 14px;">The listener is running — check back tomorrow.</p>
        </div>
        """
    else:
        for post in posts_sorted:
            score = post["match_score"]
            score_class = "high-score" if score >= 7 else ""
            badge_class = "" if score >= 7 else ("medium" if score >= 4 else "low")

            keywords_str = ", ".join(post["matched_keywords"][:3])

            html += f"""
        <div class="post-card {score_class}">
          <div class="post-meta">
            <span class="subreddit">r/{post["subreddit"]}</span>
            <span class="score-badge {badge_class}">{score}/10</span>
          </div>
          <div class="post-title"><a href="{post["permalink"]}">{post["title"]}</a></div>
          <div class="summary">{post["summary"]}</div>
          <div class="suggested-reply">
            <div class="label">Suggested opening</div>
            <p>{post["suggested_reply"]}</p>
          </div>
          <div class="keywords">Matched: {keywords_str}</div>
        </div>
            """

    html += """
        <div class="footer">
          <p>Remember: review every post before responding. This finds — you decide.</p>
          <p>Swoon Lead Listener &middot; Built with care</p>
        </div>
      </div>
    </body>
    </html>
    """

    return html


def send_digest_email(posts, supabase):
    """
    Send the daily digest email via Gmail SMTP.
    Uses your Gmail address + an App Password (not your real password).
    Marks all included posts as emailed so they won't appear again.
    """
    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    html_content = build_email_html(posts)
    today = datetime.now().strftime("%b %d")

    # Build the email message
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"Swoon Leads — {len(posts)} new {'leads' if len(posts) != 1 else 'lead'} ({today})"
    msg["From"] = os.environ["GMAIL_ADDRESS"]
    msg["To"] = os.environ.get("DIGEST_TO_EMAIL", os.environ["GMAIL_ADDRESS"])
    msg.attach(MIMEText(html_content, "html"))

    try:
        # Connect to Gmail's SMTP server and send
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(os.environ["GMAIL_ADDRESS"], os.environ["GMAIL_APP_PASSWORD"])
            server.send_message(msg)
        print(f"\n  ✉ Digest email sent via Gmail!")

        # Mark all posts as emailed so they don't show up in tomorrow's digest
        now = datetime.now(tz=timezone.utc).isoformat()
        for post in posts:
            supabase.table("lead_listener_posts").update(
                {"emailed_at": now}
            ).eq("reddit_id", post["reddit_id"]).execute()

    except Exception as e:
        print(f"\n  ✗ Failed to send email: {e}")
        raise


# ══════════════════════════════════════════════════════════════
# RUN IT — This is what happens when the script executes
# ══════════════════════════════════════════════════════════════

def main():
    print("=" * 50)
    print("  Swoon Lead Listener — Starting scan")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 50)

    # Step 1: Connect to Reddit and Supabase
    print("\n→ Connecting to Reddit...")
    reddit = create_reddit_client()

    print("→ Connecting to Supabase...")
    supabase = create_supabase_client()

    # Step 2: Scan all subreddits for matching posts
    print("\n→ Scanning subreddits for leads...\n")
    new_posts = scan_subreddits(reddit, supabase)

    print(f"\n→ Found {len(new_posts)} new lead{'s' if len(new_posts) != 1 else ''}")

    # Step 3: Fetch any un-emailed posts (including from previous runs)
    unemailed = (
        supabase.table("lead_listener_posts")
        .select("*")
        .is_("emailed_at", "null")
        .order("match_score", desc=True)
        .execute()
    )
    posts_to_email = unemailed.data

    # Step 4: Send the digest email
    if posts_to_email:
        print(f"\n→ Sending digest with {len(posts_to_email)} post{'s' if len(posts_to_email) != 1 else ''}...")
        send_digest_email(posts_to_email, supabase)
    else:
        print("\n→ No un-emailed posts — skipping digest.")

    print("\n✓ Done! Check your inbox.")
    print("=" * 50)


if __name__ == "__main__":
    main()
