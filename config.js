'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = Object.freeze({
  listenHost: '127.0.0.1',
  port: 8787,
  sourceCodeUrl: 'https://github.com/GoByeBye/LayerRelay',
  pollIntervalMs: 2000,
  analysisCacheMaxEntries: 100,
  analysisCacheMaxBytes: 64 * 1024 * 1024,
  toolCount: 1,
  toolSlots: {},
  printNameOverrides: {},
  localBgcodeDirs: [],
  cameraRtspUrl: '',
  useConnect: true,
});

const ENV_OVERRIDES = Object.freeze({
  LISTEN_HOST: ['listenHost', 'string'],
  PORT: ['port', 'integer'],
  PRINTER_HOST: ['printerHost', 'string'],
  PRINTER_USERNAME: ['username', 'string'],
  PRINTER_PASSWORD: ['password', 'secret'],
  CAMERA_RTSP_URL: ['cameraRtspUrl', 'string'],
  CAMERA_STREAM_ENABLED: ['cameraStreamEnabled', 'boolean'],
  SOURCE_CODE_URL: ['sourceCodeUrl', 'string'],
});

const KNOWN_CONFIG_KEYS = new Set([
  '$schema',
  'printerHost', 'username', 'password', 'listenHost', 'port', 'sourceCodeUrl', 'pollIntervalMs',
  'analysisCacheMaxEntries', 'analysisCacheMaxBytes', 'printNameOverrides',
  'toolCount', 'toolSlots', 'localBgcodeDirs',
  'cameraRtspUrl', 'cameraStreamEnabled', 'cameraFfmpegPath', 'cameraStreamFps',
  'cameraStreamWidth', 'cameraStreamJpegQuality', 'cameraStreamThreads',
  'cameraStreamKillGraceMs', 'cameraStreamIdleMs', 'cameraStreamStallMs',
  'cameraStreamIoTimeoutMs', 'cameraStreamRestartBaseMs', 'cameraStreamRestartMaxMs',
  'cameraStreamMaxFrameBytes',
  'useConnect', 'connectPrinterUuid', 'connectPollMs', 'connectClientId', 'connectRefreshToken',
  'useNetatmo', 'netatmoClientId', 'netatmoClientSecret', 'netatmoRefreshToken', 'netatmoPollMs',
  'lastStateWriteMs', 'maxPrinterJsonBytes', 'maxPrinterResponseBytes',
]);

const INTEGER_RANGES = Object.freeze({
  port: [1, 65535],
  pollIntervalMs: [250, Number.MAX_SAFE_INTEGER],
  analysisCacheMaxEntries: [1, 1000],
  analysisCacheMaxBytes: [1024 * 1024, 1024 * 1024 * 1024],
  toolCount: [1, 32],
  cameraStreamFps: [1, 30],
  cameraStreamWidth: [320, 3840],
  cameraStreamJpegQuality: [2, 31],
  cameraStreamThreads: [1, 16],
  cameraStreamKillGraceMs: [500, 10000],
  cameraStreamIdleMs: [1000, 300000],
  cameraStreamStallMs: [5000, 120000],
  cameraStreamIoTimeoutMs: [3000, 120000],
  cameraStreamRestartBaseMs: [250, 30000],
  cameraStreamRestartMaxMs: [1000, 120000],
  cameraStreamMaxFrameBytes: [1024 * 1024, 64 * 1024 * 1024],
  connectPollMs: [5000, Number.MAX_SAFE_INTEGER],
  netatmoPollMs: [60000, Number.MAX_SAFE_INTEGER],
  lastStateWriteMs: [5000, Number.MAX_SAFE_INTEGER],
  maxPrinterJsonBytes: [1024, Number.MAX_SAFE_INTEGER],
  maxPrinterResponseBytes: [1024, Number.MAX_SAFE_INTEGER],
});

const OPTIONAL_STRING_KEYS = Object.freeze([
  '$schema', 'cameraRtspUrl', 'cameraFfmpegPath', 'connectPrinterUuid',
  'connectClientId', 'connectRefreshToken', 'netatmoClientId', 'netatmoClientSecret',
  'netatmoRefreshToken',
]);

const OPTIONAL_BOOLEAN_KEYS = Object.freeze(['cameraStreamEnabled', 'useConnect', 'useNetatmo']);

function firstEnvironmentValue(env, ...names) {
  for (const name of names) {
    if (typeof env[name] === 'string' && env[name].trim() !== '') return env[name];
  }
  return '';
}

function resolveRuntimePath(rootDir, value, fallback) {
  const selected = value || fallback;
  return path.isAbsolute(selected) ? path.normalize(selected) : path.resolve(rootDir, selected);
}

