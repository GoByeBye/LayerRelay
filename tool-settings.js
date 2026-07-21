'use strict';

const nodeFs = require('node:fs');
const { writeFileAtomic } = require('./persistence.js');

const SETTINGS_VERSION = 2;
const MAX_TOOLS = 32;
const MAX_NAME_LENGTH = 80;
const TOOL_SLOT_KEY = /^(?:[1-9]|[12][0-9]|3[0-2])$/;
const TOOL_COLOR = /^#[0-9a-f]{6}$/i;

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownStringKeys(value) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return null;
  return keys;
}

function requireExactKeys(value, expected, label) {
  const keys = ownStringKeys(value);
  const allowed = new Set(expected);
  if (!keys || keys.length !== expected.length || keys.some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} must contain exactly ${expected.join(' and ')}`);
  }
}

function normalizeName(value, slot) {
  if (typeof value !== 'string' || value.length > MAX_NAME_LENGTH) {
    throw new TypeError(`toolSlots.${slot}.name must be a string of at most ${MAX_NAME_LENGTH} characters`);
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length > MAX_NAME_LENGTH) {
    throw new TypeError(`toolSlots.${slot}.name must be a string of at most ${MAX_NAME_LENGTH} characters`);
  }
  return normalized;
}

function normalizeToolSettings(input) {
  if (!plainObject(input)) throw new TypeError('tool settings must be an object');
  requireExactKeys(input, ['toolCount', 'toolSlots'], 'tool settings');

  if (input.toolCount !== null &&
      (!Number.isInteger(input.toolCount) || input.toolCount < 1 || input.toolCount > MAX_TOOLS)) {
    throw new TypeError(`toolCount must be null (automatic) or an integer from 1 to ${MAX_TOOLS}`);
  }
  if (!plainObject(input.toolSlots)) {
    throw new TypeError('toolSlots must be an object keyed by 1-based tool number');
  }

  const toolSlots = {};
  const slotKeys = ownStringKeys(input.toolSlots);
  if (!slotKeys || slotKeys.some((slot) => !TOOL_SLOT_KEY.test(slot))) {
    throw new TypeError(`toolSlots keys must be canonical integers from 1 to ${MAX_TOOLS}`);
  }

  for (const slot of slotKeys) {
    const value = input.toolSlots[slot];
    if (!plainObject(value)) throw new TypeError(`toolSlots.${slot} must be an object`);

    const keys = ownStringKeys(value);
    const allowed = new Set(['loaded', 'name', 'color']);
    if (!keys || keys.some((key) => !allowed.has(key))) {
      throw new TypeError(`toolSlots.${slot} contains an unknown setting`);
    }

    const normalized = {};
    if (Object.hasOwn(value, 'loaded')) {
      if (typeof value.loaded !== 'boolean') {
        throw new TypeError(`toolSlots.${slot}.loaded must be true or false`);
      }
      normalized.loaded = value.loaded;
    }
    if (Object.hasOwn(value, 'name')) {
      const name = normalizeName(value.name, slot);
      if (name) normalized.name = name;
    }
    if (Object.hasOwn(value, 'color')) {
      if (typeof value.color !== 'string' || !TOOL_COLOR.test(value.color)) {
        throw new TypeError(`toolSlots.${slot}.color must be a six-digit hex colour`);
      }
      normalized.color = value.color.toUpperCase();
    }
    // An omitted/empty slot is the explicit automatic state. Keeping empty
    // objects would make it impossible to distinguish Auto from a manual row.
    if (Object.keys(normalized).length) toolSlots[slot] = normalized;
  }

  return { toolCount: input.toolCount, toolSlots };
}

function normalizePersistedSettings(input) {
  if (!plainObject(input)) throw new TypeError('persisted tool settings must be an object');
  requireExactKeys(input, ['version', 'toolCount', 'toolSlots'], 'persisted tool settings');
  if (input.version !== 1 && input.version !== SETTINGS_VERSION) {
    throw new TypeError('persisted tool settings version is unsupported');
  }
  const normalized = normalizeToolSettings({ toolCount: input.toolCount, toolSlots: input.toolSlots });
  return input.version === 1 ? migrateLegacyLoadedSemantics(normalized) : normalized;
}

function migrateLegacyLoadedSemantics(settings) {
  const migrated = cloneToolSettings(settings);
  for (const slot of Object.values(migrated.toolSlots)) {
    if (!Object.hasOwn(slot, 'loaded') && (slot.name || slot.color)) slot.loaded = true;
  }
  return migrated;
}

function normalizeConfigurationDefaults(input) {
  if (!plainObject(input) || !plainObject(input.toolSlots)) {
    return normalizeToolSettings(input);
  }
  const toolSlots = {};
  for (const [slot, value] of Object.entries(input.toolSlots)) {
    if (!plainObject(value)) {
      toolSlots[slot] = value;
      continue;
    }
    const keys = ownStringKeys(value);
    if (!keys) {
      toolSlots[slot] = value;
      continue;
    }
    toolSlots[slot] = {};
    for (const key of keys) {
      // Older accepted configuration files may explicitly use null to mean
      // "not configured". Keep the browser API strict while preserving that
      // startup compatibility at the configuration boundary.
      if (value[key] != null) toolSlots[slot][key] = value[key];
    }
  }
  return migrateLegacyLoadedSemantics(normalizeToolSettings({ toolCount: input.toolCount, toolSlots }));
}

function cloneToolSettings(settings) {
  const toolSlots = {};
  for (const [slot, value] of Object.entries(settings.toolSlots)) {
    toolSlots[slot] = { ...value };
  }
  return { toolCount: settings.toolCount, toolSlots };
}

function cleanDetectedText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return normalized || null;
}

function normalizeDetectedToolSettings(input) {
  const value = plainObject(input) ? input : {};
  const source = value.source === 'connect' ? 'connect' : null;
  const status = ['fresh', 'stale', 'unavailable'].includes(value.status)
    ? value.status : (source ? 'stale' : 'unavailable');
  const rawSlots = value.toolSlots;
  const keyed = {};
  let highestLabel = 0;

  const addSlot = (label, raw) => {
    if (!Number.isInteger(label) || label < 1 || label > MAX_TOOLS || !plainObject(raw)) return;
    highestLabel = Math.max(highestLabel, label);
    const slot = {};
    if (typeof raw.loaded === 'boolean') slot.loaded = raw.loaded;
    const name = cleanDetectedText(raw.name, MAX_NAME_LENGTH);
    const material = cleanDetectedText(raw.material, MAX_NAME_LENGTH);
    if (name) slot.name = name;
    if (material) slot.material = material;
    if (typeof raw.color === 'string' && TOOL_COLOR.test(raw.color)) slot.color = raw.color.toUpperCase();
    keyed[String(label)] = slot;
  };

  if (Array.isArray(rawSlots)) {
    rawSlots.slice(0, MAX_TOOLS).forEach((slot, index) => {
      const rawLabel = plainObject(slot) ? Number(slot.toolLabel) : NaN;
      addSlot(Number.isInteger(rawLabel) ? rawLabel : index + 1, slot);
    });
  } else if (plainObject(rawSlots)) {
    for (const [key, slot] of Object.entries(rawSlots)) {
      if (TOOL_SLOT_KEY.test(key)) addSlot(Number(key), slot);
    }
  }

  const requestedCount = Number.isInteger(value.toolCount) && value.toolCount >= 1 &&
    value.toolCount <= MAX_TOOLS ? value.toolCount : null;
  const toolCount = requestedCount == null && highestLabel === 0
    ? null : Math.max(requestedCount || 0, highestLabel);
  const toolSlots = toolCount == null ? [] : Array.from({ length: toolCount }, (_, toolIndex) => {
    const toolLabel = toolIndex + 1;
    const slot = keyed[String(toolLabel)] || {};
    return {
      toolIndex,
      toolLabel,
      loaded: typeof slot.loaded === 'boolean' ? slot.loaded : null,
      name: slot.name || null,
      material: slot.material || null,
      color: slot.color || null,
    };
  });
  return { source, status, toolCount, toolSlots };
}

function restoreCachedConnectToolInventory(saved, printerUuid) {
  if (!plainObject(saved) || (saved.version !== 1 && saved.version !== 2)) return null;
  const configuredPrinter = cleanDetectedText(printerUuid, 256);
  const cachedPrinter = cleanDetectedText(saved.printerUuid, 256);
  // Legacy caches had no printer identity. They are safe only when no printer
  // UUID is configured (for example, an explicit offline demo fixture).
  if (configuredPrinter !== cachedPrinter) return null;
  const normalized = normalizeDetectedToolSettings({
    source: 'connect',
    status: 'stale',
    toolCount: saved.toolCount,
    toolSlots: saved.toolSlots,
  });
  return normalized.toolCount == null
    ? null : { toolCount: normalized.toolCount, toolSlots: normalized.toolSlots };
}

function mergeConnectToolInventory(previous, sample) {
  const incoming = normalizeDetectedToolSettings({
    source: 'connect',
    status: 'fresh',
    toolCount: sample && sample.toolCount,
    toolSlots: sample && sample.toolSlots,
  });
  if (incoming.toolCount == null) return previous || null;
  const prior = normalizeDetectedToolSettings({
    source: 'connect',
    status: 'stale',
    toolCount: previous && previous.toolCount,
    toolSlots: previous && previous.toolSlots,
  });
  if (sample && sample.countAuthoritative === true || prior.toolCount == null) {
    return { toolCount: incoming.toolCount, toolSlots: incoming.toolSlots };
  }

  const toolCount = Math.max(prior.toolCount, incoming.toolCount);
  const toolSlots = Array.from({ length: toolCount }, (_, toolIndex) => {
    const incomingSlot = incoming.toolSlots[toolIndex];
    const observed = incomingSlot && (
      typeof incomingSlot.loaded === 'boolean' || incomingSlot.name || incomingSlot.material || incomingSlot.color
    );
    if (observed) return { ...incomingSlot };
    const priorSlot = prior.toolSlots[toolIndex];
    return priorSlot ? { ...priorSlot } : {
      toolIndex,
      toolLabel: toolIndex + 1,
      loaded: null,
      name: null,
      material: null,
      color: null,
    };
  });
  return { toolCount, toolSlots };
}

function resolveToolSettings(settings, detected, options = {}) {
  const overrides = normalizeToolSettings(settings);
  const automatic = normalizeDetectedToolSettings(detected);
  const highestOverride = Object.keys(overrides.toolSlots)
    .reduce((highest, key) => Math.max(highest, Number(key)), 0);
  const minimum = Number.isInteger(options.minimumToolCount) && options.minimumToolCount >= 1 &&
    options.minimumToolCount <= MAX_TOOLS ? options.minimumToolCount : 0;
  const baseCount = overrides.toolCount != null
    ? overrides.toolCount
    : automatic.toolCount != null ? automatic.toolCount : Math.max(1, highestOverride);
  const toolCount = Math.min(MAX_TOOLS, Math.max(baseCount, minimum));
  const toolCountSource = overrides.toolCount != null
    ? 'override' : automatic.toolCount != null ? 'connect' : 'fallback';
  const detectedByLabel = new Map(automatic.toolSlots.map((slot) => [slot.toolLabel, slot]));

  const toolSlots = Array.from({ length: toolCount }, (_, toolIndex) => {
    const toolLabel = toolIndex + 1;
    const override = overrides.toolSlots[String(toolLabel)] || {};
    const auto = detectedByLabel.get(toolLabel) || {};
    const loadedOverridden = Object.hasOwn(override, 'loaded');
    const nameOverridden = Object.hasOwn(override, 'name');
    const colorOverridden = Object.hasOwn(override, 'color');
    const loaded = loadedOverridden ? override.loaded
      : typeof auto.loaded === 'boolean' ? auto.loaded : null;
    const name = nameOverridden ? override.name : auto.name || null;
    const material = auto.material || null;
    const color = colorOverridden ? override.color : auto.color || null;
    return {
      toolIndex,
      toolLabel,
      loaded,
      name,
      material,
      color,
      sources: {
        loaded: loadedOverridden ? 'override' : typeof auto.loaded === 'boolean' ? 'connect' : 'none',
        name: nameOverridden ? 'override' : auto.name ? 'connect' : 'none',
        material: auto.material ? 'connect' : 'none',
        color: colorOverridden ? 'override' : auto.color ? 'connect' : 'none',
      },
    };
  });

  return {
    toolCount,
    toolCountSource,
    countAdjusted: toolCount > baseCount,
    toolSlots,
    detected: automatic,
  };
}

function toPublicToolSlots(settings, detected, options) {
  return resolveToolSettings(settings, detected, options).toolSlots;
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

function createToolSettingsStore(options = {}) {
  const { dataFile, defaults, fs: fsImpl = nodeFs, logger = console } = options;
  if (typeof dataFile !== 'string' || dataFile.trim() === '') {
    throw new TypeError('dataFile must be a non-empty path string');
  }

  const fallback = normalizeConfigurationDefaults(defaults);
  const primary = readPersistedCandidate(fsImpl, dataFile);
  let current;

  if (primary.status === 'valid') {
    current = primary.value;
  } else {
    const backup = readPersistedCandidate(fsImpl, `${dataFile}.bak`);
    if (backup.status === 'valid') {
      current = backup.value;
      warn(logger, 'Tool settings primary was unusable; recovered from backup.');
    } else {
      current = fallback;
      if (primary.status === 'invalid' || backup.status === 'invalid') {
        warn(logger, 'Persisted tool settings were unusable; using configuration defaults.');
      }
    }
  }

  return Object.freeze({
    get() {
      return cloneToolSettings(current);
    },
    replace(input) {
      const next = normalizeToolSettings(input);
      const persisted = JSON.stringify({ version: SETTINGS_VERSION, ...next });
      writeFileAtomic(dataFile, persisted);
      try { writeFileAtomic(`${dataFile}.bak`, persisted); }
      catch { warn(logger, 'Tool settings backup could not be updated; the primary save succeeded.'); }
      current = next;
      return cloneToolSettings(current);
    },
  });
}

module.exports = {
  createToolSettingsStore,
  mergeConnectToolInventory,
  normalizeDetectedToolSettings,
  normalizeToolSettings,
  resolveToolSettings,
  restoreCachedConnectToolInventory,
  toPublicToolSlots,
};
