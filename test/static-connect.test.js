'use strict';
// Tests for the static build's Prusa Connect telemetry mapping
// (pages/app/connect-live.mjs): every MQTT topic the printer tree publishes,
// turned into the /api/state field names the overlay reads.
//
// Payloads are copied from a real capture of the retained topic tree. No test
// opens a network connection, contacts a broker, or touches a printer: the
// module is pure and every value is injected by hand.

const assert = require('node:assert/strict');
const { test } = require('bun:test');

const MODULE = '../pages/app/connect-live.mjs';
const PREFIX = 'v1/devices/printers/00000000-0000-4000-8000-000000000000/';

function makeClock(startMs = 1700000000000) {
  let current = startMs;
  return {
    now: () => current,
    advanceSec: (sec) => { current += sec * 1000; },
  };
}

// The full retained tree as captured, plus the two per-tool nozzle rows that
// only appear around a toolchange. job-progress and the job's own progress are
// deliberately different here so each assertion proves which topic fed it.
const RETAINED_TREE = [
  ['data/state', 'PRINTING'],
  ['data/online', '1'],
  ['data/job-progress', '12'],
  ['data/current-job', '650'],
  ['data/material', 'PLA'],
  ['data/axis-z', '1.19'],
  ['data/tools/active', '3'],
  ['data/tools/3/temp/nozzle/current', '158.8'],
  ['data/tools/3/temp/nozzle/target', '100.0'],
  ['data/temp/nozzle/current', '225.1'],
  ['data/temp/nozzle/target', '225.0'],
  ['data/temp/heatbed/current', '59.7'],
  ['data/temp/heatbed/target', '60.0'],
  ['data/temp/chamber/current', '30.8'],
  ['dialog', '{"id": 405205626, "code": null, "text": null, "title": null, "buttons": null, "key": null}'],
  ['jobs/650/data/progress', '13'],
  ['jobs/650/data/state', 'PRINTING'],
  ['jobs/650/data/time-remaining', '540'],
];

async function loadModule() {
  return import(MODULE);
}

function applyAll(state, entries) {
  const results = [];
  for (const [topic, payload] of entries) results.push(state.apply(topic, payload));
  return results;
}

test('every retained topic maps to its /api/state field with the right type', async () => {
  const { createConnectState } = await loadModule();
  const clock = makeClock();
  const state = createConnectState({ now: clock.now });

  const applied = applyAll(state, RETAINED_TREE);
  assert.deepEqual(applied, RETAINED_TREE.map(() => true),
    'every captured topic must be recognized');

  const snap = state.snapshot();

  assert.equal(snap.state, 'PRINTING');
  assert.equal(typeof snap.state, 'string');

  assert.equal(snap.online, true);
  assert.equal(typeof snap.online, 'boolean');

  // The current job's own progress wins over the printer-level percentage.
  assert.equal(snap.progress, 13);
  assert.equal(typeof snap.progress, 'number');

  assert.equal(snap.jobId, 650);
  assert.equal(typeof snap.jobId, 'number');
  assert.equal(state.jobId, 650);
  assert.equal(snap.jobState, 'PRINTING');

  // time-remaining is SECONDS on the wire and stays seconds in the snapshot.
  assert.equal(snap.timeRemainingSec, 540);
  assert.equal(typeof snap.timeRemainingSec, 'number');

  assert.equal(snap.material, 'PLA');
  assert.equal(typeof snap.material, 'string');

  assert.equal(snap.axisZ, 1.19);
  assert.equal(typeof snap.axisZ, 'number');

  // data/tools/active is 1-based on the wire.
  assert.equal(snap.toolLabel, 3);
  assert.equal(snap.currentTool, 2);

  assert.equal(snap.nozzleTemp, 225.1);
  assert.equal(snap.nozzleTarget, 225);
  assert.equal(snap.bedTemp, 59.7);
  assert.equal(snap.bedTarget, 60);
  assert.equal(snap.chamberTemp, 30.8);
  // No chamber target exists anywhere in the tree.
  assert.equal(snap.chamberTarget, null);

  // Every wire payload is text. A field that reached the overlay as a string
  // would still render, so the type is asserted alongside the value.
  for (const field of ['nozzleTemp', 'nozzleTarget', 'bedTemp', 'bedTarget',
    'chamberTemp', 'toolLabel', 'currentTool']) {
    assert.equal(typeof snap[field], 'number', `${field} must be a number`);
  }

  // Per-tool nozzle temps are keyed by the raw topic segment.
  assert.deepEqual(snap.toolTemps, { 3: { nozzleTemp: 158.8, nozzleTarget: 100 } });

  // A dialog whose text and title are both null is not an activity.
  assert.equal(snap.activity, null);

  // Fields with no MQTT source stay null; the engine fills what it can from a
  // decoded file.
  for (const field of ['name', 'thumbnailUrl', 'speed', 'flow', 'fanHotend',
    'timeElapsedSec', 'filamentG']) {
    assert.equal(snap[field], null, `${field} must have no MQTT source`);
  }

  assert.equal(snap.lastMessageAt, clock.now());
  assert.equal(snap.topicCount, RETAINED_TREE.length);
});

