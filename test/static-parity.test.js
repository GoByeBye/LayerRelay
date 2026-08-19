'use strict';

// Parity tests: the browser ESM ports in pages/app/ must decode byte-identically
// to the root CommonJS modules. Fixture containers are built inline (node:zlib
// deflate, hand-rolled heatshrink literal streams) so these tests run even
// before bgcode-builder.js exists; the builder-fixture matrix below is skipped
// until that file lands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { test } = require('bun:test');

const rootBgcode = require('../bgcode.js');
const rootToolswaps = require('../toolswaps.js');
const rootPrintName = require('../print-name.js');

const builderPath = path.join(__dirname, '..', 'bgcode-builder.js');
const hasBuilder = fs.existsSync(builderPath);
const testIfBuilder = hasBuilder ? test : test.skip;
if (!hasBuilder) {
  console.log('static-parity: ../bgcode-builder.js not present yet; builder-fixture parity tests are skipped. Integrator: re-run bun test once agent B lands bgcode-builder.js.');
}

// Browser modules are ESM; load them once via dynamic import.
const browserModules = (async () => ({
  bgcode: await import('../pages/app/bgcode.mjs'),
  toolswaps: await import('../pages/app/toolswaps.mjs'),
  printName: await import('../pages/app/print-name.mjs'),
  qoi: await import('../pages/app/qoi.mjs'),
}))();

async function withWatchdog(promise, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('test watchdog expired')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Inline bgcode container builder (fixtures only) -------------------------
// Layout inverted from bgcode.js iterBlocks: GCDE + version u32 + checksum u16,
// then per block: type u16, compression u16, uncompressedSize u32,
// [compressedSize u32 when compressed], params (2 bytes, 6 for thumbnails),
// data, [4-byte CRC when checksum enabled].
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }

function buildContainer(blocks, { checksum = false } = {}) {
  const parts = [Buffer.from('GCDE', 'latin1'), u32(1), u16(checksum ? 1 : 0)];
  for (const blk of blocks) {
    parts.push(u16(blk.type), u16(blk.compression), u32(blk.uncompressedSize));
    if (blk.compression !== 0) parts.push(u32(blk.payload.length));
    parts.push(blk.params);
    parts.push(blk.payload);
    if (checksum) parts.push(Buffer.from([0xde, 0xad, 0xbe, 0xef])); // decoder skips, never verifies
  }
  return Buffer.concat(parts);
}

function gcodeBlock(textLatin1, { compression = 0, encoding = 0, payload = null } = {}) {
  const raw = Buffer.from(textLatin1, 'latin1');
  return {
    type: 1,
    compression,
    uncompressedSize: raw.length,
    params: u16(encoding),
    payload: payload || (compression === 1 ? zlib.deflateRawSync(raw) : raw),
  };
}

function metadataBlock(type, ini, { compression = 1, zlibWrapped = false } = {}) {
  const raw = Buffer.from(ini, 'latin1');
  let payload = raw;
  if (compression === 1) payload = zlibWrapped ? zlib.deflateSync(raw) : zlib.deflateRawSync(raw);
  return { type, compression, uncompressedSize: raw.length, params: u16(0), payload };
}

function thumbnailBlock(format, width, height, data, { compression = 0 } = {}) {
  return {
    type: 5,
    compression,
    uncompressedSize: data.length,
    params: Buffer.concat([u16(format), u16(width), u16(height)]),
    payload: compression === 1 ? zlib.deflateRawSync(data) : data,
  };
}

// Literal-only heatshrink stream (tag bit 1 + 8 data bits, MSB first). Valid
// for any window/lookahead size, so it exercises both compression 2 and 3.
function heatshrinkLiteralEncode(bytes) {
  const out = Buffer.alloc(Math.ceil((bytes.length * 9) / 8));
  let bit = 0;
  const push = (v) => {
    if (v) out[bit >> 3] |= 0x80 >> (bit & 7);
    bit++;
  };
  for (const b of bytes) {
    push(1);
    for (let i = 7; i >= 0; i--) push((b >> i) & 1);
  }
  return out;
}

