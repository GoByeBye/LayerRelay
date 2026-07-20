'use strict';

const assert = require('node:assert/strict');
const { test } = require('bun:test');
const { sampleHealth, selectTelemetrySource } = require('../telemetry-freshness.js');

test('expires a previously successful sample at the overlay disconnect threshold', () => {
  assert.deepEqual(sampleHealth(100, true, 107), { lastGood: 100, staleSec: 7, online: true });
  assert.deepEqual(sampleHealth(100, true, 108), { lastGood: 100, staleSec: 8, online: false });
  assert.deepEqual(sampleHealth(100, false, 101), { lastGood: 100, staleSec: 1, online: false });
  assert.deepEqual(sampleHealth(0, true, 101), { lastGood: 0, staleSec: null, online: false });
});

test('selects a fresh source and otherwise keeps the newest cached telemetry', () => {
  const freshLocal = sampleHealth(100, true, 104);
  const staleConnect = sampleHealth(90, true, 104);
  assert.equal(selectTelemetrySource(freshLocal, staleConnect, true), 'local');

  const freshConnect = sampleHealth(103, true, 104);
  assert.equal(selectTelemetrySource(freshLocal, freshConnect, true), 'connect');

  const staleLocal = sampleHealth(95, true, 110);
  const newerStaleConnect = sampleHealth(99, true, 110);
  assert.equal(selectTelemetrySource(staleLocal, newerStaleConnect, true), 'connect');
  assert.equal(selectTelemetrySource(staleLocal, newerStaleConnect, false), 'local');
});
