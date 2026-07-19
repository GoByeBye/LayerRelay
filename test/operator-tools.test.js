'use strict';

const assert = require('node:assert/strict');
const { test } = require('bun:test');

const overlayModule = import('../tools/_overlay-client.mjs');

test('overlay URL override avoids local config and write auth is scoped to mutations', async () => {
  const {
    overlayApiUrl,
    overlayRequestHeaders,
    resolveOverlayApiToken,
    resolveOverlayBaseUrl,
  } = await overlayModule;
  const base = resolveOverlayBaseUrl({
    env: { OVERLAY_URL: 'https://overlay.example/base/' },
    readFileSync() { throw new Error('config should not be read'); },
  });
  assert.equal(base, 'https://overlay.example/base');
  assert.equal(overlayApiUrl(base, '/api/message'), 'https://overlay.example/base/api/message');

  const env = { OVERLAY_API_TOKEN: 'secret-token' };
  assert.deepEqual(
    overlayRequestHeaders('POST', { 'Content-Type': 'application/json' }, env),
    { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
  );
  assert.deepEqual(overlayRequestHeaders('DELETE', {}, env), {
    Authorization: 'Bearer secret-token',
  });
  assert.deepEqual(overlayRequestHeaders('GET', {}, env), {});
  assert.equal(resolveOverlayApiToken({
    env: { OVERLAY_URL: 'https://remote.example' },
    readFileSync() { throw new Error('remote URL must not load a local token'); },
  }), '');
  assert.equal(resolveOverlayApiToken({
    env: {}, configPath: 'config.json', readFileSync: () => '{"apiToken":"from-config"}',
  }), 'from-config');
  assert.deepEqual(overlayRequestHeaders('POST', {}, {}, {
    configPath: 'config.json', readFileSync: () => '{"apiToken":"from-config"}',
  }), { Authorization: 'Bearer from-config' });
});

test('overlay config fallback validates its port and rejects unsafe URLs or tokens', async () => {
  const {
    normalizeOverlayBaseUrl,
    overlayRequestHeaders,
    resolveOverlayBaseUrl,
  } = await overlayModule;
  assert.equal(resolveOverlayBaseUrl({
    env: {}, configPath: 'example.json', readFileSync: () => '{"port":9123}',
  }), 'http://127.0.0.1:9123');
  assert.throws(
    () => resolveOverlayBaseUrl({
      env: {}, configPath: 'example.json', readFileSync: () => '{"port":70000}',
    }),
    /invalid overlay port/,
  );
  assert.throws(() => normalizeOverlayBaseUrl('file:///tmp/socket'), /must use http or https/);
  assert.throws(() => normalizeOverlayBaseUrl('http://user:pass@localhost:8787'), /embedded credentials/);
  assert.throws(
    () => overlayRequestHeaders('POST', {}, { OVERLAY_API_TOKEN: 'one\r\ntwo' }),
    /contains a newline/,
  );
  assert.throws(
    () => resolveOverlayBaseUrl({
      env: {},
      configPath: 'example.json',
      readFileSync: () => '{"apiToken": TOP_SECRET_TOKEN,',
    }),
    (error) => {
      assert.match(error.message, /invalid JSON/);
      assert.doesNotMatch(error.message, /TOP_SECRET_TOKEN/);
      return true;
    },
  );
});