// Deterministic pseudo-random bytes (LCG); no Math.random in tests.
function pseudoBytes(count, seed = 0x1234) {
  const out = Buffer.alloc(count);
  let s = seed >>> 0;
  for (let i = 0; i < count; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = (s >>> 16) & 0xff;
  }
  return out;
}

// ---- Fixture corpus ----------------------------------------------------------
// \xE9, \x85, \xFE exercise the latin1 identity mapping: a windows-1252
// TextDecoder would turn 0x85 into U+2026 and break byte parity.
const GCODE_TEXT = [
  '; parity fixture',
  '; latin1 bytes: caf\xE9 \x85 \xFE',
  'M73P0R120',
  'T0',
  ';LAYER_CHANGE',
  ';Z:0.2',
  ';FLUSH_START',
  'G1 X1 E10',
  'G1 E-2',
  ';FLUSH_END',
  'M73P25R90',
  'T1',
  ';EXCLUDE_E_START',
  'G1 X2 E2.5',
  ';EXCLUDE_E_END',
  ';LAYER_CHANGE',
  ';Z:0.4',
  'M73P50R60',
  'T2',
  'M73P50R55',
  'T0',
  'M73P100R0',
  '',
].join('\n');

const META_FILE_INI = [
  'filament_type=PLA;PETG;PLA',
  'filament_diameter=1.75',
  'filament_density=1.24',
  '',
].join('\n');

const META_PRINT_INI = [
  'total filament used [g]=42.5',
  'printer_model=COREONE',
  'objects_info={"objects":[{"name":"Voron cube.stl"},{"name":"Merged"}]}',
  '',
].join('\n');

function buildFixtureContainer({ checksum = false } = {}) {
  const half = Math.floor(GCODE_TEXT.length / 2);
  return buildContainer([
    metadataBlock(0, META_FILE_INI),                        // deflate raw
    metadataBlock(4, META_PRINT_INI, { zlibWrapped: true }), // zlib wrapped: fallback path
    gcodeBlock(GCODE_TEXT.slice(0, half)),                   // stored
    gcodeBlock(GCODE_TEXT.slice(half), { compression: 1 }),  // deflate raw
  ], { checksum });
}

// ---- print-name / toolswaps pure-function parity -----------------------------
test('print-name port matches root on a sample table', async () => {
  const { printName } = await browserModules;
  const nameInputs = ['Merged', 'merged (3)', 'Untitled', 'new_project 2', 'Benchy', '', null, '  '];
  for (const value of nameInputs) {
    assert.equal(printName.isGenericPrintName(value), rootPrintName.isGenericPrintName(value));
  }
  const objectInputs = ['C:\\prints\\Voron cube.STL', '/tmp/a/benchy.3mf', 'plain', 'evil\u0000name.obj', 42];
  for (const value of objectInputs) {
    assert.equal(printName.cleanObjectName(value), rootPrintName.cleanObjectName(value));
  }
  const metas = [
    { objects_info: '{"objects":[{"name":"a.stl"},{"name":"A.STL"},{"name":"Merged"},{"name":"b.3mf"}]}' },
    { objects_info: 'not json' },
    { objects_info: { objects: [{ name: 'inline.stl' }] } },
    {},
  ];
  for (const meta of metas) {
    assert.deepEqual(printName.objectNamesFromMetadata(meta), rootPrintName.objectNamesFromMetadata(meta));
    assert.equal(printName.modelNameFromMetadata(meta), rootPrintName.modelNameFromMetadata(meta));
  }
  assert.equal(
    printName.preferredPrintName('Merged', 'cube.stl', '  My  Print '),
    rootPrintName.preferredPrintName('Merged', 'cube.stl', '  My  Print '),
  );
  assert.equal(
    printName.preferredPrintName('Merged', 'cube.stl', null),
    rootPrintName.preferredPrintName('Merged', 'cube.stl', null),
  );
});

