'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { onTestFinished, test } = require('bun:test');
const {
  createFilamentCatalog,
  normalizeCatalogQuery,
  normalizeSuggestion,
} = require('../filament-catalog.js');

const API_HOST = 'database.openprinttag.org';
const MATERIALS_PATH = '/api/materials.json';
const BRANDS_PATH = '/api/brands/basic.json';
const SOURCE_URL = 'https://database.openprinttag.org/api/materials.json';
const USER_AGENT = 'LayerRelay/0.1 filament-catalog (+https://github.com/GoByeBye/LayerRelay)';
const SILENT_LOGGER = { warn() {} };

function tempDataFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-filaments-'));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'filament-catalog.json');
}

function sourceBrand(overrides = {}) {
  return {
    uuid: '11111111-1111-5111-8111-111111111111',
    slug: 'acme',
    name: 'Acme',
    material_count: 1,
    ...overrides,
  };
}

function sourceMaterial(overrides = {}) {
  return {
    uuid: '22222222-2222-5222-8222-222222222222',
    slug: 'acme-pla-black',
    brand: { slug: 'acme' },
    brandId: 'acme',
    name: 'PLA Black',
    class: 'FFF',
    type: 'PLA',
    abbreviation: 'PLA',
    primary_color: { color_rgba: '#112233ff' },
    properties: {},
    ...overrides,
  };
}

function jsonResponse(value, status = 200, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  };
}

function datasetRequest(materials, brands, calls = []) {
  return async (...args) => {
    calls.push(args);
    const requestPath = args[1]?.path;
    if (requestPath === MATERIALS_PATH) return jsonResponse(materials);
    if (requestPath === BRANDS_PATH) return jsonResponse(brands);
    throw new Error('unexpected OpenPrintTag path: ' + requestPath);
  };
}

