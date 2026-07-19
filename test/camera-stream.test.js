'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { onTestFinished, test } = require('bun:test');
const express = require('express');

const {
  CameraStream,
  buildFfmpegArgs,
  normalizeCameraOptions,
  redactCameraError,
} = require('../camera-stream.js');

class FakeResponse extends EventEmitter {
  constructor(writeResults = []) {
    super();
    this.headers = {};
    this.statusCode = 200;
    this.writes = [];
    this.rawWrites = [];
    this.writeResults = [...writeResults];
    this.destroyed = false;
    this.writableEnded = false;
  }

  status(code) { this.statusCode = code; return this; }
  set(name, value) {
    if (typeof name === 'object') Object.assign(this.headers, name);
    else this.headers[name] = value;
    return this;
  }
  type(value) { this.headers['Content-Type'] = value; return this; }
  flushHeaders() {}
  write(value) {
    this.rawWrites.push(value);
    this.writes.push(Buffer.from(value));
    return this.writeResults.length ? this.writeResults.shift() : true;
  }
  cork() { this.corked = (this.corked || 0) + 1; }
  uncork() { this.uncorked = (this.uncorked || 0) + 1; }
  json(value) { this.body = value; this.writableEnded = true; return this; }
  send(value) { this.body = value; this.writableEnded = true; return this; }
  end() { this.writableEnded = true; }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 1234;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = [];
  }

  kill(signal) { this.kills.push(signal); return true; }
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false, unref() {} };
      pending.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    run(ms) {
      const timer = pending.find((item) => !item.cleared && item.ms === ms);
      assert.ok(timer, `expected a pending ${ms}ms timer`);
      timer.cleared = true;
      timer.fn();
    },
  };
}

function createHarness(config = {}, responseResults = []) {
  const children = [];
  const calls = [];
  const timers = fakeTimers();
  let now = 1000;
  const relay = new CameraStream({
    cameraRtspUrl: 'rtsp://user:secret@camera.local/live',
    cameraStreamStallMs: 5000,
    cameraStreamIdleMs: 1000,
    cameraStreamRestartBaseMs: 250,
    ...config,
  }, {
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    now: () => now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const subscribe = (results = responseResults) => {
    const req = new EventEmitter();
    const res = new FakeResponse(results);
    relay.handleMjpeg(req, res);
    return { req, res };
  };
  return { relay, calls, children, timers, subscribe, setNow: (value) => { now = value; } };
}

test('normalizes relay settings and builds a direct ffmpeg command', () => {
  const defaults = normalizeCameraOptions({ cameraRtspUrl: 'rtsp://camera/live' });
  assert.equal(defaults.fps, 24);
  assert.equal(defaults.maxFrameBytes, 16 * 1024 * 1024);
  const options = normalizeCameraOptions({
    cameraRtspUrl: ' rtsp://camera/live ',
    cameraStreamFps: 99,
    cameraStreamWidth: 1919,
    cameraStreamJpegQuality: 1,
    cameraFfmpegPath: 'C:\\ffmpeg\\ffmpeg.exe',
    cameraStreamMaxFrameBytes: 128 * 1024 * 1024,
  });
  assert.equal(options.enabled, true);
  assert.equal(options.fps, 30);
  assert.equal(options.width, 1918);
  assert.equal(options.jpegQuality, 2);
  assert.equal(options.threads, 4);
  assert.equal(options.ffmpegPath, 'C:\\ffmpeg\\ffmpeg.exe');
  assert.equal(options.maxFrameBytes, 64 * 1024 * 1024);

  const args = buildFfmpegArgs(options);
  assert.equal(args[args.indexOf('-i') + 1], 'rtsp://camera/live');
  assert.equal(args[args.indexOf('-rtsp_transport') + 1], 'tcp');
  assert.equal(args[args.indexOf('-timeout') + 1], String(options.ioTimeoutMs * 1000));
  assert.equal(args.includes('-rw_timeout'), false);
  assert.match(args[args.indexOf('-vf') + 1], /fps=30,scale=1918:-2/);
  assert.equal(args[args.indexOf('-filter_threads') + 1], '4');
  assert.equal(args.filter((arg) => arg === '-threads').length, 2);
});

test('fans split JPEG frames from one process out to every subscriber', () => {
  const harness = createHarness();
  const first = harness.subscribe();
  const second = harness.subscribe();
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].options.shell, false);
  assert.equal(harness.calls[0].options.windowsHide, true);

  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  harness.children[0].stdout.emit('data', jpeg.subarray(0, 3));
  harness.children[0].stdout.emit('data', jpeg.subarray(3));

  assert.equal(first.res.writes.length, 3);
  assert.equal(second.res.writes.length, 3);
  assert.ok(Buffer.concat(first.res.writes).includes(jpeg));
  assert.ok(first.res.rawWrites.includes(harness.relay.latestFrame));
  assert.match(first.res.headers['Content-Type'], /multipart\/x-mixed-replace/);
  assert.deepEqual(harness.relay.getStatus(), {
    enabled: true,
    running: true,
    online: true,
    state: 'live',
    subscribers: 2,
    lastFrameAt: 1000,
    lastFrameAgeMs: 0,
    frames: 1,
    targetFps: 24,
    measuredFps: null,
    outputWidth: 1920,
    jpegQuality: 5,
    threads: 4,
    latestFrameBytes: jpeg.length,
    outputBytesPerSec: null,
    estimatedEgressBytesPerSec: null,
    restartAttempts: 0,
    restartInMs: null,
    error: null,
  });
  harness.relay.close();
});

