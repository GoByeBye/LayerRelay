'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { test } = require('bun:test');
const {
  buildBgcode,
  heatshrinkEncode,
  meatpackBinarize,
  pngEncode,
  qoiEncode,
  makeDemoPrint,
  makeDemoThumbnail,
  crc32,
} = require('../bgcode-builder.js');
const { decodeGcodeText, decodeMetadata } = require('../bgcode.js');
const { analyzeBgcode } = require('../toolswaps.js');

// Walk the container exactly like iterBlocks in bgcode.js, additionally
// verifying each block's trailing CRC32 (which the root decoder skips).
function* walkBlocks(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'GCDE');
  const checksumType = buf.readUInt16LE(8);
  let off = 10;
  while (off + 8 <= buf.length) {
    const start = off;
    const type = buf.readUInt16LE(off);
    const compression = buf.readUInt16LE(off + 2);
    const uncompressedSize = buf.readUInt32LE(off + 4);
    let p = off + 8;
    let dataSize = uncompressedSize;
    if (compression !== 0) { dataSize = buf.readUInt32LE(p); p += 4; }
    const paramSize = type === 5 ? 6 : 2;
    const params = buf.subarray(p, p + paramSize);
    p += paramSize;
    const data = buf.subarray(p, p + dataSize);
    p += dataSize;
    if (checksumType !== 0) {
      const stored = buf.readUInt32LE(p);
      assert.equal(stored, crc32(buf.subarray(start, p)), 'block CRC32 mismatch for type ' + type);
      p += 4;
    }
    yield { type, compression, uncompressedSize, params, data };
    off = p;
  }
  assert.equal(off, buf.length, 'container has trailing bytes');
}

// Reference QOI decoder following qoi.h decode byte-for-byte, used to prove
// qoiEncode output is spec-conformant without depending on other agents' files.
function qoiDecodeRef(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'qoif', 'bad QOI magic');
  const width = buf.readUInt32BE(4);
  const height = buf.readUInt32BE(8);
  assert.equal(buf[12], 4, 'expected 4 channels');
  const rgba = Buffer.alloc(width * height * 4);
  const index = new Array(64).fill(null).map(() => [0, 0, 0, 0]);
  let r = 0, g = 0, b = 0, a = 255;
  let p = 14, run = 0;
  const chunksLen = buf.length - 8;
  for (let i = 0; i < width * height; i++) {
    if (run > 0) {
      run--;
    } else if (p < chunksLen) {
      const b1 = buf[p++];
      if (b1 === 0xFE) { r = buf[p++]; g = buf[p++]; b = buf[p++]; }
      else if (b1 === 0xFF) { r = buf[p++]; g = buf[p++]; b = buf[p++]; a = buf[p++]; }
      else if ((b1 & 0xC0) === 0x00) { [r, g, b, a] = index[b1]; }
      else if ((b1 & 0xC0) === 0x40) {
        r = (r + ((b1 >> 4) & 0x03) - 2) & 255;
        g = (g + ((b1 >> 2) & 0x03) - 2) & 255;
        b = (b + (b1 & 0x03) - 2) & 255;
      } else if ((b1 & 0xC0) === 0x80) {
        const b2 = buf[p++];
        const vg = (b1 & 0x3F) - 32;
        r = (r + vg - 8 + ((b2 >> 4) & 0x0F)) & 255;
        g = (g + vg) & 255;
        b = (b + vg - 8 + (b2 & 0x0F)) & 255;
      } else {
        run = b1 & 0x3F;
      }
      index[(r * 3 + g * 5 + b * 7 + a * 11) % 64] = [r, g, b, a];
    }
    const o = i * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
  }
  assert.deepEqual([...buf.subarray(buf.length - 8)], [0, 0, 0, 0, 0, 0, 0, 1], 'bad QOI end marker');
  return { width, height, rgba };
}

test('crc32 matches the standard check vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  if (typeof zlib.crc32 === 'function') {
    const sample = makeDemoThumbnail(16, 16);
    assert.equal(crc32(sample), zlib.crc32(sample) >>> 0);
  }
});

