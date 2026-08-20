/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Live camera video for the static dashboard's cloud mode, straight from Prusa
 * Connect's WebRTC path with no server in between. The signaling handshake is
 * the same one Prusa's own web client performs; the message shapes live in
 * protobuf.mjs.
 *
 * THIS MODULE NEVER SENDS A `configuration` EVENT. That message switches the
 * camera between WebRTC and RTSP, and turning WebRTC on turns the camera's RTSP
 * server off, which would silently break anyone feeding OBS from RTSP. Choosing
 * the camera's mode is the owner's decision, made in Prusa Connect. All this
 * module does is ask an already-WebRTC camera for a stream.
 */
// Browser ESM. No Node APIs, no dependencies.

import {
  encodeClientAuthentication, encodeWebRtc, decodeWebRtc, encodeCameraTrigger, readWebrtcMode,
  WEBRTC_MSG_TYPE, WEBRTC_CLIENT_TYPE, WEBRTC_MODE,
  ICE_SCHEME_TYPE, ICE_TRANSPORT_PROTOCOL, ICE_POLICY,
} from './protobuf.mjs';
import { createSocketIo } from './socketio.mjs';

const SIGNALING_URL = 'wss://camera-signaling.prusa3d.com';
const ICE_CONFIG_URL = 'https://camera-service-api.prusa3d.com/v1/camera-webrtc-config';
// Prusa's client arms the same 15s window on its REQUEST.
const REQUEST_TIMEOUT_MS = 15000;
// By far the likeliest reason a camera never answers, so say it rather than
// leaving the user staring at a generic timeout.
const NO_ANSWER_MESSAGE = 'the camera did not answer. It may be set to RTSP rather than ' +
  'WebRTC in Prusa Connect, or it may be offline.';
// The camera reports its own mode, so say so exactly rather than inferring it
// from silence. Switching it back is a decision with a side effect worth
// naming: the same setting that enables WebRTC turns the RTSP server off.
const RTSP_MODE_MESSAGE = 'this camera is set to RTSP, not WebRTC, so it will not send video to ' +
  'a browser. Switching it to WebRTC in Prusa Connect turns its RTSP server off, which breaks ' +
  'anything reading rtsp:// from it, such as OBS or a LayerRelay relay.';

// stun:host:port / turns:host:port?transport=tcp, matching Prusa's own parser.
const ICE_URL = /^(stun|turn|turns):([^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp|tls))?$/;

export function iceUrlToEndpoint(url) {
  const match = ICE_URL.exec(String(url || ''));
  if (!match) return { address: String(url || '') };
  const [, scheme, address, port, transport] = match;
  const endpoint = { address };
  if (scheme === 'stun') endpoint.schemeType = ICE_SCHEME_TYPE.STUN;
  else endpoint.schemeType = ICE_SCHEME_TYPE.TURN;
  if (port) endpoint.port = parseInt(port, 10);
  if (transport === 'udp') endpoint.transportProtocol = ICE_TRANSPORT_PROTOCOL.UDP;
  else if (transport === 'tcp') endpoint.transportProtocol = ICE_TRANSPORT_PROTOCOL.TCP;
  else if (transport === 'tls' || scheme === 'turns') {
    endpoint.transportProtocol = ICE_TRANSPORT_PROTOCOL.TLS;
  }
  return endpoint;
}

// The REST endpoint answers in the browser's own RTCConfiguration shape; the
// signaling channel wants the protobuf one.
export function restIceToProtobuf(configuration, ttl) {
  const servers = (configuration && configuration.iceServers) || [];
  return {
    iceServers: servers.map((server) => ({
      endpoints: (Array.isArray(server.urls) ? server.urls : [server.urls]).map(iceUrlToEndpoint),
      username: server.username,
      credential: server.credential,
    })),
    iceTransportPolicy: configuration && configuration.iceTransportPolicy === 'relay'
      ? ICE_POLICY.RELAY : ICE_POLICY.ALL,
    ttl,
  };
}

