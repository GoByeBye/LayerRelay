'use strict';

const { test } = require('bun:test');
const assert = require('node:assert/strict');
const {
  isActiveJobState,
  jobKeysEqual,
  sameJobKey,
  selectJobId,
  shouldFinalizeJobSnapshot,
} = require('../job-lifecycle.js');

test('keeps an active print snapshot through BUSY until a terminal state arrives', () => {
  assert.equal(isActiveJobState('PRINTING'), true);
  assert.equal(isActiveJobState('PAUSED'), true);

  for (const state of [null, '', 'UNKNOWN', 'BUSY', 'PRINTING', 'PAUSED']) {
    assert.equal(shouldFinalizeJobSnapshot(state), false, `${state} must preserve the snapshot`);
  }

  for (const state of ['IDLE', 'FINISHED', 'ERROR', 'STOPPED', 'REPLACED']) {
    assert.equal(shouldFinalizeJobSnapshot(state), true, `${state} must finalize the snapshot`);
  }
});

test('selects a zero-valued local job id without falling through', () => {
  assert.equal(selectJobId({ id: 0 }, { id: 42 }), 0);
  assert.equal(selectJobId({}, { id: 0 }), 0);
  assert.equal(selectJobId(null, { id: 42 }), 42);
  assert.equal(selectJobId({}, {}), null);
});

test('matches job keys case-insensitively while preserving empty-state equality', () => {
  assert.equal(sameJobKey('42::Part.BGCODE', '42::part.bgcode'), true);
  assert.equal(sameJobKey('42::part.bgcode', '43::part.bgcode'), false);
  assert.equal(sameJobKey(null, null), false);
  assert.equal(jobKeysEqual(null, null), true);
  assert.equal(jobKeysEqual(null, '42::part.bgcode'), false);
});
