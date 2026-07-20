import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { loadRuntimeConfig } = require('../config.js');
const { readJsonWithBackup } = require('../persistence.js');
const args = process.argv.slice(2);
const requireRunning = args.includes('--require-running');
const errors = [];
const warnings = [];

function ok(message) { console.log(`[ok] ${message}`); }
function warn(message) { warnings.push(message); console.warn(`[warn] ${message}`); }
function fail(message) { errors.push(message); console.error(`[error] ${message}`); }

function isLoopbackHostname(hostname) {
  let value = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  value = value.split('%')[0];
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  return value === 'localhost' || value === '::1' ||
    (isIP(value) === 4 && value.split('.')[0] === '127');
}

function normalizeOverlayBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('overlay URL is empty');
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('overlay URL is not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`overlay URL must use http or https, not ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error('overlay URL must not contain embedded credentials');
  if (url.search || url.hash) throw new Error('overlay URL must not contain a query string or fragment');
  return url.href.replace(/\/+$/, '');
}

const bunRange = require('../package.json').engines.bun;
if (Bun.semver.satisfies(Bun.version, bunRange)) ok(`Bun ${Bun.version}`);
else fail(`Bun ${bunRange} is required; found ${Bun.version}`);

let runtime;
try {
  runtime = loadRuntimeConfig();
  ok(`configuration is valid (${runtime.source}: ${runtime.configPath})`);
  ok(`runtime state directory: ${runtime.dataDir}`);
} catch (error) {
  fail(error.message);
}

if (runtime) {
  const { config } = runtime;
  if (config.cameraRtspUrl && config.cameraStreamEnabled !== false) {
    const ffmpeg = spawnSync(config.cameraFfmpegPath || 'ffmpeg', ['-version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    if (ffmpeg.error) fail(`FFmpeg is required for the enabled camera relay: ${ffmpeg.error.message}`);
    else if (ffmpeg.status !== 0) fail(`FFmpeg exited with status ${ffmpeg.status}`);
    else ok((ffmpeg.stdout || '').split(/\r?\n/, 1)[0] || 'FFmpeg is available');
  } else {
    ok('camera relay is disabled; FFmpeg is optional');
  }

  const hasConnectUuid = typeof config.connectPrinterUuid === 'string' && config.connectPrinterUuid.trim() !== '';
  const hasConnectSeed = typeof config.connectRefreshToken === 'string' && config.connectRefreshToken.trim() !== '';
  const persistedConnect = readJsonWithBackup(path.join(runtime.dataDir, 'connect-token.json'), null);
  const hasPersistedConnectToken = typeof persistedConnect?.refresh_token === 'string' &&
    persistedConnect.refresh_token.trim() !== '';
  const hasConnectToken = hasPersistedConnectToken || hasConnectSeed;
  if (config.useConnect === false) {
    warn('Prusa Connect is explicitly disabled; the PrusaLink-only fallback lacks exact INDX active-tool telemetry');
  } else if (hasConnectUuid && hasConnectToken) {
    ok(`Prusa Connect credentials are available from the ${hasPersistedConnectToken ? 'rotated token store' : 'config seed'}`);
  } else if (hasConnectUuid || hasConnectToken) {
    warn('Prusa Connect configuration is incomplete; set both connectPrinterUuid and connectRefreshToken (see docs/prusa-connect.md)');
  } else {
    warn('Prusa Connect is not configured; the PrusaLink-only fallback lacks exact INDX active-tool telemetry (see docs/prusa-connect.md)');
  }

  const localListener = isLoopbackHostname(config.listenHost);
  if (!localListener) warn('listener is not loopback; read APIs and camera images may be reachable remotely');

  const urlIndex = args.indexOf('--url');
  const explicitUrl = urlIndex >= 0 ? args[urlIndex + 1] : '';
  if (urlIndex >= 0 && (!explicitUrl || explicitUrl.startsWith('--'))) {
    fail('--url requires an http:// or https:// base URL');
  } else {
    const listenHost = String(config.listenHost).trim().replace(/\.$/, '');
    const probeHost = listenHost === '0.0.0.0' ? '127.0.0.1'
      : listenHost === '::' ? '[::1]'
        : listenHost.includes(':') ? `[${listenHost.replace(/%/g, '%25')}]`
          : listenHost;
    let baseUrl;
    try {
      baseUrl = normalizeOverlayBaseUrl(
        explicitUrl || process.env.OVERLAY_URL || `http://${probeHost}:${config.port}`,
      );
    } catch (error) {
      fail(`overlay URL is invalid: ${error.message}`);
    }
    if (baseUrl) {
      try {
        const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
        let body;
        try { body = JSON.parse(await response.text()); }
        catch { throw new Error(`HTTP ${response.status} returned invalid health JSON`); }
        if (!response.ok || body?.ok !== true) throw new Error(`HTTP ${response.status} returned an unexpected body`);
        ok(`overlay process is healthy at ${baseUrl}`);

        const stateResponse = await fetch(`${baseUrl}/api/state`, { signal: AbortSignal.timeout(3000) });
        let state;
        try { state = JSON.parse(await stateResponse.text()); }
        catch { throw new Error(`HTTP ${stateResponse.status} returned invalid state JSON`); }
        if (stateResponse.ok && state?.online === true) {
          ok(`printer telemetry is online (stale ${Number(state.staleSec) || 0}s)`);
        } else {
          warn('overlay is running, but printer telemetry is offline or unavailable');
        }
      } catch (error) {
        const message = `overlay process is not reachable: ${error.message}`;
        if (requireRunning) fail(message); else warn(`${message} (start it, or use --require-running in deployment checks)`);
      }
    }
  }
}

console.log(`Doctor finished with ${errors.length} error(s) and ${warnings.length} warning(s).`);
if (errors.length) process.exitCode = 1;
