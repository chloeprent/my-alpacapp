"""
Swoon Receipt Forwarder — Daily bookkeeper forward

Finds receipts in the 'Transactions' Gmail label from the last 24 hours
that haven't already been forwarded, forwards each to the bookkeeper,
and adds a 'Forwarded' label so the script never double-forwards.

Read-original-mail only + sends new mail + adds a label to originals.
Never deletes or modifies the originals.

Config via env (inherits from ../lead-listener/.env):
  GMAIL_ADDRESS            chloeprent@gmail.com
  GMAIL_APP_PASSWORD       (app password)
  BOOKKEEPER_EMAIL         anna032375@gmail.com
  FORWARD_LOOKBACK_HOURS   24  (override for catch-up runs)

Run: python forward_receipts.py
Schedule: daily at 8am via launchd
"""
import os
import imaplib
import smtplib
import email
import email.policy
from email.header import decode_header
from email.utils import parseaddr, parsedate_to_datetime, make_msgid, formatdate
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ── Load env ──
ENV_FILE = Path(__file__).parent.parent / 'lead-listener' / '.env'
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

GMAIL_ADDRESS     = os.environ['GMAIL_ADDRESS']
GMAIL_APP_PW      = os.environ['GMAIL_APP_PASSWORD']
BOOKKEEPER_EMAIL  = os.environ.get('BOOKKEEPER_EMAIL', 'anna032375@gmail.com')
LOOKBACK_HOURS    = int(os.environ.get('FORWARD_LOOKBACK_HOURS', '24'))

# Safety cap — max receipts forwarded per run
MAX_PER_RUN = int(os.environ.get('FORWARD_MAX_PER_RUN', '40'))

# Dry-run mode: list what would be forwarded, don't actually send or label
DRY_RUN = os.environ.get('DRY_RUN', '').lower() in ('1', 'true', 'yes')

# Label names (must match what the filter XML created)
SOURCE_LABEL   = 'Transactions'
FORWARDED_LABEL = 'Forwarded'


def decode_subj(raw):
    try:
        parts = decode_header(raw or '')
        return ''.join(
            (p.decode(c or 'utf-8', errors='replace') if isinstance(p, bytes) else p)
            for p, c in parts
        ).strip()
    except Exception:
        return str(raw or '').strip()


def ensure_forwarded_label(M):
    """Create the 'Forwarded' label in Gmail if it doesn't already exist."""
    # list_ returns like: '(\\HasNoChildren) "/" "Forwarded"'
    typ, data = M.list()
    existing = set()
    for row in data or []:
        # Get the last quoted segment
        s = row.decode(errors='replace') if isinstance(row, bytes) else row
        if '"' in s:
            existing.add(s.rsplit('"', 2)[-2])
    if FORWARDED_LABEL not in existing:
        print(f"  creating label '{FORWARDED_LABEL}'...")
        M.create(f'"{FORWARDED_LABEL}"')


def find_receipts_to_forward(M):
    """Return list of UIDs in Transactions label but not Forwarded, within lookback."""
    since = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)
    since_imap = since.strftime('%d-%b-%Y')
    # Need to select All Mail so label-based search finds archived items too
    M.select('"[Gmail]/All Mail"', readonly=False)
    # Search: has Transactions label, no Forwarded label, recent
    # IMAP search syntax: X-GM-LABELS "label" | -X-GM-LABELS "label"
    try:
        status, data = M.search(
            None,
            f'X-GM-LABELS "{SOURCE_LABEL}"',
            f'NOT X-GM-LABELS "{FORWARDED_LABEL}"',
            f'SINCE {since_imap}',
        )
    except Exception as e:
        print(f"  search error: {e}")
        return []
    uids = data[0].split() if data and data[0] else []
    # Cap
    if len(uids) > MAX_PER_RUN:
        print(f"  ⚠️  Capping from {len(uids)} → {MAX_PER_RUN} (safety limit; override via FORWARD_MAX_PER_RUN)")
        uids = uids[-MAX_PER_RUN:]
    return uids, since


def fetch_full(M, uid):
    """Return the raw RFC822 bytes of the message."""
    status, data = M.fetch(uid, '(RFC822)')
    if status != 'OK' or not data or not data[0]:
        return None
    return data[0][1]


def parse_headers(raw_bytes):
    msg = email.message_from_bytes(raw_bytes, policy=email.policy.default)
    return {
        'from': str(msg.get('From', '')),
        'from_name_addr': parseaddr(msg.get('From', '')),
        'subject': decode_subj(msg.get('Subject', '')),
        'date': msg.get('Date', ''),
        'to': str(msg.get('To', '')),
        'cc': str(msg.get('Cc', '')),
    }


