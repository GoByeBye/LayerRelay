'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { onTestFinished, test } = require('bun:test');

const rootDir = path.resolve(__dirname, '..');
const setupScript = path.join(rootDir, 'scripts', 'setup.mjs');

test('setup refuses a credential path inside the repository unless it is config.json', () => {
  const unsafePath = path.join(rootDir, 'config.public-test.json');
  try { fs.rmSync(unsafePath, { force: true }); } catch {}
  const result = spawnSync(process.execPath, [setupScript, '--non-interactive', '--config', unsafePath], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Refusing to create credentials/);
  assert.equal(fs.existsSync(unsafePath), false);
});

test('setup honors LIVESTREAM_CONFIG for an external private path', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '3d-livestream-setup-'));
  const configPath = path.join(directory, 'private.json');
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [setupScript, '--non-interactive'], {
    cwd: rootDir,
    env: { ...process.env, CONFIG_PATH: '', LIVESTREAM_CONFIG: configPath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.match(config.apiToken, /^[0-9a-f]{64}$/);
  assert.match(config.$schema, /^file:\/\//);
  assert.equal(fs.existsSync(new URL(config.$schema)), true);
  assert.match(result.stdout, /custom path is outside the repository/);
});
