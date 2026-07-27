'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { onTestFinished, test } = require('bun:test');
const {
  createCameraSettingsStore,
  normalizeCameraSettings,
} = require('../camera-settings.js');

function tempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-camera-settings-'));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function persisted(profile, patch = {}) {
  return JSON.stringify({ version: 1, profile, ...patch });
}

test('accepts only the exact public shape and supported profile values', () => {
  assert.deepEqual(normalizeCameraSettings({ profile: 'native' }), { profile: 'native' });
  assert.deepEqual(
    normalizeCameraSettings(Object.assign(Object.create(null), { profile: 'enhanced-1440p' })),
    { profile: 'enhanced-1440p' },
  );

  for (const value of [
    null,
    [],
    {},
    { profile: 'native', extra: true },
    { profile: 'enhanced-2160p' },
    { profile: 'Native' },
    { profile: 1 },
  ]) {
    assert.throws(() => normalizeCameraSettings(value), TypeError);
  }

  const symbolKey = { profile: 'native' };
  symbolKey[Symbol('extra')] = true;
  assert.throws(() => normalizeCameraSettings(symbolKey), TypeError);
});

test('uses a detached caller-supplied default when no persisted settings exist', () => {
  const dataFile = path.join(tempDir(), 'camera-settings.json');
  const defaults = { profile: 'native' };
  const messages = [];
  const store = createCameraSettingsStore({
    dataFile,
    defaults,
    logger: { warn: (message) => messages.push(message) },
  });

  defaults.profile = 'enhanced-1440p';
  const first = store.get();
  first.profile = 'enhanced-1440p';

  assert.deepEqual(store.get(), { profile: 'native' });
  assert.deepEqual(messages, []);
});

test('loads a semantically valid primary snapshot instead of its backup', () => {
  const dataFile = path.join(tempDir(), 'camera-settings.json');
  fs.writeFileSync(dataFile, persisted('enhanced-1440p'));
  fs.writeFileSync(`${dataFile}.bak`, persisted('native'));

  const store = createCameraSettingsStore({
    dataFile,
    defaults: { profile: 'native' },
  });

  assert.deepEqual(store.get(), { profile: 'enhanced-1440p' });
});

test('recovers a valid backup after a semantically invalid primary', () => {
  const dataFile = path.join(tempDir(), 'camera-settings.json');
  fs.writeFileSync(dataFile, persisted('enhanced-2160p'));
  fs.writeFileSync(`${dataFile}.bak`, persisted('enhanced-1440p'));
  const messages = [];

  const store = createCameraSettingsStore({
    dataFile,
    defaults: { profile: 'native' },
    logger: (message) => messages.push(message),
  });

  assert.deepEqual(store.get(), { profile: 'enhanced-1440p' });
  assert.deepEqual(messages, ['Camera settings primary was unusable; recovered from backup.']);
});

test('falls back safely when persisted candidates are invalid without logging paths or contents', () => {
  const directory = tempDir();
  const dataFile = path.join(directory, 'camera-settings.json');
  const marker = 'TOP_SECRET_CAMERA_MARKER';
  fs.writeFileSync(dataFile, marker);
  fs.writeFileSync(`${dataFile}.bak`, persisted('native', { extra: marker }));
  const messages = [];

  const store = createCameraSettingsStore({
    dataFile,
    defaults: { profile: 'enhanced-1440p' },
    logger: { warn: (message) => messages.push(message) },
  });

  assert.deepEqual(store.get(), { profile: 'enhanced-1440p' });
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], new RegExp(marker));
  assert.doesNotMatch(messages[0], new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('replace persists an exact versioned snapshot and returns a defensive clone', () => {
  const dataFile = path.join(tempDir(), 'camera-settings.json');
  const store = createCameraSettingsStore({
    dataFile,
    defaults: { profile: 'native' },
  });

  const result = store.replace({ profile: 'enhanced-1440p' });

  assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')), {
    version: 1,
    profile: 'enhanced-1440p',
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${dataFile}.bak`, 'utf8')),
    { version: 1, profile: 'enhanced-1440p' },
  );
  assert.equal(fs.readdirSync(path.dirname(dataFile)).some((name) => name.endsWith('.tmp')), false);

  result.profile = 'native';
  assert.deepEqual(store.get(), { profile: 'enhanced-1440p' });
});

test('a stale ETag cannot replace newer camera settings', () => {
  const dataFile = path.join(tempDir(), 'camera-settings.json');
  const store = createCameraSettingsStore({
    dataFile,
    defaults: { profile: 'native' },
  });
  const clientARevision = store.etag();
  const clientBRevision = store.etag();

  assert.match(clientARevision, /^"[0-9a-f]{64}"$/);
  store.replace({ profile: 'enhanced-1440p' }, clientARevision);

  assert.notEqual(store.etag(), clientBRevision);
  assert.throws(
    () => store.replace({ profile: 'native' }, clientBRevision),
    (error) => error && error.code === 'CAMERA_SETTINGS_CONFLICT',
  );
  assert.deepEqual(store.get(), { profile: 'enhanced-1440p' });
});

test('replace leaves memory unchanged when the primary atomic write fails', () => {
  const directory = tempDir();
  const blockedParent = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blockedParent, 'block writes below this path');
  const dataFile = path.join(blockedParent, 'camera-settings.json');
  const store = createCameraSettingsStore({
    dataFile,
    defaults: { profile: 'native' },
    logger: null,
  });

  assert.throws(() => store.replace({ profile: 'enhanced-1440p' }));
  assert.deepEqual(store.get(), { profile: 'native' });
});

test('replace succeeds and warns safely when only the backup write fails', () => {
  const directory = tempDir();
  const dataFile = path.join(directory, 'camera-settings.json');
  const messages = [];
  const store = createCameraSettingsStore({
    dataFile,
    defaults: { profile: 'native' },
    logger: { warn: (message) => messages.push(message) },
  });
  fs.mkdirSync(`${dataFile}.bak`);

  assert.deepEqual(
    store.replace({ profile: 'enhanced-1440p' }),
    { profile: 'enhanced-1440p' },
  );
  assert.deepEqual(store.get(), { profile: 'enhanced-1440p' });
  assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')), {
    version: 1,
    profile: 'enhanced-1440p',
  });
  assert.deepEqual(messages, [
    'Camera settings backup could not be updated; the primary save succeeded.',
  ]);
});
