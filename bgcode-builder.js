/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Added 2026-08-19: synthetic .bgcode fixture and demo builder. This module is
 * the encoding inverse of bgcode.js (container writer, Heatshrink LZSS
 * encoder, MeatPack binarize), which is itself a port of prusa3d/libbgcode.
 * Build/test-time only; server.js never loads it. See NOTICE.md for pinned
 * provenance and third-party license notices.
 */
'use strict';
// Builds Prusa binary G-code (.bgcode) containers that the decoder in
// bgcode.js accepts byte-for-byte, plus deterministic demo fixtures
// (synthetic multitool print, procedural thumbnail, PNG/QOI encoders).
const zlib = require('zlib');

// ---- CRC32 (IEEE 802.3, the polynomial libbgcode uses for block checksums) --
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf, seed = 0) {
  let c = (seed ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- Heatshrink (LZSS) encoder, MSB-first bit order --------------------------
// Inverse of heatshrinkDecode in bgcode.js: 1-bit tag, literals are 8 bits,
// backrefs are (distance-1) in windowSz2 bits + (count-1) in lookaheadSz2 bits.
class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  writeBit(b) {
    this.cur = (this.cur << 1) | (b & 1);
    if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
  }
  writeBits(v, n) { for (let i = n - 1; i >= 0; i--) this.writeBit((v >> i) & 1); }
  finish() {
    if (this.n > 0) this.bytes.push((this.cur << (8 - this.n)) & 0xFF);
    return Buffer.from(this.bytes);
  }
}

function heatshrinkEncode(input, windowSz2, lookaheadSz2) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const n = buf.length;
  const maxDist = 1 << windowSz2;
  const maxLen = 1 << lookaheadSz2;
  // A backref costs 1+windowSz2+lookaheadSz2 bits, a literal 9 bits per byte.
  const minLen = Math.floor((1 + windowSz2 + lookaheadSz2) / 9) + 1;
  const bw = new BitWriter();
  // Hash chains over 2-byte prefixes keep the match search fast; any match the
  // chain finds is valid for the decoder, optimality is irrelevant.
  const HEAD = new Int32Array(65536).fill(-1);
  const PREV = new Int32Array(Math.max(1, n)).fill(-1);
  const insert = (i) => {
    if (i + 1 >= n) return;
    const k = (buf[i] << 8) | buf[i + 1];
    PREV[i] = HEAD[k];
    HEAD[k] = i;
  };
  let o = 0;
  while (o < n) {
    let bestLen = 0, bestPos = -1;
    if (o + 1 < n) {
      let p = HEAD[(buf[o] << 8) | buf[o + 1]];
      const limit = o - maxDist;
      const cap = Math.min(maxLen, n - o);
      let chain = 0;
      while (p >= 0 && p >= limit && chain < 64) {
        let len = 0;
        while (len < cap && buf[p + len] === buf[o + len]) len++;
        if (len > bestLen) {
          bestLen = len; bestPos = p;
          if (len === cap) break;
        }
        p = PREV[p]; chain++;
      }
    }
    if (bestLen >= minLen) {
      bw.writeBit(0);
      bw.writeBits(o - bestPos - 1, windowSz2);
      bw.writeBits(bestLen - 1, lookaheadSz2);
      for (let i = 0; i < bestLen; i++) insert(o + i);
      o += bestLen;
    } else {
      bw.writeBit(1);
      bw.writeBits(buf[o], 8);
      insert(o);
      o += 1;
    }
  }
  return bw.finish();
}

// ---- MeatPack binarize (inverse of MeatPack::unbinarize in bgcode.js) --------
const MP_ENABLE_PACKING = 251;
const MP_ENABLE_NO_SPACES = 247;

// Reverse of the decoder's getChar table. Returns the 4-bit code or -1.
function packNibble(code, noSpaces) {
  if (code >= 48 && code <= 57) return code - 48;         // 0-9
  if (code === 46) return 0xA;                            // .
  if (code === (noSpaces ? 69 : 32)) return 0xB;          // E in no-spaces mode, else space
  if (code === 10) return 0xC;                            // \n
  if (code === 71) return 0xD;                            // G
  if (code === 88) return 0xE;                            // X
  return -1;
}

