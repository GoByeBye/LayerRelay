/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Browser ESM port of the pure core of tool-settings.js (repo root): the
 * normalize/resolve pipeline is kept semantically identical so the static
 * dashboard's tools editor behaves exactly like the server one. The Node
 * store (disk persistence, SHA-256 revisions) is replaced by a localStorage
 * store with FNV-1a 64-bit revisions, since WebCrypto digests are async and
 * the engine needs synchronous ETags.
 */

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

export function normalizeToolSettings(input) {
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

function cloneToolSettings(settings) {
  const toolSlots = {};
  for (const [slot, value] of Object.entries(settings.toolSlots)) {
    toolSlots[slot] = { ...value };
  }
  return { toolCount: settings.toolCount, toolSlots };
}

// FNV-1a 64-bit of the settings JSON: a stable synchronous revision string.
// (The server uses SHA-256; the overlay only compares ETags for equality, so
// any collision-unlikely deterministic hash preserves the If-Match protocol.)
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

function fnv1a64Hex(text) {
  const bytes = new TextEncoder().encode(text);
  let hash = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

function etagFor(settings) {
  return `"${fnv1a64Hex(JSON.stringify(settings))}"`;
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

export function normalizeDetectedToolSettings(input) {
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

export function resolveToolSettings(settings, detected, options = {}) {
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

export function toPublicToolSlots(settings, detected, options) {
  return resolveToolSettings(settings, detected, options).toolSlots;
}

function defaultStorage() {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage
      ? globalThis.localStorage : null;
  } catch {
    // Private-mode Safari and locked-down contexts throw on access.
    return null;
  }
}

const DEFAULT_SETTINGS = () => ({ toolCount: null, toolSlots: {} });

// Browser counterpart of createToolSettingsStore: same get/etag/replace
// surface, persisted in localStorage (falling back to memory-only when
// storage is unavailable or over quota).
export function createBrowserToolSettingsStore(
  storageKey = 'layer-relay.static.tool-settings',
  storage = defaultStorage(),
) {
  let current = DEFAULT_SETTINGS();
  try {
    const raw = storage ? storage.getItem(storageKey) : null;
    if (raw) current = normalizePersistedSettings(JSON.parse(raw));
  } catch {
    current = DEFAULT_SETTINGS();
  }

  function persist() {
    if (!storage) return;
    try {
      storage.setItem(storageKey, JSON.stringify({ version: SETTINGS_VERSION, ...current }));
    } catch {
      // Quota or private-mode failure: the in-memory copy stays authoritative.
    }
  }

  return Object.freeze({
    get() {
      return cloneToolSettings(current);
    },
    etag() {
      return etagFor(current);
    },
    replace(input, expectedEtag) {
      if (expectedEtag != null && expectedEtag !== etagFor(current)) {
        const error = new Error('tool settings changed since they were loaded');
        error.code = 'TOOL_SETTINGS_CONFLICT';
        throw error;
      }
      const next = normalizeToolSettings(input);
      current = next;
      persist();
      return cloneToolSettings(current);
    },
  });
}
