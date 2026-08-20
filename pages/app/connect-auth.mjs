/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Prusa account OAuth for the static dashboard's cloud mode. The page has no
 * backend, so the refresh token lives in the visitor's own localStorage and is
 * sent to account.prusa3d.com only.
 *
 * account.prusa3d.com rotates the refresh token on every use and invalidates
 * the old one, which is far more dangerous in a browser than on a server: two
 * tabs, or a reload racing an in-flight refresh, can spend the same token and
 * kill the chain for good. Everything unusual in this module exists to make
 * that impossible:
 *   - the rotated token is written to storage synchronously, before the access
 *     token is handed back to any caller, and a failed write is a hard error
 *     rather than a silent success;
 *   - a cross-tab lock in localStorage (random owner id, 15s TTL, re-read
 *     after the write, heartbeat while the request is in flight) keeps a
 *     single tab in charge, and the others wait for its result;
 *   - a BroadcastChannel shares the fresh ACCESS token (never the refresh
 *     token) so waiting tabs do not have to poll for long;
 *   - a second storage key mirrors the last known-good token and records that
 *     a refresh was in flight, so an interrupted rotation can be reported;
 *   - a rejected token is remembered so the account service is not hammered,
 *     keyed to the token value so a peer tab's legitimate rotation clears it.
 *
 * The account profile response carries the account email and name. Only the
 * numeric user id is ever kept, and nothing here logs or renders any of it.
 */

const TOKEN_URL = 'https://account.prusa3d.com/o/token/';
const ME_URL = 'https://account.prusa3d.com/api/v1/me';
// Prusa Connect's own public SPA client id, the same one prusaconnect.js uses.
const CLIENT_ID = 'MRHTlZhZqkNrrQ6FUPtjyusAz8nc59ErHXP8XkS4'; // gitleaks:allow -- public browser client identifier, not a credential

export const CONNECT_STORAGE_KEY = 'layer-relay.static.connect';
export const CONNECT_BACKUP_KEY = 'layer-relay.static.connect.last-good';
export const CONNECT_LOCK_KEY = 'layer-relay.static.connect.lock';
export const CONNECT_CHANNEL_NAME = 'layer-relay.static.connect';
export const CONNECT_TOKEN_DOC = 'docs/prusa-connect.md';

const ACCESS_SKEW_MS = 60000;
const LOCK_TTL_MS = 15000;
const LOCK_CONFIRM_MS = 40;
const LOCK_HEARTBEAT_MS = 5000;
const LOCK_POLL_MS = 200;
const LOCK_WAIT_MS = 30000;
const DEFAULT_EXPIRES_IN_SEC = 3600;
const MAX_TOKEN_LENGTH = 4096;
// Printer ids go straight into an MQTT topic filter, so anything that could
// change the filter's meaning (slash, wildcard, whitespace) is rejected. The
// character set matches state-engine.mjs so both reject exactly the same ids.
const PRINTER_UUID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const ACCESS_MESSAGE = 'layer-relay.connect.access';

const INVALID_GRANT_MESSAGE = [
  'Prusa rejected the stored refresh token.',
  'A refresh token can only be spent once, so this usually means something else spent it:',
  'a running LayerRelay server, another browser tab, or an interrupted refresh.',
  `Capture a fresh token as described in ${CONNECT_TOKEN_DOC} and paste it in again.`,
].join(' ');