test('drops frames for a blocked client and idles only after the final disconnect', () => {
  const harness = createHarness();
  const slow = harness.subscribe([false, true]);
  const fast = harness.subscribe();
  const child = harness.children[0];
  const jpeg = Buffer.from([0xff, 0xd8, 0x03, 0xff, 0xd9]);

  child.stdout.emit('data', jpeg);
  child.stdout.emit('data', jpeg);
  assert.equal(slow.res.writes.length, 3);
  assert.equal(fast.res.writes.length, 6);
  slow.res.emit('drain');
  child.stdout.emit('data', jpeg);
  assert.equal(slow.res.writes.length, 6);

  slow.req.emit('aborted');
  assert.equal(child.kills.length, 0);
  fast.res.emit('close');
  harness.timers.run(1000);
  assert.deepEqual(child.kills, ['SIGTERM']);
  harness.relay.close();
});

test('keeps subscribers connected while a failed ffmpeg process backs off and restarts', () => {
  const harness = createHarness();
  const client = harness.subscribe();
  harness.children[0].stderr.emit('data', 'could not open rtsp://user:secret@camera.local/live');
  harness.children[0].emit('close', 1, null);

  const failed = harness.relay.getStatus();
  assert.equal(failed.running, false);
  assert.equal(failed.online, false);
  assert.equal(failed.state, 'reconnecting');
  assert.equal(failed.subscribers, 1);
  assert.doesNotMatch(JSON.stringify(failed), /user|secret|camera\.local/);

  harness.timers.run(250);
  assert.equal(harness.calls.length, 2);
  assert.equal(client.res.writableEnded, false);
  harness.relay.close();
});

test('does not start a second reader when an already-running child emits an error', () => {
  const harness = createHarness();
  harness.subscribe();
  harness.children[0].emit('error', Object.assign(new Error('kill failed'), { code: 'EPERM' }));
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.relay.getStatus().running, true);
  assert.equal(harness.relay.getStatus().subscribers, 1);
  harness.relay.close();
});

test('force-stops an ffmpeg child that ignores the graceful termination window', () => {
  const harness = createHarness({ cameraStreamKillGraceMs: 750 });
  harness.subscribe();
  const child = harness.children[0];

  harness.relay.close();
  assert.deepEqual(child.kills, ['SIGTERM']);
  harness.timers.run(750);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
});

test('serves the latest complete JPEG without starting a second reader', () => {
  const harness = createHarness();
  harness.subscribe();
  const jpeg = Buffer.from([0xff, 0xd8, 0x44, 0xff, 0xd9]);
  harness.children[0].stdout.emit('data', jpeg);

  const snapshot = new FakeResponse();
  harness.relay.handleSnapshot(new EventEmitter(), snapshot);
  assert.equal(snapshot.statusCode, 200);
  assert.deepEqual(snapshot.body, jpeg);
  assert.equal(snapshot.headers['Content-Type'], 'image/jpeg');
  assert.equal(harness.calls.length, 1);
  harness.relay.close();
});

test('reports measured frame and byte rates without storing frame history', () => {
  const harness = createHarness();
  harness.subscribe();
  const jpeg = Buffer.from([0xff, 0xd8, 0x44, 0x55, 0xff, 0xd9]);

  for (let index = 0; index <= 24; index += 1) {
    harness.setNow(1000 + Math.round(index * (1000 / 24)));
    harness.children[0].stdout.emit('data', jpeg);
  }

  const status = harness.relay.getStatus();
  assert.equal(status.measuredFps, 24);
  assert.equal(status.outputBytesPerSec, jpeg.length * 24);
  assert.equal(status.estimatedEgressBytesPerSec, jpeg.length * 24);
  assert.equal(harness.relay.latestFrame.length, jpeg.length);
  assert.equal(Object.hasOwn(harness.relay, 'frameHistory'), false);
  harness.relay.close();
});

