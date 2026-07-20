'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('bun:test');
const { createRawRequest } = require('../digest.js');

function createResponse(statusCode = 200, headers = {}) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.headers = headers;
  response.destroy = (error) => queueMicrotask(() => response.emit('error', error));
  return response;
}

function createRequestStub(run) {
  const calls = [];
  const requestImpl = (options, onResponse) => {
    const request = new EventEmitter();
    request.destroyError = null;
    request.destroy = (error) => {
      request.destroyError = error;
      queueMicrotask(() => request.emit('error', error));
    };
    request.end = () => queueMicrotask(() => run({ onResponse, options, request }));
    calls.push({ options, request });
    return request;
  };
  return { calls, requestImpl };
}

async function withWatchdog(promise, timeoutMs = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('test watchdog expired')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('enforces a wall-clock deadline when the HTTP transport stays silent', async () => {
  const stub = createRequestStub(() => {});
  const request = createRawRequest({ requestImpl: stub.requestImpl, agent: null });

  await assert.rejects(withWatchdog(request('printer.local', {
    method: 'GET', path: '/api/v1/status', timeoutMs: 10,
  })), /request timeout/);

  assert.match(stub.calls[0].request.destroyError.message, /request timeout/);
});

test('clears the wall-clock deadline after a successful HTTP response', async () => {
  const stub = createRequestStub(({ onResponse }) => {
    const response = createResponse(200, { 'content-type': 'application/json' });
    onResponse(response);
    response.emit('data', Buffer.from('{}'));
    response.emit('end');
  });
  const request = createRawRequest({ requestImpl: stub.requestImpl, agent: null });

  const result = await request('printer.local', {
    method: 'GET', path: '/api/v1/status', timeoutMs: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(result.status, 200);
  assert.equal(stub.calls[0].request.destroyError, null);
});
