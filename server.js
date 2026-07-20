'use strict';
const BUN_RANGE = require('./package.json').engines.bun;
if (typeof Bun === 'undefined' || !Bun.semver.satisfies(Bun.version, BUN_RANGE)) throw new Error(`Bun ${BUN_RANGE} is required`);

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { loadRuntimeConfig } = require('./config.js');
const { digestGet, digestGetJson } = require('./digest.js');
const { analyzeBgcode, mapLive, materialFor, ANALYSIS_VERSION } = require('./toolswaps.js');
const {
  ConnectAuth,
  classifyPrinterActivity,
  connectAssetsNeedRefresh,
  fetchConnectAsset,
  fetchPrinter,
  fetchPrinterJob,
  mapConnectJobAssets,
  mapConnectToState,
  normalizePrinterState,
} = require('./prusaconnect.js');
const { NetatmoAuth, fetchStation } = require('./netatmo.js');
const {
  isActiveJobState,
  jobKeysEqual,
  sameJobKey,
  selectJobId,
  shouldFinalizeJobSnapshot,
} = require('./job-lifecycle.js');
const { createLatestWork } = require('./latest-work.js');
const { CameraStream } = require('./camera-stream.js');
const { pruneAnalysisCache } = require('./cache-retention.js');
const { preferredPrintName } = require('./print-name.js');
const { sampleHealth, selectTelemetrySource } = require('./telemetry-freshness.js');
const {
  readJsonDetailed,
  readJsonWithBackup,
  quarantineJsonPair,
  sanitizeCompletedJob,
  stableJobIdentity,
  usableJobKey,
  writeFileAtomic,
  writeJsonAtomic,
} = require('./persistence.js');

const runtimeConfig = loadRuntimeConfig({ rootDir: __dirname });
const cfg = runtimeConfig.config;
const sourceCodeUrl = new URL(cfg.sourceCodeUrl).href;
const cameraStream = new CameraStream(cfg);
const CACHE_DIR = runtimeConfig.dataDir;
fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') {
  try { fs.chmodSync(CACHE_DIR, 0o700); } catch { /* Best effort for bind mounts and network filesystems. */ }
}
const ANALYSIS_CACHE_OPTIONS = Object.freeze({
  maxEntries: cfg.analysisCacheMaxEntries,
  maxBytes: cfg.analysisCacheMaxBytes,
});
const LASTSTATE_FILE = path.join(CACHE_DIR, 'laststate.json');
const CONNECT_TOKEN_FILE = path.join(CACHE_DIR, 'connect-token.json');
const NETATMO_TOKEN_FILE = path.join(CACHE_DIR, 'netatmo-token.json');
const COMPLETED_JOB_FILE = path.join(CACHE_DIR, 'completed-job.json');
const CONNECT_JOB_FILE = path.join(CACHE_DIR, 'connect-job.json');
const THUMB_META_FILE = path.join(CACHE_DIR, 'thumbnail.json');
const MAX_THUMB_BYTES = 16 * 1024 * 1024;
const LASTSTATE_WRITE_MS = Math.max(5000, Number(cfg.lastStateWriteMs) || 10000);

// Prusa Connect (cloud): authoritative source for the INDX active tool + full live telemetry.
// Inert unless a refresh token AND printer uuid are configured, so the local-only path is unaffected.
const connectAuth = new ConnectAuth(cfg, CONNECT_TOKEN_FILE);
const connectEnabled = connectAuth.hasCredentials() && !!cfg.connectPrinterUuid && cfg.useConnect !== false;
let connectLive = null;       // last mapped Connect telemetry (see mapConnectToState)
let connectLastGoodAt = 0;    // epoch sec of the last successful Connect read
let connectOnline = false;    // did the most recent Connect poll succeed?
let connectFailures = 0;      // consecutive Connect failures (for log throttling)
let connectAssets = null;     // persisted preview/raw-file descriptor for the current/last job
const connectAssetWork = createLatestWork(
  (assets, controller) => prepareConnectAssets(assets, controller),
  (error) => console.error(`[connect-assets] ${error.message}`),
);
let connectAssetFailures = 0;

// Netatmo weather station (cloud): ambient room + outdoor temperature for the overlay.
// Inert unless client id/secret and a refresh token are configured.
const netatmoAuth = new NetatmoAuth(cfg, NETATMO_TOKEN_FILE);
const netatmoEnabled = netatmoAuth.hasCredentials() && cfg.useNetatmo !== false;
let netatmoLive = null;       // last successful fetchStation result
let netatmoFailures = 0;      // consecutive failures (for log throttling)

// ---- shared state ------------------------------------------------------------
let state = { state: 'UNKNOWN' };
let analysis = null;          // { jobKey, initialTool, totalSwaps, timeline, layers, toolsSeen }
let analyzing = false;        // guards concurrent bgcode downloads
let analysisFailCount = 0;    // consecutive analysis download failures (for backoff)
let analysisFailedKey = null; // jobKey that last failed
let analysisRetryAt = 0;      // epoch ms before which we won't retry the failed job
let activeAnalysisJobKey = null;
let analysisAbortController = null;
let thumbCache = { key: null, buf: null, contentType: 'image/png', fileName: null };
let thumbFailureKey = null;
let thumbFailures = 0;
let thumbRetryAt = 0;
let lastGoodAt = 0;           // epoch sec of the last SUCCESSFUL printer read
let printerOnline = false;    // did the most recent poll succeed?
let consecutiveFailures = 0;  // for backoff when the printer API hangs
let lastJobRead = null;
let jobReadFailures = 0;
let lastStateWriteAt = 0;
let lastStateSignature = null;
let activeJobSnapshot = null;
let completedJob = null;
let completedJobDirty = false;
let restoredCompletedJob = null;

// Restore the last-known frame so a restart while the printer is down still shows
// (grayed-out) data rather than an empty card.
{
  const saved = readJsonWithBackup(LASTSTATE_FILE, null);
  if (saved && saved.state) {
    state = saved.state;
    lastGoodAt = saved.lastGoodAt || 0;
    lastStateSignature = `${state.state || ''}|${state.thumbnailKey || state.name || ''}`;
  }
  restoredCompletedJob = readJsonWithBackup(COMPLETED_JOB_FILE, null);
}

