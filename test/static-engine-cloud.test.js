'use strict';
// Tests for cloud mode in the static build's virtual API engine
// (pages/app/state-engine.mjs): Prusa Connect telemetry arriving over MQTT,
// merged with an optionally dropped .bgcode analysis.
//
// Every collaborator is injected: the MQTT client, the Connect auth client and
// the topic mapper are all fakes, so these tests never touch the network, a
// printer, or a refresh token, and they do not depend on pages/app/mqtt.mjs,
// connect-auth.mjs or connect-live.mjs existing yet. The fake mapper follows
// the contract those modules publish: the engine strips the
// v1/devices/printers/<id>/ prefix and calls apply() with the relative topic.

const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { test } = require('bun:test');
const rootToolswaps = require('../toolswaps.js');

const PAGES = path.join(__dirname, '..', 'pages', 'app');
const hasFile = (name) => existsSync(path.join(PAGES, name));
const hasEngineDeps = ['toolswaps.mjs', 'bgcode.mjs', 'qoi.mjs', 'print-name.mjs', 'state-engine.mjs']
  .every(hasFile);
const engineTest = hasEngineDeps ? test : test.skip;

const PRINTER_ID = 'prusa-core-one-0001';
const TOPIC_ROOT = `v1/devices/printers/${PRINTER_ID}/`;
// A syntactically plausible stand-in. No real token is used anywhere here.
const FAKE_REFRESH_TOKEN = 'fake-refresh-token-not-a-real-credential';

// ---- harness -----------------------------------------------------------------

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeClock(startMs = 1700000000000) {
  let current = startMs;
  return {
    now: () => current,
    setNow: (value) => { current = value; },
    advanceSec: (sec) => { current += sec * 1000; },
  };
}

function memStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    dump: () => JSON.stringify([...map.entries()]),
  };
}

// Deterministic timer queue: the engine's backoff and connect watchdog run
// through this, so tests observe the exact delays and fire them by hand.
function fakeTimers(clock) {
  let seq = 0;
  const pending = new Map();
  return {
    set: (fn, ms) => { const id = ++seq; pending.set(id, { fn, at: clock.now() + ms, ms }); return id; },
    clear: (id) => { pending.delete(id); },
    size: () => pending.size,
    delays: () => [...pending.values()].map((timer) => timer.ms).sort((a, b) => a - b),
    async run() {
      const entries = [...pending.entries()].sort((a, b) => a[1].at - b[1].at);
      if (!entries.length) return null;
      const [id, timer] = entries[0];
      pending.delete(id);
      clock.setNow(timer.at);
      timer.fn();
      await flush();
      return timer.ms;
    },
  };
}

function fakeAuth() {
  const calls = { accessToken: 0, userId: 0, configured: [], cleared: 0 };
  const auth = {
    calls,
    accessToken: 'access-token-1',
    userId: 9876543,
    nextAccessError: null,
    configure(config) { calls.configured.push(config); },
    async getAccessToken() {
      calls.accessToken += 1;
      if (auth.nextAccessError) {
        const error = auth.nextAccessError;
        auth.nextAccessError = null;
        throw error;
      }
      return auth.accessToken;
    },
    async getUserId() { calls.userId += 1; return auth.userId; },
    clear() { calls.cleared += 1; },
  };
  return auth;
}

function fakeMqtt() {
  const created = [];
  const factory = async (config) => {
    const handlers = new Map();
    const client = {
      config,
      subscriptions: [],
      connects: 0,
      closes: 0,
      on(event, callback) {
        const list = handlers.get(event) || [];
        list.push(callback);
        handlers.set(event, list);
      },
      async connect() { client.connects += 1; },
      subscribe(filters) { client.subscriptions.push(...filters); },
      close() { client.closes += 1; },
      emit(event, payload) {
        for (const callback of handlers.get(event) || []) callback(payload);
      },
    };
    created.push(client);
    return client;
  };
  return { factory, created, last: () => created[created.length - 1] || null };
}

// Stand-in for pages/app/connect-live.mjs. Mirrors the verified topic table
// (relative topics, string payloads) and the prusaconnect.js state vocabulary.
const STATE_MAP = {
  PRINTING: 'PRINTING', PAUSED: 'PAUSED', PAUSING: 'PRINTING', RESUMING: 'PRINTING',
  FINISHED: 'FINISHED', STOPPED: 'IDLE', IDLE: 'IDLE', READY: 'IDLE',
  ATTENTION: 'ERROR', ERROR: 'ERROR',
};

