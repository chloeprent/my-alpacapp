# Slack Alpaclaw agent not responding — reinstall and troubleshoot

When you change **scopes** or **event subscriptions** on the Slack app, Slack requires you to **reinstall the app to the workspace**. Until you do, the app won’t receive events (e.g. messages in `#alpaclaw-agent`) and the Hostinger Alpaclaw agent will not respond.

## 1. Reinstall the Slack app (manual, required)

1. Open the Slack app config: **[https://api.slack.com/apps/A0AJRUVQV8T](https://api.slack.com/apps/A0AJRUVQV8T)**
2. In the left sidebar, click **OAuth & Permissions**.
3. If you see a yellow/orange banner at the top saying you’ve changed scopes or events and need to reinstall:
   - Click **Reinstall to Workspace** (or the button in the banner).
   - Complete the authorization flow.
4. If there is **no** reinstall banner on OAuth & Permissions:
   - In the left sidebar, click **Event Subscriptions**.
   - Check for the same kind of banner there and click **Reinstall to Workspace** if shown.
5. After reinstalling, send a test message in **#alpaclaw-agent** and see if Alpaclaw replies.

Reinstall is a **manual step** in the Slack API dashboard; it cannot be done from code or from the Hostinger server.

## 2. If it still doesn’t respond after reinstall

- **Confirm Slack is enabled in OpenClaw**  
  On Hostinger, inside the container:
  ```bash
  docker exec openclaw-vnfd-openclaw-1 cat /data/.openclaw/openclaw.json
  ```
  Check that `channels.slack.enabled` is `true` and that there is a binding for the Slack channel you use (e.g. `#alpaclaw-agent`).

- **Watch OpenClaw logs while you send a message**  
  On Hostinger:
  ```bash
  cd /docker/openclaw-vnfd && docker compose logs -f --tail=100
  ```
  Send a message in `#alpaclaw-agent`. If you see no Slack-related log lines (e.g. socket connection, event received), the workspace still isn’t sending events to the app — double-check reinstall and Event Subscriptions (including **Subscribe to bot events** and the correct channel).

- **Socket Mode**  
  OpenClaw uses Slack Socket Mode (no public URL). In the Slack app: **App-Level Tokens** must have a token with `connections:write`, and **Socket Mode** must be enabled. Reinstall applies to OAuth/scopes; Socket Mode is separate but must be set up for the bot to receive events.

- **Admin UI**  
  In **Alpaclaw** admin (`/spaces/admin/alpaclaw.html`): ensure Slack is enabled and the **Bot Token** (`xoxb-...`) is the one from the same Slack app (A0AJRUVQV8T) and is the token that was reinstalled.

## Summary

| Step | Action |
|------|--------|
| 1 | [Open Slack app](https://api.slack.com/apps/A0AJRUVQV8T) → OAuth & Permissions (or Event Subscriptions) |
| 2 | Click **Reinstall to Workspace** if the banner is present |
| 3 | Test in **#alpaclaw-agent** |
| 4 | If still silent: check OpenClaw Slack config, logs, and Socket Mode |
