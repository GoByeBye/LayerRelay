'use strict';
// Netatmo weather station client. The station's indoor base module measures the room the
// printer lives in, so the overlay can show ambient temperature next to the chamber temp:
//   GET https://api.netatmo.com/api/getstationsdata
// Auth is Netatmo's OAuth2: short-lived access tokens kept alive with a refresh token
// exchanged at /oauth2/token. Netatmo rotates the refresh token on use, so each new one is
// persisted to disk (same pattern as prusaconnect.js, otherwise a restart kills the chain).
const { readJsonWithBackup, writeJsonAtomic } = require('./persistence.js');
const { createHttpsRequest } = require('./https-request.js');

const API_HOST = 'api.netatmo.com';
const httpsRequest = createHttpsRequest();

class NetatmoAuth {
  constructor(cfg, tokenFile) {
    this.clientId = cfg.netatmoClientId || null;
    this.clientSecret = cfg.netatmoClientSecret || null;
    this.tokenFile = tokenFile;
    this.accessToken = null;
    this.expiresAt = 0;
    this.persistPending = false;
    const persisted = readJsonWithBackup(tokenFile, null);
    // Prefer the persisted (already-rotated) token; fall back to the one seeded in config.
    this.refreshToken = (persisted && persisted.refresh_token) || cfg.netatmoRefreshToken || null;
  }

  hasCredentials() { return !!(this.clientId && this.clientSecret && this.refreshToken); }

  async getAccessToken() {
    if (this.persistPending) this.persistRefreshToken();
    if (this.accessToken && Date.now() < this.expiresAt - 60000) return this.accessToken;
    await this.refresh();
    return this.accessToken;
  }

  async refresh() {
    if (!this.hasCredentials()) throw new Error('no Netatmo credentials configured');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    }).toString();
    const r = await httpsRequest(API_HOST, {
      method: 'POST', path: '/oauth2/token',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, body);
    if (r.status !== 200) throw new Error(`netatmo token refresh HTTP ${r.status}`);
    const j = JSON.parse(r.body);
    if (!j.access_token) throw new Error('netatmo token refresh: no access_token in response');
    this.accessToken = j.access_token;
    this.expiresAt = Date.now() + (j.expires_in || 10800) * 1000;
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

// GET the station data. On a 401/403 (token revoked/expired early) force one refresh and retry.
async function fetchStation(auth, timeoutMs = 12000) {
  const get = (tok) => httpsRequest(API_HOST, {
    method: 'GET', path: '/api/getstationsdata',
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
  }, null, timeoutMs);
  let r = await get(await auth.getAccessToken());
  if (r.status === 401 || r.status === 403) r = await get(await auth.refresh());
  if (r.status !== 200) throw new Error(`netatmo stations HTTP ${r.status}`);
  const j = JSON.parse(r.body);
  const base = (j.body && j.body.devices && j.body.devices[0]) || null;
  if (!base) throw new Error('netatmo: no station devices in response');
  const dd = base.dashboard_data || {};
  // First outdoor module (NAModule1), if the station has one.
  const outdoor = (base.modules || []).find((m) => m.type === 'NAModule1') || null;
  const od = (outdoor && outdoor.dashboard_data) || {};
  return {
    roomTemp: dd.Temperature != null ? dd.Temperature : null,
    roomHumidity: dd.Humidity != null ? dd.Humidity : null,
    outdoorTemp: od.Temperature != null ? od.Temperature : null,
  };
}

module.exports = { NetatmoAuth, fetchStation };
