// server.js — Studeo storybook 15s MP4 preview worker
// Pre-transcodes Mux H.264 cinemagraphs to WebM VP8 before opening the browser,
// then intercepts <video> requests via page.route and serves the local WebM,
// bypassing Hyperbrowser's Chromium not supporting H.264.
import express from 'express';
import { Hyperbrowser } from '@hyperbrowser/sdk';
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { v2 as cloudinary } from 'cloudinary';

const PREVIEWS_DIR = '/tmp/previews';
const CINEMAGRAPHS_DIR = '/tmp/cinemagraphs';
const PORT = process.env.PORT || 3000;
const HB_KEY = process.env.HB_KEY;

// Cloudinary config — optional. If any of the three env vars are missing,
// uploads are skipped and mp4Url falls back to the Railway /previews/ URL.
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'studeo-previews';
const CLOUDINARY_ENABLED = !!(
  CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET
);

if (CLOUDINARY_ENABLED) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
  console.log(`cloudinary: enabled, folder="${CLOUDINARY_FOLDER}"`);
} else {
  console.log('cloudinary: DISABLED (missing env vars), falling back to Railway /previews/ URLs');
}

if (!HB_KEY) {
  console.error('FATAL: HB_KEY env var not set');
  process.exit(1);
}

const hb = new Hyperbrowser({ apiKey: HB_KEY });

// ========================================================
//  helpers
// ========================================================

async function ensureDirs() {
  await fs.mkdir(PREVIEWS_DIR, { recursive: true });
  await fs.mkdir(CINEMAGRAPHS_DIR, { recursive: true });
}

async function cleanupOldFiles() {
  const TTL_MS = 72 * 60 * 60 * 1000;
  const now = Date.now();
  for (const dir of [PREVIEWS_DIR, CINEMAGRAPHS_DIR]) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fp = path.join(dir, entry.name);
        try {
          const st = await fs.stat(fp);
          if (now - st.mtimeMs > TTL_MS) {
            if (entry.isDirectory()) {
              await fs.rm(fp, { recursive: true, force: true });
            } else {
              await fs.unlink(fp);
            }
            console.log(`cleanup: removed ${fp}`);
          }
        } catch {}
      }
    } catch {}
  }
}

function sanitizeJobId(id) {
  return String(id || `job_${Date.now()}`)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => resolve(parseFloat(out.trim()) || 0));
    proc.on('error', () => resolve(0));
  });
}

function trimMp4(inPath, outPath, startSec, durationSec) {
  return new Promise((resolve, reject) => {
    // iMessage thumbnailer is pickier than ffmpeg/browsers. To make the
    // output reliably generate thumbnails in iMessage (via Blooio/Apple):
    //   - Force H.264 Main profile (High profile trips some thumbnailers)
    //   - Force level 4.0 (widely supported, safe for 1080p)
    //   - Force yuv420p explicitly (was implicit, now guaranteed)
    //   - Force 30fps via -r (input may be 10fps from HB, low-fps videos
    //     can fail the "find decodable frame near t=0" heuristic)
    //   - Force a keyframe at t=0 so the first decodable frame is immediate
    //   - Add a silent AAC audio track (many thumbnailers expect audio;
    //     video-only MP4s sometimes render as black in iMessage)
    //   - ELIMINATE THE EDIT LIST: use setpts=PTS-STARTPTS filter so frames
    //     themselves are timestamped starting at 0. ffmpeg's default is to
    //     add an edit list (edts/elst atoms) that tells decoders to skip
    //     the initial gap, but iMessage's thumbnailer does NOT honor edit
    //     lists. The thumbnailer sees frame 1 at t=0.1s and asks "frame at
    //     t=0?" — gets nothing — falls back to black. The setpts filter
    //     rewrites each frame's PTS so frame 1 is at exactly t=0 in its own
    //     data, no edit list needed.
    const args = [
      '-y',
      '-i', inPath,
      '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-ss', startSec.toFixed(3),
      '-t', durationSec.toFixed(3),
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-vf', 'setpts=PTS-STARTPTS',
      '-af', 'asetpts=PTS-STARTPTS',
      '-c:v', 'libx264',
      '-profile:v', 'main',
      '-level', '4.0',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-force_key_frames', '0',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-shortest',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      outPath,
    ];
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
    proc.on('error', reject);
  });
}

async function downloadToFile(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(filePath, buf);
  return buf.length;
}

// Upload a local MP4 to Cloudinary. Returns the secure public URL.
// Uses public_id = jobId so re-renders with the same jobId overwrite,
// keeping URLs stable per storybook (overwrite: true is explicit about this).
// resource_type: 'video' is required so Cloudinary treats the file as video.
// No transformation requested — the MP4 is stored byte-for-byte as uploaded.
// Folder is configurable via CLOUDINARY_FOLDER env var.
async function uploadToCloudinary(localPath, jobId) {
  if (!CLOUDINARY_ENABLED) {
    throw new Error('cloudinary not configured');
  }
  const result = await cloudinary.uploader.upload(localPath, {
    resource_type: 'video',
    folder: CLOUDINARY_FOLDER,
    public_id: jobId,
    overwrite: true,
    invalidate: true,   // purge CDN cache if this jobId was re-uploaded
    use_filename: false,
    unique_filename: false,
  });
  return {
    secureUrl: result.secure_url,
    publicId: result.public_id,
    bytes: result.bytes,
    duration: result.duration,
    format: result.format,
  };
}

