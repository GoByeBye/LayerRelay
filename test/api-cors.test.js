'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { onTestFinished, test } = require('bun:test');
const { DEFAULT_CONFIG, validateConfig } = require('../config.js');

const rootDir = path.resolve(__dirname, '..');
const SERVER_TEST_TIMEOUT_MS = 60000;
const MEDIA_PATHS = ['/api/thumbnail', '/api/camera.mjpeg', '/api/camera.jpg', '/api/nozzle.mjpeg', '/api/nozzle.jpg'];

const validBaseConfig = Object.freeze({
  printerHost: 'printer.local',
  username: 'maker',
  password: 'secret',
  listenHost: '127.0.0.1',
  port: 8787,
  sourceCodeUrl: 'https://code.example/layer-relay/tree/test',
});

async function freePort() {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  return port;
}

// Boots a real server.js child over loopback only, like scripts/smoke.mjs.
// printerHost points at 127.0.0.1 where nothing listens, so polls fail fast
// and no network beyond this machine's loopback is ever touched.
async function startServer(configPatch = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-api-cors-'));
  const port = await freePort();
  const configPath = path.join(tempDir, 'config.json');
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // Seed a fresh OpenPrintTag snapshot so the spawned server's boot-time index
  // refresh is satisfied from disk and never opens an outbound connection.
  fs.writeFileSync(path.join(dataDir, 'openprinttag-materials-v1.json'), JSON.stringify({
    version: 1,
    checkedAt: Date.now(),
    materials: Array.from({ length: 100 }, (_, i) => ({
      brandSlug: 'examplebrand',
      slug: `material-${i}`,
      brand: 'Example Brand',
      type: 'PLA',
      name: `Test Filament ${i}`,
      color: null,
    })),
  }));
  fs.writeFileSync(configPath, JSON.stringify({
    printerHost: '127.0.0.1',
    username: 'cors-test',
    password: 'cors-test',
    sourceCodeUrl: 'https://code.example/layer-relay/tree/cors-test',
    ...configPatch,
  }));
  const child = Bun.spawn([process.execPath, 'server.js'], {
    cwd: rootDir,
    windowsHide: true,
    env: {
      ...process.env,
      CONFIG_PATH: configPath,
      DATA_DIR: dataDir,
      LISTEN_HOST: '127.0.0.1',
      PORT: String(port),
      CAMERA_STREAM_ENABLED: 'false',
      NOZZLE_STREAM_ENABLED: 'false',
    },
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  });
  onTestFinished(async () => {
    if (child.exitCode == null) {
      child.kill();
      const timedOut = await Promise.race([child.exited.then(() => false), Bun.sleep(6000).then(() => true)]);
      if (timedOut && child.exitCode == null) {
        child.kill(9);
        await child.exited;
      }
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* Windows can briefly hold handles from the exiting child. */ }
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      if (response.ok && body?.ok === true) return baseUrl;
      lastError = new Error(`health endpoint returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`server did not become healthy: ${lastError?.message || 'timeout'}`);
}

test('apiReadAllowedOrigins accepts exact origin lists and rejects malformed entries', () => {
  assert.deepEqual(DEFAULT_CONFIG.apiReadAllowedOrigins, []);

  const accepted = validateConfig({
    ...validBaseConfig,
    apiReadAllowedOrigins: ['https://username.github.io', 'http://127.0.0.1:8788'],
  });
  assert.deepEqual(accepted.apiReadAllowedOrigins, ['https://username.github.io', 'http://127.0.0.1:8788']);
  assert.deepEqual(validateConfig({ ...validBaseConfig, apiReadAllowedOrigins: [] }).apiReadAllowedOrigins, []);

  for (const [patch, pattern] of [
    [{ apiReadAllowedOrigins: 'https://pages.example' }, /apiReadAllowedOrigins must be an array of at most 16/],
    [
      { apiReadAllowedOrigins: Array.from({ length: 17 }, (_, i) => `https://origin${i}.example`) },
      /apiReadAllowedOrigins must be an array of at most 16/,
    ],
    [{ apiReadAllowedOrigins: ['https://pages.example/path'] }, /apiReadAllowedOrigins\.0 must be an exact HTTP\(S\) origin/],
    [{ apiReadAllowedOrigins: ['ftp://pages.example'] }, /exact HTTP\(S\) origin/],
    [{ apiReadAllowedOrigins: ['https://user:pw@pages.example'] }, /exact HTTP\(S\) origin/],
    [{ apiReadAllowedOrigins: ['https://pages.example?q=1'] }, /exact HTTP\(S\) origin/],
    [{ apiReadAllowedOrigins: ['https://pages.example', ' https://other.example'] }, /apiReadAllowedOrigins\.1 must be an exact HTTP\(S\) origin/],
    [{ apiReadAllowedOrigins: [42] }, /exact HTTP\(S\) origin/],
    [{ apiReadAllowedOrigins: ['https://pages.example', 'https://pages.example'] }, /apiReadAllowedOrigins entries must be unique/],
  ]) {
    assert.throws(() => validateConfig({ ...validBaseConfig, ...patch }), pattern);
  }
});