test('buildTimeline and ANALYSIS_VERSION match root', async () => {
  const { toolswaps } = await browserModules;
  assert.equal(toolswaps.ANALYSIS_VERSION, rootToolswaps.ANALYSIS_VERSION);
  assert.deepEqual(toolswaps.buildTimeline(GCODE_TEXT), rootToolswaps.buildTimeline(GCODE_TEXT));
  assert.deepEqual(
    toolswaps.parseMaterials({ filament_type: 'PETG;;PLA; ' }),
    rootToolswaps.parseMaterials({ filament_type: 'PETG;;PLA; ' }),
  );
});

// ---- Inline container decode parity ------------------------------------------
test('inline container: decodeGcodeText and decodeMetadata byte-identical (stored, deflate raw, zlib fallback, latin1 bytes)', async () => {
  const { bgcode } = await browserModules;
  const container = buildFixtureContainer();

  assert.equal(bgcode.isBgcode(container), true);
  assert.equal(bgcode.isBgcode(Buffer.from('not a bgcode file')), false);

  const rootText = rootBgcode.decodeGcodeText(container);
  const browserText = await withWatchdog(bgcode.decodeGcodeText(container));
  assert.equal(browserText, rootText);
  assert.equal(rootText, GCODE_TEXT); // both must reassemble the original corpus
  assert.equal(browserText.includes('caf\xE9 \x85 \xFE'), true); // latin1 identity, not windows-1252

  const rootMeta = rootBgcode.decodeMetadata(container);
  const browserMeta = await withWatchdog(bgcode.decodeMetadata(container));
  assert.deepEqual(browserMeta, rootMeta);
  assert.equal(rootMeta.filament_type, 'PLA;PETG;PLA');
  assert.equal(rootMeta['total filament used [g]'], '42.5');
});

test('inline container: checksum blocks and offset Uint8Array views decode identically', async () => {
  const { bgcode } = await browserModules;
  const container = buildFixtureContainer({ checksum: true });
  const padded = Buffer.concat([Buffer.from([1, 2, 3]), container]);
  const view = padded.subarray(3); // nonzero byteOffset exercises the DataView plumbing

  const rootText = rootBgcode.decodeGcodeText(view);
  assert.equal(await withWatchdog(bgcode.decodeGcodeText(view)), rootText);
  assert.equal(rootText, GCODE_TEXT);
  assert.deepEqual(await withWatchdog(bgcode.decodeMetadata(view)), rootBgcode.decodeMetadata(view));
});

test('inline container: heatshrink 11/4 and 12/4 literal streams decode identically', async () => {
  const { bgcode } = await browserModules;
  const raw = Buffer.from(GCODE_TEXT, 'latin1');
  const stream = heatshrinkLiteralEncode(raw);
  const container = buildContainer([
    { type: 1, compression: 2, uncompressedSize: raw.length, params: u16(0), payload: stream },
    { type: 1, compression: 3, uncompressedSize: raw.length, params: u16(0), payload: stream },
  ]);

  const rootText = rootBgcode.decodeGcodeText(container);
  assert.equal(await withWatchdog(bgcode.decodeGcodeText(container)), rootText);
  assert.equal(rootText, GCODE_TEXT + GCODE_TEXT);
});

test('inline container: meatpack streams decode identically on pseudo-random bytes', async () => {
  const { bgcode } = await browserModules;
  // Signal + EnablePacking + EnableNoSpaces, then arbitrary bytes. Both decoders
  // must walk the identical state machine regardless of stream validity.
  const packed = Buffer.concat([
    Buffer.from([0xff, 0xff, 251, 0xff, 0xff, 247]),
    pseudoBytes(4096, 0xbeef),
  ]);
  const container = buildContainer([
    { type: 1, compression: 0, uncompressedSize: packed.length, params: u16(1), payload: packed },
  ]);

  const rootText = rootBgcode.decodeGcodeText(container);
  const browserText = await withWatchdog(bgcode.decodeGcodeText(container));
  assert.equal(browserText, rootText);
  assert.ok(rootText.length > 0);
});

