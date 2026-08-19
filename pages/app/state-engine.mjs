/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Virtual /api/* server for the static dashboard build. Serves the exact
 * response shapes of server.js (state, jobmap, thumbnail, settings,
 * filaments) from an in-browser replay of a decoded G-code file, or
 * forwards to a user-provided LayerRelay bridge in live mode.
 */
// Browser ESM. The only I/O is through the injected fetch implementation
// (demo asset load and live-mode forwarding) and localStorage via the
// injected stores; everything else is computed locally.
import { analyzeBgcode } from './toolswaps.mjs';
import { extractThumbnails, isBgcode } from './bgcode.mjs';
import { decodeQoi } from './qoi.mjs';
import { preferredPrintName } from './print-name.mjs';
import { createReplay } from './replay.mjs';
import {
  createBrowserToolSettingsStore,
  normalizeDetectedToolSettings,
  resolveToolSettings,
} from './tool-settings.mjs';
import { createFilamentIndex } from './openprinttag.mjs';

const DISABLED_STREAM_STATUS = Object.freeze({
  enabled: false,
  running: false,
  online: false,
  state: 'disabled',
  subscribers: 0,
  lastFrameAt: null,
  lastFrameAgeMs: null,
  frames: 0,
  targetFps: 0,
  measuredFps: null,
  outputWidth: 0,
  jpegQuality: 0,
  threads: 0,
  latestFrameBytes: null,
  outputBytesPerSec: null,
  estimatedEgressBytesPerSec: null,
  restartAttempts: 0,
  restartInMs: null,
  error: null,
});

function abortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function headerGet(init, name) {
  const headers = init && init.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

function parseApiUrl(url) {
  const q = url.indexOf('?');
  return {
    pathname: q < 0 ? url : url.slice(0, q),
    params: new URLSearchParams(q < 0 ? '' : url.slice(q + 1)),
  };
}

// A bridge must be a bare http(s) origin: no path, query, fragment, or
// credentials, so the engine can safely append /api paths to it.
export function normalizeBridgeOrigin(value) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw new TypeError('bridge URL must be an absolute http(s) URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('bridge URL must use http or https');
  }
  if (url.username || url.password) {
    throw new TypeError('bridge URL must not contain credentials');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new TypeError('bridge URL must be a bare origin without path or query');
  }
  return url.origin;
}

function basename(value) {
  const clean = String(value || '').split(/[?#]/)[0];
  const parts = clean.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'demo.bgcode';
}

function stripExtension(value) {
  return String(value || '').replace(/\.(?:bgcode|bgc|gcode)$/i, '');
}

// Detected tool inventory synthesized from the decoded file: every tool the
// G-code selects counts as loaded. Slot indexes are 0-based like toolsSeen.
function detectedFromAnalysis(analysis) {
  if (!analysis) return {};
  const seen = Array.isArray(analysis.toolsSeen) ? analysis.toolsSeen : [];
  const maxTool = seen.length ? Math.max(...seen) : 0;
  const toolCount = Math.max(1, maxTool + 1);
  const seenSet = new Set(seen);
  const materials = Array.isArray(analysis.materials) ? analysis.materials : [];
  const toolSlots = Array.from({ length: toolCount }, (_, toolIndex) => {
    const slot = {
      toolIndex,
      toolLabel: toolIndex + 1,
      name: null,
      material: materials[toolIndex] ?? null,
      color: null,
    };
    if (seenSet.has(toolIndex)) slot.loaded = true;
    return slot;
  });
  return { source: null, status: 'fresh', toolCount, toolSlots };
}

async function qoiThumbnailToPng(thumbnail) {
  const { width, height, rgba } = decodeQoi(thumbnail.data);
  const pixels = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  let blob = null;
  if (typeof OffscreenCanvas === 'function' && typeof ImageData === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.putImageData(new ImageData(pixels, width, height), 0, 0);
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } else if (typeof document !== 'undefined' && typeof ImageData === 'function' &&
      typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), contentType: 'image/png' };
}

async function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) return null;
  const area = (t) => (t.width || 0) * (t.height || 0);
  const raster = thumbnails
    .filter((t) => t.format === 'png' || t.format === 'jpg')
    .sort((a, b) => area(b) - area(a))[0];
  if (raster) {
    return {
      bytes: raster.data,
      contentType: raster.format === 'png' ? 'image/png' : 'image/jpeg',
    };
  }
  const qoi = thumbnails.filter((t) => t.format === 'qoi').sort((a, b) => area(b) - area(a))[0];
  if (!qoi) return null;
  try { return await qoiThumbnailToPng(qoi); }
  catch { return null; }
}

