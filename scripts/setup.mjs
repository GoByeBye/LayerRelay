import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

function failSetup(error) {
  console.error(`Setup failed: ${error?.message || error}`);
  process.exit(1);
}
process.once('uncaughtException', failSetup);
process.once('unhandledRejection', failSetup);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const bunRange = require('../package.json').engines.bun;
if (!Bun.semver.satisfies(Bun.version, bunRange)) throw new Error(`Bun ${bunRange} is required; found ${Bun.version}`);
const args = process.argv.slice(2);

function argumentValue(name) {
  const index = args.indexOf(name);
  if (index < 0) return '';
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

const requestedPath = [argumentValue('--config'), process.env.CONFIG_PATH, process.env.LIVESTREAM_CONFIG]
  .find((value) => typeof value === 'string' && value.trim())?.trim() || 'config.json';
const configPath = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(rootDir, requestedPath);
const defaultConfigPath = path.join(rootDir, 'config.json');
const examplePath = path.join(rootDir, 'config.example.json');
const nonInteractive = args.includes('--non-interactive') || !process.stdin.isTTY || !process.stdout.isTTY;

const relativeConfigPath = path.relative(rootDir, configPath);
const configIsInsideRepository = relativeConfigPath === '' || (
  relativeConfigPath !== '..' &&
  !relativeConfigPath.startsWith(`..${path.sep}`) &&
  !path.isAbsolute(relativeConfigPath)
);
if (configIsInsideRepository && configPath !== defaultConfigPath) {
  throw new Error(
    'Refusing to create credentials at a custom path inside the repository. ' +
    'Use the ignored config.json path or an absolute path outside the checkout.',
  );
}

if (fs.existsSync(configPath)) {
  console.log(`Configuration already exists: ${configPath}`);
  console.log('It was left unchanged. Run bun run doctor to validate it.');
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
if (configPath !== defaultConfigPath) {
  // A relative schema reference would resolve beside the external credentials
  // file instead of beside this checkout. Keep editor completion working.
  config.$schema = pathToFileURL(path.join(rootDir, 'config.schema.json')).href;
}
config.apiToken = crypto.randomBytes(32).toString('hex');

if (!nonInteractive) {
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!output.muted) process.stdout.write(chunk);
      callback();
    },
  });
  output.muted = false;
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });

  try {
    const host = (await rl.question(`Printer hostname or IP [${config.printerHost}]: `)).trim();
    if (host) config.printerHost = host;

    const username = (await rl.question(`PrusaLink username [${config.username}]: `)).trim();
    if (username) config.username = username;

    process.stdout.write('PrusaLink password (input is hidden): ');
    output.muted = true;
    config.password = await rl.question('');
    output.muted = false;
    process.stdout.write('\n');
    if (!config.password) throw new Error('PrusaLink password cannot be empty');

    const cameraUrl = (await rl.question('Camera RTSP URL (optional): ')).trim();
    config.cameraRtspUrl = cameraUrl;
    config.cameraStreamEnabled = cameraUrl !== '';

    const toolCountRaw = (await rl.question(`Number of tool slots [${config.toolCount}]: `)).trim();
    if (toolCountRaw) {
      const toolCount = Number(toolCountRaw);
      if (!Number.isInteger(toolCount) || toolCount < 1 || toolCount > 32) {
        throw new Error('Tool count must be an integer from 1 to 32');
      }
      config.toolCount = toolCount;
    }
  } finally {
    output.muted = false;
    rl.close();
  }
  require('../config.js').validateConfig(config);
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
if (process.platform !== 'win32') {
  try { fs.chmodSync(configPath, 0o600); } catch { /* Best effort on unusual filesystems. */ }
}

console.log(`Created private configuration: ${configPath}`);
if (configPath === defaultConfigPath) {
  console.log('This default path is ignored by Git and excluded from Docker builds.');
} else {
  console.log('This custom path is outside the repository; keep its permissions and backups private.');
}
if (nonInteractive) {
  console.log('Edit the printer host, username, password, and optional camera settings before starting.');
}
console.log('A random API token was generated and stored only in the configuration file above.');
console.log('Next: bun run doctor, then bun run start (or docker compose up -d --build).');
