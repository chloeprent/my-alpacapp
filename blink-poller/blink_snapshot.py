#!/usr/bin/env python3
"""
Blink Camera Snapshot Poller (Python/blinkpy)

Authenticates to Blink cloud API, fetches camera thumbnails,
and uploads them to Supabase Storage for display on the cameras page.

Deploy to: ~/blink-poller/ on Alpaca Mac (residential IP needed — Blink
blocks datacenter IPs via Cloudflare)

Usage:
  First run (2FA setup):  python3 blink_snapshot.py --setup
  Daemon mode:            python3 blink_snapshot.py
  Single poll:            python3 blink_snapshot.py --once

Environment variables (or .env file):
  SUPABASE_URL              - Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY - Service role key for storage uploads
  BLINK_EMAIL               - Blink account email
  BLINK_PASSWORD            - Blink account password
  POLL_INTERVAL             - Poll interval in seconds (default: 60)
"""

import asyncio
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# Load .env file if present
env_path = Path(__file__).parent / '.env'
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, _, val = line.partition('=')
            os.environ.setdefault(key.strip(), val.strip())

SUPABASE_URL = os.environ.get('SUPABASE_URL', 'https://aphrrfprbixmhissnjfn.supabase.co')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
BLINK_EMAIL = os.environ.get('BLINK_EMAIL', '')
BLINK_PASSWORD = os.environ.get('BLINK_PASSWORD', '')
POLL_INTERVAL = int(os.environ.get('POLL_INTERVAL', '60'))
CRED_FILE = str(Path(__file__).parent / '.blink-cred.json')
STORAGE_BUCKET = 'housephotos'
SNAPSHOT_PATH = 'cameras/blink-latest.jpg'


def log(level, msg, **kwargs):
    ts = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    extra = f' {json.dumps(kwargs)}' if kwargs else ''
    print(f'[{ts}] [{level}] {msg}{extra}', flush=True)


def upload_to_supabase(jpeg_bytes, path=SNAPSHOT_PATH):
    """Upload JPEG to Supabase Storage via REST API."""
    url = f'{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{path}'
    headers = {
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'apikey': SUPABASE_KEY,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'true',
        'Cache-Control': 'max-age=30',
    }
    req = urllib.request.Request(url, data=jpeg_bytes, headers=headers, method='PUT')
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status in (200, 201):
                log('INFO', f'Uploaded {path} ({len(jpeg_bytes) / 1024:.1f}KB)')
                return True
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')[:200]
        log('ERROR', f'Upload failed ({e.code}): {body}')
    except Exception as e:
        log('ERROR', f'Upload error: {e}')
    return False


async def setup_blink(pin=None):
    """2FA setup for first-time auth. Pass pin=None to trigger 2FA, pin='123456' to verify."""
    from aiohttp import ClientSession
    from blinkpy.blinkpy import Blink
    from blinkpy.auth import Auth

    log('INFO', '=== Blink 2FA Setup ===')

    async with ClientSession() as session:
        blink = Blink(session=session)
        auth = Auth(
            {'username': BLINK_EMAIL, 'password': BLINK_PASSWORD},
            no_prompt=True,
            session=session,
        )
        blink.auth = auth

        from blinkpy.auth import BlinkTwoFARequiredError
        needs_2fa = False
        try:
            await blink.start()
            log('INFO', 'Login succeeded without 2FA!')
        except BlinkTwoFARequiredError:
            log('INFO', '2FA is required')
            needs_2fa = True
        except Exception as e:
            log('ERROR', f'Login failed: {type(e).__name__}: {e}')
            raise

        if needs_2fa:
            if not pin:
                log('INFO', '2FA code has been sent to your email/phone.')
                log('INFO', 'Run again with: python3 blink_snapshot.py --setup --pin YOUR_PIN')
                return

            log('INFO', f'Submitting 2FA pin...')
            result = await auth.complete_2fa_login(pin)
            if not result:
                log('ERROR', '2FA verification failed. Check the PIN and try again.')
                return

            log('INFO', '2FA verification successful! Initializing...')
            # Re-start blink now that 2FA is complete — token is valid
            try:
                await blink.start()
            except Exception as e:
                # If setup_post_verify is needed instead
                log('WARN', f'Re-start raised {type(e).__name__}, trying setup_post_verify...')
                try:
                    await blink.setup_post_verify()
                except Exception as e2:
                    log('ERROR', f'Post-verify also failed: {e2}')
                    # Still save what we have
                    pass

        # Save credentials
        await blink.save(CRED_FILE)
        log('INFO', f'Credentials saved to {CRED_FILE}')

        # Show cameras
        for name, camera in blink.cameras.items():
            log('INFO', f'Camera: {name}', status=camera.arm)

        log('INFO', 'Setup complete! Run without --setup for daemon mode.')