test('inline container: analyzeBgcode deep-equals root and mapLive sweeps identically', async () => {
  const { toolswaps } = await browserModules;
  const container = buildFixtureContainer();

  const rootAnalysis = rootToolswaps.analyzeBgcode(container);
  const browserAnalysis = await withWatchdog(toolswaps.analyzeBgcode(container));
  assert.deepEqual(browserAnalysis, rootAnalysis);
  assert.equal(browserAnalysis.version, 6);
  assert.equal(browserAnalysis.modelName, 'Voron cube');
  assert.ok(browserAnalysis.totalSwaps > 0);

  const remMins = [null, 130, 120, 90, 60, 55, 30, 0];
  for (let pct = 0; pct <= 100; pct += 0.5) {
    for (const remMin of remMins) {
      assert.deepEqual(
        toolswaps.mapLive(browserAnalysis, pct, remMin),
        rootToolswaps.mapLive(rootAnalysis, pct, remMin),
        `mapLive diverged at pct=${pct} remMin=${remMin}`,
      );
    }
  }
});

test('plain-text gcode: analyzeBgcode parity and identical error messages', async () => {
  const { toolswaps } = await browserModules;
  const text = [
    '; filament_type = PETG;PLA',
    '; filament_diameter = 1.75',
    '; filament_density = 1.27',
    '; total filament used [g] = 12.5',
    'M73 P0 R20',
    'T0',
    ';FLUSH_START',
    'G1 E10',
    ';FLUSH_END',
    'M73 P25 R15',
    'T1',
  ].join('\n');
  const buf = Buffer.from(text, 'utf8');

  const rootAnalysis = rootToolswaps.analyzeBgcode(buf);
  const browserAnalysis = await withWatchdog(toolswaps.analyzeBgcode(new Uint8Array(buf)));
  assert.deepEqual(browserAnalysis, rootAnalysis);

  assert.throws(() => rootToolswaps.analyzeBgcode(Buffer.alloc(0)), /empty G-code response/);
  await assert.rejects(toolswaps.analyzeBgcode(new Uint8Array(0)), /empty G-code response/);
  const html = Buffer.from('<!doctype html><title>temporary error</title>');
  assert.throws(() => rootToolswaps.analyzeBgcode(html), /not plausible plain-text G-code/);
  await assert.rejects(toolswaps.analyzeBgcode(new Uint8Array(html)), /not plausible plain-text G-code/);
});

test('bad magic rejects with the root error message', async () => {
  const { bgcode } = await browserModules;
  const junk = Buffer.from('MZ\x90\x00 definitely not bgcode', 'latin1');
  assert.throws(() => rootBgcode.decodeGcodeText(junk), /not a bgcode file \(bad magic\)/);
  await assert.rejects(bgcode.decodeGcodeText(junk), /not a bgcode file \(bad magic\)/);
});