function fakeConnectState() {
  const snapshot = {
    state: 'IDLE', online: null, progress: null, timeRemainingSec: null,
    material: null, axisZ: null, currentTool: null, toolLabel: null,
    nozzleTemp: null, nozzleTarget: null, bedTemp: null, bedTarget: null,
    chamberTemp: null, chamberTarget: null, activity: null,
    name: null, thumbnailUrl: null, speed: null, flow: null,
    fanHotend: null, timeElapsedSec: null, filamentG: null,
  };
  let jobId = null;
  let jobProgress = null;
  const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const normalizeState = (value) => STATE_MAP[String(value || '').toUpperCase()] || 'UNKNOWN';

  function applyJob(id, leaf, payload) {
    if (jobId == null || String(id) !== String(jobId)) return; // stale job, ignored
    if (leaf === 'progress') { jobProgress = num(payload); snapshot.progress = jobProgress; }
    else if (leaf === 'time-remaining') snapshot.timeRemainingSec = num(payload);
    else if (leaf === 'state') snapshot.state = normalizeState(payload);
  }

  function apply(topic, payload) {
    const job = /^jobs\/([^/]+)\/data\/(.+)$/.exec(topic);
    if (job) { applyJob(job[1], job[2], payload); return; }
    switch (topic) {
      case 'data/state': snapshot.state = normalizeState(payload); break;
      case 'data/online': snapshot.online = String(payload).trim() === '1'; break;
      case 'data/current-job': jobId = String(payload); break;
      case 'data/job-progress':
        if (jobProgress == null) snapshot.progress = num(payload);
        break;
      case 'data/material': snapshot.material = String(payload); break;
      case 'data/axis-z': snapshot.axisZ = num(payload); break;
      case 'data/tools/active': {
        const label = num(payload);
        snapshot.toolLabel = label;
        snapshot.currentTool = label == null ? null : label - 1;
        break;
      }
      case 'data/temp/nozzle/current': snapshot.nozzleTemp = num(payload); break;
      case 'data/temp/nozzle/target': snapshot.nozzleTarget = num(payload); break;
      case 'data/temp/heatbed/current': snapshot.bedTemp = num(payload); break;
      case 'data/temp/heatbed/target': snapshot.bedTarget = num(payload); break;
      case 'data/temp/chamber/current': snapshot.chamberTemp = num(payload); break;
      case 'dialog': {
        const dialog = JSON.parse(payload);
        const label = dialog && (dialog.title || dialog.text);
        snapshot.activity = label
          ? { active: true, kind: 'OPERATION', label: 'Printer busy', detail: String(label), progress: null }
          : null;
        break;
      }
      default: break;
    }
  }

  return { apply, snapshot: () => ({ ...snapshot }), get jobId() { return jobId; } };
}

// Retained payloads exactly as captured from the live broker.
const RETAINED = [
  ['data/current-job', '650'],
  ['data/state', 'PRINTING'],
  ['data/online', '1'],
  ['data/job-progress', '13'],
  ['data/material', 'PLA'],
  ['data/axis-z', '1.19'],
  ['data/tools/active', '3'],
  ['data/temp/nozzle/current', '225.1'],
  ['data/temp/nozzle/target', '225.0'],
  ['data/temp/heatbed/current', '59.7'],
  ['data/temp/heatbed/target', '60.0'],
  ['data/temp/chamber/current', '30.8'],
  ['dialog', '{"id":405205626,"code":null,"text":null,"title":null,"buttons":null,"key":null}'],
  ['jobs/650/data/state', 'PRINTING'],
  ['jobs/650/data/progress', '50'],
  ['jobs/650/data/time-remaining', '3600'],
];

function publish(client, topic, payload, retained = true) {
  client.emit('message', { topic: TOPIC_ROOT + topic, payload, retained });
}

function bringLive(client, messages = RETAINED) {
  client.emit('connack', { returnCode: 0 });
  client.emit('suback', { granted: [0] });
  for (const [topic, payload] of messages) publish(client, topic, payload);
}

// Same five-layer, three-swap fixture the replay tests use: T0 -> T1 -> T2 -> T0
// across 120 minutes of M73 clock.
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

const demoBytes = () => new TextEncoder().encode(DEMO_GCODE);
const rootAnalysis = () => rootToolswaps.analyzeBgcode(Buffer.from(DEMO_GCODE));

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

