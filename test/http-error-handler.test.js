'use strict';

const assert = require('node:assert/strict');
const { test } = require('bun:test');
const { createHttpErrorHandler } = require('../http-error-handler.js');

function handle(error) {
  const result = { status: null, body: null, nextError: null, logs: [] };
  const response = {
    headersSent: false,
    status(status) {
      result.status = status;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };
  const handler = createHttpErrorHandler({
    error(message) { result.logs.push(message); },
  });
  handler(error, {}, response, (nextError) => { result.nextError = nextError; });
  return result;
}

test('keeps explicit oversized and malformed JSON responses', () => {
  const tooLarge = new Error('TOP_SECRET oversized body');
  tooLarge.type = 'entity.too.large';
  tooLarge.status = 413;
  assert.deepEqual(handle(tooLarge), {
    status: 413,
    body: { error: 'request body too large' },
    nextError: null,
    logs: [],
  });

  const malformed = new SyntaxError('TOP_SECRET malformed JSON');
  malformed.body = '{"secret":';
  malformed.status = 400;
  assert.deepEqual(handle(malformed), {
    status: 400,
    body: { error: 'invalid JSON body' },
    nextError: null,
    logs: [],
  });
});

test('preserves safe body-parser 4xx statuses without exposing parser messages', () => {
  for (const [status, type, expectedMessage] of [
    [415, 'charset.unsupported', 'unsupported request body'],
    [415, 'encoding.unsupported', 'unsupported request body'],
    [400, 'request.size.invalid', 'invalid request body'],
    [403, 'entity.verify.failed', 'request body rejected'],
  ]) {
    const error = new Error(`TOP_SECRET ${type}`);
    error.status = status;
    error.statusCode = status;
    error.type = type;
    const result = handle(error);
    assert.equal(result.status, status);
    assert.deepEqual(result.body, { error: expectedMessage });
    assert.doesNotMatch(JSON.stringify(result.body), /TOP_SECRET/);
    assert.deepEqual(result.logs, []);
  }

  const malformedCompression = new Error('TOP_SECRET malformed compressed body');
  malformedCompression.status = 400;
  malformedCompression.statusCode = 400;
  const compressedResult = handle(malformedCompression);
  assert.equal(compressedResult.status, 400);
  assert.deepEqual(compressedResult.body, { error: 'invalid request body' });
  assert.doesNotMatch(JSON.stringify(compressedResult.body), /TOP_SECRET/);
});

test('keeps non-client failures generic and logged server-side', () => {
  const error = new Error('database unavailable');
  error.status = 500;
  const result = handle(error);
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: 'internal server error' });
  assert.deepEqual(result.logs, ['[http] database unavailable']);
});
