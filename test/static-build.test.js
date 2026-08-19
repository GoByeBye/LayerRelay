'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { onTestFinished, test } = require('bun:test');

const rootDir = path.resolve(__dirname, '..');
const buildScript = path.join(rootDir, 'scripts', 'build-pages.mjs');
const overlayPath = path.join(rootDir, 'public', 'overlay.html');

// The full build needs the demo generator and every browser module the bundle
// entry imports. They are tracked files, so a missing one is a failure to
// report rather than a reason to stop exercising the build end to end.
const bundleSources = ['bgcode.mjs', 'qoi.mjs', 'toolswaps.mjs', 'print-name.mjs',
  'tool-settings.mjs', 'openprinttag.mjs', 'replay.mjs', 'state-engine.mjs',
  'adapter.js', 'main.mjs'];

test('every build input the bundle entry needs is present', () => {
  assert.ok(fs.existsSync(path.join(rootDir, 'bgcode-builder.js')), 'bgcode-builder.js is missing');
  for (const name of bundleSources) {
    assert.ok(fs.existsSync(path.join(rootDir, 'pages', 'app', name)), `pages/app/${name} is missing`);
  }
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-static-build-'));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runBuild(args) {
  return spawnSync(process.execPath, [buildScript, ...args], {
    cwd: rootDir,
    encoding: 'utf8',
  });
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function assertTransformedIndex(html) {
  // The static bundle tag must precede the overlay's inline script so the fetch
  // shim is installed before the first /api poll.
  const bundleTag = html.indexOf('<script src="./lr-static.js"></script>');
  const inlineTag = html.indexOf('<script>');
  assert.notEqual(bundleTag, -1, 'index.html must load ./lr-static.js');
  assert.notEqual(inlineTag, -1, 'index.html must keep the overlay inline script');
  assert.ok(bundleTag < inlineTag, 'lr-static.js tag must precede the inline script');

  // No bare stream literals may remain; every occurrence carries the bridge prefix.
  const nozzleBare = countOccurrences(html, "'/api/nozzle.mjpeg'");
  const nozzlePrefixed = countOccurrences(html, "(window.__LR_API_BASE || '') + '/api/nozzle.mjpeg'");
  assert.equal(nozzleBare, 1);
  assert.equal(nozzlePrefixed, 1, 'nozzle stream literal must carry the bridge prefix');
  const cameraBare = countOccurrences(html, "'/api/camera.mjpeg?overlay=1&_=' + Date.now()");
  const cameraPrefixed = countOccurrences(html,
    "(window.__LR_API_BASE || '') + '/api/camera.mjpeg?overlay=1&_=' + Date.now()");
  assert.equal(cameraBare, 1);
  assert.equal(cameraPrefixed, 1, 'camera stream literal must carry the bridge prefix');

  assert.ok(html.includes('http-equiv="Content-Security-Policy"'), 'CSP meta tag must be present');
  assert.ok(html.includes("default-src 'self'"), 'CSP meta tag must restrict default-src');
  const charsetIndex = html.indexOf('<meta charset');
  const cspIndex = html.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(charsetIndex !== -1 && charsetIndex < cspIndex, 'CSP meta must follow the charset meta');

  assert.ok(html.includes('href="https://github.com/GoByeBye/LayerRelay"'),
    'source link must point at the public repository');
  assert.ok(!html.includes('href="/source"'), 'the server-only /source link must be gone');
}

test('transform stage rewrites the overlay for static hosting', () => {
  const outDir = temporaryDirectory();
  const result = runBuild(['--transform-only', '--out', outDir]);
  assert.equal(result.status, 0, `build failed: ${result.stderr}${result.stdout}`);

  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  assertTransformedIndex(html);
  assert.equal(fs.readFileSync(path.join(outDir, '.nojekyll'), 'utf8'), '');
}, 30000);

test('transform guard exits nonzero when a target literal is duplicated', () => {
  const overlayDir = temporaryDirectory();
  const outDir = temporaryDirectory();
  const cameraLiteral = "'/api/camera.mjpeg?overlay=1&_=' + Date.now()";
  const original = fs.readFileSync(overlayPath, 'utf8');
  assert.equal(countOccurrences(original, cameraLiteral), 1,
    'fixture assumption: overlay.html carries the camera literal exactly once');
  const corruptPath = path.join(overlayDir, 'overlay.html');
  fs.writeFileSync(corruptPath, `${original}\n<!-- ${cameraLiteral} -->\n`);

  const result = runBuild(['--transform-only', '--overlay', corruptPath, '--out', outDir]);
  assert.notEqual(result.status, 0, 'duplicated literal must fail the build');
  assert.match(result.stderr, /overlay transform guard/);
}, 30000);

test('transform guard exits nonzero when a target literal is missing', () => {
  const overlayDir = temporaryDirectory();
  const outDir = temporaryDirectory();
  const original = fs.readFileSync(overlayPath, 'utf8');
  const corruptPath = path.join(overlayDir, 'overlay.html');
  fs.writeFileSync(corruptPath, original.replace('href="/source"', 'href="/elsewhere"'));

  const result = runBuild(['--transform-only', '--overlay', corruptPath, '--out', outDir]);
  assert.notEqual(result.status, 0, 'missing literal must fail the build');
  assert.match(result.stderr, /overlay transform guard/);
}, 30000);

test('full build emits a working index.html, bundle, and demo bgcode', () => {
  const outDir = temporaryDirectory();
  const result = runBuild(['--out', outDir]);
  assert.equal(result.status, 0, `build failed: ${result.stderr}${result.stdout}`);

  assertTransformedIndex(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
  assert.ok(fs.existsSync(path.join(outDir, '.nojekyll')));

  const bundle = fs.readFileSync(path.join(outDir, 'lr-static.js'), 'utf8');
  assert.ok(bundle.length > 0, 'lr-static.js must not be empty');
  assert.doesNotMatch(bundle, /require\(\s*["'](?:node:)?(?:assert|buffer|child_process|crypto|fs|http|https|module|net|os|path|process|stream|url|util|zlib)["']\s*\)/,
    'browser bundle must not require node modules');
  assert.ok(!bundle.includes('process.env'), 'browser bundle must not read process.env');

  const demoBytes = fs.readFileSync(path.join(outDir, 'demo.bgcode'));
  assert.equal(demoBytes.subarray(0, 4).toString('ascii'), 'GCDE');

  const { decodeGcodeText, decodeMetadata } = require('../bgcode.js');
  const gcodeText = decodeGcodeText(demoBytes);
  assert.ok(gcodeText.length > 0, 'demo gcode must decode to non-empty text');
  assert.match(gcodeText, /M73/, 'demo gcode must carry progress markers');
  const metadata = decodeMetadata(demoBytes);
  assert.ok(Object.keys(metadata).length > 0, 'demo metadata must decode to entries');

  const { analyzeBgcode, mapLive } = require('../toolswaps.js');
  const analysis = analyzeBgcode(demoBytes);
  assert.ok(analysis.totalSwaps > 0, 'demo analysis must contain tool swaps');
  assert.ok(mapLive(analysis, 50, 120).swapsTotal > 0, 'mapLive must expose swapsTotal');
}, 120000);