async function cloudHarness(extra = {}) {
  const { createEngine } = await import('../pages/app/state-engine.mjs');
  const clock = makeClock();
  const timers = fakeTimers(clock);
  const mqtt = fakeMqtt();
  const auth = fakeAuth();
  const storage = memStorage();
  const engine = createEngine({
    now: clock.now,
    storage,
    // Any network call at all is a test failure, not a fallback.
    fetchImpl: () => { throw new Error('cloud mode tests must not use fetch'); },
    authFactory: async () => auth,
    mqttFactory: mqtt.factory,
    connectStateFactory: () => fakeConnectState(),
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
    clientIdFactory: () => 'lr-static-test-client',
    ...extra,
  });
  return { engine, clock, timers, mqtt, auth, storage };
}

const stateOf = async (engine) => (await engine.handleFetch('/api/state', {})).json();

// ---- tests -------------------------------------------------------------------

engineTest('printer ids that could rewrite an MQTT topic filter are rejected', async () => {
  const { normalizeConnectPrinterId } = await import('../pages/app/state-engine.mjs');
  assert.equal(normalizeConnectPrinterId(`  ${PRINTER_ID} `), PRINTER_ID);
  assert.equal(normalizeConnectPrinterId('ABCDEF0123456789'), 'ABCDEF0123456789');
  for (const bad of ['', 'short', 'has/slash/here', 'wildcard#here', 'plus+here',
    'spaces in here', '-leading-dash-id', 'a'.repeat(65), null, undefined]) {
    assert.throws(() => normalizeConnectPrinterId(bad), TypeError, `must reject ${String(bad)}`);
  }
});

engineTest('cloud mode connects, subscribes to one printer tree, and maps retained topics', async () => {
  const { engine, mqtt, auth, timers, storage } = await cloudHarness();

  await engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID });

  assert.equal(engine.getStatus().mode, 'cloud');
  assert.deepEqual(auth.calls.configured, [
    { refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID },
  ]);
  assert.equal(auth.calls.accessToken, 1, 'the access token is refreshed before the attempt');
  assert.equal(auth.calls.userId, 1);

  const client = mqtt.last();
  assert.ok(client, 'an MQTT client must be created');
  assert.equal(client.config.url, 'wss://mqtt.prusa3d.com:8084/mqtt');
  assert.equal(client.config.username, '9876543', 'username is the numeric Prusa user id');
  assert.equal(client.config.password, 'access-token-1');
  assert.equal(client.connects, 1);

  // Nothing has arrived yet: the overlay must see a disconnected printer.
  let state = await stateOf(engine);
  assert.equal(state.online, false);
  assert.equal(engine.getStatus().cloud.phase, 'connecting');

  bringLive(client);
  assert.deepEqual(client.subscriptions, [`v1/devices/printers/${PRINTER_ID}/#`],
    'only the per-printer tree may be subscribed; v1/devices/# is denied by the broker');

  state = await stateOf(engine);
  for (const field of OVERLAY_STATE_FIELDS) {
    assert.ok(field in state, `missing /api/state field: ${field}`);
  }
  assert.equal(state.state, 'PRINTING');
  assert.equal(state.online, true);
  assert.equal(state.staleSec, 0);
  assert.equal(state.progress, 50, 'the current job subtree wins over data/job-progress');
  assert.equal(state.timeRemainingSec, 3600);
  assert.equal(state.material, 'PLA');
  assert.equal(state.axisZ, 1.19);
  assert.equal(state.toolLabel, 3, 'data/tools/active is 1-based');
  assert.equal(state.currentTool, 2, 'and converts to a 0-based currentTool');
  assert.equal(state.nozzleTemp, 225.1);
  assert.equal(state.nozzleTarget, 225);
  assert.equal(state.bedTemp, 59.7);
  assert.equal(state.bedTarget, 60);
  assert.equal(state.chamberTemp, 30.8);
  assert.equal(state.chamberTarget, null, 'no chamber target is published');
  assert.equal(state.activity, null, 'a dialog with null text is not an activity');

  // Without a dropped file every file-derived field stays null and the overlay
  // degrades cleanly rather than showing invented numbers.
  assert.equal(state.name, null);
  assert.equal(state.thumbnailUrl, null);
  assert.equal(state.currentLayer, null);
  assert.equal(state.totalLayers, null);
  assert.equal(state.swapsTotal, null);
  assert.equal(state.wasteTotal, null);
  assert.equal(state.filamentG, null);
  assert.equal(state.timeElapsedSec, null);

  // No camera exists in cloud mode; the overlay reads the disabled shape.
  assert.equal(state.camera.enabled, false);
  assert.equal(state.camera.state, 'disabled');
  assert.equal(state.camera.error, 'no camera in cloud mode');
  assert.equal(state.nozzle.enabled, false);
  assert.equal(state.nozzlePipUrl, null);

  const status = engine.getStatus();
  assert.equal(status.cloud.phase, 'live');
  assert.equal(status.cloud.printerUuid, PRINTER_ID);
  assert.equal(status.cloud.topics, RETAINED.length);
  assert.equal(status.cloud.error, null);
  assert.equal(status.cloud.fatal, false);
  assert.equal(timers.size(), 0, 'the connect watchdog is cleared once the link is live');

  // The engine persists the printer id only. The refresh token belongs to
  // connect-auth's own storage key and must never appear in the engine's.
  assert.equal(storage.getItem('layer-relay.static.cloud.printer'), PRINTER_ID);
  assert.ok(!storage.dump().includes(FAKE_REFRESH_TOKEN),
    'the engine must never persist the refresh token');
});

