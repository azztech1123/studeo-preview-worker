# studeo-preview-worker

Generates 15-second MP4 previews of Studeo storybooks.

## Deploy in 5 minutes (no terminal, no CLI)

1. **Create a GitHub repo.** github.com → New repo → name it `studeo-preview-worker` → make it private → Create.
2. **Upload these 5 files.** On the empty repo page, click "uploading an existing file" and drag all 5 files in (Dockerfile, package.json, server.js, .dockerignore, this README). Commit.
3. **Deploy on Railway.** railway.com → New Project → Deploy from GitHub repo → pick the repo. Railway detects the Dockerfile and builds.
4. **Add your Hyperbrowser key.** In Railway, click the service → Variables tab → New Variable → `HB_KEY` = your Hyperbrowser API key.
5. **Generate a public URL.** Settings → Networking → Generate Domain. Copy it.

Done. Test it:

```bash
curl -X POST https://YOUR-URL.up.railway.app/render-preview \
  -H 'Content-Type: application/json' \
  -d '{"storybookUrl":"https://4missjuliaway.studeoapp.com/"}'
```

## Response

```json
{
  "mp4Url": "https://hyperbrowser-videos.s3...mp4",
  "pageCount": 10,
  "duration": 15.1,
  "sizeBytes": 3800000,
  "attempts": [{ "attempt": 1, "pass": true, ... }]
}
```

The MP4 URL comes straight from Hyperbrowser's video storage. Link it in emails, embed it in Slack, whatever.

## Choreography

Fixed for every book, regardless of page count:

```
t=0.0   Spread 1 (cover)          2s
t=2.0   ArrowRight → Spread 2     4s
t=6.0   ArrowRight → Spread 3     4s
t=10.0  ArrowLeft  → Spread 2     2s
t=12.0  ArrowLeft  → Spread 1     2s
```

Requires ≥3 spreads (≥5 pages). Shorter books return `422 BOOK_TOO_SHORT`.

## Ogre validator

Every MP4 is checked before the URL is returned:
- Duration ∈ [14.0, 16.5] seconds
- Size > 500 KB

Fails retry up to 3 attempts. If all 3 fail, response is 500 with the per-attempt log.

## Env vars

| Var | Required | Description |
|---|---|---|
| `HB_KEY` | yes | Hyperbrowser API key |
| `PORT` | no | Default 3000 |
| `MAX_SESSIONS` | no | Most Hyperbrowser sessions this worker holds at once. Default 20 (the Startup plan allows 25 for the whole team). Extra renders wait their turn. |
| `SESSION_WAIT_MS` | no | Longest a render waits for a free session slot before it fails with `BUSY`. Default 120000 |
| `SESSION_MAX_HOLD_MS` | no | Longest one session may hold a slot before the worker stops it. Default 600000 |

`GET /health` reports the queue: `{"ok":true,"sessions":{"max":20,"inUse":3,"waiting":0}}`.

Run one replica only. The worker keeps each render's converted cinemagraphs on its own disk and the recording browser fetches them back through the public address, so a second replica would answer some of those requests with 404.
