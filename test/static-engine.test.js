'use strict';
// Tests for the static build's virtual API engine (pages/app/state-engine.mjs)
// and its supporting modules: replay.mjs, tool-settings.mjs, openprinttag.mjs.
// tool-settings.mjs and openprinttag.mjs are standalone browser modules and are
// always tested. replay.mjs imports pages/app/toolswaps.mjs and the engine also
// imports pages/app/bgcode.mjs + qoi.mjs + print-name.mjs (built concurrently),
// so those tests are skipped while the browser decoder port is absent.
// No test opens a network connection: every fetch is an injected fake.

const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { test } = require('bun:test');
const rootToolswaps = require('../toolswaps.js');

const PAGES = path.join(__dirname, '..', 'pages', 'app');
const hasFile = (name) => existsSync(path.join(PAGES, name));
const hasToolswaps = hasFile('toolswaps.mjs');
const hasEngineDeps = ['toolswaps.mjs', 'bgcode.mjs', 'qoi.mjs', 'print-name.mjs']
  .every(hasFile);
const replayTest = hasToolswaps ? test : test.skip;
const engineTest = hasEngineDeps ? test : test.skip;

async function withWatchdog(promise, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('test watchdog expired')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function makeClock(startMs = 1700000000000) {
  let current = startMs;
  return {
    now: () => current,
    advanceSec: (sec) => { current += sec * 1000; },
  };
}

function memStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

// Deterministic five-layer, three-swap print: 120 minutes of M73 clock,
// tools T0 -> T1 -> T2 -> T0, purge waste in FLUSH/EXCLUDE_E blocks.
const DEMO_GCODE = [
  '; filament_type = PLA;PETG;ASA',
  '; filament_diameter = 1.75',
  '; filament_density = 1.24',
  '; total filament used [g] = 87.4',
  '; objects_info = {"objects":[{"name":"Voron cube x3"}]}',
  'M73 P0 R120',
  'T0',
  ';LAYER_CHANGE',
  ';Z:0.20',
  'M73 P10 R108',
  ';LAYER_CHANGE',
  ';Z:0.40',
  'M73P20R96',
  'T1',
  ';FLUSH_START',
  'G1 E25',
  ';FLUSH_END',
  ';LAYER_CHANGE',
  ';Z:0.60',
  'M73 P40 R72',
  'T2',
  ';EXCLUDE_E_START',
  'G1 X2 E5',
  ';EXCLUDE_E_END',
  ';LAYER_CHANGE',
  ';Z:0.80',
  'M73 P70 R36',
  'T0',
  ';LAYER_CHANGE',
  ';Z:1.00',
  'M73 P100 R0',
].join('\n');

const DEMO_DURATION_SEC = 120 * 60;

// Analysis built with the ROOT (Node) toolswaps module, so replay logic is
// testable even before the browser decoder port lands.
function rootAnalysis() {
  return rootToolswaps.analyzeBgcode(Buffer.from(DEMO_GCODE));
}

const demoBytes = () => new TextEncoder().encode(DEMO_GCODE);

// Every /api/state field the overlay reads (RECON a2fa2dfdf23c3b474).
const OVERLAY_STATE_FIELDS = [
  'state', 'activity', 'name', 'online', 'staleSec', 'updatedAt',
  'progress', 'timeRemainingSec', 'timeElapsedSec',
  'thumbnailUrl', 'thumbnailKey',
  'nozzleTemp', 'nozzleTarget', 'bedTemp', 'bedTarget',
  'chamberTemp', 'chamberTarget', 'roomTemp', 'roomHumidity', 'outdoorTemp',
  'material', 'analyzing', 'toolLabel', 'toolSlots', 'toolCount',
  'toolSettings', 'toolCountSource', 'swapping', 'nextToolLabel',
  'nextSwapInSec', 'speed', 'flow', 'currentLayer', 'totalLayers', 'axisZ',
  'fanHotend', 'swapsTotal', 'swapsDone', 'wasteTotal', 'wasteDone',
  'filamentG', 'completedJob', 'camera', 'nozzle', 'nozzlePipUrl',
  'timelapseUrl', 'timelapseIntervalSec',
];

function cannedOpenPrintTag() {
  const materials = [];
  for (let i = 0; i < 120; i++) {
    materials.push({
      class: 'FFF',
      slug: `pla-shade-${String(i).padStart(3, '0')}`,
      name: `PLA Shade ${i}`,
      type: 'PLA',
      brand: { slug: 'acme' },
      primary_color: { color_rgba: '#AABBCC' },
    });
  }
  materials.push({
    class: 'FFF',
    slug: 'petg-clear',
    name: 'PETG Clear',
    type: 'PETG',
    brandId: 'contoso',
    primary_color: { color_rgba: '#112233FF' },
  });
  const brands = [
    { slug: 'acme', name: 'Acme Filaments' },
    { slug: 'contoso', name: 'Contoso' },
  ];
  const fetchImpl = async (url) => {
    const body = String(url).includes('/api/materials.json') ? materials : brands;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { materials, brands, fetchImpl };
}

// ---------------------------------------------------------------------------
// tool-settings.mjs (standalone, always runs)
// ---------------------------------------------------------------------------

test('tool settings port validates input and normalizes slots', async () => {
  const mod = await import('../pages/app/tool-settings.mjs');

  const normalized = mod.normalizeToolSettings({
    toolCount: 4,
    toolSlots: { 2: { loaded: true, name: '  Galaxy   Black ', color: '#ff00aa' } },
  });
  assert.deepEqual(normalized, {
    toolCount: 4,
    toolSlots: { 2: { loaded: true, name: 'Galaxy Black', color: '#FF00AA' } },
  });

  assert.throws(() => mod.normalizeToolSettings(null), TypeError);
  assert.throws(() => mod.normalizeToolSettings({ toolCount: 0, toolSlots: {} }), TypeError);
  assert.throws(() => mod.normalizeToolSettings({ toolCount: null, toolSlots: { 0: {} } }), TypeError);
  assert.throws(
    () => mod.normalizeToolSettings({ toolCount: null, toolSlots: {}, extra: 1 }),
    TypeError,
  );
  assert.throws(
    () => mod.normalizeToolSettings({ toolCount: null, toolSlots: { 1: { color: 'red' } } }),
    TypeError,
  );

  const detected = mod.normalizeDetectedToolSettings({
    source: null,
    status: 'fresh',
    toolCount: 2,
    toolSlots: [
      { toolLabel: 1, loaded: true, material: 'PLA' },
      { toolLabel: 2, name: 'Sidekick' },
    ],
  });
  assert.equal(detected.source, null);
  assert.equal(detected.status, 'fresh');
  assert.equal(detected.toolCount, 2);
  assert.equal(detected.toolSlots[0].loaded, true);
  assert.equal(detected.toolSlots[0].material, 'PLA');
  assert.equal(detected.toolSlots[1].name, 'Sidekick');

  const resolved = mod.resolveToolSettings(
    { toolCount: null, toolSlots: { 1: { color: '#010203' } } },
    { source: null, status: 'fresh', toolCount: 2, toolSlots: [{ toolLabel: 1, loaded: true, material: 'PLA' }] },
    { minimumToolCount: 3 },
  );
  assert.equal(resolved.toolCount, 3);
  assert.equal(resolved.toolCountSource, 'connect');
  assert.equal(resolved.countAdjusted, true);
  assert.equal(resolved.toolSlots[0].color, '#010203');
  assert.deepEqual(resolved.toolSlots[0].sources, {
    loaded: 'connect', name: 'none', material: 'connect', color: 'override',
  });
});

test('browser tool settings store: etag flow, conflicts, storage fallback', async () => {
  const mod = await import('../pages/app/tool-settings.mjs');

  const storage = memStorage();
  const store = mod.createBrowserToolSettingsStore('test.tool-settings', storage);
  assert.deepEqual(store.get(), { toolCount: null, toolSlots: {} });
  const etag = store.etag();
  assert.match(etag, /^"[0-9a-f]{16}"$/);
  assert.equal(store.etag(), etag);

  // get() must return clones, not live references.
  const view = store.get();
  view.toolCount = 9;
  assert.equal(store.get().toolCount, null);

  assert.throws(
    () => store.replace({ toolCount: 2, toolSlots: {} }, '"0000000000000000"'),
    (error) => error.code === 'TOOL_SETTINGS_CONFLICT',
  );
  assert.throws(() => store.replace({ toolCount: -1, toolSlots: {} }, etag), TypeError);

  const replaced = store.replace({ toolCount: 2, toolSlots: { 1: { loaded: false } } }, etag);
  assert.deepEqual(replaced, { toolCount: 2, toolSlots: { 1: { loaded: false } } });
  assert.notEqual(store.etag(), etag);

  // A second store on the same storage sees the persisted settings.
  const rehydrated = mod.createBrowserToolSettingsStore('test.tool-settings', storage);
  assert.deepEqual(rehydrated.get(), { toolCount: 2, toolSlots: { 1: { loaded: false } } });
  assert.equal(rehydrated.etag(), store.etag());

  // Corrupt persisted JSON falls back to defaults instead of throwing.
  storage.setItem('test.corrupt', '{nope');
  const corrupt = mod.createBrowserToolSettingsStore('test.corrupt', storage);
  assert.deepEqual(corrupt.get(), { toolCount: null, toolSlots: {} });

  // Broken storage (private mode / quota) leaves the store memory-only.
  const throwing = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('quota'); },
  };
  const memoryOnly = mod.createBrowserToolSettingsStore('test.tool-settings', throwing);
  const memoryEtag = memoryOnly.etag();
  memoryOnly.replace({ toolCount: 3, toolSlots: {} }, memoryEtag);
  assert.equal(memoryOnly.get().toolCount, 3);

  const noStorage = mod.createBrowserToolSettingsStore('test.tool-settings', null);
  assert.deepEqual(noStorage.get(), { toolCount: null, toolSlots: {} });
});