// Packs text into a MeatPack stream that meatpackUnbinarize decodes back.
// In no-spaces mode every space is stripped (the decoder reinserts spaces on
// G lines before X/Y/Z/E/F/... parameters), so round-trip fidelity requires
// corpus text where spaces appear only in those canonical G-line positions.
function meatpackBinarize(text, { noSpaces = true } = {}) {
  if (typeof text !== 'string') throw new TypeError('meatpackBinarize: text must be a string');
  const codes = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0xFE) throw new Error('meatpackBinarize: unsupported char code ' + c + ' at index ' + i);
    if (noSpaces && c === 32) continue;
    codes.push(c);
  }
  const out = [0xFF, 0xFF, MP_ENABLE_PACKING];
  if (noSpaces) out.push(0xFF, 0xFF, MP_ENABLE_NO_SPACES);
  const n = codes.length;
  let i = 0;
  while (i < n) {
    const a = codes[i];
    const na = packNibble(a, noSpaces);
    const hasB = i + 1 < n;
    const b = hasB ? codes[i + 1] : -1;
    const nb = hasB ? packNibble(b, noSpaces) : -1;
    if (na >= 0) {
      if (a === 10) {
        // The decoder drops the second slot when the first decodes to \n, so a
        // newline in the first slot is padded (0xF = not packed) and the next
        // char starts a fresh pair.
        out.push(0xF0 | na);
        i += 1;
      } else if (!hasB) {
        // Trailing single packable char: mark the second slot not-packed; the
        // stream ends before the decoder ever expects the full byte.
        out.push(0xF0 | na);
        i += 1;
      } else if (nb >= 0) {
        out.push((nb << 4) | na);
        i += 2;
      } else {
        out.push(0xF0 | na, b);
        i += 2;
      }
    } else if (hasB && nb >= 0) {
      // First not packed (0xF low nibble), second packed in the high nibble.
      // The decoder buffers the packed char and emits it after the full byte.
      out.push((nb << 4) | 0x0F, a);
      i += 2;
    } else if (hasB) {
      // Both chars unpackable: 0x0F | 0xF0 is 0xFF, the signal byte. A lone
      // 0xFF followed by a non-0xFF byte is replayed as data by the decoder
      // (cmdCount logic), and both full bytes are ASCII so no 0xFF pair forms.
      out.push(0xFF, a, b);
      i += 2;
    } else {
      out.push(0xFF, a);
      i += 1;
    }
  }
  return Buffer.from(out);
}

// ---- Container writer (inverse of iterBlocks in bgcode.js) -------------------
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }

function serializeBlock(type, compression, uncompressedSize, stored, params, checksumType) {
  const parts = [u16(type), u16(compression), u32(uncompressedSize)];
  if (compression !== 0) parts.push(u32(stored.length));
  parts.push(params, stored);
  const body = Buffer.concat(parts);
  if (checksumType === 0) return body;
  // CRC32 of the block header + parameters + data, appended little-endian,
  // per the libbgcode spec. bgcode.js skips it but external tools may check.
  return Buffer.concat([body, u32(crc32(body))]);
}

// Block types per libbgcode: 0 file metadata, 1 gcode, 2 slicer metadata,
// 3 printer metadata, 4 print metadata, 5 thumbnail.
function buildBgcode({ gcode, metadata = {}, thumbnails = [], checksum = true } = {}) {
  if (!gcode || typeof gcode.text !== 'string') throw new TypeError('buildBgcode: gcode.text is required');
  const encoding = gcode.encoding ?? 0;
  const compression = gcode.compression ?? 0;
  if (encoding !== 0 && encoding !== 1) throw new RangeError('buildBgcode: gcode.encoding must be 0 (none) or 1 (MeatPack)');
  if (compression !== 0 && compression !== 1 && compression !== 2 && compression !== 3) {
    throw new RangeError('buildBgcode: gcode.compression must be 0..3');
  }
  const checksumType = checksum ? 1 : 0;
  const blocks = [];
  const pushMetadata = (type, obj) => {
    if (!obj) return;
    const keys = Object.keys(obj);
    if (!keys.length) return;
    const ini = keys.map((k) => k + '=' + String(obj[k])).join('\n') + '\n';
    const raw = Buffer.from(ini, 'latin1');
    blocks.push(serializeBlock(type, 1, raw.length, zlib.deflateRawSync(raw), u16(0), checksumType));
  };
  pushMetadata(0, metadata.file);
  pushMetadata(3, metadata.printer);
  for (const thumb of thumbnails) {
    if (!thumb || (thumb.format !== 0 && thumb.format !== 1 && thumb.format !== 2)) {
      throw new RangeError('buildBgcode: thumbnail format must be 0 (PNG), 1 (JPG) or 2 (QOI)');
    }
    if (!Number.isInteger(thumb.width) || !Number.isInteger(thumb.height) || thumb.width <= 0 || thumb.height <= 0) {
      throw new RangeError('buildBgcode: thumbnail width/height must be positive integers');
    }
    const data = Buffer.isBuffer(thumb.data) ? thumb.data : Buffer.from(thumb.data);
    const params = Buffer.concat([u16(thumb.format), u16(thumb.width), u16(thumb.height)]);
    blocks.push(serializeBlock(5, 0, data.length, data, params, checksumType));
  }
  pushMetadata(4, metadata.print);
  pushMetadata(2, metadata.slicer);
  const payload = encoding === 1
    ? meatpackBinarize(gcode.text, { noSpaces: gcode.noSpaces !== false })
    : Buffer.from(gcode.text, 'latin1');
  let stored = payload;
  if (compression === 1) stored = zlib.deflateRawSync(payload);
  else if (compression === 2) stored = heatshrinkEncode(payload, 11, 4);
  else if (compression === 3) stored = heatshrinkEncode(payload, 12, 4);
  blocks.push(serializeBlock(1, compression, payload.length, stored, u16(encoding), checksumType));
  return Buffer.concat([Buffer.from('GCDE', 'ascii'), u32(1), u16(checksumType), ...blocks]);
}

