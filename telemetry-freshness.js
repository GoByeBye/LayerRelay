'use strict';

const DEFAULT_OFFLINE_AFTER_SEC = 8;

function sampleHealth(lastGoodAt, lastAttemptOk, nowSec, offlineAfterSec = DEFAULT_OFFLINE_AFTER_SEC) {
  const timestamp = Number(lastGoodAt);
  const now = Number(nowSec);
  const lastGood = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
  const staleSec = lastGood && Number.isFinite(now)
    ? Math.max(0, Math.floor(now - lastGood)) : null;
  return {
    lastGood,
    staleSec,
    online: !!lastAttemptOk && staleSec != null && staleSec < offlineAfterSec,
  };
}

function selectTelemetrySource(local, connect, connectAvailable) {
  if (!connectAvailable) return 'local';
  if (connect.online) return 'connect';
  if (local.online) return 'local';
  return connect.lastGood > local.lastGood ? 'connect' : 'local';
}

module.exports = { DEFAULT_OFFLINE_AFTER_SEC, sampleHealth, selectTelemetrySource };