// ---------------------------------------------------------------------------
// openprinttag.mjs (standalone, always runs)
// ---------------------------------------------------------------------------

test('filament index: loading on first search, then canned results', async () => {
  const mod = await import('../pages/app/openprinttag.mjs');
  const clock = makeClock();
  const { fetchImpl } = cannedOpenPrintTag();
  const index = mod.createFilamentIndex({ fetchImpl, storage: memStorage(), now: clock.now });

  const first = index.search('petg');
  assert.equal(first.loading, true);
  assert.equal(first.unavailable, false);
  assert.deepEqual(first.suggestions, []);

  assert.equal(await withWatchdog(index.refresh()), true);

  const second = index.search('petg');
  assert.equal(second.loading, false);
  assert.equal(second.stale, false);
  assert.equal(second.unavailable, false);
  assert.deepEqual(second.suggestions, [{ label: 'Contoso — PETG Clear', color: '#112233' }]);

  // Ranking cap: a broad query returns at most 12 suggestions.
  const broad = index.search('pla');
  assert.equal(broad.suggestions.length, 12);

  // Under-length and empty queries return the quiet empty shape.
  assert.deepEqual(index.search(''), {
    suggestions: [], stale: false, unavailable: false, loading: false,
  });
  assert.deepEqual(index.search('p'), {
    suggestions: [], stale: false, unavailable: false, loading: false,
  });
});

