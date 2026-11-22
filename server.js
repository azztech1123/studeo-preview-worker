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
//  Session gate
// ========================================================
// Hyperbrowser caps how many sessions the team can run at once (25 on the
// Startup plan). A session past the cap is refused, and a refused render is a
// lost video. So this worker never holds more than MAX_SESSIONS at a time:
// a render that arrives while every slot is taken waits its turn (up to
// SESSION_WAIT_MS) instead of failing. A slot is released when its session is
// stopped, and after SESSION_MAX_HOLD_MS at the latest, so a render that dies
// without stopping its session cannot block the queue for good.
//
// Env vars (all optional):
//   MAX_SESSIONS         sessions this worker may hold at once      (default 20)
//   SESSION_WAIT_MS      longest a render waits for a free slot     (default 120000)
//   SESSION_MAX_HOLD_MS  longest one session may hold a slot        (default 600000)
const envInt = (name, fallback, min) => {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const MAX_SESSIONS = envInt('MAX_SESSIONS', 20, 1);
const SESSION_WAIT_MS = envInt('SESSION_WAIT_MS', 120000, 1000);
const SESSION_MAX_HOLD_MS = envInt('SESSION_MAX_HOLD_MS', 600000, 60000);
const HB_BUSY_RETRIES = 6;       // when Hyperbrowser itself says it is at its limit
const HB_BUSY_WAIT_MS = 10000;

let slotsInUse = 0;
const slotWaiters = [];          // first in, first out
const heldSessions = new Map();  // sessionId -> max-hold timer

function sessionGateStats() {
  return { max: MAX_SESSIONS, inUse: slotsInUse, waiting: slotWaiters.length };
}

function acquireSlot() {
  if (slotsInUse < MAX_SESSIONS) {
    slotsInUse++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = {};
    waiter.grant = () => { clearTimeout(waiter.timer); resolve(); };
    waiter.timer = setTimeout(() => {
      const i = slotWaiters.indexOf(waiter);
      if (i >= 0) slotWaiters.splice(i, 1);
      reject(new Error(
        `BUSY: all ${MAX_SESSIONS} session slots stayed in use for ${Math.round(SESSION_WAIT_MS / 1000)}s`
      ));
    }, SESSION_WAIT_MS);
    slotWaiters.push(waiter);
  });
}

function releaseSlot() {
  const next = slotWaiters.shift();
  if (next) next.grant();        // the slot goes straight to the next in line
  else slotsInUse = Math.max(0, slotsInUse - 1);
}

function isHyperbrowserBusy(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  return (err && err.statusCode === 429) || msg.includes('concurren') || msg.includes('too many');
}

async function createSessionGated(opts) {
  await acquireSlot();
  try {
    let session = null;
    for (let i = 0; ; i++) {
      try {
        session = await hb.sessions.create(opts);
        break;
      } catch (err) {
        if (!isHyperbrowserBusy(err) || i >= HB_BUSY_RETRIES) throw err;
        console.log(`session gate: Hyperbrowser is at its limit, retry ${i + 1}/${HB_BUSY_RETRIES} in ${HB_BUSY_WAIT_MS / 1000}s`);
        await new Promise((r) => setTimeout(r, HB_BUSY_WAIT_MS));
      }
    }
    const timer = setTimeout(() => {
      if (!heldSessions.has(session.id)) return;
      console.log(`session gate: ${session.id} held a slot for over ${Math.round(SESSION_MAX_HOLD_MS / 1000)}s, stopping it`);
      stopSessionGated(session.id).catch(() => {});
    }, SESSION_MAX_HOLD_MS);
    timer.unref();
    heldSessions.set(session.id, timer);
    return session;
  } catch (err) {
    releaseSlot();
    throw err;
  }
}

async function stopSessionGated(sessionId) {
  try {
    return await hb.sessions.stop(sessionId);
  } finally {
    const timer = heldSessions.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      heldSessions.delete(sessionId);
      releaseSlot();
    }
  }
}

