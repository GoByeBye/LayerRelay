/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Added 2026-08-19 for the static GitHub Pages build: window.fetch shim that
 * routes /api/* requests to the in-browser state engine, plus the injected
 * control panel (Demo / Your file / Live server / Prusa Connect). Visual
 * language mirrors public/overlay.html. See NOTICE.md and
 * docs/static-hosting.md.
 */
// Browser ESM. No Node APIs, no frameworks, no npm deps. Nothing in this module
// touches the DOM (or window) at evaluation time: every access lives inside a
// function so pages/app/main.mjs can install the fetch shim synchronously
// before overlay.html's inline script issues its first /api/state poll.

import { CLOUD_PRINTER_KEY, normalizeConnectPrinterId } from './state-engine.mjs';

const MODE_KEY = 'layer-relay.static.mode';
const BRIDGE_KEY = 'layer-relay.static.bridge';
const SPEED_KEY = 'layer-relay.static.speed';
const MODES = ['demo', 'file', 'live', 'cloud'];
const SPEEDS = [1, 10, 60, 300];
const DEFAULT_SPEED = 60;
// Relative on purpose: must resolve under a GitHub Pages project subpath
// (https://user.github.io/LayerRelay/demo.bgcode), never the site root.
const DEMO_ASSET_URL = 'demo.bgcode';
const SOURCE_URL = 'https://github.com/GoByeBye/LayerRelay';
const DOCS_URL = 'https://github.com/GoByeBye/LayerRelay/blob/master/docs/static-hosting.md';
const CONNECT_DOCS_URL = 'https://github.com/GoByeBye/LayerRelay/blob/master/docs/prusa-connect.md';
const IDLE_HIDE_MS = 3500;           // mirror overlay.html scheduleControlsIdle default
const IDLE_LEAVE_MS = 2500;          // mirror overlay.html pointerleave delay
const IDLE_FIRST_MS = 5000;          // first-visit grace so the panel is discoverable
const REVEAL_THROTTLE_MS = 180;      // mirror overlay.html pointermove throttle
const REFRESH_MS = 500;
const SCRUB_HOLDOFF_MS = 1000;
const PROBE_TIMEOUT_MS = 6000;

// ---- small helpers -----------------------------------------------------------

function storageGet(win, key) {
  try {
    return win && win.localStorage ? win.localStorage.getItem(key) : null;
  } catch (err) {
    return null; // private mode / storage disabled
  }
}

function storageSet(win, key, value) {
  try {
    if (win && win.localStorage) win.localStorage.setItem(key, value);
  } catch (err) {
    // quota / private mode: persistence is best-effort
  }
}

function messageOf(err) {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

// Same accepted spellings as overlay.html's queryFlag().
function queryFlag(params, name) {
  if (!params.has(name)) return null;
  const value = String(params.get(name) || '').trim().toLowerCase();
  if (!value || value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return null;
}

// Strict bridge validation: plain http(s) origin, no credentials, path, query,
// or fragment. Returns the normalized origin string or null.
export function normalizeBridge(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (url.pathname && url.pathname !== '/') return null;
  return url.origin;
}

// Non-throwing wrapper around the engine's topic-safe printer id check.
export function normalizePrinterId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    return normalizeConnectPrinterId(value);
  } catch (err) {
    return null;
  }
}

function parseSpeed(value) {
  if (value == null) return null;
  const n = Number(String(value).trim().replace(/x$/i, ''));
  return SPEEDS.indexOf(n) === -1 ? null : n;
}

// Startup resolution: URL params override localStorage, storage overrides
// defaults. Exported for tests.
export function resolveStartup(win) {
  const w = win;
  let params;
  try {
    params = new URLSearchParams((w.location && w.location.search) || '');
  } catch (err) {
    params = new URLSearchParams('');
  }
  const paramMode = String(params.get('mode') || '').trim().toLowerCase();
  const storedMode = String(storageGet(w, MODE_KEY) || '').trim().toLowerCase();
  const mode = MODES.indexOf(paramMode) !== -1 ? paramMode
    : (MODES.indexOf(storedMode) !== -1 ? storedMode : 'demo');
  const bridge = normalizeBridge(params.get('bridge')) || normalizeBridge(storageGet(w, BRIDGE_KEY)) || '';
  const paramSpeed = parseSpeed(params.get('speed'));
  const storedSpeed = parseSpeed(storageGet(w, SPEED_KEY));
  const speed = paramSpeed != null ? paramSpeed : (storedSpeed != null ? storedSpeed : DEFAULT_SPEED);
  const controlsEnabled = queryFlag(params, 'controls') !== false;
  // Only the printer id is ever accepted from the URL or restored from
  // storage. A refresh token is typed in by hand every time it changes and is
  // handed straight to the engine; this module never stores or reads one.
  const printerId = normalizePrinterId(params.get('printer')) ||
    normalizePrinterId(storageGet(w, CLOUD_PRINTER_KEY)) || '';
  return { mode, bridge, speed, controlsEnabled, printerId };
}

// ---- fetch shim --------------------------------------------------------------

// Replaces window.fetch with a wrapper that hands root-relative /api/* URLs to
// the state engine and passes everything else (and every engine miss) to the
// real fetch. Must be called synchronously at bundle evaluation, before the
// overlay's inline script runs. Returns the bound real fetch.
export function installFetchShim(options) {
  const opts = options || {};
  const win = opts.win || window;
  const engineReady = opts.engineReady || Promise.resolve(opts.engine || null);
  const realFetch = win.fetch.bind(win);
  if (typeof win.__LR_API_BASE !== 'string') win.__LR_API_BASE = '';
  let warned = false;
  win.fetch = function (input, init) {
    let url = '';
    if (typeof input === 'string') url = input;
    else if (input && typeof input.url === 'string') url = input.url;      // Request
    else if (input != null) url = String(input);                           // URL and friends
    if (!url.startsWith('/api/')) return realFetch(input, init);
    return engineReady.then(function (engine) {
      let handled = null;
      if (engine && typeof engine.handleFetch === 'function') {
        try {
          handled = engine.handleFetch(url, init);
        } catch (err) {
          if (!warned && typeof console !== 'undefined') {
            warned = true;
            console.warn('LayerRelay static engine failed to handle ' + url + ':', err);
          }
          handled = null;
        }
      }
      // null = not handled by the engine: fall through to the real fetch so
      // unknown /api paths behave like an ordinary static-host 404.
      return handled || realFetch(input, init);
    }, function () {
      return realFetch(input, init);
    });
  };
  return realFetch;
}