test('filament index: unavailable after a failed refresh', async () => {
  const mod = await import('../pages/app/openprinttag.mjs');
  const clock = makeClock();
  const fetchImpl = async () => { throw new Error('offline'); };
  const index = mod.createFilamentIndex({ fetchImpl, storage: memStorage(), now: clock.now });

  const first = index.search('petg');
  assert.equal(first.loading, true);
  assert.equal(await withWatchdog(index.refresh()), false);

  const second = index.search('petg');
  assert.deepEqual(second, { suggestions: [], stale: false, unavailable: true, loading: false });
});

test('filament index: serves the storage cache without refetching', async () => {
  const mod = await import('../pages/app/openprinttag.mjs');
  const clock = makeClock();
  const storage = memStorage();
  const { fetchImpl } = cannedOpenPrintTag();

  const warm = mod.createFilamentIndex({ fetchImpl, storage, now: clock.now });
  warm.search('petg');
  assert.equal(await withWatchdog(warm.refresh()), true);
  assert.ok(storage.getItem('layer-relay.static.openprinttag-v1'));

  let fetched = 0;
  const cold = mod.createFilamentIndex({
    fetchImpl: async () => { fetched++; throw new Error('must not fetch'); },
    storage,
    now: clock.now,
  });
  const result = cold.search('petg');
  assert.equal(fetched, 0);
  assert.equal(result.loading, false);
  assert.equal(result.stale, false);
  assert.equal(result.unavailable, false);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].label, 'Contoso — PETG Clear');
});

// ---------------------------------------------------------------------------
// replay.mjs (requires pages/app/toolswaps.mjs from the decoder port)
// ---------------------------------------------------------------------------