test('container layout: header, block order, thumbnail params, per-block CRC32', () => {
  const text = 'T0\nG1 X1 Y2 E0.5\n';
  const metadata = {
    file: { Producer: 'test' },
    printer: { printer_model: 'COREONE' },
    print: { 'total filament used [g]': '1.5' },
    slicer: { filament_type: 'PLA' },
  };
  const png = pngEncode(makeDemoThumbnail(16, 12), 16, 12);
  const qoi = qoiEncode(makeDemoThumbnail(8, 8), 8, 8);
  const file = buildBgcode({
    gcode: { text, encoding: 0, compression: 1 },
    metadata,
    thumbnails: [
      { format: 0, width: 16, height: 12, data: png },
      { format: 2, width: 8, height: 8, data: qoi },
    ],
    checksum: true,
  });

  assert.equal(file.readUInt32LE(4), 1, 'container version');
  assert.equal(file.readUInt16LE(8), 1, 'checksum type');

  const blocks = [...walkBlocks(file)]; // walkBlocks verifies every block CRC
  assert.deepEqual(blocks.map((b) => b.type), [0, 3, 5, 5, 4, 2, 1]);

  const [thumbPng, thumbQoi] = blocks.filter((b) => b.type === 5);
  assert.equal(thumbPng.params.readUInt16LE(0), 0);
  assert.equal(thumbPng.params.readUInt16LE(2), 16);
  assert.equal(thumbPng.params.readUInt16LE(4), 12);
  assert.deepEqual([...thumbPng.data], [...png]);
  assert.equal(thumbQoi.params.readUInt16LE(0), 2);
  assert.equal(thumbQoi.params.readUInt16LE(2), 8);
  assert.equal(thumbQoi.params.readUInt16LE(4), 8);
  assert.deepEqual([...thumbQoi.data], [...qoi]);

  const gcodeBlock = blocks.find((b) => b.type === 1);
  assert.equal(gcodeBlock.compression, 1);
  assert.equal(gcodeBlock.params.readUInt16LE(0), 0);
  assert.equal(gcodeBlock.uncompressedSize, Buffer.from(text, 'latin1').length);
  assert.equal(zlib.inflateRawSync(gcodeBlock.data).toString('latin1'), text);

  const fileMeta = blocks.find((b) => b.type === 0);
  assert.equal(fileMeta.compression, 1);
  assert.equal(zlib.inflateRawSync(fileMeta.data).toString('latin1'), 'Producer=test\n');

  const noCrc = buildBgcode({ gcode: { text, encoding: 0, compression: 0 }, checksum: false });
  assert.equal(noCrc.readUInt16LE(8), 0);
  assert.equal(decodeGcodeText(noCrc), text);
});

test('decodeGcodeText round-trips the demo corpus for every encoding and compression combo', () => {
  const { text, metadata } = makeDemoPrint();
  for (const encoding of [0, 1]) {
    for (const compression of [0, 1, 2, 3]) {
      const file = buildBgcode({ gcode: { text, encoding, compression }, metadata, checksum: true });
      assert.equal(decodeGcodeText(file), text, 'encoding ' + encoding + ' compression ' + compression);
    }
  }
});

test('meatpack spaces mode (noSpaces:false) round-trips the demo corpus', () => {
  const { text } = makeDemoPrint();
  const file = buildBgcode({ gcode: { text, encoding: 1, compression: 0, noSpaces: false }, checksum: false });
  assert.equal(decodeGcodeText(file), text);
});

test('meatpack edge cases round-trip through the root unbinarizer', () => {
  const cases = [
    'T0\n',                       // packed pair with escaped first char
    ';;!!\n',                     // consecutive both-unpackable pairs (0xFF pack bytes)
    'M73P5R10',                   // no trailing newline, ends on a packed pair
    'T01',                        // trailing single packable char
    'T0\nM',                      // trailing single unpackable char
    '\n',                         // lone newline in the first pack slot
    'T0\n1\n',                    // newline forced into the first slot mid-stream
    'G1 X0.5 Y2 E0.1\n',          // canonical G line space reinsertion
    'G28 W\nG92 E0\nX\n',         // W/E params plus a bare packable X line
    '123.456\n;plain\n',          // digit-only line and spaceless comment
    'G4\n',                       // G line with no parameters
  ];
  for (const text of cases) {
    const file = buildBgcode({ gcode: { text, encoding: 1, compression: 0 }, checksum: false });
    assert.equal(decodeGcodeText(file), text, JSON.stringify(text));
  }
});

