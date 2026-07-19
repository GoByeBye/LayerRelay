'use strict';
// Minimal HTTP Digest auth client (MD5, qop=auth) over Node's http module.
// PrusaLink uses: WWW-Authenticate: Digest realm="Printer API", nonce="...", qop absent/auth.
const http = require('http');
const crypto = require('crypto');
const { armRequestDeadline } = require('./request-deadline.js');

const agents = new Map();
const challengeCache = new Map();
const DEFAULT_MAX_BODY_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseChallenge(header) {
  if (!/^Digest\s+/i.test(header || '')) throw new Error('unsupported authentication challenge');
  const out = {};
  // Strip leading "Digest " then split on commas not inside quotes.
  const body = header.replace(/^Digest\s+/i, '');
  for (const m of body.matchAll(/(\w+)=(?:"([^"]*)"|([^,]*))/g)) {
    out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  if (!out.realm || !out.nonce) throw new Error('invalid Digest challenge');
  if (out.algorithm && out.algorithm.toUpperCase() !== 'MD5') {
    throw new Error(`unsupported Digest algorithm ${out.algorithm}`);
  }
  return out;
}

const quote = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function buildAuthHeader(chal, { username, password, method, uri }, nonceCount, cnonce) {
  const nc = nonceCount.toString(16).padStart(8, '0');
  const ha1 = md5(`${username}:${chal.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  let response, extra = '';
  if (chal.qop) {
    const qop = chal.qop.split(',').map((value) => value.trim().toLowerCase()).find((value) => value === 'auth');
    if (!qop) throw new Error(`unsupported Digest qop ${chal.qop}`);
    response = md5(`${ha1}:${chal.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    extra = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5(`${ha1}:${chal.nonce}:${ha2}`);
  }
  let h = `Digest username="${quote(username)}", realm="${quote(chal.realm)}", nonce="${quote(chal.nonce)}", uri="${quote(uri)}", response="${response}"`;
  if (chal.opaque) h += `, opaque="${quote(chal.opaque)}"`;
  if (chal.algorithm) h += `, algorithm=${chal.algorithm}`;
  h += extra;
  return h;
}

function agentFor(host) {
  let agent = agents.get(host);
  if (!agent) {
    agent = new http.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1, timeout: 30000 });
    agents.set(host, agent);
  }
  return agent;
}

function createRawRequest(options = {}) {
  const requestImpl = options.requestImpl || http.request;
  return function rawRequest(host, { method, path, headers, timeoutMs, signal,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES }) {
    return new Promise((resolve, reject) => {
      const requestTimeoutMs = Math.max(1, Number(timeoutMs) || 10000);
      let settled = false;
      let clearDeadline = () => {};
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearDeadline();
        reject(error);
      };
      let req;
      const timeoutRequest = () => {
        const error = new Error('request timeout');
        fail(error);
        if (req) req.destroy(error);
      };
      req = requestImpl(
        { host, method, path, headers: headers || {}, timeout: requestTimeoutMs, signal,
          agent: options.agent === undefined ? agentFor(host) : options.agent },
        (res) => {
          const chunks = [];
          let bytes = 0;
          res.on('aborted', () => fail(new Error('response aborted')));
          res.on('error', fail);
          const contentLength = Number(res.headers['content-length']);
          if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
            const error = new Error(`response exceeds ${maxBodyBytes} bytes`);
            fail(error);
            res.destroy(error);
            return;
          }
          res.on('data', (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > maxBodyBytes) {
              const error = new Error(`response exceeds ${maxBodyBytes} bytes`);
              fail(error);
              res.destroy(error);
              return;
            }
            chunks.push(buffer);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            clearDeadline();
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks, bytes) });
          });
        }
      );
      req.on('error', fail);
      req.on('timeout', timeoutRequest);
      clearDeadline = armRequestDeadline(requestTimeoutMs, timeoutRequest);
      req.end();
    });
  };
}

const rawRequest = createRawRequest();

function rememberChallenge(host, challenge) {
  const current = challengeCache.get(host);
  const entry = current && current.challenge.nonce === challenge.nonce
    ? { challenge, nonceCount: current.nonceCount, cnonce: current.cnonce }
    : { challenge, nonceCount: 0, cnonce: crypto.randomBytes(8).toString('hex') };
  challengeCache.set(host, entry);
  return entry;
}

function authHeader(host, credentials) {
  const entry = challengeCache.get(host);
  if (!entry) return null;
  entry.nonceCount++;
  return buildAuthHeader(entry.challenge, credentials, entry.nonceCount, entry.cnonce);
}

// Perform a digest-authenticated GET. Returns { status, headers, body:Buffer }.
async function digestGet(cfg, path, extraHeaders = {}, timeoutMs = 12000, options = {}) {
  const host = cfg.printerHost;
  const method = 'GET';
  const maxBodyBytes = Math.max(1024, Number(options.maxBodyBytes) || Number(cfg.maxPrinterResponseBytes) || DEFAULT_MAX_BODY_BYTES);
  const requestOptions = { method, path, timeoutMs, signal: options.signal, maxBodyBytes };
  const credentials = {
    username: cfg.username,
    password: cfg.password,
    method,
    uri: path,
  };

  let authorization = authHeader(host, credentials);
  let response = await rawRequest(host, {
    ...requestOptions,
    headers: authorization ? { ...extraHeaders, Authorization: authorization } : extraHeaders,
  });
  if (response.status !== 401) return response;

  let wwwAuth = response.headers['www-authenticate'];
  if (!wwwAuth) return response;
  rememberChallenge(host, parseChallenge(wwwAuth));
  authorization = authHeader(host, credentials);
  response = await rawRequest(host, {
    ...requestOptions,
    headers: { ...extraHeaders, Authorization: authorization },
  });
  // A nonce may expire between challenge and request. Refresh it once; never loop forever on
  // bad credentials or an unsupported printer response.
  if (response.status === 401 && response.headers['www-authenticate']) {
    wwwAuth = response.headers['www-authenticate'];
    rememberChallenge(host, parseChallenge(wwwAuth));
    authorization = authHeader(host, credentials);
    response = await rawRequest(host, {
      ...requestOptions,
      headers: { ...extraHeaders, Authorization: authorization },
    });
  }
  return response;
}

async function digestGetJson(cfg, path, timeoutMs = 8000, options = {}) {
  const maxBodyBytes = Math.max(1024, Number(cfg.maxPrinterJsonBytes) || DEFAULT_MAX_JSON_BYTES);
  const r = await digestGet(cfg, path, {}, timeoutMs, { ...options, maxBodyBytes });
  if (r.status === 204 && options.allowNoContent) return null;
  if (r.status !== 200) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return JSON.parse(r.body.toString('utf8'));
}

module.exports = { createRawRequest, digestGet, digestGetJson };