def should_skip(headers):
    """Return a reason-string if this message should NOT be forwarded; None if OK."""
    subj = (headers['subject'] or '').lstrip().lower()
    # Skip replies and already-forwarded threads (human likely already handled)
    if subj.startswith('re:') or subj.startswith('fwd:') or subj.startswith('fw:'):
        return 'already forwarded/replied'
    # Skip if bookkeeper is already a recipient (already in the loop)
    bookkeeper_lower = BOOKKEEPER_EMAIL.lower()
    recipients = ' '.join([
        headers.get('to', ''), headers.get('cc', ''),
        headers.get('from', ''),
    ]).lower()
    if bookkeeper_lower in recipients:
        return 'bookkeeper already a recipient'
    return None


def build_forward(raw_bytes, headers):
    """Build an RFC822 forward email with the original as a .eml attachment."""
    from_name, from_addr = headers['from_name_addr']
    orig_subject = headers['subject']

    outer = MIMEMultipart()
    outer['From'] = GMAIL_ADDRESS
    outer['To'] = BOOKKEEPER_EMAIL
    outer['Subject'] = f'Fwd: {orig_subject}'
    outer['Date'] = formatdate(localtime=True)
    outer['Message-ID'] = make_msgid(domain='swoon.coach')

    body = (
        f"Hi Anna — forwarding this receipt for the books.\n\n"
        f"Original sender: {headers['from']}\n"
        f"Original subject: {orig_subject}\n"
        f"Original date: {headers['date']}\n\n"
        f"— Chloe (via automated receipt forwarder)\n"
    )
    outer.attach(MIMEText(body, 'plain'))

    # Attach original as .eml
    att = MIMEBase('message', 'rfc822')
    att.set_payload(raw_bytes)
    safe_subj = ''.join(c if c.isalnum() or c in ' -_' else '_' for c in orig_subject)[:60].strip() or 'receipt'
    att.add_header('Content-Disposition', 'attachment', filename=f'{safe_subj}.eml')
    outer.attach(att)

    return outer


def add_label(M, uid, label):
    """Apply Gmail label to a message."""
    M.store(uid, '+X-GM-LABELS', f'"{label}"')


def main():
    print(f"=== Receipt forwarder starting {datetime.now().isoformat()} ===")
    print(f"Bookkeeper: {BOOKKEEPER_EMAIL}")
    print(f"Lookback: {LOOKBACK_HOURS}h, max per run: {MAX_PER_RUN}")
    if DRY_RUN:
        print("  🔍 DRY RUN — no emails will be sent or labeled")

    # Connect read-write for label operations
    M = imaplib.IMAP4_SSL('imap.gmail.com')
    M.login(GMAIL_ADDRESS, GMAIL_APP_PW)

    ensure_forwarded_label(M)

    uids, since = find_receipts_to_forward(M)
    print(f"Found {len(uids)} receipts to forward (since {since.isoformat()})")

    if not uids:
        print("Nothing to do. Bye.")
        M.logout()
        return

    # Connect SMTP (only if not dry-run)
    smtp = None
    if not DRY_RUN:
        smtp = smtplib.SMTP_SSL('smtp.gmail.com', 465)
        smtp.login(GMAIL_ADDRESS, GMAIL_APP_PW)

    forwarded = 0
    failed = 0
    for uid in uids:
        raw = fetch_full(M, uid)
        if not raw:
            print(f"  uid {uid.decode()}: fetch failed, skipping")
            failed += 1
            continue
        headers = parse_headers(raw)
        frm = headers['from_name_addr'][1] or '(unknown)'
        skip_reason = should_skip(headers)
        if skip_reason:
            # Mark as "Forwarded" so we don't re-evaluate this message every day,
            # but only outside of dry-run mode.
            if not DRY_RUN:
                add_label(M, uid, FORWARDED_LABEL)
            print(f"  ⊘ SKIP ({skip_reason}): {frm[:30]:30s} | {headers['subject'][:60]}")
            continue
        if DRY_RUN:
            print(f"  📋 WOULD forward: {frm[:30]:30s} | {headers['subject'][:60]}")
            forwarded += 1
            continue
        try:
            outer = build_forward(raw, headers)
            smtp.send_message(outer)
            add_label(M, uid, FORWARDED_LABEL)
            forwarded += 1
            print(f"  ✓ {frm[:30]:30s} | {headers['subject'][:60]}")
        except Exception as e:
            print(f"  ✗ uid {uid.decode()}: {e}")
            failed += 1

    if smtp:
        smtp.quit()
    M.logout()

    print(f"\n=== Done: {forwarded} forwarded, {failed} failed ===")


if __name__ == '__main__':
    main()
