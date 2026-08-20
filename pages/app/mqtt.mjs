/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Minimal MQTT 3.1.1 client over WebSocket for the static dashboard's cloud
 * mode. No dependencies, so the same source runs in a browser and under Bun.
 * Only the subset Prusa Connect's broker needs is implemented: CONNECT,
 * SUBSCRIBE at QoS 0, inbound PUBLISH, PINGREQ/PINGRESP and DISCONNECT.
 *
 * The packet encoder and the incremental parser are pure and exported so the
 * byte layout can be asserted against the MQTT 3.1.1 specification in tests.
 * The client never reconnects by itself: the caller owns backoff, because a
 * reconnect has to be sequenced after an access-token refresh.
 */

const PROTOCOL_NAME = 'MQTT';
const PROTOCOL_LEVEL = 4; // MQTT 3.1.1
const MAX_STRING_BYTES = 0xffff;
const MAX_REMAINING_LENGTH_BYTES = 4;
const WS_OPEN = 1;

export const MQTT_SUBPROTOCOL = 'mqtt';

export const PACKET_TYPE = Object.freeze({
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
});

export const CONNACK_REASON = Object.freeze({
  0: 'accepted',
  1: 'unacceptable protocol version',
  2: 'client id rejected',
  3: 'server unavailable',
  4: 'bad username or password',
  5: 'not authorized',
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Remaining Length, MQTT 3.1.1 section 2.2.3: 7 bits per byte, little endian,
// high bit marks a continuation byte, at most four bytes.
function encodeLength(value) {
  let remaining = value;
  const out = [];
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0);
  if (out.length > MAX_REMAINING_LENGTH_BYTES) {
    throw new RangeError('MQTT packet exceeds the maximum remaining length');
  }
  return out;
}

// UTF-8 encoded string, MQTT 3.1.1 section 1.5.3: two length bytes then bytes.
function encodeString(value) {
  const bytes = textEncoder.encode(String(value));
  if (bytes.length > MAX_STRING_BYTES) {
    throw new RangeError('MQTT string exceeds 65535 bytes');
  }
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

function packet(type, flags, payload) {
  return new Uint8Array([(type << 4) | flags, ...encodeLength(payload.length), ...payload]);
}

export function encodeConnect({ clientId, username, password, keepalive = 60 } = {}) {
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new TypeError('MQTT CONNECT requires a client id');
  }
  const keepaliveSec = Math.max(0, Math.min(0xffff, Math.floor(Number(keepalive) || 0)));
  let flags = 0x02; // clean session
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;
  const payload = [
    ...encodeString(PROTOCOL_NAME),
    PROTOCOL_LEVEL,
    flags,
    keepaliveSec >> 8,
    keepaliveSec & 0xff,
    ...encodeString(clientId),
    ...(username ? encodeString(username) : []),
    ...(password ? encodeString(password) : []),
  ];
  return packet(PACKET_TYPE.CONNECT, 0, payload);
}

export function encodeSubscribe(packetId, filters) {
  const list = Array.isArray(filters) ? filters : [filters];
  if (list.length === 0) throw new TypeError('MQTT SUBSCRIBE requires at least one filter');
  if (!Number.isInteger(packetId) || packetId < 1 || packetId > 0xffff) {
    throw new TypeError('MQTT SUBSCRIBE requires a packet id between 1 and 65535');
  }
  const payload = [packetId >> 8, packetId & 0xff];
  for (const filter of list) {
    if (typeof filter !== 'string' || filter.length === 0) {
      throw new TypeError('MQTT topic filters must be non-empty strings');
    }
    payload.push(...encodeString(filter), 0); // requested QoS 0
  }
  // Fixed header flags for SUBSCRIBE are reserved and must be 0b0010.
  return packet(PACKET_TYPE.SUBSCRIBE, 2, payload);
}

export function encodePing() {
  return packet(PACKET_TYPE.PINGREQ, 0, []);
}

export function encodeDisconnect() {
  return packet(PACKET_TYPE.DISCONNECT, 0, []);
}

// Incremental parser: feed byte chunks in any framing, get whole control
// packets back. Bytes that do not yet form a packet stay buffered.
export function createParser() {
  let buffer = new Uint8Array(0);
  return function feed(chunk) {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    const packets = [];
    for (;;) {
      if (buffer.length < 2) break;
      let multiplier = 1;
      let length = 0;
      let index = 1;
      let lengthBytes = 0;
      let byte = 0;
      let complete = true;
      do {
        if (index >= buffer.length) { complete = false; break; }
        if (lengthBytes >= MAX_REMAINING_LENGTH_BYTES) {
          throw new Error('malformed MQTT remaining length');
        }
        byte = buffer[index++];
        lengthBytes += 1;
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
      } while ((byte & 0x80) !== 0);
      if (!complete) break;
      if (buffer.length < index + length) break;
      packets.push({
        type: buffer[0] >> 4,
        flags: buffer[0] & 0x0f,
        body: buffer.subarray(index, index + length),
      });
      // subarray keeps a view on the merged copy; the next feed compacts it.
      buffer = buffer.subarray(index + length);
    }
    return packets;
  };
}

export function decodePublish(body, flags) {
  if (!body || body.length < 2) throw new Error('malformed MQTT PUBLISH packet');
  const qos = (flags >> 1) & 3;
  const topicLength = (body[0] << 8) | body[1];
  let offset = 2 + topicLength;
  if (offset > body.length) throw new Error('malformed MQTT PUBLISH topic');
  const topic = textDecoder.decode(body.subarray(2, offset));
  if (qos > 0) offset += 2; // packet identifier, present only above QoS 0
  if (offset > body.length) throw new Error('malformed MQTT PUBLISH payload');
  return {
    topic,
    payload: textDecoder.decode(body.subarray(offset)),
    retained: (flags & 1) === 1,
  };
}

function mqttError(message, code, extra) {
  const error = new Error(message);
  error.name = 'MqttError';
  error.code = code;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return error;
}

function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/**
 * MQTT client over a WebSocket.
 *
 * Events: `open`, `connack` ({ sessionPresent, returnCode }), `suback`
 * ({ packetId, granted }), `message` ({ topic, payload, retained }),
 * `error` (Error with a `code`), `close` ({ reason, code }). `close` fires
 * exactly once per client, from every teardown path, so a caller can drive
 * its own reconnect backoff from that single event.
 *
 * The injected WebSocket only needs the browser shape used here: the
 * `(url, protocols)` constructor, `send`, `close`, `readyState` and the
 * `onopen` / `onmessage` / `onerror` / `onclose` handler properties.
 */
export function createMqttClient(options = {}) {
  const url = String(options.url || '');
  const clientId = String(options.clientId || '');
  const username = options.username == null ? '' : String(options.username);
  const password = options.password == null ? '' : String(options.password);
  const protocols = options.protocols === undefined ? MQTT_SUBPROTOCOL : options.protocols;
  const WebSocketImpl = options.WebSocketImpl ||
    (typeof WebSocket === 'function' ? WebSocket : null);
  const keepaliveSec = Number.isFinite(options.keepaliveSec)
    ? Math.max(10, Math.floor(options.keepaliveSec)) : 60;
  // Half the keepalive window, so 30s at the default, with a 15s response
  // deadline before the link counts as dead.
  const pingIntervalMs = Number.isFinite(options.pingIntervalMs)
    ? Math.max(1, Math.floor(options.pingIntervalMs)) : keepaliveSec * 500;
  const pingTimeoutMs = Number.isFinite(options.pingTimeoutMs)
    ? Math.max(1, Math.floor(options.pingTimeoutMs)) : 15000;
  const timers = options.timers || {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };

  const listeners = new Map();
  const pendingSubscribes = [];
  let socket = null;
  let parser = null;
  let started = false;
  let connacked = false;
  let finished = false;
  let nextPacketId = 0;
  let pingTimer = null;
  let pingDeadline = null;

  function on(event, callback) {
    if (typeof callback !== 'function') return () => {};
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(callback);
    return () => { set.delete(callback); };
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const callback of [...set]) {
      try { callback(payload); } catch { /* listener faults stay local */ }
    }
  }

  function clearTimer(handle) {
    if (handle != null) timers.clearTimeout(handle);
  }

  function stopTimers() {
    clearTimer(pingTimer);
    clearTimer(pingDeadline);
    pingTimer = null;
    pingDeadline = null;
  }

  // `before` runs once the client is already finished, so a listener that
  // reacts by calling close() cannot re-enter this teardown and emit a second
  // close event.
  function teardown(reason, code, before) {
    if (finished) return;
    finished = true;
    stopTimers();
    const current = socket;
    socket = null;
    parser = null;
    pendingSubscribes.length = 0;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      try { current.close(); } catch { /* already closing */ }
    }
    if (before) before();
    emit('close', { reason, code: code == null ? null : code });
  }

  function fail(message, code, extra) {
    if (finished) return;
    const error = mqttError(message, code, extra);
    teardown(code, null, () => emit('error', error));
  }

  function send(bytes) {
    if (!socket) return false;
    if (typeof socket.readyState === 'number' && socket.readyState !== WS_OPEN) return false;
    try {
      socket.send(bytes);
      return true;
    } catch (cause) {
      fail('MQTT websocket send failed', 'socket', { cause });
      return false;
    }
  }

  function schedulePing() {
    clearTimer(pingTimer);
    pingTimer = timers.setTimeout(sendPing, pingIntervalMs);
  }

  function sendPing() {
    pingTimer = null;
    if (finished || !socket) return;
    if (!send(encodePing())) return;
    if (pingDeadline == null) {
      pingDeadline = timers.setTimeout(() => {
        pingDeadline = null;
        fail('MQTT keepalive response timed out', 'ping_timeout');
      }, pingTimeoutMs);
    }
    schedulePing();
  }

  function flushSubscribes() {
    while (pendingSubscribes.length > 0) {
      const queued = pendingSubscribes.shift();
      if (!send(encodeSubscribe(queued.packetId, queued.filters))) return;
    }
  }

  function handlePacket({ type, flags, body }) {
    if (type === PACKET_TYPE.CONNACK) {
      if (body.length < 2) {
        fail('malformed MQTT CONNACK', 'protocol');
        return;
      }
      const returnCode = body[1];
      if (returnCode !== 0) {
        fail(
          `MQTT connection refused: ${CONNACK_REASON[returnCode] || 'unknown reason'}`,
          'connack',
          { returnCode },
        );
        return;
      }
      connacked = true;
      schedulePing();
      emit('connack', { sessionPresent: (body[0] & 1) === 1, returnCode });
      flushSubscribes();
      return;
    }
    if (type === PACKET_TYPE.SUBACK) {
      if (body.length < 2) {
        fail('malformed MQTT SUBACK', 'protocol');
        return;
      }
      emit('suback', {
        packetId: (body[0] << 8) | body[1],
        granted: Array.from(body.subarray(2)),
      });
      return;
    }
    if (type === PACKET_TYPE.PUBLISH) {
      let message;
      try { message = decodePublish(body, flags); }
      catch (cause) {
        fail('malformed MQTT PUBLISH', 'protocol', { cause });
        return;
      }
      // Only QoS 0 is ever requested, so no PUBACK path is needed.
      emit('message', message);
      return;
    }
    if (type === PACKET_TYPE.PINGRESP) {
      clearTimer(pingDeadline);
      pingDeadline = null;
    }
    // Anything else (PUBACK, UNSUBACK) is not part of this subset.
  }

  function handleMessage(event) {
    if (finished || !parser) return;
    const data = event && typeof event === 'object' && 'data' in event ? event.data : event;
    const chunk = toBytes(data);
    if (!chunk) {
      fail('MQTT websocket delivered a non-binary frame', 'protocol');
      return;
    }
    let packets;
    try { packets = parser(chunk); }
    catch (cause) {
      fail('malformed MQTT stream', 'protocol', { cause });
      return;
    }
    for (const item of packets) {
      if (finished) return;
      handlePacket(item);
    }
  }

  function connect() {
    if (started) return;
    started = true;
    if (!WebSocketImpl) {
      fail('no WebSocket implementation is available', 'socket');
      return;
    }
    try {
      socket = protocols === undefined || protocols === null
        ? new WebSocketImpl(url)
        : new WebSocketImpl(url, protocols);
    } catch (cause) {
      socket = null;
      fail('MQTT websocket could not be opened', 'socket', { cause });
      return;
    }
    try { socket.binaryType = 'arraybuffer'; } catch { /* fakes may not allow it */ }
    parser = createParser();
    socket.onopen = () => {
      if (finished) return;
      emit('open', undefined);
      send(encodeConnect({ clientId, username, password, keepalive: keepaliveSec }));
    };
    socket.onmessage = handleMessage;
    socket.onerror = () => { fail('MQTT websocket error', 'socket'); };
    socket.onclose = (event) => {
      const code = event && typeof event.code === 'number' ? event.code : null;
      teardown('socket', code);
    };
  }

  function subscribe(filters) {
    const list = Array.isArray(filters) ? filters.slice() : [filters];
    if (finished) return null;
    nextPacketId = (nextPacketId % 0xffff) + 1;
    const packetId = nextPacketId;
    if (!connacked) {
      // Buffer until CONNACK so callers never have to sequence around it.
      pendingSubscribes.push({ packetId, filters: list });
      return packetId;
    }
    send(encodeSubscribe(packetId, list));
    return packetId;
  }

  function close() {
    if (finished) return;
    if (connacked) send(encodeDisconnect());
    teardown('local', null);
  }

  return { connect, subscribe, on, close };
}