export function createCloudCamera(options = {}) {
  const getAccessToken = options.getAccessToken;
  const cameraToken = options.cameraToken;
  const fetchImpl = options.fetchImpl ||
    (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const socketFactory = options.socketFactory || createSocketIo;
  const peerFactory = options.peerFactory ||
    ((config) => new RTCPeerConnection(config));
  const timers = options.timers || {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };

  const listeners = new Map();
  let socket = null;
  let peer = null;
  let stream = null;
  let requestTimer = null;
  let phase = 'idle';
  let lastError = null;
  let stopped = false;
  // Inbound signaling is filtered on this: the server fans messages out and a
  // reply meant for another viewer must not drive our peer connection.
  let sessionId = null;

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

  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    emit('status', getStatus());
  }

  function fail(message) {
    if (stopped) return;
    lastError = message;
    setPhase('error');
    emit('error', new Error(message));
    stop();
  }

  function clearRequestTimer() {
    if (requestTimer != null) {
      timers.clearTimeout(requestTimer);
      requestTimer = null;
    }
  }

  function sendWebRtc(fields) {
    if (!socket || stopped) return;
    const payload = encodeWebRtc({
      cameraToken,
      requestId: sessionId,
      fingerprint: sessionId,
      clientType: WEBRTC_CLIENT_TYPE.CLIENT,
      ...fields,
    });
    // Deliberately the only event this module ever emits besides
    // client_authentication. See the file header.
    socket.emitBinary('webrtc', payload).catch(() => { /* link teardown races */ });
  }

  async function handleOffer(message) {
    clearRequestTimer();
    setPhase('negotiating');
    try {
      await peer.setRemoteDescription({ type: 'offer', sdp: message.sdp.candidate });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      sendWebRtc({
        messageType: WEBRTC_MSG_TYPE.ANSWER,
        sdp: { candidate: answer.sdp, mid: '0' },
      });
    } catch (cause) {
      fail(`could not answer the camera offer: ${cause && cause.message ? cause.message : cause}`);
    }
  }

  async function handleCandidate(message) {
    if (!peer || !message.sdp || !message.sdp.candidate) return;
    try {
      await peer.addIceCandidate({
        candidate: message.sdp.candidate,
        sdpMid: message.sdp.mid || '0',
      });
    } catch { /* a candidate that arrives too late is not fatal */ }
  }

  // A status message answers the question the 15s timeout can only guess at.
  function handleStatus(bytes) {
    const mode = readWebrtcMode(bytes);
    if (mode === WEBRTC_MODE.OFF) fail(RTSP_MODE_MESSAGE);
  }

  function handleSignal(bytes) {
    let message;
    try { message = decodeWebRtc(bytes); }
    catch { return; }
    if (sessionId && message.requestId && message.requestId !== sessionId) return;
    if (message.messageType === WEBRTC_MSG_TYPE.OFFER && message.sdp) handleOffer(message);
    else if (message.messageType === WEBRTC_MSG_TYPE.CANDIDATE) handleCandidate(message);
  }

  async function start() {
    if (socket || stopped) return;
    if (!cameraToken) { fail('no camera token is configured'); return; }
    if (!fetchImpl) { fail('this browser provides no fetch implementation'); return; }
    setPhase('connecting');
    lastError = null;

    let accessToken;
    try { accessToken = await getAccessToken(); }
    catch (cause) { fail(`could not obtain a Prusa access token: ${cause && cause.message}`); return; }

    // Wildcard CORS with Authorization allowed, so a static page may call this.
    let iceConfiguration = null;
    let ttl;
    try {
      const response = await fetchImpl(ICE_CONFIG_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        cache: 'no-store',
      });
      if (response && response.ok) {
        const body = await response.json();
        iceConfiguration = body && body.configuration ? body.configuration : null;
        ttl = iceConfiguration && iceConfiguration.ttl;
      }
    } catch { iceConfiguration = null; }
    // A missing ICE config is survivable on a local network, so carry on with
    // an empty server list rather than refusing to try.
    const rtcConfig = iceConfiguration
      ? { iceServers: iceConfiguration.iceServers, iceTransportPolicy: iceConfiguration.iceTransportPolicy }
      : { iceServers: [] };

    try { peer = peerFactory(rtcConfig); }
    catch (cause) { fail(`this browser refused to create a peer connection: ${cause && cause.message}`); return; }

    peer.ontrack = (event) => {
      const incoming = (event.streams && event.streams[0]) ||
        (event.track ? new MediaStream([event.track]) : null);
      if (!incoming) return;
      stream = incoming;
      clearRequestTimer();
      setPhase('live');
      emit('stream', stream);
    };
    peer.onicecandidate = (event) => {
      if (!event || !event.candidate) return;
      sendWebRtc({
        messageType: WEBRTC_MSG_TYPE.CANDIDATE,
        sdp: { candidate: event.candidate.candidate, mid: event.candidate.sdpMid || '0' },
      });
    };
    peer.onconnectionstatechange = () => {
      const state = peer && peer.connectionState;
      if (state === 'failed' || state === 'disconnected') fail(`the video connection ${state}`);
    };

    socket = socketFactory({ url: SIGNALING_URL, WebSocketImpl: options.WebSocketImpl });
    socket.on('close', () => { if (!stopped && phase !== 'error') fail('the signaling link closed'); });
    socket.on('error', () => { /* a close event follows */ });
    socket.on('event', (evt) => {
      if (!evt || !evt.payload) return;
      if (evt.name === 'webrtc') handleSignal(evt.payload);
      // The camera answers get_status on an event whose name the server does
      // not always label, so any other binary frame is tried as a status.
      else handleStatus(evt.payload);
    });
    socket.on('connect', async ({ id }) => {
      sessionId = id;
      setPhase('authenticating');
      try {
        const ack = await socket.emitBinary(
          'client_authentication',
          encodeClientAuthentication({ cameraToken, jwt: accessToken }),
          { ack: true },
        );
        if (ack !== 0) { fail(`Prusa rejected the camera token (code ${ack})`); return; }
      } catch (cause) {
        fail(`camera authentication failed: ${cause && cause.message}`);
        return;
      }
      if (stopped) return;
      setPhase('requesting');
      // Read-only query: tells us the camera's mode so a camera in RTSP mode
      // gets a precise explanation instead of a silent fifteen second wait.
      socket.emitBinary('trigger', encodeCameraTrigger({
        cameraToken, requestId: sessionId, query: 'get_status',
      })).catch(() => { /* the request below is what actually matters */ });
      sendWebRtc({
        messageType: WEBRTC_MSG_TYPE.REQUEST,
        iceConfiguration: iceConfiguration ? restIceToProtobuf(iceConfiguration, ttl) : undefined,
      });
      requestTimer = timers.setTimeout(() => { requestTimer = null; fail(NO_ANSWER_MESSAGE); },
        REQUEST_TIMEOUT_MS);
    });
    socket.connect();
  }

  function stop() {
    stopped = true;
    clearRequestTimer();
    if (peer) {
      peer.ontrack = null;
      peer.onicecandidate = null;
      peer.onconnectionstatechange = null;
      try { peer.close(); } catch { /* already closed */ }
      peer = null;
    }
    if (stream) {
      for (const track of stream.getTracks ? stream.getTracks() : []) {
        try { track.stop(); } catch { /* already stopped */ }
      }
      stream = null;
    }
    const current = socket;
    socket = null;
    if (current) {
      try { current.close(); } catch { /* already closed */ }
    }
    if (phase !== 'error') phase = 'idle';
    emit('stopped', null);
  }

  function getStatus() {
    return { phase, error: lastError, live: phase === 'live' };
  }

  return { start, stop, on, getStatus, getStream: () => stream };
}
