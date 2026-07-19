import { createRequire } from 'node:module';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { normalizeOverlayBaseUrl } from '../tools/_overlay-client.mjs';

const require = createRequire(import.meta.url);
const { loadRuntimeConfig } = require('../config.js');
const { isLoopbackHostname } = require('../access-control.js');
const args = process.argv.slice(2);
const requireRunning = args.includes('--require-running');
const errors = [];
const warnings = [];

function ok(message) { console.log(`[ok] ${message}`); }
function warn(message) { warnings.push(message); console.warn(`[warn] ${message}`); }
function fail(message) { errors.push(message); console.error(`[error] ${message}`); }

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

  const localListener = isLoopbackHostname(config.listenHost);
  if (!localListener) warn('listener is not loopback; read APIs and camera images may be reachable remotely');
  if (config.apiToken) ok('write API token is configured');
  else if (localListener) warn('write API has local-only tokenless access; configure apiToken for Docker or reverse proxies');
  else fail('apiToken is required before using a non-loopback deployment');

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