async def poll_once(blink):
    """Request fresh snapshot, wait for capture, then fetch and upload."""
    # Step 1: Request the camera to take a new photo
    for name, camera in blink.cameras.items():
        try:
            await camera.snap_picture()
            log('INFO', f'Snap requested for {name}')
        except Exception as e:
            log('WARN', f'Snap request failed for {name}: {e}')

    # Step 2: Wait for the camera to capture and upload to Blink cloud
    await asyncio.sleep(15)

    # Step 3: Refresh to get the updated thumbnail URL
    await blink.refresh(force=True)

    # Step 4: Upload the fresh image
    for i, (name, camera) in enumerate(blink.cameras.items()):
        jpeg = camera.image_from_cache
        if not jpeg or len(jpeg) < 100:
            log('WARN', f'No thumbnail for {name}')
            continue

        safe_name = name.lower().replace(' ', '-').replace('/', '-')
        upload_to_supabase(jpeg, f'cameras/blink-{safe_name}-latest.jpg')

        if i == 0:
            upload_to_supabase(jpeg, SNAPSHOT_PATH)

        log('INFO', f'{name}: {len(jpeg)/1024:.1f}KB')


async def run_daemon():
    """Main polling loop."""
    from aiohttp import ClientSession
    from blinkpy.blinkpy import Blink
    from blinkpy.auth import Auth
    from blinkpy.helpers.util import json_load

    log('INFO', f'Blink Poller starting. Interval: {POLL_INTERVAL}s')

    if not Path(CRED_FILE).exists():
        log('ERROR', f'No saved credentials at {CRED_FILE}. Run with --setup first.')
        sys.exit(1)

    async with ClientSession() as session:
        blink = Blink(session=session)
        auth = Auth(await json_load(CRED_FILE), no_prompt=True, session=session)
        blink.auth = auth

        try:
            await blink.start()
        except Exception as e:
            if '2FA' in str(type(e).__name__):
                log('ERROR', '2FA required. Run with --setup first.')
                sys.exit(1)
            raise

        log('INFO', f'Authenticated. Found {len(blink.cameras)} camera(s)',
            cameras=list(blink.cameras.keys()))

        # Polling loop
        while True:
            try:
                await poll_once(blink)
            except Exception as e:
                log('ERROR', f'Poll error: {e}')
            await asyncio.sleep(POLL_INTERVAL)


def main():
    if not BLINK_EMAIL or not BLINK_PASSWORD:
        print('BLINK_EMAIL and BLINK_PASSWORD are required')
        sys.exit(1)
    if not SUPABASE_KEY:
        print('SUPABASE_SERVICE_ROLE_KEY is required')
        sys.exit(1)

    if '--setup' in sys.argv:
        pin = None
        if '--pin' in sys.argv:
            pin_idx = sys.argv.index('--pin') + 1
            if pin_idx < len(sys.argv):
                pin = sys.argv[pin_idx]
        asyncio.run(setup_blink(pin=pin))
    elif '--once' in sys.argv:
        # Run a single poll then exit
        async def once():
            from aiohttp import ClientSession
            from blinkpy.blinkpy import Blink
            from blinkpy.auth import Auth
            from blinkpy.helpers.util import json_load
            async with ClientSession() as session:
                blink = Blink(session=session)
                auth = Auth(await json_load(CRED_FILE), no_prompt=True, session=session)
                blink.auth = auth
                await blink.start()
                await poll_once(blink)
                await blink.save(CRED_FILE)
        asyncio.run(once())
    else:
        asyncio.run(run_daemon())


if __name__ == '__main__':
    main()
