'use strict';
// Prusa Connect (cloud) client. Unlike the local PrusaLink API, Connect exposes the INDX
// toolchanger's ACTIVE tool directly, plus full live telemetry, from a single REST call:
//   GET https://connect.prusa3d.com/app/printers/{uuid}
// Auth is the Prusa *account* OAuth2 access token (OIDC, account.prusa3d.com). Access tokens
// last ~2h; we keep one alive by exchanging a long-lived refresh token at the token endpoint.
// Django-OAuth-Toolkit ROTATES the refresh token on every use, so each new one is persisted to
// disk, otherwise the stored token dies after the first refresh.
const { readJsonWithBackup, writeJsonAtomic } = require('./persistence.js');
const { sameJobKey } = require('./job-lifecycle.js');
const { createHttpsRequest } = require('./https-request.js');

const ACCOUNT_HOST = 'account.prusa3d.com';
const TOKEN_PATH = '/o/token/';                 // confirmed: GET -> 405 allow=POST
const CONNECT_HOST = 'connect.prusa3d.com';
const CONNECT_ORIGIN = `https://${CONNECT_HOST}`;
const DEFAULT_CONNECT_FILE_BYTES = 512 * 1024 * 1024;
const INCOMPLETE_ASSET_RETRY_MS = 30000;
// Public SPA client id (from Connect's environment.js). Overridable via cfg.connectClientId.
const DEFAULT_CLIENT_ID = 'MRHTlZhZqkNrrQ6FUPtjyusAz8nc59ErHXP8XkS4'; // gitleaks:allow -- public browser client identifier, not a credential
const httpsRequest = createHttpsRequest();

// Holds the access token + expiry and the rotating refresh token (seeded from config, then
// persisted to tokenFile as it rotates so restarts keep working).
class ConnectAuth {
  constructor(cfg, tokenFile) {
    this.clientId = cfg.connectClientId || DEFAULT_CLIENT_ID;
    this.tokenFile = tokenFile;
    this.accessToken = null;
    this.expiresAt = 0;
    this.persistPending = false;
    this.refreshPromise = null;
    const persisted = readJsonWithBackup(tokenFile, null);
    // Prefer the persisted (already-rotated) token; fall back to the one seeded in config.
    this.refreshToken = (persisted && persisted.refresh_token) || cfg.connectRefreshToken || null;
  }

  hasCredentials() { return !!this.refreshToken; }

  async getAccessToken() {
    if (this.persistPending) this.persistRefreshToken();
    if (this.refreshPromise) return this.refreshPromise;
    // Refresh a minute before expiry so an in-flight request never carries a dead token.
    if (this.accessToken && Date.now() < this.expiresAt - 60000) return this.accessToken;
    return this.refresh();
  }