// ---- PNG encoder (8-bit RGBA, filter 0 rows, single zlib IDAT) ---------------
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function pngEncode(rgba, width, height) {
  const src = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('pngEncode: width/height must be positive integers');
  }
  if (src.length !== width * height * 4) throw new RangeError('pngEncode: rgba must be width*height*4 bytes');
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter type 0 (None)
    src.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: truecolor with alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- QOI encoder (qoi.h reference behavior, 4 channels, sRGB) ---------------
function qoiEncode(rgba, width, height) {
  const src = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('qoiEncode: width/height must be positive integers');
  }
  if (src.length !== width * height * 4) throw new RangeError('qoiEncode: rgba must be width*height*4 bytes');
  const header = Buffer.alloc(14);
  header.write('qoif', 0, 'ascii');
  header.writeUInt32BE(width, 4);
  header.writeUInt32BE(height, 8);
  header[12] = 4; // channels
  header[13] = 0; // colorspace: sRGB with linear alpha
  const out = [];
  const index = new Int32Array(64); // packed r<<24|g<<16|b<<8|a, init all zero
  let pr = 0, pg = 0, pb = 0, pa = 255;
  let run = 0;
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const r = src[o], g = src[o + 1], b = src[o + 2], a = src[o + 3];
    if (r === pr && g === pg && b === pb && a === pa) {
      run++;
      if (run === 62 || i === total - 1) { out.push(0xC0 | (run - 1)); run = 0; }
      continue;
    }
    if (run > 0) { out.push(0xC0 | (run - 1)); run = 0; }
    const packed = ((r << 24) | (g << 16) | (b << 8) | a) | 0;
    const hash = (r * 3 + g * 5 + b * 7 + a * 11) % 64;
    if (index[hash] === packed) {
      out.push(hash); // QOI_OP_INDEX
    } else {
      index[hash] = packed;
      if (a === pa) {
        const dr = ((r - pr + 128) & 255) - 128;
        const dg = ((g - pg + 128) & 255) - 128;
        const db = ((b - pb + 128) & 255) - 128;
        if (dr > -3 && dr < 2 && dg > -3 && dg < 2 && db > -3 && db < 2) {
          out.push(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2)); // QOI_OP_DIFF
        } else {
          const dgr = ((dr - dg + 128) & 255) - 128;
          const dgb = ((db - dg + 128) & 255) - 128;
          if (dgr > -9 && dgr < 8 && dg > -33 && dg < 32 && dgb > -9 && dgb < 8) {
            out.push(0x80 | (dg + 32), ((dgr + 8) << 4) | (dgb + 8)); // QOI_OP_LUMA
          } else {
            out.push(0xFE, r, g, b); // QOI_OP_RGB
          }
        }
      } else {
        out.push(0xFF, r, g, b, a); // QOI_OP_RGBA
      }
    }
    pr = r; pg = g; pb = b; pa = a;
  }
  return Buffer.concat([header, Buffer.from(out), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]);
}

// ---- Deterministic demo fixtures --------------------------------------------
// Small LCG so fixtures are byte-identical across runs and platforms.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) & 0x7FFFFF;
  };
}