async function pollVideoUrl(sessionId, timeoutMs = 120000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await hb.sessions.getVideoRecordingURL(sessionId);
      const url =
        result?.videoUrl ||
        result?.url ||
        result?.recordingUrl ||
        result?.data?.videoUrl;
      if (url) return url;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`video url unavailable: ${lastErr?.message || 'timeout'}`);
}

// ========================================================
//  Cinemagraph pre-transcoding pipeline
// ========================================================
//
// THE FIX: Hyperbrowser's Chromium lacks H.264 decode. Mux serves H.264.
// We fetch each cinemagraph ourselves, transcode MP4 → WebM VP8 with ffmpeg,
// then intercept Mux <video> requests inside the browser via page.route()
// and fulfill them with the local WebM. Chromium supports VP8 natively.
//
// Runs concurrently with the Hyperbrowser session boot so it adds ~0 to total
// request time. VP8 at realtime preset is 8-15x real-time on typical CPUs.

function muxIdFromUrl(url) {
  const m = String(url).match(/stream\.mux\.com\/([^\/?#]+)/);
  return m ? m[1] : null;
}

async function extractCinemagraphUrls(storybookUrl) {
  const res = await fetch(storybookUrl, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`fetch storybook ${res.status}`);
  const html = await res.text();
  const match = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) return [];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const urls = new Set();
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (
      obj.type === 'cinemagraph' &&
      typeof obj.value === 'string' &&
      obj.value.startsWith('http') &&
      obj.value.includes('mux.com')
    ) {
      urls.add(obj.value);
    }
    if (Array.isArray(obj)) obj.forEach(walk);
    else Object.values(obj).forEach(walk);
  };
  walk(data);
  return [...urls];
}

function transcodeToWebmVp8(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', srcPath,
      '-c:v', 'libvpx',            // VP8 — Chromium supports natively
      '-b:v', '2M',                 // 2 Mbps: proven to produce decodable VP8 even at cpu-used 16
      '-cpu-used', '16',            // max speed preset
      '-deadline', 'realtime',
      '-threads', '4',
      '-an',                        // cinemagraphs are silent anyway
      '-f', 'webm',
      destPath,
    ];
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`webm transcode exit ${code}: ${stderr.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

async function pretranscodeCinemagraphs(storybookUrl, jobId) {
  const result = {
    byMuxId: {},
    stats: { found: 0, transcoded: 0, failed: 0, skipped: 0, elapsedMs: 0 },
  };
  const t0 = Date.now();
  let urls;
  try {
    urls = await extractCinemagraphUrls(storybookUrl);
  } catch (e) {
    console.warn(`[${jobId}] cinemagraph extraction failed: ${e.message}`);
    result.stats.error = e.message;
    return result;
  }
  result.stats.found = urls.length;
  if (urls.length === 0) return result;

  const dir = path.join(CINEMAGRAPHS_DIR, jobId);
  await fs.mkdir(dir, { recursive: true });

  await Promise.all(
    urls.map(async (url) => {
      const muxId = muxIdFromUrl(url);
      if (!muxId) {
        result.stats.skipped++;
        return;
      }
      const mp4Path = path.join(dir, `${muxId}.mp4`);
      const webmPath = path.join(dir, `${muxId}.webm`);
      try {
        const dl = await fetch(url);
        if (!dl.ok) throw new Error(`download ${dl.status}`);
        const buf = Buffer.from(await dl.arrayBuffer());
        await fs.writeFile(mp4Path, buf);
        await transcodeToWebmVp8(mp4Path, webmPath);
        result.byMuxId[muxId] = webmPath;
        result.stats.transcoded++;
        await fs.unlink(mp4Path).catch(() => {});
      } catch (e) {
        console.warn(`[${jobId}] transcode ${muxId} failed: ${e.message}`);
        result.stats.failed++;
      }
    })
  );

  result.stats.elapsedMs = Date.now() - t0;
  console.log(
    `[${jobId}] pretranscode: ${result.stats.transcoded}/${result.stats.found} in ${result.stats.elapsedMs}ms`
  );
  return result;
}

// ========================================================
//  Browser-side diagnostic probe (minimal)
// ========================================================

const INIT_SCRIPT = `
(() => {
  window.__diag = { snaps: [], t0: Date.now() };
  window.__snap = (label) => {
    try {
      window.__diag.snaps.push({
        label,
        t_ms: Date.now() - window.__diag.t0,
        videos: [...document.querySelectorAll('video')].map((v) => ({
          src: (v.currentSrc || v.src || '').slice(-80),
          paused: v.paused,
          readyState: v.readyState,
          networkState: v.networkState,
          ct: Number((v.currentTime || 0).toFixed(2)),
          w: v.videoWidth,
          h: v.videoHeight,
          err: v.error ? v.error.code : null,
        })),
      });
    } catch (e) {
      window.__diag.snaps.push({ label, error: e.message });
    }
  };
  try {
    const probe = document.createElement('video');
    window.__diag.codecs = {
      h264: probe.canPlayType('video/mp4; codecs="avc1.42E01E"'),
      vp8: probe.canPlayType('video/webm; codecs="vp8"'),
      vp9: probe.canPlayType('video/webm; codecs="vp9"'),
    };
  } catch {}
})();
`;

// ========================================================
//  Main render attempt
// ========================================================

async function runOneAttempt({ storybookUrl, jobId, attemptNum, baseUrl }) {
  let session = null;
  let browser = null;
  const log = { attempt: attemptNum };

  try {
    console.log(`[${jobId}] attempt ${attemptNum}: creating session + pretranscoding in parallel`);

    // Session create + cinemagraph pretranscoding run concurrently.
    // Both take ~5-10s; running them in parallel means total setup ≈ max(both),
    // not sum. Net wall-clock cost of the cinemagraph fix is near zero.
    const [sessionResult, pretranscode] = await Promise.all([
      hb.sessions.create({
        enableWebRecording: true,
        enableVideoWebRecording: true,
        screen: { width: 1920, height: 1080 },
      }),
      pretranscodeCinemagraphs(storybookUrl, jobId),
    ]);
    session = sessionResult;
    log.sessionId = session.id;
    log.pretranscode = pretranscode.stats;
    console.log(`[${jobId}] session ${session.id}`);

    const sessionStartMs = Date.now();

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());

    // Track every route interception for diagnostics.
    const routeLog = [];
    const routeStart = Date.now();

    // THE KEY HOOK: redirect Mux video requests to our own HTTPS endpoint
    // at ${baseUrl}/webm/{jobId}/{muxId}.webm. Chromium follows the 302 and
    // loads the WebM through its native HTTP pipeline — which handles
    // concurrent video loads, range requests, and backpressure correctly.
    //
    // Previous approach (route.fulfill with body) wedged when two videos
    // requested simultaneously: concurrent CDP body transfers raced and
    // Chromium's media decoder would only accept one. Serializing fixed
    // the race but took so long Chromium timed out. Real HTTP sidesteps
    // both problems entirely.
    await page.route('**/stream.mux.com/**', async (route) => {
      const url = route.request().url();
      const muxId = muxIdFromUrl(url);
      const entry = { t_ms: Date.now() - routeStart, muxId };
      routeLog.push(entry);

      if (muxId && pretranscode.byMuxId[muxId]) {
        const redirectUrl = `${baseUrl}/webm/${encodeURIComponent(jobId)}/${encodeURIComponent(muxId)}.webm`;
        try {
          await route.fulfill({
            status: 302,
            headers: {
              location: redirectUrl,
              'access-control-allow-origin': '*',
            },
          });
          entry.outcome = 'redirected';
          entry.redirectTo = redirectUrl;
          return;
        } catch (e) {
          entry.outcome = 'redirect_error';
          entry.err = e.message;
        }
      } else {
        entry.outcome = 'no_match';
      }
      try { await route.continue(); } catch {}
    });

    // Network trace for debugging
    const mediaRequests = [];
    const requestStart = Date.now();
    page.on('request', (req) => {
      const url = req.url();
      if (/mux\.com|\.mp4(\?|$)|\.webm(\?|$)/i.test(url)) {
        mediaRequests.push({
          t_ms: Date.now() - requestStart,
          method: req.method(),
          url: url.slice(0, 140),
        });
      }
    });
    page.on('requestfailed', (req) => {
      const url = req.url();
      if (/mux\.com|\.mp4(\?|$)|\.webm(\?|$)/i.test(url)) {
        mediaRequests.push({
          t_ms: Date.now() - requestStart,
          failed: true,
          url: url.slice(0, 140),
          failure: req.failure()?.errorText,
        });
      }
    });

    await page.addInitScript(INIT_SCRIPT);

    console.log(`[${jobId}] navigating`);
    await page.goto(storybookUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Page count from __NEXT_DATA__ (reliable), DOM fallback
    const pageCount = await page.evaluate(() => {
      try {
        const el = document.getElementById('__NEXT_DATA__');
        if (el) {
          const j = JSON.parse(el.textContent || '{}');
          const n = j?.props?.pageProps?.data?.squirrel?.number_of_pages;
          if (typeof n === 'number' && n > 0) return n;
        }
      } catch {}
      return document.querySelectorAll('.page, [data-name]').length;
    });
    log.pageCount = pageCount;

    if (pageCount < 5) {
      throw new Error(`BOOK_TOO_SHORT: only ${pageCount} pages (need >=5)`);
    }

    // Focus + user activation
    await page.evaluate(() => {
      try {
        window.focus();
        if (document.body && document.body.focus) document.body.focus();
      } catch {}
    });
    await page.mouse.click(960, 540);
    await page.waitForTimeout(200);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    // Let Studeo's library.js inject <video> elements + our route warm up.
    // Extra buffer so the cover is actually PAINTED and stable before we
    // mark choreoStartMs — otherwise the cover dwell burns on a blank/loading
    // screen and the real cover content barely appears in the recording.
    await page.waitForTimeout(2500);

    const snap = async (label) => {
      try {
        await page.evaluate(
          `window.__snap && window.__snap(${JSON.stringify(label)})`
        );
      } catch {}
    };

    // === CHOREOGRAPHY (locked) ===
    // Studeo's page transition takes ~800-1000ms (fade + React mount + WebM fetch
    // over HTTPS → Railway). We need to WAIT for the transition to finish
    // before counting dwell time, otherwise most of each "dwell" is spent
    // looking at the outgoing spread, not the incoming one.
    //
    //   0.0s  Cover dwell       2.0s
    //   2.0s  → transition      1.2s
    //   3.2s  Spread 2 (fwd)    5.0s   ← forward pass: longer dwell
    //   8.2s  → transition      1.2s
    //   9.4s  Spread 3 (fwd)    5.0s   ← forward pass: longer dwell
    //   14.4s ← transition      1.2s
    //   15.6s Spread 2 (back)   1.5s   ← backward pass: brief
    //   17.1s ← transition      1.2s
    //   18.3s Cover (back)      1.5s
    //   19.8s tail               0.5s
    //   20.3s target (actual ~24s with snap() overhead)
    const choreoStartMs = Date.now();

    await snap('t=0_cover');
    await page.waitForTimeout(2000);                 // cover dwell

    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1200);                 // transition to spread 2
    await snap('t=3.2_spread-2-in');
    await page.waitForTimeout(5000);                 // spread 2 forward dwell (+2s)

    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1200);                 // transition to spread 3
    await snap('t=9.4_spread-3-in');
    await page.waitForTimeout(5000);                 // spread 3 forward dwell (+2s)

    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(1200);                 // transition back to spread 2
    await snap('t=15.6_spread-2-back');
    await page.waitForTimeout(1500);                 // backward dwell (unchanged)

    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(1200);                 // transition back to cover
    await snap('t=18.3_cover-back');
    await page.waitForTimeout(1500);                 // final cover dwell

    await page.waitForTimeout(500);                  // tail
    await snap('t=20.3_tail');

    const choreoEndMs = Date.now();

    try {
      log.codecs = await page.evaluate(() => window.__diag?.codecs);
      log.snapshots = await page.evaluate(() => window.__diag?.snaps);
    } catch (e) {
      log.diagReadError = e.message;
    }
    log.mediaRequests = mediaRequests;
    log.routeLog = routeLog;

    try { await browser.close(); } catch {}
    browser = null;
    try { await hb.sessions.stop(session.id); } catch (e) {
      console.warn(`[${jobId}] stop warn: ${e.message}`);
    }

    const trimDuration = (choreoEndMs - choreoStartMs) / 1000;
    log.trimDuration = Number(trimDuration.toFixed(2));

    console.log(`[${jobId}] polling for recording url`);
    const rawVideoUrl = await pollVideoUrl(session.id);

    const rawPath = path.join(PREVIEWS_DIR, `${jobId}_raw.mp4`);
    await downloadToFile(rawVideoUrl, rawPath);

    // Anchor trim from the END of the raw recording, not from a guessed
    // sessionStartMs offset. HB's recording clock is not synchronized with
    // our Node.js Date.now() — the raw can easily be 25+ seconds of preamble
    // (session boot, page load, buffer waits) before choreography begins.
    // Since hb.sessions.stop() was called immediately after choreoEndMs, the
    // LAST trimDuration seconds of the raw ARE our choreography window.
    const rawDuration = await probeDuration(rawPath);
    log.rawDuration = Number(rawDuration.toFixed(2));
    const tailCushion = 0.3; // small buffer in case HB appends frames after stop()
    const trimStart = Math.max(0, rawDuration - trimDuration - tailCushion);
    log.trimStart = Number(trimStart.toFixed(2));

    const outPath = path.join(PREVIEWS_DIR, `${jobId}.mp4`);
    await trimMp4(rawPath, outPath, trimStart, trimDuration);
    await fs.unlink(rawPath).catch(() => {});

    const duration = await probeDuration(outPath);
    const st = await fs.stat(outPath);
    log.duration = Number(duration.toFixed(1));
    log.size = st.size;

    const DUR_MIN = 13.5;
    const DUR_MAX = 28.0;
    const SIZE_MIN = 200 * 1024;

    if (duration < DUR_MIN || duration > DUR_MAX) {
      log.pass = false;
      log.reason = `duration=${duration.toFixed(1)}s out of [${DUR_MIN},${DUR_MAX}]`;
      return { ok: false, log, outPath, rawVideoUrl };
    }
    if (st.size < SIZE_MIN) {
      log.pass = false;
      log.reason = `size=${st.size} below ${SIZE_MIN}`;
      return { ok: false, log, outPath, rawVideoUrl };
    }

    // Upload to Cloudinary for persistent hosting. If it fails, we fall back
    // to the Railway /previews/ URL — render is not failed on upload error.
    let cloudinaryUrl = null;
    if (CLOUDINARY_ENABLED) {
      const uploadStart = Date.now();
      try {
        const result = await uploadToCloudinary(outPath, jobId);
        cloudinaryUrl = result.secureUrl;
        log.cloudinary = {
          url: result.secureUrl,
          bytes: result.bytes,
          uploadMs: Date.now() - uploadStart,
        };
        console.log(`[${jobId}] cloudinary upload ok: ${result.secureUrl} (${Date.now() - uploadStart}ms)`);
      } catch (upErr) {
        log.cloudinary = { error: upErr.message, uploadMs: Date.now() - uploadStart };
        console.warn(`[${jobId}] cloudinary upload failed, falling back to Railway URL: ${upErr.message}`);
      }
    }

    log.pass = true;
    log.reason = null;
    return { ok: true, log, outPath, rawVideoUrl, cloudinaryUrl };
  } catch (e) {
    log.pass = false;
    log.reason = e.message;
    const fatal = e.message.startsWith('BOOK_TOO_SHORT');
    return { ok: false, log, fatal, error: e };
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    if (session) { try { await hb.sessions.stop(session.id); } catch {} }
    fs.rm(path.join(CINEMAGRAPHS_DIR, jobId), { recursive: true, force: true }).catch(() => {});
  }
}

// ========================================================
//  Express
// ========================================================

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/previews/:file', (req, res) => {
  const file = req.params.file;
  if (!/^[a-zA-Z0-9_-]+\.mp4$/.test(file)) {
    return res.status(400).send('bad filename');
  }
  const fp = path.join(PREVIEWS_DIR, file);
  if (!fsSync.existsSync(fp)) return res.status(404).send('not found');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  fsSync.createReadStream(fp).pipe(res);
});

// Serves transcoded WebM cinemagraphs with proper HTTP range support.
// The Playwright route handler redirects Chromium here (302) so video loading
// goes through Chromium's native HTTP/video pipeline instead of CDP body
// transfer. CDP fulfill with multi-MB bodies wedged when two videos loaded
// concurrently; real HTTP with 206 range responses handles it cleanly.
app.get('/webm/:jobId/:muxId.webm', (req, res) => {
  const jobId = sanitizeJobId(req.params.jobId);
  const muxId = String(req.params.muxId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!muxId) return res.status(400).send('bad muxId');
  const fp = path.join(CINEMAGRAPHS_DIR, jobId, `${muxId}.webm`);
  if (!fsSync.existsSync(fp)) return res.status(404).send('not found');

  const stat = fsSync.statSync(fp);
  const total = stat.size;

  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start) || start < 0 || start >= total || end >= total) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).send('range not satisfiable');
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(end - start + 1));
    fsSync.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.status(200);
    res.setHeader('Content-Length', String(total));
    fsSync.createReadStream(fp).pipe(res);
  }
});

// ========================================================
//  Async job state (shared by short and long modes)
// ========================================================
const JOB_STATE = new Map(); // jobId -> state object
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

function sweepJobState() {
  const now = Date.now();
  for (const [id, state] of JOB_STATE.entries()) {
    if (now - state.updatedAt > JOB_TTL_MS) JOB_STATE.delete(id);
  }
}
setInterval(sweepJobState, 60 * 60 * 1000).unref();

// ========================================================
//  v15b short-mode implementation (UNCHANGED from proven version)
// ========================================================

async function runRenderJob({ jobId, storybookUrl, baseUrl }) {
  const state = JOB_STATE.get(jobId);
  state.status = 'running';
  state.updatedAt = Date.now();

  try {
    await ensureDirs();
    cleanupOldFiles().catch(() => {});

    const attempts = [];
    let success = null;
    let rawVideoUrl = null;

    for (let i = 1; i <= 3; i++) {
      const result = await runOneAttempt({
        storybookUrl,
        jobId,
        attemptNum: i,
        baseUrl,
      });
      attempts.push(result.log);
      if (result.ok) {
        success = result;
        rawVideoUrl = result.rawVideoUrl;
        break;
      }
      if (result.fatal) {
        state.status = 'failed';
        state.error = result.log.reason;
        state.attempts = attempts;
        state.updatedAt = Date.now();
        return;
      }
    }

    if (!success) {
      state.status = 'failed';
      state.error = 'all attempts failed';
      state.attempts = attempts;
      state.updatedAt = Date.now();
      return;
    }

    const st = await fs.stat(success.outPath);
    const fallbackUrl = `${baseUrl}/previews/${jobId}.mp4`;
    state.status = 'completed';
    state.mp4Url = success.cloudinaryUrl || fallbackUrl;
    state.fallbackMp4Url = fallbackUrl;
    state.rawMp4Url = rawVideoUrl;
    state.pageCount = success.log.pageCount;
    state.duration = success.log.duration;
    state.sizeBytes = st.size;
    state.attempts = attempts;
    state.updatedAt = Date.now();
  } catch (err) {
    state.status = 'failed';
    state.error = err?.message || 'unknown error';
    state.updatedAt = Date.now();
    console.error(`[${jobId}] render job crashed:`, err);
  }
}

app.post('/render-preview', async (req, res) => {
  // Dispatch to long-mode handler if requested
  if ((req.body || {}).version === 'long') return handleLongSyncRender(req, res);

  // ↓↓↓ v15b code from here, byte-for-byte unchanged ↓↓↓
  const { storybookUrl, storybookId } = req.body || {};
  if (!storybookUrl || typeof storybookUrl !== 'string') {
    return res.status(400).json({ error: 'storybookUrl required' });
  }
  const jobId = sanitizeJobId(storybookId);

  await ensureDirs();
  cleanupOldFiles().catch(() => {});

  const attempts = [];
  let success = null;
  let rawVideoUrl = null;

  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || 'https';
  const baseUrl = `${proto}://${host}`;

  for (let i = 1; i <= 3; i++) {
    const result = await runOneAttempt({ storybookUrl, jobId, attemptNum: i, baseUrl });
    attempts.push(result.log);
    if (result.ok) {
      success = result;
      rawVideoUrl = result.rawVideoUrl;
      break;
    }
    if (result.fatal) {
      return res.status(422).json({ error: result.log.reason, attempts });
    }
  }

  if (!success) {
    return res.status(500).json({ error: 'all attempts failed', attempts });
  }

  const st = await fs.stat(success.outPath);
  const fallbackUrl = `${baseUrl}/previews/${jobId}.mp4`;
  const mp4Url = success.cloudinaryUrl || fallbackUrl;

  res.json({
    mp4Url,
    fallbackMp4Url: fallbackUrl,
    rawMp4Url: rawVideoUrl,
    pageCount: success.log.pageCount,
    duration: success.log.duration,
    sizeBytes: st.size,
    jobId,
    attempts,
  });
});

