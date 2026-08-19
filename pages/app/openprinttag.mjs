/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Browser ESM port of openprinttag-index.js (repo root): the OpenPrintTag
 * filament catalog behind the virtual /api/filaments endpoint. Normalization,
 * ranking, and result semantics are kept identical; the Node HTTPS transport
 * and disk cache are replaced by fetch (database.openprinttag.org serves
 * Access-Control-Allow-Origin: *) and localStorage.
 */

const API_ORIGIN = 'https://database.openprinttag.org';
const MATERIALS_PATH = '/api/materials.json';
const BRANDS_PATH = '/api/brands/basic.json';
const CACHE_KEY = 'layer-relay.static.openprinttag-v1';
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MIN_DATASET_ENTRIES = 100;
const MIN_LAST_GOOD_RETENTION_RATIO = 0.5;
const MAX_QUERY_LENGTH = 80;
const MAX_TEXT_LENGTH = 80;
const MAX_TYPE_LENGTH = 40;
const MAX_LABEL_LENGTH = 80;
const MAX_SLUG_LENGTH = 240;
const MAX_MATERIAL_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_BRAND_RESPONSE_BYTES = 512 * 1024;
const MAX_MATERIAL_ENTRIES = 25000;
const MAX_BRAND_ENTRIES = 2000;
const MAX_SUGGESTIONS = 12;

function truncateCodePoints(value, maximum) {
  const points = Array.from(value);
  return points.length <= maximum ? value : points.slice(0, maximum).join('');
}

// Surrogate checks by char code instead of regex classes, so no escape can be
// mangled between source encodings; semantics match the root module.
function endsWithHighSurrogate(value) {
  if (!value.length) return false;
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

function startsWithLowSurrogate(value) {
  if (!value.length) return false;
  const code = value.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}

function truncateUtf16(value, maximum) {
  if (value.length <= maximum) return value;
  let truncated = value.slice(0, maximum);
  if (endsWithHighSurrogate(truncated)) truncated = truncated.slice(0, -1);
  return truncated;
}

export function boundedLabel(value, maximum = MAX_LABEL_LENGTH) {
  if (value.length <= maximum) return value;
  const marker = '…';
  const available = Math.max(0, maximum - marker.length);
  const prefixUnits = Math.ceil(available * 2 / 3);
  const suffixUnits = available - prefixUnits;
  const prefix = truncateUtf16(value, prefixUnits).trimEnd();
  let suffix = value.slice(Math.max(0, value.length - suffixUnits));
  if (startsWithLowSurrogate(suffix)) suffix = suffix.slice(1);
  return `${prefix}${marker}${suffix.trimStart()}`;
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

function boundedProductName(value) {
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  return boundedLabel(cleaned, MAX_TEXT_LENGTH).trim() || null;
}

function normalizeQuery(value) {
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  const length = Array.from(cleaned).length;
  return length >= 2 && length <= MAX_QUERY_LENGTH ? cleaned : null;
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

export function comparable(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function materialId(material) {
  return `${material.brandSlug}/${material.slug}`;
}

function normalizeBrand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const slug = safeSlug(value.slug);
  const name = boundedText(value.name);
  return slug && name ? { slug, name } : null;
}

function sourceBrandSlug(value) {
  const embeddedValue = value?.brand?.slug;
  const idValue = value?.brandId;
  const embedded = embeddedValue == null ? null : safeSlug(embeddedValue);
  const brandId = idValue == null ? null : safeSlug(idValue);
  if ((embeddedValue != null && !embedded) || (idValue != null && !brandId)) return null;
  if (embedded && brandId && embedded !== brandId) return null;
  return embedded || brandId;
}

function normalizeSourceMaterial(value, brandNames) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.class !== 'FFF') {
    return null;
  }
  const brandSlug = sourceBrandSlug(value);
  const slug = safeSlug(value.slug);
  const brand = brandSlug ? brandNames.get(brandSlug) : null;
  // Type is deliberately not inferred from names or abbreviations. Only the
  // official FFF type can become a tool configuration suggestion.
  const type = boundedText(value.type, MAX_TYPE_LENGTH);
  const name = boundedProductName(value.name);
  if (!brandSlug || !slug || !brand || !type || !name) return null;
  return {
    brandSlug,
    slug,
    brand,
    type,
    name,
    color: normalizeHexColor(value.primary_color?.color_rgba),
  };
}

function normalizeCachedMaterial(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const brandSlug = safeSlug(value.brandSlug);
  const slug = safeSlug(value.slug);
  const brand = boundedText(value.brand);
  const type = boundedText(value.type, MAX_TYPE_LENGTH);
  const name = boundedProductName(value.name);
  const color = value.color == null ? null : normalizeHexColor(value.color);
  if (!brandSlug || !slug || !brand || !type || !name || (value.color != null && !color)) {
    return null;
  }
  return { brandSlug, slug, brand, type, name, color };
}

function normalizeCanonicalCachedMaterial(value) {
  const normalized = normalizeCachedMaterial(value);
  if (!normalized) return null;
  const expectedKeys = ['brandSlug', 'slug', 'brand', 'type', 'name', 'color'];
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
    return null;
  }
  return expectedKeys.every((key) => value[key] === normalized[key]) ? normalized : null;
}