// Prune only after restoring state so the current job's analysis pair is protected.
// Retention is best-effort and must never prevent an active OBS overlay from starting.
try {
  const restoredJobKey = usableJobKey(state.jobKey) || usableJobKey(state.thumbnailKey);
  const protectedFiles = restoredJobKey
    ? [path.join(CACHE_DIR, `${encodeURIComponent(restoredJobKey)}.json`)]
    : [];
  const initialPrune = pruneAnalysisCache(CACHE_DIR, {
    ...ANALYSIS_CACHE_OPTIONS,
    protectedFiles,
  });
  if (initialPrune.removedFiles) {
    console.log(`[analysis] pruned ${initialPrune.removedFiles} old cache file(s), ${initialPrune.removedBytes} bytes`);
  }
} catch (error) {
  console.error(`[analysis] startup cache retention failed: ${error.message}`);
}

const cleanName = (displayName) => {
  if (!displayName) return '';
  return displayName
    .replace(/\.(bgcode|gcode|bgc|gco)$/i, '')
    .replace(/_\d+(\.\d+)?n_.*$/, '')   // strip slicer suffix: _0.4n_0.2mm_..._COREONEINDX_4h5m
    .replace(/\+/g, ' ')
    .trim();
};

const jobKeyOf = (jobId, fileName) => `${jobId != null ? jobId : 'x'}::${fileName || ''}`;
const round1 = (x) => (x != null ? Math.round(x * 10) / 10 : null); // grams, to 0.1

function sanitizeConnectAssets(value) {
  if (!value || typeof value !== 'object') return null;
  const jobKey = usableJobKey(value.jobKey);
  const file = value.file && typeof value.file === 'object' ? value.file : null;
  const previewPath = typeof value.previewPath === 'string' && value.previewPath.trim()
    ? value.previewPath.trim() : null;
  const rawPath = typeof value.rawPath === 'string' && value.rawPath.trim()
    ? value.rawPath.trim() : null;
  if (!jobKey || !file || (!previewPath && !rawPath)) return null;
  const size = Number(file.size);
  return {
    jobKey,
    connectJobId: value.connectJobId ?? null,
    file: {
      name: path.basename(String(file.name || '')),
      display_name: path.basename(String(file.display_name || file.name || '')),
      size: Number.isFinite(size) ? size : null,
      refs: {},
    },
    previewPath,
    rawPath,
    savedAt: Number(value.savedAt) || null,
  };
}

function persistConnectAssets(value) {
  try { writeJsonAtomic(CONNECT_JOB_FILE, value); }
  catch (error) { console.error(`[connect-assets] descriptor persistence failed: ${error.message}`); }
}

const thumbnailFileName = (jobKey) =>
  `thumbnail-${crypto.createHash('sha256').update(jobKey).digest('hex').slice(0, 16)}.bin`;

function restoreThumbnail() {
  const meta = readJsonWithBackup(THUMB_META_FILE, null);
  const jobKey = usableJobKey(meta && meta.key);
  if (!jobKey || meta.fileName !== thumbnailFileName(jobKey)) return;
  const file = path.join(CACHE_DIR, meta.fileName);
  try {
    const size = fs.statSync(file).size;
    if (size <= 0 || size > MAX_THUMB_BYTES) return;
    const contentType = /^image\/[a-z0-9.+-]+$/i.test(meta.contentType || '')
      ? meta.contentType : 'image/png';
    thumbCache = { key: jobKey, buf: fs.readFileSync(file), contentType, fileName: meta.fileName };
  } catch { /* Missing or partial cache: the next asset refresh repairs it. */ }
}

function publishThumbnail(jobKey, buf, contentType) {
  const fileName = thumbnailFileName(jobKey);
  const previousFile = thumbCache.fileName;
  thumbCache = { key: jobKey, buf, contentType, fileName };
  try {
    writeFileAtomic(path.join(CACHE_DIR, fileName), buf);
    writeJsonAtomic(THUMB_META_FILE, { key: jobKey, contentType, fileName, savedAt: Date.now() });
    if (previousFile && previousFile !== fileName && /^thumbnail-[a-f0-9]{16}\.bin$/.test(previousFile)) {
      try { fs.rmSync(path.join(CACHE_DIR, previousFile), { force: true }); } catch {}
    }
  } catch (error) {
    console.error(`[thumb] cache persistence failed: ${error.message}`);
  }
}

function connectLiveJobKey(value = connectLive) {
  return value && (value.jobId != null || value.fileName)
    ? jobKeyOf(value.jobId, value.fileName) : null;
}

function retainedConnectAssetKey(allowCompleted = true, localJobKey = null) {
  if (!connectAssets) return null;
  const liveKey = connectOnline ? connectLiveJobKey() : null;
  // Fresh live telemetry for another job always invalidates the persisted descriptor. Likewise,
  // a different local job must win while Connect is stale or briefly unavailable. A matching
  // local job, however, confirms that the persisted Connect descriptor is still current before
  // the first cloud poll completes; reserve analysis for its faster raw-file download.
  if (localJobKey && !sameJobKey(connectAssets.jobKey, localJobKey)) return null;
  if (liveKey) return sameJobKey(connectAssets.jobKey, liveKey) ? connectAssets.jobKey : null;
  if (localJobKey) return connectAssets.jobKey;
  if (allowCompleted && completedJob && sameJobKey(connectAssets.jobKey, completedJob.jobKey)) {
    return connectAssets.jobKey;
  }
  return null;
}

connectAssets = sanitizeConnectAssets(readJsonWithBackup(CONNECT_JOB_FILE, null));
restoreThumbnail();

const toolCount = cfg.toolCount;
const cleanSlotText = (value, max = 80) => {
  if (typeof value !== 'string') return null;
  const out = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return out || null;
};
const rawPrintNameOverrides = cfg.printNameOverrides && typeof cfg.printNameOverrides === 'object'
  ? cfg.printNameOverrides : {};