export function connectAuthError(code, message, extra) {
  const error = new Error(message);
  error.name = 'ConnectAuthError';
  error.code = code;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return error;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function randomOwnerId() {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export function createConnectAuth(options = {}) {
  const storage = options.storage ||
    (typeof localStorage === 'object' && localStorage ? localStorage : null);
  const fetchImpl = options.fetchImpl ||
    (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const timers = options.timers || {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const makeOwnerId = typeof options.randomId === 'function' ? options.randomId : randomOwnerId;
  const lockTtlMs = Number.isFinite(options.lockTtlMs) ? options.lockTtlMs : LOCK_TTL_MS;
  const lockConfirmMs = Number.isFinite(options.lockConfirmMs)
    ? options.lockConfirmMs : LOCK_CONFIRM_MS;
  const lockPollMs = Number.isFinite(options.lockPollMs) ? options.lockPollMs : LOCK_POLL_MS;
  const lockWaitMs = Number.isFinite(options.lockWaitMs) ? options.lockWaitMs : LOCK_WAIT_MS;
  const heartbeatMs = Number.isFinite(options.lockHeartbeatMs)
    ? options.lockHeartbeatMs : LOCK_HEARTBEAT_MS;
  const broadcastOption = options.broadcast;

  // In-memory mirror of the durable state. It is a cache, never the source of
  // truth, except while a storage write is failing.
  let memoryAccessToken = null;
  let memoryAccessExpiresAt = 0;
  let memoryUserId = null;
  let refreshInFlight = null;
  let userIdInFlight = null;
  let pendingRecord = null; // set when a storage write failed
  let deadRefreshToken = null;
  let channel = broadcastOption === undefined ? undefined : broadcastOption;
  let channelReady = false;

  function wait(ms) {
    return new Promise((resolve) => { timers.setTimeout(resolve, Math.max(0, ms)); });
  }

  function readKey(key) {
    if (!storage) return null;
    let raw;
    try { raw = storage.getItem(key); }
    catch { return null; }
    if (!nonEmptyString(raw)) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }

  function writeKey(key, value) {
    if (!storage) throw connectAuthError('storage', 'no browser storage is available');
    storage.setItem(key, JSON.stringify(value));
  }

  function removeKey(key) {
    if (!storage) return;
    try { storage.removeItem(key); } catch { /* nothing else to try */ }
  }

  function normalizeRecord(raw) {
    if (!raw) return null;
    const refreshToken = nonEmptyString(raw.refreshToken) ? raw.refreshToken : null;
    if (!refreshToken) return null;
    const accessExpiresAt = Number(raw.accessExpiresAt);
    return {
      refreshToken,
      printerUuid: nonEmptyString(raw.printerUuid) ? raw.printerUuid : null,
      savedAt: Number.isFinite(Number(raw.savedAt)) ? Number(raw.savedAt) : 0,
      accessToken: nonEmptyString(raw.accessToken) ? raw.accessToken : null,
      accessExpiresAt: Number.isFinite(accessExpiresAt) ? accessExpiresAt : 0,
      userId: nonEmptyString(raw.userId) ? raw.userId : null,
    };
  }

  // The durable record, with two fallbacks: a record whose write failed is
  // still authoritative for this tab, and a corrupted primary key falls back
  // to the mirror so a bad write cannot lose the chain.
  function readRecord() {
    if (pendingRecord) return pendingRecord;
    const record = normalizeRecord(readKey(CONNECT_STORAGE_KEY));
    if (record) return record;
    const backup = readKey(CONNECT_BACKUP_KEY);
    return normalizeRecord(backup && {
      refreshToken: backup.refreshToken,
      printerUuid: backup.printerUuid,
      savedAt: backup.savedAt,
    });
  }

  function persist(record, backupState) {
    const stored = {
      refreshToken: record.refreshToken,
      printerUuid: record.printerUuid,
      savedAt: record.savedAt,
      accessToken: record.accessToken,
      accessExpiresAt: record.accessExpiresAt,
      userId: record.userId,
    };
    try {
      writeKey(CONNECT_STORAGE_KEY, stored);
      writeKey(CONNECT_BACKUP_KEY, {
        refreshToken: record.refreshToken,
        printerUuid: record.printerUuid,
        savedAt: record.savedAt,
        state: backupState,
      });
      pendingRecord = null;
      return;
    } catch (cause) {
      // Keep the rotated token alive for this tab so it is not spent twice,
      // then refuse to hand out the access token: without durable storage the
      // chain dies on the next reload and the user must know now.
      pendingRecord = record;
      throw connectAuthError(
        'storage',
        'the rotated Prusa refresh token could not be saved to browser storage, so cloud mode cannot run safely',
        { cause },
      );
    }
  }

  // The marker names one specific token, so it must only ever be written while
  // that exact token is still the stored one. Between capturing a token and
  // hearing back about it, a peer tab or a freshly pasted token can replace the
  // record; branding that newer token would durably condemn a live chain and
  // make every later instance refuse to contact Prusa at all.
  function markBackupState(state, expectedToken) {
    const record = readRecord();
    if (!record) return;
    if (expectedToken != null && record.refreshToken !== expectedToken) return;
    try {
      writeKey(CONNECT_BACKUP_KEY, {
        refreshToken: record.refreshToken,
        printerUuid: record.printerUuid,
        savedAt: record.savedAt,
        state,
      });
    } catch { /* best effort marker only */ }
  }

  function backupState() {
    const backup = readKey(CONNECT_BACKUP_KEY);
    return backup && nonEmptyString(backup.state) ? backup.state : null;
  }

  function rejectedToken() {
    if (deadRefreshToken) return deadRefreshToken;
    const backup = readKey(CONNECT_BACKUP_KEY);
    if (backup && backup.state === 'invalid_grant' && nonEmptyString(backup.refreshToken)) {
      return backup.refreshToken;
    }
    return null;
  }

  function readLock() {
    const lock = readKey(CONNECT_LOCK_KEY);
    if (!lock || !nonEmptyString(lock.owner)) return null;
    const expiresAt = Number(lock.expiresAt);
    if (!Number.isFinite(expiresAt)) return null;
    return { owner: lock.owner, expiresAt };
  }

  function claimLock(ownerId) {
    const held = readLock();
    if (held && held.owner !== ownerId && held.expiresAt > now()) return false;
    try { writeKey(CONNECT_LOCK_KEY, { owner: ownerId, expiresAt: now() + lockTtlMs }); }
    catch (cause) {
      // Storage that cannot hold a lock cannot hold a rotated token either, so
      // fail immediately instead of spinning on a lock that never lands.
      throw connectAuthError(
        'storage',
        'browser storage refused the cross-tab refresh lock, so cloud mode cannot run safely',
        { cause },
      );
    }
    // Read back: localStorage writes are last-writer-wins, so a peer that wrote
    // after us owns the lock and we must stand down.
    const after = readLock();
    return !!after && after.owner === ownerId;
  }

  function ownsLock(ownerId) {
    const held = readLock();
    return !!held && held.owner === ownerId && held.expiresAt > now();
  }

  function renewLock(ownerId) {
    const held = readLock();
    if (held && held.owner !== ownerId) return false;
    try { writeKey(CONNECT_LOCK_KEY, { owner: ownerId, expiresAt: now() + lockTtlMs }); }
    catch { return false; }
    return true;
  }

  function releaseLock(ownerId) {
    // Only ever drop our own lock: a slow refresh may have lost it to a peer,
    // and evicting theirs would let a third tab in mid-refresh.
    const held = readLock();
    if (held && held.owner !== ownerId) return;
    removeKey(CONNECT_LOCK_KEY);
  }

  // A refresh that outruns the lock TTL would let a peer spend the same token,
  // so the lock is re-armed while the request is in flight.
  function startHeartbeat(ownerId) {
    let handle = null;
    const tick = () => {
      handle = null;
      if (!renewLock(ownerId)) return;
      handle = timers.setTimeout(tick, heartbeatMs);
    };
    handle = timers.setTimeout(tick, heartbeatMs);
    return () => {
      if (handle != null) timers.clearTimeout(handle);
      handle = null;
    };
  }

  function ensureChannel() {
    if (channelReady) return channel;
    channelReady = true;
    if (channel === undefined) {
      channel = typeof globalThis.BroadcastChannel === 'function'
        ? new globalThis.BroadcastChannel(CONNECT_CHANNEL_NAME) : null;
    }
    if (channel && typeof channel.addEventListener === 'function') {
      channel.addEventListener('message', (event) => {
        const data = event && typeof event === 'object' && 'data' in event ? event.data : event;
        if (!data || typeof data !== 'object' || data.type !== ACCESS_MESSAGE) return;
        if (!nonEmptyString(data.accessToken)) return;
        const expiresAt = Number(data.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= memoryAccessExpiresAt) return;
        memoryAccessToken = data.accessToken;
        memoryAccessExpiresAt = expiresAt;
      });
    }
    return channel;
  }

  function shareAccessToken(accessToken, expiresAt) {
    const target = ensureChannel();
    if (!target || typeof target.postMessage !== 'function') return;
    // Only the short-lived access token is shared. The refresh token never
    // leaves storage.
    try { target.postMessage({ type: ACCESS_MESSAGE, accessToken, expiresAt }); }
    catch { /* a closed channel is not fatal */ }
  }

  function freshAccessToken(record) {
    const cutoff = now() + ACCESS_SKEW_MS;
    if (record && record.accessToken && record.accessExpiresAt > cutoff &&
        record.accessExpiresAt >= memoryAccessExpiresAt) {
      return record.accessToken;
    }
    if (memoryAccessToken && memoryAccessExpiresAt > cutoff) return memoryAccessToken;
    return null;
  }

  function requireRecord() {
    const record = readRecord();
    if (!record) {
      throw connectAuthError(
        'not_configured',
        'no Prusa refresh token is stored in this browser',
      );
    }
    return record;
  }

  async function readJson(response) {
    try { return await response.json(); }
    catch { return null; }
  }

  async function refreshOnce() {
    const record = requireRecord();
    // A peer may have refreshed while we queued for the lock.
    const shared = freshAccessToken(record);
    if (shared) return shared;
    if (!fetchImpl) {
      throw connectAuthError('network', 'this browser provides no fetch implementation');
    }
    // Record that this exact token is being spent, so an interrupted refresh
    // (tab closed, network dropped) can be reported instead of guessed at.
    markBackupState('spending', record.refreshToken);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: record.refreshToken,
      client_id: CLIENT_ID,
    }).toString();
    let response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        // Content-Type is CORS-safelisted, so this stays a simple request and
        // no preflight is needed.
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (cause) {
      throw connectAuthError('network', 'could not reach the Prusa account service', { cause });
    }
    if (!response || !response.ok) {
      const status = response ? response.status : 0;
      const payload = response ? await readJson(response) : null;
      const reason = payload && nonEmptyString(payload.error) ? payload.error : null;
      // Django OAuth Toolkit answers a spent or revoked token with 400
      // invalid_grant. Treat an unparsable 400/401 the same way: the actionable
      // advice is identical and re-capturing the token is the only fix.
      if (reason === 'invalid_grant' || (!reason && (status === 400 || status === 401))) {
        deadRefreshToken = record.refreshToken;
        markBackupState('invalid_grant', record.refreshToken);
        throw connectAuthError('invalid_grant', INVALID_GRANT_MESSAGE);
      }
      throw connectAuthError(
        'network',
        `the Prusa account service refused the token refresh with HTTP ${status}`,
        { status },
      );
    }
    const payload = await readJson(response);
    // Nothing may await between here and the storage write: the server has
    // already rotated the token and losing it breaks the chain.
    if (!payload || typeof payload !== 'object') {
      throw connectAuthError('network', 'the Prusa account service returned an unreadable response');
    }
    const rotated = nonEmptyString(payload.refresh_token) ? payload.refresh_token : record.refreshToken;
    const accessToken = nonEmptyString(payload.access_token) ? payload.access_token : null;
    const expiresInSec = Number(payload.expires_in);
    const lifetimeSec = Number.isFinite(expiresInSec) && expiresInSec > 0
      ? expiresInSec : DEFAULT_EXPIRES_IN_SEC;
    const accessExpiresAt = now() + lifetimeSec * 1000;
    // If a newer token was stored while this request was in flight (the user
    // pasted a fresh one, or a peer tab reconfigured), that chain is the live
    // one and this rotation belongs to a chain nobody uses any more. Keep the
    // newer token rather than undoing the user's action.
    const latest = normalizeRecord(readKey(CONNECT_STORAGE_KEY));
    const superseded = !!latest && latest.savedAt > record.savedAt &&
      latest.refreshToken !== record.refreshToken;
    const base = superseded ? latest : record;
    const next = {
      ...base,
      refreshToken: superseded ? latest.refreshToken : rotated,
      savedAt: superseded ? latest.savedAt : now(),
      accessToken,
      accessExpiresAt: accessToken ? accessExpiresAt : 0,
    };
    if (rotated !== deadRefreshToken) deadRefreshToken = null;
    if (accessToken) {
      memoryAccessToken = accessToken;
      memoryAccessExpiresAt = accessExpiresAt;
    }
    persist(next, 'good');
    if (!accessToken) {
      throw connectAuthError('network', 'the Prusa account service returned no access token');
    }
    shareAccessToken(accessToken, accessExpiresAt);
    return accessToken;
  }

  async function waitForPeer(deadline) {
    for (;;) {
      const shared = freshAccessToken(readRecord());
      if (shared) return shared;
      const held = readLock();
      if (!held || held.expiresAt <= now()) return null;
      if (now() >= deadline) return null;
      await wait(lockPollMs);
    }
  }

  async function refreshWithLock() {
    if (!storage) return refreshOnce();
    const ownerId = makeOwnerId();
    const deadline = now() + lockWaitMs;
    for (;;) {
      if (claimLock(ownerId)) {
        // Re-check after a beat: two tabs can both read back their own write
        // when the writes interleave, and only the later one keeps the lock.
        await wait(lockConfirmMs);
        if (ownsLock(ownerId)) break;
      }
      const shared = await waitForPeer(deadline);
      if (shared) return shared;
      if (now() >= deadline) {
        throw connectAuthError(
          'network',
          'timed out waiting for another tab to finish refreshing the Prusa token',
        );
      }
      // Always yield before retrying the claim so a lock that keeps vanishing
      // cannot turn into a hot loop.
      await wait(lockPollMs);
    }
    const stopHeartbeat = startHeartbeat(ownerId);
    try {
      return await refreshOnce();
    } finally {
      stopHeartbeat();
      releaseLock(ownerId);
    }
  }

  function configure(input) {
    if (!input || typeof input !== 'object') {
      throw new TypeError('connect configuration must be an object');
    }
    const refreshToken = typeof input.refreshToken === 'string' ? input.refreshToken.trim() : '';
    const printerUuid = typeof input.printerUuid === 'string' ? input.printerUuid.trim() : '';
    if (!refreshToken || refreshToken.length > MAX_TOKEN_LENGTH || /\s/.test(refreshToken)) {
      throw new TypeError('refreshToken must be a non-empty token with no whitespace');
    }
    // The uuid goes straight into an MQTT topic filter, so wildcards and
    // separators are refused rather than escaped.
    if (!PRINTER_UUID.test(printerUuid)) {
      throw new TypeError('printerUuid must look like a Prusa printer uuid');
    }
    memoryAccessToken = null;
    memoryAccessExpiresAt = 0;
    memoryUserId = null;
    deadRefreshToken = null;
    pendingRecord = null;
    refreshInFlight = null;
    userIdInFlight = null;
    persist({
      refreshToken,
      printerUuid,
      savedAt: now(),
      accessToken: null,
      accessExpiresAt: 0,
      userId: null,
    }, 'configured');
    return { printerUuid };
  }

  async function getAccessToken() {
    // Listen before waiting: a tab that only ever waits still has to be able to
    // pick up the leader's fresh access token from the channel.
    ensureChannel();
    const record = requireRecord();
    const dead = rejectedToken();
    if (dead && dead === record.refreshToken) {
      throw connectAuthError('invalid_grant', INVALID_GRANT_MESSAGE);
    }
    if (dead) deadRefreshToken = null;
    if (pendingRecord) {
      // Retry the write that failed before anything else: without it the
      // rotated token is only in memory and dies with this tab.
      persist(pendingRecord, 'good');
    }
    const cached = freshAccessToken(record);
    if (cached) return cached;
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = refreshWithLock().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  async function fetchUserId() {
    const token = await getAccessToken();
    if (!fetchImpl) {
      throw connectAuthError('network', 'this browser provides no fetch implementation');
    }
    let response;
    try {
      response = await fetchImpl(ME_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (cause) {
      throw connectAuthError('network', 'could not reach the Prusa account service', { cause });
    }
    if (response && response.status === 401) {
      // The access token died early. Drop it so the next call refreshes once.
      memoryAccessToken = null;
      memoryAccessExpiresAt = 0;
      const record = readRecord();
      if (record && record.accessToken) {
        try { persist({ ...record, accessToken: null, accessExpiresAt: 0 }, 'good'); }
        catch { /* reported on the next getAccessToken */ }
      }
      throw connectAuthError('network', 'the Prusa account service rejected the access token');
    }
    if (!response || !response.ok) {
      throw connectAuthError(
        'network',
        `the Prusa account service returned HTTP ${response ? response.status : 0} for the account profile`,
        { status: response ? response.status : 0 },
      );
    }
    const payload = await readJson(response);
    const id = payload && (typeof payload.id === 'number' || nonEmptyString(payload.id))
      ? String(payload.id) : null;
    // The profile also carries the account email and name. Only the id is read,
    // so neither can reach storage, the console or the DOM.
    if (!id) {
      throw connectAuthError('network', 'the Prusa account profile carried no user id');
    }
    memoryUserId = id;
    const record = readRecord();
    if (record && record.userId !== id) {
      try { persist({ ...record, userId: id }, 'good'); }
      catch { /* the id is only a cache; keep going from memory */ }
    }
    return id;
  }

  async function getUserId() {
    if (memoryUserId) return memoryUserId;
    const record = requireRecord();
    if (record.userId) {
      memoryUserId = record.userId;
      return memoryUserId;
    }
    if (userIdInFlight) return userIdInFlight;
    userIdInFlight = fetchUserId().finally(() => { userIdInFlight = null; });
    return userIdInFlight;
  }

  function getConfig() {
    const record = readRecord();
    return {
      configured: !!record,
      printerUuid: record ? record.printerUuid : null,
    };
  }

  // Non-secret view for the status line. No token value is ever returned.
  function inspect() {
    const record = readRecord();
    const dead = rejectedToken();
    return {
      configured: !!record,
      printerUuid: record ? record.printerUuid : null,
      userId: memoryUserId || (record ? record.userId : null),
      hasFreshAccessToken: !!freshAccessToken(record),
      accessExpiresAt: record && record.accessToken ? record.accessExpiresAt : null,
      invalidGrant: !!(record && dead && dead === record.refreshToken),
      interrupted: backupState() === 'spending',
      storageFailed: !!pendingRecord,
    };
  }

  function clear() {
    memoryAccessToken = null;
    memoryAccessExpiresAt = 0;
    memoryUserId = null;
    deadRefreshToken = null;
    pendingRecord = null;
    refreshInFlight = null;
    userIdInFlight = null;
    removeKey(CONNECT_STORAGE_KEY);
    removeKey(CONNECT_BACKUP_KEY);
    removeKey(CONNECT_LOCK_KEY);
  }

  return { configure, getAccessToken, getUserId, getConfig, inspect, clear };
}