test('heatshrink 11/4 and 12/4 encode arbitrary binary decodably', () => {
  const lcgBytes = (seed, len) => {
    const out = Buffer.alloc(len);
    let s = seed >>> 0;
    for (let i = 0; i < len; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      out[i] = (s >>> 16) & 0xFF;
    }
    return out;
  };
  const buffers = [
    lcgBytes(0xC0FFEE, 30000),
    Buffer.alloc(5000, 0x41),
    Buffer.from('A'),
    Buffer.from('AB'),
    Buffer.from('abcabcabcabc'.repeat(400)),
  ];
  for (const buf of buffers) {
    // latin1 maps bytes 0..255 one-to-one, so the container's encoding-0 text
    // path round-trips arbitrary binary through decodeGcodeText.
    const text = buf.toString('latin1');
    for (const compression of [2, 3]) {
      const file = buildBgcode({ gcode: { text, encoding: 0, compression }, checksum: true });
      assert.equal(decodeGcodeText(file), text, 'len ' + buf.length + ' compression ' + compression);
    }
  }
  const repetitive = Buffer.alloc(5000, 0x41);
  assert.ok(heatshrinkEncode(repetitive, 11, 4).length < repetitive.length / 4, 'repetitive input should compress');
});

test('decodeMetadata returns the merged INI map from all metadata blocks', () => {
  const metadata = {
    file: { Producer: 'LayerRelay demo builder 1.0' },
    printer: { printer_model: 'COREONE', nozzle_diameter: '0.4;0.4' },
    print: { 'total filament used [g]': '87.4', 'estimated printing time (normal mode)': '4h 0m 0s' },
    slicer: {
      filament_type: 'PLA;PETG',
      objects_info: '{"objects":[{"name":"Voron cube x5"}]}',
    },
  };
  const file = buildBgcode({ gcode: { text: 'T0\n', encoding: 0, compression: 0 }, metadata, checksum: true });
  assert.deepEqual(decodeMetadata(file), {
    Producer: 'LayerRelay demo builder 1.0',
    printer_model: 'COREONE',
    nozzle_diameter: '0.4;0.4',
    'total filament used [g]': '87.4',
    'estimated printing time (normal mode)': '4h 0m 0s',
    filament_type: 'PLA;PETG',
    objects_info: '{"objects":[{"name":"Voron cube x5"}]}',
  });
});

test('pngEncode emits a valid RGBA PNG with correct chunk CRCs', () => {
  const width = 20, height = 12;
  const rgba = makeDemoThumbnail(width, height);
  const png = pngEncode(rgba, width, height);

  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const chunks = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const body = png.subarray(off + 4, off + 8 + len);
    const storedCrc = png.readUInt32BE(off + 8 + len);
    assert.equal(storedCrc, crc32(body), 'CRC mismatch on ' + type);
    chunks.push({ type, data: png.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  assert.equal(off, png.length);
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);

  const ihdr = chunks[0].data;
  assert.equal(ihdr.length, 13);
  assert.equal(ihdr.readUInt32BE(0), width);
  assert.equal(ihdr.readUInt32BE(4), height);
  assert.equal(ihdr[8], 8, 'bit depth');
  assert.equal(ihdr[9], 6, 'color type RGBA');
  assert.deepEqual([ihdr[10], ihdr[11], ihdr[12]], [0, 0, 0]);

  const raw = zlib.inflateSync(chunks[1].data);
  const stride = 1 + width * 4;
  assert.equal(raw.length, height * stride);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, 'filter byte row ' + y);
    assert.deepEqual(
      [...raw.subarray(y * stride + 1, (y + 1) * stride)],
      [...rgba.subarray(y * width * 4, (y + 1) * width * 4)],
      'pixel row ' + y,
    );
  }
  assert.equal(chunks[2].data.length, 0);
});