// ---- injected control panel --------------------------------------------------

const PANEL_CSS = [
  '#lr-panel {',
  '  position: fixed; top: 80px; right: 24px; z-index: 29; width: 330px;',
  "  font-family: 'IBM Plex Sans', system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;",
  '  color: #fff; -webkit-font-smoothing: antialiased;',
  '  opacity: 1; transform: translateY(0);',
  '  transition: opacity 0.22s ease, transform 0.22s ease;',
  '}',
  '#lr-panel.lr-idle { opacity: 0; transform: translateY(-6px); pointer-events: none; }',
  '#lr-panel * { box-sizing: border-box; }',
  '#lr-panel [hidden] { display: none !important; }',
  '.lr-card {',
  '  padding: 14px 16px 12px;',
  '  border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 14px;',
  '  background: rgba(10, 11, 14, 0.88); backdrop-filter: blur(18px);',
  '  box-shadow: 0 18px 55px rgba(0, 0, 0, 0.4);',
  '  max-height: calc(100vh - 104px); overflow-y: auto;',
  '}',
  '.lr-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }',
  ".lr-kicker { font: 700 10px 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace; letter-spacing: 0.12em; color: #9fa6b1; }",
  '.lr-dot { width: 7px; height: 7px; border-radius: 50%; background: #35c46a; box-shadow: 0 0 0 4px rgba(53, 196, 106, 0.13); }',
  // Four modes wrap to a 2x2 grid rather than squeezing "Prusa Connect" onto
  // two lines inside a quarter-width pill.
  '.lr-modes { display: flex; flex-wrap: wrap; gap: 6px; }',
  '.lr-mode {',
  '  flex: 1 1 calc(50% - 3px); padding: 7px 4px; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px;',
  '  background: rgba(255, 255, 255, 0.07); color: #dfe3e9;',
  '  font-family: inherit; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; cursor: pointer;',
  '}',
  '.lr-mode:hover, .lr-mode:focus-visible { background: rgba(255, 255, 255, 0.14); outline: none; }',
  '.lr-mode[aria-pressed="true"] { border-color: #ff8a3d; background: rgba(255, 138, 61, 0.16); color: #ffd9bd; }',
  '.lr-section, .lr-replay, .lr-foot { border-top: 1px solid rgba(255, 255, 255, 0.1); margin-top: 12px; padding-top: 11px; }',
  '.lr-label {',
  '  display: block; color: #aeb5c0; font-size: 11px; font-weight: 600;',
  '  text-transform: uppercase; letter-spacing: 0.06em;',
  '}',
  '.lr-status { margin: 8px 0 0; min-height: 15px; color: #b9bfc9; font-size: 11px; line-height: 1.45; }',
  '.lr-status.lr-bad, .lr-error { color: #ff9b9f; }',
  '.lr-error { margin: 10px 0 0; font-size: 11px; line-height: 1.45; }',
  '.lr-drop {',
  '  display: block; width: 100%; padding: 16px 10px;',
  '  border: 1px dashed rgba(255, 255, 255, 0.22); border-radius: 10px;',
  '  background: rgba(255, 255, 255, 0.035); color: #cdd2da;',
  '  font-family: inherit; font-size: 12px; font-weight: 600; text-align: center; cursor: pointer;',
  '}',
  '.lr-drop small { display: block; margin-top: 3px; color: #858d99; font-size: 10px; font-weight: 500; }',
  '.lr-drop:hover, .lr-drop:focus-visible, #lr-panel.lr-dropping .lr-drop { border-color: #ff8a3d; color: #fff; outline: none; }',
  '.lr-drop:disabled { opacity: 0.42; cursor: default; }',
  '.lr-hidden-input {',
  '  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;',
  '  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;',
  '}',
  '.lr-input, .lr-select {',
  '  border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 8px; padding: 7px 9px;',
  '  color: #fff; background: rgba(255, 255, 255, 0.07);',
  "  font-family: 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace; font-size: 12px; font-weight: 500;",
  '}',
  '.lr-select { font-family: inherit; font-weight: 600; font-size: 11px; padding: 6px; }',
  '.lr-select option { background: #17191e; color: #fff; }',
  '.lr-input:focus-visible, .lr-select:focus-visible {',
  '  border-color: #ff8a3d; outline: 2px solid rgba(255, 138, 61, 0.25); outline-offset: 1px;',
  '}',
  '.lr-live-row { display: flex; gap: 7px; margin-top: 6px; }',
  '.lr-live-row .lr-input { flex: 1 1 auto; min-width: 0; }',
  '.lr-btn {',
  '  flex: 0 0 auto; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px; padding: 7px 10px;',
  '  background: rgba(255, 255, 255, 0.07); color: #fff;',
  '  font-family: inherit; font-size: 11px; font-weight: 600; cursor: pointer;',
  '}',
  '.lr-btn:hover, .lr-btn:focus-visible { background: rgba(255, 255, 255, 0.14); outline: none; }',
  '.lr-btn:disabled { opacity: 0.42; cursor: default; }',
  '.lr-field { margin-top: 9px; }',
  '.lr-field:first-child { margin-top: 0; }',
  '.lr-field .lr-input { display: block; width: 100%; margin-top: 5px; }',
  '.lr-cloud-row { display: flex; justify-content: flex-end; margin-top: 9px; }',
  '.lr-warn {',
  '  margin: 11px 0 0; padding: 9px 10px;',
  '  border: 1px solid rgba(255, 138, 61, 0.42); border-radius: 9px;',
  '  background: rgba(255, 138, 61, 0.12); color: #f3d7c2;',
  '  font-size: 10px; line-height: 1.5;',
  '}',
  '.lr-warn strong {',
  "  display: block; margin-bottom: 3px; color: #ffb27a;",
  "  font: 700 10px 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace; letter-spacing: 0.1em;",
  '}',
  '.lr-warn a { color: #ffd9bd; text-decoration: underline; text-underline-offset: 2px; }',
  '.lr-warn a:hover, .lr-warn a:focus-visible { color: #fff; outline: none; }',
  '.lr-note { margin: 9px 0 0; color: #858d99; font-size: 10px; line-height: 1.45; }',
  ".lr-note code { font-family: 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace; font-size: 9px; color: #c8ced7; }",
  '.lr-note a, .lr-foot a { color: #c8ced7; text-decoration: underline; text-underline-offset: 2px; }',
  '.lr-note a:hover, .lr-note a:focus-visible, .lr-foot a:hover, .lr-foot a:focus-visible { color: #fff; outline: none; }',
  '.lr-replay-row { display: flex; align-items: center; gap: 8px; }',
  '.lr-play { min-width: 62px; }',
  '.lr-replay-row .lr-label { margin-left: auto; }',
  '.lr-speed { width: 72px; }',
  '.lr-scrub { display: block; width: 100%; margin: 10px 0 2px; accent-color: #ff8a3d; }',
  '.lr-foot { color: #858d99; font-size: 10px; line-height: 1.45; }',
].join('\n');

