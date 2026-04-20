import express from 'express';
import { Hyperbrowser } from '@hyperbrowser/sdk';
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HB_KEY = process.env.HB_KEY;
const MAX_ATTEMPTS = 3;
const VIEWPORT = { width: 1920, height: 1080 };

// Ogre validator thresholds
const MIN_DURATION_S = 14.0;
const MAX_DURATION_S = 16.5;
const MIN_SIZE_B = 500_000;

if (!HB_KEY) throw new Error('HB_KEY env var required');

const app = express();
app.use(express.json());

const hb = new Hyperbrowser({ apiKey: HB_KEY });

// ─── Choreography ──────────────────────────────────────────────────────────
// Fixed sequence, same for every book. Requires ≥3 spreads (≥5 pages).
//
//   t=0.0  Spread 1 (cover)           dwell 2s
//   t=2.0  → Spread 2 (pages 2-3)     dwell 4s
//   t=6.0  → Spread 3 (pages 4-5)     dwell 4s
//   t=10.0 ← Spread 2                 dwell 2s
//   t=12.0 ← Spread 1 (cover)         dwell 2s
//   t=14.0 tail hold                  0.6s
async function runChoreography(page) {
     await page.evaluate(() => {
       window.focus();
       document.body?.focus();
     });
     await page.waitForTimeout(200);

  await page.waitForTimeout(2000);            // Spread 1 (cover)
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(4000);            // Spread 2
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(4000);            // Spread 3
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(2000);            // Spread 2
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(2000);            // Spread 1
  await page.waitForTimeout(600);             // tail hold
}

// ─── Ogre validator ────────────────────────────────────────────────────────
function ogreValidate(mp4Path) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration,size -of json "${mp4Path}"`
  ).toString();
  const { format } = JSON.parse(out);
  const duration = parseFloat(format.duration);
  const size = parseInt(format.size, 10);

  const reasons = [];
  if (!(duration >= MIN_DURATION_S && duration <= MAX_DURATION_S)) {
    reasons.push(`duration=${duration}s out of [${MIN_DURATION_S},${MAX_DURATION_S}]`);
  }
  if (!(size > MIN_SIZE_B)) {
    reasons.push(`size=${size}b below ${MIN_SIZE_B}`);
  }
  return {
    pass: reasons.length === 0,
    duration,
    size,
    reason: reasons.join('; ') || null,
  };
}

// ─── Single render attempt ─────────────────────────────────────────────────
async function renderOnce(storybookUrl) {
  const session = await hb.sessions.create({
    enableWebRecording: true,
    enableVideoWebRecording: true,
  });

  let browser;
  let pageCount = null;
  try {
    browser = await chromium.connectOverCDP(session.wsEndpoint);
    const page = browser.contexts()[0].pages()[0];
    await page.setViewportSize(VIEWPORT);

    // Defensive mute in case any storybook ships with audio
    await page.addInitScript(() => {
      const orig = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        this.muted = true;
        return orig.apply(this, arguments);
      };
    });

    await page.goto(storybookUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForSelector('.page', { timeout: 15_000 });
    await page.waitForFunction(() => window.__NEXT_DATA__ !== undefined, { timeout: 10_000 });

    pageCount = await page.evaluate(() =>
      window.__NEXT_DATA__?.props?.pageProps?.data?.squirrel?.number_of_pages
        ?? document.querySelectorAll('.page').length
    );

    if (pageCount < 5) {
      throw new Error(`BOOK_TOO_SHORT: ${pageCount} pages, need ≥5 for 3-spread choreography`);
    }

    await runChoreography(page);
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    try { await hb.sessions.stop(session.id); } catch {}
  }

  // Poll for MP4
  for (let i = 0; i < 45; i++) {
    const r = await hb.sessions.getVideoRecordingURL(session.id);;
    if (r.status === 'completed' && r.recordingUrl) {
      return { mp4Url: r.recordingUrl, sessionId: session.id, pageCount };
    }
    if (r.status === 'failed') throw new Error(`HB_RENDER_FAILED: ${r.error || 'unknown'}`);
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('HB_RENDER_TIMEOUT: no completed MP4 after 90s');
}

// ─── HTTP handler ──────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/render-preview', async (req, res) => {
  const { storybookUrl, storybookId } = req.body;
  if (!storybookUrl) return res.status(400).json({ error: 'missing storybookUrl' });
  if (!/^https:\/\/.+studeoapp\.com/.test(storybookUrl)) {
    return res.status(400).json({ error: 'storybookUrl must be a studeoapp.com URL' });
  }

  const jobId = storybookId || `job_${Date.now()}`;
  const attempts = [];
  let localPath;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { mp4Url, pageCount, sessionId } = await renderOnce(storybookUrl);

      localPath = `/tmp/${jobId}_${attempt}.mp4`;
      const buf = Buffer.from(await (await fetch(mp4Url)).arrayBuffer());
      writeFileSync(localPath, buf);

      const validation = ogreValidate(localPath);
      attempts.push({ attempt, pageCount, sessionId, ...validation });
      unlinkSync(localPath);

      if (!validation.pass) continue;

      // Ogre passed → return Hyperbrowser's MP4 URL directly
      return res.json({
        mp4Url,
        sessionId,
        pageCount,
        duration: validation.duration,
        sizeBytes: validation.size,
        attempts,
      });
    } catch (err) {
      attempts.push({ attempt, error: err.message });
      if (localPath && existsSync(localPath)) {
        try { unlinkSync(localPath); } catch {}
      }
      if (err.message.startsWith('BOOK_TOO_SHORT')) {
        return res.status(422).json({ error: err.message, attempts });
      }
    }
  }

  return res.status(500).json({
    error: `all ${MAX_ATTEMPTS} attempts failed`,
    attempts,
  });
});

app.listen(PORT, () => console.log(`preview worker up on :${PORT}`));
