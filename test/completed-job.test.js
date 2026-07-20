'use strict';

const assert = require('node:assert/strict');
const { test } = require('bun:test');
const { sanitizeCompletedJob, stableJobIdentity, usableJobKey } = require('../persistence.js');

const cleanName = (name) => String(name || '').replace(/\.(?:bgcode|gcode)$/i, '').trim();

test('rejects sentinel-only completed jobs during restore and publication', () => {
  const emptyCompletion = {
    name: '',
    jobKey: 'x::',
    progress: null,
    timeElapsedSec: null,
  };

  assert.equal(usableJobKey('x::'), null);
  assert.equal(stableJobIdentity(emptyCompletion, cleanName), null);
  assert.equal(sanitizeCompletedJob(emptyCompletion, cleanName), null);
});

test('accepts a cleaned name or a non-sentinel job key as stable identity', () => {
  const named = sanitizeCompletedJob({ name: 'camera-idol.bgcode', jobKey: 'x::' }, cleanName);
  assert.equal(named.name, 'camera-idol');
  assert.equal(named.jobKey, null);
  assert.equal(stableJobIdentity(named, cleanName), 'name:camera-idol');

  assert.equal(usableJobKey('42::'), '42::');
  assert.equal(usableJobKey('x::ACTIVE.BGC'), 'x::ACTIVE.BGC');
  assert.match(stableJobIdentity({ name: '', jobKey: '42::' }, cleanName), /^key:/);
});

test('prefers printer job keys so repeated generic names remain distinct', () => {
  assert.equal(
    stableJobIdentity({ name: 'Merged', jobKey: '43::MERGED~1.BGC' }, cleanName),
    'key:43::merged~1.bgc',
  );
  assert.equal(
    stableJobIdentity({ name: 'Merged', jobKey: '44::MERGED~1.BGC' }, cleanName),
    'key:44::merged~1.bgc',
  );
});
