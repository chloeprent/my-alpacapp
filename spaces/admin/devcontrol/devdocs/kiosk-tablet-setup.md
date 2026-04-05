# Kiosk Tablet Setup — M4 MacBook Air Prompt

> **Run this on the M4 MacBook Air (Alpuca).** This machine is on the same WiFi as the hallway kiosk tablet and has ADB installed.

## Prompt

Paste this into a Claude Code session on the M4 MacBook Air:

---

The hallway kiosk tablet is a Samsung Galaxy Tab A9 (SM-X210) wall-mounted in the hallway. It runs Fully Kiosk Browser displaying `alpacaplayhouse.com/kioskhall/`.

### Device Info

- **Tailscale IP:** `100.103.110.7`
- **ADB Serial:** `R95Y301R05A`
- **Kiosk API:** port `2323`, password `alpaca2323`
- **Kiosk Settings Password:** `1234` (triple-tap bottom-right to exit kiosk mode)
- **WiFi:** Black Rock City (same LAN as this machine)

### Task: Set up UniFi dashboard rotation

The kiosk rotates 3 views every 15 seconds: guestbook, UniFi network dashboard, and slideshow. The UniFi dashboard needs to be logged in once so the session cookie persists.

**Step 1 — Verify connectivity:**

```bash
# Try the Fully Kiosk Browser API
curl -s "http://100.103.110.7:2323/?cmd=getDeviceInfo&password=alpaca2323" | head -20

# If that fails, try ADB
adb connect 100.103.110.7:5555
adb devices
```

**Step 2 — Load UniFi dashboard on the tablet:**

```bash
# Via Fully Kiosk API (preferred)
curl "http://100.103.110.7:2323/?cmd=loadUrl&url=https%3A%2F%2F192.168.1.1%2Fnetwork%2Fdefault%2Fdashboard&password=alpaca2323"

# Or via ADB (fallback)
adb shell am start -a android.intent.action.VIEW -d 'https://192.168.1.1/network/default/dashboard'
```

**Step 3 — Log in manually:**

On the tablet screen, log in to the UniFi console:
- **Username:** `alpacaauto`
- **Password:** check `HOMEAUTOMATION.local.md` (gitignored) or Bitwarden
- **Check "Remember me"** so the session persists (~24 hours)

**Step 4 — Return to kiosk:**

```bash
curl "http://100.103.110.7:2323/?cmd=loadUrl&url=https%3A%2F%2Falpacaplayhouse.com%2Fkioskhall%2F&password=alpaca2323"
```

**Step 5 — Verify rotation is working:**

Wait ~45 seconds. The kiosk should cycle through:
1. Guestbook/occupants/alpaca facts (15s)
2. UniFi network dashboard popup — should show logged-in dashboard (15s)
3. AI alpaca slideshow (15s)

### Bonus: Persist tablet settings after OS updates

If the tablet had a Samsung OS update, also run:

```bash
adb shell dumpsys deviceidle whitelist +com.tailscale.ipn
adb shell cmd appops set com.tailscale.ipn RUN_IN_BACKGROUND allow
adb shell settings put global auto_update 0
adb shell pm disable-user --user 0 com.sec.android.soagent
adb shell pm disable-user --user 0 com.sec.android.app.samsungapps
```

### Troubleshooting

- **Can't reach tablet:** Check Tailscale is running on both machines. Try `ping 100.103.110.7`. Also try the LAN IP (check UniFi for current DHCP lease).
- **Popup blocked:** In the tablet's browser settings, allow popups for `alpacaplayhouse.com`.
- **ADB not connecting:** Wireless debugging may need re-enabling. Triple-tap bottom-right of kiosk (password: `1234`), go to Settings → Developer Options → Wireless Debugging → ON. Then pair: `adb pair <ip>:<pair-port>`.
- **UniFi session expired:** Repeat steps 2-4 to log in again. Sessions last ~24 hours.
- **Full setup instructions page:** `alpacaplayhouse.com/kioskhall/setup.html`
