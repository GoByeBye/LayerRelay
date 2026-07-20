'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { onTestFinished, test } = require('bun:test');
const { loadRuntimeConfig, validateConfig } = require('../config.js');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-config-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('loads a file and applies typed environment overrides', () => {
  const rootDir = tempDir();
  fs.writeFileSync(path.join(rootDir, 'custom.json'), JSON.stringify({
    printerHost: 'printer.local',
    username: 'maker',
    password: 'secret',
    port: 8787,
  }));

  const runtime = loadRuntimeConfig({
    rootDir,
    env: {
      CONFIG_PATH: 'custom.json',
      DATA_DIR: 'runtime-data',
      LISTEN_HOST: '0.0.0.0',
      PORT: '9000',
      CAMERA_STREAM_ENABLED: 'true',
      SOURCE_CODE_URL: 'https://code.example/overlay/tree/test',
    },
  });

  assert.equal(runtime.config.port, 9000);
  assert.equal(runtime.config.listenHost, '0.0.0.0');
  assert.equal(runtime.config.cameraStreamEnabled, true);
  assert.equal(runtime.config.useConnect, true);
  assert.equal(runtime.config.sourceCodeUrl, 'https://code.example/overlay/tree/test');
  assert.equal(runtime.configPath, path.join(rootDir, 'custom.json'));
  assert.equal(runtime.dataDir, path.join(rootDir, 'runtime-data'));
});

test('supports an environment-only container configuration', () => {
  const rootDir = tempDir();
  const runtime = loadRuntimeConfig({
    rootDir,
    env: {
      PRINTER_HOST: '192.0.2.10',
      PRINTER_USERNAME: 'maker',
      PRINTER_PASSWORD: '  secret with spaces  ',
    },
  });

  assert.equal(runtime.source, 'environment');
  assert.equal(runtime.config.printerHost, '192.0.2.10');
  assert.equal(runtime.config.password, '  secret with spaces  ');
});

test('accepts LayerRelay-prefixed environment overrides', () => {
  const rootDir = tempDir();
  const runtime = loadRuntimeConfig({
    rootDir,
    env: {
      LAYER_RELAY_PRINTER_HOST: 'new-printer.local',
      LAYER_RELAY_PRINTER_USERNAME: 'new-maker',
      LAYER_RELAY_PRINTER_PASSWORD: 'new-secret',
      LAYER_RELAY_PORT: '9001',
    },
  });
  assert.equal(runtime.config.printerHost, 'new-printer.local');
  assert.equal(runtime.config.username, 'new-maker');
  assert.equal(runtime.config.password, 'new-secret');
  assert.equal(runtime.config.port, 9001);
});

test('reports actionable validation errors without printing secret values', () => {
  assert.throws(
    () => validateConfig({ printerHost: 'http://printer', username: '', password: 'replace-with-password', port: 0 }),
    (error) => {
      assert.match(error.message, /username must be a non-empty string/);
      assert.match(error.message, /without http/);
      assert.match(error.message, /example placeholder/);
      assert.doesNotMatch(error.message, /replace-with-password/);
      return true;
    },
  );
});

test('requires RTSP camera URLs', () => {
  assert.throws(
    () => validateConfig({
      printerHost: 'printer.local',
      username: 'maker',
      password: 'secret',
      listenHost: '127.0.0.1',
      port: 8787,
      cameraRtspUrl: 'https://camera.example/live',
    }),
    (error) => {
      assert.match(error.message, /must use rtsp/);
      return true;
    },
  );
});

test('rejects schema typos and unsafe poll cadences', () => {
  const base = {
    printerHost: 'printer.local',
    username: 'maker',
    password: 'secret',
    listenHost: '127.0.0.1',
    port: 8787,
  };
  for (const [patch, pattern] of [
    [{ pollIntervalMs: -1 }, /pollIntervalMs must be an integer/],
    [{ pollIntervalMs: 'banana' }, /pollIntervalMs must be an integer/],
    [{ connectPollMs: 4999 }, /connectPollMs must be an integer/],
    [{ pollIntervlMs: 2000 }, /unknown setting: pollIntervlMs/],
    [{ toolSlots: [{ name: 'PLA' }] }, /toolSlots must be an object/],
    [{ toolSlots: { 1: { material: 'PLA' } } }, /unknown toolSlots.1 setting/],
    [{ sourceCodeUrl: null }, /sourceCodeUrl must be a non-empty string/],
    [{ sourceCodeUrl: '' }, /sourceCodeUrl must be a non-empty string/],
    [{ sourceCodeUrl: 'file:///tmp/source' }, /must use http/],
    [{ sourceCodeUrl: 'https://user:secret@example.com/source' }, /must not contain credentials/],
  ]) {
    assert.throws(() => validateConfig({ ...base, ...patch }), pattern);
  }
});

test('rejects malformed JSON with the path and no file contents', () => {
  const rootDir = tempDir();
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, '{"password": TOP_SECRET_PASSWORD,');
  assert.throws(
    () => loadRuntimeConfig({ rootDir, env: {} }),
    (error) => {
      assert.match(error.message, /Cannot parse configuration/);
      assert.doesNotMatch(error.message, /TOP_SECRET_PASSWORD/);
      return true;
    },
  );
});
