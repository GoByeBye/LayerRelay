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

const SILENT_LOGGER = { warn() {} };

function tempDataFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-filaments-'));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'filament-catalog.json');
}

function upstreamSuggestion(overrides = {}) {
  return {
    id: 1,
    slug: 'acme-black-pla-1',
    manufacturer: { name: 'Acme' },
    filament_type: { name: 'PLA', parent_type: { name: 'PLA' } },
    color_name: 'Black',
    hex_color: '112233',
    ...overrides,
  };
}

function jsonResponse(results, status = 200) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results }) };
}

function catalogOptions(request, options = {}) {
  return {
    request,
    dataFile: tempDataFile(),
    logger: SILENT_LOGGER,
    sleep: async () => {},
    ...options,
  };
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

test('does not consult the network for short or rejected queries', async () => {
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

test('normalizes suggestions to bounded safe DTOs and derives only trusted URLs', () => {
  const suggestion = normalizeSuggestion(upstreamSuggestion({
    id: 42,
    slug: 'prusa-research-galaxy-black-pla-42',
    manufacturer: { name: '<Prusa>\0 Research' },
    filament_type: { name: ' PLA ' },
    color_name: 'Galaxy\n Black',
    hex_color: '#aBc123',
  }));

  assert.deepEqual(suggestion, {
    id: 42,
    label: 'Prusa Research PLA — Galaxy Black',
    manufacturer: 'Prusa Research',
    material: 'PLA',
    colorName: 'Galaxy Black',
    color: '#ABC123',
    url: 'https://filamentcolors.xyz/swatch/prusa-research-galaxy-black-pla-42/',
  });

  const bounded = normalizeSuggestion(upstreamSuggestion({
    manufacturer: { name: 'M'.repeat(120) },
    color_name: 'C'.repeat(120),
  }));
  assert.equal(Array.from(bounded.manufacturer).length, 80);
  assert.equal(Array.from(bounded.colorName).length, 80);
  assert.ok(bounded.label.length <= 80);

  const branded = normalizeSuggestion(upstreamSuggestion({
    slug: 'polymaker-aurora-panchroma-starlight-1',
    manufacturer: { name: 'Polymaker' },
    filament_type: { name: 'Panchroma Starlight', parent_type: { name: 'PLA' } },
    color_name: 'Aurora',
  }));
  assert.equal(branded.material, 'Panchroma Starlight (PLA)');
  assert.equal(branded.label, 'Polymaker Panchroma Starlight (PLA) — Aurora');

  const duplicateFamily = normalizeSuggestion(upstreamSuggestion({
    filament_type: { name: 'PLA+', parent_type: { name: 'PLA' } },
  }));
  assert.equal(duplicateFamily.material, 'PLA+');

  const astral = normalizeSuggestion(upstreamSuggestion({
    manufacturer: { name: `Maker ${'🧵'.repeat(60)}` },
  }));
  assert.ok(astral.label.length <= 80);
  assert.equal(/[\uD800-\uDBFF]$/.test(astral.label), false);

  assert.equal(normalizeSuggestion(upstreamSuggestion({ id: '1' })), null);
  assert.equal(normalizeSuggestion(upstreamSuggestion({ hex_color: 'not-a-color' })), null);
  assert.equal(normalizeSuggestion(upstreamSuggestion({ slug: '../escape' })), null);
  assert.equal(normalizeSuggestion({ ...suggestion, url: 'https://evil.example/swatch/good-slug/' }), null);
});

test('encodes the fixed upstream request and ranks exact token matches first', async () => {
  const calls = [];
  const request = async (...args) => {
    calls.push(args);
    return jsonResponse([
      upstreamSuggestion({
        id: 2,
        slug: 'black-industries-basic-petg-2',
        manufacturer: { name: 'Black Industries' },
        filament_type: { name: 'PETG' },
        color_name: 'Basic',
        hex_color: '222222',
      }),
      upstreamSuggestion({
        id: 3,
        slug: 'acme-blackberry-pla-3',
        color_name: 'Blackberry',
        hex_color: '333333',
      }),
      upstreamSuggestion(),
    ]);
  };
  const catalog = createFilamentCatalog(catalogOptions(request, { timeoutMs: 4321 }));

  const result = await catalog.search('  black   &   PLA  ');

  assert.deepEqual(result.suggestions.map((item) => item.id), [1, 3, 2]);
  assert.equal(result.stale, false);
  assert.equal(result.unavailable, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'filamentcolors.xyz');
  const { signal, ...requestOptions } = calls[0][1];
  assert.deepEqual(requestOptions, {
    method: 'GET',
    path: '/api/swatch/?q=black%20%26%20PLA&page_size=25',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'LayerRelay/0.1 filament-catalog (+https://github.com/GoByeBye/LayerRelay)',
    },
  });
  assert.equal(signal instanceof AbortSignal, true);
  assert.equal(calls[0][2], null);
  assert.equal(calls[0][3], 4321);
});

test('persists only normalized DTOs and restores a fresh cache without a request', async () => {
  const dataFile = tempDataFile();
  let calls = 0;
  const request = async () => {
    calls += 1;
    return jsonResponse([upstreamSuggestion({
      notes: '<b>large upstream field</b>',
      card_img: 'https://filamentcolors.xyz/media/not-cached.jpg',
    })]);
  };
  const options = {
    request,
    dataFile,
    logger: SILENT_LOGGER,
    now: () => 100,
    sleep: async () => {},
    cacheTtlMs: 1000,
  };

  const first = createFilamentCatalog(options);
  await first.search('Acme');
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(persisted.version, 1);
  assert.equal(persisted.queries.length, 1);
  assert.deepEqual(Object.keys(persisted.queries[0].suggestions[0]), [
    'id', 'label', 'manufacturer', 'material', 'colorName', 'color', 'url',
  ]);
  assert.equal(JSON.stringify(persisted).includes('card_img'), false);
  assert.equal(JSON.stringify(persisted).includes('notes'), false);

  const restored = createFilamentCatalog(options);
  const result = await restored.search(' acme ');
  assert.equal(calls, 1);
  assert.equal(result.suggestions[0].id, 1);
  assert.equal(result.stale, false);
});

test('bounds the persistent cache by newest query entries', async () => {
  const dataFile = tempDataFile();
  let now = 0;
  let id = 0;
  const request = async () => {
    id += 1;
    return jsonResponse([upstreamSuggestion({ id, slug: `acme-color-pla-${id}` })]);
  };
  const catalog = createFilamentCatalog({
    request,
    dataFile,
    logger: SILENT_LOGGER,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    maxQueries: 2,
  });

  await catalog.search('first');
  now += 1;
  await catalog.search('second');
  now += 1;
  await catalog.search('third');

  const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.deepEqual(saved.queries.map((entry) => entry.query), ['third', 'second']);
});

test('deduplicates the same normalized in-flight query', async () => {
  let calls = 0;
  let release;
  const request = () => {
    calls += 1;
    return new Promise((resolve) => { release = () => resolve(jsonResponse([upstreamSuggestion()])); });
  };
  const catalog = createFilamentCatalog(catalogOptions(request));

  const first = catalog.search(' Prusa ');
  const second = catalog.search('prusa');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);

  release();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.equal(calls, 1);
});

test('normalizes cache keys without collapsing query punctuation', async () => {
  let calls = 0;
  const catalog = createFilamentCatalog(catalogOptions(async () => {
    calls += 1;
    return jsonResponse([upstreamSuggestion({
      id: calls,
      slug: `punctuation-cache-pla-${calls}`,
    })]);
  }));

  const plain = await catalog.search(' PLA ');
  const plainAgain = await catalog.search('pla');
  const plus = await catalog.search('PLA+');
  const plusAgain = await catalog.search('  pla+  ');

  assert.equal(calls, 2);
  assert.equal(plain.suggestions[0].id, 1);
  assert.equal(plainAgain.suggestions[0].id, 1);
  assert.equal(plus.suggestions[0].id, 2);
  assert.equal(plusAgain.suggestions[0].id, 2);
});

test('does not deduplicate distinct in-flight queries that differ by punctuation', async () => {
  const releases = [];
  let calls = 0;
  const catalog = createFilamentCatalog(catalogOptions(() => {
    calls += 1;
    const id = calls;
    return new Promise((resolve) => {
      releases.push(() => resolve(jsonResponse([upstreamSuggestion({
        id,
        slug: `punctuation-flight-pla-${id}`,
      })])));
    });
  }));

  const plain = catalog.search('PLA');
  const plus = catalog.search('PLA+');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);

  releases.shift()();
  const plainResult = await plain;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  releases.shift()();
  const plusResult = await plus;

  assert.equal(plainResult.suggestions[0].id, 1);
  assert.equal(plusResult.suggestions[0].id, 2);
});

