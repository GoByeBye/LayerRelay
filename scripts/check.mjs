import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', '.claude', '.codex', 'cache', 'coverage', 'node_modules']);
const files = [];
const markdownFiles = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.(?:c?js|mjs)$/.test(entry.name)) files.push(file);
    else if (entry.name.endsWith('.md')) markdownFiles.push(file);
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

const jsonFiles = ['config.example.json', 'config.schema.json', 'package.json'];
for (const name of jsonFiles) {
  const file = path.join(rootDir, name);
  JSON.parse(fs.readFileSync(file, 'utf8'));
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
if (packageJson.private !== true || packageJson.license !== 'AGPL-3.0-or-later') {
  throw new Error('package.json must keep registry publication disabled and declare AGPL-3.0-or-later');
}
const changelog = fs.readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${packageJson.version}] - `)) {
  throw new Error(`CHANGELOG.md must contain a dated section for package version ${packageJson.version}`);
}
const notice = fs.readFileSync(path.join(rootDir, 'NOTICE.md'), 'utf8');
if (!notice.includes('## AI-assisted development')) {
  throw new Error('NOTICE.md must retain the AI-assisted development disclosure');
}
const ciWorkflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'ci.yml'), 'utf8');
for (const marker of ['name: Bun source archive', 'git archive --format=tar.gz', 'bun run doctor']) {
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

console.log(`Checked ${files.length} JavaScript files, ${jsonFiles.length} JSON files, bunfig.toml, and ${markdownFiles.length} Markdown files.`);
