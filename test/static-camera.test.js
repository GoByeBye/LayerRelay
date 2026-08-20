'use strict';

// Cloud camera: protobuf codec, Socket.IO framing, and the WebRTC negotiation
// client. No network: every socket and peer connection here is a fake.
//
// The wire formats are not invented. The ClientAuthentication encoding asserted
// below is byte-for-byte the one that authenticated against Prusa's live
// signaling server, and the field numbers come from Prusa's own published
// client bundle.

const assert = require('node:assert/strict');
const { test } = require('bun:test');

const PROTOBUF_PATH = '../pages/app/protobuf.mjs';
const SOCKETIO_PATH = '../pages/app/socketio.mjs';
const CAMERA_PATH = '../pages/app/camera-webrtc.mjs';

const utf8 = (s) => [...Buffer.from(s, 'utf8')];

// Hand-built expected bytes, not a snapshot of our own encoder.
function expectedLengthDelimited(field, text) {
  const body = Buffer.from(text, 'utf8');
  const header = [(field << 3) | 2];
  let n = body.length;
  const lengthBytes = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; lengthBytes.push(b); } while (n);
  return [...header, ...lengthBytes, ...body];
}

test('ClientAuthentication matches the encoding that the live server accepted', async () => {
  const { encodeClientAuthentication } = await import(PROTOBUF_PATH);
  const cameraToken = 'ABCDEFGHIJKLMNOPQRST'; // 20 chars, the real token length
  const jwt = 'j'.repeat(777);                // long enough to need a 2-byte length
  const expected = [
    ...expectedLengthDelimited(1, cameraToken),
    ...expectedLengthDelimited(2, 'client'),
    ...expectedLengthDelimited(3, jwt),
  ];
  const actual = [...encodeClientAuthentication({ cameraToken, jwt })];
  assert.deepEqual(actual, expected);
  // The JWT length crosses the single-byte varint boundary, which is where a
  // hand-rolled encoder usually breaks.
  assert.ok(jwt.length > 127);
});

test('varint lengths are encoded across the 127, 128 and 16383 boundaries', async () => {
  const { createWriter, decode } = await import(PROTOBUF_PATH);
  for (const size of [0, 1, 127, 128, 129, 16383, 16384]) {
    const text = 'x'.repeat(size);
    const bytes = createWriter().string(1, text).finish();
    assert.deepEqual([...bytes], expectedLengthDelimited(1, text), `size ${size}`);
    const decoded = decode(bytes);
    assert.equal(Buffer.from(decoded[1].bytes).toString('utf8'), text, `roundtrip ${size}`);
  }
});

test('decode collects repeated fields and rejects truncated input', async () => {
  const { createWriter, decode } = await import(PROTOBUF_PATH);
  const bytes = createWriter().string(1, 'a').string(1, 'b').varint(2, 300).finish();
  const decoded = decode(bytes);
  assert.ok(Array.isArray(decoded[1]));
  assert.deepEqual(decoded[1].map((e) => Buffer.from(e.bytes).toString()), ['a', 'b']);
  assert.equal(decoded[2].varint, 300);
  assert.throws(() => decode(bytes.subarray(0, bytes.length - 1)), /truncated/);
});

test('WebRtc round trips every field including nested ICE configuration', async () => {
  const mod = await import(PROTOBUF_PATH);
  const message = {
    cameraToken: 'tok', requestId: 'sid', fingerprint: 'sid',
    sdp: { candidate: 'v=0\r\ns=-', mid: '1' },
    messageType: mod.WEBRTC_MSG_TYPE.ANSWER,
    clientType: mod.WEBRTC_CLIENT_TYPE.CLIENT,
    streamStatus: mod.WEBRTC_STREAM_STATUS.START,
    iceConfiguration: {
      iceServers: [
        { endpoints: [{ schemeType: 1, address: 'stun.example', port: 3478 }] },
        {
          endpoints: [{ schemeType: 2, address: 'turn.example', port: 5349, transportProtocol: 3 }],
          username: 'u', credential: 'c',
        },
      ],
      iceTransportPolicy: mod.ICE_POLICY.ALL,
      ttl: 86400,
    },
  };
  const back = mod.decodeWebRtc(mod.encodeWebRtc(message));
  assert.equal(back.cameraToken, 'tok');
  assert.equal(back.requestId, 'sid');
  assert.equal(back.messageType, mod.WEBRTC_MSG_TYPE.ANSWER);
  assert.equal(back.clientType, mod.WEBRTC_CLIENT_TYPE.CLIENT);
  assert.deepEqual(back.sdp, { candidate: 'v=0\r\ns=-', mid: '1' });
  assert.equal(back.iceConfiguration.iceServers.length, 2);
  assert.equal(back.iceConfiguration.iceServers[1].username, 'u');
  assert.deepEqual(back.iceConfiguration.iceServers[1].endpoints[0], {
    schemeType: 2, address: 'turn.example', port: 5349, transportProtocol: 3,
  });
  assert.equal(back.iceConfiguration.ttl, 86400);
});

