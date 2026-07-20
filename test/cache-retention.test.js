'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { onTestFinished, test } = require('bun:test');
const { analysisGroupName, pruneAnalysisCache } = require('../cache-retention.js');

function writeAt(directory, name, age) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, name);
  const when = new Date(Date.now() - age);
  fs.utimesSync(file, when, when);
  return file;
}

test('analysis cache retention removes old job pairs without touching state or media', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-retention-'));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));

  const newest = writeAt(directory, '3%3A%3Anew.bgcode.json', 1000);
  writeAt(directory, '3%3A%3Anew.bgcode.json.bak', 1000);
  const middle = writeAt(directory, '2%3A%3Amiddle.bgcode.json', 2000);
  writeAt(directory, '2%3A%3Amiddle.bgcode.json.bak', 2000);
  const protectedOld = writeAt(directory, '1%3A%3Aactive.bgcode.json', 3000);
  writeAt(directory, '1%3A%3Aactive.bgcode.json.bak', 3000);
  const state = writeAt(directory, 'laststate.json', 10000);
  const image = writeAt(directory, 'manual-snapshot.jpg', 10000);

  const result = pruneAnalysisCache(directory, {
    maxEntries: 1,
    protectedFiles: [protectedOld],
  });

  assert.equal(result.removedFiles, 2);
  assert.equal(fs.existsSync(newest), true);
  assert.equal(fs.existsSync(middle), false);
  assert.equal(fs.existsSync(protectedOld), true);
  assert.equal(fs.existsSync(state), true);
  assert.equal(fs.existsSync(image), true);
});

test('analysis cache grouping recognizes primary, backup, and quarantine files only', () => {
  assert.equal(analysisGroupName('12%3A%3Ajob.bgcode.json'), '12%3A%3Ajob.bgcode.json');
  assert.equal(analysisGroupName('12%3A%3Ajob.bgcode.json.bak'), '12%3A%3Ajob.bgcode.json');
  assert.equal(analysisGroupName('12%3A%3Ajob.bgcode.json.bak.corrupt-42'), '12%3A%3Ajob.bgcode.json');
  assert.equal(analysisGroupName('laststate.json'), null);
  assert.equal(analysisGroupName('camera.jpg'), null);
});
