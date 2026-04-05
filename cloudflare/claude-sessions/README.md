# Claude Sessions Archive

Auto-saves every Claude Code session transcript to Cloudflare D1 (serverless SQLite). A `Stop` hook fires on every agent response, reads the JSONL transcript from disk, and posts it to a Cloudflare Worker that stores it in D1. Built-in rate-limiting ensures each session is only saved once every 5 minutes.

## Setup

### 1. Create the D1 database

```bash
npx wrangler d1 create claude-sessions
```

Copy the `database_id` from the output and paste it into `wrangler.jsonc`.

### 2. Run the schema

```bash
npx wrangler d1 execute claude-sessions --file=schema.sql --remote
```

### 3. Set your auth token

Edit `src/index.js` and change `AUTH_TOKEN` to a secret of your choice.

### 4. Deploy the Worker

```bash
npx wrangler deploy
```

Note the Worker URL from the output (e.g., `https://claude-sessions.YOUR-SUBDOMAIN.workers.dev`).

### 5. Install the hook

```bash
cp hooks/save-session.sh ~/.claude/hooks/save-session.sh
chmod +x ~/.claude/hooks/save-session.sh
```

Edit `~/.claude/hooks/save-session.sh` and set:
- `API_URL` to your Worker URL + `/sessions`
- `API_TOKEN` to the token you chose in step 3

Then add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/save-session.sh",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

**IMPORTANT:** Use the `Stop` event, **not** `SessionEnd`. The `SessionEnd` event does not fire for worktree/subagent sessions, which means those sessions would never be saved. The `Stop` event fires every time Claude stops generating, which reliably captures all sessions. The hook includes a 5-minute rate limit per session to avoid duplicate saves.

**Note:** Running sessions won't pick up new `settings.json` hooks — only sessions started after the config change will auto-save.

### 6. Verify

Start a new Claude Code session, send a message, then check:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://YOUR-WORKER.workers.dev/sessions?limit=1
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sessions` | Save a session (INSERT OR REPLACE — idempotent) |
| `GET` | `/sessions` | List sessions (supports `?limit=`, `?offset=`, `?search=`, `?from=`, `?to=`, `?project=`) |
| `GET` | `/sessions/:id` | Get full session with transcript |
| `GET` | `/stats` | Aggregate stats (total sessions, tokens, hours) — durations capped at < 1440 min |
| `POST` | `/fix-timestamps` | Repair `ended_at` for bulk-imported sessions |

All endpoints require `Authorization: Bearer YOUR_TOKEN` header.

## How it works

1. Every time Claude Code stops generating (the `Stop` hook fires), the hook script:
   - Reads the session ID from stdin (provided by Claude)
   - Checks a local lock file to avoid re-saving within 5 minutes
   - Finds the session's JSONL file in `~/.claude/projects/`
   - Parses the JSONL to extract messages, timestamps, model, and token counts
   - Calculates duration from actual JSONL timestamps (first → last)
   - POSTs the data to the Cloudflare Worker

2. The Worker stores everything in D1 using `COALESCE(?, datetime('now'))` for `ended_at`, so it uses the hook's actual timestamp when available and falls back to save-time only if missing.

3. Sessions are sorted by `COALESCE(started_at, ended_at)` for reliable ordering even when timestamps are partially missing.

## Troubleshooting

- **Sessions not saving:** Check that the hook is executable (`chmod +x`) and the `Stop` hook is registered in `~/.claude/settings.json`.
- **Auth errors:** Verify the token in `save-session.sh` matches `AUTH_TOKEN` in `src/index.js`.
- **No JSONL file found:** Sessions are stored in `~/.claude/projects/*/SESSION_ID.jsonl`. Check `PROJECTS_DIR` in the hook script.
- **Rate limiting:** The hook only saves once every 5 minutes per session. Delete `~/.claude/hooks/.session-locks/SESSION_ID` to force a re-save.
- **Wrong durations:** Duration is calculated from actual JSONL timestamps (first message → last message), not `now() - start`.

## Cost

Cloudflare D1 free tier: 5M reads/day, 100K writes/day, 5GB storage. More than enough for personal use.
