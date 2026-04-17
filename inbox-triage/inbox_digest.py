"""
Swoon Inbox Digest — Daily Gmail Triage

Scans chloeprent@gmail.com for mail that arrived in the last 24 hours,
categorizes it using the Gmail labels we set up (Unsubscribe queue,
Transactions, Coaching/Platform, etc.), and emails you a morning digest
summarizing what arrived and what needs your actual attention.

Read-only IMAP — never deletes or modifies any email.
Sends digest to chloe@swoon.coach.

Run: python inbox_digest.py
Schedule: daily at 7am via launchd
"""
import os
import re
import imaplib
import smtplib
import email
from email.header import decode_header
from email.utils import parseaddr, parsedate_to_datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from datetime import datetime, timezone, timedelta
from collections import defaultdict, Counter
from pathlib import Path

# Load env from ../lead-listener/.env (which has Gmail credentials set up)
ENV_FILE = Path(__file__).parent.parent / 'lead-listener' / '.env'
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

GMAIL_ADDRESS     = os.environ['GMAIL_ADDRESS']
GMAIL_APP_PW      = os.environ['GMAIL_APP_PASSWORD']
DIGEST_TO_EMAIL   = os.environ.get('DIGEST_TO_EMAIL', GMAIL_ADDRESS)

# Labels we care about (created by our filter XML import).
# Order matters for priority display.
KNOWN_LABELS = [
    'Coaching/Platform',
    'Transactions',
    'Rentals',
    'Travel',
    'Work',
    'Personal',
    'My Newsletter',
    'Reading',
    'Auto-archive',
    'Unsubscribe queue',
]

# Domain/address hints that mean "definitely not a human replying to me"
NOREPLY_HINTS = re.compile(
    r'(noreply|no-reply|donotreply|do-not-reply|notifications?@|mailer-daemon|'
    r'news@|newsletter@|updates?@|reply\+|bounce|automated|postmaster)',
    re.IGNORECASE,
)

# Priority keywords that suggest the email needs a response
URGENT_KEYWORDS = re.compile(
    r'\b(urgent|asap|deadline|tomorrow|today|please respond|'
    r'waiting for|can you|could you|do you want|are you available|'
    r'reschedule|cancel|refund|invoice due|payment due|past due)\b',
    re.IGNORECASE,
)


def decode_subj(raw):
    try:
        parts = decode_header(raw or '')
        return ''.join(
            (p.decode(c or 'utf-8', errors='replace') if isinstance(p, bytes) else p)
            for p, c in parts
        ).strip()
    except Exception:
        return str(raw or '').strip()


def parse_labels_from_response(resp_bytes):
    """Extract X-GM-LABELS from an IMAP fetch response chunk."""
    if not resp_bytes:
        return []
    text = resp_bytes.decode('utf-8', errors='replace') if isinstance(resp_bytes, bytes) else resp_bytes
    m = re.search(r'X-GM-LABELS\s*\(([^)]*)\)', text)
    if not m:
        return []
    inner = m.group(1)
    # Labels are space-separated, quoted ones preserve spaces
    labels = re.findall(r'"([^"]+)"|(\S+)', inner)
    return [a or b for a, b in labels if (a or b)]


def classify(sender_addr, sender_name, subject, labels):
    """Return ('category', display_label) for this message."""
    # First, check our known labels
    for lbl in KNOWN_LABELS:
        if lbl in labels:
            return (lbl, lbl)

    # Gmail system categories
    sys_cat_map = {
        'CATEGORY_PROMOTIONS': ('Promotions (Gmail)', 'Promotions'),
        'CATEGORY_SOCIAL':     ('Social (Gmail)',      'Social'),
        'CATEGORY_UPDATES':    ('Updates (Gmail)',     'Updates'),
        'CATEGORY_FORUMS':     ('Forums (Gmail)',      'Forums'),
    }
    for sys_label, cat in sys_cat_map.items():
        if sys_label in labels:
            return cat

    # Spam / Trash shouldn't appear but guard anyway
    if '\\Spam' in labels or '\\Trash' in labels:
        return ('Spam/Trash', 'Spam')

    # Unclassified — is it a human?
    addr = (sender_addr or '').lower()
    if NOREPLY_HINTS.search(addr):
        return ('Unclassified notification', '(automated)')

    # Looks human — this is the bucket that needs attention
    return ('Needs attention', '👤 Human')