engineTest('a dialog with text becomes an activity and job state changes follow', async () => {
  const { engine, mqtt } = await cloudHarness();
  await engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID });
  const client = mqtt.last();
  bringLive(client);

  publish(client, 'dialog',
    '{"id":1,"code":null,"text":"Insert filament","title":"Filament","buttons":null,"key":null}');
  let state = await stateOf(engine);
  assert.equal(state.activity.active, true);
  assert.equal(state.activity.kind, 'OPERATION');
  assert.equal(state.activity.detail, 'Filament');

  publish(client, 'data/state', 'PAUSING');
  state = await stateOf(engine);
  assert.equal(state.state, 'PRINTING', 'PAUSING normalizes to PRINTING');

  publish(client, 'data/state', 'ATTENTION');
  state = await stateOf(engine);
  assert.equal(state.state, 'ERROR', 'ATTENTION normalizes to ERROR');

  // A retained message from a job the printer already left must not overwrite
  // the live values.
  publish(client, 'jobs/649/data/time-remaining', '99999');
  state = await stateOf(engine);
  assert.equal(state.timeRemainingSec, 3600);
});

engineTest('a dropped .bgcode supplies the fields MQTT never publishes', async () => {
  const { engine, mqtt } = await cloudHarness();
  await engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID });
  bringLive(mqtt.last());

  await engine.loadFile(demoBytes(), 'demo-cube.gcode');
  assert.equal(engine.getStatus().mode, 'cloud',
    'loading an analysis must not drop out of cloud mode');

  const state = await stateOf(engine);
  // Live telemetry still wins for everything the printer reports.
  assert.equal(state.state, 'PRINTING');
  assert.equal(state.progress, 50);
  assert.equal(state.toolLabel, 3);
  assert.equal(state.material, 'PLA', 'the printer reports the loaded material, not the slicer');

  // mapLive(analysis, progress, timeRemainingSec / 60) supplies the rest.
  const expected = rootToolswaps.mapLive(rootAnalysis(), 50, 3600 / 60);
  assert.equal(state.name, 'demo-cube');
  assert.match(state.thumbnailKey, /^cloud::650::\d+::demo-cube\.gcode$/);
  assert.equal(state.swapsDone, 2);
  assert.equal(state.swapsTotal, 3);
  assert.equal(state.currentLayer, 4);
  assert.equal(state.totalLayers, 5);
  assert.equal(state.nextToolLabel, 1);
  assert.equal(state.nextSwapInSec, 1440);
  assert.equal(state.filamentG, 87);
  assert.equal(state.wasteTotal, Math.round(expected.wasteTotal * 10) / 10);
  assert.equal(state.wasteDone, Math.round(expected.wasteDone * 10) / 10);

  // Per-tool materials come from the analysis through the tool inventory.
  assert.equal(state.toolCount, 3);
  assert.equal(state.toolSlots[1].material, 'PETG');
  assert.equal(state.toolSlots[2].material, 'ASA');

  // The swap map the overlay draws is served from the same analysis.
  const jobmap = await (await engine.handleFetch('/api/jobmap', {})).json();
  assert.equal(jobmap.jobKey, state.thumbnailKey);
  assert.equal(jobmap.totalLayers, 5);
  assert.equal(jobmap.swapPcts.length, 3);
});