const printNameOverrides = new Map(Object.entries(rawPrintNameOverrides)
  .map(([key, value]) => [String(key).trim().toLocaleLowerCase(), cleanSlotText(value, 160)])
  .filter(([key, value]) => key && value));
const printNameOverrideFor = (jobKey) => jobKey
  ? printNameOverrides.get(String(jobKey).toLocaleLowerCase()) || null : null;
const toolSlots = Array.from({ length: toolCount }, (_, toolIndex) => {
  const toolLabel = toolIndex + 1;
  const raw = cfg.toolSlots[String(toolLabel)];
  const name = cleanSlotText(raw?.name);
  const color = raw?.color || null;
  const loaded = typeof raw?.loaded === 'boolean' ? raw.loaded
    : !!(name || color) || null;
  return { toolIndex, toolLabel, loaded, name, material: null, color };
});

function stateSignature(value) {
  return `${value.state || ''}|${value.thumbnailKey || cleanName(value.name) || ''}`;
}

function persistLastState(force = false) {
  const now = Date.now();
  const signature = stateSignature(state);
  if (!force && signature === lastStateSignature && now - lastStateWriteAt < LASTSTATE_WRITE_MS) return;
  try {
    writeJsonAtomic(LASTSTATE_FILE, { state, lastGoodAt });
    lastStateWriteAt = now;
    lastStateSignature = signature;
  } catch (error) {
    console.error(`[state] persistence failed: ${error.message}`);
  }
}

function completedSnapshot(snapshot, finalState) {
  const fields = ['progress', 'timeElapsedSec', 'filamentG', 'material', 'toolLabel', 'swapsDone',
    'swapsTotal', 'wasteDone', 'wasteTotal', 'currentLayer', 'totalLayers'];
  const out = {
    jobKey: usableJobKey(snapshot.jobKey) || usableJobKey(snapshot.thumbnailKey) || null,
    name: cleanName(snapshot.name || ''),
    state: finalState,
    finalState,
    completedAt: Math.floor(Date.now() / 1000),
  };
  for (const key of fields) out[key] = snapshot[key] ?? null;
  if (finalState === 'FINISHED') out.progress = 100;
  return out;
}

function jobIdentity(value) {
  return stableJobIdentity(value, cleanName);
}

completedJob = sanitizeCompletedJob(restoredCompletedJob, cleanName);
restoredCompletedJob = null;
if ((state.state === 'PRINTING' || state.state === 'PAUSED') && jobIdentity(state)) {
  activeJobSnapshot = { ...state };
}

function finishActiveSnapshot(finalState) {
  if (!activeJobSnapshot) return;
  if (!jobIdentity(activeJobSnapshot)) {
    activeJobSnapshot = null;
    return;
  }
  const nextCompleted = sanitizeCompletedJob(
    completedSnapshot(activeJobSnapshot, finalState || 'FINISHED'), cleanName);
  activeJobSnapshot = null;
  if (!nextCompleted) return;
  completedJob = nextCompleted;
  completedJobDirty = true;
  persistCompletedJob();
}

function persistCompletedJob() {
  if (!completedJobDirty || !completedJob) return;
  try {
    writeJsonAtomic(COMPLETED_JOB_FILE, completedJob);
    completedJobDirty = false;
  } catch (error) {
    console.error(`[completed-job] persistence failed: ${error.message}`);
  }
}

function analysisTotals(value) {
  const totalLayers = (value.layers || []).length || null;
  const material = materialFor(value, value.initialTool) ||
    (Array.isArray(value.materials) ? value.materials.find(Boolean) : null) || null;
  return {
    swapsTotal: value.totalSwaps ?? null,
    wasteTotal: round1(value.totalWasteG),
    totalLayers,
    filamentG: value.totalFilamentG != null ? Math.round(value.totalFilamentG) : null,
    material,
  };
}

function backfillJobAnalysis(value, jobKey) {
  const totals = analysisTotals(value);
  if (activeJobSnapshot && sameJobKey(activeJobSnapshot.jobKey || activeJobSnapshot.thumbnailKey, jobKey)) {
    for (const [key, fieldValue] of Object.entries(totals)) {
      if (fieldValue != null) activeJobSnapshot[key] = fieldValue;
    }
  }
  if (!completedJob || !sameJobKey(completedJob.jobKey, jobKey)) return;
  const before = JSON.stringify(completedJob);
  for (const [key, fieldValue] of Object.entries(totals)) {
    if (fieldValue != null) completedJob[key] = fieldValue;
  }
  if (completedJob.finalState === 'FINISHED') {
    if (totals.swapsTotal != null) completedJob.swapsDone = totals.swapsTotal;
    if (totals.wasteTotal != null) completedJob.wasteDone = totals.wasteTotal;
    if (totals.totalLayers != null) completedJob.currentLayer = totals.totalLayers;
  }
  if (JSON.stringify(completedJob) !== before) {
    completedJobDirty = true;
    persistCompletedJob();
  }
}

function observeJobLifecycle(nextState) {
  if (!nextState) return;
  persistCompletedJob();
  const active = isActiveJobState(nextState.state);
  if (active) {
    const priorId = jobIdentity(activeJobSnapshot);
    const nextId = jobIdentity(nextState);
    if (!nextId) return;
    if (activeJobSnapshot && priorId && nextId && priorId !== nextId) finishActiveSnapshot('REPLACED');
    activeJobSnapshot = { ...nextState };
  } else if (activeJobSnapshot && shouldFinalizeJobSnapshot(nextState.state)) {
    finishActiveSnapshot(nextState.state || 'FINISHED');
  }
}

// During an INDX swap the nozzle craters, then reheats. Track that window against
// the last nonzero target; the live target itself drops to zero during the swap.
let swapTrack = { jobKey: null, armed: false, swapping: false, lastTarget: 0 };