app.post('/render-preview-async', async (req, res) => {
  // Dispatch to long-mode handler if requested
  if ((req.body || {}).version === 'long') return handleLongAsyncRender(req, res);

  // ↓↓↓ v15b code from here, byte-for-byte unchanged ↓↓↓
  const { storybookUrl, storybookId } = req.body || {};
  if (!storybookUrl || typeof storybookUrl !== 'string') {
    return res.status(400).json({ error: 'storybookUrl required' });
  }
  const jobId = sanitizeJobId(storybookId);

  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || 'https';
  const baseUrl = `${proto}://${host}`;

  // If this jobId is already running/completed, return its current state
  // rather than starting a new render — enables idempotency retries.
  const existing = JOB_STATE.get(jobId);
  if (existing && (existing.status === 'pending' || existing.status === 'running')) {
    return res.status(202).json({
      jobId,
      statusUrl: `${baseUrl}/preview-status/${jobId}`,
      status: existing.status,
      note: 'already in progress',
    });
  }

  const state = {
    jobId,
    status: 'pending',
    storybookUrl,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  JOB_STATE.set(jobId, state);

  // Fire and forget — runs after the response is sent.
  setImmediate(() => {
    runRenderJob({ jobId, storybookUrl, baseUrl }).catch((err) => {
      console.error(`[${jobId}] runRenderJob threw:`, err);
    });
  });

  res.status(202).json({
    jobId,
    statusUrl: `${baseUrl}/preview-status/${jobId}`,
    status: 'pending',
  });
});

app.get('/preview-status/:jobId', (req, res) => {
  const jobId = sanitizeJobId(req.params.jobId);
  const state = JOB_STATE.get(jobId);
  if (!state) {
    return res.status(404).json({
      jobId,
      status: 'unknown',
      error: 'no job with that id (may have expired or never existed)',
    });
  }
  // Return a clean view — omit storybookUrl and attempts log from status for brevity
  const { storybookUrl: _omit1, attempts: _omit2, ...clean } = state;
  res.json(clean);
});

await ensureDirs();

// ============================================================================
//  ██  LONG-MODE ADDITIONS — PURELY ADDITIVE, DOES NOT TOUCH v15b CODE  ██
// ============================================================================
//
//  Triggered by {version: "long"} in the POST body of either /render-preview
//  or /render-preview-async. Dispatched via a single-line branch inserted at
//  the top of each v15b endpoint (see above).
//
//  Choreography: cover → fwd through entire book → idle on last spread, 42s.
//  Spread count S = min(floor((pageCount - 2) / 2), 5). Books with more than
//  5 interior spreads are truncated to 5 with a truncated:true flag in the
//  response.
//
//  Shares with v15b:
//    - JOB_STATE map (for async status lookups via /preview-status/:jobId)
//    - All infrastructure: pretranscoding, Mux→WebM 302 redirects,
//      /webm/* endpoint, /previews/* endpoint, trim math, ffprobe/ffmpeg
//
//  Does not share with v15b:
//    - Choreography (different flow)
//    - Validator bounds (40-44s instead of 13.5-28s)
//    - Attempt runner (runFullForwardAttempt vs runOneAttempt)
//    - Job runner (runLongRenderJob vs runRenderJob)
//    - Handler bodies (handleLongSyncRender vs inline v15b handler)
// ============================================================================

async function runFullForwardAttempt({ storybookUrl, jobId, attemptNum, baseUrl }) {
  let session = null;
  let browser = null;
  const log = { attempt: attemptNum, version: 'long' };

  try {
    console.log(`[${jobId}] LONG attempt ${attemptNum}: creating session + pretranscoding in parallel`);

    const [sessionResult, pretranscode] = await Promise.all([
      hb.sessions.create({
        enableWebRecording: true,
        enableVideoWebRecording: true,
        screen: { width: 1920, height: 1080 },
      }),
      pretranscodeCinemagraphs(storybookUrl, jobId),
    ]);
    session = sessionResult;
    log.sessionId = session.id;
    log.pretranscode = pretranscode.stats;
    console.log(`[${jobId}] LONG session ${session.id}`);

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());

    const routeLog = [];
    const routeStart = Date.now();

    // Same 302 redirect architecture as v15b
    await page.route('**/stream.mux.com/**', async (route) => {
      const url = route.request().url();
      const muxId = muxIdFromUrl(url);
      const entry = { t_ms: Date.now() - routeStart, muxId };
      routeLog.push(entry);

      if (muxId && pretranscode.byMuxId[muxId]) {
        const redirectUrl = `${baseUrl}/webm/${encodeURIComponent(jobId)}/${encodeURIComponent(muxId)}.webm`;
        try {
          await route.fulfill({
            status: 302,
            headers: {
              location: redirectUrl,
              'access-control-allow-origin': '*',
            },
          });
          entry.outcome = 'redirected';
          entry.redirectTo = redirectUrl;
          return;
        } catch (e) {
          entry.outcome = 'redirect_error';
          entry.err = e.message;
        }
      } else {
        entry.outcome = 'no_match';
      }
      try { await route.continue(); } catch {}
    });

    const mediaRequests = [];
    const requestStart = Date.now();
    page.on('request', (req) => {
      const url = req.url();
      if (/mux\.com|\.mp4(\?|$)|\.webm(\?|$)/i.test(url)) {
        mediaRequests.push({
          t_ms: Date.now() - requestStart,
          method: req.method(),
          url: url.slice(0, 140),
        });
      }
    });
    page.on('requestfailed', (req) => {
      const url = req.url();
      if (/mux\.com|\.mp4(\?|$)|\.webm(\?|$)/i.test(url)) {
        mediaRequests.push({
          t_ms: Date.now() - requestStart,
          failed: true,
          url: url.slice(0, 140),
          failure: req.failure()?.errorText,
        });
      }
    });

    await page.addInitScript(INIT_SCRIPT);

    console.log(`[${jobId}] LONG navigating`);
    await page.goto(storybookUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const pageCount = await page.evaluate(() => {
      try {
        const el = document.getElementById('__NEXT_DATA__');
        if (el) {
          const j = JSON.parse(el.textContent || '{}');
          const n = j?.props?.pageProps?.data?.squirrel?.number_of_pages;
          if (typeof n === 'number' && n > 0) return n;
        }
      } catch {}
      return document.querySelectorAll('.page, [data-name]').length;
    });
    log.pageCount = pageCount;

    if (pageCount < 4) {
      throw new Error(`BOOK_TOO_SHORT: ${pageCount} pages yields no interior spreads (need >=4)`);
    }

    await page.evaluate(() => {
      try {
        window.focus();
        if (document.body && document.body.focus) document.body.focus();
      } catch {}
    });
    await page.mouse.click(960, 540);
    await page.waitForTimeout(200);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    await page.waitForTimeout(2500);

    const snap = async (label) => {
      try {
        await page.evaluate(
          `window.__snap && window.__snap(${JSON.stringify(label)})`
        );
      } catch {}
    };

    // === LONG-MODE CHOREOGRAPHY ===
    // 42s total target:
    //   t=0.0   Cover dwell 2s
    //   t=2.0   press ArrowRight → transition 1.2s
    //   t=3.2   Spread 1 dwell 6s
    //   ... (repeat per spread, each flip + dwell = 7.2s)
    //   t=3.2 + S*7.2   Last spread reached, start idle
    //   t=42.0          End
    //
    // S = min(floor((pageCount - 2) / 2), 5)
    // Idle is computed from WALL CLOCK so snap() overhead can't push past 42s.
    const TARGET_MS = 42000;
    const COVER_DWELL = 2000;
    const TRANSITION = 1200;
    const SPREAD_DWELL = 6000;
    const MAX_SPREADS = 5;

    const interiorSpreadsTotal = Math.floor((pageCount - 2) / 2);
    const spreadsShown = Math.min(interiorSpreadsTotal, MAX_SPREADS);
    const truncated = interiorSpreadsTotal > MAX_SPREADS;

    log.spreadsShown = spreadsShown;
    log.spreadsTotal = interiorSpreadsTotal;
    log.truncated = truncated;
    log.targetMs = TARGET_MS;

    const choreoStartMs = Date.now();

    await snap('t=0_cover');
    await page.waitForTimeout(COVER_DWELL);

    for (let i = 1; i <= spreadsShown; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(TRANSITION);
      if (i === 1 || i === spreadsShown) {
        await snap(`t_approx_spread-${i}-in`);
      }
      await page.waitForTimeout(SPREAD_DWELL);
    }

    // Idle from wall clock
    const forwardElapsed = Date.now() - choreoStartMs;
    const remaining = TARGET_MS - forwardElapsed;
    log.forwardPassMs = forwardElapsed;
    log.idleOnLastMs = Math.max(0, remaining);
    if (remaining > 100) {
      await page.waitForTimeout(remaining);
    }
    await snap('t=end_idle');

    const choreoEndMs = Date.now();

    try {
      log.codecs = await page.evaluate(() => window.__diag?.codecs);
      log.snapshots = await page.evaluate(() => window.__diag?.snaps);
    } catch (e) {
      log.diagReadError = e.message;
    }
    log.mediaRequests = mediaRequests;
    log.routeLog = routeLog;

    try { await browser.close(); } catch {}
    browser = null;
    try { await hb.sessions.stop(session.id); } catch (e) {
      console.warn(`[${jobId}] LONG stop warn: ${e.message}`);
    }

    const trimDuration = (choreoEndMs - choreoStartMs) / 1000;
    log.trimDuration = Number(trimDuration.toFixed(2));

    console.log(`[${jobId}] LONG polling for recording url`);
    const rawVideoUrl = await pollVideoUrl(session.id);

    const rawPath = path.join(PREVIEWS_DIR, `${jobId}_raw.mp4`);
    await downloadToFile(rawVideoUrl, rawPath);

    const rawDuration = await probeDuration(rawPath);
    log.rawDuration = Number(rawDuration.toFixed(2));
    const tailCushion = 0.3;
    const trimStart = Math.max(0, rawDuration - trimDuration - tailCushion);
    log.trimStart = Number(trimStart.toFixed(2));

    const outPath = path.join(PREVIEWS_DIR, `${jobId}.mp4`);
    await trimMp4(rawPath, outPath, trimStart, trimDuration);
    await fs.unlink(rawPath).catch(() => {});

    const duration = await probeDuration(outPath);
    const st = await fs.stat(outPath);
    log.duration = Number(duration.toFixed(1));
    log.size = st.size;

    // LONG-MODE validator: target ~42s
    const DUR_MIN = 40.0;
    const DUR_MAX = 44.0;
    const SIZE_MIN = 200 * 1024;

    if (duration < DUR_MIN || duration > DUR_MAX) {
      log.pass = false;
      log.reason = `duration=${duration.toFixed(1)}s out of [${DUR_MIN},${DUR_MAX}]`;
      return { ok: false, log, outPath, rawVideoUrl };
    }
    if (st.size < SIZE_MIN) {
      log.pass = false;
      log.reason = `size=${st.size} below ${SIZE_MIN}`;
      return { ok: false, log, outPath, rawVideoUrl };
    }

    // Upload to Cloudinary for persistent hosting (same pattern as short mode).
    let cloudinaryUrl = null;
    if (CLOUDINARY_ENABLED) {
      const uploadStart = Date.now();
      try {
        const result = await uploadToCloudinary(outPath, jobId);
        cloudinaryUrl = result.secureUrl;
        log.cloudinary = {
          url: result.secureUrl,
          bytes: result.bytes,
          uploadMs: Date.now() - uploadStart,
        };
        console.log(`[${jobId}] LONG cloudinary upload ok: ${result.secureUrl} (${Date.now() - uploadStart}ms)`);
      } catch (upErr) {
        log.cloudinary = { error: upErr.message, uploadMs: Date.now() - uploadStart };
        console.warn(`[${jobId}] LONG cloudinary upload failed, falling back to Railway URL: ${upErr.message}`);
      }
    }

    log.pass = true;
    log.reason = null;
    return { ok: true, log, outPath, rawVideoUrl, cloudinaryUrl };
  } catch (e) {
    log.pass = false;
    log.reason = e.message;
    const fatal = e.message.startsWith('BOOK_TOO_SHORT');
    return { ok: false, log, fatal, error: e };
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    if (session) { try { await hb.sessions.stop(session.id); } catch {} }
    fs.rm(path.join(CINEMAGRAPHS_DIR, jobId), { recursive: true, force: true }).catch(() => {});
  }
}

async function runLongRenderJob({ jobId, storybookUrl, baseUrl }) {
  const state = JOB_STATE.get(jobId);
  state.status = 'running';
  state.updatedAt = Date.now();

  try {
    await ensureDirs();
    cleanupOldFiles().catch(() => {});

    const attempts = [];
    let success = null;
    let rawVideoUrl = null;

    for (let i = 1; i <= 3; i++) {
      const result = await runFullForwardAttempt({
        storybookUrl,
        jobId,
        attemptNum: i,
        baseUrl,
      });
      attempts.push(result.log);
      if (result.ok) {
        success = result;
        rawVideoUrl = result.rawVideoUrl;
        break;
      }
      if (result.fatal) {
        state.status = 'failed';
        state.error = result.log.reason;
        state.attempts = attempts;
        state.updatedAt = Date.now();
        return;
      }
    }

    if (!success) {
      state.status = 'failed';
      state.error = 'all attempts failed';
      state.attempts = attempts;
      state.updatedAt = Date.now();
      return;
    }

    const st = await fs.stat(success.outPath);
    const fallbackUrl = `${baseUrl}/previews/${jobId}.mp4`;
    state.status = 'completed';
    state.version = 'long';
    state.mp4Url = success.cloudinaryUrl || fallbackUrl;
    state.fallbackMp4Url = fallbackUrl;
    state.rawMp4Url = rawVideoUrl;
    state.pageCount = success.log.pageCount;
    state.duration = success.log.duration;
    state.sizeBytes = st.size;
    state.spreadsShown = success.log.spreadsShown;
    state.spreadsTotal = success.log.spreadsTotal;
    state.truncated = success.log.truncated;
    state.attempts = attempts;
    state.updatedAt = Date.now();
  } catch (err) {
    state.status = 'failed';
    state.error = err?.message || 'unknown error';
    state.updatedAt = Date.now();
    console.error(`[${jobId}] LONG render job crashed:`, err);
  }
}

async function handleLongSyncRender(req, res) {
  const { storybookUrl, storybookId } = req.body || {};
  if (!storybookUrl || typeof storybookUrl !== 'string') {
    return res.status(400).json({ error: 'storybookUrl required' });
  }
  const jobId = sanitizeJobId(storybookId);

  await ensureDirs();
  cleanupOldFiles().catch(() => {});

  const attempts = [];
  let success = null;
  let rawVideoUrl = null;

  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || 'https';
  const baseUrl = `${proto}://${host}`;

  for (let i = 1; i <= 3; i++) {
    const result = await runFullForwardAttempt({ storybookUrl, jobId, attemptNum: i, baseUrl });
    attempts.push(result.log);
    if (result.ok) {
      success = result;
      rawVideoUrl = result.rawVideoUrl;
      break;
    }
    if (result.fatal) {
      return res.status(422).json({ error: result.log.reason, attempts });
    }
  }

  if (!success) {
    return res.status(500).json({ error: 'all attempts failed', attempts });
  }

  const st = await fs.stat(success.outPath);
  const fallbackUrl = `${baseUrl}/previews/${jobId}.mp4`;
  const mp4Url = success.cloudinaryUrl || fallbackUrl;

  res.json({
    mp4Url,
    fallbackMp4Url: fallbackUrl,
    rawMp4Url: rawVideoUrl,
    version: 'long',
    pageCount: success.log.pageCount,
    duration: success.log.duration,
    sizeBytes: st.size,
    spreadsShown: success.log.spreadsShown,
    spreadsTotal: success.log.spreadsTotal,
    truncated: success.log.truncated,
    jobId,
    attempts,
  });
}

async function handleLongAsyncRender(req, res) {
  const { storybookUrl, storybookId } = req.body || {};
  if (!storybookUrl || typeof storybookUrl !== 'string') {
    return res.status(400).json({ error: 'storybookUrl required' });
  }
  const jobId = sanitizeJobId(storybookId);

  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || 'https';
  const baseUrl = `${proto}://${host}`;

  const existing = JOB_STATE.get(jobId);
  if (existing && (existing.status === 'pending' || existing.status === 'running')) {
    return res.status(202).json({
      jobId,
      statusUrl: `${baseUrl}/preview-status/${jobId}`,
      status: existing.status,
      version: existing.version,
      note: 'already in progress',
    });
  }

  const state = {
    jobId,
    version: 'long',
    status: 'pending',
    storybookUrl,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  JOB_STATE.set(jobId, state);

  setImmediate(() => {
    runLongRenderJob({ jobId, storybookUrl, baseUrl }).catch((err) => {
      console.error(`[${jobId}] runLongRenderJob threw:`, err);
    });
  });

  res.status(202).json({
    jobId,
    statusUrl: `${baseUrl}/preview-status/${jobId}`,
    status: 'pending',
    version: 'long',
  });
}

app.listen(PORT, () => {
  console.log(`studeo-preview-worker listening on ${PORT}`);
});