// ---- Thumbnail extraction ----------------------------------------------------
test('extractThumbnails returns exact embedded bytes with format, width, height', async () => {
  const { bgcode } = await browserModules;
  const pngBytes = pseudoBytes(600, 0x50);
  const jpgBytes = pseudoBytes(400, 0x51);
  const qoiBytes = pseudoBytes(300, 0x52);
  const container = buildContainer([
    thumbnailBlock(0, 320, 240, pngBytes),
    thumbnailBlock(1, 64, 48, jpgBytes, { compression: 1 }), // honor block compression
    thumbnailBlock(2, 160, 120, qoiBytes),
    gcodeBlock(GCODE_TEXT),
  ]);

  const thumbs = await withWatchdog(bgcode.extractThumbnails(container));
  assert.equal(thumbs.length, 3);
  assert.equal(thumbs[0].format, 'png');
  assert.equal(thumbs[0].width, 320);
  assert.equal(thumbs[0].height, 240);
  assert.deepEqual(Buffer.from(thumbs[0].data), pngBytes);
  assert.equal(thumbs[1].format, 'jpg');
  assert.equal(thumbs[1].width, 64);
  assert.equal(thumbs[1].height, 48);
  assert.deepEqual(Buffer.from(thumbs[1].data), jpgBytes);
  assert.equal(thumbs[2].format, 'qoi');
  assert.equal(thumbs[2].width, 160);
  assert.equal(thumbs[2].height, 120);
  assert.deepEqual(Buffer.from(thumbs[2].data), qoiBytes);

  // Thumbnail blocks must stay invisible to the text and metadata decoders.
  assert.equal(rootBgcode.decodeGcodeText(container), GCODE_TEXT);
  assert.equal(await withWatchdog(bgcode.decodeGcodeText(container)), GCODE_TEXT);
  assert.deepEqual(await withWatchdog(bgcode.decodeMetadata(container)), rootBgcode.decodeMetadata(container));
});

// ---- QOI decoder -------------------------------------------------------------
test('decodeQoi decodes a hand-built stream exercising every op', async () => {
  const { qoi } = await browserModules;
  // 4x2 RGBA image: RGB, DIFF, LUMA, RGBA, RUN(2 extra), INDEX, RGB.
  const header = Buffer.concat([
    Buffer.from('qoif', 'latin1'),
    Buffer.from([0, 0, 0, 4]), // width, big-endian
    Buffer.from([0, 0, 0, 2]), // height
    Buffer.from([4, 0]),       // channels, colorspace
  ]);
  const chunks = Buffer.from([
    0xfe, 10, 20, 30,          // OP_RGB -> (10,20,30,255), index slot 9
    0x79,                      // OP_DIFF dr=+1 dg=0 db=-1 -> (11,20,29,255)
    0xa5, 0xa5,                // OP_LUMA dg=5 dr-dg=2 db-dg=-3 -> (18,25,31,255)
    0xff, 200, 100, 50, 128,   // OP_RGBA -> (200,100,50,128)
    0xc1,                      // OP_RUN 2 more of (200,100,50,128)
    0x09,                      // OP_INDEX slot 9 -> (10,20,30,255)
    0xfe, 1, 2, 3,             // OP_RGB -> (1,2,3,255)
  ]);
  const end = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]);
  const decoded = qoi.decodeQoi(new Uint8Array(Buffer.concat([header, chunks, end])));

  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 2);
  assert.deepEqual(Array.from(decoded.rgba), [
    10, 20, 30, 255,
    11, 20, 29, 255,
    18, 25, 31, 255,
    200, 100, 50, 128,
    200, 100, 50, 128,
    200, 100, 50, 128,
    10, 20, 30, 255,
    1, 2, 3, 255,
  ]);

  assert.throws(() => qoi.decodeQoi(new Uint8Array(Buffer.concat([Buffer.from('nope', 'latin1'), header.subarray(4), chunks, end]))), /bad magic/);
  assert.throws(() => qoi.decodeQoi(new Uint8Array(Buffer.concat([header, chunks.subarray(0, 3), end]))), /truncated/);
  assert.throws(() => qoi.decodeQoi(new Uint8Array(5)), /truncated/);
});

// ---- Builder-fixture matrix (skipped until bgcode-builder.js lands) ----------
function builderMetadataOption(meta) {
  const sections = ['file', 'printer', 'print', 'slicer'];
  if (meta && sections.some((s) => meta[s] && typeof meta[s] === 'object')) return meta;
  return { print: meta };
}