function trackSwaps(jobKey, p, printerState) {
  if (!jobKeysEqual(swapTrack.jobKey, jobKey)) {
    swapTrack = { jobKey, armed: false, swapping: false, lastTarget: 0 };
  }
  const tN = p.temp_nozzle;
  if (p.target_nozzle > 0) swapTrack.lastTarget = p.target_nozzle; // learn/keep the print temp
  const tgt = swapTrack.lastTarget;
  if (printerState !== 'PRINTING' || !(tgt > 0) || tN == null) return swapTrack;
  if (!swapTrack.armed) {
    if (tN >= tgt - 15) {                       // nozzle back up to print temp
      swapTrack.armed = true;
      if (swapTrack.swapping) swapTrack.swapping = false;
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
  const names = [file.display_name, file.name].filter(Boolean).map((name) => path.basename(String(name)));
  for (const dir of cfg.localBgcodeDirs || []) {
    const root = path.resolve(dir);
    for (const n of names) {
      const p = path.resolve(root, n);
      if ((p === root || p.startsWith(root + path.sep)) && /\.(?:bgcode|bgc)$/i.test(p) && fs.existsSync(p)) return p;
    }
  }
  return null;
}

function setActiveAnalysisJob(jobKey) {
  if (!jobKeysEqual(activeAnalysisJobKey, jobKey) && analysisAbortController) analysisAbortController.abort();
  activeAnalysisJobKey = jobKey;
}

function finishAnalysis(a, jobKey, cacheFile, sourceLabel, file) {
  a.jobKey = jobKey;
  a.jobName = cleanName(file && (file.display_name || file.name) || a.jobName || '');
  try { writeJsonAtomic(cacheFile, a); }
  catch (error) { console.error(`[analysis] cache persistence failed: ${error.message}`); }
  try {
    const pruned = pruneAnalysisCache(CACHE_DIR, {
      ...ANALYSIS_CACHE_OPTIONS,
      protectedFiles: [cacheFile],
    });
    if (pruned.removedFiles) {
      console.log(`[analysis] pruned ${pruned.removedFiles} old cache file(s), ${pruned.removedBytes} bytes`);
    }
  } catch (error) {
    console.error(`[analysis] cache retention failed: ${error.message}`);
  }
  backfillJobAnalysis(a, jobKey);
  if (!sameJobKey(activeAnalysisJobKey, jobKey)) {
    console.log(`[analysis] cached late result for inactive job ${jobKey}; publication discarded`);
    return;
  }
  analysis = a;
  analysisFailCount = 0;
  analysisFailedKey = null;
  analysisRetryAt = 0;
  console.log(`[analysis] done (${sourceLabel}): initialTool=${a.initialTool} totalSwaps=${a.totalSwaps} tools=[${a.toolsSeen}] materials=[${a.materials}]`);
}

// Ensure the print's bgcode is analyzed once per job. Order: disk cache → local file → remote.
async function ensureAnalysis(jobKey, file, remote = null, controller = null) {
  if (analyzing || (analysis && sameJobKey(analysis.jobKey, jobKey))) return;
  if (analysisFailedKey && !sameJobKey(analysisFailedKey, jobKey)) {
    analysisFailCount = 0;
    analysisFailedKey = null;
    analysisRetryAt = 0;
  }
  if (sameJobKey(jobKey, analysisFailedKey) && Date.now() < analysisRetryAt) return;
  controller = controller || new AbortController();
  if (controller.signal.aborted) return;
  analyzing = true;
  analysisAbortController = controller;
  const cacheFile = path.join(CACHE_DIR, encodeURIComponent(jobKey) + '.json');
  try {
    // 1. Disk cache from a previous analysis of this job.
    const cacheRead = readJsonDetailed(cacheFile);
    if (cacheRead.source) {
      const cached = cacheRead.value;
      if (cached.version === ANALYSIS_VERSION) {
        cached.jobName = cleanName(cached.jobName || file && (file.display_name || file.name) || '');
        if (cacheRead.recovered) {
          try { writeJsonAtomic(cacheFile, cached); }
          catch (error) { console.error(`[analysis] cache recovery persistence failed: ${error.message}`); }
        }
        backfillJobAnalysis(cached, jobKey);
        if (sameJobKey(activeAnalysisJobKey, jobKey)) analysis = cached;
        console.log(`[analysis] cache: ${jobKey} (totalSwaps=${cached.totalSwaps}, materials=[${cached.materials || []}])`);
        return;
      }
    } else if (fs.existsSync(cacheFile) || fs.existsSync(`${cacheFile}.bak`)) {
      const moved = quarantineJsonPair(cacheFile);
      console.error(`[analysis] quarantined corrupt cache for ${jobKey}${moved.length ? ` (${moved.length} file(s))` : ''}`);
    }
    // 2. Local copy in a watched folder (works even when the printer won't serve the file).
    const local = findLocalBgcode(file);
    if (local) {
      console.log(`[analysis] decoding local file ${local} ...`);
      finishAnalysis(analyzeBgcode(fs.readFileSync(local)), jobKey, cacheFile, 'local', file);
      return;
    }
    // 3. Download from Connect when this job came from the cloud descriptor.
    if (remote && typeof remote.fetch === 'function') {
      console.log(`[analysis] downloading bgcode from ${remote.label || 'remote'} ...`);
      const r = await remote.fetch(controller.signal);
      if (r.status !== 200) throw new Error(`bgcode download HTTP ${r.status}`);
      console.log(`[analysis] decoding ${r.body.length} bytes ...`);
      finishAnalysis(analyzeBgcode(r.body), jobKey, cacheFile, remote.label || 'remote', file);
      return;
    }
    // 4. Download from the printer, only if it actually offers the file.
    const canDownload = file && file.refs && file.refs.download && file.size !== 0;
    if (!canDownload) return; // nothing available yet; try again next poll (cheap, no network)
    console.log(`[analysis] downloading bgcode ${file.refs.download} ...`);
    const r = await digestGet(cfg, file.refs.download, {}, 600000, { signal: controller.signal });
    if (r.status !== 200) throw new Error(`bgcode download HTTP ${r.status}`);
    console.log(`[analysis] decoding ${r.body.length} bytes ...`);
    finishAnalysis(analyzeBgcode(r.body), jobKey, cacheFile, 'printer', file);
  } catch (e) {
    if (controller.signal.aborted || e.code === 'ABORT_ERR') return;
    analysisFailCount++;
    analysisFailedKey = jobKey;
    const backoff = Math.min(20000 * analysisFailCount, 180000); // 20s,40s,… cap 3min
    analysisRetryAt = Date.now() + backoff;
    console.error(`[analysis] failed: ${e.message} (retry for this job in ${backoff / 1000}s)`);
  } finally {
    analyzing = false;
    if (analysisAbortController === controller) analysisAbortController = null;
  }
}

async function poll() {
  try {
    const [status, jobResult] = await Promise.all([
      digestGetJson(cfg, '/api/v1/status'),
      digestGetJson(cfg, '/api/v1/job', 8000, { allowNoContent: true })
        .then((value) => ({ value, error: null }))
        .catch((error) => ({ value: null, error })),
    ]);

    const p = status.printer || {};
    const sjob = status.job || null;
    const rawPrinterState = p.state || 'UNKNOWN';
    const statusJobId = sjob && sjob.id != null ? sjob.id : null;
    let job = jobResult.value;
    if (job) {
      lastJobRead = { value: job, jobId: job.id != null ? job.id : statusJobId };
      jobReadFailures = 0;
    } else if (!jobResult.error) {
      jobReadFailures = 0;
    } else if (jobResult.error) {
      jobReadFailures++;
      if (jobReadFailures <= 3 || jobReadFailures % 10 === 0) {
        console.error(`[job] ${jobResult.error.message} (failure #${jobReadFailures}; using matching cached job data when available)`);
      }
      const rawActive = rawPrinterState === 'PRINTING' || rawPrinterState === 'PAUSED';
      const statusMayHaveJob = rawActive || statusJobId != null;
      const cachedMatches = statusMayHaveJob && lastJobRead &&
        (statusJobId == null || lastJobRead.jobId == null || String(lastJobRead.jobId) === String(statusJobId));
      job = cachedMatches ? lastJobRead.value : null;
    }
    const file = job && job.file ? job.file : null;
    const printerState = normalizePrinterState(rawPrinterState, p, status, sjob, job);
    const printerActivity = classifyPrinterActivity(rawPrinterState, p, status, sjob, job);
    const jobId = selectJobId(sjob, job);
    const fileName = file ? file.name : null;
    const jobKey = jobKeyOf(jobId, fileName);
    const currentJobName = cleanName(file ? file.display_name || file.name : '');

    // Kick off (or reuse) bgcode analysis for the active job. ensureAnalysis picks the best
    // source (disk cache → local file → printer download) and no-ops if nothing is available.
    const activePrint = printerState === 'PRINTING' || printerState === 'PAUSED';
    const localIdentityKey = usableJobKey(jobKey);
    const connectAssetKey = retainedConnectAssetKey(!activePrint, localIdentityKey);
    setActiveAnalysisJob(connectAssetKey || (activePrint ? jobKey : null));
    if (!connectAssetKey && printerState === 'PRINTING' && file && !thumbFetching) {
      ensureAnalysis(jobKey, file); // fire-and-forget
    }
    if (!activePrint && !connectAssetKey) {
      analysis = null; // clear derived tool data when no active job
    }

    // Derived tool / swap / waste data.
    // Tool source is live progress %, with remaining time as the tiebreaker when several swaps
    // share one integer percent (see mapLive). Physical dip-counting was tried and drove the tool
    // wrong, so progress+time is authoritative again; trackSwaps is kept only for the
    // swap-in-progress indicator (the nozzle-temp crater reliably marks a swap in progress).
    let currentTool = null, swapsDone = null, swapsTotal = null, material = null;
    let wasteDone = null, wasteTotal = null;
    let nextTool = null, nextSwapInSec = null, currentLayer = null, totalLayers = null;
    const livePct = sjob?.progress ?? null;
    const liveRemMin = sjob?.time_remaining != null ? sjob.time_remaining / 60 : null;
    // The job key, unlike its display name, remains stable when Prusa reports a
    // generic label such as "Merged". It is the authoritative cache identity.
    const haveAnalysis = analysis && sameJobKey(analysis.jobKey, jobKey);
    const track = trackSwaps(jobKey, p, printerState); // for the swapping indicator only
    if (haveAnalysis && livePct != null) {
      const m = mapLive(analysis, livePct, liveRemMin);
      currentTool = m.currentTool;
      swapsDone = m.swapsDone;
      swapsTotal = m.swapsTotal;
      wasteDone = m.wasteDone;
      wasteTotal = m.wasteTotal;
      material = materialFor(analysis, currentTool);
      nextTool = m.nextTool;
      nextSwapInSec = m.nextSwapRemMin != null ? Math.round(m.nextSwapRemMin * 60) : null;
      currentLayer = m.currentLayer;
      totalLayers = m.totalLayers;
    } else if (haveAnalysis) {
      swapsTotal = analysis.totalSwaps;
      wasteTotal = analysis.totalWasteG;
      totalLayers = (analysis.layers || []).length || null;
    }
    // Printer/UI labels tools starting at 1, while the G-code (and our index) is 0-based.
    const toolLabel = currentTool != null ? currentTool + 1 : null;

    state = {
      state: printerState,
      activity: printerActivity,
      name: preferredPrintName(
        currentJobName,
        haveAnalysis ? analysis.modelName : null,
        printNameOverrideFor(jobKey),
      ),
      // Advertise the thumbnail only once the cached buffer is actually for THIS job;
      // refreshThumb is async (and can fail for a while right after an upload), so without
      // this gate the overlay would load the previous print's image and keep it all job.
      thumbnailUrl: file && file.refs && file.refs.thumbnail && sameJobKey(thumbCache.key, jobKey) ? '/api/thumbnail' : null,
      thumbnailKey: jobKey,
      progress: livePct,
      timeRemainingSec: sjob?.time_remaining ?? null,
      timeElapsedSec: sjob?.time_printing ?? null,
      nozzleTemp: p.temp_nozzle ?? null,
      nozzleTarget: p.target_nozzle ?? null,
      bedTemp: p.temp_bed ?? null,
      bedTarget: p.target_bed ?? null,
      speed: p.speed ?? null,         // print speed override, %
      flow: p.flow ?? null,           // flow rate override, %
      axisZ: p.axis_z ?? null,        // current Z height, mm
      fanHotend: p.fan_hotend ?? null, // hotend/heatbreak fan, RPM
      fanPrint: p.fan_print ?? null,   // part-cooling fan, RPM
      currentTool,
      toolLabel,
      material,
      // Upcoming toolchange (1-based label like toolLabel) and seconds until it, from the
      // M73 remaining-time recorded at that swap in the gcode timeline.
      nextToolLabel: nextTool != null ? nextTool + 1 : null,
      nextSwapInSec,
      currentLayer,           // 1-based (0 while below layer 1), from the layer timeline on progress %
      totalLayers,
      swapsDone,              // swaps completed so far (from progress %), index into tool sequence
      swapsTotal,
      wasteDone: round1(wasteDone),
      wasteTotal: round1(wasteTotal),
      filamentG: haveAnalysis && analysis.totalFilamentG != null ? Math.round(analysis.totalFilamentG) : null,
      // True for the whole dip->reheat window of an INDX toolchange (see trackSwaps), so the
      // overlay's dock panel keeps pulsing until the new tool is actually up to temp and in use.
      swapping: track.swapping,
      analyzing: analyzing && !haveAnalysis,
    };

    // Refresh thumbnail if the job changed.
    if (file && file.refs && file.refs.thumbnail && !sameJobKey(thumbCache.key, jobKey) && !analyzing &&
        (!sameJobKey(thumbFailureKey, jobKey) || Date.now() >= thumbRetryAt)) {
      refreshThumb(jobKey, file.refs.thumbnail);
    }

    lastGoodAt = Math.floor(Date.now() / 1000);
    printerOnline = true;
    consecutiveFailures = 0;
    observeJobLifecycle(mergeConnect(state).out);
    persistLastState();
    scheduleConnectAssets();
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

let thumbFetching = false; // poll retries every cycle until the key matches; don't stack downloads
function recordThumbFailure(jobKey, message) {
  if (!sameJobKey(thumbFailureKey, jobKey)) thumbFailures = 0;
  thumbFailureKey = jobKey;
  thumbFailures++;
  const backoff = Math.min(5000 * (2 ** Math.min(thumbFailures - 1, 4)), 60000);
  thumbRetryAt = Date.now() + backoff;
  if (thumbFailures <= 3 || thumbFailures % 10 === 0) {
    console.error(`[thumb] ${message} (failure #${thumbFailures}; retry in ${backoff / 1000}s)`);
  }
}

async function refreshThumb(jobKey, source, options = {}) {
  if (options.signal?.aborted || thumbFetching || (!options.allowDuringAnalysis && analyzing) ||
      (sameJobKey(thumbFailureKey, jobKey) && Date.now() < thumbRetryAt)) return;
  thumbFetching = true;
  try {
    const r = typeof source === 'function'
      ? await source()
      : await digestGet(cfg, source, {}, 20000, { maxBodyBytes: MAX_THUMB_BYTES });
    if (options.signal?.aborted) return;
    if (r.status === 200) {
      const rawContentType = String(r.headers['content-type'] || '').split(';')[0].trim();
      if (options.requireImage && !/^image\/[a-z0-9.+-]+$/i.test(rawContentType)) {
        throw new Error(`unexpected preview content type ${rawContentType || 'missing'}`);
      }
      if (!Buffer.isBuffer(r.body) || r.body.length <= 0 || r.body.length > MAX_THUMB_BYTES) {
        throw new Error('invalid preview response body');
      }
      if (sameJobKey(activeAnalysisJobKey, jobKey) ||
          (completedJob && sameJobKey(completedJob.jobKey, jobKey))) {
        const contentType = /^image\/[a-z0-9.+-]+$/i.test(rawContentType)
          ? rawContentType : 'image/png';
        publishThumbnail(jobKey, r.body, contentType);
      }
      thumbFailureKey = null;
      thumbFailures = 0;
      thumbRetryAt = 0;
    } else {
      recordThumbFailure(jobKey, `HTTP ${r.status}`);
    }
  } catch (e) {
    if (!options.signal?.aborted && e.code !== 'ABORT_ERR') recordThumbFailure(jobKey, e.message);
  }
  finally { thumbFetching = false; }
}

async function prepareConnectAssets(assets, controller) {
  const jobKey = assets.jobKey;
  const { signal } = controller;
  if (signal.aborted) return;
  if (assets.previewPath && !sameJobKey(thumbCache.key, jobKey)) {
    await refreshThumb(jobKey, () => fetchConnectAsset(connectAuth, assets.previewPath, {
      accept: 'image/avif,image/webp,image/png,image/*',
      maxResponseBytes: MAX_THUMB_BYTES,
      signal,
      timeoutMs: 30000,
    }), { allowDuringAnalysis: true, requireImage: true, signal });
  }
  if (signal.aborted) return;
  const remote = assets.rawPath ? {
    label: 'connect',
    fetch: (signal) => fetchConnectAsset(connectAuth, assets.rawPath, {
      accept: 'application/gcode+binary,application/octet-stream,*/*',
      maxResponseBytes: Math.max(1024, Number(cfg.maxPrinterResponseBytes) || 512 * 1024 * 1024),
      signal,
      timeoutMs: 600000,
    }),
  } : null;
  await ensureAnalysis(jobKey, assets.file, remote, controller);
}

function scheduleConnectAssets() {
  if (!connectEnabled) {
    connectAssetWork.cancel();
    return;
  }
  const assets = connectAssets;
  const localJobKey = isActiveJobState(state.state)
    ? usableJobKey(state.jobKey) || usableJobKey(state.thumbnailKey) : null;
  const retainedKey = retainedConnectAssetKey(!localJobKey, localJobKey);
  if (!assets || !sameJobKey(assets.jobKey, retainedKey)) {
    connectAssetWork.cancel();
    return;
  }
  setActiveAnalysisJob(assets.jobKey);
  connectAssetWork.schedule(assets);
}

// Poll Prusa Connect for the active tool + live telemetry. Slower cadence than the local poll
// (cloud API, ~5s) since it drives display values, not the swap-crater detection.
async function connectPoll() {
  try {
    const wasOnline = connectOnline;
    const j = await fetchPrinter(connectAuth, cfg.connectPrinterUuid);
    const mapped = mapConnectToState(j, cleanName);
    connectLive = mapped;
    connectLastGoodAt = Math.floor(Date.now() / 1000);
    connectOnline = true;
    connectFailures = 0;
    if (!wasOnline) console.log('[connect] telemetry poll succeeded');
    const jobKey = connectLiveJobKey(mapped);
    if (mapped.connectJobId != null && jobKey) {
      if (connectAssetsNeedRefresh(connectAssets, jobKey, mapped.connectJobId)) {
        try {
          const detail = await fetchPrinterJob(connectAuth, cfg.connectPrinterUuid, mapped.connectJobId);
          const next = sanitizeConnectAssets({
            ...mapConnectJobAssets(detail, {
              connectJobId: mapped.connectJobId,
              displayName: j.job_info && j.job_info.display_name,
              fileName: mapped.fileName,
              previewUrl: mapped.previewUrl,
              teamId: j.team_id,
            }),
            jobKey,
            savedAt: Date.now(),
          });
          if (next) {
            connectAssets = next;
            persistConnectAssets(next);
          }
          connectAssetFailures = 0;
        } catch (error) {
          connectAssetFailures++;
          if (connectAssetFailures <= 3 || connectAssetFailures % 20 === 0) {
            console.error(`[connect-assets] job detail: ${error.message} (failure #${connectAssetFailures})`);
          }
        }
      }
    }
    scheduleConnectAssets();
    observeJobLifecycle(mergeConnect(state).out);
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

// Poll the Netatmo station. Slow cadence: the station only measures every ~10 minutes,
// and Netatmo rate-limits per app, so 5 minutes is already more than enough.
async function netatmoPollLoop() {
  const base = cfg.netatmoPollMs || 300000;
  try {
    netatmoLive = await fetchStation(netatmoAuth);
    netatmoFailures = 0;
  } catch (e) {
    netatmoFailures++;
    if (netatmoFailures <= 3 || netatmoFailures % 12 === 0) {
      console.error(`[netatmo] ${e.message} (failure #${netatmoFailures})`);
    }
  }
  setTimeout(netatmoPollLoop, netatmoFailures ? Math.min(base * netatmoFailures, 1800000) : base);
}

// Overlay the authoritative Connect telemetry onto the locally-built state. Connect owns the live
// values and the active tool; the local bgcode analysis still owns swap/waste TOTALS (Connect
// doesn't expose them), so swap/waste counts are recomputed from Connect's progress %.
function mergeConnect(base, nowSec = Math.floor(Date.now() / 1000)) {
  const localHealth = sampleHealth(lastGoodAt, printerOnline, nowSec);
  const connectHealth = sampleHealth(connectLastGoodAt, connectOnline, nowSec);
  const source = selectTelemetrySource(localHealth, connectHealth, connectEnabled && !!connectLive);
  if (source === 'local') {
    return { out: base, ...localHealth, source };
  }

  const c = connectLive;
  const out = { ...base };
  const keys = ['timeRemainingSec', 'timeElapsedSec', 'nozzleTemp',
    'nozzleTarget', 'bedTemp', 'bedTarget', 'axisZ', 'flow', 'speed', 'fanHotend', 'fanPrint',
    'material', 'chamberTemp', 'chamberTarget'];
  for (const k of keys) if (c[k] != null) out[k] = c[k];
  // These fields are meaningful when null (for example an idle printer has no progress/tool).
  out.state = c.state;
  out.progress = c.progress;
  out.currentTool = c.currentTool;
  out.toolLabel = c.toolLabel;
  out.activity = c.activity || (c.state === base.state ? base.activity || null : null);
  const connectJobKey = c.jobId != null || c.fileName ? jobKeyOf(c.jobId, c.fileName) : null;
  if (connectJobKey) {
    out.jobKey = connectJobKey;
    out.thumbnailKey = connectJobKey;
    out.thumbnailUrl = sameJobKey(thumbCache.key, connectJobKey) ? '/api/thumbnail' : null;
  }
  if (c.filamentG != null) out.filamentG = c.filamentG;
  // A generic display name is not an identity. Carry analysis only when its stable key
  // matches the Connect job (or the local job when Connect has no job identity).
  const baseJobKey = base.jobKey || base.thumbnailKey;
  const analysisJobKey = connectJobKey || baseJobKey;
  const analysisMatches = !!(analysis && sameJobKey(analysis.jobKey, analysisJobKey));
  out.name = preferredPrintName(
    c.name || base.name,
    analysisMatches ? analysis.modelName : null,
    printNameOverrideFor(connectJobKey || baseJobKey),
  );
  if (analysisMatches) {
    const totals = analysisTotals(analysis);
    out.swapsTotal = totals.swapsTotal;
    out.wasteTotal = totals.wasteTotal;
    out.totalLayers = totals.totalLayers;
    if (out.filamentG == null && totals.filamentG != null) out.filamentG = totals.filamentG;
    if (c.progress != null) {
      const m = mapLive(analysis, c.progress, c.timeRemainingSec != null ? c.timeRemainingSec / 60 : null);
      out.swapsDone = m.swapsDone;
      out.wasteDone = round1(m.wasteDone);
      out.nextToolLabel = m.nextTool != null ? m.nextTool + 1 : null;
      out.nextSwapInSec = m.nextSwapRemMin != null ? Math.round(m.nextSwapRemMin * 60) : null;
      out.currentLayer = m.currentLayer;
    } else {
      const finished = c.state === 'FINISHED';
      out.swapsDone = finished ? totals.swapsTotal : null;
      out.wasteDone = finished ? totals.wasteTotal : null;
      out.currentLayer = finished ? totals.totalLayers : null;
      out.nextToolLabel = null;
      out.nextSwapInSec = null;
    }
  } else {
    for (const key of ['swapsDone', 'swapsTotal', 'wasteDone', 'wasteTotal', 'nextToolLabel',
      'nextSwapInSec', 'currentLayer', 'totalLayers']) out[key] = null;
  }
  return { out, ...connectHealth, source };
}

function exposeCompletedThumbnail(value) {
  if (!completedJob || !['IDLE', 'FINISHED'].includes(value.state) ||
      !sameJobKey(completedJob.jobKey, thumbCache.key)) return value;
  return { ...value, thumbnailKey: completedJob.jobKey, thumbnailUrl: '/api/thumbnail' };
}

// ---- HTTP --------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Link: `<${sourceCodeUrl}>; rel="source"`,
  });
  next();
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// AGPL section 13 source offer. Operators running modified builds should set
// sourceCodeUrl / SOURCE_CODE_URL to the exact corresponding source they deploy.
app.get('/source', (_req, res) => {
  res.redirect(302, sourceCodeUrl);
});

app.get('/api/state', (_req, res) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const merged = mergeConnect(state);
  const out = exposeCompletedThumbnail(merged.out);
  const { online, staleSec } = merged;
  res.json({
    ...out,
    online,
    staleSec,
    updatedAt: nowSec,
    completedJob,
    toolCount,
    toolSlots,
    camera: cameraStream.getStatus(),
    // Ambient room/outdoor readings from the Netatmo station (null when not configured).
    roomTemp: netatmoLive ? netatmoLive.roomTemp : null,
    roomHumidity: netatmoLive ? netatmoLive.roomHumidity : null,
    outdoorTemp: netatmoLive ? netatmoLive.outdoorTemp : null,
  });
});
// One shared ffmpeg reader fans the printer's RTSP camera out to every browser.
// The RTSP URL stays server-side; the relay starts lazily with its first subscriber.
app.get('/api/camera/status', (_req, res) => {
  res.json(cameraStream.getStatus());
});
app.get('/api/camera.mjpeg', (req, res) => cameraStream.handleMjpeg(req, res));
app.get('/api/camera.jpg', (req, res) => cameraStream.handleSnapshot(req, res));
// Per-job map for the overlay's progress-bar swap ticks: every toolchange's progress
// position, fetched once per job (keyed by jobKey == thumbnailKey) instead of per poll.
app.get('/api/jobmap', (_req, res) => {
  if (!analysis) return res.json({ jobKey: null, swapPcts: [], totalLayers: null });
  res.json({
    jobKey: analysis.jobKey,
    swapPcts: analysis.timeline.map((e) => e.progressPct),
    totalLayers: (analysis.layers || []).length || null,
  });
});
app.get('/api/thumbnail', (req, res) => {
  // ?j=<jobKey> must match the cached buffer, else a fresh job would get the old print's image.
  if (!thumbCache.buf || (req.query.j && !sameJobKey(req.query.j, thumbCache.key))) return res.status(404).end();
  res.type(thumbCache.contentType).send(thumbCache.buf);
});
// No-store so OBS's browser (CEF) doesn't serve a stale overlay after edits.
const noStore = (res) => res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false, setHeaders: noStore,
}));
app.get('/overlay', (_req, res) => {
  noStore(res);
  res.redirect(302, '/?camera=0');
});
app.get('/', (_req, res) => { noStore(res); res.sendFile(path.join(__dirname, 'public', 'overlay.html')); });