  async refresh() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshOnce().finally(() => { this.refreshPromise = null; });
    }
    return this.refreshPromise;
  }

  async refreshOnce() {
    if (!this.refreshToken) throw new Error('no Connect refresh token configured');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
    }).toString();
    const r = await httpsRequest(ACCOUNT_HOST, {
      method: 'POST', path: TOKEN_PATH,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, body);
    if (r.status !== 200) throw new Error(`token refresh HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    if (!j.access_token) throw new Error('token refresh: no access_token in response');
    this.accessToken = j.access_token;
    this.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
    // Persist the (rotated) refresh token so the next process/refresh uses the live one.
    if (j.refresh_token) this.refreshToken = j.refresh_token;
    this.persistPending = true;
    this.persistRefreshToken();
    return this.accessToken;
  }

  persistRefreshToken() {
    writeJsonAtomic(this.tokenFile, { refresh_token: this.refreshToken, savedAt: Date.now() });
    this.persistPending = false;
  }
}

function resolveConnectPath(value, allowedPrefixes) {
  const url = new URL(String(value || ''), `${CONNECT_ORIGIN}/`);
  if (url.origin !== CONNECT_ORIGIN || url.username || url.password ||
      !allowedPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    throw new Error('refusing non-Prusa Connect resource URL');
  }
  return `${url.pathname}${url.search}`;
}

// Authenticated Connect GET. On a 401 (token revoked/expired early), force one refresh and retry.
async function connectGet(auth, requestPath, options = {}) {
  const path = resolveConnectPath(requestPath, options.allowedPrefixes || ['/app/']);
  const get = (tok) => httpsRequest(CONNECT_HOST, {
    method: 'GET', path, signal: options.signal,
    headers: { Authorization: `Bearer ${tok}`, Accept: options.accept || 'application/json' },
  }, null, options.timeoutMs || 12000, {
    asBuffer: !!options.asBuffer,
    maxResponseBytes: options.maxResponseBytes,
  });
  const token = await auth.getAccessToken();
  let r = await get(token);
  if (r.status === 401) {
    // Another request may already have rotated the token. Reuse its new access token instead
    // of rotating the one-use refresh token a second time.
    const currentToken = await auth.getAccessToken();
    r = await get(currentToken !== token ? currentToken : await auth.refresh());
  }
  return r;
}

async function fetchPrinter(auth, uuid, timeoutMs = 12000) {
  const r = await connectGet(auth, `/app/printers/${encodeURIComponent(uuid)}`, {
    timeoutMs, allowedPrefixes: ['/app/printers/'],
  });
  if (r.status !== 200) throw new Error(`connect printer HTTP ${r.status}`);
  return JSON.parse(r.body);
}

async function fetchPrinterJob(auth, uuid, jobId, timeoutMs = 12000) {
  const r = await connectGet(auth,
    `/app/printers/${encodeURIComponent(uuid)}/jobs/${encodeURIComponent(jobId)}`,
    { timeoutMs, allowedPrefixes: ['/app/printers/'] });
  if (r.status !== 200) throw new Error(`connect job HTTP ${r.status}`);
  return JSON.parse(r.body);
}

async function fetchConnectAsset(auth, resourceUrl, options = {}) {
  const r = await connectGet(auth, resourceUrl, {
    allowedPrefixes: ['/app/teams/'],
    accept: options.accept || '*/*',
    asBuffer: true,
    maxResponseBytes: options.maxResponseBytes || DEFAULT_CONNECT_FILE_BYTES,
    signal: options.signal,
    timeoutMs: options.timeoutMs || 600000,
  });
  if (r.status !== 200) throw new Error(`connect asset HTTP ${r.status}`);
  return r;
}

const connectBasename = (value) => String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';

// Normalize the Connect job-detail response into the small, credential-free descriptor the
// server persists. Printer-local short names remain the cache identity; the long display name
// lets localBgcodeDirs find a previously downloaded copy before a cloud download is attempted.
function mapConnectJobAssets(detail, fallback = {}) {
  const job = detail && typeof detail === 'object' ? (detail.job || detail) : {};
  const file = job.file && typeof job.file === 'object' ? job.file : {};
  const teamId = file.team_id ?? job.team_id ?? fallback.teamId ?? null;
  const hash = file.hash ?? job.file_hash ?? fallback.hash ?? null;
  const fileName = connectBasename(fallback.fileName || file.path || file.name || job.path || fallback.displayName);
  const displayName = String(file.display_name || file.name || job.display_name ||
    fallback.displayName || fallback.name || fileName || '').trim();
  const sizeNumber = Number(file.size ?? job.size);
  const previewPath = file.preview_url || job.preview_url || fallback.previewUrl || null;
  const rawPath = teamId != null && hash != null
    ? `/app/teams/${encodeURIComponent(teamId)}/files/${encodeURIComponent(hash)}/raw`
    : null;
  return {
    connectJobId: job.id ?? fallback.connectJobId ?? null,
    file: {
      name: fileName || connectBasename(displayName),
      display_name: displayName,
      size: Number.isFinite(sizeNumber) ? sizeNumber : null,
      refs: {},
    },
    previewPath,
    rawPath,
  };
}

function connectAssetsNeedRefresh(descriptor, jobKey, connectJobId, nowMs = Date.now()) {
  const identityMatches = descriptor && sameJobKey(descriptor.jobKey, jobKey) &&
    String(descriptor.connectJobId) === String(connectJobId);
  if (!identityMatches) return true;
  if (descriptor.rawPath && descriptor.previewPath) return false;
  return nowMs - (Number(descriptor.savedAt) || 0) >= INCOMPLETE_ASSET_RETRY_MS;
}

// Connect state strings -> the overlay's known set (PRINTING/PAUSED/FINISHED/ERROR/IDLE).
const STATE_MAP = {
  PRINTING: 'PRINTING', PAUSED: 'PAUSED', PAUSING: 'PRINTING', RESUMING: 'PRINTING',
  FINISHED: 'FINISHED', STOPPED: 'IDLE', IDLE: 'IDLE', READY: 'IDLE',
  ATTENTION: 'ERROR', ERROR: 'ERROR',
};

function hasJobIdentity(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.id != null || job.origin_id != null) return true;
  if (typeof job.display_name === 'string' && job.display_name.trim()) return true;
  if (typeof job.path === 'string' && job.path.trim()) return true;
  const file = job.file;
  return !!(file && typeof file === 'object' &&
    ((typeof file.name === 'string' && file.name.trim()) ||
     (typeof file.display_name === 'string' && file.display_name.trim())));
}

const ACTIVITY_LABELS = {
  CALIBRATION: 'Calibrating',
  SELFTEST: 'Running self-test',
  HOMING: 'Homing',
  FILAMENT_LOAD: 'Loading filament',
  FILAMENT_UNLOAD: 'Unloading filament',
  MAINTENANCE: 'Maintenance',
  OPERATION: 'Printer busy',
};

const cleanActivityText = (value) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
  : '';

function activityKindFromText(value) {
  const text = cleanActivityText(value).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  if (!text) return null;
  if (/\b(?:NEEDED|REQUIRED|RECOMMENDED|AVAILABLE|FAILED|COMPLETE|COMPLETED|DONE)\b/.test(text)) return null;
  if (/\b(?:UNLOAD(?:ING)? FILAMENT|FILAMENT UNLOAD(?:ING)?)\b/.test(text)) return 'FILAMENT_UNLOAD';
  if (/\b(?:LOAD(?:ING)? FILAMENT|FILAMENT LOAD(?:ING)?)\b/.test(text)) return 'FILAMENT_LOAD';
  if (/\b(?:SELF ?TEST|SELF ?CHECK)\b/.test(text)) return 'SELFTEST';
  if (/\b(?:CALIBRAT(?:E|ING|ION)|BED LEVEL(?:ING)?|MESH BED|INPUT SHAPER|PHASE STEPPING|DOCK CALIBRATION|TOOL CALIBRATION)\b/.test(text)) return 'CALIBRATION';
  if (/\b(?:HOMING|HOME AXES?|G28)\b/.test(text)) return 'HOMING';
  if (/\b(?:MAINTENANCE|SERVICE|BELT TUNING|NOZZLE CLEANING|GEARBOX ALIGNMENT|LUBRICATION)\b/.test(text)) return 'MAINTENANCE';
  return null;
}

function activityProgress(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function makeActivity(kind, detail = null, progress = null) {
  return {
    active: true,
    kind,
    label: ACTIVITY_LABELS[kind],
    detail: cleanActivityText(detail) || null,
    progress: activityProgress(progress),
  };
}

const EXPLICIT_ACTIVITY_KEYS = ['activity', 'operation', 'phase', 'status', 'message', 'title', 'text', 'dialog', 'screen', 'wizard', 'command'];
const EXPLICIT_TEXT_KEYS = ['kind', 'type', 'name', 'title', 'label', 'state', 'status', 'phase', 'action', 'message'];

function explicitActivityCandidates(source) {
  if (!source || typeof source !== 'object') return [];
  const candidates = [];
  for (const key of EXPLICIT_ACTIVITY_KEYS) {
    const value = source[key];
    if (typeof value === 'string') {
      candidates.push({ text: value, progress: source[`${key}_progress`] ?? source.progress });
    } else if (value && typeof value === 'object') {
      for (const textKey of EXPLICIT_TEXT_KEYS) {
        if (typeof value[textKey] === 'string') {
          candidates.push({ text: value[textKey], progress: value.progress ?? value.percent ?? source.progress });
        }
      }
    }
  }
  return candidates;
}

function jobNameCandidates(source) {
  if (!source || typeof source !== 'object') return [];
  const jobLike = source.display_name != null || source.file != null || source.progress != null ||
    source.time_remaining != null || source.time_printing != null;
  const values = jobLike ? [source.display_name, source.name, source.path] : [];
  if (source.file && typeof source.file === 'object') {
    values.push(source.file.display_name, source.file.name, source.file.path);
  }
  if (source.job_info && typeof source.job_info === 'object') {
    values.push(...jobNameCandidates(source.job_info));
  }
  return values.filter((value) => typeof value === 'string' && value.trim());
}

function firstProgress(sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const value = source.progress ?? (source.job_info && source.job_info.progress);
    if (value != null && Number.isFinite(Number(value))) return value;
  }
  return null;
}

function classifyActivity(rawState, ...sources) {
  const stateKind = activityKindFromText(rawState);
  if (stateKind) return { activity: makeActivity(stateKind), source: 'state' };

  for (const source of sources) {
    for (const candidate of explicitActivityCandidates(source)) {
      const kind = activityKindFromText(candidate.text);
      if (kind) return { activity: makeActivity(kind, candidate.text, candidate.progress), source: 'explicit' };
    }
  }

  const raw = String(rawState || '').toUpperCase();
  if (['PRINTING', 'PAUSED', 'PAUSING', 'RESUMING', 'BUSY'].includes(raw)) {
    for (const source of sources) {
      for (const name of jobNameCandidates(source)) {
        const kind = activityKindFromText(name);
        if (kind) return { activity: makeActivity(kind, name, firstProgress(sources)), source: 'inferred' };
      }
    }
  }

  if (raw === 'BUSY' && !sources.some(hasJobIdentity)) {
    return { activity: makeActivity('OPERATION'), source: 'busy' };
  }
  return null;
}

function classifyPrinterActivity(rawState, ...sources) {
  const result = classifyActivity(rawState, ...sources);
  return result ? result.activity : null;
}

// BUSY with a real job is a print. BUSY without one is a non-print operation and stays distinct
// from IDLE; more specific explicit operation states are also normalized to BUSY.
function normalizePrinterState(rawState, ...jobs) {
  const raw = String(rawState || '').toUpperCase();
  const classified = classifyActivity(raw, ...jobs);
  if (raw === 'BUSY') return jobs.some(hasJobIdentity) ? 'PRINTING' : 'BUSY';
  if (classified && classified.source === 'state') return 'BUSY';
  if (classified && classified.source === 'explicit' && !jobs.some(hasJobIdentity) &&
      !['ERROR', 'ATTENTION', 'FINISHED', 'STOPPED'].includes(raw)) return 'BUSY';
  return STATE_MAP[raw] || 'UNKNOWN';
}

// Map a Connect printer-detail object to the telemetry subset the overlay/server state uses.
// cleanName is the server's filename cleaner (passed in to avoid duplicating it here).
function mapConnectToState(j, cleanName) {
  const job = j.job_info || {};
  const t = j.temp || {};
  // Active tool = the entry in `tools` flagged active. Connect keys tools 1-based, which already
  // matches the printer UI / our toolLabel; our internal currentTool stays 0-based.
  let activeKey = null;
  if (j.tools) for (const k of Object.keys(j.tools)) { if (j.tools[k] && j.tools[k].active) { activeKey = k; break; } }
  const tool = activeKey ? j.tools[activeKey] : null;
  const toolLabel = activeKey != null ? parseInt(activeKey, 10) : null;
  const currentTool = toolLabel != null ? toolLabel - 1 : null;

  const st = normalizePrinterState(j.state, j, job);
  const printing = st === 'PRINTING' || st === 'PAUSED';
  const num = (v) => (v != null ? v : null);

  // CORE One chamber telemetry. The firmware sends a top-level `chamber` object
  // ({temp, target_temp}, see Prusa-Firmware-Buddy src/connect/render.cpp); accept a
  // flat temp_chamber spelling too in case Connect regroups it like the nozzle/bed temps.
  const ch = j.chamber || {};

  return {
    state: st,
    activity: classifyPrinterActivity(j.state, j, job),
    name: cleanName(job.display_name || ''),
    chamberTemp: num(ch.temp ?? t.temp_chamber),
    chamberTarget: num(ch.target_temp ?? t.target_chamber),
    progress: printing ? num(job.progress) : null,
    timeRemainingSec: num(job.time_remaining),
    timeElapsedSec: num(job.time_printing),
    nozzleTemp: num(t.temp_nozzle),
    nozzleTarget: num(t.target_nozzle),
    bedTemp: num(t.temp_bed),
    bedTarget: num(t.target_bed),
    axisZ: num(j.axis_z),
    flow: num(j.flow),
    speed: num(j.speed),
    fanHotend: tool ? num(tool.fan_hotend) : null,
    fanPrint: tool ? num(tool.fan_print) : null,
    currentTool,
    toolLabel,
    material: (tool && tool.material) || (j.filament && j.filament.material) || null,
    // Connect reports the whole-model filament weight; use it as the print's total.
    filamentG: job.model_weight != null ? Math.round(job.model_weight) : null,
    jobId: job.origin_id != null ? job.origin_id : (job.id != null ? job.id : null),
    connectJobId: job.id != null ? job.id : null,
    fileName: job.path ? job.path.split('/').pop() : null,
    previewUrl: job.preview_url || null,
    printing,
  };
}

module.exports = {
  ConnectAuth,
  classifyPrinterActivity,
  connectAssetsNeedRefresh,
  fetchConnectAsset,
  fetchPrinter,
  fetchPrinterJob,
  mapConnectJobAssets,
  mapConnectToState,
  normalizePrinterState,
  resolveConnectPath,
};
