'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const { digestGet, digestGetJson } = require('./digest.js');
const { analyzeBgcode, mapLive, materialFor, ANALYSIS_VERSION } = require('./toolswaps.js');
const { ConnectAuth, fetchPrinter, mapConnectToState } = require('./prusaconnect.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const CACHE_DIR = path.join(__dirname, 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const LASTSTATE_FILE = path.join(CACHE_DIR, 'laststate.json');
const CONNECT_TOKEN_FILE = path.join(CACHE_DIR, 'connect-token.json');

// Prusa Connect (cloud): authoritative source for the INDX active tool + full live telemetry.
// Inert unless a refresh token AND printer uuid are configured, so the local-only path is unaffected.
const connectAuth = new ConnectAuth(cfg, CONNECT_TOKEN_FILE);
const connectEnabled = connectAuth.hasCredentials() && !!cfg.connectPrinterUuid && cfg.useConnect !== false;
let connectLive = null;       // last mapped Connect telemetry (see mapConnectToState)
let connectLastGoodAt = 0;    // epoch sec of the last successful Connect read
let connectOnline = false;    // did the most recent Connect poll succeed?
let connectFailures = 0;      // consecutive Connect failures (for log throttling)

// ---- shared state ------------------------------------------------------------
let state = { state: 'UNKNOWN', updatedAt: 0 };
let analysis = null;          // { jobKey, initialTool, totalSwaps, timeline, toolsSeen }
let analyzing = false;        // guards concurrent bgcode downloads
let analysisFailCount = 0;    // consecutive analysis download failures (for backoff)
let analysisFailedKey = null; // jobKey that last failed
let analysisRetryAt = 0;      // epoch ms before which we won't retry the failed job
let thumbCache = { key: null, buf: null, contentType: 'image/png' };
let lastGoodAt = 0;           // epoch sec of the last SUCCESSFUL printer read
let printerOnline = false;    // did the most recent poll succeed?
let consecutiveFailures = 0;  // for backoff when the printer API hangs

// Restore the last-known frame so a restart while the printer is down still shows
// (grayed-out) data rather than an empty card.
try {
  const saved = JSON.parse(fs.readFileSync(LASTSTATE_FILE, 'utf8'));
  if (saved && saved.state) { state = saved.state; lastGoodAt = saved.lastGoodAt || 0; }
} catch { /* no prior state */ }

const cleanName = (displayName) => {
  if (!displayName) return '';
  return displayName
    .replace(/\.(bgcode|gcode|bgc|gco)$/i, '')
    .replace(/_\d+(\.\d+)?n_.*$/, '')   // strip slicer suffix: _0.4n_0.2mm_..._COREONEINDX_4h5m
    .replace(/\+/g, ' ')
    .trim();
};

const jobKeyOf = (jobId, fileName) => `${jobId || 'x'}::${fileName || ''}`;

// Physical toolchange tracking. An INDX swap physically pulls the hot tool and docks a cold one, so
// the active nozzle reading CRATERS — measured live it plunges from 255° to 0–15° and ramps back to
// temp over ~7s. Crucially the *target* also drops to 0 mid-swap, so we must NOT measure the dip
// relative to the live target (it's meaningless at 0). We remember the last real print temp
// (`lastTarget`) and detect the crater against that absolute value.
//   armed=true  -> nozzle at print temp, tool in use.
//   crater (temp < lastTarget-60) while armed   -> swap started: disarm, swapping=true.
//   reheat (temp >= lastTarget-15) while disarmed -> swap done: rearm, swapping=false, confirmed++.
// `confirmed` is the count of COMPLETED swaps — i.e. the current index into the gcode tool sequence.
// It is seeded once (see poll) from the restored/progress estimate, then dips carry it forward.
// Reset per job. (Between two real swaps the nozzle must return to print temp to extrude, so the
// re-arm always triggers — the ~20s of steady 255° seen between craters guarantees no merged count.)
let swapTrack = { jobKey: null, confirmed: 0, armed: false, swapping: false, lastTarget: 0, seeded: false };

function trackSwaps(jobKey, p, printerState) {
  if (swapTrack.jobKey !== jobKey) {
    swapTrack = { jobKey, confirmed: 0, armed: false, swapping: false, lastTarget: 0, seeded: false };
  }
  const tN = p.temp_nozzle;
  if (p.target_nozzle > 0) swapTrack.lastTarget = p.target_nozzle; // learn/keep the print temp
  const tgt = swapTrack.lastTarget;
  if (printerState !== 'PRINTING' || !(tgt > 0) || tN == null) return swapTrack;
  if (!swapTrack.armed) {
    if (tN >= tgt - 15) {                       // nozzle back up to print temp
      swapTrack.armed = true;
      if (swapTrack.swapping) { swapTrack.swapping = false; swapTrack.confirmed++; } // swap completed
    }
  } else if (tN < tgt - 60) {                   // armed nozzle craters -> tool was pulled
    swapTrack.armed = false;
    swapTrack.swapping = true;
  }
  return swapTrack;
}

// Look for a local copy of the print's bgcode (by display/short name) in configured dirs.
// PrusaLink sometimes won't serve a file over HTTP (e.g. reports size 0 / dead download ref
// right after an upload or reboot), so a local copy dropped in a watched folder is the fallback.
function findLocalBgcode(file) {
  if (!file) return null;
  const names = [file.display_name, file.name].filter(Boolean);
  for (const dir of cfg.localBgcodeDirs || []) {
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.existsSync(p)) return p; } catch {}
    }
  }
  return null;
}

