import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-smoke-'));
let child;
let childOptions;

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

function startChild() {
  child = Bun.spawn([process.execPath, 'server.js'], childOptions);
}

try {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const configPath = path.join(tempDir, 'config.json');
  const dataDir = path.join(tempDir, 'data');
  fs.writeFileSync(configPath, JSON.stringify({
    printerHost: '127.0.0.1',
    username: 'smoke',
    password: 'smoke',
    sourceCodeUrl: 'https://code.example/layer-relay/tree/smoke',
    toolSettingsAllowedOrigins: [`http://relay.example:${port}`],
  }));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'connect-tool-inventory.json'), JSON.stringify({
    version: 2,
    printerUuid: null,
    toolCount: 3,
    toolSlots: [
      { toolIndex: 0, toolLabel: 1, loaded: true, name: null, material: 'PLA', color: null },
      { toolIndex: 1, toolLabel: 2, loaded: false, name: null, material: null, color: null },
      { toolIndex: 2, toolLabel: 3, loaded: null, name: null, material: null, color: null },
    ],
  }));
  childOptions = {
    cwd: rootDir,
    windowsHide: true,
    env: {
      ...process.env,
      CONFIG_PATH: configPath,
      DATA_DIR: dataDir,
      LISTEN_HOST: '127.0.0.1',
      PORT: String(port),
      PRINTER_HOST: '127.0.0.1',
      PRINTER_USERNAME: 'smoke',
      PRINTER_PASSWORD: 'smoke',
      CAMERA_STREAM_ENABLED: 'false',
      SOURCE_CODE_URL: 'https://code.example/layer-relay/tree/smoke',
    },
    stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
  };
  startChild();

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
  if (state.toolCount !== 1 || state.toolCountSource !== 'fallback' || state.toolSlots?.length !== 1 ||
      state.toolSlots[0].loaded !== null || state.toolSlots[0].material !== null ||
      state.toolSettings?.toolCount !== null || state.toolSettings?.detected?.status !== 'unavailable' ||
      state.camera?.enabled !== false) {
    throw new Error('state endpoint returned unexpected tool or camera status');
  }

  const initialToolsResponse = await fetch(`${baseUrl}/api/settings/tools`);
  const initialToolsText = await initialToolsResponse.text();
  const initialTools = JSON.parse(initialToolsText);
  if (!initialToolsResponse.ok || initialTools.toolCount !== null || initialTools.effective?.toolCount !== 1 ||
      initialTools.effective?.toolCountSource !== 'fallback' || initialTools.detected?.status !== 'unavailable' ||
      /password|refreshToken|cameraRtspUrl|configPath/i.test(initialToolsText)) {
    throw new Error('tool settings endpoint exposed an unexpected payload');
  }

  const crossOriginWrite = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ toolCount: 2, toolSlots: {} }),
  });
  if (crossOriginWrite.status !== 403) throw new Error('cross-origin tool settings write was not rejected');

  const reboundWrite = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Host: `evil.example:${port}`,
      Origin: `http://evil.example:${port}`,
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({ toolCount: 2, toolSlots: {} }),
  });
  if (reboundWrite.status !== 403) throw new Error('DNS-rebound loopback settings write was not rejected');

  const allowedProxyWrite = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Host: `relay.example:${port}`,
      Origin: `http://relay.example:${port}`,
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({ toolCount: 1, toolSlots: {} }),
  });
  if (!allowedProxyWrite.ok) throw new Error('explicitly allowed proxy origin could not save tool settings');

  const wrongContentType = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain', Origin: baseUrl },
    body: '{}',
  });
  if (wrongContentType.status !== 415) throw new Error('non-JSON tool settings write was not rejected');

  const savedToolsResponse = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      toolCount: 2,
      toolSlots: { 2: { loaded: true, name: 'Prusament PETG Galaxy Black', color: '#112233' } },
    }),
  });
  const savedTools = await savedToolsResponse.json();
  if (!savedToolsResponse.ok || savedTools.toolCount !== 2 || savedTools.toolSlots?.['2']?.color !== '#112233') {
    throw new Error('valid tool settings were not saved');
  }

  const updatedState = await (await fetch(`${baseUrl}/api/state`)).json();
  if (updatedState.toolCount !== 2 || updatedState.toolSlots?.length !== 2 ||
      updatedState.toolSlots[1]?.name !== 'Prusament PETG Galaxy Black') {
    throw new Error('saved tool settings did not hot-update state');
  }
  if (!fs.existsSync(path.join(tempDir, 'data', 'tool-settings.json'))) {
    throw new Error('tool settings were not persisted under DATA_DIR');
  }

  await stopChild();
  startChild();
  await waitForHealth(baseUrl);
  const restartedTools = await (await fetch(`${baseUrl}/api/settings/tools`)).json();
  const restartedState = await (await fetch(`${baseUrl}/api/state`)).json();
  if (restartedTools.toolCount !== 2 || restartedTools.toolSlots?.['2']?.name !== 'Prusament PETG Galaxy Black' ||
      restartedState.toolCount !== 2 || restartedState.toolSlots?.[1]?.color !== '#112233') {
    throw new Error('tool settings did not survive a server restart');
  }

  const autoResponse = await fetch(`${baseUrl}/api/settings/tools`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ toolCount: null, toolSlots: { 2: { name: 'Reserve spool' } } }),
  });
  const autoTools = await autoResponse.json();
  if (!autoResponse.ok || autoTools.toolCount !== null || autoTools.effective?.toolCount !== 2 ||
      autoTools.effective?.toolCountSource !== 'fallback' ||
      autoTools.effective?.toolSlots?.[1]?.loaded !== null ||
      autoTools.effective?.toolSlots?.[1]?.name !== 'Reserve spool') {
    throw new Error('automatic count and independent slot overrides did not resolve correctly');
  }

  await stopChild();
  startChild();
  await waitForHealth(baseUrl);
  const restartedAutoTools = await (await fetch(`${baseUrl}/api/settings/tools`)).json();
  if (restartedAutoTools.toolCount !== null || restartedAutoTools.effective?.toolCount !== 2 ||
      restartedAutoTools.toolSlots?.['2']?.name !== 'Reserve spool') {
    throw new Error('automatic settings did not survive a server restart');
  }

  const rejectedMutation = await fetch(`${baseUrl}/api/state`, { method: 'POST' });
  if (rejectedMutation.status !== 404 || rejectedMutation.headers.has('www-authenticate')) {
    throw new Error('state API unexpectedly exposed a mutation or authentication surface');
  }

  console.log(`Smoke test passed on ${process.platform}: health, source offer, state, scoped writes, and restart persistence.`);
} catch (error) {
  console.error(`Smoke test failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await stopChild();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
