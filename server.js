import express from 'express';
import { Hyperbrowser } from '@hyperbrowser/sdk';
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import {
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'fs';
import path from 'path';

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HB_KEY = process.env.HB_KEY;
const MAX_ATTEMPTS = 3;
const VIEWPORT = { width: 1920, height: 1080 };

const PREVIEW_DIR = '/tmp/previews';
const MAX_PREVIEW_AGE_MS = 72 * 60 * 60 * 1000; // 72h

// Ogre validator thresholds — applied to the TRIMMED clip
const MIN_DURATION_S = 13.5;
const MAX_DURATION_S = 16.0;
const MIN_SIZE_B = 200_000;

if (!HB_KEY) throw new Error('HB_KEY env var required');
if (!existsSync(PREVIEW_DIR)) mkdirSync(PREVIEW_DIR, { recursive: true });

const app = express();
app.use(express.json());

const hb = new Hyperbrowser({ apiKey: HB_KEY });

// ─── Choreography ──────────────────────────────────────────────────────────
// Fixed sequence, same for every book. Requires ≥3 spreads (≥5 pages).
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

// ─── Housekeeping: remove previews older than 72h ──────────────────────────
function cleanOldPreviews() {
  try {
    const now = Date.now();
    for (const f of readdirSync(PREVIEW_DIR)) {
      const fp = path.join(PREVIEW_DIR, f);
      const age = now - statSync(fp).mtimeMs;
      if (age > MAX_PREVIEW_AGE_MS) unlinkSync(fp);
    }
  } catch (e) {
    console.warn('preview cleanup failed:', e.message);
  }
}

// ─── Single render attempt ─────────────────────────────────────────────────
async function renderOnce(storybookUrl) {
  const session = await hb.sessions.create({
    enableWebRecording: true,
    enableVideoWebRecording: true,
  });
  const sessionStartMs = Date.now(); // HB recording begins ~here

  let browser;
  let pageCount = null;
  let choreoStartMs = null;
  let choreoEndMs = null;

  try {
    browser = await chromium.connectOverCDP(session.wsEndpoint);
    const page = browser.contexts()[0].pages()[0];
    await page.setViewportSize(VIEWPORT);

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

    choreoStartMs = Date.now();
    await runChoreography(page);
    choreoEndMs = Date.now();
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    try { await hb.sessions.stop(session.id); } catch {}
  }

  // Poll Hyperbrowser for the MP4
  for (let i = 0; i < 45; i++) {
    const r = await hb.sessions.getVideoRecordingURL(session.id);
    if (r.status === 'completed' && r.recordingUrl) {
      // Trim window — offset from recording start to choreo start, minus a small head cushion
      const trimStart = Math.max(0, (choreoStartMs - sessionStartMs) / 1000 - 0.2);
      const trimDuration = (choreoEndMs - choreoStartMs) / 1000;
      return {
        rawMp4Url: r.recordingUrl,
        sessionId: session.id,
        pageCount,
        trimStart,
        trimDuration,
      };
    }
    if (r.status === 'failed') throw new Error(`HB_RENDER_FAILED: ${r.error || 'unknown'}`);
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('HB_RENDER_TIMEOUT: no completed MP4 after 90s');
}

// ─── HTTP endpoints ────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// Serve a trimmed MP4 by jobId
app.get('/previews/:id.mp4', (req, res) => {
  const fp = path.join(PREVIEW_DIR, `${req.params.id}.mp4`);
  if (!existsSync(fp)) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(fp);
});

app.post('/render-preview', async (req, res) => {
  cleanOldPreviews();

  const { storybookUrl, storybookId } = req.body;
  if (!storybookUrl) return res.status(400).json({ error: 'missing storybookUrl' });
  if (!/^https:\/\/.+studeoapp\.com/.test(storybookUrl)) {
    return res.status(400).json({ error: 'storybookUrl must be a studeoapp.com URL' });
  }

  const jobId = (storybookId || `job_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
  const attempts = [];
  let rawPath, finalPath;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { rawMp4Url, pageCount, sessionId, trimStart, trimDuration } =
        await renderOnce(storybookUrl);

      rawPath = path.join('/tmp', `${jobId}_${attempt}_raw.mp4`);
      finalPath = path.join(PREVIEW_DIR, `${jobId}.mp4`);

      // Download raw MP4 from Hyperbrowser
      const buf = Buffer.from(await (await fetch(rawMp4Url)).arrayBuffer());
      writeFileSync(rawPath, buf);

      // Trim with ffmpeg — precise cut, re-encoded for clean keyframe alignment
      execSync(
        `ffmpeg -y -ss ${trimStart.toFixed(2)} -i "${rawPath}" ` +
        `-t ${trimDuration.toFixed(2)} ` +
        `-c:v libx264 -preset fast -crf 23 ` +
        `-an -movflags +faststart ` +
        `"${finalPath}" 2>&1`,
        { stdio: 'pipe' }
      );

      unlinkSync(rawPath);
      rawPath = null;

      const validation = ogreValidate(finalPath);
      attempts.push({
        attempt,
        pageCount,
        sessionId,
        trimStart: Number(trimStart.toFixed(2)),
        trimDuration: Number(trimDuration.toFixed(2)),
        ...validation,
      });

      if (!validation.pass) {
        unlinkSync(finalPath);
        finalPath = null;
        continue;
      }

      // Build public URL served by this same Railway container
      const scheme = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const publicUrl = `${scheme}://${host}/previews/${jobId}.mp4`;

      return res.json({
        mp4Url: publicUrl,
        rawMp4Url,        // Hyperbrowser's original (expires ~1h)
        pageCount,
        duration: validation.duration,
        sizeBytes: validation.size,
        jobId,
        attempts,
      });
    } catch (err) {
      attempts.push({ attempt, error: err.message });
      if (rawPath && existsSync(rawPath)) { try { unlinkSync(rawPath); } catch {} }
      if (finalPath && existsSync(finalPath)) { try { unlinkSync(finalPath); } catch {} }
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