function finishAnalysis(a, jobKey, cacheFile, sourceLabel) {
  a.jobKey = jobKey;
  analysis = a;
  try { fs.writeFileSync(cacheFile, JSON.stringify(a)); } catch {}
  analysisFailCount = 0;
  analysisFailedKey = null;
  console.log(`[analysis] done (${sourceLabel}): initialTool=${a.initialTool} totalSwaps=${a.totalSwaps} tools=[${a.toolsSeen}] materials=[${a.materials}]`);
}

// Ensure the print's bgcode is analyzed once per job. Order: disk cache → local file → printer.
async function ensureAnalysis(jobKey, file) {
  if (analyzing || (analysis && analysis.jobKey === jobKey)) return;
  analyzing = true;
  const cacheFile = path.join(CACHE_DIR, encodeURIComponent(jobKey) + '.json');
  try {
    // 1. Disk cache from a previous analysis of this job.
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached.version === ANALYSIS_VERSION) {
        analysis = cached;
        console.log(`[analysis] cache: ${jobKey} (totalSwaps=${cached.totalSwaps}, materials=[${cached.materials || []}])`);
        return;
      }
    }
    // 2. Local copy in a watched folder (works even when the printer won't serve the file).
    const local = findLocalBgcode(file);
    if (local) {
      console.log(`[analysis] decoding local file ${local} ...`);
      finishAnalysis(analyzeBgcode(fs.readFileSync(local)), jobKey, cacheFile, 'local');
      return;
    }
    // 3. Download from the printer — only if it actually offers the file.
    const canDownload = file && file.refs && file.refs.download && file.size !== 0;
    if (!canDownload) return; // nothing available yet; try again next poll (cheap, no network)
    if (jobKey === analysisFailedKey && Date.now() < analysisRetryAt) return; // backoff
    console.log(`[analysis] downloading bgcode ${file.refs.download} ...`);
    const r = await digestGet(cfg, file.refs.download, {}, 600000);
    if (r.status !== 200) throw new Error(`bgcode download HTTP ${r.status}`);
    console.log(`[analysis] decoding ${r.body.length} bytes ...`);
    finishAnalysis(analyzeBgcode(r.body), jobKey, cacheFile, 'printer');
  } catch (e) {
    analysisFailCount++;
    analysisFailedKey = jobKey;
    const backoff = Math.min(20000 * analysisFailCount, 180000); // 20s,40s,… cap 3min
    analysisRetryAt = Date.now() + backoff;
    console.error(`[analysis] failed: ${e.message} (retry for this job in ${backoff / 1000}s)`);
  } finally {
    analyzing = false;
  }
}

