'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(TOOLS_DIR, '..', 'config.json');
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readOverlayConfig(configPath, readFile = fs.readFileSync) {
  let contents;
  try { contents = readFile(configPath, 'utf8'); }
  catch (error) {
    const reason = error && typeof error.code === 'string' ? ` (${error.code})` : '';
    throw new Error(`Cannot read overlay configuration at "${configPath}"${reason}`);
  }
  try { return JSON.parse(contents); }
  catch {
    // JSON.parse may echo source text on modern Node releases. Never expose a
    // nearby printer password or API token in an operator-tool error.
    throw new Error(`Cannot parse overlay configuration at "${configPath}": invalid JSON`);
  }
}

function normalizeOverlayBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('overlay URL is empty');
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('OVERLAY_URL is not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`overlay URL must use http or https, not ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error('overlay URL must not contain embedded credentials');
  if (url.search || url.hash) throw new Error('overlay URL must not contain a query string or fragment');
  return url.href.replace(/\/+$/, '');
}

function resolveOverlayBaseUrl(options = {}) {
  const env = options.env || process.env;
  const configured = typeof env.OVERLAY_URL === 'string' ? env.OVERLAY_URL.trim() : '';
  if (configured) return normalizeOverlayBaseUrl(configured);

  const configuredPath = typeof env.CONFIG_PATH === 'string' ? env.CONFIG_PATH.trim() : '';
  const configPath = options.configPath || (configuredPath
    ? (path.isAbsolute(configuredPath) ? configuredPath : path.resolve(TOOLS_DIR, '..', configuredPath))
    : DEFAULT_CONFIG_PATH);
  const readFile = options.readFileSync || fs.readFileSync;
  let cfg;
  try { cfg = readOverlayConfig(configPath, readFile); }
  catch (error) { throw new Error(`${error.message}. Set OVERLAY_URL to the running overlay base URL.`); }
  const port = Number(cfg.port || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid overlay port in "${configPath}"`);
  }
  return `http://127.0.0.1:${port}`;
}

function resolveOverlayApiToken(options = {}) {
  const env = options.env || process.env;
  const environmentToken = typeof env.OVERLAY_API_TOKEN === 'string' ? env.OVERLAY_API_TOKEN.trim() : '';
  if (environmentToken) return environmentToken;
  // An explicit destination must have an explicit token. Never forward a token from the
  // local config file to an arbitrary URL supplied through the environment.
  if (typeof env.OVERLAY_URL === 'string' && env.OVERLAY_URL.trim()) return '';

  const configuredPath = typeof env.CONFIG_PATH === 'string' ? env.CONFIG_PATH.trim() : '';
  const configPath = options.configPath || (configuredPath
    ? (path.isAbsolute(configuredPath) ? configuredPath : path.resolve(TOOLS_DIR, '..', configuredPath))
    : DEFAULT_CONFIG_PATH);
  try {
    const cfg = readOverlayConfig(configPath, options.readFileSync || fs.readFileSync);
    return typeof cfg.apiToken === 'string' ? cfg.apiToken.trim() : '';
  } catch {
    return '';
  }
}

function overlayApiUrl(baseUrl, apiPath) {
  if (typeof apiPath !== 'string' || !apiPath.startsWith('/api/')) {
    throw new Error(`overlay API path must start with /api/: ${apiPath}`);
  }
  return `${normalizeOverlayBaseUrl(baseUrl)}${apiPath}`;
}

function overlayRequestHeaders(method, headers = {}, env = process.env, options = {}) {
  const result = { ...headers };
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const token = resolveOverlayApiToken({ ...options, env });
  if (token && /[\r\n]/.test(token)) throw new Error('OVERLAY_API_TOKEN contains a newline');
  const hasAuthorization = Object.keys(result).some((name) => name.toLowerCase() === 'authorization');
  if (token && WRITE_METHODS.has(normalizedMethod) && !hasAuthorization) {
    result.Authorization = `Bearer ${token}`;
  }
  return result;
}

export {
  normalizeOverlayBaseUrl,
  overlayApiUrl,
  overlayRequestHeaders,
  readOverlayConfig,
  resolveOverlayApiToken,
  resolveOverlayBaseUrl,
};
