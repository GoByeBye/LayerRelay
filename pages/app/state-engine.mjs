/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Virtual /api/* server for the static dashboard build. Serves the exact
 * response shapes of server.js (state, jobmap, thumbnail, settings,
 * filaments) from an in-browser replay of a decoded G-code file, from live
 * Prusa Connect MQTT telemetry in cloud mode, or by forwarding to a
 * user-provided LayerRelay bridge in live mode.
 */
// Browser ESM. The only I/O is through the injected fetch implementation
// (demo asset load and live-mode forwarding), the MQTT WebSocket in cloud
// mode, and localStorage via the injected stores; everything else is
// computed locally.
import { analyzeBgcode, mapLive, materialFor } from './toolswaps.mjs';
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

// ---- cloud (Prusa Connect over MQTT) constants --------------------------------

// Verified reachable from a foreign origin: WebSocket handshakes are exempt
// from CORS, and the broker accepts MQTT 3.1.1 with the Prusa account id as
// username and an OAuth access token as password.
export const CLOUD_MQTT_URL = 'wss://mqtt.prusa3d.com:8084/mqtt';
// Only the per-printer tree is granted; a subscribe to v1/devices/# is denied.
const CLOUD_TOPIC_ROOT = 'v1/devices/printers/';
const CLOUD_TOPIC_PREFIX = /^v1\/devices\/printers\/[^/]+\//;
// Printer id only. The refresh token lives in connect-auth's own key and is
// never written, read, or rendered by the engine.
export const CLOUD_PRINTER_KEY = 'layer-relay.static.cloud.printer';
const CLOUD_BACKOFF_MIN_MS = 2000;
const CLOUD_BACKOFF_MAX_MS = 30000;
// A CONNACK/SUBACK that never arrives must not wedge the link forever.
const CLOUD_CONNECT_TIMEOUT_MS = 20000;
const CLOUD_CAMERA_REASON = 'no camera in cloud mode';

// Retrying any of these only burns the token chain further, so cloud mode
// stops on them. The engine surfaces its own wording rather than the thrown
// message: this text reaches the DOM and /api/state, and a curated string
// cannot accidentally carry a token from a collaborator's error.
const CLOUD_TERMINAL_MESSAGES = {
  invalid_grant: 'Prusa rejected the stored refresh token (invalid_grant). A refresh token ' +
    'can be spent only once, so something else spent it: a running LayerRelay server, ' +
    'another tab, or an interrupted refresh. Capture a fresh token as described in ' +
    'docs/prusa-connect.md and paste it in again.',
  not_configured: 'No Prusa refresh token is stored in this browser. Paste a refresh token ' +
    'and a printer id to start cloud mode: see docs/prusa-connect.md.',
  storage: 'This browser refused to store the rotated Prusa refresh token, so cloud mode ' +
    'cannot run safely: a token that rotates without being saved kills the chain. Allow ' +
    'site data for this page, then connect again.',
};

// Printer ids go straight into an MQTT topic filter, so anything that could
// change the filter's meaning (slash, wildcard, whitespace) is rejected.
export function normalizeConnectPrinterId(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(raw)) {
    throw new TypeError(
      'printer id must be 8 to 64 characters of letters, digits, dash, or underscore');
  }
  return raw;
}