test('qoiEncode output decodes back to the source rgba via a reference decoder', () => {
  const width = 48, height = 32;
  const rgba = makeDemoThumbnail(width, height);
  const qoi = qoiEncode(rgba, width, height);
  assert.equal(qoi.readUInt32BE(4), width);
  assert.equal(qoi.readUInt32BE(8), height);
  const decoded = qoiDecodeRef(qoi);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual([...decoded.rgba], [...rgba]);

  // Crafted 6x2 pattern exercising LUMA, DIFF, RUN, RGBA, INDEX and RGB ops.
  const px = [
    [10, 10, 10, 255],   // LUMA from the implicit (0,0,0,255) start pixel
    [11, 11, 11, 255],   // DIFF
    [11, 11, 11, 255],   // RUN
    [11, 11, 11, 255],   // RUN
    [200, 50, 50, 128],  // RGBA (alpha change)
    [10, 10, 10, 255],   // INDEX (seen as the first pixel)
    [200, 10, 10, 255],  // RGB (red jump too large for LUMA, same alpha)
    [200, 10, 10, 255],  // RUN
    [199, 11, 9, 255],   // DIFF
    [90, 200, 90, 60],   // RGBA
    [90, 200, 90, 60],   // RUN
    [200, 50, 50, 128],  // INDEX
  ];
  const flat = Buffer.from(px.flat());
  const crafted = qoiEncode(flat, 6, 2);
  assert.ok(crafted.includes(0xFE), 'expected a QOI_OP_RGB chunk');
  assert.deepEqual([...qoiDecodeRef(crafted).rgba], [...flat]);
});

test('makeDemoThumbnail is deterministic opaque RGBA with multiple colors', () => {
  const a = makeDemoThumbnail(32, 24);
  const b = makeDemoThumbnail(32, 24);
  assert.equal(a.length, 32 * 24 * 4);
  assert.deepEqual([...a], [...b]);
  const colors = new Set();
  for (let i = 0; i < a.length; i += 4) {
    assert.equal(a[i + 3], 255, 'alpha at pixel ' + i / 4);
    colors.add((a[i] << 16) | (a[i + 1] << 8) | a[i + 2]);
  }
  assert.ok(colors.size >= 5, 'expected a multi-color render, got ' + colors.size);
});

test('demo print analyzes like a real INDX multitool job through the root toolchain', () => {
  const demo = makeDemoPrint();
  assert.equal(demo.name, 'Voron cube x5');
  assert.ok(demo.text.length < 400 * 1024, 'demo corpus stays under 400KB');
  assert.equal(makeDemoPrint().text, demo.text, 'demo corpus is deterministic');
  assert.ok(!demo.text.includes('\n\n'), 'no blank lines (newline collapsing safety)');

  const file = buildBgcode({
    gcode: { text: demo.text, encoding: 1, compression: 2 },
    metadata: demo.metadata,
    thumbnails: [{ format: 0, width: 16, height: 12, data: pngEncode(makeDemoThumbnail(16, 12), 16, 12) }],
    checksum: true,
  });
  const analysis = analyzeBgcode(file);

  assert.equal(analysis.initialTool, 0);
  assert.equal(analysis.totalSwaps, 90);
  assert.deepEqual(analysis.toolsSeen, [0, 1, 2, 3, 4]);
  assert.equal(analysis.layers.length, 180);
  assert.deepEqual(analysis.materials, ['PLA', 'PETG', 'PLA', 'ASA', 'PLA']);
  assert.equal(analysis.totalFilamentG, 87.4);
  assert.equal(analysis.modelName, 'Voron cube x5');
  assert.ok(analysis.totalWasteMm > 900, 'purge waste accumulated: ' + analysis.totalWasteMm);
  assert.ok(analysis.totalWasteG > 0);
  const maxRemaining = Math.max(...analysis.layers.map((l) => l.remainingMin));
  assert.equal(maxRemaining, 240, 'replay duration source (max M73 R) is 240 minutes');
  assert.equal(analysis.timeline.length, 90);
  assert.ok(analysis.timeline.every((e) => e.toolIndex >= 0 && e.toolIndex <= 4));
});