test('the full broker topic and the per-printer suffix are both accepted', async () => {
  const { createConnectState } = await loadModule();
  const state = createConnectState();

  assert.equal(state.apply(`${PREFIX}data/axis-z`, '4.5'), true);
  assert.equal(state.snapshot().axisZ, 4.5);
  assert.equal(state.apply('data/axis-z', '6.25'), true);
  assert.equal(state.snapshot().axisZ, 6.25);

  // A different printer's uuid still strips to the same suffix: the caller
  // subscribes to exactly one printer tree.
  assert.equal(state.apply('v1/devices/printers/other-uuid/data/axis-z', '7'), true);
  assert.equal(state.snapshot().axisZ, 7);

  // Unmapped topics are reported as not applied and change nothing.
  assert.equal(state.apply('data/unknown/thing', '9'), false);
  assert.equal(state.apply('', '9'), false);
  assert.equal(state.snapshot().axisZ, 7);
  assert.equal(state.snapshot().topicCount, 1);
});

test('data/tools/active converts the 1-based wire value to both tool fields', async () => {
  const { createConnectState } = await loadModule();
  const state = createConnectState();

  for (const [payload, toolLabel, currentTool] of [
    ['1', 1, 0],
    ['3', 3, 2],
    ['32', 32, 31],
  ]) {
    assert.equal(state.apply('data/tools/active', payload), true);
    const snap = state.snapshot();
    assert.equal(snap.toolLabel, toolLabel, `label for ${payload}`);
    assert.equal(snap.currentTool, currentTool, `index for ${payload}`);
  }

  // 0 means no active tool, matching prusaconnect.js numericActiveTool.
  assert.equal(state.apply('data/tools/active', '0'), true);
  assert.equal(state.snapshot().toolLabel, null);
  assert.equal(state.snapshot().currentTool, null);

  // Out of range and non-integer payloads are refused outright rather than
  // producing an impossible tool index.
  assert.equal(state.apply('data/tools/active', '2'), true);
  for (const bad of ['33', '999', '-1', '2.5', 'T2', '', '  ']) {
    assert.equal(state.apply('data/tools/active', bad), false, `must refuse ${bad}`);
    assert.equal(state.snapshot().toolLabel, 2, `label survives ${bad}`);
    assert.equal(state.snapshot().currentTool, 1, `index survives ${bad}`);
  }
});