replayTest('replay: duration, warmup, live mapping, swaps, finish, determinism', async () => {
  const { createReplay } = await import('../pages/app/replay.mjs');
  const analysis = rootAnalysis();
  const replay = createReplay({ analysis, name: 'Voron cube x3' });

  assert.equal(replay.durationSec, DEMO_DURATION_SEC);

  const start = replay.stateAt(0);
  assert.equal(start.state, 'PRINTING');
  assert.equal(start.progress, 0);
  assert.equal(start.timeRemainingSec, DEMO_DURATION_SEC);
  assert.equal(start.toolLabel, 1);
  assert.equal(start.material, 'PLA');
  assert.equal(start.nozzleTarget, 215);
  assert.ok(start.nozzleTemp < 60, `warmup starts near ambient, got ${start.nozzleTemp}`);
  assert.equal(start.fanHotend, 0);
  assert.equal(start.swapping, false);
  assert.equal(start.currentLayer, 1);
  assert.equal(start.axisZ, 0.2);
  assert.equal(start.nextToolLabel, 2);
  assert.equal(start.nextSwapInSec, (120 - 96) * 60);
  assert.equal(start.filamentG, 87);
  assert.equal(start.name, 'Voron cube x3');

  // Halfway: 3600s played of 7200 -> progress 50, on tool 3 (ASA).
  const mid = replay.stateAt(3600);
  assert.equal(mid.progress, 50);
  assert.equal(mid.timeElapsedSec, 3600);
  assert.equal(mid.timeRemainingSec, 3600);
  assert.equal(mid.toolLabel, 3);
  assert.equal(mid.material, 'ASA');
  assert.equal(mid.nozzleTarget, 255);
  assert.ok(Math.abs(mid.nozzleTemp - 255) < 2, `at target after warmup, got ${mid.nozzleTemp}`);
  assert.equal(mid.bedTarget, 100);
  assert.equal(mid.chamberTarget, 45);
  assert.ok(mid.chamberTemp != null && mid.chamberTemp > 24);
  assert.ok(Math.abs(mid.fanHotend - 7900) <= 100);
  assert.equal(mid.swapsDone, 2);
  assert.equal(mid.swapsTotal, 3);
  assert.equal(mid.nextToolLabel, 1);
  assert.equal(mid.nextSwapInSec, (60 - 36) * 60);
  assert.equal(mid.currentLayer, 4);
  assert.equal(mid.totalLayers, 5);
  assert.equal(mid.axisZ, 0.8);
  assert.equal(mid.speed, 100);
  assert.ok(mid.flow >= 98 && mid.flow <= 102);
  assert.ok(mid.wasteDone > 0 && mid.wasteDone <= mid.wasteTotal);

  // First swap fires at duration - 96min = 1440s; the window lasts 12s.
  const swapping = replay.stateAt(1445);
  assert.equal(swapping.swapping, true);
  assert.ok(swapping.nozzleTemp < swapping.nozzleTarget - 10, 'nozzle dips during a swap');
  assert.equal(replay.stateAt(1460).swapping, false);

  const done = replay.stateAt(DEMO_DURATION_SEC);
  assert.equal(done.state, 'FINISHED');
  assert.equal(done.progress, 100);
  assert.equal(done.timeRemainingSec, 0);
  assert.equal(done.timeElapsedSec, DEMO_DURATION_SEC);
  assert.equal(done.nozzleTarget, 0);
  assert.equal(done.swapsDone, 3);
  assert.equal(done.currentLayer, 5);
  assert.equal(done.wasteDone, done.wasteTotal);
  assert.equal(done.swapping, false);
  assert.equal(replay.stateAt(DEMO_DURATION_SEC + 9999).state, 'FINISHED');

  // Deterministic: the same played second yields the same state.
  assert.deepEqual(replay.stateAt(3600), replay.stateAt(3600));

  // Scrub helper maps a percent onto the timeline.
  const scrub = replay.timelineFor(50);
  assert.equal(scrub.playedSec, 3600);
  assert.equal(scrub.currentTool, 2);

  // Overrides and fallbacks.
  assert.equal(createReplay({ analysis, durationSecOverride: 100 }).durationSec, 100);
  const bare = {
    ...rootToolswaps.buildTimeline('T0'),
    materials: [], gPerMm: 0.003, totalWasteG: 0, totalFilamentG: null,
  };
  assert.equal(createReplay({ analysis: bare }).durationSec, 3600);
  assert.throws(() => createReplay({}), TypeError);
});

