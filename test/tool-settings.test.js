'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { onTestFinished, test } = require('bun:test');
const {
  createToolSettingsStore,
  mergeConnectToolInventory,
  normalizeDetectedToolSettings,
  normalizeToolSettings,
  resolveToolSettings,
  restoreCachedConnectToolInventory,
  toPublicToolSlots,
} = require('../tool-settings.js');

function tempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-tool-settings-'));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function persisted(settings, version = 1) {
  return JSON.stringify({ version, ...settings });
}

const defaults = Object.freeze({
  toolCount: 2,
  toolSlots: Object.freeze({
    1: Object.freeze({ loaded: true, name: 'Default PLA', color: '#112233' }),
  }),
});

test('normalizes names and colours while preserving slots above the active count', () => {
  const input = {
    toolCount: 2,
    toolSlots: {
      1: { loaded: true, name: '  Prusament\tPETG   Galaxy Black  ', color: '#a1b2c3' },
      32: { loaded: false, name: 'Reserved spool' },
    },
  };

  const result = normalizeToolSettings(input);

  assert.deepEqual(result, {
    toolCount: 2,
    toolSlots: {
      1: { loaded: true, name: 'Prusament PETG Galaxy Black', color: '#A1B2C3' },
      32: { loaded: false, name: 'Reserved spool' },
    },
  });
  assert.equal(input.toolSlots[1].color, '#a1b2c3');
});

test('requires the exact API shape and a nullable bounded tool-count override', () => {
  for (const value of [null, [], 'tools']) {
    assert.throws(() => normalizeToolSettings(value), /must be an object/);
  }
  for (const value of [
    { toolCount: 1 },
    { toolSlots: {} },
    { toolCount: 1, toolSlots: {}, version: 1 },
  ]) {
    assert.throws(() => normalizeToolSettings(value), /exactly toolCount and toolSlots/);
  }
  for (const toolCount of [0, 33, 1.5, '8', NaN]) {
    assert.throws(() => normalizeToolSettings({ toolCount, toolSlots: {} }), /integer from 1 to 32/);
  }
  assert.equal(normalizeToolSettings({ toolCount: 1, toolSlots: {} }).toolCount, 1);
  assert.equal(normalizeToolSettings({ toolCount: 32, toolSlots: {} }).toolCount, 32);
  assert.equal(normalizeToolSettings({ toolCount: null, toolSlots: {} }).toolCount, null);
});

test('rejects non-canonical slots and malformed nested settings', () => {
  for (const key of ['0', '01', '33', '1.0', '-1']) {
    assert.throws(
      () => normalizeToolSettings({ toolCount: 1, toolSlots: { [key]: {} } }),
      /canonical integers from 1 to 32/,
    );
  }
  for (const [value, pattern] of [
    [{ 1: null }, /toolSlots.1 must be an object/],
    [{ 1: [] }, /toolSlots.1 must be an object/],
    [{ 1: { material: 'PETG' } }, /unknown setting/],
    [{ 1: { loaded: 'yes' } }, /loaded must be true or false/],
    [{ 1: { name: 'x'.repeat(81) } }, /at most 80 characters/],
    [{ 1: { name: ' '.repeat(81) } }, /at most 80 characters/],
    [{ 1: { color: '112233' } }, /six-digit hex/],
    [{ 1: { color: '#12345g' } }, /six-digit hex/],
  ]) {
    assert.throws(() => normalizeToolSettings({ toolCount: 1, toolSlots: value }), pattern);
  }
  assert.throws(
    () => normalizeToolSettings({ toolCount: 1, toolSlots: [] }),
    /toolSlots must be an object/,
  );
});

test('builds public slots without inferring presence from independent name or color overrides', () => {
  const slots = toPublicToolSlots({
    toolCount: 4,
    toolSlots: {
      1: { name: 'PLA' },
      2: { color: '#abcdef' },
      3: { loaded: false, name: 'Remembered PETG' },
      32: { loaded: true, name: 'Hidden reserve' },
    },
  });

  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map(({ loaded, name, color }) => ({ loaded, name, color })), [
    { loaded: null, name: 'PLA', color: null },
    { loaded: null, name: null, color: '#ABCDEF' },
    { loaded: false, name: 'Remembered PETG', color: null },
    { loaded: null, name: null, color: null },
  ]);
  assert.equal(slots[0].sources.name, 'override');
  assert.equal(slots[0].sources.loaded, 'none');
});