test('job topics are selected by the current job id in either arrival order', async () => {
  const { createConnectState } = await loadModule();

  // Retained messages arrive in arbitrary order, so a job topic can land
  // before data/current-job names that job. The value must still surface once
  // the job id arrives.
  const early = createConnectState();
  early.apply('jobs/650/data/time-remaining', '540');
  early.apply('jobs/650/data/progress', '13');
  early.apply('jobs/650/data/state', 'PRINTING');
  assert.equal(early.snapshot().timeRemainingSec, null, 'no job id yet');
  assert.equal(early.snapshot().progress, null);
  assert.equal(early.apply('data/current-job', '650'), true);
  assert.equal(early.snapshot().timeRemainingSec, 540);
  assert.equal(early.snapshot().progress, 13);
  assert.equal(early.snapshot().jobState, 'PRINTING');

  // A previous job's retained values must never clobber the live job.
  const stale = createConnectState();
  stale.apply('data/current-job', '650');
  stale.apply('jobs/650/data/progress', '13');
  stale.apply('jobs/650/data/state', 'PRINTING');
  stale.apply('jobs/650/data/time-remaining', '540');
  assert.equal(stale.apply('jobs/649/data/progress', '100'), true,
    'the stale message is stored, just not read');
  stale.apply('jobs/649/data/state', 'FINISHED');
  stale.apply('jobs/649/data/time-remaining', '0');
  const held = stale.snapshot();
  assert.equal(held.progress, 13);
  assert.equal(held.jobState, 'PRINTING');
  assert.equal(held.timeRemainingSec, 540);

  // Switching to a job with no values yet must not leak the old job's clock.
  stale.apply('data/current-job', '651');
  const switched = stale.snapshot();
  assert.equal(switched.jobId, 651);
  assert.equal(switched.timeRemainingSec, null);
  assert.equal(switched.jobState, null);

  // Job ids are compared as strings: the topic segment and the payload are
  // both text, and a numeric comparison would discard everything.
  const text = createConnectState();
  text.apply('data/current-job', '0650');
  text.apply('jobs/650/data/time-remaining', '900');
  assert.equal(text.snapshot().timeRemainingSec, null);
  text.apply('jobs/0650/data/time-remaining', '450');
  assert.equal(text.snapshot().timeRemainingSec, 450);
});

test('progress falls back to data/job-progress without a job value', async () => {
  const { createConnectState } = await loadModule();
  const state = createConnectState();

  state.apply('data/job-progress', '11');
  assert.equal(state.snapshot().progress, 11);

  state.apply('data/current-job', '650');
  assert.equal(state.snapshot().progress, 11, 'still the printer-level value');

  state.apply('jobs/650/data/progress', '13');
  assert.equal(state.snapshot().progress, 13, 'the job value takes over');

  // Percentages are clamped to the range the overlay draws.
  state.apply('jobs/650/data/progress', '140');
  assert.equal(state.snapshot().progress, 100);
  state.apply('jobs/650/data/progress', '-5');
  assert.equal(state.snapshot().progress, 0);

  // A negative remaining time is clamped rather than rendered as a countdown
  // running backwards.
  state.apply('jobs/650/data/time-remaining', '-30');
  assert.equal(state.snapshot().timeRemainingSec, 0);
});

test('the state vocabulary is normalized exactly like prusaconnect.js', async () => {
  const { createConnectState, CONNECT_STATE_MAP, normalizeConnectState } = await loadModule();

  const entries = Object.entries(CONNECT_STATE_MAP);
  assert.equal(entries.length, 10, 'the ported table must stay complete');
  assert.deepEqual(Object.keys(CONNECT_STATE_MAP).sort(), [
    'ATTENTION', 'ERROR', 'FINISHED', 'IDLE', 'PAUSED', 'PAUSING',
    'PRINTING', 'READY', 'RESUMING', 'STOPPED',
  ]);

  for (const [raw, expected] of entries) {
    const state = createConnectState();
    assert.equal(state.apply('data/state', raw), true);
    assert.equal(state.snapshot().state, expected, `${raw} must normalize to ${expected}`);
  }

  // BUSY splits on job identity, which on this transport is the current job id.
  const idle = createConnectState();
  idle.apply('data/state', 'BUSY');
  assert.equal(idle.snapshot().state, 'BUSY');
  idle.apply('data/current-job', '650');
  assert.equal(idle.snapshot().state, 'PRINTING');

  // Anything outside the vocabulary is UNKNOWN, never a passthrough.
  const odd = createConnectState();
  odd.apply('data/state', 'TELEPORTING');
  assert.equal(odd.snapshot().state, 'UNKNOWN');

  // Case and stray whitespace on the wire do not change the mapping.
  odd.apply('data/state', ' printing ');
  assert.equal(odd.snapshot().state, 'PRINTING');

  // Nothing received yet is null, not a fabricated IDLE.
  assert.equal(createConnectState().snapshot().state, null);

  assert.equal(normalizeConnectState('attention'), 'ERROR');
  assert.equal(normalizeConnectState(''), null);
  assert.equal(normalizeConnectState(null), null);
  assert.equal(normalizeConnectState('BUSY', true), 'PRINTING');
  assert.equal(normalizeConnectState('BUSY', false), 'BUSY');
});

