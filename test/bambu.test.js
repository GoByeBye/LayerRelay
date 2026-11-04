'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('bun:test');
const { BambuClient, mapBambuToState, MAX_REPORT_BYTES } = require('../bambu.js');

const config = { printerHost: 'printer.local', bambuSerial: 'TESTSERIAL', bambuAccessCode: 'test-secret-code' };

function fixture() {
  const mqtt = new EventEmitter();
  mqtt.connected = true;
  mqtt.subscriptions = [];
  mqtt.publishes = [];
  mqtt.subscribe = (topic, options, callback) => {
    mqtt.subscriptions.push({ topic, options });
    callback(null, [{ topic, qos: 0 }]);
  };
  mqtt.publish = (topic, payload, options, callback) => {
    mqtt.publishes.push({ topic, payload: JSON.parse(payload), options });
    callback(null);
  };
  mqtt.end = () => { mqtt.ended = true; };
  let connectionOptions;
  const client = new BambuClient(config, { connect(options) { connectionOptions = options; return mqtt; }, now: () => 123456 });
  const telemetry = [];
  const errors = [];
  let offline = 0;
  client.on('telemetry', (value) => telemetry.push(value));
  client.on('error', (value) => errors.push(value.message));
  client.on('offline', () => { offline++; });
  client.start();
  function report(value, topic = 'device/TESTSERIAL/report') {
    mqtt.emit('message', topic, Buffer.from(JSON.stringify({ print: value })));
  }
  return { client, mqtt, telemetry, errors, report, connectionOptions, offline: () => offline };
}

test('Bambu LAN uses one TLS MQTT connection and telemetry snapshot request per connect', () => {
  const f = fixture();
  assert.equal(f.connectionOptions.protocol, 'mqtts');
  assert.equal(f.connectionOptions.host, 'printer.local');
  assert.equal(f.connectionOptions.port, 8883);
  assert.equal(f.connectionOptions.username, 'bblp');
  assert.equal(f.connectionOptions.password, config.bambuAccessCode);
  assert.equal(f.connectionOptions.rejectUnauthorized, false);
  assert.equal(f.connectionOptions.reconnectPeriod, 5000);
  f.client.start();
  f.mqtt.emit('connect');
  assert.deepEqual(f.mqtt.subscriptions, [{ topic: 'device/TESTSERIAL/report', options: { qos: 0 } }]);
  assert.deepEqual(f.mqtt.publishes, [{
    topic: 'device/TESTSERIAL/request',
    payload: { pushing: { sequence_id: '0', command: 'pushall', version: 1, push_target: 1 } },
    options: { qos: 0, retain: false },
  }]);
  f.report({ gcode_state: 'RUNNING', mc_percent: 12 });
  assert.equal(f.mqtt.publishes.length, 1);
});

test('maps Bambu temperatures, minutes, layers and percentage speed without inventing unsupported fields', () => {
  const mapped = mapBambuToState({
    gcode_state: 'RUNNING', subtask_name: 'Test part.3mf', gcode_file: 'Metadata/plate_1.gcode',
    job_id: '12', mc_percent: 0, mc_remaining_time: 2.5, layer_num: 0, total_layer_num: 128,
    nozzle_temper: 211.5, nozzle_target_temper: 215, bed_temper: 61, bed_target_temper: 65,
    chamber_temper: 35, ctt: 40, spd_mag: 100, heatbreak_fan_speed: '15', cooling_fan_speed: '15',
  }, { serial: 'TEST' });
  assert.equal(mapped.state, 'PRINTING');
  assert.equal(mapped.name, 'Test part');
  assert.equal(mapped.progress, 0);
  assert.equal(mapped.timeRemainingSec, 150);
  assert.equal(mapped.currentLayer, 0);
  assert.equal(mapped.totalLayers, 128);
  assert.equal(mapped.nozzleTemp, 211.5);
  assert.equal(mapped.nozzleTarget, 215);
  assert.equal(mapped.bedTemp, 61);
  assert.equal(mapped.bedTarget, 65);
  assert.equal(mapped.chamberTemp, 35);
  assert.equal(mapped.chamberTarget, 40);
  assert.equal(mapped.speed, 100);
  assert.equal(mapped.jobKey, 'bambu:TEST::12');
  for (const key of ['flow', 'axisZ', 'fanHotend', 'fanPrint', 'thumbnailUrl',
    'swapsDone', 'swapsTotal', 'wasteDone', 'filamentG', 'timeElapsedSec']) assert.equal(mapped[key], null);
});