test('ICE URLs parse exactly like the Prusa client parser', async () => {
  const { iceUrlToEndpoint, restIceToProtobuf } = await import(CAMERA_PATH);
  const { ICE_SCHEME_TYPE, ICE_TRANSPORT_PROTOCOL, ICE_POLICY } = await import(PROTOBUF_PATH);
  assert.deepEqual(iceUrlToEndpoint('stun:stun.l.google.com:19302'),
    { address: 'stun.l.google.com', schemeType: ICE_SCHEME_TYPE.STUN, port: 19302 });
  // turns implies TLS even without an explicit transport parameter.
  assert.deepEqual(iceUrlToEndpoint('turns:coturn.prusa3d.com:5349'), {
    address: 'coturn.prusa3d.com', schemeType: ICE_SCHEME_TYPE.TURN, port: 5349,
    transportProtocol: ICE_TRANSPORT_PROTOCOL.TLS,
  });
  assert.deepEqual(iceUrlToEndpoint('turn:h:3478?transport=tcp'), {
    address: 'h', schemeType: ICE_SCHEME_TYPE.TURN, port: 3478,
    transportProtocol: ICE_TRANSPORT_PROTOCOL.TCP,
  });
  assert.deepEqual(iceUrlToEndpoint('garbage'), { address: 'garbage' });
  const pb = restIceToProtobuf({ iceTransportPolicy: 'relay', iceServers: [{ urls: 'stun:a:1' }] }, 60);
  assert.equal(pb.iceTransportPolicy, ICE_POLICY.RELAY);
  assert.equal(pb.ttl, 60);
});

// ---- Socket.IO -------------------------------------------------------------

function fakeSocketClass() {
  const instances = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      instances.push(this);
    }
    send(data) { this.sent.push(data); }
    close() { this.closed = true; if (this.onclose) this.onclose({}); }
    open() { if (this.onopen) this.onopen({}); }
    text(data) { if (this.onmessage) this.onmessage({ data }); }
    binary(bytes) { if (this.onmessage) this.onmessage({ data: bytes.buffer ? bytes.buffer : bytes }); }
  }
  return { FakeSocket, instances };
}

test('socket.io performs the handshake, ping/pong and binary events observed on the wire', async () => {
  const { createSocketIo } = await import(SOCKETIO_PATH);
  const { FakeSocket, instances } = fakeSocketClass();
  const io = createSocketIo({ url: 'wss://example', WebSocketImpl: FakeSocket });
  const events = [];
  io.on('event', (e) => events.push(e));
  let connectedId = null;
  io.on('connect', ({ id }) => { connectedId = id; });
  io.connect();

  const socket = instances[0];
  assert.equal(socket.url, 'wss://example/socket.io/?EIO=4&transport=websocket');
  socket.open();
  socket.text('0{"sid":"engine","pingInterval":25000}');
  assert.deepEqual(socket.sent, ['40'], 'engine.io open is answered with socket.io CONNECT');
  socket.text('40{"sid":"SOCKETID"}');
  assert.equal(connectedId, 'SOCKETID');

  // Server ping must be answered or the server drops the link.
  socket.text('2');
  assert.equal(socket.sent[socket.sent.length - 1], '3');

  const ack = io.emitBinary('client_authentication', Uint8Array.of(1, 2, 3), { ack: true });
  const header = socket.sent[socket.sent.length - 2];
  assert.match(header, /^451-0\["client_authentication",\{"_placeholder":true,"num":0\}\]$/);
  assert.deepEqual([...socket.sent[socket.sent.length - 1]], [1, 2, 3]);
  socket.text('430[0]');
  assert.equal(await ack, 0, 'ack payload 0 means accepted');

  // Inbound binary event: header frame names it, the next frame carries it.
  socket.text('451-["webrtc",{"_placeholder":true,"num":0}]');
  socket.binary(Uint8Array.of(9, 9));
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'webrtc');
  assert.deepEqual([...events[0].payload], [9, 9]);
});

test('socket.io rejects pending acks when the link closes', async () => {
  const { createSocketIo } = await import(SOCKETIO_PATH);
  const { FakeSocket, instances } = fakeSocketClass();
  const io = createSocketIo({ url: 'wss://example', WebSocketImpl: FakeSocket });
  io.connect();
  const socket = instances[0];
  socket.open();
  socket.text('0{"sid":"e"}');
  socket.text('40{"sid":"s"}');
  const pending = io.emitBinary('client_authentication', Uint8Array.of(1), { ack: true });
  io.close();
  await assert.rejects(pending, /socket closed before ack/);
});

// ---- camera client ---------------------------------------------------------

function fakePeerClass() {
  const peers = [];
  class FakePeer {
    constructor(config) {
      this.config = config;
      this.closed = false;
      this.localDescription = null;
      this.remoteDescription = null;
      this.candidates = [];
      this.connectionState = 'new';
      peers.push(this);
    }
    async setRemoteDescription(desc) { this.remoteDescription = desc; }
    async createAnswer() { return { type: 'answer', sdp: 'ANSWER-SDP' }; }
    async setLocalDescription(desc) { this.localDescription = desc; }
    async addIceCandidate(c) { this.candidates.push(c); }
    close() { this.closed = true; }
  }
  return { FakePeer, peers };
}

