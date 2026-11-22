// Tests for the job gate in server.js. Run with: node tests/job-gate.test.mjs
// It lifts the block between the "job gate: begin" and "job gate: end" markers out of
// server.js and runs that exact code against a stand-in render, so nothing here can
// drift from what the worker really runs. No Hyperbrowser, ffmpeg or Cloudinary is used.
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const src = fsSync.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const block = src.match(/\/\/ ---- job gate: begin[^\n]*\n([\s\S]*?)\/\/ ---- job gate: end ----/);
if (!block) throw new Error('job gate markers not found in server.js');

function load(env) {
  const PREVIEWS_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const envInt = (name, fallback, min) => {
    const n = parseInt(env[name] || '', 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  const quiet = { log() {}, warn() {}, error() {} };
  const make = new Function('envInt', 'fs', 'path', 'PREVIEWS_DIR', 'console',
    block[1] + '\nreturn { gatedAttempt, releaseSetupSlot, jobGate, setupGate, transcodeGate, inFlightAttempts };');
  return Object.assign(make(envInt, fs, path, PREVIEWS_DIR, quiet), { PREVIEWS_DIR });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => fsSync.existsSync(p);
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
};

// 1. A burst of 40 renders: never more than MAX_JOBS running, never more than MAX_SETUP converting, all finish, in order.
{
  const g = load({ MAX_JOBS: '4', MAX_SETUP: '2', JOB_WAIT_MS: '60000' });
  let running = 0, peakRunning = 0, converting = 0, peakConverting = 0;
  const started = [];
  const render = async ({ jobId }) => {
    running++; peakRunning = Math.max(peakRunning, running); started.push(jobId);
    converting++; peakConverting = Math.max(peakConverting, converting);
    await sleep(20);                       // the conversion step
    converting--; g.releaseSetupSlot(jobId);
    await sleep(40);                       // the recording
    running--;
    return { ok: true, log: {} };
  };
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => g.gatedAttempt(render, { jobId: 'job' + i, attemptNum: 1 })));
  check('burst of 40: all finish', results.every((r) => r.ok), results.filter((r) => r.ok).length + ' of 40');
  check('burst of 40: never more than 4 running', peakRunning <= 4, 'peak ' + peakRunning);
  check('burst of 40: never more than 2 converting', peakConverting <= 2, 'peak ' + peakConverting);
  check('burst of 40: first in, first out', started.join() === Array.from({ length: 40 }, (_, i) => 'job' + i).join());
  check('burst of 40: gate is empty afterwards', g.jobGate.stats().inUse === 0 && g.jobGate.stats().waiting === 0 && g.setupGate.stats().inUse === 0 && g.inFlightAttempts.size === 0, JSON.stringify(g.jobGate.stats()));
}

// 2. A render that waits too long is turned away with BUSY, marked so the caller does not retry at once.
{
  const g = load({ MAX_JOBS: '1', MAX_SETUP: '1', JOB_WAIT_MS: '150' });
  let calls = 0;
  const slow = async ({ jobId }) => { calls++; g.releaseSetupSlot(jobId); await sleep(500); return { ok: true, log: {} }; };
  const [a, b] = await Promise.all([g.gatedAttempt(slow, { jobId: 'a', attemptNum: 1 }), g.gatedAttempt(slow, { jobId: 'b', attemptNum: 1 })]);
  check('too long a wait: first render still succeeds', a.ok === true);
  check('too long a wait: second is turned away as BUSY and fatal', b.ok === false && b.fatal === true && /^BUSY/.test(b.log.reason) && b.log.reason.indexOf(':') < 0, b.log && b.log.reason);
  check('too long a wait: the turned-away render never started', calls === 1, calls + ' started');
  check('too long a wait: gate is empty afterwards', g.jobGate.stats().inUse === 0 && g.jobGate.stats().waiting === 0);
}

// 3. The same video asked for twice while it is being made: one render, both callers get its result.
{
  const g = load({ MAX_JOBS: '2', MAX_SETUP: '2' });
  let calls = 0;
  const render = async ({ jobId }) => { calls++; g.releaseSetupSlot(jobId); await sleep(80); return { ok: true, log: {}, tag: 'only-one' }; };
  const p1 = g.gatedAttempt(render, { jobId: 'same', attemptNum: 1 });
  await sleep(20);
  const p2 = g.gatedAttempt(render, { jobId: 'same', attemptNum: 1 });
  const [r1, r2] = await Promise.all([p1, p2]);
  check('duplicate request: rendered once', calls === 1, calls + ' renders');
  check('duplicate request: both callers get the same result', r1 === r2 && r1.tag === 'only-one');
  const r3 = await g.gatedAttempt(render, { jobId: 'same', attemptNum: 2 });
  check('duplicate request: a later request renders afresh', calls === 2 && r3.ok);
}

// 4. A render that throws still gives its places back.
{
  const g = load({ MAX_JOBS: '1', MAX_SETUP: '1' });
  const boom = async () => { throw new Error('boom'); };
  let threw = false;
  try { await g.gatedAttempt(boom, { jobId: 'x', attemptNum: 1 }); } catch { threw = true; }
  const after = await g.gatedAttempt(async ({ jobId }) => { g.releaseSetupSlot(jobId); return { ok: true, log: {} }; }, { jobId: 'y', attemptNum: 1 });
  check('render that throws: error reaches the caller', threw);
  check('render that throws: the next render still gets in', after.ok === true && g.jobGate.stats().inUse === 0 && g.setupGate.stats().inUse === 0);
}

