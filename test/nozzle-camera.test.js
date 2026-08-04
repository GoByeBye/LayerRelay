'use strict';

const assert = require('node:assert/strict');
const { test } = require('bun:test');
const { validateConfig, DEFAULT_CONFIG } = require('../config.js');
const { CameraStream } = require('../camera-stream.js');

const base = {
  printerHost: '192.0.2.10',
  username: 'maker',
  password: 'secret',
  sourceCodeUrl: 'https://github.com/GoByeBye/LayerRelay',
  listenHost: '127.0.0.1',
};

test('accepts a valid nozzle camera configuration', () => {
  const cfg = validateConfig({
    ...base,
    nozzleRtspUrl: 'rtsp://192.0.2.20:8554/nozzle',
    nozzleStreamEnabled: true,
    nozzleStreamFps: 15,
    nozzleStreamWidth: 640,
    nozzleStreamJpegQuality: 6,
  });
  assert.equal(cfg.nozzleRtspUrl, 'rtsp://192.0.2.20:8554/nozzle');
});

test('nozzle is absent by default and off when unset', () => {
  assert.equal('nozzleRtspUrl' in DEFAULT_CONFIG, true);
  assert.equal(DEFAULT_CONFIG.nozzleRtspUrl, '');
  const relay = new CameraStream({ cameraRtspUrl: DEFAULT_CONFIG.nozzleRtspUrl });
  assert.equal(relay.enabled, false);
  assert.equal(relay.getStatus().state, 'disabled');
});

test('rejects a non-RTSP nozzle URL', () => {
  assert.throws(
    () => validateConfig({ ...base, nozzleRtspUrl: 'http://192.0.2.20/stream' }),
    /nozzleRtspUrl must use rtsp/,
  );
});

test('rejects out-of-range nozzle tuning', () => {
  assert.throws(() => validateConfig({ ...base, nozzleStreamFps: 99 }), /nozzleStreamFps/);
  assert.throws(() => validateConfig({ ...base, nozzleStreamWidth: 100 }), /nozzleStreamWidth/);
});

test('a nozzle-style config produces an enabled relay via CameraStream', () => {
  const relay = new CameraStream({
    cameraRtspUrl: 'rtsp://192.0.2.20:8554/nozzle',
    cameraStreamWidth: 640,
    cameraStreamFps: 15,
  });
  assert.equal(relay.enabled, true);
  assert.equal(relay.options.width, 640);
});