test('listed origins get exact CORS read headers, preflights, and gated writes', async () => {
  const readOnlyOrigin = 'https://pages.example';
  const readWriteOrigin = 'https://dashboard.example';
  const baseUrl = await startServer({
    apiReadAllowedOrigins: [readOnlyOrigin, readWriteOrigin],
    toolSettingsAllowedOrigins: [readWriteOrigin],
  });

  // GET with a listed origin: exactly that origin is echoed, never a wildcard.
  const allowedRead = await fetch(`${baseUrl}/api/state`, { headers: { Origin: readOnlyOrigin } });
  assert.equal(allowedRead.status, 200);
  assert.equal(allowedRead.headers.get('access-control-allow-origin'), readOnlyOrigin);
  assert.equal(allowedRead.headers.get('vary'), 'Origin');
  assert.equal(allowedRead.headers.get('access-control-expose-headers'), 'ETag');
  await allowedRead.arrayBuffer();

  // HEAD gets the same treatment as GET.
  const allowedHead = await fetch(`${baseUrl}/api/state`, { method: 'HEAD', headers: { Origin: readWriteOrigin } });
  assert.equal(allowedHead.headers.get('access-control-allow-origin'), readWriteOrigin);

  // Unlisted origins are never reflected, and requests without Origin get no CORS headers.
  const deniedRead = await fetch(`${baseUrl}/api/state`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(deniedRead.status, 200);
  assert.equal(deniedRead.headers.get('access-control-allow-origin'), null);
  await deniedRead.arrayBuffer();
  const bareRead = await fetch(`${baseUrl}/api/state`);
  assert.equal(bareRead.headers.get('access-control-allow-origin'), null);
  await bareRead.arrayBuffer();

  // Case-different and near-miss origins are not exact matches.
  const nearMissRead = await fetch(`${baseUrl}/api/state`, { headers: { Origin: 'https://PAGES.example' } });
  assert.equal(nearMissRead.headers.get('access-control-allow-origin'), null);
  await nearMissRead.arrayBuffer();

  // Preflight for a read-only origin advertises GET alone.
  const readPreflight = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'OPTIONS',
    headers: { Origin: readOnlyOrigin, 'Access-Control-Request-Method': 'PUT' },
  });
  assert.equal(readPreflight.status, 204);
  assert.equal(readPreflight.headers.get('access-control-allow-origin'), readOnlyOrigin);
  assert.equal(readPreflight.headers.get('access-control-allow-methods'), 'GET');
  assert.equal(readPreflight.headers.get('access-control-allow-headers'), 'Content-Type, If-Match');
  assert.equal(readPreflight.headers.get('access-control-max-age'), '600');

  // Preflight for an origin in both lists advertises PUT as well.
  const writePreflight = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'OPTIONS',
    headers: { Origin: readWriteOrigin, 'Access-Control-Request-Method': 'PUT' },
  });
  assert.equal(writePreflight.status, 204);
  assert.equal(writePreflight.headers.get('access-control-allow-origin'), readWriteOrigin);
  assert.equal(writePreflight.headers.get('access-control-allow-methods'), 'GET, PUT');

  // Preflight from an unlisted origin receives no CORS grant at all.
  const deniedPreflight = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' },
  });
  assert.notEqual(deniedPreflight.status, 204);
  assert.equal(deniedPreflight.headers.get('access-control-allow-origin'), null);
  assert.equal(deniedPreflight.headers.get('access-control-allow-methods'), null);
  await deniedPreflight.arrayBuffer();

  // Cross-site settings flow: read the revision, then save with If-Match.
  const toolsRead = await fetch(`${baseUrl}/api/settings/tools`, { headers: { Origin: readWriteOrigin } });
  const etag = toolsRead.headers.get('etag');
  assert.ok(etag);
  assert.equal(toolsRead.headers.get('access-control-allow-origin'), readWriteOrigin);
  assert.equal(toolsRead.headers.get('access-control-expose-headers'), 'ETag');
  await toolsRead.arrayBuffer();

  const acceptedWrite = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: readWriteOrigin,
      'Sec-Fetch-Site': 'cross-site',
      'If-Match': etag,
    },
    body: JSON.stringify({ toolCount: 2, toolSlots: {} }),
  });
  assert.equal(acceptedWrite.status, 200);
  assert.equal(acceptedWrite.headers.get('access-control-allow-origin'), readWriteOrigin);
  assert.equal((await acceptedWrite.json()).toolCount, 2);
  const nextEtag = acceptedWrite.headers.get('etag');
  assert.ok(nextEtag && nextEtag !== etag);

  // Stale and missing If-Match still conflict; the 409 carries CORS headers so
  // the listed page can read the error.
  const staleWrite = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: readWriteOrigin,
      'Sec-Fetch-Site': 'cross-site',
      'If-Match': etag,
    },
    body: JSON.stringify({ toolCount: 3, toolSlots: {} }),
  });
  assert.equal(staleWrite.status, 409);
  assert.equal(staleWrite.headers.get('access-control-allow-origin'), readWriteOrigin);
  await staleWrite.arrayBuffer();
  const noMatchWrite = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: readWriteOrigin, 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ toolCount: 3, toolSlots: {} }),
  });
  assert.equal(noMatchWrite.status, 409);
  assert.equal(noMatchWrite.headers.get('access-control-allow-origin'), readWriteOrigin);
  await noMatchWrite.arrayBuffer();

  // Invalid shapes still 400, with CORS headers for the listed origin.
  const invalidWrite = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: readWriteOrigin,
      'Sec-Fetch-Site': 'cross-site',
      'If-Match': nextEtag,
    },
    body: JSON.stringify({ toolCount: 'many', toolSlots: {} }),
  });
  assert.equal(invalidWrite.status, 400);
  assert.equal(invalidWrite.headers.get('access-control-allow-origin'), readWriteOrigin);
  await invalidWrite.arrayBuffer();

  // A read-listed origin without write listing cannot save, even with a valid revision.
  const readOnlyWrite = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: readOnlyOrigin,
      'Sec-Fetch-Site': 'cross-site',
      'If-Match': nextEtag,
    },
    body: JSON.stringify({ toolCount: 3, toolSlots: {} }),
  });
  assert.equal(readOnlyWrite.status, 403);
  assert.equal(readOnlyWrite.headers.get('access-control-allow-origin'), readOnlyOrigin);
  await readOnlyWrite.arrayBuffer();

  // Unlisted origins keep hitting the unchanged same-origin gate, unreflected.
  const evilWrite = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
      'Sec-Fetch-Site': 'cross-site',
      'If-Match': nextEtag,
    },
    body: JSON.stringify({ toolCount: 3, toolSlots: {} }),
  });
  assert.equal(evilWrite.status, 403);
  assert.equal(evilWrite.headers.get('access-control-allow-origin'), null);
  await evilWrite.arrayBuffer();

  // The original loopback same-origin acceptance path is untouched.
  const loopbackWrite = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'If-Match': nextEtag },
    body: JSON.stringify({ toolCount: 4, toolSlots: {} }),
  });
  assert.equal(loopbackWrite.status, 200);
  assert.equal((await loopbackWrite.json()).toolCount, 4);

  // Saves survived only where accepted: 2 then 4, never 3.
  const finalTools = await (await fetch(`${baseUrl}/api/settings/tools`)).json();
  assert.equal(finalTools.toolCount, 4);

  // A non-empty read allowlist relaxes CORP on the five image/stream routes only.
  for (const mediaPath of MEDIA_PATHS) {
    const response = await fetch(`${baseUrl}${mediaPath}`);
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin', mediaPath);
    await response.arrayBuffer();
  }
  for (const otherPath of ['/api/state', '/api/jobmap', '/healthz']) {
    const response = await fetch(`${baseUrl}${otherPath}`);
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin', otherPath);
    await response.arrayBuffer();
  }
}, SERVER_TEST_TIMEOUT_MS);

