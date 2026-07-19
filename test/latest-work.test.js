'use strict';

const assert = require('node:assert/strict');
const { test } = require('bun:test');
const { createLatestWork } = require('../latest-work.js');

test('cancels stale work and serializes the latest replacement', async () => {
  const started = [];
  const finished = [];
  const runner = createLatestWork(async (value, controller) => {
    started.push(value);
    if (value === 'old') {
      await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
    }
    finished.push(value);
  });

  runner.schedule('old');
  await Bun.sleep(0);
  runner.schedule('new');
  await runner.whenIdle();

  assert.deepEqual(started, ['old', 'new']);
  assert.deepEqual(finished, ['old', 'new']);
});

test('cancel drops a queued replacement and suppresses abort errors', async () => {
  const errors = [];
  const started = [];
  const runner = createLatestWork(async (value, controller) => {
    started.push(value);
    await new Promise((_, reject) => controller.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    }, { once: true }));
  }, (error) => errors.push(error));

  runner.schedule('old');
  await Bun.sleep(0);
  runner.schedule('new');
  runner.cancel();
  await runner.whenIdle();

  assert.deepEqual(started, ['old']);
  assert.deepEqual(errors, []);
});

test('reschedules the same value when its active task was already canceled', async () => {
  const started = [];
  const runner = createLatestWork(async (value, controller) => {
    started.push(value);
    if (started.length === 1) {
      await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
    }
  });

  const value = { jobKey: '42::part.bgcode' };
  runner.schedule(value);
  await Bun.sleep(0);
  runner.cancel();
  runner.schedule(value);
  await runner.whenIdle();

  assert.deepEqual(started, [value, value]);
});
