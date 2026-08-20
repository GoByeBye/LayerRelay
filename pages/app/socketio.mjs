/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Just enough Socket.IO v4 / engine.io 4 to talk to Prusa's camera signaling
 * server. Prusa's own client passes transports:['websocket'], which skips the
 * polling handshake, so a WebSocket is all that is ever needed and CORS never
 * applies to it. The framing below is what was observed on the wire against
 * camera-signaling.prusa3d.com.
 */
// Browser ESM. No Node APIs, no dependencies.

// engine.io packet types (first character of a text frame).
const EIO_OPEN = '0';
const EIO_PING = '2';
const EIO_PONG = '3';
const EIO_MESSAGE = '4';
// socket.io packet types (second character).
const SIO_CONNECT = '0';
const SIO_EVENT = '2';
const SIO_ACK = '3';
const SIO_BINARY_EVENT = '5';
const SIO_BINARY_ACK = '6';

export function createSocketIo(options = {}) {
  const url = options.url;
  const WebSocketImpl = options.WebSocketImpl ||
    (typeof WebSocket === 'function' ? WebSocket : null);
  const listeners = new Map();
  const pendingAcks = new Map();

  let socket = null;
  let socketId = null;
  let ackSeq = 0;
  let closed = false;
  // A binary event arrives as a header frame naming the event, then one frame
  // per attachment. This holds the header until its attachments land.
  let pendingBinary = null;

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const callback of [...set]) {
      try { callback(payload); } catch { /* listener faults stay local */ }
    }
  }

  function on(event, callback) {
    if (typeof callback !== 'function') return () => {};
    let set = listeners.get(event);
    if (!set) { set = new Set(); listeners.set(event, set); }
    set.add(callback);
    return () => set.delete(callback);
  }

  function sendText(text) {
    if (!socket || closed) return false;
    try { socket.send(text); return true; }
    catch { return false; }
  }

  function finish(reason) {
    if (closed) return;
    closed = true;
    for (const pending of pendingAcks.values()) {
      pending.reject(new Error(`socket closed before ack (${reason})`));
    }
    pendingAcks.clear();
    const current = socket;
    socket = null;
    if (current) {
      try { current.close(); } catch { /* already gone */ }
    }
    emit('close', { reason });
  }

  function handleText(text) {
    if (text === EIO_PING) { sendText(EIO_PONG); return; }
    if (text[0] === EIO_OPEN) {
      // engine.io handshake done; open the socket.io namespace.
      sendText(EIO_MESSAGE + SIO_CONNECT);
      return;
    }
    if (text[0] !== EIO_MESSAGE) return;
    const kind = text[1];
    const rest = text.slice(2);
    if (kind === SIO_CONNECT) {
      try { socketId = (JSON.parse(rest || '{}') || {}).sid || null; }
      catch { socketId = null; }
      emit('connect', { id: socketId });
      return;
    }
    if (kind === SIO_ACK || kind === SIO_BINARY_ACK) {
      const match = /^(\d+)?(\[.*\])$/.exec(rest.replace(/^\d+-/, ''));
      const id = match && match[1] ? Number(match[1]) : null;
      let payload = null;
      try { payload = match ? JSON.parse(match[2]) : null; }
      catch { payload = null; }
      const pending = id != null ? pendingAcks.get(id) : null;
      if (pending) {
        pendingAcks.delete(id);
        pending.resolve(Array.isArray(payload) ? payload[0] : payload);
      }
      return;
    }
    if (kind === SIO_EVENT || kind === SIO_BINARY_EVENT) {
      const body = rest.replace(/^\d+-/, '');
      let parsed = null;
      try { parsed = JSON.parse(body); }
      catch { parsed = null; }
      const name = Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null;
      if (kind === SIO_BINARY_EVENT) pendingBinary = { name };
      else emit('event', { name, payload: null, json: Array.isArray(parsed) ? parsed[1] : null });
    }
  }

  async function handleBinary(data) {
    let bytes;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data && typeof data.arrayBuffer === 'function') bytes = new Uint8Array(await data.arrayBuffer());
    else return;
    const name = pendingBinary ? pendingBinary.name : null;
    pendingBinary = null;
    emit('event', { name, payload: bytes, json: null });
  }

  function connect() {
    if (socket || closed) return;
    if (!WebSocketImpl) { emit('error', new Error('no WebSocket implementation available')); return; }
    let created;
    try {
      created = new WebSocketImpl(`${url}/socket.io/?EIO=4&transport=websocket`);
    } catch (cause) {
      emit('error', cause);
      finish('construct');
      return;
    }
    socket = created;
    try { socket.binaryType = 'arraybuffer'; } catch { /* fake sockets may not have it */ }
    socket.onopen = () => emit('open', null);
    socket.onmessage = (event) => {
      const data = event && event.data;
      if (typeof data === 'string') handleText(data);
      else handleBinary(data);
    };
    socket.onerror = (event) => emit('error', event instanceof Error ? event : new Error('socket error'));
    socket.onclose = () => finish('socket');
  }

  // Sends a binary event: the header frame naming the event, then the payload.
  // With ack:true the returned promise settles when the server acks.
  function emitBinary(event, payload, opts = {}) {
    if (closed || !socket) return Promise.reject(new Error('socket is not connected'));
    const wantAck = opts.ack === true;
    const id = wantAck ? ackSeq++ : null;
    const header = `${EIO_MESSAGE}${SIO_BINARY_EVENT}1-${wantAck ? id : ''}` +
      `["${event}",{"_placeholder":true,"num":0}]`;
    let settle = null;
    const result = wantAck
      ? new Promise((resolve, reject) => { settle = { resolve, reject }; })
      : Promise.resolve(null);
    if (wantAck) pendingAcks.set(id, settle);
    if (!sendText(header)) {
      if (wantAck) pendingAcks.delete(id);
      return Promise.reject(new Error('could not send event header'));
    }
    try { socket.send(payload); }
    catch (cause) {
      if (wantAck) pendingAcks.delete(id);
      return Promise.reject(cause);
    }
    return result;
  }

  return {
    connect,
    emitBinary,
    on,
    id: () => socketId,
    close: () => finish('local'),
  };
}
