'use strict';

const assert = require('node:assert/strict');
const { test } = require('bun:test');
const { AutomationLease, clampDuration } = require('../automation-lease.js');

test('automation presence is ephemeral, renewable, and fails closed', () => {
  let now = 1000;
  const lease = new AutomationLease({ durationMs: 45000, now: () => now });

  assert.equal(lease.isRunning(), false);
  assert.deepEqual(lease.status(), {
    running: false,
    expiresAt: null,
    expiresInMs: 0,
    leaseMs: 45000,
  });

  lease.heartbeat();
  assert.equal(lease.isRunning(), true);
  assert.equal(lease.status().expiresInMs, 45000);
  assert.equal(lease.status().expiresAt, 46000);

  now += 30000;
  lease.heartbeat();
  now += 44999;
  assert.equal(lease.isRunning(), true);
  now += 1;
  assert.equal(lease.isRunning(), false);

  lease.heartbeat();
  assert.equal(lease.clear().running, false);
});

test('automation lease duration is bounded independently of host presentation config', () => {
  assert.equal(clampDuration(1), 15000);
  assert.equal(clampDuration(999999), 300000);
  assert.equal(clampDuration('bad'), 45000);
});