test('Bambu lifecycle states do not turn unknown activity into an idle completion', () => {
  const expected = { RUNNING: 'PRINTING', PAUSE: 'PAUSED', PREPARE: 'PRINTING',
    FINISH: 'FINISHED', FAILED: 'ERROR', IDLE: 'IDLE', SOMETHING_NEW: 'UNKNOWN' };
  for (const [raw, normalized] of Object.entries(expected)) {
    const mapped = mapBambuToState({ gcode_state: raw, mc_percent: 40, mc_remaining_time: 5 });
    assert.equal(mapped.state, normalized);
    if (raw === 'IDLE' || raw === 'SOMETHING_NEW') {
      assert.equal(mapped.progress, null);
      assert.equal(mapped.timeRemainingSec, null);
      assert.equal(mapped.jobKey, null);
    }
  }
});

test('Bambu AMS identity is independent of physical presence and active tray sentinels', () => {
  const print = {
    gcode_state: 'RUNNING', ams: { tray_now: '4', ams_exist_bits: '3', tray_exist_bits: '11', ams: [
      { id: '0', tray: [{ id: '0', tray_type: 'PLA', tray_color: '112233FF' },
        { id: '1', tray_type: 'OLD', tray_color: 'FF00FFFF' }] },
      { id: '1', tray: [{ id: '0', tray_type: 'PETG', tray_color: 'ABCDEF00' }] },
    ] },
  };
  const mapped = mapBambuToState(print);
  assert.equal(mapped.currentTool, 4);
  assert.equal(mapped.toolLabel, 5);
  assert.equal(mapped.material, 'PETG');
  assert.equal(mapped.toolInventory.toolCount, 8);
  assert.equal(mapped.toolInventory.toolSlots[0].loaded, true);
  assert.equal(mapped.toolInventory.toolSlots[0].color, '#112233');
  assert.equal(mapped.toolInventory.toolSlots[1].loaded, false);
  assert.equal(mapped.toolInventory.toolSlots[1].material, null);
  assert.equal(mapped.toolInventory.toolSlots[1].color, null);
  print.ams.tray_now = '255';
  assert.equal(mapBambuToState(print).currentTool, null);
  print.ams.tray_now = '254';
  print.vt_tray = { tray_type: 'ASA' };
  assert.equal(mapBambuToState(print).currentTool, null);
  assert.equal(mapBambuToState(print).material, 'ASA');
});

test('merges sparse fields while differential AMS arrays replace prior tray metadata', () => {
  const f = fixture();
  f.mqtt.emit('connect');
  f.report({ msg: 0, gcode_state: 'RUNNING', subtask_name: 'one', job_id: 1,
    mc_percent: 10, nozzle_temper: 220, ams: { tray_now: '0', ams_exist_bits: '1', tray_exist_bits: '1',
      ams: [{ id: '0', tray: [{ id: '0', tray_type: 'PLA', tray_color: '123456FF' }] }] } });
  const key = f.telemetry.at(-1).jobKey;
  f.report({ msg: 1, mc_percent: 11, ams: { ams: [{ id: '0', tray: [{ id: '0', tray_type: 'PETG' }] }] } });
  assert.equal(f.telemetry.at(-1).state, 'PRINTING');
  assert.equal(f.telemetry.at(-1).nozzleTemp, 220);
  assert.equal(f.telemetry.at(-1).progress, 11);
  assert.equal(f.telemetry.at(-1).material, 'PETG');
  assert.equal(f.telemetry.at(-1).toolInventory.toolSlots[0].color, null);
  assert.equal(f.telemetry.at(-1).jobKey, key);
  f.report({ nozzle_temper: 221 });
  assert.equal(f.telemetry.at(-1).progress, 11);
  assert.equal(f.telemetry.at(-1).nozzleTemp, 221);
  f.report({ msg: 1, ams: { ams: [{ id: '0', tray: [{ id: '0' }] }] } });
  assert.equal(f.telemetry.at(-1).material, null);
  assert.equal(f.telemetry.at(-1).toolInventory.toolSlots[0].loaded, true);
  assert.equal(f.telemetry.at(-1).toolInventory.toolSlots[0].material, null);
  assert.equal(f.telemetry.at(-1).toolInventory.toolSlots[0].color, null);
  f.report({ msg: 1, ams: { ams: [] } });
  assert.equal(f.telemetry.at(-1).toolInventory, null);
});

