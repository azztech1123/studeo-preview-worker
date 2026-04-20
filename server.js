// server.js — Studeo storybook 15s MP4 preview worker
// Ogre-validated, retry-bounded, video-hostile-env-proof.
import express from 'express';
import { Hyperbrowser } from '@hyperbrowser/sdk';
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PREVIEWS_DIR = '/tmp/previews';
const PORT = process.env.PORT || 3000;
const HB_KEY = process.env.HB_KEY;

if (!HB_KEY) {
  console.error('FATAL: HB_KEY env var not set');
  process.exit(1);
}

const hb = new Hyperbrowser({ apiKey: HB_KEY });

// ---------- helpers ----------

async function ensurePreviewsDir() {
  await fs.mkdir(PREVIEWS_DIR, { recursive: true });
}

async function cleanupOldPreviews() {
  try {
    const files = await fs.readdir(PREVIEWS_DIR);
    const now = Date.now();
    const TTL_MS = 72 * 60 * 60 * 1000;
    for (const f of files) {
      const fp = path.join(PREVIEWS_DIR, f);
      try {
        const st = await fs.stat(fp);
        if (now - st.mtimeMs > TTL_MS) {
          await fs.unlink(fp);
          console.log(`cleanup: removed ${f}`);
        }
      } catch {}
    }
  } catch (e) {
    console.warn('cleanup error:', e.message);
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

// ---------- autoplay-hardening init script ----------
// Runs inside the browser on every document load, BEFORE page scripts.
// Studeo injects Mux-hosted <video> elements after React hydrates; we must
// configure them the instant they appear so Chromium's autoplay policy
// allows them and so Studeo's player's internal .play() call succeeds.
const AUTOPLAY_INIT = `
(() => {
  // --- diagnostic collector (global, accumulates across choreography) ---
  window.__diag = { snaps: [], t0: Date.now() };
  window.__snap = (label) => {
    try {
      window.__diag.snaps.push({
        label,
        t_ms: Date.now() - window.__diag.t0,
        videos: [...document.querySelectorAll('video')].map((v) => ({
          src: (v.currentSrc || v.src || '').slice(0, 120),
          paused: v.paused,
          ended: v.ended,
          muted: v.muted,
          readyState: v.readyState,
          networkState: v.networkState,
          ct: Number((v.currentTime || 0).toFixed(2)),
          dur: Number((v.duration || 0).toFixed(2)) || null,
          w: v.videoWidth,
          h: v.videoHeight,
          err: v.error ? v.error.code : null,
        })),
        slots: [...document.querySelectorAll('[id="image1"], [id="image2"]')].map((s) => ({
          id: s.id,
          childTags: [...s.children].map((c) => c.tagName.toLowerCase()).slice(0, 6),
          inner: (s.innerHTML || '').slice(0, 400),
        })),
        activePage: (document.querySelector('.page[data-name]') || {}).getAttribute
          ? document.querySelector('.page[data-name]').getAttribute('data-name')
          : null,
      });
    } catch (e) {
      window.__diag.snaps.push({ label, error: e.message });
    }
  };

  // --- video autoplay hardening ---
  const configure = (v) => {
    try {
      v.muted = true;
      v.defaultMuted = true;
      v.autoplay = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute('muted', '');
      v.setAttribute('autoplay', '');
      v.setAttribute('loop', '');
      v.setAttribute('playsinline', '');
      const kick = () => {
        try {
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
        } catch {}
      };
      if (v.readyState >= 2) kick();
      else v.addEventListener('loadeddata', kick, { once: true });
      v.addEventListener('pause', () => setTimeout(kick, 50));
    } catch {}
  };
  const scan = (root) => {
    try {
      if (root.nodeType === 1 && root.tagName === 'VIDEO') configure(root);
      root.querySelectorAll && root.querySelectorAll('video').forEach(configure);
    } catch {}
  };
  const mo = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
  });
  const start = () => {
    scan(document);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => {
      try {
        document.querySelectorAll('video').forEach((v) => {
          if (v.paused || v.ended) {
            try {
              v.muted = true;
              const p = v.play();
              if (p && p.catch) p.catch(() => {});
            } catch {}
          }
        });
      } catch {}
    }, 1000);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;

// No longer used — snapshots happen during choreography instead.
const DIAGNOSTIC_PROBE = '(() => ({deprecated: true}))()';

// ---------- one render attempt ----------

async function runOneAttempt({ storybookUrl, jobId, attemptNum }) {
  let session = null;
  let browser = null;
  const log = { attempt: attemptNum };

  try {
    console.log(`[${jobId}] attempt ${attemptNum}: creating session`);
    session = await hb.sessions.create({
      enableWebRecording: true,
      enableVideoWebRecording: true,
      screen: { width: 1920, height: 1080 },
    });
    log.sessionId = session.id;
    console.log(`[${jobId}] session ${session.id}`);

    const sessionStartMs = Date.now();

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());

    // Network trace: record any request that looks like a video asset.
    const mediaRequests = [];
    const requestStart = Date.now();
    page.on('request', (req) => {
      const url = req.url();
      if (
        /mux\.com|cinemagraph|\.mp4(\?|$)|\.webm(\?|$)|\.m3u8(\?|$)/i.test(url)
      ) {
        mediaRequests.push({
          t_ms: Date.now() - requestStart,
          method: req.method(),
          url: url.slice(0, 150),
          resourceType: req.resourceType(),
        });
      }
    });
    page.on('requestfailed', (req) => {
      const url = req.url();
      if (/mux\.com|\.mp4(\?|$)|\.webm(\?|$)/i.test(url)) {
        mediaRequests.push({
          t_ms: Date.now() - requestStart,
          failed: true,
          url: url.slice(0, 150),
          failure: req.failure()?.errorText,
        });
      }
    });

    // Arm autoplay-hardening BEFORE navigation so it runs on document creation.
    await page.addInitScript(AUTOPLAY_INIT);

    console.log(`[${jobId}] navigating`);
    await page.goto(storybookUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Count pages. Primary source: Studeo's __NEXT_DATA__ SSR payload
    // (data.squirrel.number_of_pages). Fallback: DOM count of .page / [data-name]
    // nodes. React hydration rearranges the DOM so a naive .page count can
    // return 1 even for a 10-page book — hence the NEXT_DATA primary path.
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

    // Focus the document without clicking the body (body click throws viewport errors).
    await page.evaluate(() => {
      try {
        window.focus();
        if (document.body && document.body.focus) document.body.focus();
      } catch {}
    });

    // User activation for Chromium autoplay policy.
    // A real mouse click in the middle of the viewport generates a pointer event,
    // which is the strongest signal to the browser that a user is present.
    // Tab kept as a second belt-and-suspenders gesture.
    await page.mouse.click(960, 540);
    await page.waitForTimeout(200);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    // Force-play every video now that we have user activation.
    await page.evaluate(() => {
      document.querySelectorAll('video').forEach((v) => {
        try {
          v.muted = true;
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
        } catch {}
      });
    });
    // Give videos real time to buffer + start playing before we begin choreography.
    await page.waitForTimeout(1500);

    // Helper to snapshot DOM state at the current choreography moment.
    const snap = async (label) => {
      try {
        await page.evaluate(`window.__snap && window.__snap(${JSON.stringify(label)})`);
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

    // Read back collected diagnostics before tearing down the browser.
    try {
      log.snapshots = await page.evaluate(() => window.__diag && window.__diag.snaps);
    } catch (e) {
      log.snapshots = { error: e.message };
    }
    log.mediaRequests = mediaRequests;

    // Close CDP connection; recording is server-side and finalizes on stop.
    try { await browser.close(); } catch {}
    browser = null;

    // Stop session so recording is flushed + uploaded.
    try { await hb.sessions.stop(session.id); } catch (e) {
      console.warn(`[${jobId}] stop warn: ${e.message}`);
    }

    const trimStart = Math.max(
      0,
      (choreoStartMs - sessionStartMs) / 1000 - 0.2 // 0.2s cushion before cover dwell
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

    // Ogre thresholds
    const DUR_MIN = 13.5;
    const DUR_MAX = 17.0;
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
  }
}

// ---------- express ----------

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

  await ensurePreviewsDir();
  cleanupOldPreviews().catch(() => {});

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

await ensurePreviewsDir();

app.listen(PORT, () => {
  console.log(`studeo-preview-worker listening on ${PORT}`);
});
