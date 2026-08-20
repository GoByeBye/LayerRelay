'use strict';
// Transport and auth tests for the static build's cloud mode:
// pages/app/mqtt.mjs (MQTT 3.1.1 over WebSocket) and pages/app/connect-auth.mjs
// (Prusa account OAuth with a rotating refresh token).
//
// No test opens a network connection, and no test touches a printer, a broker
// or the live Prusa account service: every WebSocket, fetch, clock, timer,
// storage and BroadcastChannel is an injected fake. Expected MQTT packet bytes
// are written out by hand from the MQTT 3.1.1 specification rather than
// captured from the encoder under test.

const assert = require('node:assert/strict');
const { test } = require('bun:test');

const MQTT_PATH = '../pages/app/mqtt.mjs';
const AUTH_PATH = '../pages/app/connect-auth.mjs';
const TOKEN_URL = 'https://account.prusa3d.com/o/token/';
const ME_URL = 'https://account.prusa3d.com/api/v1/me';
const CLIENT_ID = 'MRHTlZhZqkNrrQ6FUPtjyusAz8nc59ErHXP8XkS4'; // gitleaks:allow -- public browser client identifier
const STORAGE_KEY = 'layer-relay.static.connect';
const BACKUP_KEY = 'layer-relay.static.connect.last-good';
const LOCK_KEY = 'layer-relay.static.connect.lock';
const UUID = 'aabbccdd-1122';

// ---------------------------------------------------------------------------
// shared fakes
// ---------------------------------------------------------------------------

// Virtual clock plus timers. Nothing fires until a test advances the clock, so
// keepalive, lock polling and lock heartbeats are fully deterministic.
function makeClock(startMs = 1700000000000) {
  let current = startMs;
  let seq = 0;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      seq += 1;
      pending.set(seq, { fn, at: current + Math.max(0, Number(ms) || 0) });
      return seq;
    },
    clearTimeout(handle) { pending.delete(handle); },
  };
  async function flush() {
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  }
  async function advance(ms) {
    const target = current + Math.max(0, ms);
    for (;;) {
      let dueId = null;
      let dueAt = Infinity;
      for (const [id, timer] of pending) {
        if (timer.at <= target && timer.at < dueAt) { dueAt = timer.at; dueId = id; }
      }
      if (dueId === null) break;
      const timer = pending.get(dueId);
      pending.delete(dueId);
      current = Math.max(current, timer.at);
      timer.fn();
      await flush();
    }
    current = target;
    await flush();
  }
  return {
    now: () => current,
    timers,
    advance,
    flush,
    pendingTimers: () => pending.size,
  };
}

// Drives the virtual clock until a promise settles, so code that waits on a
// peer tab or on a keepalive deadline finishes without a real timer.
async function settle(clock, promise, { step = 100, steps = 400 } = {}) {
  let done = false;
  const tracked = promise.then(
    (value) => { done = true; return value; },
    (error) => { done = true; throw error; },
  );
  tracked.catch(() => {});
  await clock.flush();
  for (let i = 0; i < steps && !done; i += 1) await clock.advance(step);
  return tracked;
}

function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const store = {
    failWrites: null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (store.failWrites && store.failWrites(key)) throw new Error('quota exceeded');
      map.set(key, String(value));
    },
    removeItem: (key) => { map.delete(key); },
    entries: () => [...map.entries()],
    keys: () => [...map.keys()],
  };
  return store;
}

function makeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const key = String(url);
    calls.push({ url: key, init: init || {} });
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected fetch for ${key}`);
    return handler(init || {}, calls.filter((call) => call.url === key).length);
  };
  return { fetchImpl, calls, countFor: (url) => calls.filter((c) => c.url === url).length };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Same-origin channel hub: a message posted on one endpoint reaches the other
// endpoints only, exactly like BroadcastChannel.
function makeChannelHub() {
  const endpoints = [];
  const posted = [];
  function endpoint() {
    const listeners = new Set();
    const ep = {
      listeners,
      postMessage(data) {
        posted.push(data);
        for (const other of endpoints) {
          if (other === ep) continue;
          for (const fn of [...other.listeners]) fn({ data });
        }
      },
      addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    };
    endpoints.push(ep);
    return ep;
  }
  return { endpoint, posted };
}

function makeSockets() {
  const sockets = [];
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.binaryType = 'blob';
      this.sent = [];
      this.closeCalls = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      sockets.push(this);
    }

    send(data) {
      if (this.readyState !== 1) throw new Error('socket is not open');
      this.sent.push(new Uint8Array(data));
    }

    close() {
      this.closeCalls += 1;
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000, reason: 'client close' });
    }

    // test drivers
    fireOpen() { this.readyState = 1; if (this.onopen) this.onopen({}); }

    fireBytes(bytes) {
      const copy = new Uint8Array(bytes);
      if (this.onmessage) this.onmessage({ data: copy.buffer });
    }

    fireView(bytes) {
      if (this.onmessage) this.onmessage({ data: new Uint8Array(bytes) });
    }

    fireRaw(data) { if (this.onmessage) this.onmessage({ data }); }

    fireServerClose(code) {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code });
    }
  }
  return { FakeWebSocket, sockets };
}

function collect(client) {
  const events = [];
  for (const name of ['open', 'connack', 'suback', 'message', 'error', 'close']) {
    client.on(name, (payload) => { events.push({ name, payload }); });
  }
  return {
    events,
    names: () => events.map((entry) => entry.name),
    of: (name) => events.filter((entry) => entry.name === name).map((entry) => entry.payload),
  };
}

const ascii = (text) => [...text].map((char) => char.charCodeAt(0));

// ---------------------------------------------------------------------------
// MQTT packet encoding, byte for byte against MQTT 3.1.1
// ---------------------------------------------------------------------------

test('encodeConnect matches the MQTT 3.1.1 CONNECT byte layout', async () => {
  const mqtt = await import(MQTT_PATH);
  // Fixed header 0x10 (CONNECT, reserved flags 0), remaining length 25.
  // Variable header: protocol name "MQTT", level 4, connect flags
  // 0xC2 = username (0x80) + password (0x40) + clean session (0x02),
  // keepalive 60 = 0x003C. Payload: client id, username, password.
  const expected = Uint8Array.from([
    0x10, 0x19,
    0x00, 0x04, 0x4d, 0x51, 0x54, 0x54,
    0x04,
    0xc2,
    0x00, 0x3c,
    0x00, 0x04, 0x6c, 0x72, 0x2d, 0x31,
    0x00, 0x02, 0x34, 0x32,
    0x00, 0x03, 0x74, 0x6f, 0x6b,
  ]);
  const actual = mqtt.encodeConnect({
    clientId: 'lr-1',
    username: '42',
    password: 'tok',
    keepalive: 60,
  });
  assert.ok(actual instanceof Uint8Array);
  assert.equal(actual.length, 27);
  assert.deepEqual([...actual], [...expected]);
});

test('encodeConnect drops the credential flags and fields when absent', async () => {
  const mqtt = await import(MQTT_PATH);
  // Clean session only (0x02), keepalive 30 = 0x001E, remaining length 14.
  const expected = Uint8Array.from([
    0x10, 0x0e,
    0x00, 0x04, 0x4d, 0x51, 0x54, 0x54,
    0x04,
    0x02,
    0x00, 0x1e,
    0x00, 0x02, 0x69, 0x64,
  ]);
  assert.deepEqual(
    [...mqtt.encodeConnect({ clientId: 'id', keepalive: 30 })],
    [...expected],
  );
});

test('encodeConnect encodes a multi-byte remaining length little endian', async () => {
  const mqtt = await import(MQTT_PATH);
  const password = 'p'.repeat(300);
  const packet = mqtt.encodeConnect({
    clientId: 'lr-1',
    username: '42',
    password,
    keepalive: 60,
  });
  // 10 variable header bytes + (2 + 4) + (2 + 2) + (2 + 300) = 322 bytes.
  // 322 = 2 * 128 + 66, so the varint is 0xC2 0x02 (continuation on the first).
  assert.equal(packet[0], 0x10);
  assert.equal(packet[1], 0xc2);
  assert.equal(packet[2], 0x02);
  assert.equal(packet.length, 3 + 322);
});

test('encodeSubscribe matches the MQTT 3.1.1 SUBSCRIBE byte layout', async () => {
  const mqtt = await import(MQTT_PATH);
  // Fixed header 0x82 (SUBSCRIBE with the reserved 0b0010 flags), remaining
  // length 12, packet id 0x0102, then each filter followed by requested QoS 0.
  const expected = Uint8Array.from([
    0x82, 0x0c,
    0x01, 0x02,
    0x00, 0x03, 0x61, 0x2f, 0x23,
    0x00,
    0x00, 0x01, 0x62,
    0x00,
  ]);
  assert.deepEqual([...mqtt.encodeSubscribe(258, ['a/#', 'b'])], [...expected]);
});

test('encodeSubscribe carries a full Connect printer topic filter', async () => {
  const mqtt = await import(MQTT_PATH);
  const filter = 'v1/devices/printers/abc/#';
  assert.equal(filter.length, 25);
  const expected = Uint8Array.from([
    0x82, 0x1e,
    0x00, 0x01,
    0x00, 0x19,
    ...ascii(filter),
    0x00,
  ]);
  assert.deepEqual([...mqtt.encodeSubscribe(1, [filter])], [...expected]);
});

test('encodePing and encodeDisconnect are the two-byte control packets', async () => {
  const mqtt = await import(MQTT_PATH);
  assert.deepEqual([...mqtt.encodePing()], [0xc0, 0x00]);
  assert.deepEqual([...mqtt.encodeDisconnect()], [0xe0, 0x00]);
});

test('packet encoders reject malformed input', async () => {
  const mqtt = await import(MQTT_PATH);
  assert.throws(() => mqtt.encodeConnect({ clientId: '' }), TypeError);
  assert.throws(() => mqtt.encodeConnect({}), TypeError);
  assert.throws(() => mqtt.encodeSubscribe(0, ['a']), TypeError);
  assert.throws(() => mqtt.encodeSubscribe(70000, ['a']), TypeError);
  assert.throws(() => mqtt.encodeSubscribe(1, []), TypeError);
  assert.throws(() => mqtt.encodeSubscribe(1, ['']), TypeError);
  assert.throws(() => mqtt.encodeConnect({ clientId: 'a', username: 'u'.repeat(70000) }), RangeError);
});

// ---------------------------------------------------------------------------
// incremental parser and PUBLISH decoding
// ---------------------------------------------------------------------------

test('parser reassembles packets across byte-by-byte splits', async () => {
  const mqtt = await import(MQTT_PATH);
  const feed = mqtt.createParser();
  // CONNACK (0x20, len 2, no session present, accepted) then PINGRESP.
  const stream = Uint8Array.from([0x20, 0x02, 0x00, 0x00, 0xd0, 0x00]);
  const packets = [];
  for (const byte of stream) packets.push(...feed(Uint8Array.of(byte)));
  assert.equal(packets.length, 2);
  assert.equal(packets[0].type, 2);
  assert.deepEqual([...packets[0].body], [0x00, 0x00]);
  assert.equal(packets[1].type, 13);
  assert.equal(packets[1].body.length, 0);
});

test('parser splits several packets out of one merged chunk and keeps the tail', async () => {
  const mqtt = await import(MQTT_PATH);
  const feed = mqtt.createParser();
  const merged = Uint8Array.from([
    0x20, 0x02, 0x00, 0x00, // CONNACK
    0x90, 0x03, 0x00, 0x01, 0x00, // SUBACK, packet id 1, granted qos 0
    0x30, 0x05, 0x00, 0x01, 0x61, // PUBLISH "a" but two payload bytes short
  ]);
  const first = feed(merged);
  assert.equal(first.length, 2);
  assert.equal(first[0].type, 2);
  assert.equal(first[1].type, 9);
  assert.deepEqual([...first[1].body], [0x00, 0x01, 0x00]);
  const second = feed(Uint8Array.from([0x68, 0x69]));
  assert.equal(second.length, 1);
  assert.equal(second[0].type, 3);
  assert.equal(mqtt.decodePublish(second[0].body, second[0].flags).payload, 'hi');
});

test('parser handles a two-byte remaining length', async () => {
  const mqtt = await import(MQTT_PATH);
  const feed = mqtt.createParser();
  const payload = new Uint8Array(200).fill(0x41);
  const body = Uint8Array.from([0x00, 0x01, 0x61, ...payload]);
  // 203 = 1 * 128 + 75, so the varint is 0xCB 0x01.
  const packet = Uint8Array.from([0x30, 0xcb, 0x01, ...body]);
  assert.equal(body.length, 203);
  const half = Math.floor(packet.length / 2);
  assert.equal(feed(packet.subarray(0, half)).length, 0);
  const rest = feed(packet.subarray(half));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].body.length, 203);
  assert.equal(mqtt.decodePublish(rest[0].body, rest[0].flags).payload.length, 200);
});

test('parser rejects a remaining length longer than four bytes', async () => {
  const mqtt = await import(MQTT_PATH);
  const feed = mqtt.createParser();
  assert.throws(
    () => feed(Uint8Array.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x01])),
    /malformed MQTT remaining length/,
  );
});

test('decodePublish reads the retained flag, the topic and a QoS 1 packet id', async () => {
  const mqtt = await import(MQTT_PATH);
  const topic = 'v1/devices/printers/abc/data/state';
  const body = Uint8Array.from([
    (topic.length >> 8) & 0xff, topic.length & 0xff,
    ...ascii(topic),
    ...ascii('PRINTING'),
  ]);
  const retained = mqtt.decodePublish(body, 0x01);
  assert.deepEqual(retained, { topic, payload: 'PRINTING', retained: true });
  assert.equal(mqtt.decodePublish(body, 0x00).retained, false);

  const qos1 = Uint8Array.from([
    0x00, 0x03, ...ascii('a/b'),
    0x12, 0x34, // packet identifier, skipped above QoS 0
    ...ascii('9'),
  ]);
  assert.deepEqual(mqtt.decodePublish(qos1, 0x02), {
    topic: 'a/b',
    payload: '9',
    retained: false,
  });
  assert.equal(mqtt.decodePublish(qos1, 0x03).retained, true);
});

test('decodePublish decodes UTF-8 payloads and rejects truncated packets', async () => {
  const mqtt = await import(MQTT_PATH);
  const payload = new TextEncoder().encode('30.8 °C');
  const body = Uint8Array.from([0x00, 0x01, 0x74, ...payload]);
  assert.equal(mqtt.decodePublish(body, 0x00).payload, '30.8 °C');
  assert.throws(() => mqtt.decodePublish(Uint8Array.of(0x00), 0x00), /malformed MQTT PUBLISH/);
  assert.throws(() => mqtt.decodePublish(Uint8Array.of(0x00, 0x09, 0x61), 0x00), /topic/);
});

// ---------------------------------------------------------------------------
// createMqttClient over a fake WebSocket
// ---------------------------------------------------------------------------

function makeClient(mqtt, clock, sockets, overrides = {}) {
  return mqtt.createMqttClient({
    url: 'wss://mqtt.prusa3d.com:8084/mqtt',
    clientId: 'lr-1',
    username: '42',
    password: 'tok',
    WebSocketImpl: sockets.FakeWebSocket,
    timers: clock.timers,
    ...overrides,
  });
}

test('mqtt client runs open, connack, suback, publish and close', async () => {
  const mqtt = await import(MQTT_PATH);
  const clock = makeClock();
  const sockets = makeSockets();
  const client = makeClient(mqtt, clock, sockets);
  const seen = collect(client);

  client.connect();
  assert.equal(sockets.sockets.length, 1);
  const socket = sockets.sockets[0];
  assert.equal(socket.url, 'wss://mqtt.prusa3d.com:8084/mqtt');
  assert.equal(socket.protocols, 'mqtt');
  assert.equal(socket.binaryType, 'arraybuffer');

  socket.fireOpen();
  assert.deepEqual(seen.names(), ['open']);
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(
    [...socket.sent[0]],
    [...mqtt.encodeConnect({ clientId: 'lr-1', username: '42', password: 'tok', keepalive: 60 })],
  );

  socket.fireBytes([0x20, 0x02, 0x00, 0x00]);
  assert.deepEqual(seen.of('connack'), [{ sessionPresent: false, returnCode: 0 }]);

  const filter = `v1/devices/printers/${UUID}/#`;
  const packetId = client.subscribe([filter]);
  assert.equal(packetId, 1);
  assert.deepEqual([...socket.sent[1]], [...mqtt.encodeSubscribe(1, [filter])]);

  socket.fireBytes([0x90, 0x03, 0x00, 0x01, 0x00]);
  assert.deepEqual(seen.of('suback'), [{ packetId: 1, granted: [0] }]);

  const topic = `v1/devices/printers/${UUID}/data/state`;
  socket.fireView([
    0x31, 2 + topic.length + 8,
    (topic.length >> 8) & 0xff, topic.length & 0xff,
    ...ascii(topic),
    ...ascii('PRINTING'),
  ]);
  assert.deepEqual(seen.of('message'), [{ topic, payload: 'PRINTING', retained: true }]);

  client.close();
  assert.deepEqual([...socket.sent[2]], [0xe0, 0x00]);
  assert.deepEqual(seen.of('close'), [{ reason: 'local', code: null }]);
  assert.equal(seen.of('error').length, 0);

  // close is idempotent and never fires a second event.
  client.close();
  socket.fireServerClose(1006);
  assert.equal(seen.of('close').length, 1);
  assert.equal(clock.pendingTimers(), 0);
});