engineTest('without a printer material the analysis fills it in per tool', async () => {
  const { engine, mqtt } = await cloudHarness();
  await engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID });
  bringLive(mqtt.last(), RETAINED.filter(([topic]) => topic !== 'data/material'));
  await engine.loadFile(demoBytes(), 'demo-cube.gcode');

  const state = await stateOf(engine);
  assert.equal(state.currentTool, 2);
  assert.equal(state.material, 'ASA', 'materials[currentTool] from the decoded file');
});

engineTest('a dropped link reports stale then offline and reconnects with backoff', async () => {
  const { engine, clock, timers, mqtt, auth } = await cloudHarness();
  await engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID });
  const first = mqtt.last();
  bringLive(first);
  assert.equal((await stateOf(engine)).online, true);

  first.emit('close');
  let state = await stateOf(engine);
  assert.equal(state.online, false, 'a dead socket is offline even though data/online is retained 1');
  assert.equal(state.staleSec, 0);
  assert.equal(engine.getStatus().cloud.phase, 'retrying');
  assert.deepEqual(timers.delays(), [2000], 'first backoff is 2s');

  // The overlay's own thresholds: stale above 3s, disconnected at 8s.
  clock.advanceSec(4);
  state = await stateOf(engine);
  assert.equal(state.staleSec, 4);
  clock.advanceSec(5);
  state = await stateOf(engine);
  assert.equal(state.staleSec, 9);
  assert.equal(state.online, false);

  // Retry: a fresh access token is fetched before every attempt.
  const tokensBefore = auth.calls.accessToken;
  auth.accessToken = 'access-token-2';
  await timers.run();
  assert.equal(auth.calls.accessToken, tokensBefore + 1);
  // The profile endpoint is asked once per session: a 401 there makes
  // connect-auth drop its cached access token, so re-asking every reconnect
  // would rotate the refresh token once per backoff cycle.
  assert.equal(auth.calls.userId, 1, 'the user id is not re-fetched on reconnect');
  const second = mqtt.last();
  assert.notEqual(second, first, 'a new client is built for the new attempt');
  assert.equal(second.config.password, 'access-token-2');
  assert.deepEqual(timers.delays(), [20000], 'only the connect watchdog is pending mid-attempt');

  // Second failure doubles the delay, and the ceiling is 30s.
  second.emit('error', new Error('handshake failed'));
  assert.deepEqual(timers.delays(), [4000]);
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    await timers.run();
    mqtt.last().emit('close');
    seen.push(timers.delays()[0]);
  }
  assert.deepEqual(seen, [8000, 16000, 30000, 30000, 30000]);

  // A successful reconnect clears the error and restores freshness.
  await timers.run();
  bringLive(mqtt.last());
  state = await stateOf(engine);
  assert.equal(state.online, true);
  assert.equal(state.staleSec, 0);
  const status = engine.getStatus();
  assert.equal(status.cloud.phase, 'live');
  assert.equal(status.cloud.error, null);
  assert.equal(status.cloud.attempt, 0);
});

engineTest('a terminal invalid_grant stops retrying and surfaces what to do', async () => {
  const { engine, timers, mqtt, auth } = await cloudHarness();
  auth.nextAccessError = Object.assign(
    new Error(`refresh rejected for ${FAKE_REFRESH_TOKEN}`), { code: 'invalid_grant' });

  await engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID });

  const status = engine.getStatus();
  assert.equal(status.cloud.phase, 'error');
  assert.equal(status.cloud.fatal, true);
  assert.equal(mqtt.created.length, 0, 'no socket is opened on a dead token chain');
  assert.equal(timers.size(), 0, 'a dead chain must not be retried');
  assert.match(status.cloud.error, /invalid_grant/);
  assert.match(status.cloud.error, /docs\/prusa-connect\.md/);
  assert.ok(!status.cloud.error.includes(FAKE_REFRESH_TOKEN),
    'the surfaced message must never contain the token');

  const state = await stateOf(engine);
  assert.equal(state.online, false);
  assert.equal(state.error, status.cloud.error);
});

engineTest('cloud mode without a stored printer id refuses to start', async () => {
  const { engine, mqtt } = await cloudHarness();
  await assert.rejects(() => engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN }),
    (error) => error.code === 'not_configured');
  assert.equal(engine.getStatus().mode, 'demo', 'a refused start must not change the mode');
  assert.equal(mqtt.created.length, 0);
});

