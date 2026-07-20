import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-smoke-'));
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
      SOURCE_CODE_URL: 'https://code.example/layer-relay/tree/smoke',
    },
    stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
  });

  await waitForHealth(baseUrl);

  const source = await fetch(`${baseUrl}/source`, { redirect: 'manual' });
  if (source.status !== 302 || source.headers.get('location') !== 'https://code.example/layer-relay/tree/smoke') {
    throw new Error('source endpoint did not offer the configured corresponding source');
  }
  if (!source.headers.get('link')?.includes('rel="source"')) {
    throw new Error('source endpoint is missing the corresponding-source Link header');
  }

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  if (typeof state.updatedAt !== 'number' || typeof state.online !== 'boolean') {
    throw new Error('state endpoint returned an unexpected payload');
  }
  if (state.toolCount !== 1 || state.toolSlots?.length !== 1 || state.toolSlots[0].loaded !== null ||
      state.camera?.enabled !== false) {
    throw new Error('state endpoint returned unexpected tool or camera status');
  }

  const rejectedMutation = await fetch(`${baseUrl}/api/state`, { method: 'POST' });
  if (rejectedMutation.status !== 404 || rejectedMutation.headers.has('www-authenticate')) {
    throw new Error('state API unexpectedly exposed a mutation or authentication surface');
  }

  console.log(`Smoke test passed on ${process.platform}: health, source offer, state, and read-only API.`);
} catch (error) {
  console.error(`Smoke test failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await stopChild();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
