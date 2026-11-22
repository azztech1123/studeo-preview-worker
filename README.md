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
| `MAX_JOBS` | no | Most renders running at once. Default 10. Extra renders wait in line and use no CPU and no Hyperbrowser session while they wait. Keep it at or below `MAX_SESSIONS`. |
| `MAX_SETUP` | no | Of the running renders, how many may be converting cinemagraphs with ffmpeg at the same moment. Default 3. This is the CPU-heavy step. |
| `JOB_WAIT_MS` | no | Longest a render waits in line before it is turned away with a `BUSY` error. Default 150000 |
| `LOCAL_KEEP_MS` | no | How long a video's local copy stays on disk after it has been uploaded to Cloudinary. Default 600000 |

`GET /health` reports how busy the worker is:

```json
{"ok":true,"sessions":{"max":20,"inUse":7,"waiting":0},"jobs":{"max":10,"inUse":7,"waiting":0},"converting":{"max":3,"inUse":1,"waiting":0},"localVideos":{"files":41,"mb":352},"memoryMb":310}
```

`jobs.waiting` above 0 for more than a minute or two means renders are arriving faster than this worker finishes them: slow the caller down.

## Capacity and how to run it

- One render takes a little over a minute, so 10 at once is about 8 a minute. Send it no more than that. In the Flow Guide pipeline the pace is set by the Hookdeck connection that resumes the waiting n8n run (7 a minute).
- A render waits its turn before it does anything, so a burst is queued, not dropped. A render that waits longer than `JOB_WAIT_MS` is refused with `BUSY` (HTTP 422, `error` starts with `BUSY`). The caller should try again a little later.
- The same `storybookId` asked for twice while it is being rendered is rendered once: the second request joins the first and gets the same answer. So a caller that timed out can simply ask again.
- The n8n workflow that calls the sync `/render-preview` endpoint hangs up after 5 minutes (seen on 22 Nov 2026: Railway logged those requests as 499, closed by the caller, at 300 seconds). The render carries on here after the caller has gone. Asking again with the same `storybookId` joins it.
- Local disk is temporary. A video's local copy is deleted 10 minutes after it reaches Cloudinary. Videos that could not be uploaded stay for 72 hours and are then swept. Nothing on this disk survives a redeploy or restart.
- A redeploy or restart drops every render in progress. Before deploying, stop sending renders and wait until `/health` shows `jobs.inUse` at 0.
- Run `node tests/job-gate.test.mjs` after changing the job gate. It needs no keys.

Run one replica only. The worker keeps each render's converted cinemagraphs on its own disk and the recording browser fetches them back through the public address, so a second replica would answer some of those requests with 404. The line of waiting renders and the "same video asked twice" check also live in this one process.
