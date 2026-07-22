'use strict';

const { readJsonValidatedWithBackup, writeJsonAtomic } = require('./persistence.js');

const API_HOST = 'database.openprinttag.org';
const MATERIALS_PATH = '/api/materials.json';
const BRANDS_PATH = '/api/brands/basic.json';
const SOURCE_URL = `https://${API_HOST}${MATERIALS_PATH}`;
const CACHE_VERSION = 2;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MIN_DATASET_ENTRIES = 100;
const MAX_QUERY_LENGTH = 80;
const MAX_TEXT_LENGTH = 80;
const MAX_MATERIAL_LENGTH = 40;
const MAX_LABEL_LENGTH = 80;
const MAX_SLUG_LENGTH = 240;
const MAX_MATERIAL_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_BRAND_RESPONSE_BYTES = 512 * 1024;
const MAX_MATERIAL_ENTRIES = 25000;
const MAX_BRAND_ENTRIES = 2000;
const MAX_SUGGESTIONS = 12;
const USER_AGENT = 'LayerRelay/0.1 filament-catalog (+https://github.com/GoByeBye/LayerRelay)';

function truncateCodePoints(value, maximum) {
  const points = Array.from(value);
  return points.length <= maximum ? value : points.slice(0, maximum).join('');
}

function truncateUtf16(value, maximum) {
  if (value.length <= maximum) return value;
  let truncated = value.slice(0, maximum);
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
  return truncated;
}

function cleanText(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let normalized;
  try { normalized = value.normalize('NFKC'); }
  catch { return null; }
  normalized = normalized
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized || null;
}

function boundedText(value, maximum = MAX_TEXT_LENGTH) {
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  return truncateCodePoints(cleaned, maximum).trim() || null;
}

function normalizeCatalogQuery(value) {
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  return Array.from(cleaned).length >= 2 && cleaned.length <= MAX_QUERY_LENGTH ? cleaned : null;
}

function normalizeHexColor(value) {
  if (typeof value !== 'string') return null;
  const match = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim());
  if (!match || (match[2] && match[2].toLowerCase() !== 'ff')) return null;
  return `#${match[1].toUpperCase()}`;
}

function safeSlug(value) {
  if (typeof value !== 'string' || value.length > MAX_SLUG_LENGTH) return null;
  const slug = value.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

function comparable(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function includesMaterialFamily(specific, parent) {
  const normalizedSpecific = comparable(specific);
  const normalizedParent = comparable(parent);
  if (!normalizedSpecific || !normalizedParent) return false;
  return normalizedSpecific === normalizedParent ||
    ` ${normalizedSpecific} `.includes(` ${normalizedParent} `);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deriveColorName(name, material) {
  const pattern = new RegExp(`^${escapeRegExp(material)}(?:\\s+|\\s*[-–—,:]\\s*)`, 'iu');
  const withoutMaterial = name.replace(pattern, '').trim();
  return boundedText(withoutMaterial || name);
}

function composeLabel(manufacturer, material, colorName) {
  const materialAlreadyNamed = includesMaterialFamily(colorName, material);
  const prefix = materialAlreadyNamed
    ? `${manufacturer} — `
    : `${manufacturer} ${material} — `;
  const full = `${prefix}${colorName}`;
  if (full.length <= MAX_LABEL_LENGTH) return full;
  if (prefix.length < MAX_LABEL_LENGTH) return truncateUtf16(full, MAX_LABEL_LENGTH).trim();

  const materialSuffix = ` ${material}`;
  if (materialSuffix.length >= MAX_LABEL_LENGTH) {
    return truncateUtf16(material, MAX_LABEL_LENGTH).trim();
  }
  const shortenedManufacturer = truncateUtf16(
    manufacturer,
    MAX_LABEL_LENGTH - materialSuffix.length,
  ).trim();
  return `${shortenedManufacturer}${materialSuffix}`.trim();
}

function sourcePathFromUrl(value) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.hostname !== API_HOST || parsed.search || parsed.hash) {
      return null;
    }
    const match = /^\/api\/brands\/([^/]+)\/materials\/([^/]+)\.json$/.exec(parsed.pathname);
    if (!match) return null;
    const brandSlug = safeSlug(match[1]);
    const materialSlug = safeSlug(match[2]);
    return brandSlug && materialSlug ? { brandSlug, materialSlug } : null;
  } catch {
    return null;
  }
}