function publicSuggestion(material) {
  return {
    label: boundedLabel(`${material.brand} — ${material.name}`).trim(),
    color: material.color,
  };
}

export function buildSearchIndex(materials) {
  return materials
    .map((material) => ({
      id: materialId(material),
      searchText: comparable(`${material.brand} ${material.type} ${material.name}`),
      typeTokens: [...new Set(comparable(material.type).split(' ').filter(Boolean))],
      suggestion: publicSuggestion(material),
    }))
    .sort((left, right) =>
      left.suggestion.label.localeCompare(right.suggestion.label) ||
      left.id.localeCompare(right.id));
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
    const material = normalizeSourceMaterial(raw, brandNames);
    if (material && !unique.has(materialId(material))) unique.set(materialId(material), material);
  }
  if (unique.size < minimumEntries) throw new Error('upstream material dataset is unexpectedly small');
  const materials = [...unique.values()].sort((left, right) =>
    materialId(left).localeCompare(materialId(right)));
  const brands = [...brandNames.entries()].map(([slug, name]) => ({ slug, name }));
  return { materials, brands };
}

function finiteInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, Math.round(number)))
    : fallback;
}

function defaultStorage() {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage
      ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

export function createFilamentIndex(options = {}) {
  const fetchImpl = options.fetchImpl ||
    (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const storage = Object.hasOwn(options, 'storage') ? options.storage : defaultStorage();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const timeoutMs = finiteInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 60000);
  const cacheTtlMs = finiteInteger(
    options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 0, 30 * 24 * 60 * 60 * 1000);
  const retryCooldownMs = finiteInteger(
    options.retryCooldownMs, DEFAULT_RETRY_COOLDOWN_MS, 0, 24 * 60 * 60 * 1000);
  const minimumEntries = finiteInteger(
    options.minDatasetEntries, DEFAULT_MIN_DATASET_ENTRIES, 1, MAX_MATERIAL_ENTRIES);

  let materials = [];
  let brands = [];
  let searchIndex = [];
  let checkedAt = 0;
  let nextRetryAt = 0;
  let lastRefreshFailed = false;
  let refreshPromise = null;

  const timeNow = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };

  function install(nextMaterials, nextBrands) {
    searchIndex = buildSearchIndex(nextMaterials);
    materials = nextMaterials;
    brands = Array.isArray(nextBrands) ? nextBrands : [];
  }

  function loadCache() {
    if (!storage) return;
    let saved;
    try { saved = JSON.parse(storage.getItem(CACHE_KEY) || 'null'); }
    catch { return; }
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.materials) ||
        saved.materials.length > MAX_MATERIAL_ENTRIES) {
      return;
    }
    const unique = new Map();
    for (const raw of saved.materials) {
      const material = normalizeCanonicalCachedMaterial(raw);
      if (!material) return;
      const id = materialId(material);
      if (unique.has(id)) return;
      unique.set(id, material);
    }
    if (unique.size < minimumEntries) return;
    const savedBrands = Array.isArray(saved.brands)
      ? saved.brands.map(normalizeBrand).filter(Boolean) : [];
    install(
      [...unique.values()].sort((left, right) => materialId(left).localeCompare(materialId(right))),
      savedBrands,
    );
    const savedAt = Number(saved.savedAt);
    checkedAt = Number.isFinite(savedAt) && savedAt >= 0 ? Math.min(savedAt, timeNow()) : 0;
  }

  function persistCache() {
    if (!storage) return;
    try {
      storage.setItem(CACHE_KEY, JSON.stringify({ savedAt: checkedAt, materials, brands }));
    } catch {
      // Quota exceeded or storage unavailable: the in-memory dataset still works.
    }
  }

  function cacheIsFresh() {
    if (!materials.length || cacheTtlMs <= 0) return false;
    return Math.max(0, timeNow() - checkedAt) < cacheTtlMs;
  }

  async function fetchJsonArray(path, maximumBytes, maximumEntries) {
    const init = {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(timeoutMs);
    }
    const response = await fetchImpl(API_ORIGIN + path, init);
    const status = response && Number(response.status);
    if (status !== 200) throw new Error(`upstream status ${status || 'unknown'}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new Error('upstream response too large');
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(body) || body.length > maximumEntries) {
      throw new Error('upstream response schema invalid');
    }
    return body;
  }

  function refresh() {
    if (cacheIsFresh()) return Promise.resolve(true);
    if (refreshPromise) return refreshPromise;
    if (timeNow() < nextRetryAt) return Promise.resolve(false);

    refreshPromise = Promise.all([
      fetchJsonArray(MATERIALS_PATH, MAX_MATERIAL_RESPONSE_BYTES, MAX_MATERIAL_ENTRIES),
      fetchJsonArray(BRANDS_PATH, MAX_BRAND_RESPONSE_BYTES, MAX_BRAND_ENTRIES),
    ]).then(([materialValues, brandValues]) => {
      const next = normalizeDataset(materialValues, brandValues, minimumEntries);
      const minimumRetainedEntries = materials.length
        ? Math.ceil(materials.length * MIN_LAST_GOOD_RETENTION_RATIO)
        : 0;
      if (next.materials.length < minimumRetainedEntries) {
        throw new Error('upstream material dataset shrank implausibly');
      }
      install(next.materials, next.brands);
      checkedAt = timeNow();
      nextRetryAt = 0;
      lastRefreshFailed = false;
      persistCache();
      return true;
    }).catch(() => {
      nextRetryAt = timeNow() + retryCooldownMs;
      lastRefreshFailed = true;
      return false;
    }).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function search(value) {
    const query = normalizeQuery(value);
    if (!query) {
      return { suggestions: [], stale: false, unavailable: false, loading: false };
    }

    const stale = materials.length > 0 && !cacheIsFresh();
    if (!materials.length || stale) void refresh();
    const loading = refreshPromise != null;
    const tokens = [...new Set(comparable(query).split(' ').filter(Boolean))];
    const suggestions = [];
    if (tokens.length) {
      const tokenSet = new Set(tokens);
      const matchesByTypeTokenCount = new Map();
      let maximumTypeTokenCount = 0;
      for (const entry of searchIndex) {
        if (!tokens.every((token) => entry.searchText.includes(token))) continue;
        const typeTokenCount = entry.typeTokens.length > 0 &&
          entry.typeTokens.every((token) => tokenSet.has(token))
          ? entry.typeTokens.length
          : 0;
        if (!matchesByTypeTokenCount.has(typeTokenCount)) {
          matchesByTypeTokenCount.set(typeTokenCount, []);
        }
        matchesByTypeTokenCount.get(typeTokenCount).push(entry);
        maximumTypeTokenCount = Math.max(maximumTypeTokenCount, typeTokenCount);
      }

      for (let typeTokenCount = maximumTypeTokenCount;
        typeTokenCount >= 0 && suggestions.length < MAX_SUGGESTIONS;
        typeTokenCount--) {
        for (const entry of matchesByTypeTokenCount.get(typeTokenCount) || []) {
          suggestions.push({ ...entry.suggestion });
          if (suggestions.length === MAX_SUGGESTIONS) break;
        }
      }
    }
    return {
      suggestions,
      stale,
      unavailable: (!materials.length && !loading) || (stale && lastRefreshFailed),
      loading,
    };
  }

  loadCache();
  return { refresh, search };
}
