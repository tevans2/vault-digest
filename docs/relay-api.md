# The message relay

The message channel fetches Telegram messages from a small relay you host. The relay's only job is to receive Telegram's webhook and keep updates in a queue until the plugin collects them. The plugin needs these endpoints, all authenticated with `Authorization: Bearer <token>`.

| Endpoint | Purpose |
|---|---|
| `GET /api/captures?status=pending&limit=50` | Oldest-first queue of stored updates. |
| `POST /api/captures/{relay_id}/ack` with `{"status": "done" \| "failed" \| "pending", "error": string \| null}` | Mark an update handled. |
| `GET /api/stats` | `{"counts": {"pending": n, "done": n, "failed": n}}` |

`GET /api/captures` returns:

```json
{
  "ok": true,
  "captures": [
    {
      "relay_id": 12,
      "update_id": 131035809,
      "chat_id": "123456789",
      "message_id": 88,
      "received_at": "2026-10-03T16:42:11Z",
      "status": "pending",
      "update": { "update_id": 131035809, "message": { "text": "buy milk friday", "chat": { "id": 123456789 } } }
    }
  ]
}
```

`update` is the raw Telegram update. The relay doesn't download files: the plugin fetches photos and voice notes from Telegram itself, using the bot token.

## What the plugin does with it

1. Saves each message as a note, then acknowledges it on the relay. A message is never acknowledged before it is safely in the vault.
2. Only accepts messages from the chat id you configure.
3. Downloads photos and voice notes (Telegram's 20 MB bot limit applies), transcribes voice notes and describes photos with OpenAI if you've set a key.

## Configuration

Settings → Vault Digest → Messages: relay URL (must be https), relay API token, bot token, OpenAI key (all stored as Obsidian secrets), and your Telegram chat id.
