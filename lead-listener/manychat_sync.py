"""
Swoon ManyChat → CRM Sync

This script finds your ManyChat subscribers and syncs them
into your Swoon CRM (Supabase). Run it daily to keep your pipeline
up to date with everyone who's interacted with your Instagram automations.

ManyChat's API doesn't have a "list all" endpoint, so we use two strategies:
  1. Search by every letter A-Z to find subscribers by name
  2. Search by tags (if you've tagged subscribers in your flows)

New subscribers get added as "New Lead" or "Lead Magnet Sent" depending
on their ManyChat tags/activity. Existing contacts get updated with
any new info (name, email, etc.) without overwriting your notes.

Run: python manychat_sync.py
"""

import os
import time
import string
import requests
from datetime import datetime, timezone
from dotenv import load_dotenv
from supabase import create_client

# Load environment variables
load_dotenv()

# ══════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════

MANYCHAT_API_KEY = os.environ["MANYCHAT_API_KEY"]

# ManyChat API — we try /fb/ (which works for IG-connected pages too)
MANYCHAT_API_URL = "https://api.manychat.com/fb"

# Tags or custom fields that indicate the lead magnet was sent
# Adjust these to match whatever tags your ManyChat flow applies
LEAD_MAGNET_TAGS = ["lead_magnet", "guide_sent", "freebie", "download"]

# Keywords that indicate someone triggered a keyword automation
KEYWORD_INDICATORS = ["open", "guide", "send", "open1"]


# ══════════════════════════════════════════════════════════════
# CONNECT TO SERVICES
# ══════════════════════════════════════════════════════════════

def create_supabase_client():
    """Connect to Supabase."""
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )


def manychat_request(endpoint, method="GET", data=None):
    """
    Make a request to the ManyChat API.
    Handles authentication and rate limiting (max 10 req/sec).
    """
    headers = {
        "Authorization": f"Bearer {MANYCHAT_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    url = f"{MANYCHAT_API_URL}/{endpoint}"

    if method == "GET":
        response = requests.get(url, headers=headers, params=data)
    else:
        response = requests.post(url, headers=headers, json=data)

    if response.status_code == 429:
        # Rate limited — wait and retry
        print("    ⏳ Rate limited, waiting 10 seconds...")
        time.sleep(10)
        return manychat_request(endpoint, method, data)

    if response.status_code != 200:
        print(f"    ✗ API error {response.status_code}: {response.text[:200]}")
        return None

    result = response.json()
    return result.get("data", result)


# ══════════════════════════════════════════════════════════════
# FETCH SUBSCRIBERS FROM MANYCHAT
# ══════════════════════════════════════════════════════════════

def get_all_tags():
    """
    Get all tags from ManyChat.
    We'll use these to find tagged subscribers.
    """
    result = manychat_request("page/getTags")
    if result and isinstance(result, list):
        return result
    return []


def find_subscribers_by_name(search_term):
    """
    Search for subscribers by name.
    Returns up to 100 results per search.
    """
    result = manychat_request(
        f"subscriber/findByName",
        data={"name": search_term}
    )
    if result and isinstance(result, list):
        return result
    return []


def find_subscribers_by_system_field(field_name, value):
    """
    Search for subscribers by system field (email, phone).
    """
    result = manychat_request(
        f"subscriber/findBySystemField",
        data={"field_name": field_name, "field_value": value}
    )
    if result and isinstance(result, list):
        return result
    return []


def get_subscriber_details(subscriber_id):
    """
    Get full details for a single subscriber.
    Includes tags, custom fields, and activity info.
    """
    result = manychat_request(f"subscriber/getInfo?subscriber_id={subscriber_id}")
    return result


def discover_all_subscribers():
    """
    Since ManyChat has no "list all" endpoint, we search by
    every letter A-Z and by common name fragments to find everyone.
    Results are deduplicated by subscriber ID.

    Returns a dict of {subscriber_id: subscriber_object}.
    """
    seen = {}  # subscriber_id -> subscriber data

    print("  Searching for subscribers by name (A-Z)...")
    for letter in string.ascii_lowercase:
        results = find_subscribers_by_name(letter)
        new_count = 0
        for sub in results:
            sub_id = str(sub.get("id", ""))
            if sub_id and sub_id not in seen:
                seen[sub_id] = sub
                new_count += 1
        if results:
            print(f"    '{letter}': {len(results)} results ({new_count} new)")
        time.sleep(0.15)  # Stay under 10 req/sec limit

    # Also search by single digits (catches phone-number-based names)
    for digit in string.digits:
        results = find_subscribers_by_name(digit)
        new_count = 0
        for sub in results:
            sub_id = str(sub.get("id", ""))
            if sub_id and sub_id not in seen:
                seen[sub_id] = sub
                new_count += 1
        if results:
            print(f"    '{digit}': {len(results)} results ({new_count} new)")
        time.sleep(0.15)

    print(f"  Found {len(seen)} unique subscribers via name search")
    return seen


def enrich_subscribers(subscribers_dict):
    """
    For each subscriber, fetch their full details (tags, custom fields).
    This gives us the info we need to determine pipeline stage.
    """
    enriched = []
    total = len(subscribers_dict)

    print(f"  Enriching {total} subscribers with full details...")

    for i, (sub_id, sub) in enumerate(subscribers_dict.items()):
        details = get_subscriber_details(sub_id)
        if details:
            enriched.append(details)
        else:
            # Use what we have from the search results
            enriched.append(sub)

        if (i + 1) % 10 == 0:
            print(f"    ... {i + 1}/{total}")

        time.sleep(0.15)  # Rate limiting

    return enriched


# ══════════════════════════════════════════════════════════════
# SYNC LOGIC — Compare ManyChat data with CRM
# ══════════════════════════════════════════════════════════════

def determine_stage(subscriber):
    """
    Figure out what pipeline stage this subscriber should be in
    based on their ManyChat tags and activity.
    """
    tags = []
    if isinstance(subscriber.get("tags"), list):
        tags = [t.get("name", "").lower() if isinstance(t, dict) else str(t).lower()
                for t in subscriber["tags"]]

    # Check if they have a lead magnet tag
    has_lead_magnet = any(
        any(lm in tag for lm in LEAD_MAGNET_TAGS)
        for tag in tags
    )

    if has_lead_magnet:
        return "lead_magnet_sent"

    return "new_lead"


def extract_keyword(subscriber):
    """
    Try to figure out what keyword triggered the automation.
    Looks at tags, custom fields, and last input text.
    """
    # Check tags for keyword indicators
    tags = []
    if isinstance(subscriber.get("tags"), list):
        tags = [t.get("name", "") if isinstance(t, dict) else str(t)
                for t in subscriber["tags"]]

    for tag in tags:
        tag_lower = tag.lower()
        for kw in KEYWORD_INDICATORS:
            if kw in tag_lower:
                return tag.upper()

    # Check last input text
    last_input = subscriber.get("last_input_text", "")
    if last_input:
        for kw in KEYWORD_INDICATORS:
            if kw in last_input.lower():
                return last_input.upper()

    return None


def sync_subscriber(subscriber, supabase):
    """
    Sync a single ManyChat subscriber to the CRM.
    Creates new contacts or updates existing ones.
    Returns 'created', 'updated', or 'skipped'.
    """
    # Extract the info we need
    manychat_id = str(subscriber.get("id", ""))
    ig_username = subscriber.get("ig_username") or subscriber.get("username") or None
    full_name = subscriber.get("name") or subscriber.get("full_name") or None

    # Try to build name from first/last
    if not full_name:
        first = subscriber.get("first_name", "")
        last = subscriber.get("last_name", "")
        if first or last:
            full_name = f"{first} {last}".strip()

    email = subscriber.get("email") or None
    phone = subscriber.get("phone") or None

    # Skip if we have no way to identify this person
    if not manychat_id and not ig_username:
        return "skipped"

    # Check if contact already exists in CRM
    existing = None

    if manychat_id:
        result = supabase.table("swoon_crm_contacts").select("*").eq("manychat_id", manychat_id).execute()
        if result.data:
            existing = result.data[0]

    if not existing and ig_username:
        clean_ig = ig_username.replace("@", "")
        result = supabase.table("swoon_crm_contacts").select("*").eq("ig_username", clean_ig).execute()
        if result.data:
            existing = result.data[0]

    now = datetime.now(tz=timezone.utc).isoformat()

    if existing:
        # ── Update existing contact (fill in blanks, don't overwrite) ──
        updates = {"updated_at": now}

        if not existing.get("full_name") and full_name:
            updates["full_name"] = full_name
        if not existing.get("email") and email:
            updates["email"] = email
        if not existing.get("phone") and phone:
            updates["phone"] = phone
        if not existing.get("manychat_id") and manychat_id:
            updates["manychat_id"] = manychat_id
        if not existing.get("ig_username") and ig_username:
            updates["ig_username"] = ig_username.replace("@", "")

        # Only update if there's something new
        if len(updates) > 1:  # more than just updated_at
            supabase.table("swoon_crm_contacts").update(updates).eq("id", existing["id"]).execute()
            return "updated"
        return "skipped"

    else:
        # ── Create new contact ──
        stage = determine_stage(subscriber)
        keyword = extract_keyword(subscriber)

        new_contact = {
            "ig_username": ig_username.replace("@", "") if ig_username else None,
            "full_name": full_name,
            "email": email,
            "phone": phone,
            "stage": stage,
            "source": "manychat",
            "manychat_id": manychat_id,
            "keyword_used": keyword,
            "lead_magnet_sent": stage == "lead_magnet_sent",
            "lead_magnet_sent_at": now if stage == "lead_magnet_sent" else None,
            "first_contact_at": now,
            "last_activity_at": now,
        }

        result = supabase.table("swoon_crm_contacts").insert(new_contact).select().single().execute()

        # Log the activity
        if result.data:
            supabase.table("swoon_crm_activity").insert({
                "contact_id": result.data["id"],
                "activity_type": "keyword_trigger",
                "description": f"Auto-synced from ManyChat{' (keyword: ' + keyword + ')' if keyword else ''}",
                "metadata": {"manychat_id": manychat_id, "source": "manychat_sync"},
            }).execute()

        return "created"


# ══════════════════════════════════════════════════════════════
# MAIN — Run the sync
# ══════════════════════════════════════════════════════════════

def main():
    print("=" * 50)
    print("  Swoon ManyChat → CRM Sync")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 50)

    # Connect to Supabase
    print("\n→ Connecting to Supabase...")
    supabase = create_supabase_client()

    # Verify ManyChat API connection
    print("\n→ Checking ManyChat API connection...")
    page_info = manychat_request("page/getInfo")
    if not page_info:
        print("  ✗ Could not connect to ManyChat API. Check your API key.")
        return
    print(f"  ✓ Connected to: {page_info.get('name', 'unknown')}")

    # Show available tags
    print("\n→ Fetching ManyChat tags...")
    tags = get_all_tags()
    if tags:
        tag_names = [t.get("name", "?") if isinstance(t, dict) else str(t) for t in tags]
        print(f"  Tags found: {', '.join(tag_names)}")
    else:
        print("  No tags found (this is normal if you haven't tagged subscribers)")

    # Discover all subscribers via name search
    print("\n→ Discovering ManyChat subscribers...")
    subscribers_dict = discover_all_subscribers()

    if not subscribers_dict:
        print("\n→ No subscribers found.")
        print("  This could mean:")
        print("  • No one has interacted with your ManyChat automations yet")
        print("  • Your ManyChat plan may limit API access")
        print("  • Subscribers may not have names set")
        print("\n  Tip: Once someone DMs a keyword like 'OPEN' to your IG,")
        print("  they'll appear as a ManyChat subscriber and sync here.")
        return

    # Enrich with full details (tags, custom fields)
    subscribers = enrich_subscribers(subscribers_dict)

    # Sync each subscriber to CRM
    print(f"\n→ Syncing {len(subscribers)} subscribers to CRM...\n")
    created = 0
    updated = 0
    skipped = 0

    for i, sub in enumerate(subscribers):
        try:
            result = sync_subscriber(sub, supabase)
            if result == "created":
                created += 1
                name = sub.get("name") or sub.get("ig_username") or sub.get("id")
                print(f"  ✓ New contact: {name}")
            elif result == "updated":
                updated += 1
            else:
                skipped += 1
        except Exception as e:
            print(f"  ✗ Error syncing subscriber {sub.get('id', '?')}: {e}")
            skipped += 1

        # Progress update every 25 subscribers
        if (i + 1) % 25 == 0:
            print(f"  ... processed {i + 1}/{len(subscribers)}")

    print(f"\n→ Sync complete!")
    print(f"  ✓ Created: {created}")
    print(f"  ↻ Updated: {updated}")
    print(f"  — Skipped: {skipped}")
    print("=" * 50)


if __name__ == "__main__":
    main()