// ========================================================
//  Job gate
// ========================================================
// The session gate above keeps this worker inside Hyperbrowser's cap, but a
// render does more than hold a session: before the browser opens, it converts
// every moving picture in the storybook with ffmpeg. That conversion used to
// start the moment a request arrived, whether or not a session slot was free.
// On 22 Nov 2026, 69 renders arrived within ten minutes: 20 held sessions, 49
// waited for one, and all 69 were converting at once. The machine ran out of
// CPU and could not start more ffmpeg processes (spawn ffmpeg EAGAIN), renders
// slowed, waits timed out, callers retried, and each retry started the same
// video a second time on top of the first.
//
// So a render now waits its turn BEFORE it does anything:
//   - at most MAX_JOBS renders run at once. The rest wait in line, first in,
//     first out, using no CPU and no Hyperbrowser session while they wait;
//   - at most MAX_SETUP of the running renders may be in the conversion step
//     at the same moment (that step is the CPU-heavy one), and over all of them
//     at most MAX_TRANSCODES ffmpeg conversions run at once. A book with ten
//     cinemagraphs used to start ten at the same time; now they take turns;
//   - a second or third attempt at the same video goes to the head of the line
//     instead of the back, so a retry does not wait behind every newcomer;
//   - a render that waits longer than JOB_WAIT_MS is turned away with a clear
//     BUSY error, so the caller can try again instead of hanging;
//   - if the same video is asked for again while it is still being made (a
//     caller that timed out and retried), the second request joins the first
//     instead of starting a duplicate.
// Local files: once a video is safely on Cloudinary, its copy on this machine
// is deleted after LOCAL_KEEP_MS, and a failed attempt's leftovers are removed,
// so the disk does not fill up over a long run.
//
//   MAX_JOBS        renders running at once                        (default 10)
//   MAX_SETUP       of those, how many may convert at once         (default 3)
//   MAX_TRANSCODES  ffmpeg conversions at once, over all renders   (default 6)
//   JOB_WAIT_MS     longest a render waits in line                 (default 150000)
//   LOCAL_KEEP_MS   how long an uploaded video's local copy stays  (default 600000)
// ---- job gate: begin (tests/job-gate.test.mjs runs this block) ----
const MAX_JOBS = envInt('MAX_JOBS', 10, 1);
const MAX_SETUP = envInt('MAX_SETUP', 3, 1);
const MAX_TRANSCODES = envInt('MAX_TRANSCODES', 6, 1);
const JOB_WAIT_MS = envInt('JOB_WAIT_MS', 150000, 100);
const LOCAL_KEEP_MS = envInt('LOCAL_KEEP_MS', 600000, 1000);

// A first-in, first-out gate. waitMs of 0 means wait as long as it takes.
function makeGate(max, waitMs, busyMessage) {
  let inUse = 0;
  const waiters = [];
  return {
    acquire(front) {
      if (inUse < max) {
        inUse++;
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const waiter = {};
        waiter.grant = () => { clearTimeout(waiter.timer); resolve(); };
        if (waitMs > 0) {
          waiter.timer = setTimeout(() => {
            const i = waiters.indexOf(waiter);
            if (i >= 0) waiters.splice(i, 1);
            reject(new Error(busyMessage));
          }, waitMs);
        }
        if (front) waiters.unshift(waiter);     // a retry keeps its place at the head of the line
        else waiters.push(waiter);
      });
    },
    release() {
      const next = waiters.shift();
      if (next) next.grant();      // the place goes straight to the next in line
      else inUse = Math.max(0, inUse - 1);
    },
    stats() {
      return { max, inUse, waiting: waiters.length };
    },
  };
}

const jobGate = makeGate(
  MAX_JOBS,
  JOB_WAIT_MS,
  `BUSY - all ${MAX_JOBS} render places stayed taken for ${Math.round(JOB_WAIT_MS / 1000)}s, try again shortly`
);
const setupGate = makeGate(MAX_SETUP, 0, '');
const transcodeGate = makeGate(MAX_TRANSCODES, 0, '');   // ffmpeg conversions running, over all renders
const setupHolders = new Set();        // jobIds now in the conversion step
const inFlightAttempts = new Map();    // jobId -> the attempt now running or waiting

function releaseSetupSlot(jobId) {
  if (setupHolders.delete(jobId)) setupGate.release();
}

// Every attempt function (short, long, complete) is called through this.
function gatedAttempt(runAttempt, args) {
  const { jobId } = args;
  const running = inFlightAttempts.get(jobId);
  if (running) {
    console.log(`[${jobId}] already being rendered, joining that render instead of starting another`);
    return running;
  }
  const attempt = (async () => {
    const queuedAt = Date.now();
    try {
      await jobGate.acquire(args.attemptNum > 1);
    } catch (err) {
      console.warn(`[${jobId}] ${err.message}`);
      return {
        ok: false,
        fatal: true,       // no point trying again at once: the caller should come back later
        log: { attempt: args.attemptNum, pass: false, reason: err.message, queuedMs: Date.now() - queuedAt },
      };
    }
    let result = null;
    try {
      await setupGate.acquire(args.attemptNum > 1);
      setupHolders.add(jobId);
      const queuedMs = Date.now() - queuedAt;
      if (queuedMs > 1000) console.log(`[${jobId}] waited ${Math.round(queuedMs / 1000)}s in line`);
      result = await runAttempt(args);
      if (result && result.log) result.log.queuedMs = queuedMs;
      return result;
    } finally {
      releaseSetupSlot(jobId);       // normally given back already, when the conversion step ended
      jobGate.release();
      tidyLocalFiles(jobId, result);
    }
  })();
  inFlightAttempts.set(jobId, attempt);
  const forget = () => {
    if (inFlightAttempts.get(jobId) === attempt) inFlightAttempts.delete(jobId);
  };
  attempt.then(forget, forget);
  return attempt;
}