test('resolves Connect detection field by field and keeps manual overrides independent', () => {
  const resolved = resolveToolSettings({
    toolCount: null,
    toolSlots: {
      1: { loaded: false, name: 'Custom spool' },
      2: { color: '#abcdef' },
      9: { loaded: true },
    },
  }, {
    source: 'connect',
    status: 'fresh',
    toolCount: 3,
    toolSlots: [
      { toolLabel: 1, loaded: true, material: 'PLA' },
      { toolLabel: 2, loaded: false, material: null },
      { toolLabel: 3, loaded: null, material: 'PETG' },
    ],
  });

  assert.equal(resolved.toolCount, 3);
  assert.equal(resolved.toolCountSource, 'connect');
  assert.deepEqual(resolved.toolSlots.map((slot) => ({
    loaded: slot.loaded, name: slot.name, material: slot.material, color: slot.color,
  })), [
    { loaded: false, name: 'Custom spool', material: 'PLA', color: null },
    { loaded: false, name: null, material: null, color: '#ABCDEF' },
    { loaded: null, name: null, material: 'PETG', color: null },
  ]);
  assert.equal(resolved.toolSlots[0].sources.loaded, 'override');
  assert.equal(resolved.toolSlots[0].sources.material, 'connect');
  assert.equal(resolved.toolSlots[1].sources.color, 'override');
});

test('manual count wins while an active-tool floor remains visible', () => {
  const resolved = resolveToolSettings({ toolCount: 2, toolSlots: {} }, {
    source: 'connect', status: 'fresh', toolCount: 8, toolSlots: [],
  }, { minimumToolCount: 4 });
  assert.equal(resolved.toolCount, 4);
  assert.equal(resolved.toolCountSource, 'override');
  assert.equal(resolved.countAdjusted, true);
});

test('cached Connect inventory is scoped to its printer', () => {
  const eightTools = {
    version: 2,
    printerUuid: 'printer-a',
    toolCount: 8,
    toolSlots: Array.from({ length: 8 }, (_, toolIndex) => ({ toolIndex, toolLabel: toolIndex + 1 })),
  };
  assert.equal(restoreCachedConnectToolInventory(eightTools, 'printer-b'), null);
  assert.equal(restoreCachedConnectToolInventory({
    version: 1,
    toolCount: 8,
    toolSlots: eightTools.toolSlots,
  }, 'printer-a'), null);
  assert.equal(restoreCachedConnectToolInventory(eightTools, 'printer-a', false), null);
  assert.equal(restoreCachedConnectToolInventory(eightTools, 'printer-a').toolCount, 8);

  const offlineFixture = restoreCachedConnectToolInventory({
    version: 1,
    toolCount: 1,
    toolSlots: [{ toolLabel: 1, loaded: false }],
  }, null);
  assert.equal(offlineFixture.toolCount, 1);
});

test('authoritative Connect counts can shrink while top-level fallback samples preserve the floor', () => {
  const established = mergeConnectToolInventory(null, {
    countAuthoritative: true,
    toolCount: 8,
    toolSlots: Array.from({ length: 8 }, (_, toolIndex) => ({
      toolIndex,
      toolLabel: toolIndex + 1,
      loaded: toolIndex === 1 ? true : null,
      material: toolIndex === 1 ? 'PLA' : null,
    })),
  });
  const partial = mergeConnectToolInventory(established, {
    countAuthoritative: false,
    toolCount: 1,
    toolSlots: [{ toolLabel: 1, loaded: true, material: 'PETG' }],
  });
  assert.equal(partial.toolCount, 8);
  assert.equal(partial.toolSlots[0].material, 'PETG');
  assert.equal(partial.toolSlots[1].material, 'PLA');

  const reduced = mergeConnectToolInventory(established, {
    countAuthoritative: true,
    toolCount: 1,
    toolSlots: [{ toolLabel: 1, loaded: true, material: 'ASA' }],
  });
  assert.equal(reduced.toolCount, 1);
  assert.equal(reduced.toolSlots.length, 1);
  assert.equal(reduced.toolSlots[0].material, 'ASA');
});

