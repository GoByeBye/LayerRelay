'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { onTestFinished, test } = require('bun:test');
const { createHttpsRequest } = require('../https-request.js');

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
    const chunks = [];
    request.write = (chunk) => chunks.push(Buffer.from(chunk));
    request.destroyError = null;
    request.destroy = (error) => {
      request.destroyError = error;
      queueMicrotask(() => request.emit('error', error));
    };
    request.end = () => queueMicrotask(() => run({
      body: Buffer.concat(chunks).toString('utf8'),
      onResponse,
      options,
      request,
    }));
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

test('sends a bounded request and returns a UTF-8 response', async () => {
  const stub = createRequestStub(({ body, onResponse }) => {
    assert.equal(body, 'grant_type=refresh_token');
    const response = createResponse(201, { 'content-type': 'application/json' });
    onResponse(response);
    response.emit('data', Buffer.from('{"ok":'));
    response.emit('data', Buffer.from('true}'));
    response.emit('end');
  });
  const agent = { name: 'test-agent' };
  const request = createHttpsRequest({ requestImpl: stub.requestImpl, agent, maxResponseBytes: 64 });

  const result = await request('api.example', {
    method: 'POST',
    path: '/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, 'grant_type=refresh_token', 4321);

  assert.deepEqual(result, {
    status: 201,
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
  });
  assert.deepEqual(stub.calls[0].options, {
    host: 'api.example',
    method: 'POST',
    path: '/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 4321,
    agent,
  });
});

test('rejects oversized responses without settling twice', async () => {
  const stub = createRequestStub(({ onResponse }) => {
    const response = createResponse();
    onResponse(response);
    response.emit('data', Buffer.from('12345'));
    response.emit('end');
  });
  const request = createHttpsRequest({ requestImpl: stub.requestImpl, agent: null, maxResponseBytes: 4 });

  await assert.rejects(request('api.example', { method: 'GET', path: '/' }), /response exceeds 4 bytes/);
});

test('returns binary data and honors a per-call response limit', async () => {
  const stub = createRequestStub(({ onResponse }) => {
    const response = createResponse(200, { 'content-type': 'image/png' });
    onResponse(response);
    response.emit('data', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    response.emit('end');
  });
  const request = createHttpsRequest({ requestImpl: stub.requestImpl, agent: null, maxResponseBytes: 2 });

  const result = await request('api.example', { method: 'GET', path: '/preview' }, null, 12000, {
    asBuffer: true,
    maxResponseBytes: 4,
  });

  assert.deepEqual(result.body, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

test('rejects an oversized declared content length before buffering the response', async () => {
  const stub = createRequestStub(({ onResponse }) => {
    const response = createResponse(200, { 'content-length': '5' });
    onResponse(response);
  });
  const request = createHttpsRequest({ requestImpl: stub.requestImpl, agent: null });

  await assert.rejects(request('api.example', { method: 'GET', path: '/' }, null, 12000, {
    maxResponseBytes: 4,
  }), /response exceeds 4 bytes/);
});

test('forwards an AbortSignal to the request transport', async () => {
  const stub = createRequestStub(({ onResponse }) => {
    const response = createResponse();
    onResponse(response);
    response.emit('end');
  });
  const request = createHttpsRequest({ requestImpl: stub.requestImpl, agent: null });
  const controller = new AbortController();

  await request('api.example', { method: 'GET', path: '/', signal: controller.signal });

  assert.equal(stub.calls[0].options.signal, controller.signal);
});

test('rejects aborted responses without settling twice', async () => {
  const stub = createRequestStub(({ onResponse }) => {
    const response = createResponse();
    onResponse(response);
    response.emit('aborted');
    response.emit('error', new Error('late response error'));
    response.emit('end');
  });
  const request = createHttpsRequest({ requestImpl: stub.requestImpl, agent: null });

  await assert.rejects(request('api.example', { method: 'GET', path: '/' }), /response aborted/);
});

test('turns request timeouts into a stable error', async () => {
  const stub = createRequestStub(({ request }) => request.emit('timeout'));
  const request = createHttpsRequest({ requestImpl: stub.requestImpl, agent: null });

  await assert.rejects(request('api.example', { method: 'GET', path: '/' }), /request timeout/);
});

test('enforces a wall-clock deadline when the HTTPS transport stays silent', async () => {
  const stub = createRequestStub(() => {});
  const request = createHttpsRequest({ requestImpl: stub.requestImpl, agent: null });

  await assert.rejects(withWatchdog(request('api.example', {
    method: 'GET', path: '/',
  }, null, 10)), /request timeout/);

  assert.match(stub.calls[0].request.destroyError.message, /request timeout/);
});

test('forwards request transport errors', async () => {
  const stub = createRequestStub(({ request }) => request.emit('error', new Error('socket failed')));
  const request = createHttpsRequest({ requestImpl: stub.requestImpl, agent: null });

  await assert.rejects(request('api.example', { method: 'GET', path: '/' }), /socket failed/);
});

test('forwards response transport errors', async () => {
  const stub = createRequestStub(({ onResponse }) => {
    const response = createResponse();
    onResponse(response);
    response.emit('error', new Error('TLS response failed'));
    response.emit('end');
  });
  const request = createHttpsRequest({ requestImpl: stub.requestImpl, agent: null });

  await assert.rejects(request('api.example', { method: 'GET', path: '/' }), /TLS response failed/);
});

test('creates a provider-local keep-alive agent by default', async () => {
  const stub = createRequestStub(({ onResponse }) => {
    const response = createResponse();
    onResponse(response);
    response.emit('end');
  });
  const request = createHttpsRequest({ requestImpl: stub.requestImpl });

  await request('api.example', { method: 'GET', path: '/' });

  const { agent } = stub.calls[0].options;
  onTestFinished(() => agent.destroy());
  assert.equal(agent instanceof https.Agent, true);
  assert.equal(agent.keepAlive, true);
  assert.equal(agent.maxSockets, 2);
});