test('full reports and reconnects clear stale fields and wait for a new state baseline', () => {
  const f = fixture();
  f.mqtt.emit('connect');
  f.report({ gcode_state: 'RUNNING', job_id: 12, mc_percent: 70, nozzle_temper: 220 });
  const key = f.telemetry.at(-1).jobKey;
  f.report({ msg: 0, gcode_state: 'RUNNING', job_id: 12, mc_percent: 71 });
  assert.equal(f.telemetry.at(-1).nozzleTemp, null);
  f.mqtt.emit('connect');
  f.report({ nozzle_temper: 223 });
  assert.equal(f.telemetry.length, 2);
  f.report({ gcode_state: 'RUNNING', job_id: 12 });
  assert.equal(f.telemetry.at(-1).progress, null);
  assert.equal(f.telemetry.at(-1).nozzleTemp, 223);
  assert.equal(f.telemetry.at(-1).jobKey, key);
  assert.equal(f.mqtt.publishes.length, 2);
});

test('new jobs clear previous identity, name, layer and progress while retaining temperatures', () => {
  const f = fixture();
  f.report({ gcode_state: 'RUNNING', job_id: 1, subtask_name: 'old', mc_percent: 90,
    layer_num: 90, total_layer_num: 100, nozzle_temper: 220 });
  const firstKey = f.telemetry.at(-1).jobKey;
  f.report({ job_id: 2 });
  const mapped = f.telemetry.at(-1);
  assert.equal(mapped.state, 'PRINTING');
  assert.notEqual(mapped.jobKey, firstKey);
  assert.equal(mapped.name, '');
  assert.equal(mapped.progress, null);
  assert.equal(mapped.currentLayer, null);
  assert.equal(mapped.totalLayers, null);
  assert.equal(mapped.nozzleTemp, 220);
});

test('repeated local files have separate run keys and a key stays stable through pause and finish', () => {
  const f = fixture();
  f.report({ gcode_state: 'RUNNING', job_id: '0', subtask_id: '0', gcode_file: 'plate_1.gcode' });
  const firstKey = f.telemetry.at(-1).jobKey;
  f.report({ gcode_state: 'PAUSE' });
  assert.equal(f.telemetry.at(-1).jobKey, firstKey);
  f.report({ gcode_state: 'FINISH', mc_percent: 100 });
  assert.equal(f.telemetry.at(-1).jobKey, firstKey);
  f.report({ gcode_state: 'IDLE' });
  assert.equal(f.telemetry.at(-1).jobKey, null);
  f.report({ gcode_state: 'PREPARE', gcode_file: 'plate_1.gcode' });
  assert.notEqual(f.telemetry.at(-1).jobKey, firstKey);
  assert.equal(f.telemetry.at(-1).progress, null);
});

test('ignores malformed, unrelated, oversized reports and command acknowledgements', () => {
  const f = fixture();
  f.mqtt.emit('message', 'device/TESTSERIAL/report', Buffer.from('{secret invalid json'));
  f.mqtt.emit('message', 'device/TESTSERIAL/report', Buffer.alloc(MAX_REPORT_BYTES + 1));
  f.report({ gcode_state: 'RUNNING' }, 'device/ANOTHER/report');
  f.report({ command: 'pushall', result: 'success' });
  f.report({ mc_percent: 5 });
  assert.equal(f.telemetry.length, 0);
  assert.deepEqual(f.errors, []);
  f.report({ gcode_state: 'RUNNING', nozzle_temper: { valueOf: 0, toString: 0 } });
  assert.equal(f.telemetry.at(-1).nozzleTemp, null);
});