// ---------------------------------------------------------------------------
// state-engine.mjs (requires the full pages/app decoder port)
// ---------------------------------------------------------------------------

engineTest('/api/state serves every overlay field and follows the fake clock', async () => {
  const { createEngine } = await import('../pages/app/state-engine.mjs');
  const clock = makeClock();
  const engine = createEngine({ now: clock.now, storage: memStorage() });

  await withWatchdog(engine.loadFile(demoBytes(), 'demo-cube.gcode'));
  engine.setSpeed(1);

  let response = await engine.handleFetch('/api/state', { cache: 'no-store' });
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  let state = await response.json();

  for (const field of OVERLAY_STATE_FIELDS) {
    assert.ok(field in state, `missing /api/state field: ${field}`);
  }
  assert.ok(!('error' in state), 'error must be absent on healthy state');
  assert.equal(state.state, 'PRINTING');
  assert.equal(state.progress, 0);
  assert.equal(state.online, true);
  assert.equal(state.staleSec, 0);
  assert.equal(state.updatedAt, Math.floor(clock.now() / 1000));
  assert.equal(state.analyzing, false);
  assert.equal(state.name, 'demo-cube');
  assert.match(state.thumbnailKey, /^static::\d+::demo-cube\.gcode$/);
  assert.equal(state.thumbnailUrl, null);
  assert.equal(state.timeRemainingSec, DEMO_DURATION_SEC);
  assert.equal(state.completedJob, null);
  assert.equal(state.timelapseIntervalSec, 10);
  assert.equal(state.camera.enabled, false);
  assert.equal(state.camera.state, 'disabled');
  assert.equal(state.nozzle.enabled, false);
  assert.equal(state.nozzlePipUrl, null);
  assert.equal(state.roomTemp, null);

  // Detected tool inventory from the decoded file: three tools, all loaded.
  assert.equal(state.toolCount, 3);
  assert.equal(state.toolCountSource, 'connect');
  assert.equal(state.toolSlots.length, 3);
  assert.equal(state.toolSlots[0].loaded, true);
  assert.equal(state.toolSlots[1].material, 'PETG');
  assert.equal(state.toolSettings.detected.source, null);
  assert.equal(state.toolSettings.detected.status, 'fresh');
  assert.equal(state.toolSettings.effective.toolCount, 3);

  // The clock drives progress: +3600s at 1x is halfway through the print.
  clock.advanceSec(3600);
  state = await (await engine.handleFetch('/api/state', {})).json();
  assert.equal(state.progress, 50);
  assert.equal(state.timeElapsedSec, 3600);
  assert.equal(state.toolLabel, 3);
  assert.equal(state.material, 'ASA');
  assert.equal(state.swapsDone, 2);
  assert.equal(state.currentLayer, 4);
  assert.equal(state.totalLayers, 5);
  assert.equal(state.nextToolLabel, 1);
  assert.equal(state.nextSwapInSec, 1440);

  // Pause freezes played time.
  engine.pause();
  clock.advanceSec(500);
  state = await (await engine.handleFetch('/api/state', {})).json();
  assert.equal(state.progress, 50);

  // Scrubbing seeks by percent.
  engine.seekPct(25);
  state = await (await engine.handleFetch('/api/state', {})).json();
  assert.equal(state.progress, 25);

  // Play again and run past the end: FINISHED with a completed-job snapshot.
  engine.play();
  clock.advanceSec(DEMO_DURATION_SEC);
  state = await (await engine.handleFetch('/api/state', {})).json();
  assert.equal(state.state, 'FINISHED');
  assert.equal(state.progress, 100);
  assert.equal(state.timeRemainingSec, 0);
  const completed = state.completedJob;
  assert.ok(completed, 'completedJob must be present after FINISHED');
  assert.equal(completed.finalState, 'FINISHED');
  assert.equal(completed.state, 'FINISHED');
  assert.equal(completed.progress, 100);
  assert.match(completed.jobKey, /^static::\d+::demo-cube\.gcode$/);
  assert.equal(completed.swapsDone, completed.swapsTotal);
  assert.equal(completed.currentLayer, completed.totalLayers);
  assert.equal(completed.wasteDone, completed.wasteTotal);
  assert.equal(completed.completedAt, Math.floor(clock.now() / 1000));
  assert.equal(completed.timeElapsedSec, DEMO_DURATION_SEC);

  const status = engine.getStatus();
  assert.equal(status.mode, 'file');
  assert.equal(status.fileName, 'demo-cube.gcode');
  assert.equal(status.durationSec, DEMO_DURATION_SEC);
});