engineTest('a reconnect reuses the printer id persisted by an earlier session', async () => {
  const storage = memStorage();
  storage.setItem('layer-relay.static.cloud.printer', PRINTER_ID);
  const { engine, mqtt } = await cloudHarness({ storage });

  await engine.setModeCloud({});
  assert.equal(engine.getStatus().cloud.printerUuid, PRINTER_ID);
  bringLive(mqtt.last());
  assert.deepEqual(mqtt.last().subscriptions, [`v1/devices/printers/${PRINTER_ID}/#`]);
  assert.equal((await stateOf(engine)).online, true);
});

engineTest('leaving cloud mode closes the link and stops every timer', async () => {
  const { engine, timers, mqtt } = await cloudHarness({
    analyzeImpl: async () => rootAnalysis(),
    extractThumbnailsImpl: async () => [],
  });
  await engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID });
  const client = mqtt.last();
  bringLive(client);
  client.emit('close');
  assert.equal(timers.size(), 1, 'a reconnect is pending');

  engine.setBridge('http://127.0.0.1:8787');
  assert.equal(engine.getStatus().mode, 'live');
  assert.equal(engine.getStatus().cloud, null);
  assert.equal(timers.size(), 0, 'the pending reconnect is cancelled');
  assert.ok(client.closes >= 1, 'the MQTT client is closed');

  // Late events from the abandoned client must not resurrect cloud mode.
  client.emit('close');
  client.emit('message', { topic: `${TOPIC_ROOT}data/state`, payload: 'FINISHED', retained: true });
  assert.equal(timers.size(), 0);
  assert.equal(engine.getStatus().mode, 'live');

  // The file mode path also tears cloud down.
  await engine.setModeCloud({ printerUuid: PRINTER_ID });
  bringLive(mqtt.last());
  await engine.loadFile(demoBytes(), 'demo-cube.gcode');
  assert.equal(engine.getStatus().mode, 'cloud');
  await engine.setModeDemo('demo.bgcode').catch(() => {});
  assert.equal(engine.getStatus().mode, 'demo');
  assert.equal(timers.size(), 0);
});

engineTest('a token refresh that resolves after teardown never opens a socket', async () => {
  const { engine, mqtt, auth } = await cloudHarness();
  let release = null;
  auth.getAccessToken = () => new Promise((resolve) => { release = () => resolve('late-token'); });

  const pending = engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID });
  await flush();
  assert.equal(typeof release, 'function', 'the attempt must be waiting on the token');

  engine.stopCloud();
  release();
  await pending;
  await flush();
  assert.equal(mqtt.created.length, 0, 'the abandoned attempt must not connect');
});

engineTest('the connect watchdog retries a link that never answers', async () => {
  const { engine, timers, mqtt } = await cloudHarness();
  await engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID });
  const first = mqtt.last();
  assert.deepEqual(timers.delays(), [20000]);

  await timers.run();
  assert.ok(first.closes >= 1, 'the silent client is closed');
  assert.equal(engine.getStatus().cloud.phase, 'retrying');
  assert.deepEqual(timers.delays(), [2000]);
  assert.match(engine.getStatus().cloud.error, /20s/);
});

engineTest('a finished cloud job produces a completed-job snapshot once', async () => {
  const { engine, clock, mqtt } = await cloudHarness();
  await engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID });
  const client = mqtt.last();
  bringLive(client);
  await engine.loadFile(demoBytes(), 'demo-cube.gcode');

  publish(client, 'jobs/650/data/progress', '100');
  publish(client, 'jobs/650/data/time-remaining', '0');
  publish(client, 'data/state', 'FINISHED');

  const state = await stateOf(engine);
  assert.equal(state.state, 'FINISHED');
  const completed = state.completedJob;
  assert.ok(completed, 'completedJob must be present after FINISHED');
  assert.equal(completed.finalState, 'FINISHED');
  assert.equal(completed.progress, 100);
  assert.equal(completed.name, 'demo-cube');
  assert.equal(completed.swapsDone, completed.swapsTotal);
  assert.equal(completed.currentLayer, completed.totalLayers);
  assert.equal(completed.completedAt, Math.floor(clock.now() / 1000));

  clock.advanceSec(30);
  const later = await stateOf(engine);
  assert.equal(later.completedJob.completedAt, completed.completedAt,
    'the finish time must not be re-dated by a later poll');
});

// ---- integration with the real cloud modules ---------------------------------
// Same engine, but connect-auth.mjs, mqtt.mjs and connect-live.mjs are the real
// implementations. The only fakes are a WebSocket that speaks MQTT bytes and a
// fetch that answers the two account.prusa3d.com endpoints, so nothing leaves
// the process. Skipped while any of the three modules is absent.