export function createEngine(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const fetchImpl = options.fetchImpl ||
    (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const analyzeImpl = options.analyzeImpl || analyzeBgcode;
  const extractThumbnailsImpl = options.extractThumbnailsImpl ||
    (async (u8) => (isBgcode(u8) ? extractThumbnails(u8) : []));
  const toolStore = options.toolStore ||
    createBrowserToolSettingsStore(undefined, options.storage);
  let filamentIndex = options.filamentIndex || null;

  let mode = 'demo';
  let bridge = null;
  let analysis = null;
  let replay = null;
  let detected = {};
  let fileName = null;
  let printName = '';
  let thumbnail = null; // { bytes, contentType }
  let thumbnailObjectUrl = null;
  let analyzing = false;
  let lastError = null;
  let completedJob = null;
  let timelapseIntervalSec = 10;
  let loadSeq = 0;

  // Replay clock: playedSec advances from the injected wall clock only while
  // playing, scaled by the speed multiplier. Deterministic under a fake now().
  let playing = false;
  let speed = 60;
  let playedBase = 0;
  let wallBase = 0;

  const listeners = new Set();
  function emit() {
    const status = getStatus();
    for (const listener of listeners) {
      try { listener(status); } catch { /* listener errors stay local */ }
    }
  }

  function playedSecNow() {
    if (!playing) return playedBase;
    return playedBase + Math.max(0, now() - wallBase) / 1000 * speed;
  }

  function freezeClock() {
    playedBase = playedSecNow();
    wallBase = now();
  }

  function thumbnailKey() {
    // The load serial keeps the key unique per decoded file. Without it, a
    // second drop of a re-sliced file with the same name would leave the
    // overlay showing the previous thumbnail and swap ticks, because it
    // reloads both only when the key changes.
    return fileName ? `static::${loadSeq}::${fileName}` : 'x::';
  }

  function setApiBase(value) {
    if (typeof window !== 'undefined') window.__LR_API_BASE = value;
  }

  function releaseThumbnailUrl() {
    if (thumbnailObjectUrl && typeof URL !== 'undefined' &&
        typeof URL.revokeObjectURL === 'function') {
      try { URL.revokeObjectURL(thumbnailObjectUrl.slice(0, -1)); } catch { /* ignore */ }
    }
    thumbnailObjectUrl = null;
  }

  function adoptThumbnail(next) {
    releaseThumbnailUrl();
    thumbnail = next;
    if (next && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' &&
        typeof Blob === 'function') {
      try {
        // Trailing '#': the overlay appends '?j=<key>' to thumbnailUrl, and a
        // query string breaks blob URL resolution while a fragment is ignored.
        thumbnailObjectUrl = URL.createObjectURL(
          new Blob([next.bytes], { type: next.contentType })) + '#';
      } catch {
        thumbnailObjectUrl = null;
      }
    }
  }

  async function applyBytes(u8, name, token) {
    analyzing = true;
    lastError = null;
    emit();
    try {
      const nextAnalysis = await analyzeImpl(u8);
      let nextThumbnail = null;
      try { nextThumbnail = await pickThumbnail(await extractThumbnailsImpl(u8)); }
      catch { nextThumbnail = null; }
      if (token !== loadSeq) return;
      analysis = nextAnalysis;
      detected = detectedFromAnalysis(nextAnalysis);
      fileName = name;
      // The demo asset's fixed file stem carries no information; its embedded
      // model name is the only meaningful title. User files keep server
      // semantics: the file name wins unless it is a generic slicer label.
      printName = (mode === 'demo' && nextAnalysis.modelName) ||
        preferredPrintName(stripExtension(name), nextAnalysis.modelName, null) ||
        stripExtension(name);
      adoptThumbnail(nextThumbnail);
      replay = createReplay({ analysis: nextAnalysis, name: printName });
      completedJob = null;
      playedBase = 0;
      wallBase = now();
      playing = true;
      analyzing = false;
      emit();
    } catch (error) {
      if (token !== loadSeq) return;
      analyzing = false;
      lastError = String((error && error.message) || error);
      emit();
      throw error;
    }
  }

  async function loadFile(u8, name) {
    mode = 'file';
    setApiBase('');
    const token = ++loadSeq;
    await applyBytes(u8, String(name || 'print.bgcode'), token);
  }

  async function setModeDemo(demoFileUrl) {
    mode = 'demo';
    setApiBase('');
    const token = ++loadSeq;
    analyzing = true;
    lastError = null;
    emit();
    try {
      if (!fetchImpl) throw new Error('fetch is unavailable');
      const response = await fetchImpl(demoFileUrl, { cache: 'no-store' });
      if (!response || !response.ok) {
        throw new Error(`demo asset fetch failed (${response && response.status})`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (token !== loadSeq) return;
      await applyBytes(bytes, basename(demoFileUrl), token);
    } catch (error) {
      if (token !== loadSeq) return;
      analyzing = false;
      lastError = String((error && error.message) || error);
      emit();
      // Rethrow like loadFile does: callers drive their own error state from
      // the rejection, and a resolved promise would report a working demo.
      throw error;
    }
  }

  function setBridge(baseUrl) {
    const origin = normalizeBridgeOrigin(baseUrl);
    bridge = origin;
    mode = 'live';
    setApiBase(origin);
    emit();
    return origin;
  }

  function play() {
    if (playing) return;
    wallBase = now();
    playing = true;
    emit();
  }

  function pause() {
    if (!playing) return;
    freezeClock();
    playing = false;
    emit();
  }

  function setSpeed(mult) {
    const value = Number(mult);
    if (!Number.isFinite(value) || value <= 0 || value > 100000) return;
    if (playing) freezeClock();
    speed = value;
    emit();
  }

  function seekPct(pct) {
    if (!replay) return;
    const clamped = Math.min(100, Math.max(0, Number(pct) || 0));
    playedBase = (clamped / 100) * replay.durationSec;
    wallBase = now();
    emit();
  }

  function getStatus() {
    const playedSec = playedSecNow();
    return {
      mode,
      playing,
      speed,
      playedSec,
      progressPct: replay && replay.durationSec > 0
        ? Math.min(100, (playedSec / replay.durationSec) * 100) : null,
      durationSec: replay ? replay.durationSec : null,
      fileName,
      name: printName,
      analyzing,
      error: lastError,
      bridge,
    };
  }

  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function toolSettingsView(minimumToolCount) {
    const settings = toolStore.get();
    const resolved = resolveToolSettings(settings, detected, { minimumToolCount });
    return {
      toolCount: settings.toolCount,
      toolSlots: settings.toolSlots,
      detected: normalizeDetectedToolSettings(detected),
      effective: {
        toolCount: resolved.toolCount,
        toolCountSource: resolved.toolCountSource,
        countAdjusted: resolved.countAdjusted,
        toolSlots: resolved.toolSlots,
      },
    };
  }

  function completedJobFor(base) {
    if (!base || base.state !== 'FINISHED') {
      completedJob = null;
      return null;
    }
    if (!completedJob) {
      completedJob = {
        jobKey: thumbnailKey(),
        name: base.name,
        state: 'FINISHED',
        finalState: 'FINISHED',
        completedAt: Math.floor(now() / 1000),
        progress: 100,
        timeElapsedSec: base.timeElapsedSec,
        filamentG: base.filamentG,
        material: base.material,
        toolLabel: base.toolLabel,
        swapsDone: base.swapsTotal ?? base.swapsDone,
        swapsTotal: base.swapsTotal,
        wasteDone: base.wasteTotal ?? base.wasteDone,
        wasteTotal: base.wasteTotal,
        currentLayer: base.totalLayers ?? base.currentLayer,
        totalLayers: base.totalLayers,
      };
    }
    return completedJob;
  }

  function buildState() {
    const base = replay ? replay.stateAt(playedSecNow()) : {
      state: 'IDLE',
      progress: null,
      timeRemainingSec: null,
      timeElapsedSec: null,
      nozzleTemp: null,
      nozzleTarget: null,
      bedTemp: null,
      bedTarget: null,
      chamberTemp: null,
      chamberTarget: null,
      speed: null,
      flow: null,
      axisZ: null,
      fanHotend: null,
      currentTool: null,
      toolLabel: null,
      material: null,
      nextToolLabel: null,
      nextSwapInSec: null,
      currentLayer: null,
      totalLayers: null,
      swapsDone: null,
      swapsTotal: null,
      wasteDone: null,
      wasteTotal: null,
      filamentG: null,
      swapping: false,
      name: printName,
    };
    const view = toolSettingsView(base.toolLabel ?? undefined);
    const out = {
      ...base,
      activity: null,
      fanPrint: null,
      online: true,
      staleSec: 0,
      updatedAt: Math.floor(now() / 1000),
      thumbnailUrl: thumbnail ? (thumbnailObjectUrl || '/api/thumbnail') : null,
      thumbnailKey: thumbnailKey(),
      analyzing,
      completedJob: completedJobFor(replay ? base : null),
      toolCount: view.effective.toolCount,
      toolCountSource: view.effective.toolCountSource,
      toolSlots: view.effective.toolSlots,
      toolSettings: view,
      camera: { ...DISABLED_STREAM_STATUS },
      nozzle: { ...DISABLED_STREAM_STATUS },
      nozzlePipUrl: null,
      timelapseUrl: null,
      timelapseIntervalSec,
      roomTemp: null,
      roomHumidity: null,
      outdoorTemp: null,
    };
    if (lastError) out.error = lastError;
    return out;
  }

  function parseJsonBody(init) {
    if (!init || typeof init.body !== 'string') return { error: true };
    try { return { value: JSON.parse(init.body) }; }
    catch { return { error: true }; }
  }

  function handleSettingsToolsPut(init) {
    const ifMatch = headerGet(init, 'If-Match');
    if (ifMatch == null || ifMatch === '') {
      return jsonResponse({ error: 'If-Match header is required' }, 409);
    }
    const body = parseJsonBody(init);
    if (body.error) return jsonResponse({ error: 'request body must be JSON' }, 400);
    try {
      toolStore.replace(body.value, ifMatch);
    } catch (error) {
      if (error && error.code === 'TOOL_SETTINGS_CONFLICT') {
        return jsonResponse({ error: error.message }, 409);
      }
      if (error instanceof TypeError) {
        return jsonResponse({ error: error.message }, 400);
      }
      return jsonResponse({ error: 'tool settings could not be saved' }, 500);
    }
    emit();
    const base = replay ? replay.stateAt(playedSecNow()) : null;
    const view = toolSettingsView(base ? base.toolLabel ?? undefined : undefined);
    return jsonResponse(
      { ...view, minimumToolCount: base ? base.toolLabel : null },
      200,
      { ETag: toolStore.etag() },
    );
  }

  function handleTimelapsePut(init) {
    const body = parseJsonBody(init);
    if (body.error || !body.value || typeof body.value !== 'object') {
      return jsonResponse({ error: 'request body must be JSON' }, 400);
    }
    const value = body.value.intervalSec;
    if (!Number.isInteger(value) || value < 1 || value > 20) {
      return jsonResponse({ error: 'intervalSec must be an integer from 1 to 20' }, 400);
    }
    timelapseIntervalSec = value;
    emit();
    return jsonResponse({ intervalSec: timelapseIntervalSec }, 200);
  }

  function handleFilaments(params) {
    if (!filamentIndex) {
      // Only forward an explicitly supplied storage. Passing the key with an
      // undefined value would suppress createFilamentIndex's own default and
      // silently disable the catalog cache; passing null still disables it.
      const indexOptions = {};
      if (options.storage !== undefined) indexOptions.storage = options.storage;
      try { filamentIndex = createFilamentIndex(indexOptions); }
      catch { filamentIndex = null; }
    }
    let result = null;
    try { result = filamentIndex ? filamentIndex.search(params.get('q') || '') : null; }
    catch { result = null; }
    if (!result) {
      result = { suggestions: [], stale: false, unavailable: true, loading: false };
    }
    return jsonResponse(result, 200);
  }

  async function respondVirtual(url, init) {
    const signal = init && init.signal;
    if (signal && signal.aborted) throw abortError();
    const { pathname, params } = parseApiUrl(url);
    const method = init && init.method ? String(init.method).toUpperCase() : 'GET';

    if (pathname === '/api/state' && (method === 'GET' || method === 'HEAD')) {
      return jsonResponse(buildState(), 200);
    }
    if (pathname === '/api/jobmap' && method === 'GET') {
      if (!analysis) return jsonResponse({ jobKey: null, swapPcts: [], totalLayers: null }, 200);
      return jsonResponse({
        jobKey: thumbnailKey(),
        swapPcts: analysis.timeline.map((event) => event.progressPct),
        totalLayers: analysis.layers.length || null,
      }, 200);
    }
    if (pathname === '/api/thumbnail' && method === 'GET') {
      if (!thumbnail) return new Response(null, { status: 404 });
      const requestedKey = params.get('j');
      if (requestedKey != null &&
          requestedKey.toLowerCase() !== thumbnailKey().toLowerCase()) {
        return new Response(null, { status: 404 });
      }
      return new Response(thumbnail.bytes, {
        status: 200,
        headers: { 'Content-Type': thumbnail.contentType },
      });
    }
    if (pathname === '/api/settings/tools') {
      if (method === 'GET') {
        const base = replay ? replay.stateAt(playedSecNow()) : null;
        const view = toolSettingsView(base ? base.toolLabel ?? undefined : undefined);
        return jsonResponse(
          { ...view, minimumToolCount: base ? base.toolLabel : null },
          200,
          { ETag: toolStore.etag() },
        );
      }
      if (method === 'PUT') return handleSettingsToolsPut(init);
    }
    if (pathname === '/api/settings/timelapse' && method === 'PUT') {
      return handleTimelapsePut(init);
    }
    if (pathname === '/api/filaments' && method === 'GET') {
      return handleFilaments(params);
    }
    return jsonResponse({ error: 'not found' }, 404);
  }

  // The overlay loads thumbnails and camera frames through <img>, which never
  // passes the fetch shim, so a bridge server's root-relative URL fields would
  // resolve against the static host instead. Rewrite them to bridge-absolute.
  async function rewriteLiveState(response, base) {
    if (!response || !response.ok) return response;
    const text = await response.text();
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    let payload;
    try { payload = JSON.parse(text); }
    catch { return new Response(text, { status: response.status, headers }); }
    if (payload && typeof payload === 'object') {
      for (const field of ['thumbnailUrl', 'nozzlePipUrl']) {
        const value = payload[field];
        if (typeof value === 'string' && value.startsWith('/')) payload[field] = base + value;
      }
    }
    return new Response(JSON.stringify(payload), { status: response.status, headers });
  }

  function handleFetch(url, init) {
    if (typeof url !== 'string' || !url.startsWith('/api/')) return null;
    if (mode === 'live' && bridge) {
      if (!fetchImpl) return Promise.reject(new Error('fetch is unavailable'));
      const forwarded = { ...(init || {}), mode: 'cors' };
      const base = bridge;
      const pending = fetchImpl(base + url, forwarded);
      if (url.split('?')[0] !== '/api/state') return pending;
      return pending.then((response) => rewriteLiveState(response, base));
    }
    return respondVirtual(url, init);
  }

  return {
    handleFetch,
    setModeDemo,
    loadFile,
    setBridge,
    getStatus,
    play,
    pause,
    setSpeed,
    seekPct,
    onChange,
  };
}