engineTest('/api/jobmap mirrors the analysis timeline', async () => {
  const { createEngine } = await import('../pages/app/state-engine.mjs');
  const clock = makeClock();
  const engine = createEngine({ now: clock.now, storage: memStorage() });

  let jobmap = await (await engine.handleFetch('/api/jobmap', {})).json();
  assert.deepEqual(jobmap, { jobKey: null, swapPcts: [], totalLayers: null });

  await withWatchdog(engine.loadFile(demoBytes(), 'demo-cube.gcode'));
  jobmap = await (await engine.handleFetch('/api/jobmap', {})).json();
  const state = await (await engine.handleFetch('/api/state', {})).json();
  assert.deepEqual(jobmap, {
    jobKey: state.thumbnailKey,
    swapPcts: [20, 40, 70],
    totalLayers: 5,
  });

  // Reloading a re-sliced file under the same name must change the key, or the
  // overlay keeps the previous thumbnail and swap ticks.
  await withWatchdog(engine.loadFile(demoBytes(), 'demo-cube.gcode'));
  const reloaded = await (await engine.handleFetch('/api/state', {})).json();
  assert.notEqual(reloaded.thumbnailKey, state.thumbnailKey);
});

engineTest('/api/thumbnail serves stored bytes and 404s on key mismatch', async () => {
  const { createEngine } = await import('../pages/app/state-engine.mjs');
  const clock = makeClock();
  const thumbBytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4);
  const engine = createEngine({
    now: clock.now,
    storage: memStorage(),
    extractThumbnailsImpl: async () => [
      { format: 'png', width: 32, height: 24, data: Uint8Array.of(9) },
      { format: 'png', width: 320, height: 240, data: thumbBytes },
    ],
  });

  // Before any file: no thumbnail at all.
  assert.equal((await engine.handleFetch('/api/thumbnail', {})).status, 404);

  await withWatchdog(engine.loadFile(demoBytes(), 'demo-cube.gcode'));

  const jobKey = (await (await engine.handleFetch('/api/state', {})).json()).thumbnailKey;
  const hit = await engine.handleFetch(`/api/thumbnail?j=${encodeURIComponent(jobKey)}`, {});
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), thumbBytes);

  // Key comparison is case-insensitive, like the server's sameJobKey.
  const upper = await engine.handleFetch(
    `/api/thumbnail?j=${encodeURIComponent(jobKey.toUpperCase())}`, {});
  assert.equal(upper.status, 200);

  const miss = await engine.handleFetch('/api/thumbnail?j=other%3A%3Ajob', {});
  assert.equal(miss.status, 404);

  // /api/state advertises the thumbnail for the current job.
  const state = await (await engine.handleFetch('/api/state', {})).json();
  assert.equal(typeof state.thumbnailUrl, 'string');
  assert.ok(state.thumbnailUrl.length > 0);
});

