/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// Builds the static GitHub Pages bundle into dist/pages/ (run with bun):
//   1. Transforms public/overlay.html into dist/pages/index.html with guarded
//      literal rewrites (each transform asserts its exact occurrence count).
//   2. Bundles pages/app/main.mjs into dist/pages/lr-static.js via Bun.build.
//   3. Generates dist/pages/demo.bgcode with bgcode-builder.js, exercising
//      heatshrink 11/4 + MeatPack gcode, deflate metadata, PNG and QOI thumbnails.
//   4. Writes dist/pages/.nojekyll so GitHub Pages serves the artifact verbatim.
// Flags: --out <dir> overrides the output directory, --overlay <path> overrides
// the overlay HTML source, --transform-only stops after the HTML transforms.
// Exits nonzero on any guard failure or missing input.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const USAGE = 'usage: bun scripts/build-pages.mjs [--out <dir>] [--overlay <path>] [--transform-only]';

const CSP_CONTENT = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "connect-src 'self' http: https:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  // frame-ancestors is header-only; browsers ignore it in a <meta> policy and
  // log a console error, so it is deliberately absent here.
].join('; ');

function parseArgs(argv) {
  const options = {
    outDir: path.join(rootDir, 'dist', 'pages'),
    overlayPath: path.join(rootDir, 'public', 'overlay.html'),
    transformOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--out') {
      const value = argv[++i];
      if (!value) throw new Error(`--out requires a directory argument\n${USAGE}`);
      options.outDir = path.resolve(value);
    } else if (argument === '--overlay') {
      const value = argv[++i];
      if (!value) throw new Error(`--overlay requires a file argument\n${USAGE}`);
      options.overlayPath = path.resolve(value);
    } else if (argument === '--transform-only') {
      options.transformOnly = true;
    } else {
      throw new Error(`unknown argument: ${argument}\n${USAGE}`);
    }
  }
  return options;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function assertOccurrences(html, literal, expected, label) {
  const found = countOccurrences(html, literal);
  if (found !== expected) {
    throw new Error(
      `overlay transform guard: expected exactly ${expected} occurrence(s) of ${label}, found ${found}. ` +
      'The overlay HTML changed; update the transforms in scripts/build-pages.mjs to match it.');
  }
}

function replaceOnce(html, literal, replacement, label) {
  assertOccurrences(html, literal, 1, label);
  const index = html.indexOf(literal);
  return html.slice(0, index) + replacement + html.slice(index + literal.length);
}

function transformOverlay(html) {
  // 1. Load the static bundle before the overlay's single inline script so the
  //    fetch shim is installed by the time the overlay starts polling /api/*.
  assertOccurrences(html, '<script', 1, 'the <script open tag');
  const scriptIndex = html.indexOf('<script');
  const scriptLineStart = html.lastIndexOf('\n', scriptIndex) + 1;
  html = html.slice(0, scriptLineStart) +
    '  <script src="./lr-static.js"></script>\n' +
    html.slice(scriptLineStart);

  // 2. The /source redirect only exists on the live server.
  html = replaceOnce(html, 'href="/source"',
    'href="https://github.com/GoByeBye/LayerRelay"',
    'the href="/source" link');

  // 3. MJPEG streams cannot be served by the virtual engine; point <img> URLs at
  //    the optional live bridge origin so direct embeds work in live mode.
  html = replaceOnce(html, "'/api/nozzle.mjpeg'",
    "(window.__LR_API_BASE || '') + '/api/nozzle.mjpeg'",
    "the '/api/nozzle.mjpeg' literal");
  html = replaceOnce(html, "'/api/camera.mjpeg?overlay=1&_=' + Date.now()",
    "(window.__LR_API_BASE || '') + '/api/camera.mjpeg?overlay=1&_=' + Date.now()",
    "the '/api/camera.mjpeg?overlay=1&_=' + Date.now() literal");

  // 4. GitHub Pages cannot send response headers, so ship the CSP as a meta tag
  //    right after the charset declaration.
  assertOccurrences(html, '<meta charset', 1, 'the <meta charset tag');
  const charsetIndex = html.indexOf('<meta charset');
  const charsetLineEnd = html.indexOf('\n', charsetIndex);
  if (charsetLineEnd === -1) {
    throw new Error('overlay transform guard: the <meta charset tag must end with a newline');
  }
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${CSP_CONTENT}" />`;
  html = html.slice(0, charsetLineEnd + 1) + cspTag + '\n' + html.slice(charsetLineEnd + 1);

  return html;
}