test('mqtt client buffers subscriptions taken before connack', async () => {
  const mqtt = await import(MQTT_PATH);
  const clock = makeClock();
  const sockets = makeSockets();
  const client = makeClient(mqtt, clock, sockets);
  const seen = collect(client);

  client.connect();
  const socket = sockets.sockets[0];
  const first = client.subscribe('a/#');
  const second = client.subscribe(['b/#']);
  assert.equal(first, 1);
  assert.equal(second, 2);
  socket.fireOpen();
  assert.equal(socket.sent.length, 1); // CONNECT only

  socket.fireBytes([0x20, 0x02, 0x00, 0x00]);
  assert.equal(socket.sent.length, 3);
  assert.deepEqual([...socket.sent[1]], [...mqtt.encodeSubscribe(1, ['a/#'])]);
  assert.deepEqual([...socket.sent[2]], [...mqtt.encodeSubscribe(2, ['b/#'])]);
  assert.equal(seen.of('error').length, 0);
  client.close();
});

test('mqtt client pings every 30s and dies when a pingresp is missing', async () => {
  const mqtt = await import(MQTT_PATH);
  const clock = makeClock();
  const sockets = makeSockets();
  const client = makeClient(mqtt, clock, sockets);
  const seen = collect(client);

  client.connect();
  const socket = sockets.sockets[0];
  socket.fireOpen();
  socket.fireBytes([0x20, 0x02, 0x00, 0x00]);

  await clock.advance(29000);
  assert.equal(socket.sent.length, 1);
  await clock.advance(1500);
  assert.deepEqual([...socket.sent[1]], [0xc0, 0x00]);

  // A PINGRESP inside the deadline keeps the link alive.
  socket.fireBytes([0xd0, 0x00]);
  await clock.advance(20000);
  assert.equal(seen.of('close').length, 0);

  // The next ping goes unanswered, so the link is declared dead after 15s.
  await clock.advance(11000);
  assert.deepEqual([...socket.sent[2]], [0xc0, 0x00]);
  await clock.advance(13000);
  assert.equal(seen.of('close').length, 0);
  await clock.advance(2000);
  const errors = seen.of('error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ping_timeout');
  assert.deepEqual(seen.of('close'), [{ reason: 'ping_timeout', code: null }]);
  assert.equal(sockets.sockets.length, 1); // never reconnects by itself
  assert.equal(clock.pendingTimers(), 0);
  await clock.advance(120000);
  assert.equal(sockets.sockets.length, 1);
});