function cloudError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const round1 = (value) => (value == null || !Number.isFinite(value)
  ? null : Math.round(value * 10) / 10);

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

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

  // Cloud mode collaborators. Every one is injectable so the engine can be
  // driven by fakes with no network and no dependency on the real modules;
  // the defaults import them lazily, so nothing is loaded (or bundled into
  // the startup path) until cloud mode is actually engaged.
  const authFactory = options.authFactory || (async (config) => {
    const module = await import('./connect-auth.mjs');
    return module.createConnectAuth(config);
  });
  const mqttFactory = options.mqttFactory || (async (config) => {
    const module = await import('./mqtt.mjs');
    return module.createMqttClient(config);
  });
  const connectStateFactory = options.connectStateFactory || (async () => {
    const module = await import('./connect-live.mjs');
    return module.createConnectState();
  });
  const setTimer = options.setTimeoutImpl ||
    ((fn, ms) => (typeof setTimeout === 'function' ? setTimeout(fn, ms) : null));
  const clearTimer = options.clearTimeoutImpl ||
    ((id) => { if (typeof clearTimeout === 'function') clearTimeout(id); });
  const makeClientId = options.clientIdFactory || (() => {
    let suffix = '';
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      }
    } catch { suffix = ''; }
    if (!suffix) suffix = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    return `lr-static-${suffix}`;
  });

  function storageRef() {
    if (options.storage !== undefined) return options.storage;
    try { return typeof localStorage === 'undefined' ? null : localStorage; }
    catch { return null; }
  }

  function storageRead(key) {
    const store = storageRef();
    if (!store || typeof store.getItem !== 'function') return null;
    try { return store.getItem(key); }
    catch { return null; }
  }

  function storageWrite(key, value) {
    const store = storageRef();
    if (!store || typeof store.setItem !== 'function') return;
    try { store.setItem(key, value); }
    catch { /* quota or private mode: persistence is best effort */ }
  }

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

  // Cloud mode runtime. cloudSeq is the epoch guard: every teardown and every
  // fresh setModeCloud bumps it, and each await boundary in the connect path
  // bails when it moved, so a late-resolving token refresh can never open a
  // socket for a mode the user already left.
  let cloudSeq = 0;
  let cloudAuth = null;
  let cloudLive = null;         // connect-live topic mapper
  let cloudClient = null;       // MQTT client
  let cloudPrinterId = null;
  let cloudPhase = 'idle';      // idle | connecting | live | retrying | error
  let cloudFailure = null;      // last surfaced cloud error message
  let cloudFatal = false;       // terminal invalid_grant: no more attempts
  let cloudAttempt = 0;
  let cloudRetryAt = null;
  let cloudRetryTimer = null;
  let cloudConnectTimer = null;
  let cloudLastMessageAt = null;
  let cloudAnchorAt = null;     // when the current attempt started
  let cloudMessages = 0;
  let cloudUserId = null;
  // One attempt can only fail once. A dying MQTT client emits `error` and then
  // `close` for a single fault, and closing it from the failure path can emit
  // `close` again, so without this latch one drop would advance the backoff
  // two or three steps and could leave a second reconnect timer running.
  let cloudAttemptSettled = false;
  const cloudTopics = new Set();

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

  function cloudJobId() {
    if (!cloudLive) return null;
    try {
      const value = cloudLive.jobId;
      return value == null || value === '' ? null : String(value);
    } catch { return null; }
  }

  function thumbnailKey() {
    // The load serial keeps the key unique per decoded file. Without it, a
    // second drop of a re-sliced file with the same name would leave the
    // overlay showing the previous thumbnail and swap ticks, because it
    // reloads both only when the key changes.
    if (mode === 'cloud') {
      // The printer's job id joins the key so the overlay reloads the
      // thumbnail and the swap map when the printer moves to another job.
      return `cloud::${cloudJobId() || '-'}::${loadSeq}::${fileName || '-'}`;
    }
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

  // A file dropped while cloud mode is running is not a replay source: it is
  // the analysis that supplies the job name, thumbnail, layer and swap data
  // MQTT never publishes. Loading one must therefore keep cloud mode running.
  async function loadFile(u8, name) {
    if (mode !== 'cloud') {
      teardownCloud();
      mode = 'file';
    }
    setApiBase('');
    const token = ++loadSeq;
    await applyBytes(u8, String(name || 'print.bgcode'), token);
  }

  async function setModeDemo(demoFileUrl) {
    teardownCloud();
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
    teardownCloud();
    bridge = origin;
    mode = 'live';
    setApiBase(origin);
    emit();
    return origin;
  }

  // ---- cloud mode: Prusa Connect telemetry over MQTT ---------------------------

  function clearCloudTimers() {
    if (cloudRetryTimer != null) { clearTimer(cloudRetryTimer); cloudRetryTimer = null; }
    if (cloudConnectTimer != null) { clearTimer(cloudConnectTimer); cloudConnectTimer = null; }
    cloudRetryAt = null;
  }

  function closeCloudClient() {
    const client = cloudClient;
    cloudClient = null;
    if (client && typeof client.close === 'function') {
      try { client.close(); } catch { /* already gone */ }
    }
  }

  // Invalidates the current epoch, stops every timer, and drops the socket.
  // Safe to call from any mode.
  function teardownCloud() {
    cloudSeq += 1;
    clearCloudTimers();
    closeCloudClient();
    cloudPhase = 'idle';
    cloudAnchorAt = null;
  }

  function storedPrinterId() {
    const raw = storageRead(CLOUD_PRINTER_KEY);
    if (!raw) return null;
    try { return normalizeConnectPrinterId(raw); }
    catch { return null; }
  }

  function backoffMs(attempt) {
    const step = CLOUD_BACKOFF_MIN_MS * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(CLOUD_BACKOFF_MAX_MS, step);
  }

  function markCloudLive(seq) {
    if (seq !== cloudSeq) return;
    if (cloudConnectTimer != null) { clearTimer(cloudConnectTimer); cloudConnectTimer = null; }
    cloudRetryAt = null;
    cloudAttempt = 0;
    if (cloudPhase === 'live') return;
    cloudPhase = 'live';
    cloudFailure = null;
    emit();
  }

  // Terminal failures (a dead token chain, nothing configured) must not spin a
  // retry loop that burns the chain further; everything else backs off.
  function cloudAttemptFailed(seq, error) {
    if (seq !== cloudSeq || cloudAttemptSettled) return;
    cloudAttemptSettled = true;
    clearCloudTimers();
    closeCloudClient();
    const code = error && typeof error.code === 'string' ? error.code : null;
    const terminal = CLOUD_TERMINAL_MESSAGES[code];
    if (terminal) {
      cloudFatal = true;
      cloudPhase = 'error';
      cloudFailure = terminal;
      emit();
      return;
    }
    cloudFailure = String((error && error.message) || error || 'connection lost');
    cloudAttempt += 1;
    const delay = backoffMs(cloudAttempt);
    cloudPhase = 'retrying';
    cloudRetryAt = now() + delay;
    emit();
    cloudRetryTimer = setTimer(() => {
      cloudRetryTimer = null;
      cloudRetryAt = null;
      if (seq !== cloudSeq) return;
      // connectCloud rejects only through cloudAttemptFailed, which is called
      // inside it; the catch is belt and braces so a throw cannot escape into
      // an unhandled rejection from a timer callback.
      Promise.resolve(connectCloud(seq)).catch(() => {});
    }, delay);
  }

  function onCloudMessage(seq, message) {
    if (seq !== cloudSeq || !message || typeof message.topic !== 'string') return;
    // createConnectState() takes no printer id, so stripping the per-printer
    // prefix is the engine's job: the mapper only ever sees relative topics.
    const topic = message.topic.replace(CLOUD_TOPIC_PREFIX, '');
    try { cloudLive.apply(topic, message.payload); }
    catch { return; } // one unmappable payload must not kill the link
    cloudTopics.add(topic);
    cloudMessages += 1;
    cloudLastMessageAt = now();
    if (cloudPhase !== 'live') markCloudLive(seq);
  }

  async function connectCloud(seq) {
    if (seq !== cloudSeq || cloudFatal) return;
    clearCloudTimers();
    closeCloudClient();
    cloudAttemptSettled = false;
    cloudPhase = 'connecting';
    cloudAnchorAt = now();
    emit();

    let accessToken;
    let userId;
    try {
      // The access token is refreshed before every attempt, so a reconnect
      // after a long outage never carries an expired one.
      accessToken = await cloudAuth.getAccessToken();
      if (seq !== cloudSeq) return;
      // Held for the session: a 401 from the profile endpoint makes
      // connect-auth drop the cached access token, so asking again on every
      // reconnect would rotate the refresh token once per backoff cycle.
      if (cloudUserId == null) {
        cloudUserId = await cloudAuth.getUserId();
        if (seq !== cloudSeq) return;
      }
      userId = cloudUserId;
    } catch (error) {
      cloudAttemptFailed(seq, error);
      return;
    }
    if (!accessToken) {
      cloudAttemptFailed(seq, cloudError('invalid_grant', 'no access token'));
      return;
    }

    let client;
    try {
      client = await mqttFactory({
        url: CLOUD_MQTT_URL,
        clientId: makeClientId(),
        username: String(userId == null ? '' : userId),
        password: accessToken,
        WebSocketImpl: options.WebSocketImpl,
      });
    } catch (error) {
      cloudAttemptFailed(seq, error);
      return;
    }
    if (seq !== cloudSeq) {
      if (client && typeof client.close === 'function') {
        try { client.close(); } catch { /* already gone */ }
      }
      return;
    }
    cloudClient = client;

    const filter = `${CLOUD_TOPIC_ROOT}${cloudPrinterId}/#`;
    client.on('connack', () => {
      if (seq !== cloudSeq) return;
      try { client.subscribe([filter]); }
      catch (error) { cloudAttemptFailed(seq, error); }
    });
    client.on('suback', () => markCloudLive(seq));
    client.on('message', (message) => onCloudMessage(seq, message));
    client.on('close', () => cloudAttemptFailed(seq, new Error('MQTT link closed')));
    client.on('error', (error) => cloudAttemptFailed(
      seq, error instanceof Error ? error : new Error(String(error || 'MQTT error'))));

    cloudConnectTimer = setTimer(() => {
      cloudConnectTimer = null;
      if (seq !== cloudSeq || cloudPhase === 'live') return;
      cloudAttemptFailed(seq, new Error('no MQTT response within 20s'));
    }, CLOUD_CONNECT_TIMEOUT_MS);

    try { await client.connect(); }
    catch (error) {
      if (seq !== cloudSeq) return;
      cloudAttemptFailed(seq, error);
    }
  }

  // Engages cloud mode. Resolves once the first connection attempt has been
  // started (or has failed); the link's own progress is reported through
  // getStatus().cloud and /api/state, never through this promise.
  async function setModeCloud(config = {}) {
    const printerId = config && config.printerUuid != null && String(config.printerUuid).trim()
      ? normalizeConnectPrinterId(config.printerUuid)
      : storedPrinterId();
    if (!printerId) {
      throw cloudError('not_configured',
        'a Prusa Connect printer id is required to start cloud mode');
    }
    const refreshToken = config && typeof config.refreshToken === 'string'
      ? config.refreshToken.trim() : '';

    teardownCloud();
    const seq = cloudSeq;
    mode = 'cloud';
    setApiBase('');
    bridge = null;
    cloudPrinterId = printerId;
    cloudFatal = false;
    cloudFailure = null;
    cloudAttempt = 0;
    cloudMessages = 0;
    cloudUserId = null;
    cloudLastMessageAt = null;
    cloudTopics.clear();
    cloudPhase = 'connecting';
    cloudAnchorAt = now();
    storageWrite(CLOUD_PRINTER_KEY, printerId);
    emit();

    try {
      cloudLive = await connectStateFactory();
      if (seq !== cloudSeq) return;
      cloudAuth = await authFactory({ storage: storageRef(), fetchImpl, now });
      if (seq !== cloudSeq) return;
    } catch (error) {
      // A module that will not load will not load on the next attempt either.
      if (seq !== cloudSeq) return;
      cloudFatal = true;
      cloudPhase = 'error';
      cloudFailure = `cloud mode could not start: ${(error && error.message) || error}`;
      emit();
      return;
    }

    if (refreshToken) {
      // Rejected outright rather than retried: a malformed token never becomes
      // valid, and the caller shows the reason next to the field it came from.
      try {
        cloudAuth.configure({ refreshToken, printerUuid: printerId });
      } catch (error) {
        if (seq !== cloudSeq) return;
        cloudFatal = true;
        cloudPhase = 'error';
        cloudFailure = String((error && error.message) || error);
        emit();
        throw error;
      }
    }
    await connectCloud(seq);
  }

  function cloudSnapshot() {
    if (!cloudLive || typeof cloudLive.snapshot !== 'function') return {};
    try {
      const snapshot = cloudLive.snapshot();
      return snapshot && typeof snapshot === 'object' ? snapshot : {};
    } catch { return {}; }
  }

  function cloudStatus() {
    if (mode !== 'cloud') return null;
    return {
      phase: cloudPhase,
      printerUuid: cloudPrinterId,
      error: cloudFailure,
      fatal: cloudFatal,
      attempt: cloudAttempt,
      topics: cloudTopics.size,
      messages: cloudMessages,
      lastMessageAt: cloudLastMessageAt,
      retryInMs: cloudRetryAt == null ? null : Math.max(0, cloudRetryAt - now()),
    };
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
      cloud: cloudStatus(),
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

  function idleBase() {
    return {
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
      activity: null,
      fanPrint: null,
      // Placeholder so the cloud snapshot's data/online value has a slot to
      // land in; the response envelope always recomputes it.
      online: null,
      name: printName,
    };
  }

  // Copies only keys the target already declares, and only when the source
  // actually set one. A plain spread would let an `undefined` erase a field
  // (JSON.stringify then drops the key the overlay reads) and would leak the
  // topic mapper's bookkeeping fields into the public /api/state shape.
  function assignKnown(target, source) {
    if (!source || typeof source !== 'object') return target;
    for (const key of Object.keys(target)) {
      if (source[key] !== undefined) target[key] = source[key];
    }
    return target;
  }

  // Cloud telemetry merged with an optionally loaded .bgcode analysis. MQTT
  // publishes no job name, thumbnail, layer, swap or waste data, so a dropped
  // file supplies all of it through the same mapLive() the replay uses.
  function cloudBase() {
    const base = assignKnown(idleBase(), cloudSnapshot());
    base.name = null;
    if (!analysis) return base;

    base.name = printName || null;
    if (base.material == null) base.material = materialFor(analysis, base.currentTool);
    if (analysis.totalFilamentG != null) base.filamentG = Math.round(analysis.totalFilamentG);

    const progress = finiteOrNull(base.progress);
    if (progress == null) return base;
    const remainingSec = finiteOrNull(base.timeRemainingSec);
    const live = mapLive(analysis, progress, remainingSec == null ? null : remainingSec / 60);
    const finished = base.state === 'FINISHED';
    base.swapsTotal = live.swapsTotal ?? null;
    base.swapsDone = finished && live.swapsTotal != null ? live.swapsTotal : (live.swapsDone ?? null);
    base.wasteTotal = round1(live.wasteTotal);
    base.wasteDone = round1(finished && live.wasteTotal != null ? live.wasteTotal : live.wasteDone);
    base.totalLayers = live.totalLayers ?? null;
    base.currentLayer = finished && live.totalLayers != null ? live.totalLayers : (live.currentLayer ?? null);
    base.nextToolLabel = finished || live.nextTool == null ? null : live.nextTool + 1;
    base.nextSwapInSec = finished || live.nextSwapRemMin == null
      ? null : Math.round(live.nextSwapRemMin * 60);
    return base;
  }

  // The MQTT link, not the retained data/online payload, decides freshness:
  // `1` stays retained on the broker long after the socket dies. While the
  // link is up silence is normal (an idle printer publishes nothing), so
  // staleSec only starts running once the link is down.
  function cloudFreshness(reportedOnline) {
    const linkLive = cloudPhase === 'live' && cloudLastMessageAt != null;
    if (linkLive) return { online: reportedOnline !== false, staleSec: 0 };
    const anchor = cloudLastMessageAt != null ? cloudLastMessageAt
      : (cloudAnchorAt != null ? cloudAnchorAt : now());
    return { online: false, staleSec: Math.max(0, Math.floor((now() - anchor) / 1000)) };
  }

  function buildState() {
    const cloud = mode === 'cloud';
    const base = cloud ? cloudBase() : (replay ? replay.stateAt(playedSecNow()) : idleBase());
    const view = toolSettingsView(base.toolLabel ?? undefined);
    const key = thumbnailKey();
    if (cloud && completedJob && completedJob.jobKey !== key) completedJob = null;
    const freshness = cloud ? cloudFreshness(base.online) : { online: true, staleSec: 0 };
    const camera = { ...DISABLED_STREAM_STATUS };
    if (cloud) camera.error = CLOUD_CAMERA_REASON;
    const out = {
      ...base,
      activity: base.activity ?? null,
      fanPrint: base.fanPrint ?? null,
      online: freshness.online,
      staleSec: freshness.staleSec,
      updatedAt: Math.floor(now() / 1000),
      thumbnailUrl: thumbnail ? (thumbnailObjectUrl || '/api/thumbnail') : null,
      thumbnailKey: key,
      analyzing,
      completedJob: completedJobFor((cloud || replay) ? base : null),
      toolCount: view.effective.toolCount,
      toolCountSource: view.effective.toolCountSource,
      toolSlots: view.effective.toolSlots,
      toolSettings: view,
      camera,
      nozzle: { ...camera },
      nozzlePipUrl: null,
      timelapseUrl: null,
      timelapseIntervalSec,
      roomTemp: null,
      roomHumidity: null,
      outdoorTemp: null,
    };
    const error = cloud ? (cloudFailure || lastError) : lastError;
    if (error) out.error = error;
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
    setModeCloud,
    stopCloud: teardownCloud,
    getStatus,
    play,
    pause,
    setSpeed,
    seekPct,
    onChange,
  };
}