test('uses detached configuration defaults when no persisted settings exist', () => {
  const dataFile = path.join(tempDir(), 'tool-settings.json');
  const messages = [];
  const store = createToolSettingsStore({ dataFile, defaults, logger: { warn: (message) => messages.push(message) } });

  const first = store.get();
  first.toolCount = 32;
  first.toolSlots[1].name = 'Changed by caller';

  assert.deepEqual(store.get(), {
    toolCount: 2,
    toolSlots: { 1: { loaded: true, name: 'Default PLA', color: '#112233' } },
  });
  assert.deepEqual(messages, []);
});

test('preserves compatibility with accepted configuration null placeholders', () => {
  const dataFile = path.join(tempDir(), 'tool-settings.json');
  const store = createToolSettingsStore({
    dataFile,
    defaults: {
      toolCount: 2,
      toolSlots: {
        1: { loaded: null, name: null, color: null },
        2: { loaded: true, name: 'PETG', color: null },
      },
    },
  });

  assert.deepEqual(store.get(), {
    toolCount: 2,
    toolSlots: { 2: { loaded: true, name: 'PETG' } },
  });

  assert.throws(() => createToolSettingsStore({
    dataFile: path.join(tempDir(), 'invalid-defaults.json'),
    defaults: { toolCount: 1, toolSlots: { 1: { material: 'PLA' } } },
  }), /unknown setting/);
});

test('configuration defaults keep loaded, name, and color independent', () => {
  const dataFile = path.join(tempDir(), 'tool-settings.json');
  const store = createToolSettingsStore({
    dataFile,
    defaults: {
      toolCount: 3,
      toolSlots: {
        1: { name: 'Remembered PLA' },
        2: { color: '#aabbcc' },
        3: { loaded: false, name: 'Empty PETG' },
      },
    },
  });

  assert.deepEqual(store.get(), {
    toolCount: 3,
    toolSlots: {
      1: { name: 'Remembered PLA' },
      2: { color: '#AABBCC' },
      3: { loaded: false, name: 'Empty PETG' },
    },
  });
});

test('loads a valid primary persisted snapshot', () => {
  const dataFile = path.join(tempDir(), 'tool-settings.json');
  fs.writeFileSync(dataFile, persisted({
    toolCount: 1,
    toolSlots: { 1: { name: '  Primary   PETG ', color: '#aabbcc' }, 8: { loaded: false } },
  }));

  const store = createToolSettingsStore({ dataFile, defaults });

  assert.deepEqual(store.get(), {
    toolCount: 1,
    toolSlots: { 1: { loaded: true, name: 'Primary PETG', color: '#AABBCC' }, 8: { loaded: false } },
  });
});

test('migrates loaded presence only for persisted version 1 snapshots', () => {
  const legacyFile = path.join(tempDir(), 'legacy-tool-settings.json');
  fs.writeFileSync(legacyFile, persisted({
    toolCount: 2,
    toolSlots: { 1: { name: 'Legacy PLA' }, 2: { color: '#112233' } },
  }, 1));
  const currentFile = path.join(tempDir(), 'current-tool-settings.json');
  fs.writeFileSync(currentFile, persisted({
    toolCount: 2,
    toolSlots: { 1: { name: 'Current PLA' }, 2: { color: '#445566' } },
  }, 2));

  assert.deepEqual(createToolSettingsStore({ dataFile: legacyFile, defaults }).get(), {
    toolCount: 2,
    toolSlots: {
      1: { loaded: true, name: 'Legacy PLA' },
      2: { loaded: true, color: '#112233' },
    },
  });
  assert.deepEqual(createToolSettingsStore({ dataFile: currentFile, defaults }).get(), {
    toolCount: 2,
    toolSlots: {
      1: { name: 'Current PLA' },
      2: { color: '#445566' },
    },
  });
});