test('mqtt client surfaces a refused connack and stops', async () => {
  const mqtt = await import(MQTT_PATH);
  const clock = makeClock();
  const sockets = makeSockets();
  const client = makeClient(mqtt, clock, sockets);
  const seen = collect(client);

  client.connect();
  const socket = sockets.sockets[0];
  socket.fireOpen();
  socket.fireBytes([0x20, 0x02, 0x00, 0x05]); // not authorized
  const errors = seen.of('error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'connack');
  assert.equal(errors[0].returnCode, 5);
  assert.match(errors[0].message, /not authorized/);
  assert.equal(seen.of('close').length, 1);
  assert.equal(socket.sent.length, 1); // no DISCONNECT after a refusal
  await clock.advance(60000);
  assert.equal(sockets.sockets.length, 1);
});

test('mqtt client reports a socket close, a bad frame and a failed constructor once', async () => {
  const mqtt = await import(MQTT_PATH);
  const clock = makeClock();

  const sockets = makeSockets();
  const dropped = makeClient(mqtt, clock, sockets);
  const droppedSeen = collect(dropped);
  dropped.connect();
  sockets.sockets[0].fireOpen();
  sockets.sockets[0].fireServerClose(1006);
  assert.deepEqual(droppedSeen.of('close'), [{ reason: 'socket', code: 1006 }]);

  const textSockets = makeSockets();
  const text = makeClient(mqtt, clock, textSockets);
  const textSeen = collect(text);
  text.connect();
  textSockets.sockets[0].fireOpen();
  textSockets.sockets[0].fireRaw('not binary');
  assert.equal(textSeen.of('error')[0].code, 'protocol');
  assert.equal(textSeen.of('close').length, 1);

  const brokenSeen = [];
  const broken = mqtt.createMqttClient({
    url: 'wss://example.invalid/mqtt',
    clientId: 'lr-1',
    timers: clock.timers,
    WebSocketImpl: function Broken() { throw new Error('blocked'); },
  });
  broken.on('error', (error) => brokenSeen.push(['error', error.code]));
  broken.on('close', (payload) => brokenSeen.push(['close', payload.reason]));
  broken.connect();
  broken.connect();
  assert.deepEqual(brokenSeen, [['error', 'socket'], ['close', 'socket']]);
});

test('mqtt client survives a throwing listener and a malformed stream', async () => {
  const mqtt = await import(MQTT_PATH);
  const clock = makeClock();
  const sockets = makeSockets();
  const client = makeClient(mqtt, clock, sockets);
  const errors = [];
  client.on('connack', () => { throw new Error('listener fault'); });
  client.on('error', (error) => errors.push(error.code));
  client.connect();
  const socket = sockets.sockets[0];
  socket.fireOpen();
  socket.fireBytes([0x20, 0x02, 0x00, 0x00]);
  assert.deepEqual(errors, []);
  socket.fireBytes([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]);
  assert.deepEqual(errors, ['protocol']);
});

// ---------------------------------------------------------------------------
// connect-auth: rotation, cross-tab lock, caching and typed errors
// ---------------------------------------------------------------------------

function tokenBody(access, refresh, expiresIn = 7200) {
  return jsonResponse({
    access_token: access,
    refresh_token: refresh,
    expires_in: expiresIn,
    token_type: 'Bearer',
    scope: 'basic_info user_operations email_lists openid connect',
  });
}

function readRecord(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function makeAuth(overrides = {}) {
  const mod = await import(AUTH_PATH);
  const clock = overrides.clock || makeClock();
  const storage = overrides.storage || memStorage();
  const handlers = overrides.handlers || {};
  const fetcher = overrides.fetcher || makeFetch(handlers);
  const auth = mod.createConnectAuth({
    storage,
    fetchImpl: fetcher.fetchImpl,
    now: clock.now,
    timers: clock.timers,
    broadcast: overrides.broadcast === undefined ? null : overrides.broadcast,
    randomId: overrides.randomId || (() => 'owner-under-test'),
    ...(overrides.options || {}),
  });
  return { mod, auth, clock, storage, fetcher };
}

test('configure validates input and stores only the token, uuid and timestamp', async () => {
  const { auth, storage, clock } = await makeAuth();
  assert.throws(() => auth.configure(null), TypeError);
  assert.throws(() => auth.configure({ refreshToken: '', printerUuid: UUID }), TypeError);
  assert.throws(() => auth.configure({ refreshToken: 'has space', printerUuid: UUID }), TypeError);
  assert.throws(() => auth.configure({ refreshToken: 'T1', printerUuid: 'nope' }), TypeError);
  // A uuid carrying an MQTT wildcard would widen the subscription filter.
  assert.throws(() => auth.configure({ refreshToken: 'T1', printerUuid: 'aabbccdd/#' }), TypeError);
  assert.throws(() => auth.configure({ refreshToken: 'T1', printerUuid: 'aabbccdd 1122' }), TypeError);
  assert.throws(() => auth.configure({ refreshToken: 'T1', printerUuid: '_aabbccdd' }), TypeError);
  // The accepted character set matches state-engine's normalizeConnectPrinterId,
  // so an id the engine allows is never rejected here.
  auth.configure({ refreshToken: 'T1', printerUuid: 'zz_printer-01' });
  assert.equal(auth.getConfig().printerUuid, 'zz_printer-01');

  auth.configure({ refreshToken: '  T1  ', printerUuid: ` ${UUID} ` });
  const record = readRecord(storage);
  assert.equal(record.refreshToken, 'T1');
  assert.equal(record.printerUuid, UUID);
  assert.equal(record.savedAt, clock.now());
  assert.equal(record.accessToken, null);
  assert.deepEqual(auth.getConfig(), { configured: true, printerUuid: UUID });
});

test('getAccessToken persists the rotated refresh token before returning', async () => {
  const handlers = {
    [TOKEN_URL]: (init, call) => tokenBody(`access-${call}`, `T${call + 1}`),
  };
  const { auth, storage, fetcher, clock } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });

  const token = await settle(clock, auth.getAccessToken());
  assert.equal(token, 'access-1');
  const record = readRecord(storage);
  assert.equal(record.refreshToken, 'T2');
  assert.equal(record.accessToken, 'access-1');
  assert.equal(record.accessExpiresAt, record.savedAt + 7200000);
  assert.ok(record.accessExpiresAt > clock.now() + 7100000);
  const backup = JSON.parse(storage.getItem(BACKUP_KEY));
  assert.equal(backup.refreshToken, 'T2');
  assert.equal(backup.state, 'good');
  assert.equal(storage.getItem(LOCK_KEY), null); // lock released

  const call = fetcher.calls[0];
  assert.equal(call.url, TOKEN_URL);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.headers.Authorization, undefined);
  assert.equal(
    call.init.body,
    `grant_type=refresh_token&refresh_token=T1&client_id=${CLIENT_ID}`,
  );
});