async function buildBundle() {
  const entrypoint = path.join(rootDir, 'pages', 'app', 'main.mjs');
  if (!fs.existsSync(entrypoint)) {
    throw new Error('missing pages/app/main.mjs; the browser app sources must exist before bundling');
  }
  let result;
  try {
    result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      format: 'iife',
      minify: true,
      sourcemap: 'none',
    });
  } catch (error) {
    // Bun.build throws an AggregateError (for example on top-level await, which
    // the iife format rejects); surface the nested messages.
    const nested = Array.isArray(error?.errors)
      ? error.errors.map((entry) => String(entry?.message ?? entry)).join('\n')
      : '';
    throw new Error(`Bun.build failed for pages/app/main.mjs: ${error.message}${nested ? `\n${nested}` : ''}`);
  }
  if (!result.success) {
    const details = result.logs.map((entry) => String(entry?.message ?? entry)).join('\n');
    throw new Error(`Bun.build failed for pages/app/main.mjs:\n${details}`);
  }
  const output = result.outputs.find((artifact) => artifact.kind === 'entry-point') ?? result.outputs[0];
  if (!output) throw new Error('Bun.build produced no output artifact for pages/app/main.mjs');
  const code = await output.text();
  if (code.length === 0) throw new Error('Bun.build produced an empty bundle for pages/app/main.mjs');
  // Top-level await would defer the fetch shim past the overlay's inline script.
  // A classic (non-module) script cannot contain top-level await, so parsing the
  // bundle as a function body proves none survived bundling. new Function only
  // parses; the bundle is never executed here.
  try {
    new Function(code);
  } catch (error) {
    throw new Error(`bundled lr-static.js is not a valid classic script (top-level await?): ${error.message}`);
  }
  return code;
}

function buildDemoBgcode() {
  const builderPath = path.join(rootDir, 'bgcode-builder.js');
  if (!fs.existsSync(builderPath)) {
    throw new Error('missing bgcode-builder.js; the demo generator must exist before building');
  }
  const builder = require(builderPath);
  for (const name of ['buildBgcode', 'makeDemoPrint', 'makeDemoThumbnail', 'pngEncode', 'qoiEncode']) {
    if (typeof builder[name] !== 'function') {
      throw new Error(`bgcode-builder.js does not export the required function ${name}()`);
    }
  }
  const demo = builder.makeDemoPrint();
  if (!demo || typeof demo.text !== 'string' || demo.text.length === 0) {
    throw new Error('makeDemoPrint() must return a non-empty gcode text');
  }
  // Accept either sectioned metadata ({file, printer, print, slicer}) or a flat
  // record; a flat record lands in the print metadata block.
  const sections = ['file', 'printer', 'print', 'slicer'];
  const metadata = demo.metadata && sections.some((key) =>
    demo.metadata[key] && typeof demo.metadata[key] === 'object')
    ? demo.metadata
    : { print: demo.metadata || {} };
  const thumbnailSpecs = [
    { format: 0, width: 320, height: 240, encode: builder.pngEncode },
    { format: 0, width: 64, height: 48, encode: builder.pngEncode },
    { format: 2, width: 160, height: 120, encode: builder.qoiEncode },
  ];
  const thumbnails = thumbnailSpecs.map(({ format, width, height, encode }) => ({
    format,
    width,
    height,
    data: encode(builder.makeDemoThumbnail(width, height), width, height),
  }));
  // encoding 1 = MeatPack, compression 2 = heatshrink 11/4 (bgcode.js:178).
  return builder.buildBgcode({
    gcode: { text: demo.text, encoding: 1, compression: 2 },
    metadata,
    thumbnails,
    checksum: true,
  });
}

function formatSize(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.overlayPath)) {
    throw new Error(`overlay HTML not found at ${options.overlayPath}`);
  }
  const indexHtml = transformOverlay(fs.readFileSync(options.overlayPath, 'utf8'));

  const files = [['index.html', indexHtml], ['.nojekyll', '']];
  if (!options.transformOnly) {
    files.push(['lr-static.js', await buildBundle()]);
    files.push(['demo.bgcode', buildDemoBgcode()]);
  }

  fs.mkdirSync(options.outDir, { recursive: true });
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(options.outDir, name), content);
  }

  const mode = options.transformOnly ? 'transform-only' : 'full';
  console.log(`build:pages (${mode}) wrote ${files.length} file(s) to ${options.outDir}`);
  for (const [name, content] of files) {
    console.log(`  ${name.padEnd(13)} ${formatSize(content.length)}`);
  }
}

main().catch((error) => {
  console.error(`build:pages failed: ${error.message}`);
  process.exit(1);
});
