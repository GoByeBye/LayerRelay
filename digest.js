'use strict';
// Minimal HTTP Digest auth client (MD5, qop=auth) over Node's http module.
// PrusaLink uses: WWW-Authenticate: Digest realm="Printer API", nonce="...", qop absent/auth.
const http = require('http');
const crypto = require('crypto');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseChallenge(header) {
  const out = {};
  // Strip leading "Digest " then split on commas not inside quotes.
  const body = header.replace(/^Digest\s+/i, '');
  for (const m of body.matchAll(/(\w+)=(?:"([^"]*)"|([^,]*))/g)) {
    out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

function buildAuthHeader(chal, { username, password, method, uri }) {
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = md5(`${username}:${chal.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  let response, extra = '';
  if (chal.qop) {
    const qop = chal.qop.split(',')[0].trim();
    response = md5(`${ha1}:${chal.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    extra = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5(`${ha1}:${chal.nonce}:${ha2}`);
  }
  let h = `Digest username="${username}", realm="${chal.realm}", nonce="${chal.nonce}", uri="${uri}", response="${response}"`;
  if (chal.opaque) h += `, opaque="${chal.opaque}"`;
  h += extra;
  return h;
}

function rawRequest(host, { method, path, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, method, path, headers: headers || {}, timeout: timeoutMs || 10000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

// Perform a digest-authenticated GET. Returns { status, headers, body:Buffer }.
async function digestGet(cfg, path, extraHeaders = {}, timeoutMs = 12000) {
  const host = cfg.printerHost;
  const method = 'GET';
  // First request to obtain the challenge.
  const first = await rawRequest(host, { method, path, headers: extraHeaders, timeoutMs });
  if (first.status !== 401) return first; // already OK (or a real error we surface)
  const wwwAuth = first.headers['www-authenticate'];
  if (!wwwAuth) return first;
  const chal = parseChallenge(wwwAuth);
  const auth = buildAuthHeader(chal, {
    username: cfg.username,
    password: cfg.password,
    method,
    uri: path,
  });
  return rawRequest(host, {
    method,
    path,
    headers: { ...extraHeaders, Authorization: auth },
    timeoutMs,
  });
}

async function digestGetJson(cfg, path, timeoutMs = 8000) {
  const r = await digestGet(cfg, path, {}, timeoutMs);
  if (r.status !== 200) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return JSON.parse(r.body.toString('utf8'));
}

module.exports = { digestGet, digestGetJson };
