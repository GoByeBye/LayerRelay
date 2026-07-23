'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { onTestFinished, test } = require('bun:test');
const { createOpenPrintTagIndex } = require('../openprinttag-index.js');

const API_HOST = 'database.openprinttag.org';
const MATERIALS_PATH = '/api/materials.json';
const BRANDS_PATH = '/api/brands/basic.json';
const USER_AGENT = 'LayerRelay/0.1 openprinttag-index (+https://github.com/GoByeBye/LayerRelay)';
const SILENT_LOGGER = { warn() {} };

function tempDataFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-openprinttag-'));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'openprinttag-materials-v1.json');
}

function sourceBrand(overrides = {}) {
  return {
    slug: 'acme',
    name: 'Acme',
    ...overrides,
  };
}

function sourceMaterial(overrides = {}) {
  return {
    slug: 'acme-pla-black',
    brand: { slug: 'acme' },
    brandId: 'acme',
    name: 'PLA Black',
    class: 'FFF',
    type: 'PLA',
    primary_color: { color_rgba: '#112233ff' },
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return { status, body: JSON.stringify(value) };
}

function datasetRequest(materials, brands, calls = []) {
  return async (...args) => {
    calls.push(args);
    if (args[1]?.path === MATERIALS_PATH) return jsonResponse(materials);
    if (args[1]?.path === BRANDS_PATH) return jsonResponse(brands);
    throw new Error(`unexpected OpenPrintTag path: ${args[1]?.path}`);
  };
}

function indexOptions(request, overrides = {}) {
  return {
    request,
    dataFile: tempDataFile(),
    logger: SILENT_LOGGER,
    minDatasetEntries: 1,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

test('rejects short or oversized queries without starting network work', () => {
  let calls = 0;
  const index = createOpenPrintTagIndex(indexOptions(async () => {
    calls += 1;
    return jsonResponse([]);
  }));

  for (const query of ['', ' ', 'x', '<', 'x'.repeat(81), null]) {
    assert.deepEqual(index.search(query), {
      suggestions: [],
      stale: false,
      unavailable: false,
      loading: false,
    });
  }
  assert.equal(calls, 0);
});

test('downloads fixed snapshots, strictly normalizes FFF records, and searches locally', async () => {
  const calls = [];
  const materials = [
    sourceMaterial(),
    sourceMaterial({
      slug: 'acme-pla-clear',
      name: 'PLA Clear',
      primary_color: { color_rgba: '#00000000' },
    }),
    sourceMaterial({ slug: 'acme-resin', name: 'Resin', class: 'SLA' }),
    sourceMaterial({ slug: 'acme-untyped', name: 'Mystery', type: null }),
    sourceMaterial({
      slug: 'acme-conflict',
      name: 'PLA Conflict',
      brandId: 'different-brand',
    }),
    sourceMaterial({
      slug: 'unknown-pla',
      name: 'PLA Unknown',
      brand: { slug: 'unknown' },
      brandId: 'unknown',
    }),
    sourceMaterial({ slug: '../escape' }),
  ];
  const brands = [
    sourceBrand(),
    sourceBrand({ slug: 'different-brand', name: 'Different Brand' }),
  ];
  const index = createOpenPrintTagIndex(indexOptions(
    datasetRequest(materials, brands, calls),
    { timeoutMs: 4321 },
  ));

  assert.equal(await index.refresh(), true);
  const result = index.search('acme pla');
  assert.equal(result instanceof Promise, false);
  assert.deepEqual(result, {
    suggestions: [
      { label: 'Acme — PLA Black', color: '#112233' },
      { label: 'Acme — PLA Clear', color: null },
    ],
    stale: false,
    unavailable: false,
    loading: false,
  });
  assert.equal(calls.length, 2);

  const byPath = new Map(calls.map((call) => [call[1].path, call]));
  assert.deepEqual([...byPath.keys()].sort(), [BRANDS_PATH, MATERIALS_PATH]);
  for (const call of calls) {
    assert.equal(call[0], API_HOST);
    assert.deepEqual(call[1], {
      method: 'GET',
      path: call[1].path,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    assert.equal(call[2], null);
    assert.equal(call[3], 4321);
  }
  assert.deepEqual(byPath.get(MATERIALS_PATH)[4], { maxResponseBytes: 16 * 1024 * 1024 });
  assert.deepEqual(byPath.get(BRANDS_PATH)[4], { maxResponseBytes: 512 * 1024 });
  assert.equal(JSON.stringify(calls).includes('acme pla'), false);
  assert.equal(index.search('different query').suggestions.length, 0);
  assert.equal(calls.length, 2);
});

test('requires every normalized token and returns at most twelve stable matches', async () => {
  const materials = Array.from({ length: 20 }, (_, index) => sourceMaterial({
    slug: `prusa-pla-orange-${String(index).padStart(2, '0')}`,
    brand: { slug: 'prusa' },
    brandId: 'prusa',
    name: `PLA Orange ${String(index).padStart(2, '0')}`,
    primary_color: { color_rgba: '#ff6600ff' },
  }));
  materials.push(sourceMaterial({
    slug: 'prusa-petg-orange',
    brand: { slug: 'prusa' },
    brandId: 'prusa',
    name: 'PETG Orange',
    type: 'PETG',
  }));
  materials.push(sourceMaterial({
    slug: 'prusa-pla-blue',
    brand: { slug: 'prusa' },
    brandId: 'prusa',
    name: 'PLA Blue',
  }));
  const index = createOpenPrintTagIndex(indexOptions(datasetRequest(
    materials,
    [sourceBrand({ slug: 'prusa', name: 'Prüsa' })],
  )));

  await index.refresh();
  const result = index.search('orange prusa pla');

  assert.equal(result.suggestions.length, 12);
  assert.ok(result.suggestions.every((item) => item.label.startsWith('Prüsa — PLA Orange')));
  assert.deepEqual(
    result.suggestions.map((item) => item.label),
    [...result.suggestions.map((item) => item.label)].sort((a, b) => a.localeCompare(b)),
  );
  assert.deepEqual(index.search('orange nylon').suggestions, []);
});

test('bounded labels retain distinguishing suffixes for long shared product names', async () => {
  const variants = [
    ['black', 'Black', '#545252ff'],
    ['blue', 'Blue', '#0099e6ff'],
    ['gray', 'Gray', '#808080ff'],
    ['red', 'Red', '#e72f1dff'],
    ['transparent', 'Transparent', '#f2ece9ff'],
  ];
  const materials = variants.map(([slug, suffix, color]) => sourceMaterial({
    slug: `rosa3d-filaments-rosa-tpu-hardtech-${slug}`,
    brand: { slug: 'rosa3d-filaments' },
    brandId: 'rosa3d-filaments',
    name: `ROSA TPU HardTech+ 83D, Impact - Abrasive - UV - H2O - microbe- resistant ${suffix}`,
    type: 'TPU',
    primary_color: { color_rgba: color },
  }));
  const index = createOpenPrintTagIndex(indexOptions(datasetRequest(
    materials,
    [sourceBrand({ slug: 'rosa3d-filaments', name: 'ROSA3D Filaments' })],
  )));

  await index.refresh();
  const suggestions = index.search('rosa hardtech').suggestions;

  assert.equal(suggestions.length, variants.length);
  assert.equal(new Set(suggestions.map((item) => item.label)).size, variants.length);
  assert.deepEqual(
    suggestions.map((item) => item.label),
    [...suggestions.map((item) => item.label)].sort((left, right) => left.localeCompare(right)),
  );
  assert.ok(suggestions.every((item) =>
    item.label.length <= 80 &&
    item.label.startsWith('ROSA3D Filaments — ') &&
    item.label.includes('…')));
  for (const [, suffix, color] of variants) {
    const suggestion = suggestions.find((item) => item.label.endsWith(suffix));
    assert.ok(suggestion, `expected a distinct ${suffix} suggestion`);
    assert.equal(suggestion.color, color.slice(0, 7).toUpperCase());
  }
});

test('bounded labels never split UTF-16 surrogate pairs at either retained edge', async () => {
  const name = `${'A'.repeat(45)}😀 middle ${'B'.repeat(40)}😀${'Z'.repeat(25)}`;
  const index = createOpenPrintTagIndex(indexOptions(datasetRequest(
    [sourceMaterial({ name })],
    [sourceBrand()],
  )));

  await index.refresh();
  const [suggestion] = index.search('acme').suggestions;

  assert.ok(suggestion.label.length <= 80);
  assert.equal(hasUnpairedSurrogate(suggestion.label), false);
});

test('persists only canonical OpenPrintTag fields and restores a valid backup locally', async () => {
  const dataFile = tempDataFile();
  const calls = [];
  const material = sourceMaterial({
    photos: [{ url: 'https://files.openprinttag.org/not-cached.png' }],
    properties: { privateish_note: 'not cached' },
    packages: [{ gtin: '123' }],
  });
  const request = datasetRequest(
    [material],
    [sourceBrand({ countries_of_origin: ['NO'] })],
    calls,
  );
  const options = {
    request,
    dataFile,
    logger: SILENT_LOGGER,
    minDatasetEntries: 1,
    now: () => 100,
    cacheTtlMs: 1000,
  };
  const index = createOpenPrintTagIndex(options);

  await index.refresh();
  index.search('private picker query');
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.deepEqual(Object.keys(persisted), ['version', 'checkedAt', 'materials']);
  assert.equal(persisted.version, 1);
  assert.deepEqual(Object.keys(persisted.materials[0]), [
    'brandSlug', 'slug', 'brand', 'type', 'name', 'color',
  ]);
  const serialized = JSON.stringify(persisted);
  for (const forbidden of [
    'private picker query', 'not-cached.png', 'privateish_note', 'gtin',
    'countries_of_origin',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(fs.existsSync(`${dataFile}.bak`), true);

  fs.writeFileSync(dataFile, JSON.stringify({
    version: 1,
    checkedAt: 100,
    materials: [{ brandSlug: '../bad' }],
  }));
  const restored = createOpenPrintTagIndex(options);
  assert.deepEqual(restored.search('black').suggestions, [
    { label: 'Acme — PLA Black', color: '#112233' },
  ]);
  assert.equal(calls.length, 2);
});

test('deduplicates concurrent two-snapshot refreshes', async () => {
  const materialsGate = deferred();
  const brandsGate = deferred();
  const calls = [];
  const index = createOpenPrintTagIndex(indexOptions((...args) => {
    calls.push(args);
    return args[1].path === MATERIALS_PATH ? materialsGate.promise : brandsGate.promise;
  }));

  const first = index.refresh();
  const second = index.refresh();
  assert.equal(first, second);
  assert.equal(calls.length, 2);
  assert.deepEqual(index.search('Acme'), {
    suggestions: [],
    stale: false,
    unavailable: false,
    loading: true,
  });

  materialsGate.resolve(jsonResponse([sourceMaterial()]));
  brandsGate.resolve(jsonResponse([sourceBrand()]));
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(calls.length, 2);
});

test('serves stale results synchronously while a shared refresh replaces the index', async () => {
  let now = 0;
  let calls = 0;
  const materialsGate = deferred();
  const brandsGate = deferred();
  const index = createOpenPrintTagIndex(indexOptions((host, requestOptions) => {
    calls += 1;
    if (calls <= 2) {
      return requestOptions.path === MATERIALS_PATH
        ? jsonResponse([sourceMaterial()])
        : jsonResponse([sourceBrand()]);
    }
    return requestOptions.path === MATERIALS_PATH ? materialsGate.promise : brandsGate.promise;
  }, {
    now: () => now,
    cacheTtlMs: 100,
  }));

  await index.refresh();
  now = 1000;
  const stale = index.search('black');
  assert.deepEqual(stale, {
    suggestions: [{ label: 'Acme — PLA Black', color: '#112233' }],
    stale: true,
    unavailable: false,
    loading: true,
  });
  assert.equal(calls, 4);

  const refreshing = index.refresh();
  materialsGate.resolve(jsonResponse([sourceMaterial({
    slug: 'acme-pla-orange',
    name: 'PLA Orange',
    primary_color: { color_rgba: '#ff6600ff' },
  })]));
  brandsGate.resolve(jsonResponse([sourceBrand()]));
  assert.equal(await refreshing, true);
  assert.deepEqual(index.search('orange'), {
    suggestions: [{ label: 'Acme — PLA Orange', color: '#FF6600' }],
    stale: false,
    unavailable: false,
    loading: false,
  });
  assert.equal(calls, 4);
});

test('preserves last-good data and observes retry cooldown after refresh failure', async () => {
  const dataFile = tempDataFile();
  const warnings = [];
  let now = 0;
  let calls = 0;
  let failing = false;
  const index = createOpenPrintTagIndex({
    request: async (host, requestOptions) => {
      calls += 1;
      if (failing) throw new Error('private query C:\\private\\catalog.json');
      return requestOptions.path === MATERIALS_PATH
        ? jsonResponse([sourceMaterial()])
        : jsonResponse([sourceBrand()]);
    },
    dataFile,
    logger: { warn(code) { warnings.push(code); } },
    minDatasetEntries: 1,
    now: () => now,
    cacheTtlMs: 100,
    retryCooldownMs: 500,
  });

  await index.refresh();
  const lastGood = fs.readFileSync(dataFile, 'utf8');
  now = 1000;
  failing = true;
  assert.equal(index.search('black').stale, true);
  assert.equal(await index.refresh(), false);

  assert.deepEqual(index.search('black'), {
    suggestions: [{ label: 'Acme — PLA Black', color: '#112233' }],
    stale: true,
    unavailable: true,
    loading: false,
  });
  assert.equal(await index.refresh(), false);
  assert.equal(calls, 4);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), lastGood);
  assert.deepEqual(warnings, ['openprinttag_refresh_failed']);
  assert.equal(JSON.stringify(warnings).includes('private'), false);
});

test('rejects malformed, undersized, and excessive generated datasets', async () => {
  async function rejects(request, overrides = {}) {
    const dataFile = tempDataFile();
    const index = createOpenPrintTagIndex(indexOptions(request, { dataFile, ...overrides }));
    assert.equal(await index.refresh(), false);
    assert.equal(fs.existsSync(dataFile), false);
    assert.deepEqual(index.search('orange'), {
      suggestions: [],
      stale: false,
      unavailable: true,
      loading: false,
    });
  }

  await rejects(async (host, requestOptions) => (
    requestOptions.path === MATERIALS_PATH
      ? jsonResponse({ results: [sourceMaterial()] })
      : jsonResponse([sourceBrand()])
  ));
  await rejects(datasetRequest([sourceMaterial()], [sourceBrand()]), {
    minDatasetEntries: 2,
  });
  await rejects(datasetRequest(
    Array.from({ length: 25001 }, () => null),
    [sourceBrand()],
  ));
});