// 5. Local files: uploaded and failed videos are removed after LOCAL_KEEP_MS, raw leftovers at once, local-only videos stay.
{
  const g = load({ MAX_JOBS: '3', MAX_SETUP: '3', LOCAL_KEEP_MS: '1000' });
  const file = (name) => path.join(g.PREVIEWS_DIR, name);
  const write = (name) => fsSync.writeFileSync(file(name), 'x');
  const render = (result) => async ({ jobId }) => { g.releaseSetupSlot(jobId); write(jobId + '.mp4'); write(jobId + '_raw.mp4'); return Object.assign({ log: {}, outPath: file(jobId + '.mp4') }, result); };
  await g.gatedAttempt(render({ ok: true, cloudinaryUrl: 'https://res.cloudinary.com/x/video/upload/a.mp4' }), { jobId: 'uploaded', attemptNum: 1 });
  await g.gatedAttempt(render({ ok: true, cloudinaryUrl: null }), { jobId: 'localonly', attemptNum: 1 });
  await g.gatedAttempt(render({ ok: false }), { jobId: 'failed', attemptNum: 1 });
  await sleep(100);
  check('local files: raw leftovers removed at once', !exists(file('uploaded_raw.mp4')) && !exists(file('failed_raw.mp4')) && !exists(file('localonly_raw.mp4')));
  check('local files: finished videos still there right after the render', exists(file('uploaded.mp4')) && exists(file('failed.mp4')) && exists(file('localonly.mp4')));
  // a newer render of the same video, written just before the first timer fires, must survive that timer
  await sleep(600);
  await g.gatedAttempt(render({ ok: true, cloudinaryUrl: null }), { jobId: 'failed', attemptNum: 2 });
  await sleep(700);
  check('local files: uploaded video removed after the keep time', !exists(file('uploaded.mp4')));
  check('local files: video that is only here is kept', exists(file('localonly.mp4')));
  check('local files: an older timer does not delete a newer render', exists(file('failed.mp4')));
  fsSync.rmSync(g.PREVIEWS_DIR, { recursive: true, force: true });
}

// 6. A second attempt at a video goes to the head of the line, ahead of renders that were already waiting.
{
  const g = load({ MAX_JOBS: '1', MAX_SETUP: '1', JOB_WAIT_MS: '60000' });
  const started = [];
  const render = async ({ jobId, attemptNum }) => { started.push(jobId + '#' + attemptNum); g.releaseSetupSlot(jobId); await sleep(40); return { ok: true, log: {} }; };
  const first = g.gatedAttempt(render, { jobId: 'a', attemptNum: 1 });
  const waitingB = g.gatedAttempt(render, { jobId: 'b', attemptNum: 1 });
  const waitingC = g.gatedAttempt(render, { jobId: 'c', attemptNum: 1 });
  await first;                                                            // a's first attempt ends; b now runs, c waits
  const retryA = g.gatedAttempt(render, { jobId: 'a', attemptNum: 2 });   // must go ahead of c
  await Promise.all([waitingB, waitingC, retryA]);
  check('retry: second attempt runs before renders already in line', started.join() === 'a#1,b#1,a#2,c#1', started.join());
  check('retry: gate is empty afterwards', g.jobGate.stats().inUse === 0 && g.jobGate.stats().waiting === 0);
}

// 7. ffmpeg conversions take turns: never more than MAX_TRANSCODES at once, however many a render asks for.
{
  const g = load({ MAX_TRANSCODES: '3' });
  let running = 0, peak = 0, done = 0;
  const one = async () => {
    await g.transcodeGate.acquire();
    try { running++; peak = Math.max(peak, running); await sleep(15); running--; done++; }
    finally { g.transcodeGate.release(); }
  };
  await Promise.all(Array.from({ length: 25 }, one));
  check('conversions: all 25 finish', done === 25, done + ' of 25');
  check('conversions: never more than 3 at once', peak <= 3, 'peak ' + peak);
  check('conversions: gate is empty afterwards', g.transcodeGate.stats().inUse === 0 && g.transcodeGate.stats().waiting === 0);
}

// 8. In every render path the cinemagraphs are converted BEFORE the browser session is opened,
//    and the two are never started side by side again (that is what misplaced the cut).
{
  const paths = src.split('\n').filter((l) => /^async function run\w+AttemptUngated\(/.test(l)).length;
  const bodies = src.split(/^async function run\w+AttemptUngated\(/m).slice(1);
  const inOrder = bodies.every((b) => {
    const convert = b.indexOf('await pretranscodeCinemagraphs(');
    const session = b.indexOf('await createSessionGated(');
    const anchor = b.indexOf('const recordingT0Ms = Date.now()');
    return convert >= 0 && session > convert && anchor > session;
  });
  check('order: three render paths found', paths === 3 && bodies.length === 3, paths + ' found');
  check('order: convert, then open session, then set the recording anchor', inOrder);
  check('order: session and conversion are not started together', !/Promise\.all\(\[\s*createSessionGated/.test(src));
}

console.log(failures === 0 ? '\nAll checks passed.' : '\n' + failures + ' check(s) FAILED.');
process.exit(failures === 0 ? 0 : 1);