test('a storage write failure refuses to hand out the access token', async () => {
  const handlers = { [TOKEN_URL]: (init, call) => tokenBody(`access-${call}`, `T${call + 1}`) };
  const { auth, storage, fetcher, clock } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });
  storage.failWrites = (key) => key === STORAGE_KEY;

  await assert.rejects(
    settle(clock, auth.getAccessToken()),
    (error) => error.code === 'storage',
  );
  assert.equal(readRecord(storage).refreshToken, 'T1'); // old copy is untouched
  assert.equal(auth.inspect().storageFailed, true);

  // The rotated token is not spent a second time while storage stays broken.
  await assert.rejects(settle(clock, auth.getAccessToken()), (error) => error.code === 'storage');
  assert.equal(fetcher.countFor(TOKEN_URL), 1);

  storage.failWrites = null;
  assert.equal(await settle(clock, auth.getAccessToken()), 'access-1');
  assert.equal(fetcher.countFor(TOKEN_URL), 1);
  assert.equal(readRecord(storage).refreshToken, 'T2');
});

test('a cached access token is reused until the 60s window before expiry', async () => {
  const handlers = { [TOKEN_URL]: (init, call) => tokenBody(`access-${call}`, `T${call + 1}`) };
  const { auth, fetcher, clock } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });

  assert.equal(await settle(clock, auth.getAccessToken()), 'access-1');
  assert.equal(await settle(clock, auth.getAccessToken()), 'access-1');
  assert.equal(fetcher.countFor(TOKEN_URL), 1);

  await clock.advance(7200000 - 61000);
  assert.equal(await settle(clock, auth.getAccessToken()), 'access-1');
  assert.equal(fetcher.countFor(TOKEN_URL), 1);

  await clock.advance(2000);
  assert.equal(await settle(clock, auth.getAccessToken()), 'access-2');
  assert.equal(fetcher.countFor(TOKEN_URL), 2);
});