function parseEnvironmentValue(name, raw, type) {
  if (type === 'string') return raw.trim();
  if (type === 'secret') return raw;
  if (type === 'integer') {
    const normalized = raw.trim();
    if (!/^\d+$/.test(normalized)) throw new Error(`${name} must be an integer`);
    return Number(normalized);
  }
  if (type === 'boolean') {
    const normalized = raw.trim();
    if (/^(1|true|yes|on)$/i.test(normalized)) return true;
    if (/^(0|false|no|off)$/i.test(normalized)) return false;
    throw new Error(`${name} must be true or false`);
  }
  throw new Error(`unsupported environment type for ${name}`);
}

function applyEnvironment(config, env) {
  const next = { ...config };
  for (const [name, [key, type]] of Object.entries(ENV_OVERRIDES)) {
    const raw = firstEnvironmentValue(env, name, `LAYER_RELAY_${name}`);
    if (raw !== '') next[key] = parseEnvironmentValue(name, raw, type);
  }
  return next;
}

function readConfigFile(configPath, fsImpl = fs) {
  if (!fsImpl.existsSync(configPath)) return null;
  let contents;
  try {
    contents = fsImpl.readFileSync(configPath, 'utf8');
  } catch (error) {
    const reason = error && typeof error.code === 'string' ? ` (${error.code})` : '';
    throw new Error(`Cannot read configuration at ${configPath}${reason}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // Runtime JSON parse errors can quote nearby source text. Configuration often
    // contains passwords and tokens, so never append the parser's raw message.
    throw new Error(`Cannot parse configuration at ${configPath}: invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Configuration at ${configPath} must contain a JSON object`);
  }
  return parsed;
}

function validateConfig(config, { requirePrinter = true } = {}) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid configuration:\n- configuration must be an object');
  }

  for (const key of Object.keys(config)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) errors.push(`unknown setting: ${key}`);
  }

  const requiredString = (key, label = key) => {
    if (typeof config[key] !== 'string' || config[key].trim() === '') {
      errors.push(`${label} must be a non-empty string`);
    }
  };
  const plainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

  if (requirePrinter) {
    requiredString('printerHost');
    requiredString('username');
    requiredString('password');
  }
  requiredString('sourceCodeUrl');

  for (const key of OPTIONAL_STRING_KEYS) {
    if (config[key] != null && typeof config[key] !== 'string') {
      errors.push(`${key} must be a string`);
    }
  }
  for (const key of OPTIONAL_BOOLEAN_KEYS) {
    if (config[key] != null && typeof config[key] !== 'boolean') {
      errors.push(`${key} must be true or false`);
    }
  }
  for (const [key, [minimum, maximum]] of Object.entries(INTEGER_RANGES)) {
    if (config[key] == null) continue;
    if (!Number.isInteger(config[key]) || config[key] < minimum || config[key] > maximum) {
      errors.push(maximum === Number.MAX_SAFE_INTEGER
        ? `${key} must be an integer of at least ${minimum}`
        : `${key} must be an integer from ${minimum} to ${maximum}`);
    }
  }

  if (typeof config.printerHost === 'string' && /:\/\//.test(config.printerHost)) {
    errors.push('printerHost must be a hostname or IP address without http:// or https://');
  }
  if (typeof config.printerHost === 'string' && config.printerHost !== config.printerHost.trim()) {
    errors.push('printerHost must not have leading or trailing whitespace');
  }
  if (typeof config.printerHost === 'string' && /\s/.test(config.printerHost)) {
    errors.push('printerHost must not contain whitespace');
  }
  if (typeof config.password === 'string' && /^replace-with-/i.test(config.password.trim())) {
    errors.push('password still contains the example placeholder');
  }
  if (typeof config.cameraRtspUrl === 'string' && config.cameraRtspUrl !== config.cameraRtspUrl.trim()) {
    errors.push('cameraRtspUrl must not have leading or trailing whitespace');
  }
  if (typeof config.cameraRtspUrl === 'string' && config.cameraRtspUrl) {
    try {
      const cameraUrl = new URL(config.cameraRtspUrl);
      if (cameraUrl.protocol !== 'rtsp:' && cameraUrl.protocol !== 'rtsps:') {
        errors.push('cameraRtspUrl must use rtsp:// or rtsps://');
      }
    } catch {
      errors.push('cameraRtspUrl must be a valid RTSP URL');
    }
  }
  if (typeof config.cameraFfmpegPath === 'string' && !config.cameraFfmpegPath.trim()) {
    errors.push('cameraFfmpegPath must be a non-empty string');
  }
  if (typeof config.listenHost !== 'string' || config.listenHost.trim() === '') {
    errors.push('listenHost must be a non-empty hostname or IP address');
  } else if (config.listenHost !== config.listenHost.trim() || /[\s/?#@]/.test(config.listenHost) ||
      config.listenHost.includes('://')) {
    errors.push('listenHost must be a hostname or IP address without whitespace, a URL scheme, or a path');
  }
  if (typeof config.sourceCodeUrl === 'string' && config.sourceCodeUrl.trim() !== '') {
    if (config.sourceCodeUrl !== config.sourceCodeUrl.trim() || /[\u0000-\u001f\u007f]/.test(config.sourceCodeUrl)) {
      errors.push('sourceCodeUrl must not contain surrounding whitespace or control characters');
    } else {
      try {
        const sourceUrl = new URL(config.sourceCodeUrl);
        if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
          errors.push('sourceCodeUrl must use http:// or https://');
        }
        if (sourceUrl.username || sourceUrl.password) {
          errors.push('sourceCodeUrl must not contain credentials');
        }
      } catch {
        errors.push('sourceCodeUrl must be a valid absolute URL');
      }
    }
  }
  if (config.localBgcodeDirs != null) {
    if (!Array.isArray(config.localBgcodeDirs)) {
      errors.push('localBgcodeDirs must be an array');
    } else if (config.localBgcodeDirs.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      errors.push('localBgcodeDirs entries must be non-empty strings');
    }
  }
  if (config.toolSlots != null) {
    if (!plainObject(config.toolSlots)) {
      errors.push('toolSlots must be an object keyed by 1-based tool number');
    } else {
      for (const [slot, value] of Object.entries(config.toolSlots)) {
        if (!/^[1-9][0-9]*$/.test(slot) || !plainObject(value)) {
          errors.push('toolSlots entries must use 1-based numeric keys and object values');
          continue;
        }
        for (const key of Object.keys(value)) {
          if (!['loaded', 'name', 'color'].includes(key)) errors.push(`unknown toolSlots.${slot} setting: ${key}`);
        }
        if (value.loaded != null && typeof value.loaded !== 'boolean') errors.push(`toolSlots.${slot}.loaded must be true or false`);
        if (value.name != null && (typeof value.name !== 'string' || value.name.length > 80)) {
          errors.push(`toolSlots.${slot}.name must be a string of at most 80 characters`);
        }
        if (value.color != null && (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color))) {
          errors.push(`toolSlots.${slot}.color must be a six-digit hex colour`);
        }
      }
    }
  }
  if (config.printNameOverrides != null) {
    if (!plainObject(config.printNameOverrides)) {
      errors.push('printNameOverrides must be an object');
    } else if (Object.values(config.printNameOverrides).some((value) => typeof value !== 'string' || value.length > 200)) {
      errors.push('printNameOverrides values must be strings of at most 200 characters');
    }
  }
  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  return config;
}

function loadRuntimeConfig(options = {}) {
  const rootDir = path.resolve(options.rootDir || __dirname);
  const env = options.env || process.env;
  const fsImpl = options.fs || fs;
  const configPath = resolveRuntimePath(
    rootDir,
    firstEnvironmentValue(env, 'CONFIG_PATH', 'LAYER_RELAY_CONFIG').trim(),
    'config.json',
  );
  const dataDir = resolveRuntimePath(
    rootDir,
    firstEnvironmentValue(env, 'DATA_DIR', 'LAYER_RELAY_DATA_DIR').trim(),
    'cache',
  );
  const fileConfig = readConfigFile(configPath, fsImpl);
  if (!fileConfig && !firstEnvironmentValue(
    env,
    'PRINTER_HOST',
    'LAYER_RELAY_PRINTER_HOST',
  )) {
    throw new Error(
      `No configuration found at ${configPath}. Run bun run setup, copy config.example.json, ` +
      'or provide PRINTER_HOST, PRINTER_USERNAME, and PRINTER_PASSWORD.',
    );
  }
  const mergedConfig = { ...DEFAULT_CONFIG, ...(fileConfig || {}) };
  const config = validateConfig(
    applyEnvironment(mergedConfig, env),
    { requirePrinter: options.requirePrinter !== false },
  );

  return Object.freeze({
    config: Object.freeze(config),
    configPath,
    dataDir,
    source: fileConfig ? 'file' : 'environment',
  });
}

module.exports = {
  DEFAULT_CONFIG,
  ENV_OVERRIDES,
  applyEnvironment,
  loadRuntimeConfig,
  readConfigFile,
  resolveRuntimePath,
  validateConfig,
};