async function poll() {
  try {
    const [status, job] = await Promise.all([
      digestGetJson(cfg, '/api/v1/status'),
      digestGetJson(cfg, '/api/v1/job').catch(() => null),
    ]);

    const p = status.printer || {};
    const sjob = status.job || null;
    const printerState = p.state || 'UNKNOWN';
    const file = job && job.file ? job.file : null;
    const jobId = (sjob && sjob.id) || (job && job.id) || null;
    const fileName = file ? file.name : null;
    const jobKey = jobKeyOf(jobId, fileName);

    // Kick off (or reuse) bgcode analysis for the active job. ensureAnalysis picks the best
    // source (disk cache → local file → printer download) and no-ops if nothing is available.
    if (printerState === 'PRINTING' && file) {
      ensureAnalysis(jobKey, file); // fire-and-forget
    }
    if (printerState !== 'PRINTING' && printerState !== 'PAUSED') {
      analysis = null; // clear derived tool data when no active job
    }

    // Derived tool / swap / waste data.
    // Tool source is live progress %, with remaining time as the tiebreaker when several swaps
    // share one integer percent (see mapLive). Physical dip-counting was tried and drove the tool
    // wrong, so progress+time is authoritative again; trackSwaps is kept only for the
    // "swapping…" badge (the nozzle-temp crater reliably marks a swap in progress).
    let currentTool = null, swapsDone = null, swapsTotal = null, material = null;
    let wasteDone = null, wasteTotal = null;
    const livePct = sjob && sjob.progress != null ? sjob.progress : null;
    const liveRemMin = sjob && sjob.time_remaining != null ? sjob.time_remaining / 60 : null;
    const track = trackSwaps(jobKey, p, printerState); // for the swapping indicator only
    if (analysis && analysis.jobKey === jobKey && livePct != null) {
      const m = mapLive(analysis, livePct, liveRemMin);
      currentTool = m.currentTool;
      swapsDone = m.swapsDone;
      swapsTotal = m.swapsTotal;
      wasteDone = m.wasteDone;
      wasteTotal = m.wasteTotal;
      material = materialFor(analysis, currentTool);
    } else if (analysis && analysis.jobKey === jobKey) {
      swapsTotal = analysis.totalSwaps;
      wasteTotal = analysis.totalWasteG;
    }
    // Printer/UI labels tools starting at 1, while the G-code (and our index) is 0-based.
    const toolLabel = currentTool != null ? currentTool + 1 : null;

    // True for the whole dip→reheat window of an INDX toolchange (see trackSwaps), so the overlay
    // shows "swapping…" until the new tool is actually up to temp and in use.
    const swapping = track.swapping;

    state = {
      state: printerState,
      name: cleanName(file ? file.display_name || file.name : ''),
      thumbnailUrl: file && file.refs && file.refs.thumbnail ? '/api/thumbnail' : null,
      thumbnailKey: jobKey,
      progress: livePct,
      timeRemainingSec: sjob && sjob.time_remaining != null ? sjob.time_remaining : null,
      timeElapsedSec: sjob && sjob.time_printing != null ? sjob.time_printing : null,
      nozzleTemp: p.temp_nozzle != null ? p.temp_nozzle : null,
      nozzleTarget: p.target_nozzle != null ? p.target_nozzle : null,
      bedTemp: p.temp_bed != null ? p.temp_bed : null,
      bedTarget: p.target_bed != null ? p.target_bed : null,
      speed: p.speed != null ? p.speed : null,       // print speed override, %
      flow: p.flow != null ? p.flow : null,          // flow rate override, %
      axisZ: p.axis_z != null ? p.axis_z : null,     // current Z height, mm
      fanHotend: p.fan_hotend != null ? p.fan_hotend : null, // hotend/heatbreak fan, RPM
      fanPrint: p.fan_print != null ? p.fan_print : null,    // part-cooling fan, RPM
      currentTool,
      toolLabel,
      material,
      swapsDone,              // swaps completed so far (from progress %), index into tool sequence
      swapsTotal,
      wasteDone: wasteDone != null ? Math.round(wasteDone * 10) / 10 : null,
      wasteTotal: wasteTotal != null ? Math.round(wasteTotal * 10) / 10 : null,
      filamentG: analysis && analysis.jobKey === jobKey && analysis.totalFilamentG != null
        ? Math.round(analysis.totalFilamentG) : null,
      swapping,
      analyzing: analyzing && !(analysis && analysis.jobKey === jobKey),
      updatedAt: Math.floor(Date.now() / 1000),
    };

    // Refresh thumbnail if the job changed.
    if (file && file.refs && file.refs.thumbnail && thumbCache.key !== jobKey) {
      refreshThumb(jobKey, file.refs.thumbnail);
    }

    lastGoodAt = Math.floor(Date.now() / 1000);
    printerOnline = true;
    consecutiveFailures = 0;
    try { fs.writeFileSync(LASTSTATE_FILE, JSON.stringify({ state, lastGoodAt })); } catch {}
  } catch (e) {
    // Printer API hung/unreachable. Keep last good state; mark offline so the
    // overlay can show "reconnecting" instead of silently freezing.
    printerOnline = false;
    consecutiveFailures++;
    if (consecutiveFailures <= 3 || consecutiveFailures % 10 === 0) {
      console.error(`[poll] ${e.message} (failure #${consecutiveFailures})`);
    }
    state = { ...state, error: e.message };
  }
}

async function refreshThumb(jobKey, thumbPath) {
  try {
    const r = await digestGet(cfg, thumbPath, {}, 20000);
    if (r.status === 200) {
      thumbCache = { key: jobKey, buf: r.body, contentType: r.headers['content-type'] || 'image/png' };
    }
  } catch (e) { console.error(`[thumb] ${e.message}`); }
}

