'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function tempPathFor(file) {
  const nonce = crypto.randomBytes(6).toString('hex');
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${nonce}.tmp`);
}

function syncDirectory(dir) {
  // Windows does not support fsync on directory handles. The file itself is still fsynced
  // before rename; on platforms which allow it, also persist the directory entry.
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* best effort */ }
  finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tempPathFor(file);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, data, typeof data === 'string' ? 'utf8' : undefined);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(file, 0o600); } catch {}
    }
    syncDirectory(dir);
  } catch (error) {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

function writeJsonAtomic(file, value, { backup = true } = {}) {
  const data = JSON.stringify(value);
  writeFileAtomic(file, data);
  // Keep an independently atomic copy. If this second write fails the primary is already
  // durable, so callers should report the error but must not roll the valid primary back.
  if (backup) writeFileAtomic(`${file}.bak`, data);
}

function tryReadJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    return { ok: false, value: undefined, error };
  }
}

function readJsonDetailed(file) {
  const primary = tryReadJson(file);
  if (primary.ok) return { value: primary.value, source: file, recovered: false, errors: [] };
  const backupFile = `${file}.bak`;
  const backup = tryReadJson(backupFile);
  if (backup.ok) {
    return { value: backup.value, source: backupFile, recovered: true, errors: [primary.error] };
  }
  return { value: undefined, source: null, recovered: false, errors: [primary.error, backup.error] };
}

function readJsonWithBackup(file, fallback = null) {
  const result = readJsonDetailed(file);
  return result.source ? result.value : fallback;
}

function readJsonValidatedWithBackup(file, normalize, fallback = null) {
  if (typeof normalize !== 'function') throw new TypeError('normalize must be a function');
  for (const candidate of [file, `${file}.bak`]) {
    const parsed = tryReadJson(candidate);
    if (!parsed.ok) continue;
    try {
      const value = normalize(parsed.value);
      if (value != null) return value;
    } catch { /* Try the independently written backup after semantic corruption. */ }
  }
  return fallback;
}

function quarantineFile(file, suffix = Date.now()) {
  if (!fs.existsSync(file)) return null;
  const target = `${file}.corrupt-${suffix}`;
  fs.renameSync(file, target);
  return target;
}

function quarantineJsonPair(file) {
  const suffix = Date.now();
  const moved = [];
  for (const candidate of [file, `${file}.bak`]) {
    try {
      const target = quarantineFile(candidate, suffix);
      if (target) moved.push(target);
    } catch { /* a concurrent recovery may already have moved it */ }
  }
  return moved;
}

function usableJobKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!key) return null;
  const separator = key.indexOf('::');
  if (separator < 0) return key === 'x' ? null : key;
  const id = key.slice(0, separator).trim();
  const file = key.slice(separator + 2).trim();
  return ((id && id !== 'x') || file) ? key : null;
}

function stableJobIdentity(value, normalizeName = (name) => String(name || '').trim()) {
  if (!value || typeof value !== 'object') return null;
  const key = usableJobKey(value.jobKey) || usableJobKey(value.thumbnailKey);
  if (key) return `key:${key.toLocaleLowerCase()}`;
  const name = String(normalizeName(value.name || '') || '').trim().toLocaleLowerCase();
  return name ? `name:${name}` : null;
}

function sanitizeCompletedJob(value, normalizeName = (name) => String(name || '').trim()) {
  if (!stableJobIdentity(value, normalizeName)) return null;
  const name = String(normalizeName(value.name || '') || '').trim();
  const jobKey = usableJobKey(value.jobKey) || usableJobKey(value.thumbnailKey);
  return { ...value, name, jobKey: jobKey || null };
}

module.exports = {
  readJsonDetailed,
  readJsonValidatedWithBackup,
  readJsonWithBackup,
  quarantineJsonPair,
  sanitizeCompletedJob,
  stableJobIdentity,
  usableJobKey,
  writeFileAtomic,
  writeJsonAtomic,
};