// After an attempt: remove what nothing will ask for again.
function tidyLocalFiles(jobId, result) {
  // a failed attempt can leave its raw recording behind (a good one already deleted it)
  fs.unlink(path.join(PREVIEWS_DIR, `${jobId}_raw.mp4`)).catch(() => {});
  if (!result || !result.outPath) return;
  const uploaded = result.ok && result.cloudinaryUrl;
  const failed = !result.ok;
  // Good video that is NOT on Cloudinary: its only copy is here and its address
  // points here, so it stays (the 72-hour sweep in cleanupOldFiles removes it).
  if (!uploaded && !failed) return;
  const outPath = result.outPath;
  const timer = setTimeout(async () => {
    try {
      if (inFlightAttempts.has(jobId)) return;                      // being rendered again right now
      const st = await fs.stat(outPath);
      if (Date.now() - st.mtimeMs < LOCAL_KEEP_MS - 500) return;    // a newer render wrote it, and has its own timer
      await fs.unlink(outPath);
    } catch {}
  }, LOCAL_KEEP_MS);
  timer.unref();
}
// ---- job gate: end ----

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
    //   - Disable B-frames (-bf 0): older AVFoundation thumbnailers
    //     misbehave on decode-order-vs-display-order reorder in the first
    //     GOP, even with a forced I-frame at t=0
    //   - Short GOP (-g 60 -keyint_min 60): I-frame every 2s so iMessage's
    //     seek-to-thumbnail (often with non-zero tolerance) always lands on
    //     a content keyframe, never falls into a B-frame decode chain
    //   - Tag color metadata explicitly (bt709 primaries/transfer/matrix,
    //     tv range) + write_colr in movflags so the colr box is embedded.
    //     Without these, AVFoundation defaults to BT.601 limited-range and
    //     the BT.709 source decodes washed-out or near-black
    //   - NO AUDIO TRACK. A previous version added a silent AAC track on
    //     the folklore that "video-only MP4s sometimes render as black in
    //     iMessage". Empirically that was wrong: AAC's encoder priming
    //     delay (~2048 samples / ~46ms at 44.1kHz) forces the MP4 muxer to
    //     insert an "empty edit" (elst entry with media_time=-1, duration
    //     ≈ 860 / 15360 = 56ms) at the head of the VIDEO track to keep A/V
    //     in sync. iMessage's thumbnailer doesn't honor edit lists, asks
    //     for frame at t=0, sees "empty edit, no frame there", falls back
    //     to black. Removing the audio eliminates priming → no empty edit
    //     → video starts at PTS=0 → iMessage thumbnail shows the cover.
    //     (Verified by ffprobe: with audio, video start_pts=860; without
    //     audio, video start_pts=0.)
    //   - ELIMINATE THE EDIT LIST: setpts=PTS-STARTPTS filter resets the
    //     first frame's PTS to 0 — combined with the no-audio fix above,
    //     this gives a clean single-entry edit list (media_time=0, normal
    //     "play from start") that every thumbnailer accepts.
    const args = [
      '-y',
      '-i', inPath,
      '-ss', startSec.toFixed(3),
      '-t', durationSec.toFixed(3),
      '-map', '0:v:0',
      '-an',
      '-vf', 'setpts=PTS-STARTPTS',
      '-c:v', 'libx264',
      '-profile:v', 'main',
      '-level', '4.0',
      '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709',
      '-color_trc',       'bt709',
      '-colorspace',      'bt709',
      '-color_range',     'tv',
      '-r', '30',
      '-g', '60',
      '-keyint_min', '60',
      '-bf', '0',
      '-force_key_frames', '0',
      '-preset', 'veryfast',
      '-crf', '23',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart+write_colr',
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

// Click a Studeo book-navigation control by its stable id (#nav-forward /
// #nav-back). page.click auto-waits for visibility + actionability; the short
// timeout fails fast if the control is absent rather than stalling ~30s.
async function clickNav(page, selector) {
  await page.click(selector, { timeout: 8000 });
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

// The conversion step of a render. When it ends (well or badly), the render
// gives back its conversion place so the next render in line can start its own.
async function pretranscodeCinemagraphs(storybookUrl, jobId) {
  try {
    return await pretranscodeCinemagraphsUngated(storybookUrl, jobId);
  } finally {
    releaseSetupSlot(jobId);
  }
}

async function pretranscodeCinemagraphsUngated(storybookUrl, jobId) {
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
        await transcodeGate.acquire();
        try {
          await transcodeToWebmVp8(mp4Path, webmPath);
        } finally {
          transcodeGate.release();
        }
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

// Each attempt waits its turn at the job gate (see "Job gate" above).
function runOneAttempt(args) {
  return gatedAttempt(runOneAttemptUngated, args);
}

async function runOneAttemptUngated({ storybookUrl, jobId, attemptNum, baseUrl }) {
  let session = null;
  let browser = null;
  const log = { attempt: attemptNum };

  try {
    console.log(`[${jobId}] attempt ${attemptNum}: converting cinemagraphs, then opening the session`);

    // Convert first, open the browser session second. Hyperbrowser records from
    // the moment the session exists and the trim further down measures from
    // that moment, so nothing slow may sit between the two. (When the two ran
    // side by side, a slow conversion pushed the cut that many seconds early:
    // blank page at the start, the last pages cut off, and under load a whole
    // clip of blank page that failed the size check.)
    const pretranscode = await pretranscodeCinemagraphs(storybookUrl, jobId);
    const sessionResult = await createSessionGated({
      enableWebRecording: true,
      enableVideoWebRecording: true,
      screen: { width: 1920, height: 1080 },
    });
    session = sessionResult;
    log.sessionId = session.id;
    log.pretranscode = pretranscode.stats;
    console.log(`[${jobId}] session ${session.id}`);

    // Wall-clock anchor for the recording. HB starts recording at session
    // creation, so the delta from here to any later Date.now() approximates
    // the offset of that moment within the raw video. Used below to trim
    // from the choreography START, not from the recording's END — the old
    // tail-anchored approach assumed HB's post-stop tail was ~0.3s when in
    // reality it's 1.5-4s (browser.close + sessions.stop + HB buffer flush),
    // which made trimStart land in the pre-choreography preamble (loading
    // screen / blank page → black frame at t=0 → black iMessage thumbnail).
    const recordingT0Ms = Date.now();

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
    // Let Studeo's library.js inject <video> elements + our route warm up.
    // Extra buffer so the cover is actually PAINTED and stable before we
    // mark choreoStartMs — otherwise the cover dwell burns on a blank/loading
    // screen and the real cover content barely appears in the recording.
    await page.waitForTimeout(2500);

    // Storybook nav controls are rendered client-side; confirm before
    // choreography so a template missing them fails fast (and retries).
    await page.waitForSelector('#nav-forward', { state: 'visible', timeout: 10000 });

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

    await clickNav(page, '#nav-forward');
    await page.waitForTimeout(1200);                 // transition to spread 2
    await snap('t=3.2_spread-2-in');
    await page.waitForTimeout(5000);                 // spread 2 forward dwell (+2s)

    await clickNav(page, '#nav-forward');
    await page.waitForTimeout(1200);                 // transition to spread 3
    await snap('t=9.4_spread-3-in');
    await page.waitForTimeout(5000);                 // spread 3 forward dwell (+2s)

    await clickNav(page, '#nav-back');
    await page.waitForTimeout(1200);                 // transition back to spread 2
    await snap('t=15.6_spread-2-back');
    await page.waitForTimeout(1500);                 // backward dwell (unchanged)

    await clickNav(page, '#nav-back');
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
    try { await stopSessionGated(session.id); } catch (e) {
      console.warn(`[${jobId}] stop warn: ${e.message}`);
    }

    const trimDuration = (choreoEndMs - choreoStartMs) / 1000;
    log.trimDuration = Number(trimDuration.toFixed(2));

    console.log(`[${jobId}] polling for recording url`);
    const rawVideoUrl = await pollVideoUrl(session.id);

    const rawPath = path.join(PREVIEWS_DIR, `${jobId}_raw.mp4`);
    await downloadToFile(rawVideoUrl, rawPath);

    // Anchor trim from recording T0 (session create) using wall-clock delta.
    // The leadIn shifts trimStart slightly earlier than choreoStartMs so the
    // first output frame lands on the painted cover, not on the snap() instant
    // where the cinemagraph might still be at readyState < 2 (which would render
    // as a black <video> rectangle and cause iMessage to extract a black thumb).
    const rawDuration = await probeDuration(rawPath);
    log.rawDuration = Number(rawDuration.toFixed(2));
    const leadIn = 0.5;
    const trimStart = Math.max(0, (choreoStartMs - recordingT0Ms) / 1000 - leadIn);
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
    if (session) { try { await stopSessionGated(session.id); } catch {} }
    fs.rm(path.join(CINEMAGRAPHS_DIR, jobId), { recursive: true, force: true }).catch(() => {});
  }
}

// ========================================================
//  Express
// ========================================================

const app = express();
app.use(express.json({ limit: '1mb' }));

// How full the local previews folder is, refreshed once a minute for /health.
let localFiles = { files: 0, mb: 0 };
async function measureLocalFiles() {
  try {
    const names = await fs.readdir(PREVIEWS_DIR);
    let bytes = 0;
    for (const name of names) {
      try { bytes += (await fs.stat(path.join(PREVIEWS_DIR, name))).size; } catch {}
    }
    localFiles = { files: names.length, mb: Math.round(bytes / 1048576) };
  } catch {}
}
setInterval(measureLocalFiles, 60 * 1000).unref();

app.get('/health', (req, res) => res.json({
  ok: true,
  sessions: sessionGateStats(),
  jobs: jobGate.stats(),            // renders running, and waiting in line
  converting: setupGate.stats(),    // renders in the ffmpeg conversion step
  transcodes: transcodeGate.stats(),// single ffmpeg conversions running, over all renders
  localVideos: localFiles,          // finished videos still on this machine's disk
  memoryMb: Math.round(process.memoryUsage().rss / 1048576),
}));

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
  // Dispatch by version field
  const v = (req.body || {}).version;
  if (v === 'complete') return handleCompleteSyncRender(req, res);
  if (v === 'long') return handleLongSyncRender(req, res);

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
  // Dispatch by version field
  const v = (req.body || {}).version;
  if (v === 'complete') return handleCompleteAsyncRender(req, res);
  if (v === 'long') return handleLongAsyncRender(req, res);

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

// Each attempt waits its turn at the job gate (see "Job gate" above).
function runFullForwardAttempt(args) {
  return gatedAttempt(runFullForwardAttemptUngated, args);
}

async function runFullForwardAttemptUngated({ storybookUrl, jobId, attemptNum, baseUrl }) {
  let session = null;
  let browser = null;
  const log = { attempt: attemptNum, version: 'long' };

  try {
    console.log(`[${jobId}] LONG attempt ${attemptNum}: converting cinemagraphs, then opening the session`);

    // Convert first, open the browser session second. Hyperbrowser records from
    // the moment the session exists and the trim further down measures from
    // that moment, so nothing slow may sit between the two. (When the two ran
    // side by side, a slow conversion pushed the cut that many seconds early:
    // blank page at the start, the last pages cut off, and under load a whole
    // clip of blank page that failed the size check.)
    const pretranscode = await pretranscodeCinemagraphs(storybookUrl, jobId);
    const sessionResult = await createSessionGated({
      enableWebRecording: true,
      enableVideoWebRecording: true,
      screen: { width: 1920, height: 1080 },
    });
    session = sessionResult;
    log.sessionId = session.id;
    log.pretranscode = pretranscode.stats;
    console.log(`[${jobId}] LONG session ${session.id}`);

    // Wall-clock anchor for the recording — see comment in runOneAttempt.
    const recordingT0Ms = Date.now();

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
    await page.waitForTimeout(2500);

    // Storybook nav controls are rendered client-side; confirm before
    // choreography so a template missing them fails fast (and retries).
    await page.waitForSelector('#nav-forward', { state: 'visible', timeout: 10000 });

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
    // S = min(floor((pageCount - 2) / 2), MAX_SPREADS)
    // Idle is computed from WALL CLOCK so snap() overhead can't push past 42s.
    //
    // Tuning (post-mortem from runs producing 44.3s output):
    // - Each spread iteration costs ~8.4s wall-clock with SPREAD_DWELL=6000,
    //   because clickNav + snap + CDP RTT adds ~1.2s of overhead the original
    //   plan budgeted at zero. With MAX_SPREADS=5 the forward pass alone hit
    //   ~44s, busting the 42s target before any idle could run.
    // - Drop SPREAD_DWELL to 4500ms and cap MAX_SPREADS at 4. Expected forward
    //   pass: 2000 + 4 * (1200 + 4500 + ~1200 overhead) = ~29600ms. That leaves
    //   ~12s of real idle on the last spread, well inside the budget.
    // - User intent: "loosely 42 seconds, don't need to show all spreads."
    const TARGET_MS = 42000;
    const COVER_DWELL = 2000;
    const TRANSITION = 1200;
    const SPREAD_DWELL = 4500;
    const MAX_SPREADS = 4;

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
      await clickNav(page, '#nav-forward');
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
    try { await stopSessionGated(session.id); } catch (e) {
      console.warn(`[${jobId}] LONG stop warn: ${e.message}`);
    }

    const rawChoreoElapsedMs = choreoEndMs - choreoStartMs;
    // Cap the trim duration: even if CDP overhead made the choreography
    // overrun the 42s target, never write a video longer than 46s. This
    // keeps us inside the validator's upper bound regardless of variance.
    const MAX_TRIM_MS = 46000;
    const trimDuration = Math.min(rawChoreoElapsedMs, MAX_TRIM_MS) / 1000;
    log.trimDuration = Number(trimDuration.toFixed(2));
    log.choreoElapsedMs = rawChoreoElapsedMs;

    console.log(`[${jobId}] LONG polling for recording url`);
    const rawVideoUrl = await pollVideoUrl(session.id);

    const rawPath = path.join(PREVIEWS_DIR, `${jobId}_raw.mp4`);
    await downloadToFile(rawVideoUrl, rawPath);

    // Anchor trim from recording T0 (session create) using wall-clock delta —
    // see comment in runOneAttempt for the rationale.
    const rawDuration = await probeDuration(rawPath);
    log.rawDuration = Number(rawDuration.toFixed(2));
    const leadIn = 0.5;
    const trimStart = Math.max(0, (choreoStartMs - recordingT0Ms) / 1000 - leadIn);
    log.trimStart = Number(trimStart.toFixed(2));

    const outPath = path.join(PREVIEWS_DIR, `${jobId}.mp4`);
    await trimMp4(rawPath, outPath, trimStart, trimDuration);
    await fs.unlink(rawPath).catch(() => {});

    const duration = await probeDuration(outPath);
    const st = await fs.stat(outPath);
    log.duration = Number(duration.toFixed(1));
    log.size = st.size;

    // LONG-MODE validator: target ~42s with WIDE tolerance.
    // Previous tight window [40, 44] failed on encoder rounding alone
    // (44.22s trim → 44.3s output → out of bounds by 0.3s). 30fps frame
    // quantization, AAC sample alignment, and toFixed(1) rounding together
    // can shift output by ~0.1s. The widened window absorbs that plus
    // normal CDP timing variance without compromising "roughly 42s" intent.
    const DUR_MIN = 35.0;
    const DUR_MAX = 50.0;
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
    if (session) { try { await stopSessionGated(session.id); } catch {} }
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

// ============================================================================
//  ██  COMPLETE-MODE ADDITIONS — purely additive, no time cap  ██
// ============================================================================
//
//  Triggered by {version: "complete"} in the POST body of either /render-preview
//  or /render-preview-async.
//
//  Choreography: cover → every interior spread → back cover. 5s dwell on each
//  panel, 1.2s transition between panels. No 42s ceiling — duration scales
//  with pageCount.
//
//  For a pageCount of P:
//    interiorSpreads = floor((P - 2) / 2)
//    totalPanels     = 1 + interiorSpreads + 1   (cover + interior + back cover)
//    totalClicks     = totalPanels - 1
//    expectedSec     = totalPanels * 5 + totalClicks * 1.7   (1.7s/click overhead)
//
//  Examples:
//    P=12  →  5 interior spreads, 7 panels, 6 clicks   →  ~45s
//    P=20  →  9 interior spreads, 11 panels, 10 clicks →  ~72s
//    P=6   →  2 interior spreads, 4 panels, 3 clicks   →  ~25s
//
//  Validator: ±25% with min ±5s. Far looser than long mode because we have
//  no fixed target — the video length IS the deliverable.
//
//  Shares with long/v15b: pretranscoding, Mux→WebM 302 redirect, JOB_STATE,
//  /webm + /previews endpoints, trim math, ffprobe/ffmpeg helpers.
// ============================================================================

// Each attempt waits its turn at the job gate (see "Job gate" above).
function runCompleteForwardAttempt(args) {
  return gatedAttempt(runCompleteForwardAttemptUngated, args);
}

async function runCompleteForwardAttemptUngated({ storybookUrl, jobId, attemptNum, baseUrl }) {
  let session = null;
  let browser = null;
  const log = { attempt: attemptNum, version: 'complete' };

  try {
    console.log(`[${jobId}] COMPLETE attempt ${attemptNum}: converting cinemagraphs, then opening the session`);

    // Convert first, open the browser session second. Hyperbrowser records from
    // the moment the session exists and the trim further down measures from
    // that moment, so nothing slow may sit between the two. (When the two ran
    // side by side, a slow conversion pushed the cut that many seconds early:
    // blank page at the start, the last pages cut off, and under load a whole
    // clip of blank page that failed the size check.)
    const pretranscode = await pretranscodeCinemagraphs(storybookUrl, jobId);
    const sessionResult = await createSessionGated({
      enableWebRecording: true,
      enableVideoWebRecording: true,
      screen: { width: 1920, height: 1080 },
    });
    session = sessionResult;
    log.sessionId = session.id;
    log.pretranscode = pretranscode.stats;
    console.log(`[${jobId}] COMPLETE session ${session.id}`);

    // Wall-clock anchor for the recording — see comment in runOneAttempt.
    const recordingT0Ms = Date.now();

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());

    const routeLog = [];
    const routeStart = Date.now();

    // Same 302 redirect architecture as long/v15b
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

    console.log(`[${jobId}] COMPLETE navigating`);
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

    if (pageCount < 2) {
      throw new Error(`BOOK_TOO_SHORT: ${pageCount} pages (need >=2 for cover + back cover)`);
    }

    await page.evaluate(() => {
      try {
        window.focus();
        if (document.body && document.body.focus) document.body.focus();
      } catch {}
    });
    await page.waitForTimeout(2500);

    // Storybook nav controls are rendered client-side; confirm before
    // choreography so a template missing them fails fast (and retries).
    await page.waitForSelector('#nav-forward', { state: 'visible', timeout: 10000 });

    const snap = async (label) => {
      try {
        await page.evaluate(
          `window.__snap && window.__snap(${JSON.stringify(label)})`
        );
      } catch {}
    };

    // === COMPLETE-MODE CHOREOGRAPHY ===
    // Traverse the ENTIRE book: cover → every interior spread → back cover.
    // 5s dwell on each panel, 1.2s transition between panels.
    // No artificial time cap — duration = totalPanels × 5s + totalClicks × overhead.
    const PANEL_DWELL = 5000;
    const TRANSITION = 1200;

    const interiorSpreads = Math.max(0, Math.floor((pageCount - 2) / 2));
    const totalPanels = 1 + interiorSpreads + 1;  // cover + interior + back cover
    const totalForwardClicks = totalPanels - 1;

    log.interiorSpreads = interiorSpreads;
    log.totalPanels = totalPanels;
    log.totalForwardClicks = totalForwardClicks;

    const choreoStartMs = Date.now();

    // Panel 0: cover
    await snap('panel-0_cover');
    await page.waitForTimeout(PANEL_DWELL);

    // Panels 1..N-1: each interior spread, ending with back cover.
    // If clickNav throws (end of book reached earlier than expected, e.g. odd
    // pageCount with a layout we didn't predict), break gracefully and dwell
    // on whatever the current panel is so we still produce a usable video.
    let actualClicks = 0;
    for (let i = 1; i <= totalForwardClicks; i++) {
      try {
        await clickNav(page, '#nav-forward');
        actualClicks++;
      } catch (e) {
        log.earlyEndAtPanel = i;
        log.earlyEndReason = e.message;
        console.warn(`[${jobId}] COMPLETE clickNav failed at panel ${i}: ${e.message}`);
        break;
      }
      await page.waitForTimeout(TRANSITION);
      // Diagnostic snaps: first interior, last interior, back cover
      if (i === 1 || i === totalForwardClicks - 1 || i === totalForwardClicks) {
        const label = i === totalForwardClicks
          ? `panel-${i}_back-cover`
          : `panel-${i}_spread`;
        await snap(label);
      }
      await page.waitForTimeout(PANEL_DWELL);
    }
    log.actualForwardClicks = actualClicks;

    await snap('t=end');
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
    try { await stopSessionGated(session.id); } catch (e) {
      console.warn(`[${jobId}] COMPLETE stop warn: ${e.message}`);
    }

    const trimDuration = (choreoEndMs - choreoStartMs) / 1000;
    log.trimDuration = Number(trimDuration.toFixed(2));

    console.log(`[${jobId}] COMPLETE polling for recording url`);
    // Longer poll timeout for complete mode: long books generate larger
    // recordings that take longer to finalize on Hyperbrowser's side.
    const rawVideoUrl = await pollVideoUrl(session.id, 180000);

    const rawPath = path.join(PREVIEWS_DIR, `${jobId}_raw.mp4`);
    await downloadToFile(rawVideoUrl, rawPath);

    // Anchor trim from recording T0 (session create) using wall-clock delta —
    // see comment in runOneAttempt for the rationale.
    const rawDuration = await probeDuration(rawPath);
    log.rawDuration = Number(rawDuration.toFixed(2));
    const leadIn = 0.5;
    const trimStart = Math.max(0, (choreoStartMs - recordingT0Ms) / 1000 - leadIn);
    log.trimStart = Number(trimStart.toFixed(2));

    const outPath = path.join(PREVIEWS_DIR, `${jobId}.mp4`);
    await trimMp4(rawPath, outPath, trimStart, trimDuration);
    await fs.unlink(rawPath).catch(() => {});

    const duration = await probeDuration(outPath);
    const st = await fs.stat(outPath);
    log.duration = Number(duration.toFixed(1));
    log.size = st.size;

    // COMPLETE-MODE validator: expected duration scales with pageCount.
    // Each panel ~5s dwell, each click ~1.7s overhead (transition + CDP +
    // snap on diagnostic panels). Tolerance ±25% with a 5s floor.
    const expectedSec = totalPanels * 5 + actualClicks * 1.7;
    const tolerance = Math.max(5, expectedSec * 0.25);
    const DUR_MIN = Math.max(5, expectedSec - tolerance);
    const DUR_MAX = expectedSec + tolerance;
    const SIZE_MIN = 200 * 1024;

    log.expectedSec = Number(expectedSec.toFixed(1));
    log.durMin = Number(DUR_MIN.toFixed(1));
    log.durMax = Number(DUR_MAX.toFixed(1));

    if (duration < DUR_MIN || duration > DUR_MAX) {
      log.pass = false;
      log.reason = `duration=${duration.toFixed(1)}s out of [${DUR_MIN.toFixed(1)},${DUR_MAX.toFixed(1)}] (expected ~${expectedSec.toFixed(1)}s for ${totalPanels} panels)`;
      return { ok: false, log, outPath, rawVideoUrl };
    }
    if (st.size < SIZE_MIN) {
      log.pass = false;
      log.reason = `size=${st.size} below ${SIZE_MIN}`;
      return { ok: false, log, outPath, rawVideoUrl };
    }

    // Upload to Cloudinary (same pattern as long/short modes).
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
        console.log(`[${jobId}] COMPLETE cloudinary upload ok: ${result.secureUrl} (${Date.now() - uploadStart}ms)`);
      } catch (upErr) {
        log.cloudinary = { error: upErr.message, uploadMs: Date.now() - uploadStart };
        console.warn(`[${jobId}] COMPLETE cloudinary upload failed, falling back to Railway URL: ${upErr.message}`);
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
    if (session) { try { await stopSessionGated(session.id); } catch {} }
    fs.rm(path.join(CINEMAGRAPHS_DIR, jobId), { recursive: true, force: true }).catch(() => {});
  }
}

async function runCompleteRenderJob({ jobId, storybookUrl, baseUrl }) {
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
      const result = await runCompleteForwardAttempt({
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
    state.version = 'complete';
    state.mp4Url = success.cloudinaryUrl || fallbackUrl;
    state.fallbackMp4Url = fallbackUrl;
    state.rawMp4Url = rawVideoUrl;
    state.pageCount = success.log.pageCount;
    state.duration = success.log.duration;
    state.sizeBytes = st.size;
    state.totalPanels = success.log.totalPanels;
    state.interiorSpreads = success.log.interiorSpreads;
    state.actualForwardClicks = success.log.actualForwardClicks;
    state.attempts = attempts;
    state.updatedAt = Date.now();
  } catch (err) {
    state.status = 'failed';
    state.error = err?.message || 'unknown error';
    state.updatedAt = Date.now();
    console.error(`[${jobId}] COMPLETE render job crashed:`, err);
  }
}

async function handleCompleteSyncRender(req, res) {
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
    const result = await runCompleteForwardAttempt({ storybookUrl, jobId, attemptNum: i, baseUrl });
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
    version: 'complete',
    pageCount: success.log.pageCount,
    duration: success.log.duration,
    sizeBytes: st.size,
    totalPanels: success.log.totalPanels,
    interiorSpreads: success.log.interiorSpreads,
    actualForwardClicks: success.log.actualForwardClicks,
    expectedSec: success.log.expectedSec,
    jobId,
    attempts,
  });
}

async function handleCompleteAsyncRender(req, res) {
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
    version: 'complete',
    status: 'pending',
    storybookUrl,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  JOB_STATE.set(jobId, state);

  setImmediate(() => {
    runCompleteRenderJob({ jobId, storybookUrl, baseUrl }).catch((err) => {
      console.error(`[${jobId}] runCompleteRenderJob threw:`, err);
    });
  });

  res.status(202).json({
    jobId,
    statusUrl: `${baseUrl}/preview-status/${jobId}`,
    status: 'pending',
    version: 'complete',
  });
}

app.listen(PORT, () => {
  console.log(`studeo-preview-worker listening on ${PORT}`);
});
