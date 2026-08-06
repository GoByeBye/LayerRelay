'use strict';

const nodeFs = require('node:fs');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('./persistence.js');

const SETTINGS_VERSION = 1;
const ALLOWED_PROFILES = new Set(['native', 'enhanced-1440p']);

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownStringKeys(value) {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === 'string') ? keys : null;
}

function requireExactKeys(value, expected, label) {
  const keys = ownStringKeys(value);
  const allowed = new Set(expected);
  if (!keys || keys.length !== expected.length || keys.some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} must contain exactly ${expected.join(' and ')}`);
  }
}

function normalizeCameraSettings(input) {
  if (!plainObject(input)) throw new TypeError('camera settings must be an object');
  requireExactKeys(input, ['profile'], 'camera settings');
  if (typeof input.profile !== 'string' || !ALLOWED_PROFILES.has(input.profile)) {
    throw new TypeError('profile must be native or enhanced-1440p');
  }
  return { profile: input.profile };
}

function normalizePersistedSettings(input) {
  if (!plainObject(input)) throw new TypeError('persisted camera settings must be an object');
  requireExactKeys(input, ['version', 'profile'], 'persisted camera settings');
  if (input.version !== SETTINGS_VERSION) {
    throw new TypeError('persisted camera settings version is unsupported');
  }
  return normalizeCameraSettings({ profile: input.profile });
}

function cloneCameraSettings(settings) {
  return { profile: settings.profile };
}

function revisionFor(settings) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(settings))
    .digest('hex');
}

function etagFor(settings) {
  return `"${revisionFor(settings)}"`;
}

function readPersistedCandidate(fsImpl, file) {
  let contents;
  try {
    contents = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    const missing = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
    return { status: missing ? 'missing' : 'invalid', value: null };
  }

  try {
    return { status: 'valid', value: normalizePersistedSettings(JSON.parse(contents)) };
  } catch {
    return { status: 'invalid', value: null };
  }
}

function warn(logger, message) {
  try {
    if (typeof logger === 'function') logger(message);
    else if (logger && typeof logger.warn === 'function') logger.warn(message);
  } catch { /* Logging must never prevent the dashboard from starting. */ }
}

function createCameraSettingsStore(options = {}) {
  const { dataFile, defaults, fs: fsImpl = nodeFs, logger = console } = options;
  if (typeof dataFile !== 'string' || dataFile.trim() === '') {
    throw new TypeError('dataFile must be a non-empty path string');
  }

  const fallback = normalizeCameraSettings(defaults);
  const primary = readPersistedCandidate(fsImpl, dataFile);
  let current;

  if (primary.status === 'valid') {
    current = primary.value;
  } else {
    const backup = readPersistedCandidate(fsImpl, `${dataFile}.bak`);
    if (backup.status === 'valid') {
      current = backup.value;
      warn(logger, 'Camera settings primary was unusable; recovered from backup.');
    } else {
      current = fallback;
      if (primary.status === 'invalid' || backup.status === 'invalid') {
        warn(logger, 'Persisted camera settings were unusable; using configured defaults.');
      }
    }
  }

  return Object.freeze({
    get() {
      return cloneCameraSettings(current);
    },
    etag() {
      return etagFor(current);
    },
    replace(input, expectedEtag) {
      if (expectedEtag != null && expectedEtag !== etagFor(current)) {
        const error = new Error('camera settings changed since they were loaded');
        error.code = 'CAMERA_SETTINGS_CONFLICT';
        throw error;
      }
      const next = normalizeCameraSettings(input);
      const persisted = JSON.stringify({ version: SETTINGS_VERSION, ...next });
      writeFileAtomic(dataFile, persisted);
      try { writeFileAtomic(`${dataFile}.bak`, persisted); }
      catch { warn(logger, 'Camera settings backup could not be updated; the primary save succeeded.'); }
      current = next;
      return cloneCameraSettings(current);
    },
  });
}

module.exports = {
  createCameraSettingsStore,
  normalizeCameraSettings,
};