test('concurrent calls in one tab spend the refresh token once', async () => {
  const handlers = { [TOKEN_URL]: (init, call) => tokenBody(`access-${call}`, `T${call + 1}`) };
  const { auth, fetcher, clock } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });

  const pending = [auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()];
  const tokens = await settle(clock, Promise.all(pending));
  assert.deepEqual(tokens, ['access-1', 'access-1', 'access-1']);
  assert.equal(fetcher.countFor(TOKEN_URL), 1);
});

test('a lock held by another tab blocks the refresh and reuses its result', async () => {
  const handlers = { [TOKEN_URL]: () => { throw new Error('the locked tab must not refresh'); } };
  const { auth, storage, fetcher, clock } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });
  storage.setItem(LOCK_KEY, JSON.stringify({ owner: 'peer-tab', expiresAt: clock.now() + 15000 }));

  const pending = auth.getAccessToken();
  await clock.advance(1000);
  assert.equal(fetcher.countFor(TOKEN_URL), 0);
  assert.equal(JSON.parse(storage.getItem(LOCK_KEY)).owner, 'peer-tab');

  // The peer finishes: it rotated the token and published the access token.
  storage.setItem(STORAGE_KEY, JSON.stringify({
    refreshToken: 'T2',
    printerUuid: UUID,
    savedAt: clock.now(),
    accessToken: 'peer-access',
    accessExpiresAt: clock.now() + 7200000,
    userId: null,
  }));
  storage.removeItem(LOCK_KEY);

  assert.equal(await settle(clock, pending), 'peer-access');
  assert.equal(fetcher.countFor(TOKEN_URL), 0);
  assert.equal(readRecord(storage).refreshToken, 'T2');
});

test('an expired peer lock is taken over and released to the new owner', async () => {
  const handlers = { [TOKEN_URL]: (init, call) => tokenBody(`access-${call}`, `T${call + 1}`) };
  const { auth, storage, fetcher, clock } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });
  storage.setItem(LOCK_KEY, JSON.stringify({ owner: 'dead-tab', expiresAt: clock.now() - 1 }));

  assert.equal(await settle(clock, auth.getAccessToken()), 'access-1');
  assert.equal(fetcher.countFor(TOKEN_URL), 1);
  assert.equal(storage.getItem(LOCK_KEY), null);
});

test('a slow refresh keeps its lock alive and never drops a peer lock', async () => {
  let release = null;
  const handlers = {
    [TOKEN_URL]: () => new Promise((resolve) => {
      release = () => resolve(tokenBody('access-slow', 'T2'));
    }),
  };
  const { auth, storage, clock } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });

  const pending = auth.getAccessToken();
  await clock.advance(100);
  const claimed = JSON.parse(storage.getItem(LOCK_KEY));
  assert.equal(claimed.owner, 'owner-under-test');

  // Well past the 15s TTL, the heartbeat has pushed the lock forward.
  await clock.advance(40000);
  const renewed = JSON.parse(storage.getItem(LOCK_KEY));
  assert.equal(renewed.owner, 'owner-under-test');
  assert.ok(renewed.expiresAt > clock.now(), 'lock must still be in the future');

  // If a peer does take the lock anyway, releasing must not evict it.
  storage.setItem(LOCK_KEY, JSON.stringify({ owner: 'peer-tab', expiresAt: clock.now() + 15000 }));
  release();
  assert.equal(await settle(clock, pending), 'access-slow');
  assert.equal(JSON.parse(storage.getItem(LOCK_KEY)).owner, 'peer-tab');
  assert.equal(readRecord(storage).refreshToken, 'T2');
});

test('waiting for a stuck peer times out with a typed network error', async () => {
  const handlers = { [TOKEN_URL]: () => { throw new Error('must not refresh'); } };
  const { auth, storage, clock } = await makeAuth({
    handlers,
    options: { lockWaitMs: 1000 },
  });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });
  storage.setItem(LOCK_KEY, JSON.stringify({ owner: 'peer-tab', expiresAt: clock.now() + 600000 }));

  await assert.rejects(
    settle(clock, auth.getAccessToken()),
    (error) => error.code === 'network' && /another tab/.test(error.message),
  );
});

test('a waiting tab accepts the access token shared over the channel', async () => {
  const hub = makeChannelHub();
  const handlers = { [TOKEN_URL]: () => { throw new Error('must not refresh'); } };
  const { auth, storage, fetcher, clock } = await makeAuth({
    handlers,
    broadcast: hub.endpoint(),
  });
  const peerChannel = hub.endpoint();
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });
  storage.setItem(LOCK_KEY, JSON.stringify({ owner: 'peer-tab', expiresAt: clock.now() + 600000 }));

  const pending = auth.getAccessToken();
  await clock.advance(500);
  peerChannel.postMessage({
    type: 'layer-relay.connect.access',
    accessToken: 'channel-access',
    expiresAt: clock.now() + 7200000,
  });
  assert.equal(await settle(clock, pending), 'channel-access');
  assert.equal(fetcher.countFor(TOKEN_URL), 0);
});

