import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ignoredDirectories = new Set(['.git', '.claude', '.codex', 'cache', 'coverage', 'node_modules']);
const files = [];
const markdownFiles = [];
const yamlFiles = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.(?:c?js|mjs)$/.test(entry.name)) files.push(file);
    else if (entry.name.endsWith('.md')) markdownFiles.push(file);
    else if (/\.ya?ml$/.test(entry.name)) yamlFiles.push(file);
  }
}

visit(rootDir);
const transpiler = new Bun.Transpiler({ loader: 'js' });
for (const file of files.sort()) {
  try {
    transpiler.transformSync(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Syntax check failed for ${path.relative(rootDir, file)}:`);
    throw error;
  }
}
for (const file of yamlFiles.sort()) {
  try {
    Bun.YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`YAML check failed for ${path.relative(rootDir, file)}:`);
    throw error;
  }
}

const jsonFiles = ['config.example.json', 'config.schema.json', 'package.json'];
for (const name of jsonFiles) {
  const file = path.join(rootDir, name);
  JSON.parse(fs.readFileSync(file, 'utf8'));
}

const configExample = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.example.json'), 'utf8'));
const configSchema = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.schema.json'), 'utf8'));
const configDocs = fs.readFileSync(path.join(rootDir, 'docs', 'configuration.md'), 'utf8');
const configDocLines = configDocs.split(/\r?\n/);
function requireConfigTableRow(setting, columnCount) {
  const prefix = `| \`${setting}\` |`;
  const row = configDocLines.find((line) => line.startsWith(prefix));
  const cells = row?.split('|').slice(1, -1).map((cell) => cell.trim()) || [];
  if (cells.length !== columnCount || cells.some((cell) => cell.length === 0)) {
    throw new Error(`docs/configuration.md must give ${setting} a complete ${columnCount}-column table row`);
  }
}
const { ENV_OVERRIDES } = require(path.join(rootDir, 'config.js'));
for (const setting of ['CONFIG_PATH', 'DATA_DIR', ...Object.keys(ENV_OVERRIDES)]) {
  requireConfigTableRow(setting, 6);
}
for (const [setting, definition] of Object.entries(configSchema.properties)) {
  requireConfigTableRow(setting, 5);
  if (!definition.deprecated && !Object.hasOwn(configExample, setting)) {
    throw new Error(`config.example.json must include active config setting: ${setting}`);
  }
}
for (const [parent, properties] of [
  ['toolSlots.<n>', configSchema.properties.toolSlots.patternProperties['^(?:[1-9]|[12][0-9]|3[0-2])$'].properties],
]) {
  const example = Object.values(configExample.toolSlots)[0];
  for (const setting of Object.keys(properties)) {
    requireConfigTableRow(`${parent}.${setting}`, 4);
    // An empty toolSlots object is the recommended automatic-Connect default.
    // If an explicit example override is present, keep it complete.
    if (example && !Object.hasOwn(example, setting)) {
      throw new Error(`config.example.json must include nested config setting: ${parent}.${setting}`);
    }
  }
}

for (const required of ['bun.lock', 'bunfig.toml']) {
  if (!fs.existsSync(path.join(rootDir, required))) throw new Error(`Missing required Bun file: ${required}`);
}
if (fs.existsSync(path.join(rootDir, 'package-lock.json'))) {
  throw new Error('package-lock.json must not coexist with the Bun lockfile');
}
const bunConfig = Bun.TOML.parse(fs.readFileSync(path.join(rootDir, 'bunfig.toml'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
if (bunConfig.env !== false || bunConfig.telemetry !== false || bunConfig.install?.auto !== 'disable') {
  throw new Error('bunfig.toml must disable implicit environment loading, telemetry, and auto-install');
}
if (packageJson.packageManager !== 'bun@1.3.14' || packageJson.engines?.bun !== '>=1.3.14 <2') {
  throw new Error('package.json must pin the supported Bun runtime');
}
if (packageJson.name !== 'layer-relay' || packageJson.private !== true || packageJson.license !== 'AGPL-3.0-or-later') {
  throw new Error('package.json must identify private AGPL-3.0-or-later project layer-relay');
}
const changelog = fs.readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes('## Unreleased')) {
  throw new Error('CHANGELOG.md must retain an Unreleased section');
}
const notice = fs.readFileSync(path.join(rootDir, 'NOTICE.md'), 'utf8');
if (!notice.includes('## AI-assisted development')) {
  throw new Error('NOTICE.md must retain the AI-assisted development disclosure');
}
const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
const bannerRelative = 'docs/assets/banner.webp';
const bannerPath = path.join(rootDir, ...bannerRelative.split('/'));
if (!readme.includes('src="' + bannerRelative + '"') ||
    !readme.includes('# LayerRelay')) {
  throw new Error('README banner must remain linked from README.md');
}
const bannerSize = fs.statSync(bannerPath).size;
if (bannerSize < 1024 || bannerSize > 256 * 1024) {
  throw new Error('README banner must be a non-placeholder asset no larger than 256 KiB');
}
const artworkProvenance = fs.readFileSync(path.join(rootDir, 'docs', 'assets', 'README.md'), 'utf8');
const bannerSha256 = crypto.createHash('sha256').update(fs.readFileSync(bannerPath)).digest('hex').toUpperCase();
if (!artworkProvenance.includes(`Published SHA-256:\n  ${bannerSha256}`)) {
  throw new Error('docs/assets/README.md must record the exact README banner SHA-256');
}
const ciWorkflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'ci.yml'), 'utf8');
for (const marker of ['name: Bun source archive', 'git archive --format=tar.gz',
  'docs/assets/(banner|dashboard-preview|overlay-preview)\\.webp', 'bun run doctor']) {
  if (!ciWorkflow.includes(marker)) throw new Error(`CI source-archive gate is missing marker: ${marker}`);
}
const restartScript = fs.readFileSync(path.join(rootDir, 'tools', 'restart-overlay.ps1'), 'utf8');
for (const marker of ['bun -p process.execPath', 'function Test-OverlayApiFingerprint',
  'if (-not (Test-OverlayApiFingerprint))', 'Start-Process -FilePath $bunExecutable']) {
  if (!restartScript.includes(marker)) throw new Error(`restart helper is missing safety marker: ${marker}`);
}
if (restartScript.includes('Start-Process -FilePath $bun.Source')) throw new Error('restart helper must launch native Bun');

for (const file of markdownFiles) {
  const markdown = fs.readFileSync(file, 'utf8');
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    if (!rawTarget || rawTarget.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
    const target = decodeURIComponent(rawTarget.split('#', 1)[0]);
    const resolved = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Broken Markdown link in ${path.relative(rootDir, file)}: ${rawTarget}`);
    }
  }
}

console.log(`Checked ${files.length} JavaScript files, ${jsonFiles.length} JSON files, ${yamlFiles.length} YAML files, bunfig.toml, and ${markdownFiles.length} Markdown files.`);
