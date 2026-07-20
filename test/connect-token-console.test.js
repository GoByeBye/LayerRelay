'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('bun:test');

const rootDir = path.resolve(__dirname, '..');
const helperPath = path.join(rootDir, 'tools', 'copy-connect-token.js');
const guidePath = path.join(rootDir, 'docs', 'prusa-connect.md');
const helperSource = fs.readFileSync(helperPath, 'utf8').trim();
const guideSource = fs.readFileSync(guidePath, 'utf8');
const expectedOrigin = 'https://connect.prusa3d.com';
const testToken = 'TEST_ONLY_CONNECT_REFRESH_TOKEN'; // gitleaks:allow -- deterministic test fixture

function runHelper(options = {}) {
  const messages = [];
  let storageReads = 0;
  const record = (level, values) => {
    messages.push({ level, message: values.map(String).join(' ') });
  };
  const context = {
    location: { origin: options.origin ?? expectedOrigin },
    localStorage: {
      getItem(key) {
        storageReads++;
        assert.equal(key, 'auth.refresh_token');
        if (options.storageError) throw new Error('test storage failure');
        return options.token === undefined ? testToken : options.token;
      },
    },
    console: {
      info(...values) { record('info', values); },
      log(...values) { record('log', values); },
      error(...values) { record('error', values); },
    },
  };
  const evaluationResult = vm.runInNewContext(helperSource, context, { filename: helperPath });

  return {
    evaluationResult,
    messages,
    storageReads: () => storageReads,
  };
}

function assertTokenNotShown(result) {
  assert.equal(result.evaluationResult, undefined);
  assert.equal(result.messages.some(({ message }) => message.includes(testToken)), false);
}

test('documented Connect console snippet exactly matches the reviewed helper file', () => {
  const match = /<!-- BEGIN CONNECT TOKEN HELPER -->\s*```js\s*([\s\S]*?)\s*```\s*<!-- END CONNECT TOKEN HELPER -->/.exec(guideSource);
  assert.ok(match, 'guide must contain the marked JavaScript helper block');
  const documentedSource = match[1].split(/\r?\n/)
    .map((line) => line.replace(/^ {3}/, ''))
    .join('\n')
    .trim();
  assert.equal(documentedSource, helperSource);
  assert.doesNotMatch(helperSource, /\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket)\b/);
  assert.doesNotMatch(helperSource, /navigator\.clipboard|writeText|consoleCopy/);
  assert.match(helperSource, /console\.log\(token\)/);
});

test('Connect console helper prints the token once and tells the user to copy it', () => {
  const result = runHelper();

  assert.equal(result.evaluationResult, undefined);
  assert.equal(result.storageReads(), 1);
  assert.deepEqual(result.messages.map(({ level }) => level), ['info', 'log', 'info']);
  assert.match(result.messages[0].message, /Copy .* refresh token .* next line/i);
  assert.equal(result.messages[1].message, testToken);
  assert.match(result.messages[2].message, /clear this console and your clipboard/i);
  assert.equal(result.messages.filter(({ message }) => message.includes(testToken)).length, 1);
});

test('Connect console helper refuses the wrong origin before reading storage', () => {
  const result = runHelper({ origin: 'https://example.invalid' });

  assert.equal(result.storageReads(), 0);
  assert.deepEqual(result.messages.map(({ level }) => level), ['error']);
  assertTokenNotShown(result);
});

test('Connect console helper fails closed for absent or inaccessible storage', () => {
  for (const options of [{ token: null }, { storageError: true }]) {
    const result = runHelper(options);
    assert.deepEqual(result.messages.map(({ level }) => level), ['error']);
    assertTokenNotShown(result);
  }
});