function catalogOptions(request, options = {}) {
  return {
    request,
    dataFile: tempDataFile(),
    logger: SILENT_LOGGER,
    minDatasetEntries: 1,
    ...options,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('normalizes catalog queries without allowing short or oversized input', () => {
  assert.equal(normalizeCatalogQuery(' \tPrusa\n   PLA\0 '), 'Prusa PLA');
  assert.equal(normalizeCatalogQuery('<Prusa>'), 'Prusa');
  assert.equal(normalizeCatalogQuery('x'), null);
  assert.equal(normalizeCatalogQuery('🧵'), null);
  assert.equal(normalizeCatalogQuery(' '.repeat(100)), null);
  assert.equal(normalizeCatalogQuery('x'.repeat(80)), 'x'.repeat(80));
  assert.equal(normalizeCatalogQuery('x'.repeat(81)), null);
  assert.equal(normalizeCatalogQuery(null), null);
});

test('does not download a dataset for short or rejected queries', async () => {
  let calls = 0;
  const catalog = createFilamentCatalog(catalogOptions(async () => {
    calls += 1;
    return jsonResponse([]);
  }));

  assert.deepEqual(await catalog.search('x'), {
    suggestions: [], stale: false, unavailable: false,
  });
  assert.deepEqual(await catalog.search('x'.repeat(81)), {
    suggestions: [], stale: false, unavailable: false,
  });
  assert.equal(calls, 0);
});

test('normalizes FFF materials to bounded safe DTOs and trusted JSON URLs', () => {
  const suggestion = normalizeSuggestion(sourceMaterial({
    slug: 'prusament-pla-prusa-orange',
    brand: { slug: 'prusament' },
    brandId: 'prusament',
    name: ' PLA Prusa\n Orange ',
    primary_color: { color_rgba: '#aBc123FF' },
  }), '<Prusament>\0');

  assert.deepEqual(suggestion, {
    id: 'prusament/prusament-pla-prusa-orange',
    label: 'Prusament PLA — Prusa Orange',
    manufacturer: 'Prusament',
    material: 'PLA',
    colorName: 'Prusa Orange',
    color: '#ABC123',
    url: 'https://database.openprinttag.org/api/brands/prusament/materials/prusament-pla-prusa-orange.json',
  });

  const embeddedType = normalizeSuggestion(sourceMaterial({
    slug: 'acme-dual-silk',
    name: 'Dual-Color Silk PLA, Blue Orange',
  }), 'Acme');
  assert.equal(embeddedType.label, 'Acme — Dual-Color Silk PLA, Blue Orange');
  assert.equal(embeddedType.colorName, 'Dual-Color Silk PLA, Blue Orange');

  assert.equal(normalizeSuggestion(sourceMaterial({
    primary_color: { color_rgba: '#123456' },
  }), 'Acme').color, '#123456');
  assert.equal(normalizeSuggestion(sourceMaterial({
    primary_color: { color_rgba: '#12345600' },
  }), 'Acme').color, null);
  assert.equal(normalizeSuggestion(sourceMaterial({
    primary_color: null,
    secondary_colors: [{ color_rgba: '#123456ff' }, { color_rgba: '#abcdefFF' }],
  }), 'Acme').color, null);
  assert.equal(normalizeSuggestion(sourceMaterial({
    primary_color: { color_rgba: 'not-a-color' },
  }), 'Acme').color, null);

  const bounded = normalizeSuggestion(sourceMaterial({
    name: 'PLA ' + '🧵'.repeat(100),
  }), 'M'.repeat(120));
  assert.equal(Array.from(bounded.manufacturer).length, 80);
  assert.ok(bounded.label.length <= 80);
  assert.equal(/[\uD800-\uDBFF]$/.test(bounded.label), false);

  assert.equal(normalizeSuggestion(sourceMaterial({ class: 'SLA' }), 'Acme'), null);
  assert.equal(normalizeSuggestion(sourceMaterial({ type: null }), 'Acme'), null);
  assert.equal(normalizeSuggestion(sourceMaterial({ brand: { slug: '../escape' } }), 'Acme'), null);
  assert.equal(normalizeSuggestion(sourceMaterial({ slug: 'bad/slash' }), 'Acme'), null);
  assert.equal(normalizeSuggestion(sourceMaterial(), null), null);
});

test('revalidates persisted suggestions and derives identity only from trusted JSON URLs', () => {
  const source = normalizeSuggestion(sourceMaterial(), 'Acme');
  const restored = normalizeSuggestion({
    ...source,
    id: 'tampered',
    label: '<tampered>',
  });

  assert.equal(restored.id, 'acme/acme-pla-black');
  assert.equal(restored.label, 'Acme PLA — Black');
  assert.equal(restored.url,
    'https://database.openprinttag.org/api/brands/acme/materials/acme-pla-black.json');
  assert.equal(normalizeSuggestion({ ...source, url: 'https://evil.example/material.json' }), null);
  assert.equal(normalizeSuggestion({
    ...source,
    url: 'http://database.openprinttag.org/api/brands/acme/materials/acme-pla-black.json',
  }), null);
  assert.equal(normalizeSuggestion({ ...source, url: source.url + '?secret=1' }), null);
  assert.equal(normalizeSuggestion({
    ...source,
    url: 'https://database.openprinttag.org/brands/acme/materials/acme-pla-black',
  }), null);
});

test('downloads the two fixed OpenPrintTag endpoints and keeps picker queries local', async () => {
  const calls = [];
  const materials = [
    sourceMaterial(),
    sourceMaterial({
      uuid: '33333333-3333-5333-8333-333333333333',
      slug: 'black-industries-petg-basic',
      brand: { slug: 'black-industries' },
      brandId: 'black-industries',
      name: 'PETG Basic Black',
      type: 'PETG',
      abbreviation: 'PETG',
      primary_color: { color_rgba: '#222222ff' },
    }),
    sourceMaterial({
      uuid: '44444444-4444-5444-8444-444444444444',
      slug: 'acme-pla-blackberry',
      name: 'PLA Blackberry',
      primary_color: { color_rgba: '#333333ff' },
    }),
  ];
  const brands = [
    sourceBrand(),
    sourceBrand({
      uuid: '55555555-5555-5555-8555-555555555555',
      slug: 'black-industries',
      name: 'Black Industries',
    }),
  ];
  const catalog = createFilamentCatalog(catalogOptions(
    datasetRequest(materials, brands, calls),
    { timeoutMs: 4321 },
  ));

  const pla = await catalog.search('  black   &   PLA  ');
  const petg = await catalog.search('black PETG');
  const missing = await catalog.search('orange PLA');

  assert.deepEqual(pla.suggestions.map((item) => item.id), [
    'acme/acme-pla-black',
    'acme/acme-pla-blackberry',
  ]);
  assert.deepEqual(petg.suggestions.map((item) => item.id), [
    'black-industries/black-industries-petg-basic',
  ]);
  assert.deepEqual(missing.suggestions, []);
  assert.equal(pla.stale, false);
  assert.equal(pla.unavailable, false);
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
  const serializedCalls = JSON.stringify(calls);
  assert.equal(serializedCalls.includes('black & PLA'), false);
  assert.equal(serializedCalls.includes('black PETG'), false);
  assert.equal(serializedCalls.includes('orange PLA'), false);
});

test('strictly filters class, type, brand and malformed material identity', async () => {
  const materials = [
    sourceMaterial(),
    sourceMaterial({
      uuid: '33333333-3333-5333-8333-333333333333',
      slug: 'acme-pla-white',
      name: 'PLA White',
      primary_color: { color_rgba: '#ABCDEF' },
    }),
    sourceMaterial({
      uuid: '44444444-4444-5444-8444-444444444444',
      slug: 'acme-pla-no-color',
      name: 'PLA No Color',
      primary_color: null,
    }),
    sourceMaterial({
      uuid: '55555555-5555-5555-8555-555555555555',
      slug: 'acme-pla-dual',
      name: 'PLA Dual',
      primary_color: null,
      secondary_colors: [{ color_rgba: '#ff0000ff' }, { color_rgba: '#0000ffff' }],
    }),
    sourceMaterial({
      uuid: '66666666-6666-5666-8666-666666666666',
      slug: 'acme-pla-transparent',
      name: 'PLA Transparent',
      primary_color: { color_rgba: '#00000000' },
    }),
    sourceMaterial({
      uuid: '77777777-7777-5777-8777-777777777777',
      slug: 'acme-resin-black',
      name: 'Resin Black',
      class: 'SLA',
      type: 'PLA',
    }),
    sourceMaterial({
      uuid: '88888888-8888-5888-8888-888888888888',
      slug: 'acme-untyped-black',
      name: 'Mystery Black',
      type: null,
      abbreviation: 'PLA',
    }),
    sourceMaterial({
      uuid: '99999999-9999-5999-8999-999999999999',
      slug: 'unknown-pla-black',
      brand: { slug: 'unknown' },
      brandId: 'unknown',
    }),
    sourceMaterial({ slug: '../escape' }),
    sourceMaterial({
      uuid: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
      slug: 'acme-pla-black',
      name: 'PLA Duplicate Must Lose',
      primary_color: { color_rgba: '#ffffffFF' },
    }),
  ];
  const catalog = createFilamentCatalog(catalogOptions(
    datasetRequest(materials, [sourceBrand()]),
  ));

  const result = await catalog.search('Acme PLA');
  const byId = new Map(result.suggestions.map((item) => [item.id, item]));

  assert.equal(result.suggestions.length, 5);
  assert.equal(byId.get('acme/acme-pla-black').color, '#112233');
  assert.equal(byId.get('acme/acme-pla-white').color, '#ABCDEF');
  assert.equal(byId.get('acme/acme-pla-no-color').color, null);
  assert.equal(byId.get('acme/acme-pla-dual').color, null);
  assert.equal(byId.get('acme/acme-pla-transparent').color, null);
  assert.equal([...byId.keys()].some((id) => id.includes('resin') || id.includes('untyped')), false);
});

test('rejects a material whose embedded brand slug conflicts with brandId', async () => {
  const materials = [
    sourceMaterial(),
    sourceMaterial({
      uuid: '33333333-3333-5333-8333-333333333333',
      slug: 'acme-conflicting-brand',
      brand: { slug: 'acme' },
      brandId: 'different-brand',
      name: 'PLA Conflicting Brand',
    }),
  ];
  const brands = [
    sourceBrand(),
    sourceBrand({ slug: 'different-brand', name: 'Different Brand' }),
  ];
  const catalog = createFilamentCatalog(catalogOptions(datasetRequest(materials, brands)));

  const result = await catalog.search('conflicting');
  assert.deepEqual(result.suggestions, []);
});

test('requires every local query token and returns at most twelve suggestions', async () => {
  const matches = Array.from({ length: 20 }, (_, index) => sourceMaterial({
    uuid: 'bbbbbbbb-bbbb-5bbb-8bbb-' + String(index).padStart(12, '0'),
    slug: 'acme-pla-orange-' + index,
    name: 'PLA Orange ' + String(index).padStart(2, '0'),
    primary_color: { color_rgba: index === 0 ? '#ff660000' : '#ff6600ff' },
  }));
  const materials = [
    ...matches,
    sourceMaterial({
      uuid: 'cccccccc-cccc-5ccc-8ccc-cccccccccccc',
      slug: 'acme-petg-orange',
      name: 'PETG Orange',
      type: 'PETG',
    }),
    sourceMaterial({
      uuid: 'dddddddd-dddd-5ddd-8ddd-dddddddddddd',
      slug: 'acme-pla-blue',
      name: 'PLA Blue',
    }),
  ];
  const catalog = createFilamentCatalog(catalogOptions(
    datasetRequest(materials, [sourceBrand()]),
  ));

  const result = await catalog.search('orange PLA');

  assert.equal(result.suggestions.length, 12);
  assert.ok(result.suggestions.every((item) => item.id.startsWith('acme/acme-pla-orange-')));
  assert.equal(result.suggestions.find((item) => item.id.endsWith('-0'))?.color, null);
  assert.deepEqual((await catalog.search('purple PLA')).suggestions, []);
});

test('persists only normalized fields and never picker queries or rich upstream data', async () => {
  const dataFile = tempDataFile();
  const calls = [];
  const material = sourceMaterial({
    photos: [{ url: 'https://files.openprinttag.org/private-looking-photo.png' }],
    properties: { secretish_vendor_note: 'not cached' },
    packages: [{ gtin: '123' }],
    tags: ['silk'],
  });
  const brand = sourceBrand({
    countries_of_origin: ['NO'],
    privateish_metadata: 'not cached either',
  });
  const catalog = createFilamentCatalog(catalogOptions(
    datasetRequest([material], [brand], calls),
    { dataFile, now: () => 100 },
  ));

  await catalog.search('private picker query');
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(persisted.version, 2);
  assert.equal(persisted.source, SOURCE_URL);
  assert.equal(persisted.checkedAt, 100);
  assert.deepEqual(Object.keys(persisted.suggestions[0]), [
    'id', 'label', 'manufacturer', 'material', 'colorName', 'color', 'url',
  ]);
  const serialized = JSON.stringify(persisted);
  assert.equal(serialized.includes('private picker query'), false);
  assert.equal(serialized.includes('private-looking-photo'), false);
  assert.equal(serialized.includes('secretish_vendor_note'), false);
  assert.equal(serialized.includes('gtin'), false);
  assert.equal(serialized.includes('countries_of_origin'), false);
  assert.equal(serialized.includes('privateish_metadata'), false);
  assert.equal(calls.length, 2);
});

test('restores a fresh normalized snapshot without network access', async () => {
  const dataFile = tempDataFile();
  const calls = [];
  const request = datasetRequest([sourceMaterial()], [sourceBrand()], calls);
  const options = {
    request,
    dataFile,
    logger: SILENT_LOGGER,
    minDatasetEntries: 1,
    now: () => 100,
    cacheTtlMs: 1000,
  };

  await createFilamentCatalog(options).search('Acme');
  const restored = createFilamentCatalog(options);
  const result = await restored.search('black PLA');

  assert.equal(calls.length, 2);
  assert.equal(result.suggestions[0].id, 'acme/acme-pla-black');
  assert.equal(result.stale, false);
  assert.equal(result.unavailable, false);
});

test('falls back to a semantically valid backup snapshot', async () => {
  const dataFile = tempDataFile();
  const calls = [];
  const request = datasetRequest([sourceMaterial()], [sourceBrand()], calls);
  const options = {
    request,
    dataFile,
    logger: SILENT_LOGGER,
    minDatasetEntries: 1,
    now: () => 100,
    cacheTtlMs: 1000,
  };

  await createFilamentCatalog(options).search('Acme');
  assert.equal(fs.existsSync(dataFile + '.bak'), true);
  fs.writeFileSync(dataFile, JSON.stringify({
    version: 2,
    source: SOURCE_URL,
    checkedAt: 100,
    suggestions: [{ url: 'https://evil.example/not-valid.json' }],
  }));

  const restored = createFilamentCatalog(options);
  const result = await restored.search('Black');

  assert.equal(calls.length, 2);
  assert.equal(result.suggestions[0].id, 'acme/acme-pla-black');
  assert.equal(result.stale, false);
});

test('ignores and replaces the superseded version-one query cache', async () => {
  const dataFile = tempDataFile();
  fs.writeFileSync(dataFile, JSON.stringify({
    version: 1,
    queries: [{ query: 'old secret', suggestions: [] }],
  }));
  const calls = [];
  const catalog = createFilamentCatalog(catalogOptions(
    datasetRequest([sourceMaterial()], [sourceBrand()], calls),
    { dataFile },
  ));

  const result = await catalog.search('Acme');
  const saved = fs.readFileSync(dataFile, 'utf8');

  assert.equal(calls.length, 2);
  assert.equal(result.suggestions.length, 1);
  assert.equal(saved.includes('old secret'), false);
  assert.equal(JSON.parse(saved).version, 2);
});

test('deduplicates one shared two-endpoint refresh across independent searches', async () => {
  const materialsGate = deferred();
  const brandsGate = deferred();
  const calls = [];
  const catalog = createFilamentCatalog(catalogOptions((...args) => {
    calls.push(args);
    if (args[1].path === MATERIALS_PATH) return materialsGate.promise;
    if (args[1].path === BRANDS_PATH) return brandsGate.promise;
    throw new Error('unexpected path');
  }));

  const black = catalog.search('Black');
  const orange = catalog.search('Orange');
  await flushAsyncWork();
  assert.equal(calls.length, 2);

  materialsGate.resolve(jsonResponse([
    sourceMaterial(),
    sourceMaterial({
      uuid: '33333333-3333-5333-8333-333333333333',
      slug: 'acme-pla-orange',
      name: 'PLA Orange',
      primary_color: { color_rgba: '#ff6600ff' },
    }),
  ]));
  brandsGate.resolve(jsonResponse([sourceBrand()]));

  assert.equal((await black).suggestions[0].colorName, 'Black');
  assert.equal((await orange).suggestions[0].colorName, 'Orange');
  assert.equal(calls.length, 2);
});

test('an aborted caller detaches without cancelling the shared dataset refresh', async () => {
  const materialsGate = deferred();
  const brandsGate = deferred();
  const calls = [];
  const catalog = createFilamentCatalog(catalogOptions((...args) => {
    calls.push(args);
    return args[1].path === MATERIALS_PATH ? materialsGate.promise : brandsGate.promise;
  }));
  const controller = new AbortController();
  const pending = catalog.search('Acme', { signal: controller.signal });
  await flushAsyncWork();
  assert.equal(calls.length, 2);

  controller.abort(new Error('private abort reason'));
  await assert.rejects(pending, (error) => error?.name === 'AbortError');

  materialsGate.resolve(jsonResponse([sourceMaterial()]));
  brandsGate.resolve(jsonResponse([sourceBrand()]));
  assert.equal(await catalog.warm(), true);
  const retried = await catalog.search('Acme');

  assert.equal(calls.length, 2);
  assert.equal(retried.suggestions.length, 1);
});

test('rejects a pre-aborted caller without starting a refresh', async () => {
  let calls = 0;
  const catalog = createFilamentCatalog(catalogOptions(async () => {
    calls += 1;
    return jsonResponse([]);
  }));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    catalog.search('Acme', { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(calls, 0);
});

test('serves stale results immediately while warm joins the background refresh', async () => {
  let now = 0;
  let calls = 0;
  const materialsGate = deferred();
  const brandsGate = deferred();
  const catalog = createFilamentCatalog(catalogOptions((host, requestOptions) => {
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

  await catalog.search('Black');
  now = 1000;
  const stale = await catalog.search('Black');
  await flushAsyncWork();

  assert.equal(stale.suggestions.length, 1);
  assert.equal(stale.stale, true);
  assert.equal(stale.unavailable, false);
  assert.equal(calls, 4);

  const warming = catalog.warm();
  materialsGate.resolve(jsonResponse([sourceMaterial({
    uuid: '33333333-3333-5333-8333-333333333333',
    slug: 'acme-pla-orange',
    name: 'PLA Orange',
    primary_color: { color_rgba: '#ff6600ff' },
  })]));
  brandsGate.resolve(jsonResponse([sourceBrand()]));
  assert.equal(await warming, true);

  const fresh = await catalog.search('Orange');
  assert.equal(fresh.suggestions[0].colorName, 'Orange');
  assert.equal(fresh.stale, false);
  assert.equal(fresh.unavailable, false);
  assert.equal(calls, 4);
});

test('preserves last-good data and observes retry cooldown after refresh failure', async () => {
  const dataFile = tempDataFile();
  const warnings = [];
  let now = 0;
  let calls = 0;
  let failing = false;
  let nextMaterial = sourceMaterial();
  const request = async (host, requestOptions) => {
    calls += 1;
    if (failing) throw new Error('private query C:\\private\\catalog.json');
    return requestOptions.path === MATERIALS_PATH
      ? jsonResponse([nextMaterial])
      : jsonResponse([sourceBrand()]);
  };
  const catalog = createFilamentCatalog({
    request,
    dataFile,
    logger: { warn(...args) { warnings.push(args); } },
    minDatasetEntries: 1,
    now: () => now,
    cacheTtlMs: 100,
    retryCooldownMs: 500,
  });

  await catalog.search('Black');
  const lastGood = fs.readFileSync(dataFile, 'utf8');
  now = 1000;
  failing = true;

  const firstStale = await catalog.search('Black');
  assert.equal(firstStale.stale, true);
  assert.equal(firstStale.unavailable, false);
  assert.equal(await catalog.warm(), false);

  const failedStale = await catalog.search('Black');
  assert.equal(failedStale.suggestions.length, 1);
  assert.equal(failedStale.stale, true);
  assert.equal(failedStale.unavailable, true);
  assert.equal(await catalog.warm(), false);
  assert.equal(calls, 4);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), lastGood);
  assert.deepEqual(warnings, [['filament_catalog_refresh_failed']]);
  assert.equal(JSON.stringify(warnings).includes('private'), false);

  now = 2000;
  failing = false;
  nextMaterial = sourceMaterial({
    uuid: '33333333-3333-5333-8333-333333333333',
    slug: 'acme-pla-orange',
    name: 'PLA Orange',
    primary_color: { color_rgba: '#ff6600ff' },
  });
  const stillStale = await catalog.search('Black');
  assert.equal(stillStale.stale, true);
  assert.equal(await catalog.warm(), true);
  const refreshed = await catalog.search('Orange');

  assert.equal(refreshed.suggestions[0].colorName, 'Orange');
  assert.equal(refreshed.stale, false);
  assert.equal(calls, 6);
  assert.notEqual(fs.readFileSync(dataFile, 'utf8'), lastGood);
});

test('rejects malformed, undersized and oversized generated datasets', async () => {
  async function rejectedResult(request, options = {}) {
    const dataFile = tempDataFile();
    const catalog = createFilamentCatalog(catalogOptions(request, { dataFile, ...options }));
    const result = await catalog.search('Orange');
    assert.equal(fs.existsSync(dataFile), false);
    return result;
  }

  const malformed = await rejectedResult(async (host, requestOptions) => (
    requestOptions.path === MATERIALS_PATH
      ? jsonResponse({ results: [sourceMaterial()] })
      : jsonResponse([sourceBrand()])
  ));
  assert.deepEqual(malformed, { suggestions: [], stale: false, unavailable: true });

  const undersized = await rejectedResult(
    datasetRequest([sourceMaterial()], [sourceBrand()]),
    { minDatasetEntries: 2 },
  );
  assert.deepEqual(undersized, { suggestions: [], stale: false, unavailable: true });

  const tooManyMaterials = Array.from({ length: 25001 }, () => null);
  const oversized = await rejectedResult(
    datasetRequest(tooManyMaterials, [sourceBrand()]),
  );
  assert.deepEqual(oversized, { suggestions: [], stale: false, unavailable: true });

  const invalidBrandIndex = await rejectedResult(
    datasetRequest([sourceMaterial()], [{ slug: '../bad', name: null }]),
  );
  assert.deepEqual(invalidBrandIndex, { suggestions: [], stale: false, unavailable: true });
});