const hasCloudModules = ['mqtt.mjs', 'connect-auth.mjs', 'connect-live.mjs'].every(hasFile);
const integrationTest = hasEngineDeps && hasCloudModules ? test : test.skip;

const encoder = new TextEncoder();

function remainingLength(value) {
  const out = [];
  let left = value;
  do {
    let byte = left % 128;
    left = Math.floor(left / 128);
    if (left > 0) byte |= 0x80;
    out.push(byte);
  } while (left > 0);
  return out;
}

function brokerPacket(type, flags, body) {
  return new Uint8Array([(type << 4) | flags, ...remainingLength(body.length), ...body]);
}

const CONNACK_ACCEPTED = brokerPacket(2, 0, [0, 0]);
const suback = (packetId) => brokerPacket(9, 0, [packetId >> 8, packetId & 0xff, 0]);

function publishPacket(topic, payload) {
  const name = [...encoder.encode(topic)];
  const body = [...encoder.encode(payload)];
  return brokerPacket(3, 1, [name.length >> 8, name.length & 0xff, ...name, ...body]);
}

function fakeSocketClass(instances) {
  return class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.sent = [];
      this.readyState = 1;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      instances.push(this);
    }

    send(bytes) { this.sent.push(new Uint8Array(bytes)); }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000 });
    }

    fireOpen() { if (this.onopen) this.onopen(); }

    deliver(bytes) { if (this.onmessage) this.onmessage({ data: bytes }); }
  };
}

