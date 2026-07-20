'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { onTestFinished, test } = require('bun:test');
const {
  quarantineJsonPair,
  readJsonDetailed,
  readJsonWithBackup,
  writeFileAtomic,
  writeJsonAtomic,
} = require('../persistence.js');

function withTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-persistence-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('atomically replaces JSON and keeps a current backup', () => {
  const file = path.join(withTempDir(), 'state.json');

  writeJsonAtomic(file, { sequence: 1 });
  writeJsonAtomic(file, { sequence: 2 });

  assert.deepEqual(readJsonWithBackup(file), { sequence: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { sequence: 2 });
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith('.tmp')), false);
});

test('atomically writes binary data without UTF-8 conversion', () => {
  const file = path.join(withTempDir(), 'preview.bin');
  const data = Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0xff]);

  writeFileAtomic(file, data);

  assert.deepEqual(fs.readFileSync(file), data);
});

test('recovers from the backup when the primary JSON is truncated', () => {
  const file = path.join(withTempDir(), 'token.json');
  writeJsonAtomic(file, { refresh_token: 'rotated-token' });
  fs.writeFileSync(file, '{"refresh_token":');

  const result = readJsonDetailed(file);

  assert.equal(result.recovered, true);
  assert.equal(result.source, `${file}.bak`);
  assert.deepEqual(result.value, { refresh_token: 'rotated-token' });
});

test('quarantines both corrupt primary and backup files', () => {
  const dir = withTempDir();
  const file = path.join(dir, 'analysis.json');
  fs.writeFileSync(file, 'bad primary');
  fs.writeFileSync(`${file}.bak`, 'bad backup');

  const moved = quarantineJsonPair(file);

  assert.equal(moved.length, 2);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.bak`), false);
  for (const quarantined of moved) assert.equal(fs.existsSync(quarantined), true);
});