test('reports do not pollute object prototypes or retain arbitrarily deep metadata', () => {
  const f = fixture();
  const payload = '{"print":{"gcode_state":"IDLE","__proto__":{"polluted":true},"ams":{"__proto__":{"polluted":true}}}}';
  f.mqtt.emit('message', 'device/TESTSERIAL/report', Buffer.from(payload));
  assert.equal({}.polluted, undefined);
  assert.equal(f.telemetry.at(-1).state, 'IDLE');
  let deep = {};
  for (let i = 0; i < 100; i++) deep = { deep };
  f.report({ ams: deep });
  assert.equal(f.telemetry.at(-1).state, 'IDLE');
  assert.deepEqual(f.client.report.ams, {});
  for (let i = 0; i < 50; i++) f.report({ device: { [`unused-${i}`]: { data: 'ignored' } } });
  assert.deepEqual(f.client.report.device, {});
});

test('MQTT failures are credential safe and close cancels reconnect and late events', () => {
  const f = fixture();
  f.mqtt.emit('error', new Error(`mqtts://${config.printerHost} password=${config.bambuAccessCode}`));
  assert.deepEqual(f.errors, ['Bambu LAN telemetry connection failed']);
  assert.equal(f.offline(), 1);
  f.mqtt.emit('offline');
  f.mqtt.emit('close');
  assert.equal(f.offline(), 3);
  f.client.close();
  f.client.close();
  assert.equal(f.mqtt.ended, true);
  f.mqtt.emit('connect');
  f.mqtt.emit('error', new Error(config.bambuAccessCode));
  f.report({ gcode_state: 'RUNNING' });
  assert.equal(f.telemetry.length, 0);
  assert.equal(f.offline(), 3);
  assert.equal(f.mqtt.subscriptions.length, 0);
});

test('rejected subscriptions never publish and stale subscription callbacks are ignored', () => {
  const f = fixture();
  const callbacks = [];
  let destroyed = 0;
  f.mqtt.stream = { destroy() { destroyed++; } };
  f.mqtt.subscribe = (_topic, _options, callback) => callbacks.push(callback);
  f.mqtt.emit('connect');
  f.mqtt.emit('connect');
  callbacks[0](null, [{ topic: 'device/TESTSERIAL/report', qos: 0 }]);
  assert.equal(f.mqtt.publishes.length, 0);
  callbacks[1](null, [{ topic: 'device/TESTSERIAL/report', qos: 128 }]);
  assert.equal(f.mqtt.publishes.length, 0);
  assert.equal(f.errors.length, 1);
  assert.equal(destroyed, 1);
});

test('full AMS detach clears detected inventory and explicit null clears external spool material', () => {
  const f = fixture();
  f.report({ msg: 0, gcode_state: 'RUNNING', ams: { tray_now: '0', ams_exist_bits: '1', tray_exist_bits: '1',
    ams: [{ id: '0', tray: [{ id: '0', tray_type: 'PLA', tray_color: '123456FF' }] }] } });
  assert.equal(f.telemetry.at(-1).toolInventory.toolCount, 4);
  f.report({ msg: 0, gcode_state: 'IDLE', ams: { tray_now: '255', ams_exist_bits: '0', ams: [] } });
  assert.equal(f.telemetry.at(-1).toolInventory, null);
  assert.equal(f.telemetry.at(-1).material, null);
  f.report({ ams: { tray_now: '254' }, vt_tray: { tray_type: 'ASA' } });
  assert.equal(f.telemetry.at(-1).material, 'ASA');
  f.report({ vt_tray: null });
  assert.equal(f.telemetry.at(-1).material, null);
});

test('maps modern packed bed and chamber temperatures without claiming multi-nozzle support', () => {
  const mapped = mapBambuToState({ gcode_state: 'IDLE', device: {
    bed_temp: (70 << 16) | 65,
    ctc: { info: { temp: (45 << 16) | 39 } },
    extruder: { info: [{ id: 0, temp: (220 << 16) | 200 }] },
  } });
  assert.equal(mapped.bedTemp, 65);
  assert.equal(mapped.bedTarget, 70);
  assert.equal(mapped.chamberTemp, 39);
  assert.equal(mapped.chamberTarget, 45);
  assert.equal(mapped.nozzleTemp, null);
});
