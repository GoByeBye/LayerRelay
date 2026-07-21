'use strict';

const { readJsonWithBackup, writeJsonAtomic } = require('./persistence.js');

const API_HOST = 'filamentcolors.xyz';
const API_PAGE_SIZE = 25;
const CACHE_VERSION = 1;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_QUERIES = 100;
const DEFAULT_TIMEOUT_MS = 12000;
const MIN_REQUEST_INTERVAL_MS = 1100;
const MAX_PENDING_QUERIES = 8;
const MAX_QUERY_LENGTH = 80;
const MAX_TEXT_LENGTH = 80;
const MAX_LABEL_LENGTH = 80;
const MAX_SLUG_LENGTH = 240;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_UPSTREAM_RESULTS = 100;
const MAX_SUGGESTIONS = 12;
const USER_AGENT = 'LayerRelay/0.1 filament-catalog (+https://github.com/GoByeBye/LayerRelay)';
const ABORTED_WORK = Symbol('aborted filament catalog work');

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
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? `#${match[1].toUpperCase()}` : null;
}

function safeSlug(value) {
  if (typeof value !== 'string' || value.length > MAX_SLUG_LENGTH) return null;
  const slug = value.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

function slugFromUrl(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.hostname !== API_HOST || parsed.search || parsed.hash) return null;
    const match = /^\/swatch\/([^/]+)\/?$/.exec(parsed.pathname);
    return match ? safeSlug(match[1]) : null;
  } catch {
    return null;
  }
}

function includesMaterialFamily(specific, parent) {
  const normalizedSpecific = comparable(specific);
  const normalizedParent = comparable(parent);
  if (!normalizedSpecific || !normalizedParent) return false;
  return normalizedSpecific === normalizedParent ||
    ` ${normalizedSpecific} `.includes(` ${normalizedParent} `);
}

function normalizeMaterial(value) {
  if (value.material != null) return boundedText(value.material);
  const specific = boundedText(value.filament_type?.name);
  const parent = boundedText(value.filament_type?.parent_type?.name, 32);
  if (!specific) return parent;
  if (!parent || includesMaterialFamily(specific, parent)) return specific;
  const suffix = ` (${parent})`;
  const prefix = truncateUtf16(specific, Math.max(1, MAX_TEXT_LENGTH - suffix.length)).trim();
  return `${prefix}${suffix}`;
}

function composeLabel(manufacturer, material, colorName) {
  const prefix = `${manufacturer} ${material} — `;
  const full = `${prefix}${colorName}`;
  if (full.length <= MAX_LABEL_LENGTH) return full;
  if (prefix.length < MAX_LABEL_LENGTH) {
    return truncateUtf16(full, MAX_LABEL_LENGTH).trim();
  }

  // Pathologically long manufacturer text must not push the material family out of the
  // persisted name; the overlay uses that token to reconcile PLA/PETG/etc.
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

function normalizeSuggestion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = value.id;
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const manufacturer = boundedText(
    typeof value.manufacturer === 'string' ? value.manufacturer : value.manufacturer?.name,
  );
  const material = normalizeMaterial(value);
  const colorName = boundedText(value.colorName ?? value.color_name);
  const color = normalizeHexColor(value.color ?? value.hex_color);
  const slug = safeSlug(value.slug) || slugFromUrl(value.url);
  if (!manufacturer || !material || !colorName || !color || !slug) return null;

  const label = composeLabel(manufacturer, material, colorName);
  if (!label) return null;
  return {
    id,
    label,
    manufacturer,
    material,
    colorName,
    color,
    url: `https://${API_HOST}/swatch/${slug}/`,
  };
}