test('an empty v2 automatic snapshot survives restart without reasserting configuration defaults', () => {
  const dataFile = path.join(tempDir(), 'tool-settings.json');
  fs.writeFileSync(dataFile, persisted({ toolCount: null, toolSlots: {} }, 2));
  const store = createToolSettingsStore({ dataFile, defaults });
  assert.deepEqual(store.get(), { toolCount: null, toolSlots: {} });
});

test('recovers a valid backup after a semantically invalid primary', () => {
  const directory = tempDir();
  const dataFile = path.join(directory, 'tool-settings.json');
  fs.writeFileSync(dataFile, persisted({ toolCount: 2, toolSlots: { 1: { color: 'bad' } } }));
  fs.writeFileSync(`${dataFile}.bak`, persisted({
    toolCount: 3,
    toolSlots: { 3: { loaded: true, name: 'Backup ASA', color: '#ff6600' } },
  }));
  const messages = [];

  const store = createToolSettingsStore({ dataFile, defaults, logger: { warn: (message) => messages.push(message) } });

  assert.deepEqual(store.get(), {
    toolCount: 3,
    toolSlots: { 3: { loaded: true, name: 'Backup ASA', color: '#FF6600' } },
  });
  assert.deepEqual(messages, ['Tool settings primary was unusable; recovered from backup.']);
});

test('falls back safely when primary and backup are unusable without logging contents or paths', () => {
  const directory = tempDir();
  const dataFile = path.join(directory, 'tool-settings.json');
  const marker = 'TOP_SECRET_TEST_MARKER';
  fs.writeFileSync(dataFile, marker);
  fs.writeFileSync(`${dataFile}.bak`, '{"version":99}');
  const messages = [];

  const store = createToolSettingsStore({ dataFile, defaults, logger: (message) => messages.push(message) });

  assert.deepEqual(store.get(), {
    toolCount: 2,
    toolSlots: { 1: { loaded: true, name: 'Default PLA', color: '#112233' } },
  });
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], new RegExp(marker));
  assert.doesNotMatch(messages[0], new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('replace writes a versioned atomic snapshot and swaps state only after success', () => {
  const dataFile = path.join(tempDir(), 'tool-settings.json');
  const store = createToolSettingsStore({ dataFile, defaults });

  const result = store.replace({
    toolCount: 1,
    toolSlots: { 1: { loaded: true, name: '  New  PLA ', color: '#abcdef' }, 12: { loaded: false } },
  });

  const expected = {
    toolCount: 1,
    toolSlots: { 1: { loaded: true, name: 'New PLA', color: '#ABCDEF' }, 12: { loaded: false } },
  };
  assert.deepEqual(result, expected);
  assert.deepEqual(store.get(), expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')), { version: 2, ...expected });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${dataFile}.bak`, 'utf8')), { version: 2, ...expected });
  assert.equal(fs.readdirSync(path.dirname(dataFile)).some((name) => name.endsWith('.tmp')), false);

  result.toolSlots[1].name = 'Caller mutation';
  assert.equal(store.get().toolSlots[1].name, 'New PLA');
});

test('replace leaves in-memory state unchanged when the atomic write fails', () => {
  const directory = tempDir();
  const blockedParent = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blockedParent, 'block writes below this path');
  const dataFile = path.join(blockedParent, 'tool-settings.json');
  const store = createToolSettingsStore({ dataFile, defaults, logger: null });
  const before = store.get();

  assert.throws(
    () => store.replace({ toolCount: 8, toolSlots: { 8: { name: 'Must not become current' } } }),
  );
  assert.deepEqual(store.get(), before);
});

test('replace remains successful and consistent when only the backup write fails', () => {
  const directory = tempDir();
  const dataFile = path.join(directory, 'tool-settings.json');
  const messages = [];
  const store = createToolSettingsStore({
    dataFile,
    defaults,
    logger: { warn: (message) => messages.push(message) },
  });
  fs.mkdirSync(`${dataFile}.bak`);
  const next = { toolCount: 1, toolSlots: { 1: { name: 'Saved primary' } } };

  assert.deepEqual(store.replace(next), next);
  assert.deepEqual(store.get(), next);
  assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')), { version: 2, ...next });
  assert.deepEqual(messages, [
    'Tool settings backup could not be updated; the primary save succeeded.',
  ]);
});