function fakeTimers() {
  const timeouts = [];
  return {
    timeouts,
    timers: {
      setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length - 1; },
      clearTimeout: (h) => { if (timeouts[h]) timeouts[h].cleared = true; },
    },
  };
}

async function startCamera(extra = {}) {
  const { createCloudCamera } = await import(CAMERA_PATH);
  const { FakePeer, peers } = fakePeerClass();
  const { timers, timeouts } = fakeTimers();
  const emitted = [];
  let connectHandler = null;
  let eventHandler = null;
  const socket = {
    connect() { if (connectHandler) connectHandler({ id: 'SID' }); },
    emitBinary(name, payload, opts) {
      emitted.push({ name, payload });
      if (opts && opts.ack) return Promise.resolve(extra.ack === undefined ? 0 : extra.ack);
      return Promise.resolve(null);
    },
    on(event, cb) {
      if (event === 'connect') connectHandler = cb;
      if (event === 'event') eventHandler = cb;
      return () => {};
    },
    id: () => 'SID',
    close() { this.closed = true; },
  };
  const camera = createCloudCamera({
    cameraToken: 'CAMTOKEN',
    getAccessToken: async () => 'ACCESS',
    socketFactory: () => socket,
    peerFactory: (config) => new FakePeer(config),
    timers,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ configuration: { iceTransportPolicy: 'all', iceServers: [{ urls: ['stun:s:1'] }], ttl: 60 } }),
    }),
    ...extra.options,
  });
  const events = [];
  camera.on('stream', (s) => events.push({ type: 'stream', s }));
  camera.on('error', (e) => events.push({ type: 'error', message: e.message }));
  await camera.start();
  return { camera, socket, emitted, peers, events, timeouts, deliver: (bytes) => eventHandler({ name: 'webrtc', payload: bytes }) };
}

test('the camera client authenticates then requests a stream, and never configures the camera', async () => {
  const { emitted } = await startCamera();
  assert.deepEqual(emitted.map((e) => e.name), ['client_authentication', 'webrtc']);
  // Rule that protects the owner's RTSP feed: this module must never write a
  // camera setting, because enabling WebRTC turns the camera's RTSP server off.
  assert.ok(!emitted.some((e) => e.name === 'configuration'),
    'the camera client must never emit a configuration event');
});

test('an offer is answered and a track becomes the stream', async () => {
  const mod = await import(PROTOBUF_PATH);
  const { emitted, peers, events, deliver, camera } = await startCamera();
  deliver(mod.encodeWebRtc({
    cameraToken: 'CAMTOKEN', requestId: 'SID', fingerprint: 'SID',
    messageType: mod.WEBRTC_MSG_TYPE.OFFER,
    clientType: mod.WEBRTC_CLIENT_TYPE.CAMERA,
    sdp: { candidate: 'OFFER-SDP', mid: '0' },
  }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(peers[0].remoteDescription.sdp, 'OFFER-SDP');
  assert.equal(peers[0].localDescription.sdp, 'ANSWER-SDP');
  const answer = mod.decodeWebRtc(emitted[emitted.length - 1].payload);
  assert.equal(answer.messageType, mod.WEBRTC_MSG_TYPE.ANSWER);
  assert.equal(answer.sdp.candidate, 'ANSWER-SDP');

  const track = { stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] };
  peers[0].ontrack({ streams: [stream] });
  assert.equal(events.filter((e) => e.type === 'stream').length, 1);
  assert.equal(camera.getStatus().phase, 'live');
  camera.stop();
  assert.ok(peers[0].closed && track.stopped, 'teardown closes the peer and stops tracks');
});

test('a message for another viewer is ignored', async () => {
  const mod = await import(PROTOBUF_PATH);
  const { peers, deliver } = await startCamera();
  deliver(mod.encodeWebRtc({
    cameraToken: 'CAMTOKEN', requestId: 'SOMEONE-ELSE', fingerprint: 'SOMEONE-ELSE',
    messageType: mod.WEBRTC_MSG_TYPE.OFFER, sdp: { candidate: 'OTHER-SDP', mid: '0' },
  }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(peers[0].remoteDescription, null);
});

test('a camera that never answers reports the RTSP-mode explanation', async () => {
  const { events, timeouts, camera } = await startCamera();
  const timer = timeouts.find((t) => t.ms === 15000);
  assert.ok(timer, 'the request arms a 15s timeout like the Prusa client');
  timer.fn();
  const error = events.find((e) => e.type === 'error');
  assert.match(error.message, /RTSP/);
  assert.equal(camera.getStatus().phase, 'error');
});

test('a rejected camera token surfaces the rejection code', async () => {
  const { events } = await startCamera({ ack: 7 });
  const error = events.find((e) => e.type === 'error');
  assert.match(error.message, /rejected the camera token \(code 7\)/);
});