function comparable(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function queryKey(query) {
  return query
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

function matchScore(text, token, weight) {
  if (!text || !text.includes(token)) return 0;
  if (text === token) return 160 + weight;
  const words = text.split(' ');
  if (words.some((word) => word === token)) return 120 + weight;
  if (words.some((word) => word.startsWith(token))) return 80 + weight;
  return 40 + weight;
}

function scoreSuggestion(suggestion, query) {
  const tokens = comparable(query).split(' ').filter(Boolean);
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

  const wholeQuery = comparable(query);
  const label = comparable(suggestion.label);
  if (label === wholeQuery) score += 300;
  else if (label.startsWith(wholeQuery)) score += 100;
  else if (label.includes(wholeQuery)) score += 50;
  return { score, matched, tokenCount: tokens.length };
}

function rankSuggestions(values, query, { requireAllTokens = false } = {}) {
  const unique = new Map();
  for (const value of values) {
    const suggestion = normalizeSuggestion(value);
    if (suggestion && !unique.has(suggestion.id)) unique.set(suggestion.id, suggestion);
  }
  return [...unique.values()]
    .map((suggestion) => ({ suggestion, ...scoreSuggestion(suggestion, query) }))
    .filter((entry) => !requireAllTokens || entry.matched === entry.tokenCount)
    .sort((left, right) =>
      right.matched - left.matched ||
      right.score - left.score ||
      left.suggestion.label.localeCompare(right.suggestion.label) ||
      left.suggestion.id - right.suggestion.id)
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

function cloneSearchResult(result) {
  return {
    suggestions: cloneSuggestions(result.suggestions),
    stale: result.stale,
    unavailable: result.unavailable,
  };
}

function createAbortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
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

function parseApiResponse(response) {
  if (!response || typeof response !== 'object' || Number(response.status) !== 200) {
    const status = response && Number(response.status);
    throw new Error(status === 429 ? 'upstream rate limited' : `upstream status ${status || 'unknown'}`);
  }
  let body = response.body;
  if (Buffer.isBuffer(body)) {
    if (body.length > MAX_RESPONSE_BYTES) throw new Error('upstream response too large');
    body = body.toString('utf8');
  }
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('upstream response too large');
    body = JSON.parse(body);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.results)) {
    throw new Error('upstream response schema invalid');
  }
  return body.results.slice(0, MAX_UPSTREAM_RESULTS);
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
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const timeoutMs = finiteInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 30000);
  const minIntervalMs = finiteInteger(
    options.minIntervalMs,
    MIN_REQUEST_INTERVAL_MS,
    MIN_REQUEST_INTERVAL_MS,
    60 * 1000,
  );
  const cacheTtlMs = finiteInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 0, 30 * 24 * 60 * 60 * 1000);
  const maxQueries = finiteInteger(options.maxQueries, DEFAULT_MAX_QUERIES, 1, 1000);
  const cache = new Map();
  const inFlight = new Map();
  const requestQueue = [];
  let activeRequest = null;
  let lastRequestStart = null;

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

  function pruneCache() {
    const ordered = [...cache.entries()].sort((left, right) =>
      right[1].savedAt - left[1].savedAt || left[0].localeCompare(right[0]));
    cache.clear();
    for (const [key, entry] of ordered.slice(0, maxQueries)) cache.set(key, entry);
  }

  function loadCache() {
    const saved = readJsonWithBackup(dataFile, null);
    if (!saved || saved.version !== CACHE_VERSION || !Array.isArray(saved.queries)) return;
    const current = timeNow();
    for (const raw of saved.queries.slice(0, 5000)) {
      if (!raw || typeof raw !== 'object') continue;
      const query = normalizeCatalogQuery(raw.query);
      const savedAt = Number(raw.savedAt);
      if (!query || !Number.isFinite(savedAt) || savedAt < 0 || !Array.isArray(raw.suggestions)) continue;
      const suggestions = rankSuggestions(raw.suggestions.slice(0, MAX_SUGGESTIONS), query);
      const key = queryKey(query);
      const entry = { query, savedAt: Math.min(savedAt, current), suggestions };
      const existing = cache.get(key);
      if (!existing || existing.savedAt < entry.savedAt) cache.set(key, entry);
    }
    pruneCache();
  }

  function persistCache() {
    pruneCache();
    const queries = [...cache.values()]
      .sort((left, right) => right.savedAt - left.savedAt || left.query.localeCompare(right.query))
      .map((entry) => ({
        query: entry.query,
        savedAt: entry.savedAt,
        suggestions: cloneSuggestions(entry.suggestions),
      }));
    try { writeJsonAtomic(dataFile, { version: CACHE_VERSION, queries }); }
    catch { warn('filament_catalog_cache_write_failed'); }
  }

  function putCache(query, suggestions) {
    const key = queryKey(query);
    cache.delete(key);
    cache.set(key, { query, savedAt: timeNow(), suggestions: cloneSuggestions(suggestions) });
    persistCache();
  }

  function fallbackFor(query) {
    const exact = cache.get(queryKey(query));
    if (exact) {
      return { suggestions: cloneSuggestions(exact.suggestions), stale: true, unavailable: true };
    }
    const allSuggestions = [];
    for (const entry of cache.values()) allSuggestions.push(...entry.suggestions);
    const suggestions = rankSuggestions(allSuggestions, query, { requireAllTokens: true });
    if (suggestions.length) {
      return { suggestions: cloneSuggestions(suggestions), stale: true, unavailable: true };
    }
    return { suggestions: [], stale: false, unavailable: true };
  }

  async function waitForInterval(milliseconds, signal) {
    throwIfAborted(signal);
    let onAbort;
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(createAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      await Promise.race([
        Promise.resolve().then(() => sleep(milliseconds)),
        aborted,
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    throwIfAborted(signal);
  }

  function settleRequestJob(job, settle, value) {
    if (job.state === 'settled') return;
    job.state = 'settled';
    job.signal.removeEventListener('abort', job.onAbort);
    settle(value);
  }

  function pumpRequestQueue() {
    if (activeRequest) return;
    const job = requestQueue.shift();
    if (!job) return;
    if (job.state !== 'queued') {
      pumpRequestQueue();
      return;
    }

    activeRequest = job;
    job.state = 'active';
    Promise.resolve()
      .then(async () => {
        throwIfAborted(job.signal);
        const current = timeNow();
        if (lastRequestStart != null) {
          const elapsed = Math.max(0, current - lastRequestStart);
          const waitMs = Math.max(0, minIntervalMs - elapsed);
          if (waitMs) await waitForInterval(waitMs, job.signal);
        }
        throwIfAborted(job.signal);
        const observed = timeNow();
        lastRequestStart = lastRequestStart == null
          ? observed
          : Math.max(observed, lastRequestStart + minIntervalMs);
        return job.task();
      })
      .then(
        (result) => settleRequestJob(job, job.resolve, result),
        (error) => settleRequestJob(job, job.reject, error),
      )
      .finally(() => {
        if (activeRequest === job) activeRequest = null;
        pumpRequestQueue();
      });
  }

  function scheduleRequest(signal, task) {
    return new Promise((resolve, reject) => {
      const job = {
        signal,
        task,
        resolve,
        reject,
        state: 'queued',
        onAbort: null,
      };
      job.onAbort = () => {
        if (job.state !== 'queued') return;
        const index = requestQueue.indexOf(job);
        if (index >= 0) requestQueue.splice(index, 1);
        settleRequestJob(job, reject, createAbortError());
      };
      signal.addEventListener('abort', job.onAbort, { once: true });
      if (signal.aborted) {
        job.onAbort();
        return;
      }
      requestQueue.push(job);
      pumpRequestQueue();
    });
  }

  async function fetchSuggestions(query, signal) {
    return scheduleRequest(signal, async () => {
      throwIfAborted(signal);
      const response = await request(API_HOST, {
        method: 'GET',
        path: `/api/swatch/?q=${encodeURIComponent(query)}&page_size=${API_PAGE_SIZE}`,
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        signal,
      }, null, timeoutMs);
      throwIfAborted(signal);
      const suggestions = rankSuggestions(parseApiResponse(response), query);
      putCache(query, suggestions);
      return { suggestions: cloneSuggestions(suggestions), stale: false, unavailable: false };
    });
  }

  function createWork(query, key) {
    const controller = new AbortController();
    const work = {
      key,
      query,
      controller,
      consumers: 0,
      settled: false,
      promise: null,
    };
    work.promise = fetchSuggestions(query, controller.signal)
      .catch((error) => {
        if (controller.signal.aborted || isAbortError(error)) return ABORTED_WORK;
        warn('filament_catalog_upstream_unavailable');
        return fallbackFor(query);
      })
      .finally(() => {
        work.settled = true;
        if (inFlight.get(key) === work) inFlight.delete(key);
      });
    return work;
  }

  function cancelWork(work) {
    if (work.settled || work.controller.signal.aborted) return;
    if (inFlight.get(work.key) === work) inFlight.delete(work.key);
    work.controller.abort();
  }

  function consumeWork(work, signal) {
    if (signal?.aborted) return Promise.reject(createAbortError());
    work.consumers += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const detach = () => {
        if (finished) return false;
        finished = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        work.consumers = Math.max(0, work.consumers - 1);
        return true;
      };
      const onAbort = () => {
        if (!detach()) return;
        reject(createAbortError());
        if (work.consumers === 0) cancelWork(work);
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
      }

      work.promise.then(
        (result) => {
          if (!detach()) return;
          if (result === ABORTED_WORK) reject(createAbortError());
          else resolve(cloneSearchResult(result));
        },
        (error) => {
          if (!detach()) return;
          if (work.controller.signal.aborted || isAbortError(error)) reject(createAbortError());
          else reject(error);
        },
      );
    });
  }

  async function search(value, { signal } = {}) {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const query = normalizeCatalogQuery(value);
    if (!query) return { suggestions: [], stale: false, unavailable: false };
    const key = queryKey(query);
    const cached = cache.get(key);
    if (cached && cacheTtlMs > 0 && timeNow() - cached.savedAt < cacheTtlMs) {
      return cloneSearchResult({
        suggestions: cached.suggestions,
        stale: false,
        unavailable: false,
      });
    }
    let active = inFlight.get(key);
    if (active?.controller.signal.aborted) {
      if (inFlight.get(key) === active) inFlight.delete(key);
      active = null;
    }
    if (active) return consumeWork(active, signal);
    if (inFlight.size >= MAX_PENDING_QUERIES) {
      warn('filament_catalog_queue_full');
      return fallbackFor(query);
    }
    const work = createWork(query, key);
    inFlight.set(key, work);
    return consumeWork(work, signal);
  }

  loadCache();
  return { search };
}

module.exports = {
  createFilamentCatalog,
  normalizeCatalogQuery,
  normalizeSuggestion,
};
