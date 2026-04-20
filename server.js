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

const PREVIEWS_DIR = '/tmp/previews';
const CINEMAGRAPHS_DIR = '/tmp/cinemagraphs';
const PORT = process.env.PORT || 3000;
const HB_KEY = process.env.HB_KEY;

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
    const args = [
      '-y',
      '-ss', startSec.toFixed(3),
      '-i', inPath,
      '-t', durationSec.toFixed(3),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-an',
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

async function runOneAttempt({ storybookUrl, jobId, attemptNum }) {
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

    // PRE-LOAD every transcoded WebM into memory ONCE. This eliminates any
    // fs.readFile race condition in the route handler — two simultaneous
    // video requests were randomly causing one to serve correctly and the
    // other to stall at readyState:0 when both handlers raced to read files
    // from the thread pool. In-memory lookup is sync and bulletproof.
    const webmBuffers = {};
    for (const [muxId, webmPath] of Object.entries(pretranscode.byMuxId)) {
      try {
        webmBuffers[muxId] = await fs.readFile(webmPath);
      } catch (e) {
        console.warn(`[${jobId}] preload ${muxId} failed: ${e.message}`);
      }
    }
    log.preloadedBuffers = Object.keys(webmBuffers).length;

    const sessionStartMs = Date.now();

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());

    // Track every route interception so we can see what actually happened
    // per request — critical for diagnosing any remaining odd behavior.
    const routeLog = [];
    const routeStart = Date.now();

    // THE KEY HOOK: intercept Mux video requests, serve local WebM.
    // Plain 200 response with full body + explicit vp8 codec in Content-Type.
    // (v8 tried 206/Range handling and it made things WORSE — Chromium's
    // media engine kept the decoder waiting for "more" data even when we'd
    // served the whole file, because 206 Partial Content literally means
    // partial. Plain 200 tells it "this is everything, go.")
    await page.route('**/stream.mux.com/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const muxId = muxIdFromUrl(url);
      const body = muxId ? webmBuffers[muxId] : null;
      const entry = {
        t_ms: Date.now() - routeStart,
        muxId,
        size: body ? body.length : 0,
      };
      routeLog.push(entry);

      if (!body) {
        entry.outcome = 'no_buffer';
        try { await route.continue(); } catch {}
        return;
      }

      try {
        await route.fulfill({
          status: 200,
          contentType: 'video/webm',
          headers: {
            'access-control-allow-origin': '*',
            'accept-ranges': 'bytes',
            'cache-control': 'public, max-age=3600',
          },
          body,
        });
        entry.outcome = 'fulfilled';
      } catch (e) {
        entry.outcome = 'fulfill_error';
        entry.err = e.message;
        try { await route.continue(); } catch {}
      }
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
    await page.waitForTimeout(1500);

    const snap = async (label) => {
      try {
        await page.evaluate(
          `window.__snap && window.__snap(${JSON.stringify(label)})`
        );
      } catch {}
    };

    // === CHOREOGRAPHY (locked) ===
    const choreoStartMs = Date.now();

    await snap('t=0_cover');
    await page.waitForTimeout(2000);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await snap('t=2_after-right-1');
    await page.waitForTimeout(3700);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await snap('t=6_after-right-2');
    await page.waitForTimeout(3700);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
    await snap('t=10_after-left-1');
    await page.waitForTimeout(1700);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
    await snap('t=12_after-left-2');
    await page.waitForTimeout(1700);
    await page.waitForTimeout(600);
    await snap('t=14_tail');

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

    const trimStart = Math.max(
      0,
      (choreoStartMs - sessionStartMs) / 1000 - 0.2
    );
    const trimDuration = (choreoEndMs - choreoStartMs) / 1000;
    log.trimStart = Number(trimStart.toFixed(2));
    log.trimDuration = Number(trimDuration.toFixed(2));

    console.log(`[${jobId}] polling for recording url`);
    const rawVideoUrl = await pollVideoUrl(session.id);

    const rawPath = path.join(PREVIEWS_DIR, `${jobId}_raw.mp4`);
    await downloadToFile(rawVideoUrl, rawPath);

    const outPath = path.join(PREVIEWS_DIR, `${jobId}.mp4`);
    await trimMp4(rawPath, outPath, trimStart, trimDuration);
    await fs.unlink(rawPath).catch(() => {});

    const duration = await probeDuration(outPath);
    const st = await fs.stat(outPath);
    log.duration = Number(duration.toFixed(1));
    log.size = st.size;

    const DUR_MIN = 13.5;
    const DUR_MAX = 22.0;
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

    log.pass = true;
    log.reason = null;
    return { ok: true, log, outPath, rawVideoUrl };
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

app.post('/render-preview', async (req, res) => {
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

  for (let i = 1; i <= 3; i++) {
    const result = await runOneAttempt({ storybookUrl, jobId, attemptNum: i });
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
  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || 'https';
  const mp4Url = `${proto}://${host}/previews/${jobId}.mp4`;

  res.json({
    mp4Url,
    rawMp4Url: rawVideoUrl,
    pageCount: success.log.pageCount,
    duration: success.log.duration,
    sizeBytes: st.size,
    jobId,
    attempts,
  });
});

await ensureDirs();

app.listen(PORT, () => {
  console.log(`studeo-preview-worker listening on ${PORT}`);
});