integrationTest('the real MQTT, auth, and topic modules drive cloud mode end to end', async () => {
  const { createEngine } = await import('../pages/app/state-engine.mjs');
  const { createConnectAuth } = await import('../pages/app/connect-auth.mjs');
  const { createMqttClient } = await import('../pages/app/mqtt.mjs');
  const { createConnectState } = await import('../pages/app/connect-live.mjs');

  const clock = makeClock();
  const timers = fakeTimers(clock);
  const storage = memStorage();
  const sockets = [];
  const FakeWebSocket = fakeSocketClass(sockets);
  const ACCOUNT_EMAIL = 'someone@example.invalid';
  const ACCOUNT_NAME = 'Someone Example';
  const calls = [];

  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url) === 'https://account.prusa3d.com/o/token/') {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), FAKE_REFRESH_TOKEN);
      assert.equal(form.get('client_id'), 'MRHTlZhZqkNrrQ6FUPtjyusAz8nc59ErHXP8XkS4');
      return new Response(JSON.stringify({
        access_token: 'access-abc',
        expires_in: 7200,
        refresh_token: 'rotated-refresh-token',
        scope: 'basic_info user_operations email_lists openid connect',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url) === 'https://account.prusa3d.com/api/v1/me') {
      assert.equal(init.headers.Authorization, 'Bearer access-abc');
      return new Response(JSON.stringify({
        id: 424242, email: ACCOUNT_EMAIL, name: ACCOUNT_NAME,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected request: ' + url);
  };

  const engine = createEngine({
    now: clock.now,
    storage,
    fetchImpl,
    authFactory: async (config) => createConnectAuth({
      ...config,
      broadcast: null, // no BroadcastChannel in the test process
      // Real timers on purpose: the cross-tab lock confirms itself after a
      // 40 ms recheck, so a hand-driven queue would deadlock the refresh.
      // Nothing here waits on I/O, only on those short local delays.
      timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
      lockHeartbeatMs: 3600000,
    }),
    mqttFactory: async (config) => createMqttClient({
      ...config,
      WebSocketImpl: FakeWebSocket,
      // Keepalive is exercised in the MQTT module's own tests; no live pings here.
      timers: { setTimeout: () => null, clearTimeout: () => {} },
    }),
    connectStateFactory: () => createConnectState({ now: clock.now }),
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
    clientIdFactory: () => 'lr-static-integration',
  });

  await engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID });
  assert.deepEqual(calls, [
    'https://account.prusa3d.com/o/token/',
    'https://account.prusa3d.com/api/v1/me',
  ]);

  const socket = sockets[0];
  assert.ok(socket, 'the client must open a WebSocket');
  assert.equal(socket.url, 'wss://mqtt.prusa3d.com:8084/mqtt');
  assert.equal(socket.protocols, 'mqtt');

  socket.fireOpen();
  const connectPacket = Buffer.from(socket.sent[0]);
  assert.equal(connectPacket[0] >> 4, 1, 'the first packet is CONNECT');
  assert.ok(connectPacket.includes(Buffer.from('424242')), 'username is the numeric user id');
  assert.ok(connectPacket.includes(Buffer.from('access-abc')), 'password is the access token');

  socket.deliver(CONNACK_ACCEPTED);
  const subscribePacket = Buffer.from(socket.sent[1]);
  assert.equal(subscribePacket[0] >> 4, 8, 'CONNACK is followed by SUBSCRIBE');
  assert.ok(subscribePacket.includes(Buffer.from('v1/devices/printers/' + PRINTER_ID + '/#')));
  socket.deliver(suback(1));

  for (const [topic, payload] of RETAINED) {
    socket.deliver(publishPacket(TOPIC_ROOT + topic, payload));
  }
  await engine.loadFile(demoBytes(), 'demo-cube.gcode');

  const state = await stateOf(engine);
  for (const field of OVERLAY_STATE_FIELDS) {
    assert.ok(field in state, 'missing /api/state field: ' + field);
  }
  assert.equal(state.state, 'PRINTING');
  assert.equal(state.online, true);
  assert.equal(state.staleSec, 0);
  assert.equal(state.progress, 50);
  assert.equal(state.timeRemainingSec, 3600);
  assert.equal(state.toolLabel, 3);
  assert.equal(state.currentTool, 2);
  assert.equal(state.material, 'PLA');
  assert.equal(state.axisZ, 1.19);
  assert.equal(state.nozzleTemp, 225.1);
  assert.equal(state.bedTarget, 60);
  assert.equal(state.chamberTemp, 30.8);
  assert.equal(state.name, 'demo-cube');
  assert.equal(state.currentLayer, 4);
  assert.equal(state.totalLayers, 5);
  assert.equal(state.swapsDone, 2);
  assert.equal(state.swapsTotal, 3);
  assert.equal(state.nextToolLabel, 1);
  assert.equal(state.nextSwapInSec, 1440);
  assert.equal(state.filamentG, 87);
  assert.equal(state.camera.enabled, false);
  assert.equal(engine.getStatus().cloud.phase, 'live');

  // The rotated token replaced the spent one, and no account identity was
  // written anywhere in browser storage.
  const stored = storage.dump();
  assert.ok(stored.includes('rotated-refresh-token'), 'the rotated token must be persisted');
  assert.ok(!stored.includes(FAKE_REFRESH_TOKEN), 'the spent token must be replaced');
  assert.ok(!stored.includes(ACCOUNT_EMAIL), 'the account email must never be stored');
  assert.ok(!stored.includes(ACCOUNT_NAME), 'the account name must never be stored');
  assert.ok(!JSON.stringify(state).includes('rotated-refresh-token'),
    '/api/state must never carry the refresh token');

  // A dead socket is reported as offline and reconnects on the 2s backoff.
  socket.close();
  const dropped = await stateOf(engine);
  assert.equal(dropped.online, false);
  assert.deepEqual(timers.delays(), [2000]);
  engine.stopCloud();
});

engineTest('one fault advances the backoff exactly one step', async () => {
  // The real client emits `error` then `close` for a single fault, and closing
  // it from the failure path emits `close` again. All three must count once.
  const mqtt = fakeMqtt();
  const noisyFactory = async (config) => {
    const client = await mqtt.factory(config);
    const plainClose = client.close;
    client.close = function () {
      plainClose.call(client);
      client.emit('close', { reason: 'local', code: null });
    };
    return client;
  };
  const { engine, timers } = await cloudHarness({ mqttFactory: noisyFactory });
  await engine.setModeCloud({ refreshToken: FAKE_REFRESH_TOKEN, printerUuid: PRINTER_ID });
  const first = mqtt.last();
  bringLive(first);

  first.emit('error', new Error('socket died'));
  first.emit('close', { reason: 'socket', code: 1006 });
  assert.deepEqual(timers.delays(), [2000], 'a single fault must not skip backoff steps');
  assert.equal(engine.getStatus().cloud.attempt, 1);

  await timers.run();
  const second = mqtt.last();
  assert.notEqual(second, first);
  second.emit('error', new Error('socket died again'));
  second.emit('close', { reason: 'socket', code: 1006 });
  assert.deepEqual(timers.delays(), [4000]);
  assert.equal(engine.getStatus().cloud.attempt, 2);
  engine.stopCloud();
});
