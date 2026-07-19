import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '3d-livestream-smoke-'));
let child;

async function freePort() {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  return port;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      if (response.ok && body?.ok === true) {
        if (response.headers.get('x-content-type-options') !== 'nosniff') {
          throw new Error('health endpoint is missing security headers');
        }
        return;
      }
      lastError = new Error(`health endpoint returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`server did not become healthy: ${lastError?.message || 'timeout'}`);
}

async function stopChild() {
  if (!child || child.exitCode != null) return;
  child.kill();
  const timedOut = await Promise.race([child.exited.then(() => false), Bun.sleep(6000).then(() => true)]);
  if (timedOut && child.exitCode == null) {
    child.kill(9);
    await child.exited;
  }
}

try {
  const port = await freePort();
  const token = 'smoke-test-token-0123456789abcdef';
  const baseUrl = `http://127.0.0.1:${port}`;
  child = Bun.spawn([process.execPath, 'server.js'], {
    cwd: rootDir,
    windowsHide: true,
    env: {
      ...process.env,
      CONFIG_PATH: path.join(tempDir, 'missing-config.json'),
      DATA_DIR: path.join(tempDir, 'data'),
      LISTEN_HOST: '127.0.0.1',
      PORT: String(port),
      PRINTER_HOST: '127.0.0.1',
      PRINTER_USERNAME: 'smoke',
      PRINTER_PASSWORD: 'smoke',
      CAMERA_STREAM_ENABLED: 'false',
      OVERLAY_API_TOKEN: token,
      SOURCE_CODE_URL: 'https://code.example/3d-livestream/tree/smoke',
    },
    stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
  });

  await waitForHealth(baseUrl);

  const source = await fetch(`${baseUrl}/source`, { redirect: 'manual' });
  if (source.status !== 302 || source.headers.get('location') !== 'https://code.example/3d-livestream/tree/smoke') {
    throw new Error('source endpoint did not offer the configured corresponding source');
  }
  if (!source.headers.get('link')?.includes('rel="source"')) {
    throw new Error('source endpoint is missing the corresponding-source Link header');
  }

  const denied = await fetch(`${baseUrl}/api/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'smoke test' }),
  });
  if (denied.status !== 401) throw new Error(`unauthenticated write returned HTTP ${denied.status}, expected 401`);

  const accepted = await fetch(`${baseUrl}/api/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'smoke test' }),
  });
  if (!accepted.ok) throw new Error(`authenticated write returned HTTP ${accepted.status}`);

  const message = await (await fetch(`${baseUrl}/api/message`)).json();
  if (message?.text !== 'smoke test') throw new Error('authenticated write was not observable');

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  if (typeof state.updatedAt !== 'number' || typeof state.online !== 'boolean') {
    throw new Error('state endpoint returned an unexpected payload');
  }
  if (state.toolCount !== 1 || state.toolSlots?.length !== 1 || state.toolSlots[0].loaded !== null ||
      state.camera?.enabled !== false) {
    throw new Error('state endpoint returned unexpected tool or camera status');
  }

  console.log(`Smoke test passed on ${process.platform}: health, source offer, state, and write authentication.`);
} catch (error) {
  console.error(`Smoke test failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await stopChild();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