function normalizeBrand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const slug = safeSlug(value.slug);
  const name = boundedText(value.name);
  return slug && name ? { slug, name } : null;
}

function materialBrandSlug(value) {
  const embeddedValue = value?.brand?.slug;
  const idValue = value?.brandId;
  const embedded = embeddedValue == null ? null : safeSlug(embeddedValue);
  const brandId = idValue == null ? null : safeSlug(idValue);
  if ((embeddedValue != null && !embedded) || (idValue != null && !brandId)) return null;
  if (embedded && brandId && embedded !== brandId) return null;
  return embedded || brandId;
}

function normalizeSourceSuggestion(value, brandNames) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.class !== 'FFF') {
    return null;
  }
  const brandSlug = materialBrandSlug(value);
  const materialSlug = safeSlug(value.slug);
  const manufacturer = brandSlug ? brandNames.get(brandSlug) : null;
  // Only the official type field is accepted. Name/abbreviation inference could
  // silently turn incomplete or SLA records into a filament configuration.
  const material = boundedText(value.type, MAX_MATERIAL_LENGTH);
  const name = boundedText(value.name);
  if (!brandSlug || !materialSlug || !manufacturer || !material || !name) return null;
  const colorName = deriveColorName(name, material);
  if (!colorName) return null;
  return {
    id: `${brandSlug}/${materialSlug}`,
    label: composeLabel(manufacturer, material, colorName),
    manufacturer,
    material,
    colorName,
    color: normalizeHexColor(value.primary_color?.color_rgba),
    url: `https://${API_HOST}/api/brands/${brandSlug}/materials/${materialSlug}.json`,
  };
}

function normalizeCachedSuggestion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourcePath = sourcePathFromUrl(value.url);
  const manufacturer = boundedText(value.manufacturer);
  const material = boundedText(value.material, MAX_MATERIAL_LENGTH);
  const colorName = boundedText(value.colorName);
  if (!sourcePath || !manufacturer || !material || !colorName) return null;
  return {
    id: `${sourcePath.brandSlug}/${sourcePath.materialSlug}`,
    label: composeLabel(manufacturer, material, colorName),
    manufacturer,
    material,
    colorName,
    color: normalizeHexColor(value.color),
    url: `https://${API_HOST}/api/brands/${sourcePath.brandSlug}/materials/${sourcePath.materialSlug}.json`,
  };
}

function normalizeSuggestion(value, brandName) {
  if (value?.class === 'FFF') {
    const brandSlug = materialBrandSlug(value);
    const normalizedBrandName = boundedText(brandName ?? value.brandName);
    const brandNames = new Map();
    if (brandSlug && normalizedBrandName) brandNames.set(brandSlug, normalizedBrandName);
    return normalizeSourceSuggestion(value, brandNames);
  }
  return normalizeCachedSuggestion(value);
}

function matchScore(text, token, weight) {
  if (!text || !text.includes(token)) return 0;
  if (text === token) return 160 + weight;
  const words = text.split(' ');
  if (words.some((word) => word === token)) return 120 + weight;
  if (words.some((word) => word.startsWith(token))) return 80 + weight;
  return 40 + weight;
}

function scoreSuggestion(suggestion, tokens, wholeQuery) {
  const fields = [
    [comparable(suggestion.colorName), 30],
    [comparable(suggestion.manufacturer), 20],
    [comparable(suggestion.material), 10],
  ];
  let score = 0;
  let matched = 0;
  for (const token of tokens) {
    let best = 0;
    for (const [field, weight] of fields) best = Math.max(best, matchScore(field, token, weight));
    if (best > 0) matched += 1;
    score += best;
  }

  const label = comparable(suggestion.label);
  if (label === wholeQuery) score += 300;
  else if (label.startsWith(wholeQuery)) score += 100;
  else if (label.includes(wholeQuery)) score += 50;
  return { score, matched };
}