def build_html(digest):
    """Build the HTML email body."""
    d = digest
    pieces = []
    pieces.append(f"""
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#2d2926;background:#faf8f5;">
  <div style="background:#fff;border-radius:16px;padding:24px 28px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
    <h1 style="font-size:20px;margin:0 0 4px;color:#8b6f5e;font-family:Georgia,serif;">📬 Your Gmail overnight</h1>
    <p style="color:#a09080;font-size:13px;margin:0 0 20px;">
      {d['window_label']} &middot; {d['new_total']} new emails &middot; inbox: {d['inbox_total']} ({d['inbox_unread']} unread)
    </p>
""")

    # TOP SECTION — Needs attention (humans + urgent)
    needs = d['categories'].get('Needs attention', [])
    if needs:
        pieces.append(f"""
    <div style="background:#fff8e1;border-left:4px solid #ffc107;border-radius:8px;padding:14px 18px;margin-bottom:16px;">
      <h2 style="font-size:15px;margin:0 0 10px;color:#e65100;">🎯 Needs your attention ({len(needs)})</h2>
""")
        for m in needs[:10]:
            urgent = '🔥 ' if URGENT_KEYWORDS.search(m['subject']) else ''
            pieces.append(f"""
      <div style="padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:13.5px;">
        <strong>{urgent}{html_escape(m['from_name'] or m['from_addr'])}</strong><br>
        <span style="color:#555;">{html_escape(m['subject'])[:90]}</span><br>
        <span style="color:#a09080;font-size:11px;">{html_escape(m['from_addr'])} &middot; {m['time_label']}</span>
      </div>""")
        if len(needs) > 10:
            pieces.append(f'<p style="font-size:12px;color:#a09080;margin-top:8px;">+ {len(needs)-10} more…</p>')
        pieces.append('</div>')

    # Other categories — compact summary
    pieces.append('<h2 style="font-size:14px;color:#5a4a3a;margin:18px 0 10px;">Auto-sorted into labels</h2>')
    pieces.append('<table style="width:100%;border-collapse:collapse;font-size:13px;">')
    for cat in ['Coaching/Platform', 'Transactions', 'Rentals', 'Travel',
                'Work', 'Personal', 'My Newsletter', 'Reading',
                'Promotions (Gmail)', 'Social (Gmail)', 'Updates (Gmail)',
                'Auto-archive', 'Unsubscribe queue', 'Unclassified notification']:
        msgs = d['categories'].get(cat, [])
        if not msgs:
            continue
        emoji_map = {
            'Coaching/Platform': '🧡', 'Transactions': '🧾', 'Rentals': '🏘️',
            'Travel': '🧭', 'Work': '💼', 'Personal': '📁',
            'My Newsletter': '✉️', 'Reading': '📰',
            'Promotions (Gmail)': '🛍️', 'Social (Gmail)': '👥',
            'Updates (Gmail)': '🔔', 'Auto-archive': '🗄️',
            'Unsubscribe queue': '🗑️', 'Unclassified notification': '🤖',
        }
        emoji = emoji_map.get(cat, '•')
        # List top 3 senders
        sender_counts = Counter(m['from_addr'] for m in msgs)
        top = ', '.join(s.split('@')[0] for s, _ in sender_counts.most_common(3))
        pieces.append(f"""
      <tr>
        <td style="padding:6px 0;width:30px;">{emoji}</td>
        <td style="padding:6px 0;"><strong>{cat}</strong> <span style="color:#a09080;">&middot; {top}</span></td>
        <td style="padding:6px 0;text-align:right;color:#8b6f5e;font-weight:600;">{len(msgs)}</td>
      </tr>""")
    pieces.append('</table>')

    # Footer
    pieces.append(f"""
    <div style="margin-top:20px;padding-top:14px;border-top:1px solid #f0ebe5;font-size:12px;color:#a09080;">
      Generated {d['generated_at']} &middot; chloeprent@gmail.com
    </div>
  </div>
</div>
""")
    return ''.join(pieces)


def html_escape(s):
    s = str(s or '')
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