// Poll Prusa Connect for the active tool + live telemetry. Slower cadence than the local poll
// (cloud API, ~5s) since it drives display values, not the swap-crater detection.
async function connectPoll() {
  try {
    const j = await fetchPrinter(connectAuth, cfg.connectPrinterUuid);
    connectLive = mapConnectToState(j, cleanName);
    connectLastGoodAt = Math.floor(Date.now() / 1000);
    connectOnline = true;
    connectFailures = 0;
  } catch (e) {
    connectOnline = false;
    connectFailures++;
    if (connectFailures <= 3 || connectFailures % 20 === 0) {
      console.error(`[connect] ${e.message} (failure #${connectFailures})`);
    }
  }
}

async function connectPollLoop() {
  const base = cfg.connectPollMs || 5000;
  await connectPoll();
  setTimeout(connectPollLoop, connectOnline ? base : Math.min(base * connectFailures, 30000));
}

// Overlay the authoritative Connect telemetry onto the locally-built state. Connect owns the live
// values and the active tool; the local bgcode analysis still owns swap/waste TOTALS (Connect
// doesn't expose them), so swap/waste counts are recomputed from Connect's progress %.
function mergeConnect(base) {
  if (!connectEnabled || !connectLive) {
    return { out: base, online: printerOnline, lastGood: lastGoodAt };
  }
  const c = connectLive;
  const out = { ...base };
  const keys = ['state', 'progress', 'timeRemainingSec', 'timeElapsedSec', 'nozzleTemp',
    'nozzleTarget', 'bedTemp', 'bedTarget', 'axisZ', 'flow', 'speed', 'fanHotend', 'fanPrint',
    'currentTool', 'toolLabel', 'material'];
  for (const k of keys) out[k] = c[k];
  if (c.name) out.name = c.name;
  if (c.filamentG != null) out.filamentG = c.filamentG;
  // Swap/waste totals come from bgcode analysis; advance the "done" counts off Connect's progress.
  if (analysis && c.progress != null) {
    const m = mapLive(analysis, c.progress, c.timeRemainingSec != null ? c.timeRemainingSec / 60 : null);
    out.swapsDone = m.swapsDone;
    out.swapsTotal = m.swapsTotal;
    out.wasteDone = m.wasteDone != null ? Math.round(m.wasteDone * 10) / 10 : null;
    out.wasteTotal = m.wasteTotal != null ? Math.round(m.wasteTotal * 10) / 10 : null;
  }
  return { out, online: connectOnline, lastGood: connectLastGoodAt };
}

// ---- HTTP --------------------------------------------------------------------
const app = express();
app.get('/api/state', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const nowSec = Math.floor(Date.now() / 1000);
  const { out, online, lastGood } = mergeConnect(state);
  res.json({
    ...out,
    online,
    staleSec: lastGood ? nowSec - lastGood : null,
    updatedAt: nowSec,
  });
});
// Debug sink: the overlay POSTs event lines here so behavior can be observed server-side.
app.post('/api/debug', express.text({ type: '*/*', limit: '64kb' }), (req, res) => {
  try { fs.appendFileSync(path.join(CACHE_DIR, 'debug.log'), req.body + '\n'); } catch {}
  res.set('Cache-Control', 'no-store');
  res.end('ok');
});
app.get('/api/thumbnail', (_req, res) => {
  if (!thumbCache.buf) return res.status(404).end();
  res.set('Cache-Control', 'no-store');
  res.type(thumbCache.contentType).send(thumbCache.buf);
});
// No-store so OBS's browser (CEF) doesn't serve a stale overlay after edits.
const noStore = (res) => res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false, setHeaders: noStore,
}));
app.get('/', (_req, res) => { noStore(res); res.sendFile(path.join(__dirname, 'public', 'overlay.html')); });

// Self-scheduling poll loop: never overlaps requests (important when the printer
// API hangs), and backs off while it's failing so we don't pile onto a struggling board.
async function pollLoop() {
  const base = cfg.pollIntervalMs || 2000;
  await poll();
  // Back off while the printer is unreachable, but cap low so recovery (e.g. after a
  // printer reboot) is noticed within a few seconds.
  const delay = printerOnline ? base : Math.min(base * consecutiveFailures, 5000);
  setTimeout(pollLoop, delay);
}

app.listen(cfg.port, () => {
  console.log(`3d-livestream overlay: http://localhost:${cfg.port}/`);
  console.log(`state JSON:            http://localhost:${cfg.port}/api/state`);
  pollLoop();
  if (connectEnabled) {
    console.log(`prusa connect:         polling printer ${cfg.connectPrinterUuid} every ${(cfg.connectPollMs || 5000) / 1000}s`);
    connectPollLoop();
  } else {
    console.log('prusa connect:         disabled (set connectRefreshToken + connectPrinterUuid in config.json)');
  }
});