function rankSuggestions(values, query) {
  const wholeQuery = comparable(query);
  const tokens = wholeQuery.split(' ').filter(Boolean);
  if (!tokens.length) return [];
  return values
    .map((suggestion) => ({ suggestion, ...scoreSuggestion(suggestion, tokens, wholeQuery) }))
    .filter((entry) => entry.matched === tokens.length)
    .sort((left, right) =>
      right.score - left.score ||
      left.suggestion.label.localeCompare(right.suggestion.label) ||
      left.suggestion.id.localeCompare(right.suggestion.id))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.suggestion);
}

function finiteInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, Math.round(number)))
    : fallback;
}

function cloneSuggestions(suggestions) {
  return suggestions.map((suggestion) => ({ ...suggestion }));
}

function createAbortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function validateAbortSignal(signal) {
  if (signal == null) return;
  if (typeof signal !== 'object' || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function') {
    throw new TypeError('signal must be an AbortSignal');
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function waitForPromise(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function parseJsonArray(response, { maximumBytes, maximumEntries }) {
  if (!response || typeof response !== 'object' || Number(response.status) !== 200) {
    const status = response && Number(response.status);
    throw new Error(`upstream status ${status || 'unknown'}`);
  }
  let body = response.body;
  if (Buffer.isBuffer(body)) {
    if (body.length > maximumBytes) throw new Error('upstream response too large');
    body = body.toString('utf8');
  }
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > maximumBytes) {
      throw new Error('upstream response too large');
    }
    body = JSON.parse(body);
  }
  if (!Array.isArray(body) || body.length > maximumEntries) {
    throw new Error('upstream response schema invalid');
  }
  return body;
}

function normalizeDataset(materialValues, brandValues, minimumEntries) {
  const brandNames = new Map();
  for (const raw of brandValues) {
    const brand = normalizeBrand(raw);
    if (brand && !brandNames.has(brand.slug)) brandNames.set(brand.slug, brand.name);
  }
  if (!brandNames.size) throw new Error('upstream brand index contains no usable entries');

  const unique = new Map();
  for (const raw of materialValues) {
    const suggestion = normalizeSourceSuggestion(raw, brandNames);
    if (suggestion && !unique.has(suggestion.id)) unique.set(suggestion.id, suggestion);
  }
  if (unique.size < minimumEntries) throw new Error('upstream material dataset is unexpectedly small');
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function createFilamentCatalog(options = {}) {
  if (typeof options.request !== 'function') throw new TypeError('request must be a function');
  if (typeof options.dataFile !== 'string' || !options.dataFile.trim()) {
    throw new TypeError('dataFile must be a non-empty path');
  }

  const request = options.request;
  const dataFile = options.dataFile;
  const logger = options.logger || console;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const timeoutMs = finiteInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 30000);
  const cacheTtlMs = finiteInteger(
    options.cacheTtlMs,
    DEFAULT_CACHE_TTL_MS,
    0,
    30 * 24 * 60 * 60 * 1000,
  );
  const retryCooldownMs = finiteInteger(
    options.retryCooldownMs,
    DEFAULT_RETRY_COOLDOWN_MS,
    0,
    24 * 60 * 60 * 1000,
  );
  const minimumEntries = finiteInteger(
    options.minDatasetEntries,
    DEFAULT_MIN_DATASET_ENTRIES,
    1,
    MAX_MATERIAL_ENTRIES,
  );
  let suggestions = [];
  let checkedAt = 0;
  let nextRetryAt = 0;
  let lastRefreshFailed = false;
  let refreshPromise = null;

  const timeNow = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };
  const warn = (code) => {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(code);
      else if (typeof logger === 'function') logger(code);
    } catch { /* logging must not break manual fallback */ }
  };

  function normalizeSavedCache(saved) {
    if (!saved || saved.version !== CACHE_VERSION || saved.source !== SOURCE_URL ||
        !Array.isArray(saved.suggestions) || saved.suggestions.length > MAX_MATERIAL_ENTRIES) {
      return null;
    }
    const unique = new Map();
    for (const raw of saved.suggestions) {
      const suggestion = normalizeCachedSuggestion(raw);
      if (suggestion && !unique.has(suggestion.id)) unique.set(suggestion.id, suggestion);
    }
    if (unique.size < minimumEntries) return null;
    const savedAt = Number(saved.checkedAt);
    return {
      suggestions: [...unique.values()].sort((left, right) => left.id.localeCompare(right.id)),
      checkedAt: Number.isFinite(savedAt) && savedAt >= 0 ? Math.min(savedAt, timeNow()) : 0,
    };
  }

  function persistCache() {
    try {
      writeJsonAtomic(dataFile, {
        version: CACHE_VERSION,
        source: SOURCE_URL,
        checkedAt,
        suggestions: cloneSuggestions(suggestions),
      });
    } catch {
      warn('filament_catalog_cache_write_failed');
    }
  }

  function loadCache() {
    const saved = readJsonValidatedWithBackup(dataFile, normalizeSavedCache, null);
    if (!saved) return;
    suggestions = saved.suggestions;
    checkedAt = saved.checkedAt;
  }

  function cacheIsFresh() {
    if (!suggestions.length || cacheTtlMs <= 0) return false;
    return Math.max(0, timeNow() - checkedAt) < cacheTtlMs;
  }

  function fixedRequest(path, maximumBytes) {
    return request(API_HOST, {
      method: 'GET',
      path,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    }, null, timeoutMs, { maxResponseBytes: maximumBytes });
  }

  function refreshDataset() {
    if (refreshPromise) return refreshPromise;
    if (timeNow() < nextRetryAt) return Promise.resolve(false);
    refreshPromise = Promise.resolve().then(async () => {
      const [materialsResponse, brandsResponse] = await Promise.all([
        fixedRequest(MATERIALS_PATH, MAX_MATERIAL_RESPONSE_BYTES),
        fixedRequest(BRANDS_PATH, MAX_BRAND_RESPONSE_BYTES),
      ]);
      const materialValues = parseJsonArray(materialsResponse, {
        maximumBytes: MAX_MATERIAL_RESPONSE_BYTES,
        maximumEntries: MAX_MATERIAL_ENTRIES,
      });
      const brandValues = parseJsonArray(brandsResponse, {
        maximumBytes: MAX_BRAND_RESPONSE_BYTES,
        maximumEntries: MAX_BRAND_ENTRIES,
      });
      const nextSuggestions = normalizeDataset(materialValues, brandValues, minimumEntries);
      suggestions = nextSuggestions;
      checkedAt = timeNow();
      nextRetryAt = 0;
      lastRefreshFailed = false;
      persistCache();
      return true;
    }).catch(() => {
      nextRetryAt = timeNow() + retryCooldownMs;
      lastRefreshFailed = true;
      warn('filament_catalog_refresh_failed');
      return false;
    }).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function warm() {
    return cacheIsFresh() ? Promise.resolve(true) : refreshDataset();
  }

  async function search(value, { signal } = {}) {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const query = normalizeCatalogQuery(value);
    if (!query) return { suggestions: [], stale: false, unavailable: false };

    if (suggestions.length) {
      const stale = !cacheIsFresh();
      if (stale) void refreshDataset();
      return {
        suggestions: cloneSuggestions(rankSuggestions(suggestions, query)),
        stale,
        unavailable: stale && lastRefreshFailed,
      };
    }

    const refreshed = await waitForPromise(refreshDataset(), signal);
    throwIfAborted(signal);
    return {
      suggestions: cloneSuggestions(rankSuggestions(suggestions, query)),
      stale: false,
      unavailable: !refreshed,
    };
  }

  loadCache();
  return { search, warm };
}

module.exports = {
  createFilamentCatalog,
  normalizeCatalogQuery,
  normalizeSuggestion,
};