// Procedural thumbnail: vertical gradient backdrop, print bed plate, and a
// layered five-color silhouette (one band per demo tool). Integer math only.
function makeDemoThumbnail(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8) {
    throw new RangeError('makeDemoThumbnail: width/height must be integers >= 8');
  }
  const out = Buffer.alloc(width * height * 4);
  const palette = [
    [228, 88, 58],   // T0 PLA
    [242, 178, 60],  // T1 PETG
    [84, 198, 122],  // T2 PLA
    [72, 140, 228],  // T3 ASA
    [198, 92, 200],  // T4 PLA
  ];
  const yBed = Math.floor((height * 82) / 100);
  const yTop = Math.floor((height * 30) / 100);
  const span = Math.max(1, yBed - yTop);
  const cx = Math.floor(width / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 18 + Math.floor((26 * y) / height);
      let g = 24 + Math.floor((46 * y) / height);
      let b = 46 + Math.floor((72 * y) / height);
      if (y >= yBed && y < yBed + 3) { r = 92; g = 96; b = 104; }
      if (y >= yTop && y < yBed) {
        const halfW = Math.floor((width * 16) / 100) + Math.floor((width * 10 * (y - yTop)) / (100 * span));
        if (Math.abs(x - cx) <= halfW) {
          const band = Math.min(4, Math.floor(((y - yTop) * 5) / span));
          r = palette[band][0]; g = palette[band][1]; b = palette[band][2];
          if ((yBed - y) % 3 === 0) { // layer lines
            r = Math.max(0, r - 34); g = Math.max(0, g - 34); b = Math.max(0, b - 34);
          }
        }
      }
      const o = (y * width + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return out;
}

// Synthetic CORE One INDX-style multitool job: 5 tools, 180 layers, 90 tool
// changes, M73 remaining time descending from 240 minutes, FLUSH/EXCLUDE
// purge blocks. The text is a fixed point of the MeatPack no-spaces round
// trip: non-G lines carry no spaces, G lines carry exactly one space before
// every parameter letter the decoder reinserts spaces for.
function makeDemoPrint() {
  const LAYERS = 180;
  const rand = lcg(0x1A2B3C4D);
  const lines = [];
  lines.push(';LayerRelay-demo:CORE-One-INDX-style-multitool-job');
  lines.push('M73P0R240');
  lines.push('M104S215');
  lines.push('M140S60');
  lines.push('M190S60');
  lines.push('M109S215');
  lines.push('G28 W');
  lines.push('G1 Z5 F5000');
  lines.push('M83');
  lines.push('T0');
  lines.push(';EXCLUDE_E_START');
  lines.push('G1 E2.5 F1800');
  lines.push(';EXCLUDE_E_END');
  let tool = 0;
  for (let layer = 0; layer < LAYERS; layer++) {
    const p = Math.floor((layer * 100) / LAYERS);
    const r = 240 - Math.floor((layer * 240) / LAYERS);
    const z = (0.2 + layer * 0.2).toFixed(2);
    lines.push('M73P' + p + 'R' + r);
    lines.push(';LAYER_CHANGE');
    lines.push(';Z:' + z);
    lines.push('G1 Z' + z + ' F720');
    lines.push('G92 E0');
    if (layer % 2 === 1) {
      tool = (tool + 1 + (rand() % 4)) % 5;
      lines.push('T' + tool);
      const flush = 8 + (rand() % 70) / 10;
      const prime = 1.5 + (rand() % 15) / 10;
      lines.push(';FLUSH_START');
      lines.push('G1 E' + flush.toFixed(2) + ' F2400');
      lines.push('G1 E-0.8 F2100');
      lines.push(';FLUSH_END');
      lines.push(';EXCLUDE_E_START');
      lines.push('G1 E' + prime.toFixed(2) + ' F1800');
      lines.push(';EXCLUDE_E_END');
    }
    for (let m = 0; m < 10; m++) {
      const x = (9000 + (rand() % 12000)) / 100;
      const y = (9000 + (rand() % 10000)) / 100;
      const e = (5 + (rand() % 300)) / 100;
      if (m === 0) lines.push('G1 X' + x.toFixed(2) + ' Y' + y.toFixed(2) + ' F9000');
      else lines.push('G1 X' + x.toFixed(2) + ' Y' + y.toFixed(2) + ' E' + e.toFixed(3));
    }
  }
  lines.push('M73P100R0');
  lines.push('M104S0');
  lines.push('M140S0');
  lines.push('M84');
  lines.push(';demo-end');
  const text = lines.join('\n') + '\n';
  const metadata = {
    file: { Producer: 'LayerRelay demo builder 1.0' },
    printer: {
      printer_model: 'COREONE',
      nozzle_diameter: '0.4;0.4;0.4;0.4;0.4',
    },
    print: {
      'total filament used [g]': '87.4',
      'estimated printing time (normal mode)': '4h 0m 0s',
    },
    slicer: {
      filament_type: 'PLA;PETG;PLA;ASA;PLA',
      filament_diameter: '1.75',
      filament_density: '1.24',
      objects_info: '{"objects":[{"name":"Voron cube x5"}]}',
    },
  };
  return { text, metadata, name: 'Voron cube x5' };
}

module.exports = {
  buildBgcode,
  heatshrinkEncode,
  meatpackBinarize,
  pngEncode,
  qoiEncode,
  makeDemoPrint,
  makeDemoThumbnail,
  crc32,
};