function makeEl(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function makeStatusLine(doc, id) {
  const node = makeEl(doc, 'p', 'lr-status');
  node.id = id;
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  return node;
}

function makeLink(doc, text, href) {
  const node = makeEl(doc, 'a', '', text);
  node.setAttribute('href', href);
  node.setAttribute('target', '_blank');
  node.setAttribute('rel', 'noopener');
  return node;
}

// Creates the app driver. `boot()` is DOM-free and safe to call at bundle
// evaluation; `mountPanel()` needs the document and runs on DOMContentLoaded.
export function createStaticApp(options) {
  const opts = options || {};
  const win = opts.win || window;
  const engine = opts.engine || null;
  const engineError = opts.engineError || null;
  const startup = resolveStartup(win);

  const state = {
    section: startup.mode,               // which panel tab is showing
    engineMode: null,                    // which source the engine actually serves
    speed: startup.speed,
    bridge: startup.bridge,
    demo: { phase: 'idle', error: null },   // idle | loading | ready | error
    file: null,                             // null | {name, phase, error}
    live: { phase: 'idle', origin: '', detail: '' },
    // idle | invalid | starting | engaged | error. The live link's own progress
    // is read from engine.getStatus().cloud, never mirrored here.
    cloud: { phase: 'idle', detail: '' },
    printerId: startup.printerId,
    assumedPlaying: true,                // fallback when getStatus() lacks a playing flag
  };
  let refs = null;
  let mounted = false;
  let demoSeq = 0;
  let fileSeq = 0;
  let probeSeq = 0;
  let cloudSeq = 0;
  let idleTimer = null;
  let interacting = false;
  let lastReveal = 0;
  let lastScrubAt = 0;
  let dragDepth = 0;

  function clearBridgeBase() {
    try {
      if (typeof win.__LR_API_BASE === 'string' && win.__LR_API_BASE) win.__LR_API_BASE = '';
    } catch (err) {
      // window locked down: nothing to fix
    }
    // The bridge is no longer serving this page, so a previous verdict about
    // it must not keep reading as a live connection on the Live tab.
    if (state.live && state.live.phase !== 'idle') {
      state.live = { phase: 'idle', origin: state.live.origin || '', detail: '' };
    }
  }

  function applySpeed() {
    if (!engine || typeof engine.setSpeed !== 'function') return;
    try {
      engine.setSpeed(state.speed);
    } catch (err) {
      // replay not active yet: the next mode activation re-applies it
    }
  }

  function readEngineStatus() {
    if (!engine || typeof engine.getStatus !== 'function') return null;
    try {
      const status = engine.getStatus();
      return status && typeof status === 'object' ? status : null;
    } catch (err) {
      return null;
    }
  }

  function pickNumber(status, keys) {
    if (!status) return null;
    for (let i = 0; i < keys.length; i += 1) {
      const value = status[keys[i]];
      if (typeof value === 'number' && isFinite(value)) return value;
    }
    return null;
  }

  function pickPlaying(status) {
    if (status && typeof status.playing === 'boolean') return status.playing;
    if (status && typeof status.paused === 'boolean') return !status.paused;
    return state.assumedPlaying;
  }

  function refreshIfMounted() {
    if (mounted && refs) refreshPanel();
  }

  // ---- data sources ----------------------------------------------------------

  function startDemo() {
    if (!engine || typeof engine.setModeDemo !== 'function') return;
    const seq = ++demoSeq;
    fileSeq += 1;
    probeSeq += 1;
    state.engineMode = 'demo';
    clearBridgeBase();
    state.demo = { phase: 'loading', error: null };
    let pending;
    try {
      pending = Promise.resolve(engine.setModeDemo(DEMO_ASSET_URL));
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(function () {
      if (seq !== demoSeq) return;
      state.demo = { phase: 'ready', error: null };
      state.assumedPlaying = true;
      applySpeed();
      refreshIfMounted();
    }, function (err) {
      if (seq !== demoSeq) return;
      state.demo = { phase: 'error', error: messageOf(err) };
      refreshIfMounted();
    });
    refreshIfMounted();
  }

  function loadLocalFile(file) {
    const name = (file && file.name) || 'print.bgcode';
    if (!engine || typeof engine.loadFile !== 'function') {
      state.file = { name: name, phase: 'error', error: 'engine unavailable' };
      refreshIfMounted();
      return;
    }
    // A file dropped during cloud mode is the analysis that fills in what MQTT
    // never publishes, not a replay source, so cloud mode must survive it.
    const keepCloud = state.engineMode === 'cloud';
    const seq = ++fileSeq;
    demoSeq += 1;
    probeSeq += 1;
    if (!keepCloud) cloudSeq += 1;
    state.engineMode = keepCloud ? 'cloud' : 'file';
    clearBridgeBase();
    let record = { name: name, phase: 'reading', error: null };
    state.file = record;
    refreshIfMounted();
    // A load that another source superseded must not leave its progress text
    // behind, or the File tab keeps claiming a decode that no longer runs.
    function dropSuperseded() {
      if (state.file !== record) return;
      state.file = null;
      refreshIfMounted();
    }
    Promise.resolve()
      .then(function () { return file.arrayBuffer(); })
      .then(function (buffer) {
        if (seq !== fileSeq) { dropSuperseded(); return null; }
        record = { name: name, phase: 'decoding', error: null };
        state.file = record;
        refreshIfMounted();
        return engine.loadFile(new Uint8Array(buffer), name);
      })
      .then(function () {
        if (seq !== fileSeq) { dropSuperseded(); return; }
        state.file = { name: name, phase: 'ready', error: null };
        state.assumedPlaying = true;
        storageSet(win, MODE_KEY, keepCloud ? 'cloud' : 'file');
        applySpeed();
        refreshIfMounted();
      })
      .catch(function (err) {
        if (seq !== fileSeq) { dropSuperseded(); return; }
        state.file = { name: name, phase: 'error', error: messageOf(err) };
        refreshIfMounted();
      });
  }

  function engageBridge(origin, probe) {
    if (!engine || typeof engine.setBridge !== 'function') {
      state.live = { phase: 'dead', origin: origin, detail: '' };
      refreshIfMounted();
      return;
    }
    demoSeq += 1;
    fileSeq += 1;
    state.engineMode = 'live';
    try {
      engine.setBridge(origin);
    } catch (err) {
      state.live = { phase: 'error', origin: origin, detail: messageOf(err) };
      refreshIfMounted();
      return;
    }
    state.live = { phase: 'set', origin: origin, detail: '' };
    if (probe) probeBridge(origin);
    refreshIfMounted();
  }

  function probeBridge(origin) {
    const seq = ++probeSeq;
    state.live = { phase: 'checking', origin: origin, detail: '' };
    refreshIfMounted();
    let signal;
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      }
    } catch (err) {
      signal = undefined;
    }
    // Goes through the shimmed fetch so it exercises the exact live-forward
    // path the overlay's own polling uses.
    win.fetch('/api/state', { cache: 'no-store', signal: signal })
      .then(function (res) {
        if (seq !== probeSeq) return;
        state.live = res && res.ok
          ? { phase: 'ok', origin: origin, detail: '' }
          : { phase: 'http', origin: origin, detail: String(res ? res.status : '?') };
        refreshIfMounted();
      }, function (err) {
        if (seq !== probeSeq) return;
        state.live = { phase: 'fail', origin: origin, detail: messageOf(err) };
        refreshIfMounted();
      });
  }

  function connectLive(rawValue) {
    let raw = String(rawValue == null ? '' : rawValue).trim();
    if (raw && raw.indexOf('://') === -1) raw = 'http://' + raw;
    const origin = normalizeBridge(raw);
    if (!origin) {
      state.live = { phase: 'invalid', origin: '', detail: '' };
      refreshIfMounted();
      return;
    }
    state.bridge = origin;
    if (refs) refs.bridgeInput.value = origin;
    storageSet(win, MODE_KEY, 'live');
    storageSet(win, BRIDGE_KEY, origin);
    engageBridge(origin, true);
  }

  // Engages cloud mode. The refresh token is read once out of the field,
  // handed to the engine, and the field is wiped in the same turn: it is never
  // stored here and never rendered back into the DOM.
  function connectCloud(rawPrinterId, rawToken) {
    if (!engine || typeof engine.setModeCloud !== 'function') {
      state.cloud = { phase: 'error', detail: 'engine unavailable' };
      refreshIfMounted();
      return;
    }
    const printerId = normalizePrinterId(rawPrinterId);
    if (!printerId) {
      state.cloud = {
        phase: 'invalid',
        detail: 'Enter the printer ID from Prusa Connect: 8 to 64 letters, digits, dashes, or underscores.',
      };
      refreshIfMounted();
      return;
    }
    const token = String(rawToken == null ? '' : rawToken).trim();
    if (refs) refs.tokenInput.value = '';
    const seq = ++cloudSeq;
    demoSeq += 1;
    fileSeq += 1;
    probeSeq += 1;
    state.engineMode = 'cloud';
    state.printerId = printerId;
    clearBridgeBase();
    if (refs) refs.printerInput.value = printerId;
    state.cloud = { phase: 'starting', detail: '' };
    storageSet(win, MODE_KEY, 'cloud');
    const request = { printerUuid: printerId };
    if (token) request.refreshToken = token;
    let pending;
    try {
      pending = Promise.resolve(engine.setModeCloud(request));
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(function () {
      if (seq !== cloudSeq) return;
      state.cloud = { phase: 'engaged', detail: '' };
      refreshIfMounted();
    }, function (err) {
      if (seq !== cloudSeq) return;
      state.cloud = { phase: 'error', detail: messageOf(err) };
      refreshIfMounted();
    });
    refreshIfMounted();
  }

  function forgetCloud() {
    if (refs) {
      refs.tokenInput.value = '';
      refs.printerInput.value = '';
    }
    state.printerId = '';
    cloudSeq += 1;
    storageSet(win, MODE_KEY, 'demo');
    if (!engine || typeof engine.forgetCloudCredentials !== 'function') {
      state.cloud = { phase: 'error', detail: 'this build cannot remove stored credentials' };
      refreshIfMounted();
      return;
    }
    state.cloud = { phase: 'idle', detail: '' };
    refreshIfMounted();
    Promise.resolve()
      .then(function () { return engine.forgetCloudCredentials(); })
      .then(function () {
        state.cloud = { phase: 'forgotten', detail: '' };
        refreshIfMounted();
      }, function (err) {
        state.cloud = { phase: 'error', detail: messageOf(err) };
        refreshIfMounted();
      });
  }

  function seekTo(value) {
    if (!engine || typeof engine.seekPct !== 'function') return;
    const pct = Number(value);
    if (!isFinite(pct)) return;
    try {
      engine.seekPct(Math.max(0, Math.min(100, pct)));
    } catch (err) {
      // nothing loaded yet
    }
  }

  function togglePlay() {
    if (!engine) return;
    const playing = pickPlaying(readEngineStatus());
    try {
      if (playing) {
        if (typeof engine.pause === 'function') engine.pause();
        state.assumedPlaying = false;
      } else {
        if (typeof engine.play === 'function') engine.play();
        state.assumedPlaying = true;
      }
    } catch (err) {
      // refresh below surfaces engine state
    }
    refreshPanel();
  }

  function onModeClick(mode) {
    state.section = mode;
    if (mode === 'demo') {
      storageSet(win, MODE_KEY, 'demo');
      if (engine && (state.engineMode !== 'demo' || state.demo.phase === 'error' || state.demo.phase === 'idle')) {
        startDemo();
      }
    } else if (mode === 'live' && refs && state.bridge && !refs.bridgeInput.value) {
      refs.bridgeInput.value = state.bridge;
    } else if (mode === 'cloud' && refs && state.printerId && !refs.printerInput.value) {
      refs.printerInput.value = state.printerId;
    }
    // 'file', 'live' and 'cloud' persist on successful load / connect, not on
    // tab click, so a reload never lands on a source that cannot be restored.
    refreshPanel();
  }

  // ---- panel construction ----------------------------------------------------

  function buildPanel(doc) {
    const built = {};
    const pageOrigin = (win.location && win.location.origin) || 'this page origin';

    built.panel = makeEl(doc, 'section', '');
    built.panel.id = 'lr-panel';
    built.panel.setAttribute('aria-label', 'Static dashboard controls');
    const card = makeEl(doc, 'div', 'lr-card');
    built.panel.appendChild(card);

    const head = makeEl(doc, 'div', 'lr-head');
    head.appendChild(makeEl(doc, 'span', 'lr-kicker', 'STATIC DASHBOARD'));
    const dot = makeEl(doc, 'span', 'lr-dot');
    dot.setAttribute('aria-hidden', 'true');
    head.appendChild(dot);
    card.appendChild(head);

    const modes = makeEl(doc, 'div', 'lr-modes');
    built.modeButtons = {};
    const defs = [['demo', 'Demo'], ['file', 'Your file'], ['live', 'Live server'],
      ['cloud', 'Prusa Connect']];
    for (let i = 0; i < defs.length; i += 1) {
      const button = makeEl(doc, 'button', 'lr-mode', defs[i][1]);
      button.type = 'button';
      button.setAttribute('data-mode', defs[i][0]);
      button.setAttribute('aria-pressed', 'false');
      built.modeButtons[defs[i][0]] = button;
      modes.appendChild(button);
    }
    card.appendChild(modes);

    built.demoSection = makeEl(doc, 'div', 'lr-section');
    built.demoStatus = makeStatusLine(doc, 'lr-demo-status');
    built.demoSection.appendChild(built.demoStatus);
    card.appendChild(built.demoSection);

    built.fileSection = makeEl(doc, 'div', 'lr-section');
    built.drop = makeEl(doc, 'button', 'lr-drop');
    built.drop.type = 'button';
    built.drop.appendChild(doc.createTextNode('Drop a .bgcode file here'));
    built.drop.appendChild(makeEl(doc, 'small', '', 'or click to browse (.bgcode, .gcode, .bgc)'));
    built.fileSection.appendChild(built.drop);
    built.fileInput = makeEl(doc, 'input', 'lr-hidden-input');
    built.fileInput.type = 'file';
    built.fileInput.id = 'lr-file-input';
    built.fileInput.setAttribute('accept', '.bgcode,.gcode,.bgc');
    built.fileInput.setAttribute('aria-label', 'Choose a print file');
    built.fileSection.appendChild(built.fileInput);
    built.fileStatus = makeStatusLine(doc, 'lr-file-status');
    built.fileSection.appendChild(built.fileStatus);
    card.appendChild(built.fileSection);

    built.liveSection = makeEl(doc, 'div', 'lr-section');
    const bridgeLabel = makeEl(doc, 'label', 'lr-label', 'Server URL');
    bridgeLabel.setAttribute('for', 'lr-bridge');
    built.liveSection.appendChild(bridgeLabel);
    const liveRow = makeEl(doc, 'div', 'lr-live-row');
    built.bridgeInput = makeEl(doc, 'input', 'lr-input');
    built.bridgeInput.type = 'text';
    built.bridgeInput.id = 'lr-bridge';
    built.bridgeInput.setAttribute('placeholder', 'http://127.0.0.1:8787');
    built.bridgeInput.setAttribute('autocomplete', 'off');
    built.bridgeInput.setAttribute('spellcheck', 'false');
    liveRow.appendChild(built.bridgeInput);
    built.connectBtn = makeEl(doc, 'button', 'lr-btn', 'Connect');
    built.connectBtn.type = 'button';
    liveRow.appendChild(built.connectBtn);
    built.liveSection.appendChild(liveRow);
    built.liveStatus = makeStatusLine(doc, 'lr-live-status');
    built.liveSection.appendChild(built.liveStatus);
    const note = makeEl(doc, 'p', 'lr-note');
    note.appendChild(doc.createTextNode('The server config must list this page origin ('));
    note.appendChild(makeEl(doc, 'code', '', pageOrigin));
    note.appendChild(doc.createTextNode(') in '));
    note.appendChild(makeEl(doc, 'code', '', 'apiReadAllowedOrigins'));
    note.appendChild(doc.createTextNode('. '));
    note.appendChild(makeLink(doc, 'Setup guide', DOCS_URL));
    note.appendChild(doc.createTextNode('.'));
    built.liveSection.appendChild(note);
    card.appendChild(built.liveSection);

    built.cloudSection = makeEl(doc, 'div', 'lr-section');
    const printerField = makeEl(doc, 'div', 'lr-field');
    const printerLabel = makeEl(doc, 'label', 'lr-label', 'Printer ID');
    printerLabel.setAttribute('for', 'lr-connect-printer');
    printerField.appendChild(printerLabel);
    built.printerInput = makeEl(doc, 'input', 'lr-input');
    built.printerInput.type = 'text';
    built.printerInput.id = 'lr-connect-printer';
    built.printerInput.setAttribute('placeholder', 'printer id from Prusa Connect');
    built.printerInput.setAttribute('autocomplete', 'off');
    built.printerInput.setAttribute('spellcheck', 'false');
    printerField.appendChild(built.printerInput);
    built.cloudSection.appendChild(printerField);

    const tokenField = makeEl(doc, 'div', 'lr-field');
    const tokenLabel = makeEl(doc, 'label', 'lr-label', 'Refresh token');
    tokenLabel.setAttribute('for', 'lr-connect-token');
    tokenField.appendChild(tokenLabel);
    built.tokenInput = makeEl(doc, 'input', 'lr-input');
    // Never a readable field, never repopulated: once handed to the engine the
    // value is wiped and only connect-auth's storage holds the chain.
    built.tokenInput.type = 'password';
    built.tokenInput.id = 'lr-connect-token';
    built.tokenInput.setAttribute('placeholder', 'paste once, or leave blank to reuse');
    built.tokenInput.setAttribute('autocomplete', 'off');
    built.tokenInput.setAttribute('spellcheck', 'false');
    tokenField.appendChild(built.tokenInput);
    built.cloudSection.appendChild(tokenField);

    const cloudRow = makeEl(doc, 'div', 'lr-cloud-row');
    built.cloudBtn = makeEl(doc, 'button', 'lr-btn', 'Connect');
    built.cloudBtn.type = 'button';
    cloudRow.appendChild(built.cloudBtn);
    // A stored refresh token mints access tokens for the whole Prusa account,
    // so removing it has to be one click, not "clear your site data".
    built.forgetBtn = makeEl(doc, 'button', 'lr-btn', 'Forget token');
    built.forgetBtn.type = 'button';
    cloudRow.appendChild(built.forgetBtn);
    built.cloudSection.appendChild(cloudRow);

    built.cloudStatus = makeStatusLine(doc, 'lr-cloud-status');
    built.cloudSection.appendChild(built.cloudStatus);

    const warn = makeEl(doc, 'div', 'lr-warn');
    warn.setAttribute('role', 'note');
    warn.appendChild(makeEl(doc, 'strong', '', 'ONE TOKEN CHAIN, ONE CONSUMER'));
    warn.appendChild(doc.createTextNode(
      'Prusa rotates the refresh token every single time it is used. Do not connect here while ' +
      'a LayerRelay server, or a second tab of this page, uses the same token: whichever one ' +
      'loses the race ends up with a dead chain and you have to capture a new token by hand. '));
    warn.appendChild(makeLink(doc, 'How to capture a token', CONNECT_DOCS_URL));
    warn.appendChild(doc.createTextNode('.'));
    built.cloudSection.appendChild(warn);

    const cloudNote = makeEl(doc, 'p', 'lr-note');
    cloudNote.appendChild(doc.createTextNode(
      'The token stays in this browser and is sent only to '));
    cloudNote.appendChild(makeEl(doc, 'code', '', 'account.prusa3d.com'));
    cloudNote.appendChild(doc.createTextNode(
      '. This page has no backend. Live telemetry covers state, progress, temperatures, ' +
      'the active tool and Z; drop the printing .bgcode for the job name, thumbnail, layers ' +
      'and swap map. There is no camera in cloud mode.'));
    built.cloudSection.appendChild(cloudNote);
    card.appendChild(built.cloudSection);

    built.replay = makeEl(doc, 'div', 'lr-replay');
    const replayRow = makeEl(doc, 'div', 'lr-replay-row');
    built.playBtn = makeEl(doc, 'button', 'lr-btn lr-play', 'Pause');
    built.playBtn.type = 'button';
    replayRow.appendChild(built.playBtn);
    const speedLabel = makeEl(doc, 'label', 'lr-label', 'Speed');
    speedLabel.setAttribute('for', 'lr-speed');
    replayRow.appendChild(speedLabel);
    built.speedSel = makeEl(doc, 'select', 'lr-select lr-speed');
    built.speedSel.id = 'lr-speed';
    for (let i = 0; i < SPEEDS.length; i += 1) {
      const option = makeEl(doc, 'option', '', SPEEDS[i] + 'x');
      option.value = String(SPEEDS[i]);
      built.speedSel.appendChild(option);
    }
    replayRow.appendChild(built.speedSel);
    built.replay.appendChild(replayRow);
    built.scrub = makeEl(doc, 'input', 'lr-scrub');
    built.scrub.type = 'range';
    built.scrub.setAttribute('min', '0');
    built.scrub.setAttribute('max', '100');
    built.scrub.setAttribute('step', '0.1');
    built.scrub.value = '0';
    built.scrub.setAttribute('aria-label', 'Replay position');
    built.replay.appendChild(built.scrub);
    card.appendChild(built.replay);

    built.errorLine = makeEl(doc, 'p', 'lr-error');
    built.errorLine.id = 'lr-error';
    built.errorLine.hidden = true;
    card.appendChild(built.errorLine);

    const foot = makeEl(doc, 'div', 'lr-foot');
    foot.appendChild(doc.createTextNode('All processing runs in your browser. '));
    foot.appendChild(makeLink(doc, 'Source & AGPL license', SOURCE_URL));
    card.appendChild(foot);

    return built;
  }

  // ---- fade + events ---------------------------------------------------------

  function scheduleIdle(delay) {
    win.clearTimeout(idleTimer);
    idleTimer = null;
    if (interacting) return;
    idleTimer = win.setTimeout(function () {
      if (!interacting && refs) refs.panel.classList.add('lr-idle');
    }, delay == null ? IDLE_HIDE_MS : delay);
  }

  function reveal() {
    if (!refs) return;
    refs.panel.classList.remove('lr-idle');
    scheduleIdle(IDLE_HIDE_MS);
  }

  function dragHasFiles(event) {
    const types = event && event.dataTransfer && event.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  function wirePanel(doc) {
    const names = MODES;
    for (let i = 0; i < names.length; i += 1) {
      (function (mode) {
        refs.modeButtons[mode].addEventListener('click', function () { onModeClick(mode); });
      })(names[i]);
    }
    refs.drop.addEventListener('click', function () {
      if (engine && typeof refs.fileInput.click === 'function') refs.fileInput.click();
    });
    refs.fileInput.addEventListener('change', function () {
      const file = refs.fileInput.files && refs.fileInput.files[0];
      refs.fileInput.value = '';
      if (file) loadLocalFile(file);
    });
    refs.connectBtn.addEventListener('click', function () { connectLive(refs.bridgeInput.value); });
    refs.bridgeInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        connectLive(refs.bridgeInput.value);
      }
    });
    function submitCloud() {
      connectCloud(refs.printerInput.value, refs.tokenInput.value);
    }
    refs.cloudBtn.addEventListener('click', submitCloud);
    refs.forgetBtn.addEventListener('click', forgetCloud);
    for (const field of [refs.printerInput, refs.tokenInput]) {
      field.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        submitCloud();
      });
    }
    refs.playBtn.addEventListener('click', togglePlay);
    refs.speedSel.addEventListener('change', function () {
      const value = Number(refs.speedSel.value);
      state.speed = SPEEDS.indexOf(value) === -1 ? DEFAULT_SPEED : value;
      storageSet(win, SPEED_KEY, String(state.speed));
      applySpeed();
    });
    refs.scrub.addEventListener('input', function () {
      lastScrubAt = Date.now();
      seekTo(refs.scrub.value);
    });
    refs.scrub.addEventListener('change', function () {
      seekTo(refs.scrub.value);
      lastScrubAt = 0;
    });

    // Auto-fade mirrors the overlay's #dashboard-controls behavior.
    doc.addEventListener('pointermove', function () {
      const now = Date.now();
      if (now - lastReveal < REVEAL_THROTTLE_MS) return;
      lastReveal = now;
      reveal();
    });
    doc.addEventListener('keydown', function (event) {
      if (event.key === 'Tab') reveal();
    });
    refs.panel.addEventListener('pointerenter', function () {
      interacting = true;
      win.clearTimeout(idleTimer);
      idleTimer = null;
      refs.panel.classList.remove('lr-idle');
    });
    refs.panel.addEventListener('pointerleave', function () {
      interacting = false;
      scheduleIdle(IDLE_LEAVE_MS);
    });
    refs.panel.addEventListener('focusin', function () {
      interacting = true;
      refs.panel.classList.remove('lr-idle');
    });
    refs.panel.addEventListener('focusout', function () {
      interacting = false;
      scheduleIdle(IDLE_LEAVE_MS);
    });

    // Whole-window drag and drop loads a file from anywhere on the page.
    win.addEventListener('dragenter', function (event) {
      if (!dragHasFiles(event)) return;
      dragDepth += 1;
      refs.panel.classList.add('lr-dropping');
      reveal();
    });
    win.addEventListener('dragover', function (event) {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    win.addEventListener('dragleave', function (event) {
      if (!dragHasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) refs.panel.classList.remove('lr-dropping');
    });
    win.addEventListener('drop', function (event) {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      refs.panel.classList.remove('lr-dropping');
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) {
        // In cloud mode the file feeds the live card; the file tab is still
        // where its decode progress belongs.
        state.section = 'file';
        loadLocalFile(file);
      }
    });
  }

  // ---- rendering -------------------------------------------------------------

  function setStatus(node, text, bad) {
    node.textContent = text;
    if (bad) node.classList.add('lr-bad');
    else node.classList.remove('lr-bad');
  }

  function demoStatusText(analyzing) {
    if (!engine) return ['Engine unavailable.', true];
    if (state.demo.phase === 'error') return ['Could not load the demo: ' + state.demo.error, true];
    if (state.demo.phase === 'loading') return ['Loading demo print…', false];
    if (state.demo.phase === 'ready') {
      if (analyzing && state.engineMode === 'demo') return ['Decoding demo print…', false];
      return ['Synthetic demo print, decoded and replayed in this tab.', false];
    }
    return ['Demo not loaded yet.', false];
  }

  function fileStatusText(analyzing) {
    if (!engine) return ['Engine unavailable.', true];
    const f = state.file;
    if (!f) {
      return state.engineMode === 'cloud'
        ? ['Drop the .bgcode that is printing to add the job name, thumbnail, layers, and swap map.', false]
        : ['Drop a .bgcode or .gcode file anywhere on this page, or click to browse.', false];
    }
    if (f.phase === 'error') return ['Could not decode ' + f.name + ': ' + f.error, true];
    if (f.phase === 'reading') return ['Reading ' + f.name + '…', false];
    if (f.phase === 'decoding') return ['Analyzing ' + f.name + '…', false];
    if (analyzing && (state.engineMode === 'file' || state.engineMode === 'cloud')) {
      return ['Analyzing ' + f.name + '…', false];
    }
    if (state.engineMode === 'cloud') return ['Merging ' + f.name + ' into the live Connect data.', false];
    return ['Loaded ' + f.name + '.', false];
  }

  function cloudStatusText(status) {
    if (!engine) return ['Engine unavailable.', true];
    const local = state.cloud;
    if (local.phase === 'invalid') return [local.detail, true];
    if (local.phase === 'error') return ['Prusa Connect failed: ' + local.detail, true];
    if (local.phase === 'forgotten') {
      return ['Removed the stored refresh token and printer ID from this browser.', false];
    }
    const cloud = status && status.cloud;
    if (!cloud) {
      if (local.phase === 'starting') return ['Starting Prusa Connect…', false];
      return ['Enter the printer ID and paste a Prusa Connect refresh token.', false];
    }
    if (cloud.phase === 'error') {
      return [cloud.error || 'The Prusa Connect link failed.', true];
    }
    if (cloud.phase === 'retrying') {
      const seconds = Math.max(1, Math.ceil((cloud.retryInMs || 0) / 1000));
      return [(cloud.error || 'Link lost.') + ' Reconnecting in ' + seconds + 's.', true];
    }
    if (cloud.phase === 'live') {
      const topics = cloud.topics + (cloud.topics === 1 ? ' topic' : ' topics');
      const tail = state.file && state.file.phase === 'ready'
        ? '' : ' Drop the printing .bgcode to fill in layers and swaps.';
      return ['Live: ' + topics + ' from ' + cloud.printerUuid + '.' + tail, false];
    }
    if (cloud.phase === 'connecting') return ['Connecting to Prusa Connect…', false];
    return ['Not connected.', false];
  }

  function liveStatusText() {
    const live = state.live;
    switch (live.phase) {
      case 'invalid':
        return ['Enter an http(s) origin such as http://127.0.0.1:8787 (no path).', true];
      case 'dead':
        return ['Engine unavailable.', true];
      case 'error':
        return ['Live mode failed: ' + live.detail, true];
      case 'set':
      case 'checking':
        return ['Checking ' + live.origin + '…', false];
      case 'ok':
        return ['Connected to ' + live.origin + '.', false];
      case 'http':
        return ['HTTP ' + live.detail + ' from ' + live.origin +
          '. Add this page origin to apiReadAllowedOrigins on the server.', true];
      case 'fail':
        return ['Could not reach ' + live.origin +
          '. Check that LayerRelay is running and that apiReadAllowedOrigins includes this page origin.', true];
      default:
        return ['Enter the URL of a running LayerRelay server.', false];
    }
  }

  function refreshPanel() {
    if (!refs) return;
    const status = readEngineStatus();
    const analyzing = !!(status && status.analyzing);
    const statusError = status && status.error ? messageOf(status.error) : null;

    for (let i = 0; i < MODES.length; i += 1) {
      const mode = MODES[i];
      refs.modeButtons[mode].setAttribute('aria-pressed', mode === state.section ? 'true' : 'false');
    }
    refs.demoSection.hidden = state.section !== 'demo';
    refs.fileSection.hidden = state.section !== 'file';
    refs.liveSection.hidden = state.section !== 'live';
    refs.cloudSection.hidden = state.section !== 'cloud';
    refs.replay.hidden = state.section === 'live' || state.section === 'cloud' ||
      state.engineMode === 'cloud';

    const demoText = demoStatusText(analyzing);
    setStatus(refs.demoStatus, demoText[0], demoText[1]);
    const fileText = fileStatusText(analyzing);
    setStatus(refs.fileStatus, fileText[0], fileText[1]);
    const liveText = liveStatusText();
    setStatus(refs.liveStatus, liveText[0], liveText[1]);
    const cloudText = cloudStatusText(status);
    setStatus(refs.cloudStatus, cloudText[0], cloudText[1]);

    const fileReady = !!(state.file && state.file.phase === 'ready');
    const replayReady = state.engineMode === 'demo' ? state.demo.phase === 'ready'
      : state.engineMode === 'file' ? fileReady : false;
    const controlsOn = !!engine && replayReady && !analyzing;
    refs.playBtn.disabled = !controlsOn;
    refs.scrub.disabled = !controlsOn;
    refs.speedSel.disabled = !engine;
    refs.drop.disabled = !engine;
    refs.connectBtn.disabled = !engine;
    refs.cloudBtn.disabled = !engine;
    refs.forgetBtn.disabled = !engine;
    refs.playBtn.textContent = pickPlaying(status) ? 'Pause' : 'Play';

    const progress = pickNumber(status, ['progressPct', 'progress', 'pct']);
    if (progress != null && Date.now() - lastScrubAt > SCRUB_HOLDOFF_MS) {
      refs.scrub.value = String(Math.max(0, Math.min(100, progress)));
    }
    refs.speedSel.value = String(SPEEDS.indexOf(state.speed) === -1 ? DEFAULT_SPEED : state.speed);

    let globalError = null;
    if (engineError) {
      globalError = 'Static engine failed to start: ' + messageOf(engineError);
    } else if (statusError) {
      const sectionError = (state.section === 'demo' && state.demo.error) ||
        (state.section === 'file' && state.file && state.file.error) ||
        (state.section === 'cloud' && state.cloud.detail) || null;
      if (sectionError !== statusError) globalError = statusError;
    }
    refs.errorLine.hidden = !globalError;
    refs.errorLine.textContent = globalError || '';
  }

  // ---- public surface --------------------------------------------------------

  // DOM-free activation of the persisted / URL-selected mode. Runs at bundle
  // evaluation so the overlay's very first poll already hits live data even
  // when the panel is hidden by ?controls=0.
  function boot() {
    if (!engine) return;
    if (typeof engine.onChange === 'function') {
      try {
        engine.onChange(function () { refreshIfMounted(); });
      } catch (err) {
        // engine without change events: the 500 ms refresh loop covers it
      }
    }
    applySpeed();
    if (startup.mode === 'demo') startDemo();
    else if (startup.mode === 'live' && startup.bridge) engageBridge(startup.bridge, false);
    // Cloud mode resumes on the refresh token connect-auth already persisted;
    // no token is passed here, so nothing is read out of storage by this
    // module. A chain that died surfaces the engine's invalid_grant message.
    else if (startup.mode === 'cloud' && startup.printerId) {
      connectCloud(startup.printerId, '');
    }
    // 'file' (and live/cloud without a saved target) wait for user input; the
    // overlay shows its own offline shell until then.
  }

  function mountPanel() {
    if (mounted) return null;
    mounted = true;
    if (!startup.controlsEnabled) return null; // ?controls=0: no panel, no drop targets
    const doc = win.document;
    if (!doc || !doc.body || !doc.head) return null;
    const style = doc.createElement('style');
    style.textContent = PANEL_CSS;
    doc.head.appendChild(style);
    refs = buildPanel(doc);
    if (state.bridge) refs.bridgeInput.value = state.bridge;
    if (state.printerId) refs.printerInput.value = state.printerId;
    wirePanel(doc);
    doc.body.appendChild(refs.panel);
    if (state.engineMode === 'live' && state.live.phase === 'set') probeBridge(state.live.origin);
    refreshPanel();
    win.setInterval(function () { refreshPanel(); }, REFRESH_MS);
    scheduleIdle(IDLE_FIRST_MS);
    return refs.panel;
  }

  return {
    boot: boot,
    mountPanel: mountPanel,
    startup: startup,
  };
}
