/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Minimal protobuf wire codec plus the handful of Prusa camera-signaling
 * message shapes the static dashboard needs. Field numbers were read out of
 * Prusa Connect's own published bundle (assets/CamerasView-*.js: the WebRtc
 * encoder `ir`, the ClientAuthentication encoder `An`), not guessed, and the
 * ClientAuthentication encoding here is the one that authenticated against the
 * live signaling server.
 */
// Browser ESM. No Node APIs, no dependencies.

const WIRE_VARINT = 0;
const WIRE_BYTES = 2;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function varintBytes(value) {
  const out = [];
  let n = value >>> 0;
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

export function createWriter() {
  const parts = [];
  const api = {
    varint(field, value) {
      if (value === undefined || value === null) return api;
      parts.push(...varintBytes((field << 3) | WIRE_VARINT), ...varintBytes(value));
      return api;
    },
    bytes(field, value) {
      if (value === undefined || value === null) return api;
      const body = value instanceof Uint8Array ? value : new Uint8Array(value);
      parts.push(...varintBytes((field << 3) | WIRE_BYTES), ...varintBytes(body.length), ...body);
      return api;
    },
    string(field, value) {
      if (value === undefined || value === null) return api;
      return api.bytes(field, textEncoder.encode(String(value)));
    },
    message(field, value) {
      if (value === undefined || value === null) return api;
      return api.bytes(field, value);
    },
    finish() {
      return Uint8Array.from(parts);
    },
  };
  return api;
}

// Decodes to { [fieldNumber]: entry | entry[] } where entry is
// { varint } or { bytes }. Length-delimited payloads stay raw on purpose: only
// the caller knows whether a field is a string or a nested message, and
// guessing produces silent corruption on binary strings.
export function decode(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const out = {};
  let off = 0;
  const readVarint = () => {
    let shift = 0;
    let value = 0;
    for (;;) {
      if (off >= buf.length) throw new Error('protobuf: truncated varint');
      const byte = buf[off++];
      value += (byte & 0x7f) * Math.pow(2, shift);
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 63) throw new Error('protobuf: varint too long');
    }
  };
  const push = (field, entry) => {
    if (out[field] === undefined) out[field] = entry;
    else if (Array.isArray(out[field])) out[field].push(entry);
    else out[field] = [out[field], entry];
  };
  while (off < buf.length) {
    const key = readVarint();
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === WIRE_VARINT) push(field, { varint: readVarint() });
    else if (wire === WIRE_BYTES) {
      const length = readVarint();
      if (off + length > buf.length) throw new Error('protobuf: truncated length-delimited field');
      push(field, { bytes: buf.subarray(off, off + length) });
      off += length;
    } else if (wire === 5) { off += 4; push(field, { fixed32: true }); }
    else if (wire === 1) { off += 8; push(field, { fixed64: true }); }
    else throw new Error(`protobuf: unsupported wire type ${wire}`);
  }
  return out;
}

const list = (value) => (value === undefined ? [] : (Array.isArray(value) ? value : [value]));
const asString = (entry) => (entry && entry.bytes ? textDecoder.decode(entry.bytes) : null);
const asNumber = (entry) => (entry && entry.varint !== undefined ? entry.varint : null);

export const WEBRTC_MSG_TYPE = Object.freeze({
  UNKNOWN: 0, REQUEST: 1, ANSWER: 2, OFFER: 3, CANDIDATE: 4,
});
export const WEBRTC_CLIENT_TYPE = Object.freeze({ UNKNOWN: 0, CAMERA: 1, CLIENT: 2 });
export const WEBRTC_STREAM_STATUS = Object.freeze({ INVALID: 0, START: 1, STOP: 2 });
export const ICE_SCHEME_TYPE = Object.freeze({ UNDEFINED: 0, STUN: 1, TURN: 2 });
export const ICE_TRANSPORT_PROTOCOL = Object.freeze({ UNDEFINED: 0, UDP: 1, TCP: 2, TLS: 3 });
export const ICE_POLICY = Object.freeze({ UNDEFINED: 0, ALL: 1, RELAY: 2 });

