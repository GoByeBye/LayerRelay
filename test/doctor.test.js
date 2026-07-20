'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { onTestFinished, test } = require('bun:test');

const rootDir = path.resolve(__dirname, '..');
const doctorScript = path.join(rootDir, 'scripts', 'doctor.mjs');

function doctorEnvironment(directory, overrides = {}) {
  return {
    ...process.env,
    CONFIG_PATH: path.join(directory, 'missing-config.json'),
    DATA_DIR: directory,
    PRINTER_HOST: '127.0.0.1',
    PRINTER_USERNAME: 'ci',
    PRINTER_PASSWORD: 'ci-password',
    CAMERA_STREAM_ENABLED: 'false',
    ...overrides,
  };
}

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-doctor-'));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('doctor rejects credential-bearing probe URLs without echoing their contents', () => {
  const directory = temporaryDirectory();
  const result = spawnSync(process.execPath, [
    doctorScript,
    '--url',
    'http://operator:TOP_SECRET_PASSWORD@localhost:8787',
  ], {
    cwd: rootDir,
    env: doctorEnvironment(directory),
    encoding: 'utf8',
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /must not contain embedded credentials/);
  assert.doesNotMatch(output, /TOP_SECRET_PASSWORD/);
});

test('doctor recognizes the effective persisted Connect token without printing it', () => {
  const directory = temporaryDirectory();
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ connectPrinterUuid: 'test-printer-uuid' }));
  fs.writeFileSync(path.join(directory, 'connect-token.json'), JSON.stringify({
    refresh_token: 'PERSISTED_TEST_CONNECT_TOKEN', // gitleaks:allow -- deterministic test fixture
  }));

  const result = spawnSync(process.execPath, [doctorScript], {
    cwd: rootDir,
    env: doctorEnvironment(directory, { CONFIG_PATH: configPath, PORT: '1' }),
    encoding: 'utf8',
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /credentials are available from the rotated token store/);
  assert.doesNotMatch(output, /PERSISTED_TEST_CONNECT_TOKEN/);
  assert.doesNotMatch(result.stderr, /Prusa Connect configuration is incomplete/);
});

test('doctor warns when read APIs and camera images bind beyond loopback', () => {
  const directory = temporaryDirectory();
  const result = spawnSync(process.execPath, [doctorScript], {
    cwd: rootDir,
    env: doctorEnvironment(directory, { LISTEN_HOST: '0.0.0.0', PORT: '1' }),
    encoding: 'utf8',
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stderr, /listener is not loopback; read APIs and camera images may be reachable remotely/);
});

test('doctor probes an IPv6 loopback listener when configured', async () => {
  const directory = temporaryDirectory();
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/healthz') res.end('{"ok":true}');
    else if (req.url === '/api/state') res.end('{"online":false,"staleSec":0}');
    else { res.statusCode = 404; res.end('{"error":"not found"}'); }
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', resolve);
    });
  } catch (error) {
    if (error?.code === 'EAFNOSUPPORT' || error?.code === 'EADDRNOTAVAIL') {
      return;
    }
    throw error;
  }
  onTestFinished(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const child = spawn(process.execPath, [doctorScript, '--require-running'], {
    cwd: rootDir,
    env: doctorEnvironment(directory, { LISTEN_HOST: '::1', PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  assert.equal(status, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, new RegExp(`healthy at http://\\[::1\\]:${port}`));
  assert.match(stderr, /Prusa Connect is not configured/);
});