test('dialog becomes an activity only when it carries text', async () => {
  const { createConnectState } = await loadModule();
  const state = createConnectState();

  // The captured dialog: an id and nothing readable.
  state.apply('dialog',
    '{"id": 405205626, "code": null, "text": null, "title": null, "buttons": null, "key": null}');
  assert.equal(state.snapshot().activity, null);

  state.apply('dialog', JSON.stringify({
    id: 405205627,
    code: 'FILAMENT_RUNOUT',
    title: 'Filament runout',
    text: 'Load filament and press knob',
    buttons: ['RETRY'],
    key: null,
  }));
  assert.deepEqual(state.snapshot().activity, {
    active: true,
    kind: 'OPERATION',
    label: 'Printer busy',
    detail: 'Filament runout',
    progress: null,
  });

  // A snapshot hands out a copy, so a caller cannot mutate the live activity.
  const snap = state.snapshot();
  snap.activity.detail = 'tampered';
  assert.equal(state.snapshot().activity.detail, 'Filament runout');

  // Without a title the body text carries the detail, cleaned of control
  // characters and collapsed like the server does.
  state.apply('dialog', JSON.stringify({ title: null, text: 'Heating\x00  up\nnow' }));
  assert.equal(state.snapshot().activity.detail, 'Heating up now');

  // Over-long dialog text is capped at the server's 160 characters.
  state.apply('dialog', JSON.stringify({ title: 'x'.repeat(400), text: null }));
  assert.equal(state.snapshot().activity.detail.length, 160);

  // Valid JSON that is not an object clears the activity.
  for (const payload of ['null', '5', '[]', '"text"']) {
    state.apply('dialog', JSON.stringify({ title: 'Calibrating', text: null }));
    assert.equal(state.snapshot().activity.detail, 'Calibrating');
    assert.equal(state.apply('dialog', payload), true, `${payload} is a valid document`);
    assert.equal(state.snapshot().activity, null, `${payload} clears the activity`);
  }

  // Invalid JSON leaves the previous activity standing rather than blanking
  // the overlay on one bad publish.
  state.apply('dialog', JSON.stringify({ title: 'Calibrating', text: null }));
  assert.equal(state.apply('dialog', '{not json'), false);
  assert.equal(state.snapshot().activity.detail, 'Calibrating');
  assert.equal(state.apply('dialog', ''), false);
  assert.equal(state.snapshot().activity.detail, 'Calibrating');

  // A dialog cleared by the printer clears the activity.
  state.apply('dialog', '{"id": 1, "text": null, "title": null}');
  assert.equal(state.snapshot().activity, null);
});