// ClientAuthentication { 1: camera_token, 2: client_type, 3: client_jwt_token }
// All three are strings; client_type is the literal "client" for a viewer.
export function encodeClientAuthentication({ cameraToken, clientType = 'client', jwt }) {
  return createWriter()
    .string(1, cameraToken)
    .string(2, clientType)
    .string(3, jwt)
    .finish();
}

// IceEndpoint { 1: scheme_type, 2: address, 3: port, 4: transport_protocol }
// IceServer { 1: repeated endpoints, 2: username, 3: credential }
// IceConfiguration { 1: repeated ice_servers, 2: ice_transport_policy, 3: ttl }
function encodeIceEndpoint(endpoint) {
  return createWriter()
    .varint(1, endpoint.schemeType)
    .string(2, endpoint.address)
    .varint(3, endpoint.port)
    .varint(4, endpoint.transportProtocol)
    .finish();
}

function encodeIceServer(server) {
  const writer = createWriter();
  for (const endpoint of server.endpoints || []) writer.message(1, encodeIceEndpoint(endpoint));
  return writer.string(2, server.username).string(3, server.credential).finish();
}

export function encodeIceConfiguration(config) {
  const writer = createWriter();
  for (const server of (config && config.iceServers) || []) writer.message(1, encodeIceServer(server));
  return writer
    .varint(2, config && config.iceTransportPolicy)
    .varint(3, config && config.ttl)
    .finish();
}

// Sdp { 1: candidate, 2: mid }. Both the SDP body and ICE candidates ride in
// `candidate`; message_type is what tells them apart.
export function encodeWebRtc(message) {
  const writer = createWriter()
    .string(1, message.cameraToken)
    .string(2, message.requestId)
    .string(3, message.fingerprint);
  if (message.sdp) {
    writer.message(4, createWriter()
      .string(1, message.sdp.candidate)
      .string(2, message.sdp.mid)
      .finish());
  }
  writer.varint(5, message.messageType)
    .varint(6, message.streamStatus)
    .varint(7, message.clientType);
  if (message.iceConfiguration) {
    writer.message(8, encodeIceConfiguration(message.iceConfiguration));
  }
  return writer.finish();
}

function decodeIceEndpoint(bytes) {
  const f = decode(bytes);
  return {
    schemeType: asNumber(f[1]),
    address: asString(f[2]),
    port: asNumber(f[3]),
    transportProtocol: asNumber(f[4]),
  };
}

function decodeIceServer(bytes) {
  const f = decode(bytes);
  return {
    endpoints: list(f[1]).map((entry) => decodeIceEndpoint(entry.bytes)),
    username: asString(f[2]),
    credential: asString(f[3]),
  };
}

export function decodeIceConfiguration(bytes) {
  const f = decode(bytes);
  return {
    iceServers: list(f[1]).map((entry) => decodeIceServer(entry.bytes)),
    iceTransportPolicy: asNumber(f[2]),
    ttl: asNumber(f[3]),
  };
}

export function decodeWebRtc(bytes) {
  const f = decode(bytes);
  const sdpEntry = Array.isArray(f[4]) ? f[4][0] : f[4];
  const sdpFields = sdpEntry ? decode(sdpEntry.bytes) : null;
  const iceEntry = Array.isArray(f[8]) ? f[8][0] : f[8];
  return {
    cameraToken: asString(f[1]),
    requestId: asString(f[2]),
    fingerprint: asString(f[3]),
    sdp: sdpFields ? { candidate: asString(sdpFields[1]), mid: asString(sdpFields[2]) } : null,
    messageType: asNumber(f[5]),
    streamStatus: asNumber(f[6]),
    clientType: asNumber(f[7]),
    iceConfiguration: iceEntry ? decodeIceConfiguration(iceEntry.bytes) : null,
  };
}
