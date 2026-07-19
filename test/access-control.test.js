'use strict';

const assert = require('node:assert/strict');
const { test } = require('bun:test');
const { canWrite, isLoopbackAddress, isSafeLocalBrowserRequest } = require('../access-control.js');

test('token configuration requires the token even over loopback', () => {
  const request = { remoteAddress: '127.0.0.1', host: 'localhost:8787', expectedToken: 'secret' };
  assert.equal(canWrite(request), false);
  assert.equal(canWrite({ ...request, suppliedToken: 'wrong' }), false);
  assert.equal(canWrite({ ...request, suppliedToken: 'secret' }), true);
  assert.equal(canWrite({ ...request, expectedToken: true, suppliedToken: 'true' }), false);
});

test('tokenless writes are limited to a local socket and local Host header', () => {
  assert.equal(canWrite({ remoteAddress: '127.0.0.1', host: 'localhost:8787' }), true);
  assert.equal(canWrite({ remoteAddress: '::ffff:127.0.0.1', host: '127.0.0.1:8787' }), true);
  assert.equal(canWrite({ remoteAddress: '192.0.2.20', host: 'localhost:8787' }), false);
  assert.equal(canWrite({ remoteAddress: '127.0.0.1', host: 'attacker.example' }), false);
});

test('tokenless browser writes reject cross-origin and DNS-rebinding shapes', () => {
  assert.equal(isSafeLocalBrowserRequest({
    host: 'localhost:8787',
    origin: 'http://localhost:8787',
    secFetchSite: 'same-origin',
  }), true);
  assert.equal(isSafeLocalBrowserRequest({
    host: 'localhost:8787',
    origin: 'https://attacker.example',
    secFetchSite: 'cross-site',
  }), false);
  assert.equal(isSafeLocalBrowserRequest({
    host: 'attacker.example',
    origin: 'https://attacker.example',
    secFetchSite: 'same-origin',
  }), false);
  for (const hostname of ['127.attacker.example', '127.0.0.1.attacker.example']) {
    assert.equal(isSafeLocalBrowserRequest({
      host: `${hostname}:8787`,
      origin: `http://${hostname}:8787`,
      secFetchSite: 'same-origin',
    }), false);
  }
  assert.equal(isSafeLocalBrowserRequest({
    host: 'http://127.0.0.1:8787',
    origin: 'http://127.0.0.1:8787',
    secFetchSite: 'same-origin',
  }), false);
});

test('recognizes IPv4, mapped IPv4, and IPv6 loopback sockets', () => {
  for (const address of ['127.0.0.1', '127.9.8.7', '::1', '::ffff:127.0.0.1', '::ffff:127.9.8.7']) {
    assert.equal(isLoopbackAddress(address), true);
  }
  for (const address of ['172.18.0.1', '127.attacker.example', '127.0.0.1.attacker.example']) {
    assert.equal(isLoopbackAddress(address), false);
  }
});