engineTest('settings endpoints: ETag flow, If-Match conflicts, timelapse', async () => {
  const { createEngine } = await import('../pages/app/state-engine.mjs');
  const clock = makeClock();
  const engine = createEngine({ now: clock.now, storage: memStorage() });
  await withWatchdog(engine.loadFile(demoBytes(), 'demo-cube.gcode'));

  const got = await engine.handleFetch('/api/settings/tools', {});
  assert.equal(got.status, 200);
  const etag = got.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{16}"$/);
  const view = await got.json();
  assert.equal(view.toolCount, null);
  assert.deepEqual(view.toolSlots, {});
  assert.equal(view.minimumToolCount, 1);
  assert.equal(view.detected.toolCount, 3);
  assert.equal(view.effective.toolCount, 3);
  assert.equal(view.effective.toolCountSource, 'connect');

  const putInit = (body, headers) => ({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const payload = {
    toolCount: 5,
    toolSlots: { 2: { loaded: true, name: 'Galaxy Black', color: '#112233' } },
  };

  // Missing and mismatching If-Match are conflicts, exactly like the server.
  assert.equal((await engine.handleFetch('/api/settings/tools', putInit(payload, {}))).status, 409);
  assert.equal((await engine.handleFetch(
    '/api/settings/tools', putInit(payload, { 'If-Match': '"0000000000000000"' }))).status, 409);

  const saved = await engine.handleFetch(
    '/api/settings/tools', putInit(payload, { 'If-Match': etag }));
  assert.equal(saved.status, 200);
  const savedEtag = saved.headers.get('etag');
  assert.ok(savedEtag && savedEtag !== etag);
  const savedView = await saved.json();
  assert.equal(savedView.toolCount, 5);
  assert.equal(savedView.effective.toolCount, 5);
  assert.equal(savedView.effective.toolCountSource, 'override');
  assert.equal(savedView.toolSlots['2'].name, 'Galaxy Black');

  // The stale first ETag now conflicts; the new one accepts further writes.
  assert.equal((await engine.handleFetch(
    '/api/settings/tools', putInit(payload, { 'If-Match': etag }))).status, 409);

  // Invalid shapes and invalid JSON are 400s.
  const invalid = await engine.handleFetch(
    '/api/settings/tools', putInit({ toolCount: 0, toolSlots: {} }, { 'If-Match': savedEtag }));
  assert.equal(invalid.status, 400);
  const broken = await engine.handleFetch('/api/settings/tools', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': savedEtag },
    body: '{nope',
  });
  assert.equal(broken.status, 400);

  // The saved override flows into /api/state.
  const state = await (await engine.handleFetch('/api/state', {})).json();
  assert.equal(state.toolCount, 5);
  assert.equal(state.toolCountSource, 'override');
  assert.equal(state.toolSettings.toolCount, 5);

  // Timelapse interval: accepted range 1..20, reflected in /api/state.
  const timelapse = await engine.handleFetch('/api/settings/timelapse', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intervalSec: 7 }),
  });
  assert.equal(timelapse.status, 200);
  assert.deepEqual(await timelapse.json(), { intervalSec: 7 });
  assert.equal((await (await engine.handleFetch('/api/state', {})).json()).timelapseIntervalSec, 7);
  const badInterval = await engine.handleFetch('/api/settings/timelapse', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intervalSec: 25 }),
  });
  assert.equal(badInterval.status, 400);
});

engineTest('/api/filaments proxies the injected filament index', async () => {
  const { createEngine } = await import('../pages/app/state-engine.mjs');
  const { createFilamentIndex } = await import('../pages/app/openprinttag.mjs');
  const clock = makeClock();
  const { fetchImpl } = cannedOpenPrintTag();
  const index = createFilamentIndex({ fetchImpl, storage: memStorage(), now: clock.now });
  const engine = createEngine({ now: clock.now, storage: memStorage(), filamentIndex: index });

  const first = await (await engine.handleFetch('/api/filaments?q=petg', {})).json();
  assert.equal(first.loading, true);
  assert.deepEqual(first.suggestions, []);

  assert.equal(await withWatchdog(index.refresh()), true);

  const second = await (await engine.handleFetch('/api/filaments?q=petg', {})).json();
  assert.deepEqual(second, {
    suggestions: [{ label: 'Contoso — PETG Clear', color: '#112233' }],
    stale: false,
    unavailable: false,
    loading: false,
  });

  const empty = await (await engine.handleFetch('/api/filaments?q=', {})).json();
  assert.deepEqual(empty, { suggestions: [], stale: false, unavailable: false, loading: false });

  // A failed refresh surfaces as unavailable, which the overlay renders.
  const failingIndex = createFilamentIndex({
    fetchImpl: async () => { throw new Error('offline'); },
    storage: memStorage(),
    now: clock.now,
  });
  const failing = createEngine({ now: clock.now, storage: memStorage(), filamentIndex: failingIndex });
  await (await failing.handleFetch('/api/filaments?q=petg', {})).json();
  await withWatchdog(failingIndex.refresh());
  const unavailable = await (await failing.handleFetch('/api/filaments?q=petg', {})).json();
  assert.equal(unavailable.unavailable, true);
  assert.equal(unavailable.loading, false);
});