test('an empty read allowlist keeps every response same-origin', async () => {
  const writeOrigin = 'https://dashboard.example';
  const baseUrl = await startServer({ toolSettingsAllowedOrigins: [writeOrigin] });

  // No CORS read headers for any origin, listed for writes or not.
  for (const origin of [writeOrigin, 'https://pages.example']) {
    const read = await fetch(`${baseUrl}/api/state`, { headers: { Origin: origin } });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('access-control-allow-origin'), null);
    assert.equal(read.headers.get('access-control-expose-headers'), null);
    await read.arrayBuffer();
  }

  // No preflight grant either, so browsers cannot start a cross-site save.
  const preflight = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'OPTIONS',
    headers: { Origin: writeOrigin, 'Access-Control-Request-Method': 'PUT' },
  });
  assert.notEqual(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  await preflight.arrayBuffer();

  // The write gate itself is governed by toolSettingsAllowedOrigins alone.
  const toolsRead = await fetch(`${baseUrl}/api/settings/tools`);
  const etag = toolsRead.headers.get('etag');
  assert.ok(etag);
  await toolsRead.arrayBuffer();
  const crossSiteWrite = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: writeOrigin,
      'Sec-Fetch-Site': 'cross-site',
      'If-Match': etag,
    },
    body: JSON.stringify({ toolCount: 2, toolSlots: {} }),
  });
  assert.equal(crossSiteWrite.status, 200);
  assert.equal(crossSiteWrite.headers.get('access-control-allow-origin'), null);
  await crossSiteWrite.arrayBuffer();

  // CORP stays same-origin on the image/stream routes when the list is empty.
  for (const mediaPath of MEDIA_PATHS) {
    const response = await fetch(`${baseUrl}${mediaPath}`);
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin', mediaPath);
    await response.arrayBuffer();
  }
}, SERVER_TEST_TIMEOUT_MS);