test('redacts camera URLs and embedded credentials from diagnostic text', () => {
  const url = 'rtsp://alice:correct-horse@10.0.0.4/live';
  const safe = redactCameraError(`failed opening ${url}`, url);
  assert.doesNotMatch(safe, /alice|correct-horse|10\.0\.0\.4/);
  assert.match(safe, /redacted|camera/);
});

test('Express endpoints expose one shared stream and credential-safe status', async () => {
  const child = new FakeChild();
  let spawnCount = 0;
  const relay = new CameraStream({
    cameraRtspUrl: 'rtsp://user:secret@camera.local/live',
    cameraStreamStallMs: 5000,
    cameraStreamIdleMs: 1000,
  }, {
    spawn() { spawnCount += 1; return child; },
  });
  const app = express();
  app.get('/api/camera/status', (_req, res) => res.json(relay.getStatus()));
  app.get('/api/camera.mjpeg', (req, res) => relay.handleMjpeg(req, res));
  app.get('/api/camera.jpg', (req, res) => relay.handleSnapshot(req, res));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  onTestFinished(() => {
    relay.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = await fetch(`${base}/api/camera.mjpeg`, { signal: firstAbort.signal });
  const second = await fetch(`${base}/api/camera.mjpeg`, { signal: secondAbort.signal });
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type'), /multipart\/x-mixed-replace/);
  assert.equal(spawnCount, 1);

  const jpeg = Buffer.from([0xff, 0xd8, 0x55, 0x66, 0xff, 0xd9]);
  child.stdout.emit('data', jpeg);
  const [firstPart, secondPart] = await Promise.all([
    first.body.getReader().read(),
    second.body.getReader().read(),
  ]);
  assert.ok(Buffer.from(firstPart.value).includes(jpeg));
  assert.ok(Buffer.from(secondPart.value).includes(jpeg));

  const status = await fetch(`${base}/api/camera/status`).then((response) => response.json());
  assert.equal(status.online, true);
  assert.equal(status.subscribers, 2);
  assert.doesNotMatch(JSON.stringify(status), /user|secret|camera\.local/);

  const snapshot = await fetch(`${base}/api/camera.jpg`);
  assert.equal(snapshot.status, 200);
  assert.deepEqual(Buffer.from(await snapshot.arrayBuffer()), jpeg);
  firstAbort.abort();
  secondAbort.abort();
});

test('Express stream continues after a full-size frame applies backpressure', async () => {
  const child = new FakeChild();
  const relay = new CameraStream({
    cameraRtspUrl: 'rtsp://camera.local/live',
    cameraStreamStallMs: 5000,
    cameraStreamIdleMs: 1000,
  }, {
    spawn() { return child; },
  });
  const app = express();
  app.get('/api/camera.mjpeg', (req, res) => relay.handleMjpeg(req, res));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const abort = new AbortController();
  onTestFinished(() => {
    abort.abort();
    relay.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  });

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/camera.mjpeg`,
    { signal: abort.signal },
  );
  const reader = response.body.getReader();
  const secondMarker = Buffer.from([0xff, 0xd8, 0x22, 0x33, 0x44]);
  let received = Buffer.alloc(0);
  let resolveSecond;
  let rejectSecond;
  const sawSecond = new Promise((resolve, reject) => {
    resolveSecond = resolve;
    rejectSecond = reject;
  });
  const timeout = setTimeout(() => rejectSecond(new Error('second MJPEG frame was not delivered')), 1000);
  const consume = (async () => {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) throw new Error('MJPEG response ended before the second frame');
        received = Buffer.concat([received, Buffer.from(part.value)]);
        if (received.indexOf(secondMarker) >= 0) {
          resolveSecond();
          return;
        }
      }
    } catch (error) {
      rejectSecond(error);
    }
  })();

  const first = Buffer.alloc(220000, 0x11);
  first[0] = 0xff;
  first[1] = 0xd8;
  first[first.length - 2] = 0xff;
  first[first.length - 1] = 0xd9;
  const second = Buffer.alloc(220000, 0x22);
  secondMarker.copy(second, 0);
  second[second.length - 2] = 0xff;
  second[second.length - 1] = 0xd9;

  child.stdout.emit('data', first);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit('data', second);
  await sawSecond;
  clearTimeout(timeout);
  await consume;
  assert.ok(received.indexOf(secondMarker) >= 0);
});