engineTest('demo mode loads the asset through the injected fetch', async () => {
  const { createEngine } = await import('../pages/app/state-engine.mjs');
  const clock = makeClock();
  const fetched = [];
  const fetchImpl = async (url, init) => {
    fetched.push({ url, init });
    return new Response(DEMO_GCODE, { status: 200 });
  };
  const engine = createEngine({ now: clock.now, storage: memStorage(), fetchImpl });

  await withWatchdog(engine.setModeDemo('./demo.bgcode'));
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, './demo.bgcode');

  const status = engine.getStatus();
  assert.equal(status.mode, 'demo');
  assert.equal(status.analyzing, false);
  assert.equal(status.error, null);
  const state = await (await engine.handleFetch('/api/state', {})).json();
  assert.equal(state.state, 'PRINTING');
  assert.match(state.thumbnailKey, /^static::\d+::demo\.bgcode$/);

  // A failing demo fetch rejects and records the error, so a caller cannot
  // mistake a missing demo asset for a loaded one.
  const failing = createEngine({
    now: clock.now,
    storage: memStorage(),
    fetchImpl: async () => new Response('missing', { status: 404 }),
  });
  await assert.rejects(
    withWatchdog(failing.setModeDemo('./demo.bgcode')),
    /demo asset fetch failed/);
  assert.match(failing.getStatus().error, /demo asset fetch failed/);
  const errored = await (await failing.handleFetch('/api/state', {})).json();
  assert.equal(typeof errored.error, 'string');
});

engineTest('live mode forwards /api paths to the bridge with CORS', async () => {
  const { createEngine } = await import('../pages/app/state-engine.mjs');
  const clock = makeClock();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const engine = createEngine({ now: clock.now, storage: memStorage(), fetchImpl });

  globalThis.window = {};
  try {
    assert.equal(engine.setBridge('https://bridge.example'), 'https://bridge.example');
    assert.equal(globalThis.window.__LR_API_BASE, 'https://bridge.example');
    assert.equal(engine.getStatus().mode, 'live');

    const response = await engine.handleFetch('/api/state', { cache: 'no-store' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://bridge.example/api/state');
    assert.equal(calls[0].init.mode, 'cors');
    assert.equal(calls[0].init.cache, 'no-store');
    assert.deepEqual(await response.json(), { ok: true });

    // PUTs forward untouched too (headers, body, method).
    await engine.handleFetch('/api/settings/tools', {
      method: 'PUT',
      headers: { 'If-Match': '"x"' },
      body: '{}',
    });
    assert.equal(calls[1].url, 'https://bridge.example/api/settings/tools');
    assert.equal(calls[1].init.method, 'PUT');
  } finally {
    delete globalThis.window;
  }

  // Image URL fields must come back bridge-absolute: <img> loads never pass
  // through the fetch shim, so a root-relative path would resolve against the
  // static host and 404 there.
  const imageEngine = createEngine({
    now: clock.now,
    storage: memStorage(),
    fetchImpl: async () => new Response(JSON.stringify({
      thumbnailUrl: '/api/thumbnail',
      nozzlePipUrl: '/api/nozzle.mjpeg',
      timelapseUrl: 'https://timelapse.example/clip',
      state: 'PRINTING',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  globalThis.window = {};
  try {
    imageEngine.setBridge('https://bridge.example');
    const live = await (await imageEngine.handleFetch('/api/state', {})).json();
    assert.equal(live.thumbnailUrl, 'https://bridge.example/api/thumbnail');
    assert.equal(live.nozzlePipUrl, 'https://bridge.example/api/nozzle.mjpeg');
    assert.equal(live.timelapseUrl, 'https://timelapse.example/clip');
    assert.equal(live.state, 'PRINTING');
  } finally {
    delete globalThis.window;
  }

  for (const bad of [
    'ftp://bridge.example',
    'https://user:pw@bridge.example',
    'https://bridge.example/path',
    'https://bridge.example/?q=1',
    'not a url',
  ]) {
    assert.throws(() => engine.setBridge(bad), TypeError, `must reject ${bad}`);
  }
});

engineTest('handleFetch ignores non-API URLs and honors aborted signals', async () => {
  const { createEngine } = await import('../pages/app/state-engine.mjs');
  const clock = makeClock();
  const engine = createEngine({ now: clock.now, storage: memStorage() });

  assert.equal(engine.handleFetch('/overlay.html', {}), null);
  assert.equal(engine.handleFetch('https://example.test/api/state', {}), null);
  assert.equal(engine.handleFetch('/apix', {}), null);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    withWatchdog(engine.handleFetch('/api/state', { signal: controller.signal })),
    (error) => error.name === 'AbortError',
  );

  const missing = await engine.handleFetch('/api/nope', {});
  assert.equal(missing.status, 404);
});