test('a refreshing tab shares the access token but never the refresh token', async () => {
  const hub = makeChannelHub();
  const handlers = { [TOKEN_URL]: () => tokenBody('access-1', 'T2') };
  const { auth, clock } = await makeAuth({ handlers, broadcast: hub.endpoint() });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });
  await settle(clock, auth.getAccessToken());

  assert.equal(hub.posted.length, 1);
  assert.equal(hub.posted[0].accessToken, 'access-1');
  const wire = JSON.stringify(hub.posted);
  assert.ok(!wire.includes('T2'), 'the refresh token must never be broadcast');
  assert.ok(!wire.includes('T1'), 'the spent refresh token must never be broadcast');
});

test('invalid_grant is typed, actionable and not retried against the account service', async () => {
  const handlers = {
    [TOKEN_URL]: (init, call) => (call === 1
      ? jsonResponse({ error: 'invalid_grant', error_description: 'expired' }, 400)
      : tokenBody('access-new', 'T9')),
  };
  const { auth, storage, fetcher, clock } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });

  await assert.rejects(settle(clock, auth.getAccessToken()), (error) => {
    assert.equal(error.code, 'invalid_grant');
    assert.equal(error.name, 'ConnectAuthError');
    assert.match(error.message, /docs\/prusa-connect\.md/);
    assert.match(error.message, /only be spent once/);
    return true;
  });
  assert.equal(auth.inspect().invalidGrant, true);
  assert.equal(storage.getItem(LOCK_KEY), null);

  // Sticky: the same dead token is not sent again.
  await assert.rejects(settle(clock, auth.getAccessToken()), (error) => error.code === 'invalid_grant');
  assert.equal(fetcher.countFor(TOKEN_URL), 1);

  // A peer tab that legitimately rotated the chain clears the sticky state.
  const record = readRecord(storage);
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...record, refreshToken: 'T5' }));
  assert.equal(await settle(clock, auth.getAccessToken()), 'access-new');
  assert.equal(fetcher.countFor(TOKEN_URL), 2);
  assert.equal(auth.inspect().invalidGrant, false);
});

test('a fresh configure clears a rejected token chain', async () => {
  const handlers = {
    [TOKEN_URL]: (init, call) => (call === 1
      ? jsonResponse({ error: 'invalid_grant' }, 400)
      : tokenBody('access-2', 'T3')),
  };
  const { auth, clock, fetcher } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });
  await assert.rejects(settle(clock, auth.getAccessToken()), (error) => error.code === 'invalid_grant');

  auth.configure({ refreshToken: 'T2', printerUuid: UUID });
  assert.equal(auth.inspect().invalidGrant, false);
  assert.equal(await settle(clock, auth.getAccessToken()), 'access-2');
  assert.equal(fetcher.countFor(TOKEN_URL), 2);
});

test('transport faults and server errors surface as typed network errors', async () => {
  const offline = await makeAuth({
    handlers: { [TOKEN_URL]: () => { throw new TypeError('Failed to fetch'); } },
  });
  offline.auth.configure({ refreshToken: 'T1', printerUuid: UUID });
  await assert.rejects(
    settle(offline.clock, offline.auth.getAccessToken()),
    (error) => error.code === 'network' && /could not reach/.test(error.message),
  );

  const broken = await makeAuth({
    handlers: { [TOKEN_URL]: () => jsonResponse({ error: 'server_error' }, 503) },
  });
  broken.auth.configure({ refreshToken: 'T1', printerUuid: UUID });
  await assert.rejects(
    settle(broken.clock, broken.auth.getAccessToken()),
    (error) => error.code === 'network' && error.status === 503,
  );

  const empty = await makeAuth({
    handlers: { [TOKEN_URL]: () => jsonResponse({ refresh_token: 'T2' }, 200) },
  });
  empty.auth.configure({ refreshToken: 'T1', printerUuid: UUID });
  await assert.rejects(
    settle(empty.clock, empty.auth.getAccessToken()),
    (error) => error.code === 'network' && /no access token/.test(error.message),
  );
  // The rotated token still landed, because the server already spent the old one.
  assert.equal(readRecord(empty.storage).refreshToken, 'T2');
});

test('an unconfigured auth throws not_configured', async () => {
  const { auth, clock } = await makeAuth();
  await assert.rejects(
    settle(clock, auth.getAccessToken()),
    (error) => error.code === 'not_configured',
  );
  await assert.rejects(
    settle(clock, auth.getUserId()),
    (error) => error.code === 'not_configured',
  );
  assert.deepEqual(auth.getConfig(), { configured: false, printerUuid: null });
});