testIfBuilder('builder fixtures: decode parity across the encoding x compression matrix', async () => {
  const builder = require(builderPath);
  const { bgcode, toolswaps } = await browserModules;
  const demo = builder.makeDemoPrint();
  const metadata = builderMetadataOption(demo.metadata);

  for (const encoding of [0, 1]) {
    for (const compression of [0, 1, 2, 3]) {
      const file = builder.buildBgcode({ gcode: { text: demo.text, encoding, compression }, metadata });
      const rootText = rootBgcode.decodeGcodeText(file);
      const browserText = await withWatchdog(bgcode.decodeGcodeText(file), 15000);
      assert.equal(browserText, rootText, `text parity failed at encoding=${encoding} compression=${compression}`);
      assert.ok(rootText.length > 0);
      assert.deepEqual(
        await withWatchdog(bgcode.decodeMetadata(file), 15000),
        rootBgcode.decodeMetadata(file),
        `metadata parity failed at encoding=${encoding} compression=${compression}`,
      );
    }
  }

  // Full analysis parity on representative combos, including checksummed output.
  for (const [encoding, compression, checksum] of [[0, 0, false], [1, 1, false], [1, 3, true]]) {
    const file = builder.buildBgcode({ gcode: { text: demo.text, encoding, compression }, metadata, checksum });
    const rootAnalysis = rootToolswaps.analyzeBgcode(file);
    const browserAnalysis = await withWatchdog(toolswaps.analyzeBgcode(file), 15000);
    assert.deepEqual(browserAnalysis, rootAnalysis,
      `analysis parity failed at encoding=${encoding} compression=${compression} checksum=${checksum}`);
    assert.ok(rootAnalysis.totalSwaps > 0);
    for (let pct = 0; pct <= 100; pct += 0.5) {
      for (const remMin of [null, 240, 120, 45, 0]) {
        assert.deepEqual(
          toolswaps.mapLive(browserAnalysis, pct, remMin),
          rootToolswaps.mapLive(rootAnalysis, pct, remMin),
          `mapLive diverged at pct=${pct} remMin=${remMin}`,
        );
      }
    }
  }
}, 60000);

testIfBuilder('builder thumbnails: extractThumbnails exact bytes and qoiEncode round-trips through decodeQoi', async () => {
  const builder = require(builderPath);
  const { bgcode, qoi } = await browserModules;
  const demo = builder.makeDemoPrint();
  const rgbaLarge = builder.makeDemoThumbnail(320, 240);
  const rgbaSmall = builder.makeDemoThumbnail(160, 120);
  const png = builder.pngEncode(rgbaLarge, 320, 240);
  const qoiImg = builder.qoiEncode(rgbaSmall, 160, 120);

  const file = builder.buildBgcode({
    gcode: { text: demo.text, encoding: 0, compression: 1 },
    metadata: builderMetadataOption(demo.metadata),
    thumbnails: [
      { format: 0, width: 320, height: 240, data: png },
      { format: 2, width: 160, height: 120, data: qoiImg },
    ],
  });

  const thumbs = await withWatchdog(bgcode.extractThumbnails(file), 15000);
  assert.equal(thumbs.length, 2);
  const pngThumb = thumbs.find((t) => t.format === 'png');
  const qoiThumb = thumbs.find((t) => t.format === 'qoi');
  assert.ok(pngThumb && qoiThumb);
  assert.equal(pngThumb.width, 320);
  assert.equal(pngThumb.height, 240);
  assert.deepEqual(Buffer.from(pngThumb.data), png);
  assert.equal(qoiThumb.width, 160);
  assert.equal(qoiThumb.height, 120);
  assert.deepEqual(Buffer.from(qoiThumb.data), qoiImg);

  const decoded = qoi.decodeQoi(new Uint8Array(qoiThumb.data));
  assert.equal(decoded.width, 160);
  assert.equal(decoded.height, 120);
  assert.deepEqual(Buffer.from(decoded.rgba), rgbaSmall);
}, 60000);
