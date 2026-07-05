'use strict';
// Prusa Connect (cloud) client. Unlike the local PrusaLink API, Connect exposes the INDX
// toolchanger's ACTIVE tool directly, plus full live telemetry, from a single REST call:
//   GET https://connect.prusa3d.com/app/printers/{uuid}
// Auth is the Prusa *account* OAuth2 access token (OIDC, account.prusa3d.com). Access tokens
// last ~2h; we keep one alive by exchanging a long-lived refresh token at the token endpoint.
// Django-OAuth-Toolkit ROTATES the refresh token on every use, so each new one is persisted to
// disk, otherwise the stored token dies after the first refresh.
const https = require('https');
const fs = require('fs');

const ACCOUNT_HOST = 'account.prusa3d.com';
const TOKEN_PATH = '/o/token/';                 // confirmed: GET -> 405 allow=POST
const CONNECT_HOST = 'connect.prusa3d.com';
// Public SPA client id (from Connect's environment.js). Overridable via cfg.connectClientId.
const DEFAULT_CLIENT_ID = 'MRHTlZhZqkNrrQ6FUPtjyusAz8nc59ErHXP8XkS4';

function httpsRequest(host, { method, path, headers }, bodyStr, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, method, path, headers: headers || {}, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Holds the access token + expiry and the rotating refresh token (seeded from config, then
// persisted to tokenFile as it rotates so restarts keep working).
class ConnectAuth {
  constructor(cfg, tokenFile) {
    this.clientId = cfg.connectClientId || DEFAULT_CLIENT_ID;
    this.tokenFile = tokenFile;
    this.accessToken = null;
    this.expiresAt = 0;
    let persisted = null;
    try { persisted = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch { /* none yet */ }
    // Prefer the persisted (already-rotated) token; fall back to the one seeded in config.
    this.refreshToken = (persisted && persisted.refresh_token) || cfg.connectRefreshToken || null;
  }

  hasCredentials() { return !!this.refreshToken; }

  async getAccessToken() {
    // Refresh a minute before expiry so an in-flight request never carries a dead token.
    if (this.accessToken && Date.now() < this.expiresAt - 60000) return this.accessToken;
    await this.refresh();
    return this.accessToken;
  }

  async refresh() {
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
    if (r.status !== 200) throw new Error(`token refresh HTTP ${r.status}: ${r.body.slice(0, 160)}`);
    const j = JSON.parse(r.body);
    if (!j.access_token) throw new Error('token refresh: no access_token in response');
    this.accessToken = j.access_token;
    this.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
    // Persist the (rotated) refresh token so the next process/refresh uses the live one.
    if (j.refresh_token) this.refreshToken = j.refresh_token;
    try { fs.writeFileSync(this.tokenFile, JSON.stringify({ refresh_token: this.refreshToken, savedAt: Date.now() })); } catch { /* best effort */ }
    return this.accessToken;
  }
}

// GET the printer detail. On a 401 (token revoked/expired early) force one refresh and retry.
async function fetchPrinter(auth, uuid, timeoutMs = 12000) {
  const get = (tok) => httpsRequest(CONNECT_HOST, {
    method: 'GET', path: `/app/printers/${uuid}`,
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
  }, null, timeoutMs);
  let r = await get(await auth.getAccessToken());
  if (r.status === 401) r = await get(await auth.refresh());
  if (r.status !== 200) throw new Error(`connect printer HTTP ${r.status}: ${r.body.slice(0, 160)}`);
  return JSON.parse(r.body);
}

// Connect state strings -> the overlay's known set (PRINTING/PAUSED/FINISHED/ERROR/IDLE).
const STATE_MAP = {
  PRINTING: 'PRINTING', PAUSED: 'PAUSED', PAUSING: 'PRINTING', RESUMING: 'PRINTING',
  FINISHED: 'FINISHED', STOPPED: 'IDLE', IDLE: 'IDLE', READY: 'IDLE', BUSY: 'PRINTING',
  ATTENTION: 'ERROR', ERROR: 'ERROR',
};

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

  const st = STATE_MAP[j.state] || 'UNKNOWN';
  const printing = st === 'PRINTING' || st === 'PAUSED';
  const num = (v) => (v != null ? v : null);

  // CORE One chamber telemetry. The firmware sends a top-level `chamber` object
  // ({temp, target_temp}, see Prusa-Firmware-Buddy src/connect/render.cpp); accept a
  // flat temp_chamber spelling too in case Connect regroups it like the nozzle/bed temps.
  const ch = j.chamber || {};

  return {
    state: st,
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
    fileName: job.path ? job.path.split('/').pop() : null,
    printing,
  };
}

module.exports = { ConnectAuth, fetchPrinter, mapConnectToState };