test('malformed payloads never throw and never corrupt existing values', async () => {
  const { createConnectState } = await loadModule();
  const clock = makeClock();
  const state = createConnectState({ now: clock.now });
  applyAll(state, RETAINED_TREE);
  const good = state.snapshot();

  const numericTopics = [
    'data/job-progress', 'data/axis-z', 'data/temp/nozzle/current',
    'data/temp/nozzle/target', 'data/temp/heatbed/current', 'data/temp/heatbed/target',
    'data/temp/chamber/current', 'data/tools/3/temp/nozzle/current',
    'jobs/650/data/progress', 'jobs/650/data/time-remaining',
  ];
  const garbage = ['', '   ', 'NaN', 'abc', 'Infinity', '-Infinity', '12,5', '1.2.3', 'null'];
  for (const topic of numericTopics) {
    for (const payload of garbage) {
      assert.equal(state.apply(topic, payload), false, `${topic} must refuse ${payload}`);
    }
  }
  assert.equal(state.apply('data/state', '   '), false);
  assert.equal(state.apply('data/online', 'yes please'), false);
  assert.equal(state.apply('data/current-job', '  '), false);
  assert.equal(state.apply('jobs/650/data/state', ''), false);

  const after = state.snapshot();
  assert.deepEqual(after, { ...good, lastMessageAt: after.lastMessageAt },
    'no malformed payload may change a mapped field');
  assert.equal(after.topicCount, good.topicCount);

  // Non-string topics and payloads are rejected without throwing.
  for (const topic of [null, undefined, 42, {}, ['data/axis-z']]) {
    assert.equal(state.apply(topic, '1.0'), false);
  }
  for (const payload of [null, undefined, 42, {}, true]) {
    assert.equal(state.apply('data/axis-z', payload), false);
  }
  assert.equal(state.snapshot().axisZ, good.axisZ);

  // Byte payloads decode, so a transport that skips the string decode still
  // feeds the mapping.
  assert.equal(state.apply('data/axis-z', new TextEncoder().encode('3.75')), true);
  assert.equal(state.snapshot().axisZ, 3.75);
  assert.equal(state.apply('data/axis-z', new TextEncoder().encode('4.25').buffer), true);
  assert.equal(state.snapshot().axisZ, 4.25);

  // A hostile tool segment cannot reach the prototype of the temps view.
  assert.equal(state.apply('data/tools/__proto__/temp/nozzle/current', '9'), false);
  assert.equal(Object.getPrototypeOf(state.snapshot().toolTemps), Object.prototype);
});

test('online, material, and liveness reflect only what the tree publishes', async () => {
  const { createConnectState } = await loadModule();
  const clock = makeClock();
  const state = createConnectState({ now: clock.now });

  // online mirrors data/online alone. The engine ANDs it with the live link.
  assert.equal(state.snapshot().online, null, 'unknown until the printer says');
  state.apply('data/online', '1');
  assert.equal(state.snapshot().online, true);
  state.apply('data/online', '0');
  assert.equal(state.snapshot().online, false);
  state.apply('data/online', 'true');
  assert.equal(state.snapshot().online, true);

  // A blank or '---' material is the printer reporting no filament, which is
  // a real value rather than a malformed payload.
  state.apply('data/material', 'PLA');
  assert.equal(state.snapshot().material, 'PLA');
  assert.equal(state.apply('data/material', '---'), true);
  assert.equal(state.snapshot().material, null);
  state.apply('data/material', 'PETG');
  assert.equal(state.apply('data/material', ''), true);
  assert.equal(state.snapshot().material, null);
  state.apply('data/material', '  PC  Blend ');
  assert.equal(state.snapshot().material, 'PC Blend');

  // lastMessageAt tracks any message, including an unmapped topic, because it
  // is the link liveness the engine turns into staleSec.
  const first = state.snapshot().lastMessageAt;
  clock.advanceSec(30);
  state.apply('data/nothing/we/map', 'x');
  assert.equal(state.snapshot().lastMessageAt, first + 30000);
  assert.equal(createConnectState().snapshot().lastMessageAt, null);
});

test('reset clears every mapped field for a fresh subscription', async () => {
  const { createConnectState } = await loadModule();
  const state = createConnectState();
  applyAll(state, RETAINED_TREE);
  state.reset();

  const snap = state.snapshot();
  const empty = createConnectState().snapshot();
  assert.deepEqual(snap, empty);
  assert.equal(state.jobId, null);
  assert.equal(snap.topicCount, 0);
  assert.equal(snap.toolTemps && Object.keys(snap.toolTemps).length, 0);
});
