'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { onTestFinished, test } = require('bun:test');

const rootDir = path.resolve(__dirname, '..');
const serial = 'EXAMPLE123456';
const accessCode = 'SECRET_TEST_LAN_CODE';

async function waitFor(read, accept, description) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) { lastError = error; }
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${description}: ${lastError?.message || 'condition not met'}`);
}

function fixtureDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-bambu-server-'));
  onTestFinished(() => {
    try { fs.rmSync(directory, { recursive: true, force: true }); }
    catch { /* Windows may briefly retain child-process file handles. */ }
  });
  return directory;
}

function seedIndex(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'openprinttag-materials-v1.json'), JSON.stringify({
    version: 1, checkedAt: Date.now(),
    materials: Array.from({ length: 100 }, (_, index) => ({
      brandSlug: 'example', slug: `material-${index}`, brand: 'Example',
      type: 'PLA', name: `Test ${index}`, color: null,
    })),
  }));
}

async function startServer(directory) {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  const preloadPath = path.join(directory, 'mock-mqtt.cjs');
  // Only the child mocks these modules, leaving the actual Bambu adapter,
  // Express routes, inventory resolver and persistence code under test.
  fs.writeFileSync(preloadPath, `
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mock } = require('bun:test');
const readline = require('node:readline');
mock.module(${JSON.stringify(path.join(rootDir, 'digest.js'))}, () => ({
  digestGet() { throw new Error('UNEXPECTED_PRUSALINK_READ'); },
  digestGetJson() { throw new Error('UNEXPECTED_PRUSALINK_READ'); },
}));
mock.module(${JSON.stringify(require.resolve('mqtt'))}, () => ({ connect(options) {
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.protocol, 'mqtts');
  assert.equal(options.port, 8883);
  assert.equal(options.username, 'bblp');
  assert.equal(options.password, ${JSON.stringify(accessCode)});
  const client = new EventEmitter();
  client.connected = true;
  client.subscribe = (topic, options, callback) => {
    assert.equal(topic, 'device/${serial}/report');
    callback(null, [{ topic, qos: 0 }]);
  };
  client.publish = (topic, payload, options, callback) => {
    assert.equal(topic, 'device/${serial}/request');
    assert.equal(JSON.parse(payload).pushing.command, 'pushall');
    assert.equal(options.retain, false);
    callback(null);
    console.log('MOCK_MQTT_READY');
  };
  client.end = () => { console.log('MOCK_MQTT_ENDED'); };
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const command = JSON.parse(line);
    if (command.event === 'shutdown') process.emit('SIGTERM');
    else if (command.event === 'error') client.emit('error', new Error(${JSON.stringify(accessCode)}));
    else if (command.event) client.emit(command.event);
    else client.emit('message', 'device/${serial}/report', Buffer.from(line));
  });
  setImmediate(() => client.emit('connect'));
  return client;
} }));
`);
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    printerType: 'bambu', printerHost: '127.0.0.1', bambuSerial: serial, bambuAccessCode: accessCode,
    // Complete Prusa credentials must remain inert when Bambu is selected.
    connectPrinterUuid: 'unused-prusa', connectRefreshToken: 'SECRET_UNUSED_CONNECT',
    useConnect: true,
  }));
  const child = spawn(process.execPath, ['--preload', preloadPath, 'server.js'], {
    cwd: rootDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CONFIG_PATH: configPath, DATA_DIR: path.join(directory, 'data'),
      LISTEN_HOST: '127.0.0.1', PORT: String(port),
      CAMERA_STREAM_ENABLED: 'false', NOZZLE_STREAM_ENABLED: 'false' },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  onTestFinished(async () => {
    if (child.exitCode == null) child.kill();
    await exited;
  });
  const url = `http://127.0.0.1:${port}`;
  const json = async (endpoint = '/api/state') => {
    const response = await fetch(`${url}${endpoint}`, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  await waitFor(async () => {
    if (child.exitCode != null) throw new Error(output);
    return (await json('/healthz')).ok && output.includes('MOCK_MQTT_READY');
  }, Boolean, 'server and MQTT subscription');
  return {
    json, output: () => output,
    send(command) { child.stdin.write(`${JSON.stringify(command)}\n`); },
    async stop() {
      child.stdin.write('{"event":"shutdown"}\n');
      assert.equal(await exited, 0, output);
      assert.match(output, /MOCK_MQTT_ENDED/);
    },
  };
}

test('Bambu server relays MQTT telemetry, AMS inventory, completion and persisted offline state', async () => {
  const directory = fixtureDirectory();
  const dataDir = path.join(directory, 'data');
  const bambuData = path.join(dataDir, `bambu-${crypto.createHash('sha256').update(serial).digest('hex').slice(0, 16)}`);
  seedIndex(bambuData);
  // Switching printer types must not restore a previous Prusa print.
  fs.writeFileSync(path.join(dataDir, 'laststate.json'), JSON.stringify({ state: {
    state: 'PRINTING', name: 'Previous Prusa print', jobKey: 'old-prusa-job',
  }, lastGoodAt: 123 }));
  const server = await startServer(directory);
  let state = await server.json();
  assert.equal(state.printerType, 'bambu');
  assert.equal(state.state, 'UNKNOWN');
  assert.equal(state.online, false);
  assert.equal(state.completedJob, null);

  server.send({ print: {
    msg: 0, gcode_state: 'RUNNING', subtask_name: 'Test vase.3mf', gcode_file: 'plate_1.gcode',
    task_id: '42', mc_percent: 25, mc_remaining_time: 15,
    nozzle_temper: 215, nozzle_target_temper: 220, bed_temper: 60, bed_target_temper: 60,
    layer_num: 12, total_layer_num: 48,
    ams: { ams_exist_bits: '1', tray_exist_bits: '3', tray_now: '1', ams: [{ id: '0', tray: [
      { id: '0', tray_type: 'PLA', tray_color: 'FF8800FF' },
      { id: '1', tray_type: 'PETG', tray_color: '112233FF' },
    ] }] },
  } });
  state = await waitFor(server.json, (value) => value.online && value.progress === 25, 'live print');
  const jobKey = state.jobKey;
  assert.equal(state.state, 'PRINTING');
  assert.equal(state.name, 'Test vase');
  assert.equal(state.timeRemainingSec, 900);
  assert.equal(state.currentLayer, 12);
  assert.equal(state.totalLayers, 48);
  assert.equal(state.nozzleTemp, 215);
  assert.equal(state.toolCount, 4);
  assert.equal(state.toolCountSource, 'bambu');
  assert.equal(state.toolLabel, 2);
  assert.equal(state.material, 'PETG');
  assert.equal(state.toolSlots[1].color, '#112233');
  assert.equal(state.toolSlots[1].sources.material, 'bambu');
  assert.equal(state.toolSettings.detected.source, 'bambu');
  assert.equal(state.toolSettings.detected.status, 'fresh');
  assert.equal(state.thumbnailUrl, null);

  server.send({ print: { mc_percent: 50, layer_num: 24 } });
  state = await waitFor(server.json, (value) => value.progress === 50, 'partial telemetry');
  assert.equal(state.jobKey, jobKey);
  assert.equal(state.nozzleTemp, 215);
  assert.equal(state.material, 'PETG');
  server.send({ event: 'error' });
  state = await waitFor(server.json, (value) => !value.online, 'offline state');
  assert.equal(state.progress, 50);
  assert.equal(state.toolSettings.detected.status, 'stale');

  // A full terminal report may omit the job's previous name/material/layer total.
  server.send({ print: { msg: 0, gcode_state: 'FINISH', mc_percent: 100, mc_remaining_time: 0, layer_num: 48 } });
  state = await waitFor(server.json, (value) => value.completedJob?.finalState === 'FINISHED', 'completed print');
  assert.equal(state.completedJob.jobKey, jobKey);
  assert.equal(state.completedJob.name, 'Test vase');
  assert.equal(state.completedJob.progress, 100);
  assert.equal(state.completedJob.currentLayer, 48);
  assert.equal(state.completedJob.totalLayers, 48);
  assert.equal(state.completedJob.material, 'PETG');
  assert.equal(fs.existsSync(path.join(bambuData, 'completed-job.json')), true);
  assert.doesNotMatch(JSON.stringify(state), /SECRET_TEST_LAN_CODE|SECRET_UNUSED_CONNECT/);
  assert.doesNotMatch(server.output(), /SECRET_TEST_LAN_CODE|SECRET_UNUSED_CONNECT|UNEXPECTED_PRUSALINK_READ|\[connect\]/);
  await server.stop();

  const restarted = await startServer(directory);
  const restored = await restarted.json();
  assert.equal(restored.state, 'FINISHED');
  assert.equal(restored.online, false);
  assert.equal(restored.completedJob.jobKey, jobKey);
  assert.equal(restored.completedJob.progress, 100);
  assert.equal(restored.completedJob.currentLayer, 48);
  assert.equal(restored.toolSettings.detected.status, 'unavailable');
  await restarted.stop();
}, 30000);