def main():
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    since_imap = since.strftime('%d-%b-%Y')

    print(f"Connecting to Gmail IMAP as {GMAIL_ADDRESS}...")
    M = imaplib.IMAP4_SSL('imap.gmail.com')
    M.login(GMAIL_ADDRESS, GMAIL_APP_PW)
    M.select('"[Gmail]/All Mail"', readonly=True)

    # Search for mail received since yesterday
    status, data = M.search(None, f'SINCE {since_imap}')
    uids = data[0].split() if data[0] else []
    print(f"  found {len(uids)} messages since {since_imap}")

    # Also get inbox totals for context
    M.select('INBOX', readonly=True)
    status, all_in = M.search(None, 'ALL')
    inbox_total = len(all_in[0].split()) if all_in[0] else 0
    status, unread_in = M.search(None, 'UNSEEN')
    inbox_unread = len(unread_in[0].split()) if unread_in[0] else 0

    # Re-select All Mail for the categorization scan
    M.select('"[Gmail]/All Mail"', readonly=True)

    # Fetch headers + labels for each
    by_cat = defaultdict(list)
    new_total = 0

    BATCH = 100
    for i in range(0, len(uids), BATCH):
        batch = uids[i:i+BATCH]
        if not batch:
            continue
        uid_str = b','.join(batch).decode()
        try:
            status, msgs = M.fetch(
                uid_str,
                '(X-GM-LABELS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])'
            )
        except Exception as e:
            print(f"  batch error: {e}")
            continue

        # Pair up the response items — each message is 2 or more tuple entries
        buffer_labels = []
        for item in msgs:
            if isinstance(item, tuple):
                header_bytes = item[1]
                # The preamble item[0] carries X-GM-LABELS metadata
                labels = parse_labels_from_response(item[0])
                try:
                    msg = email.message_from_bytes(header_bytes)
                except Exception:
                    continue

                # Get date and make sure it's within last 24h (SINCE is date-only, not time)
                date_hdr = msg.get('Date', '')
                try:
                    dt = parsedate_to_datetime(date_hdr)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                except Exception:
                    dt = None
                if dt and dt < since:
                    continue

                from_raw = msg.get('From', '')
                from_name, from_addr = parseaddr(from_raw)
                subject = decode_subj(msg.get('Subject', ''))

                cat, display = classify(from_addr.lower(), from_name, subject, labels)

                hours_ago = int((datetime.now(timezone.utc) - dt).total_seconds() / 3600) if dt else 0
                time_label = f'{hours_ago}h ago' if hours_ago > 0 else 'just now'

                by_cat[cat].append({
                    'from_name': from_name,
                    'from_addr': from_addr,
                    'subject': subject,
                    'labels': labels,
                    'time_label': time_label,
                })
                new_total += 1

    M.logout()

    print(f"  classified {new_total} messages into {len(by_cat)} categories")
    for cat, msgs in sorted(by_cat.items(), key=lambda x: -len(x[1])):
        print(f"    {cat}: {len(msgs)}")

    if new_total == 0:
        print("No new mail — skipping digest email.")
        return

    digest = {
        'window_label': f'since {since.strftime("%b %-d %-I:%M %p")}',
        'new_total': new_total,
        'inbox_total': inbox_total,
        'inbox_unread': inbox_unread,
        'categories': dict(by_cat),
        'generated_at': datetime.now().strftime('%b %-d %Y, %-I:%M %p'),
    }

    html = build_html(digest)
    needs_n = len(by_cat.get('Needs attention', []))
    today = datetime.now().strftime('%b %-d')

    msg = MIMEMultipart('alternative')
    msg['Subject'] = (
        f"📬 Inbox digest — {today} "
        f"({needs_n} need{'s' if needs_n==1 else ''} attention, {new_total} total)"
    )
    msg['From'] = GMAIL_ADDRESS
    msg['To'] = DIGEST_TO_EMAIL
    msg.attach(MIMEText(html, 'html'))

    print(f"Sending digest to {DIGEST_TO_EMAIL}...")
    with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
        server.login(GMAIL_ADDRESS, GMAIL_APP_PW)
        server.send_message(msg)
    print("✓ Digest sent")


if __name__ == '__main__':
    main()