test('skips queued work when its only consumer aborts', async () => {
  const calls = [];
  const warnings = [];
  let releaseActive;
  const catalog = createFilamentCatalog({
    request: async (host, requestOptions) => {
      calls.push(requestOptions.path);
      return new Promise((resolve) => {
        releaseActive = () => resolve(jsonResponse([upstreamSuggestion()]));
      });
    },
    dataFile: tempDataFile(),
    logger: { warn: (...values) => warnings.push(values) },
    sleep: async () => {},
  });
  const active = catalog.search('active request');
  const controller = new AbortController();
  const queued = catalog.search('queued secret query', { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);

  controller.abort(new Error('queued secret query C:\\private\\catalog.json'));
  await assert.rejects(queued, (error) => error?.name === 'AbortError');
  releaseActive();
  await active;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1);
  assert.deepEqual(warnings, []);
});

test('aborts active upstream work when its only consumer cancels', async () => {
  const warnings = [];
  let calls = 0;
  let upstreamSignal;
  let observedTimeout;
  const catalog = createFilamentCatalog({
    request: async (host, requestOptions, body, timeoutMs) => {
      calls += 1;
      observedTimeout = timeoutMs;
      if (calls > 1) {
        return jsonResponse([upstreamSuggestion({ id: 2, slug: 'retried-active-pla-2' })]);
      }
      upstreamSignal = requestOptions.signal;
      return new Promise((resolve, reject) => {
        upstreamSignal.addEventListener('abort', () => {
          const error = new Error('transport aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    dataFile: tempDataFile(),
    logger: { warn: (...values) => warnings.push(values) },
    sleep: async () => {},
  });
  const controller = new AbortController();
  const pending = catalog.search('active secret query', { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls, 1);
  assert.notEqual(upstreamSignal, controller.signal);
  assert.equal(upstreamSignal.aborted, false);
  assert.equal(observedTimeout, 12000);
  controller.abort(new Error('active secret query C:\\private\\catalog.json'));
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(upstreamSignal.aborted, true);
  assert.deepEqual(warnings, []);
  const retried = await catalog.search('active secret query');
  assert.equal(retried.suggestions[0].id, 2);
  assert.equal(calls, 2);
});

test('keeps shared work alive when only one duplicate consumer aborts', async () => {
  const warnings = [];
  let calls = 0;
  let release;
  let upstreamSignal;
  const catalog = createFilamentCatalog({
    request: async (host, requestOptions) => {
      calls += 1;
      upstreamSignal = requestOptions.signal;
      return new Promise((resolve) => {
        release = () => resolve(jsonResponse([upstreamSuggestion()]));
      });
    },
    dataFile: tempDataFile(),
    logger: { warn: (...values) => warnings.push(values) },
    sleep: async () => {},
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = catalog.search(' Shared   PLA ', { signal: firstController.signal });
  const second = catalog.search('shared pla', { signal: secondController.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls, 1);
  assert.notEqual(upstreamSignal, firstController.signal);
  assert.notEqual(upstreamSignal, secondController.signal);
  firstController.abort();
  await assert.rejects(first, (error) => error?.name === 'AbortError');
  assert.equal(upstreamSignal.aborted, false);

  release();
  const result = await second;
  assert.equal(result.suggestions[0].id, 1);
  assert.equal(calls, 1);
  assert.deepEqual(warnings, []);
});

test('rejects a pre-aborted consumer without occupying the request queue', async () => {
  let calls = 0;
  const catalog = createFilamentCatalog(catalogOptions(async () => {
    calls += 1;
    return jsonResponse([]);
  }));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    catalog.search('pre-aborted query', { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(calls, 0);
});

test('uses 1100ms request-start headroom by default', async () => {
  let now = 0;
  let nextId = 0;
  const starts = [];
  const sleeps = [];
  const request = async () => {
    starts.push(now);
    nextId += 1;
    return jsonResponse([upstreamSuggestion({ id: nextId, slug: `default-rate-pla-${nextId}` })]);
  };
  const catalog = createFilamentCatalog(catalogOptions(request, {
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
  }));

  await Promise.all([catalog.search('black'), catalog.search('white')]);

  assert.deepEqual(starts, [0, 1100]);
  assert.deepEqual(sleeps, [1100]);
});

test('clamps a configured request interval to no less than 1100ms', async () => {
  let now = 0;
  let nextId = 0;
  const starts = [];
  const sleeps = [];
  const request = async () => {
    starts.push(now);
    nextId += 1;
    return jsonResponse([upstreamSuggestion({ id: nextId, slug: `acme-black-pla-${nextId}` })]);
  };
  const catalog = createFilamentCatalog(catalogOptions(request, {
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    minIntervalMs: 25,
  }));

  await Promise.all([catalog.search('black'), catalog.search('white')]);

  assert.deepEqual(starts, [0, 1100]);
  assert.deepEqual(sleeps, [1100]);
});

test('rejects the ninth distinct pending query without queuing or leaking it', async () => {
  let calls = 0;
  let releaseFirst;
  const warnings = [];
  const request = () => {
    calls += 1;
    if (calls === 1) {
      return new Promise((resolve) => {
        releaseFirst = () => resolve(jsonResponse([upstreamSuggestion()]));
      });
    }
    return Promise.resolve(jsonResponse([upstreamSuggestion({
      id: calls,
      slug: `queued-color-pla-${calls}`,
    })]));
  };
  const catalog = createFilamentCatalog({
    request,
    dataFile: tempDataFile(),
    logger: { warn: (...values) => warnings.push(values) },
    sleep: async () => {},
  });
  const pending = Array.from({ length: 8 }, (_, index) => catalog.search(`pending-${index}`));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);

  const rejected = await catalog.search('super-secret-ninth-query');

  assert.deepEqual(rejected, { suggestions: [], stale: false, unavailable: true });
  assert.equal(calls, 1);
  assert.deepEqual(warnings, [['filament_catalog_queue_full']]);
  assert.equal(JSON.stringify(warnings).includes('super-secret-ninth-query'), false);

  releaseFirst();
  await Promise.all(pending);
  assert.equal(calls, 8);
});

test('falls back to exact stale or locally filtered cache when upstream fails', async () => {
  let now = 0;
  let failing = false;
  const request = async () => {
    if (failing) throw new Error('offline');
    return jsonResponse([upstreamSuggestion({
      id: 8,
      slug: 'prusament-orange-pla-8',
      manufacturer: { name: 'Prusament' },
      color_name: 'Orange',
      hex_color: 'FF8800',
    })]);
  };
  const catalog = createFilamentCatalog(catalogOptions(request, {
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    cacheTtlMs: 10,
  }));

  await catalog.search('Prusa');
  now = 100;
  failing = true;

  const exact = await catalog.search('prusa');
  assert.equal(exact.suggestions[0].id, 8);
  assert.equal(exact.stale, true);
  assert.equal(exact.unavailable, true);

  const filtered = await catalog.search('orange');
  assert.equal(filtered.suggestions[0].id, 8);
  assert.equal(filtered.stale, true);
  assert.equal(filtered.unavailable, true);
});

test('returns an explicit non-blocking empty fallback for 429 or invalid schema', async () => {
  const rateLimited = createFilamentCatalog(catalogOptions(async () => ({
    status: 429,
    headers: { 'retry-after': '60' },
    body: '{"detail":"throttled"}',
  })));
  assert.deepEqual(await rateLimited.search('PLA'), {
    suggestions: [], stale: false, unavailable: true,
  });

  const invalidSchema = createFilamentCatalog(catalogOptions(async () => ({
    status: 200,
    body: '{"items":[]}',
  })));
  assert.deepEqual(await invalidSchema.search('PLA'), {
    suggestions: [], stale: false, unavailable: true,
  });
});

test('logs only stable event codes when an upstream error contains sensitive text', async () => {
  const warnings = [];
  const catalog = createFilamentCatalog({
    request: async () => { throw new Error('secret-query C:\\private\\catalog.json'); },
    dataFile: tempDataFile(),
    logger: { warn: (...values) => warnings.push(values) },
    sleep: async () => {},
  });

  await catalog.search('secret-query');

  assert.deepEqual(warnings, [['filament_catalog_upstream_unavailable']]);
});

test('drops malformed and excessive upstream values and returns at most twelve items', async () => {
  const valid = Array.from({ length: 20 }, (_, index) => upstreamSuggestion({
    id: index + 1,
    slug: `maker-color-pla-${index + 1}`,
    manufacturer: { name: index === 0 ? 'M'.repeat(120) : 'Maker' },
    color_name: index === 0 ? 'C'.repeat(120) : `Color ${index + 1}`,
    hex_color: index.toString(16).padStart(6, '0'),
  }));
  const malformed = [
    upstreamSuggestion({ id: '21', slug: 'bad-id' }),
    upstreamSuggestion({ id: 22, slug: '../bad-slug' }),
    upstreamSuggestion({ id: 23, hex_color: '12345' }),
    upstreamSuggestion({ id: 24, manufacturer: { name: 'X'.repeat(5000) } }),
    null,
  ];
  const catalog = createFilamentCatalog(catalogOptions(async () => jsonResponse([...malformed, ...valid])));

  const result = await catalog.search('C'.repeat(80));

  assert.equal(result.suggestions.length, 12);
  assert.equal(result.suggestions.every((item) => /^#[0-9A-F]{6}$/.test(item.color)), true);
  const bounded = result.suggestions.find((item) => item.id === 1);
  assert.equal(Array.from(bounded.manufacturer).length, 80);
  assert.equal(Array.from(bounded.colorName).length, 80);
});