test('getUserId fetches once, caches the id and stores no personal data', async () => {
  const hub = makeChannelHub();
  const handlers = {
    [TOKEN_URL]: () => tokenBody('access-1', 'T2'),
    [ME_URL]: () => jsonResponse({
      id: 1234567,
      username: 'ada',
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      public_username: 'ada-l',
    }),
  };
  const { auth, storage, fetcher, clock } = await makeAuth({ handlers, broadcast: hub.endpoint() });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });

  const id = await settle(clock, auth.getUserId());
  assert.equal(id, '1234567');
  assert.equal(await settle(clock, auth.getUserId()), '1234567');
  assert.equal(fetcher.countFor(ME_URL), 1);
  assert.equal(readRecord(storage).userId, '1234567');

  const meCall = fetcher.calls.find((call) => call.url === ME_URL);
  assert.equal(meCall.init.headers.Authorization, 'Bearer access-1');
  assert.equal(meCall.init.credentials, 'omit');
  assert.equal(meCall.init.headers['User-Agent'], undefined);

  // Nothing personal may reach storage, the channel or the status view.
  const written = [...storage.entries().map(([, value]) => value), JSON.stringify(hub.posted),
    JSON.stringify(auth.inspect())];
  for (const blob of written) {
    assert.ok(!blob.includes('@'), `stored value must not contain an email address: ${blob}`);
    assert.ok(!blob.includes('first_name'), 'stored value must not contain first_name');
    assert.ok(!blob.includes('Ada'), 'stored value must not contain the account name');
    assert.ok(!blob.includes('Lovelace'), 'stored value must not contain the account name');
    assert.ok(!blob.includes('example.com'), 'stored value must not contain the account email');
  }
  const view = JSON.stringify(auth.inspect());
  assert.ok(!view.includes('access-1') && !view.includes('T2'), 'inspect must not expose tokens');

  // A second instance on the same storage reuses the cached id with no request.
  const second = await makeAuth({ storage, fetcher, clock: makeClock() });
  assert.equal(await settle(clock, second.auth.getUserId()), '1234567');
  assert.equal(fetcher.countFor(ME_URL), 1);
});

test('a rejected access token is dropped so the next call refreshes once', async () => {
  const handlers = {
    [TOKEN_URL]: (init, call) => tokenBody(`access-${call}`, `T${call + 1}`),
    [ME_URL]: (init, call) => (call === 1
      ? jsonResponse({ detail: 'invalid token' }, 401)
      : jsonResponse({ id: 42, email: 'ada@example.com' })),
  };
  const { auth, storage, fetcher, clock } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });

  await assert.rejects(
    settle(clock, auth.getUserId()),
    (error) => error.code === 'network' && /rejected the access token/.test(error.message),
  );
  assert.equal(readRecord(storage).accessToken, null);
  assert.equal(auth.inspect().hasFreshAccessToken, false);

  assert.equal(await settle(clock, auth.getUserId()), '42');
  assert.equal(fetcher.countFor(TOKEN_URL), 2);
  assert.equal(fetcher.countFor(ME_URL), 2);
});

test('an interrupted refresh is visible and clear removes every key', async () => {
  let seen = null;
  const handlers = {
    [TOKEN_URL]: () => new Promise((resolve) => { seen = resolve; }),
  };
  const { auth, storage, clock } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });

  const pending = auth.getAccessToken();
  await clock.advance(200);
  assert.equal(JSON.parse(storage.getItem(BACKUP_KEY)).state, 'spending');
  assert.equal(auth.inspect().interrupted, true);

  seen(tokenBody('access-1', 'T2'));
  await settle(clock, pending);
  assert.equal(JSON.parse(storage.getItem(BACKUP_KEY)).state, 'good');
  assert.equal(auth.inspect().interrupted, false);

  auth.clear();
  assert.deepEqual(storage.keys(), []);
  assert.deepEqual(auth.getConfig(), { configured: false, printerUuid: null });
});

test('a corrupted primary record falls back to the mirrored token', async () => {
  const handlers = { [TOKEN_URL]: () => tokenBody('access-1', 'T3') };
  const { auth, storage, clock } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T2', printerUuid: UUID });
  storage.setItem(STORAGE_KEY, '{ not json');

  assert.equal(auth.getConfig().configured, true);
  assert.equal(await settle(clock, auth.getAccessToken()), 'access-1');
  assert.equal(readRecord(storage).refreshToken, 'T3');
  assert.equal(readRecord(storage).printerUuid, UUID);
});

test('a token pasted during a refresh is not undone by the rotation', async () => {
  let release = null;
  const handlers = {
    [TOKEN_URL]: () => new Promise((resolve) => { release = () => resolve(tokenBody('access-1', 'T2')); }),
  };
  const { auth, storage, clock } = await makeAuth({ handlers });
  auth.configure({ refreshToken: 'T1', printerUuid: UUID });

  const pending = auth.getAccessToken();
  await clock.advance(200);
  // The user gives up waiting and pastes a token from a fresh capture.
  auth.configure({ refreshToken: 'USER-NEW', printerUuid: UUID });
  release();
  assert.equal(await settle(clock, pending), 'access-1');
  assert.equal(readRecord(storage).refreshToken, 'USER-NEW');
  assert.equal(JSON.parse(storage.getItem(BACKUP_KEY)).refreshToken, 'USER-NEW');
});

test('an error listener that closes the client cannot re-enter the teardown', async () => {
  const mqtt = await import(MQTT_PATH);
  const clock = makeClock();
  const sockets = makeSockets();
  const client = makeClient(mqtt, clock, sockets);
  const order = [];
  client.on('error', (error) => {
    order.push(`error:${error.code}`);
    client.close(); // the caller's own teardown, mid-error
  });
  client.on('close', (payload) => { order.push(`close:${payload.reason}`); });

  client.connect();
  const socket = sockets.sockets[0];
  socket.fireOpen();
  socket.fireBytes([0x20, 0x02, 0x00, 0x04]); // bad username or password
  assert.deepEqual(order, ['error:connack', 'close:connack']);

  // A late socket close from the transport adds nothing.
  socket.fireServerClose(1006);
  assert.deepEqual(order, ['error:connack', 'close:connack']);
  assert.equal(clock.pendingTimers(), 0);
});