// Keep all API failures JSON-only; never expose Express's HTML stack/path response.
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`[http] ${err && err.message ? err.message : 'unknown error'}`);
  return res.status(500).json({ error: 'internal server error' });
});

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

const listenPort = Number.isInteger(Number(cfg.port)) && Number(cfg.port) > 0 ? Number(cfg.port) : 8787;
const listenHost = cleanSlotText(cfg.listenHost, 255) || '127.0.0.1';
const httpServer = app.listen(listenPort, listenHost, () => {
  console.log(`LayerRelay dashboard: http://${listenHost}:${listenPort}/`);
  console.log(`state JSON:            http://${listenHost}:${listenPort}/api/state`);
  console.log(`camera relay:          ${cameraStream.enabled ? `http://${listenHost}:${listenPort}/api/camera.mjpeg` : 'disabled (set cameraRtspUrl in config.json)'}`);
  console.log(`corresponding source:  ${sourceCodeUrl}`);
  console.log(`configuration:         ${runtimeConfig.source}; state: ${CACHE_DIR}`);
  pollLoop();
  if (connectEnabled) {
    console.log(`prusa connect:         polling configured printer every ${(cfg.connectPollMs || 5000) / 1000}s`);
    connectPollLoop();
  } else {
    console.log('prusa connect:         disabled (set connectRefreshToken + connectPrinterUuid in config.json)');
  }
  if (netatmoEnabled) {
    console.log(`netatmo:               polling station every ${(cfg.netatmoPollMs || 300000) / 1000}s`);
    netatmoPollLoop();
  } else {
    console.log('netatmo:               disabled (set netatmoClientId/Secret/RefreshToken in config.json)');
  }
});

let stopping = false;
function stopServer() {
  if (stopping) return;
  stopping = true;
  cameraStream.close();
  httpServer.close(() => process.exit(0));
  const forceExit = setTimeout(() => process.exit(1), 5000);
  if (typeof forceExit.unref === 'function') forceExit.unref();
}
process.once('SIGINT', stopServer);
process.once('SIGTERM', stopServer);
process.once('exit', () => cameraStream.close());
