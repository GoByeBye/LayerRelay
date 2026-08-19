/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Browser ESM port of the repository root bgcode.js, itself a
 * JavaScript/Node.js adaptation of portions of prusa3d/libbgcode, including
 * its binary G-code specification and MeatPack::unbinarize behavior. See
 * NOTICE.md for pinned provenance and third-party license notices.
 *
 * Decode logic is kept identical to bgcode.js. Only the platform pieces
 * differ: Buffer reads become Uint8Array/DataView, zlib inflate becomes
 * DecompressionStream (which makes the decode entry points async), and
 * thumbnail extraction is added for the static dashboard.
 */
// Pure-JS Prusa binary G-code (.bgcode) decoder.
// Container iteration + Heatshrink (11/4, 12/4) decompression + MeatPack unbinarize.
// Ported from prusa3d/libbgcode (doc/specifications.md and binarize/meatpack.cpp).
// This combined project is distributed under AGPL-3.0-or-later; see LICENSE and NOTICE.md.

// ---- Heatshrink (LZSS) decoder, MSB-first bit order --------------------------
class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; this.bit = 0; }
  getBit() {
    if (this.pos >= this.buf.length) return -1;
    const b = (this.buf[this.pos] >> (7 - this.bit)) & 1;
    if (++this.bit === 8) { this.bit = 0; this.pos++; }
    return b;
  }
  getBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const b = this.getBit();
      if (b < 0) return -1;
      v = (v << 1) | b;
    }
    return v;
  }
}

function heatshrinkDecode(src, outLen, windowSz2, lookaheadSz2) {
  const mask = (1 << windowSz2) - 1;
  const window = new Uint8Array(1 << windowSz2);
  const out = new Uint8Array(outLen);
  const br = new BitReader(src);
  let head = 0, o = 0;
  while (o < outLen) {
    const tag = br.getBit();
    if (tag < 0) break;
    if (tag === 1) {
      const c = br.getBits(8);
      if (c < 0) break;
      out[o++] = c; window[head++ & mask] = c;
    } else {
      let idx = br.getBits(windowSz2);
      if (idx < 0) break;
      idx += 1;
      let cnt = br.getBits(lookaheadSz2);
      if (cnt < 0) break;
      cnt += 1;
      for (let i = 0; i < cnt && o < outLen; i++) {
        const c = window[(head - idx) & mask];
        out[o++] = c; window[head++ & mask] = c;
      }
    }
  }
  return out.subarray(0, o);
}

// ---- MeatPack unbinarize (verbatim port of MeatPack::unbinarize) -------------
const Cmd = { EnablePacking: 251, DisablePacking: 250, ResetAll: 249, QueryConfig: 248, EnableNoSpaces: 247, DisableNoSpaces: 246, Signal: 0xFF };
const FirstNotPacked = 0x0F, SecondNotPacked = 0xF0;
const NextPackedFirst = 0x01, NextPackedSecond = 0x02;
const GLINE_PARAMS = new Set('XYZEFIJRSGPWHCA'.split('').map((c) => c.charCodeAt(0)));
const NL = 10, SP = 32, G = 71;

function meatpackUnbinarize(src) {
  let unbinarizing = false, nospace = false, cmdActive = false, cmdCount = 0;
  let charBuf = 0, fullCharQueue = 0;
  const outBuf = [];              // char codes for the current unpack step (0..2)
  const result = [];             // final char codes
  let addSpace = false;

  const getChar = (c) => {
    switch (c) {
      case 0x0: return 48; case 0x1: return 49; case 0x2: return 50; case 0x3: return 51;
      case 0x4: return 52; case 0x5: return 53; case 0x6: return 54; case 0x7: return 55;
      case 0x8: return 56; case 0x9: return 57; case 0xA: return 46 /* . */;
      case 0xB: return nospace ? 69 /* E */ : 32 /* space */;
      case 0xC: return 10 /* newline */; case 0xD: return 71 /* G */; case 0xE: return 88 /* X */;
    }
    return 0;
  };

  const unpackChars = (pk, chars) => {
    let out = 0;
    if ((pk & FirstNotPacked) === FirstNotPacked) out |= NextPackedFirst;
    else chars[0] = getChar(pk & 0xF);
    if ((pk & SecondNotPacked) === SecondNotPacked) out |= NextPackedSecond;
    else chars[1] = getChar((pk >> 4) & 0xF);
    return out;
  };

  const handleRxChar = (c) => {
    if (unbinarizing) {
      if (fullCharQueue > 0) {
        outBuf.push(c);
        if (charBuf > 0) { outBuf.push(charBuf); charBuf = 0; }
        --fullCharQueue;
      } else {
        const buf = [0, 0];
        const res = unpackChars(c, buf);
        if ((res & NextPackedFirst) !== 0) {
          ++fullCharQueue;
          if ((res & NextPackedSecond) !== 0) ++fullCharQueue;
          else charBuf = buf[1];
        } else {
          outBuf.push(buf[0]);
          if (buf[0] !== NL) {
            if ((res & NextPackedSecond) !== 0) ++fullCharQueue;
            else outBuf.push(buf[1]);
          }
        }
      }
    } else {
      outBuf.push(c);
    }
  };

  const emit = (ch) => {
    const prev = result.length ? result[result.length - 1] : -1;
    let newLine = false;
    if (ch === G && (result.length === 0 || prev === NL)) { addSpace = true; newLine = true; }
    else if (ch === NL) addSpace = false;
    if (!newLine && addSpace && (result.length === 0 || result[result.length - 1] !== SP) && GLINE_PARAMS.has(ch)) {
      result.push(SP);
    }
    // Collapse consecutive newlines (matches reference).
    if (ch !== NL || result.length === 0 || result[result.length - 1] !== NL) result.push(ch);
  };

  for (let i = 0; i < src.length; i++) {
    const cBin = src[i];
    if (cBin === Cmd.Signal) {
      if (cmdCount > 0) { cmdActive = true; cmdCount = 0; }
      else ++cmdCount;
    } else {
      if (cmdActive) {
        switch (cBin) {
          case Cmd.EnablePacking: unbinarizing = true; break;
          case Cmd.DisablePacking: unbinarizing = false; break;
          case Cmd.EnableNoSpaces: nospace = true; break;
          case Cmd.DisableNoSpaces: nospace = false; break;
          case Cmd.ResetAll: unbinarizing = false; break;
          default: break; // QueryConfig / unknown
        }
        cmdActive = false;
      } else {
        if (cmdCount > 0) { handleRxChar(Cmd.Signal); cmdCount = 0; }
        handleRxChar(cBin);
      }
    }
    // Flush any chars produced by this input byte through the space-reinsertion stage.
    for (let k = 0; k < outBuf.length; k++) emit(outBuf[k]);
    outBuf.length = 0;
  }

  // Build string from char codes in chunks (avoid arg-count limits).
  let s = '';
  for (let i = 0; i < result.length; i += 8192) {
    s += String.fromCharCode.apply(null, result.slice(i, i + 8192));
  }
  return s;
}

// ---- Platform shims ----------------------------------------------------------
// Node Buffer 'latin1' is the ISO-8859-1 identity mapping (byte N is char N).
// TextDecoder('latin1') is NOT: the WHATWG spec maps that label to
// windows-1252, which differs in 0x80..0x9F. Chunked String.fromCharCode
// keeps byte-exact parity with the root decoder.
function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return s;
}

async function inflateWith(data, format) {
  const stream = new DecompressionStream(format);
  const writer = stream.writable.getWriter();
  const writing = writer.write(data).then(() => writer.close());
  writing.catch(() => {}); // errors surface through the reader below
  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await writing;
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---- Container ---------------------------------------------------------------
async function decompressBlockData(blk) {
  switch (blk.compression) {
    case 0: return blk.data;
    case 1: // Deflate: raw first, zlib-wrapped second (same fallback order as bgcode.js).
      try { return await inflateWith(blk.data, 'deflate-raw'); }
      catch { return inflateWith(blk.data, 'deflate'); }
    case 2: return heatshrinkDecode(blk.data, blk.uncompressedSize, 11, 4);
    case 3: return heatshrinkDecode(blk.data, blk.uncompressedSize, 12, 4);
    default: throw new Error('unknown bgcode compression ' + blk.compression);
  }
}

export function isBgcode(u8) {
  return !!u8 && u8.length >= 4 &&
    u8[0] === 0x47 && u8[1] === 0x43 && u8[2] === 0x44 && u8[3] === 0x45; // 'GCDE'
}

function* iterBlocks(buf) {
  if (!isBgcode(buf)) throw new Error('not a bgcode file (bad magic)');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const checksumType = dv.getUint16(8, true);
  let off = 10;
  while (off + 8 <= buf.length) {
    const type = dv.getUint16(off, true);
    const compression = dv.getUint16(off + 2, true);
    const uncompressedSize = dv.getUint32(off + 4, true);
    let p = off + 8;
    let compressedSize = uncompressedSize;
    if (compression !== 0) { compressedSize = dv.getUint32(p, true); p += 4; }
    const paramSize = type === 5 ? 6 : 2; // Thumbnail=6, else Encoding u16=2
    // First param u16: block encoding, or the image format for thumbnails.
    const encoding = dv.getUint16(p, true);
    let width = 0, height = 0;
    // The root decoder never reads past the first parameter word, so a file
    // truncated inside a thumbnail's parameter area stops iteration there
    // instead of failing. Only read the extra fields when they are present.
    if (type === 5 && p + paramSize <= buf.length) {
      width = dv.getUint16(p + 2, true);
      height = dv.getUint16(p + 4, true);
    }
    p += paramSize;
    const dataSize = compression !== 0 ? compressedSize : uncompressedSize;
    if (p + dataSize > buf.length) break;
    const data = buf.subarray(p, p + dataSize);
    p += dataSize;
    if (checksumType !== 0) p += 4; // CRC32 (not verified; sizes drive iteration)
    yield { type, compression, uncompressedSize, encoding, data, width, height };
    off = p;
  }
}

// Return the full ASCII G-code text of all GCode blocks concatenated.
export async function decodeGcodeText(fileBuf) {
  let text = '';
  for (const blk of iterBlocks(fileBuf)) {
    if (blk.type !== 1) continue; // 1 = GCode
    const raw = await decompressBlockData(blk);
    // encoding: 0 none, 1 MeatPack, 2 MeatPackComments
    text += blk.encoding === 0 ? latin1(raw) : meatpackUnbinarize(raw);
  }
  return text;
}

// Return plaintext key=value metadata (FileMetadata/PrinterMetadata/etc, INI encoded).
export async function decodeMetadata(fileBuf) {
  const meta = {};
  for (const blk of iterBlocks(fileBuf)) {
    if (blk.type === 1 || blk.type === 5) continue; // skip gcode + thumbnails
    const raw = latin1(await decompressBlockData(blk));
    for (const line of raw.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) meta[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return meta;
}

// Thumbnail (type 5) blocks carry a 6-byte parameter area: format u16,
// width u16, height u16 (libbgcode doc/specifications.md; 0=PNG 1=JPG 2=QOI).
// The root decoder skips them; the static dashboard needs the images.
const THUMBNAIL_FORMATS = ['png', 'jpg', 'qoi'];

export async function extractThumbnails(fileBuf) {
  const thumbnails = [];
  for (const blk of iterBlocks(fileBuf)) {
    if (blk.type !== 5) continue;
    const format = THUMBNAIL_FORMATS[blk.encoding];
    if (!format) continue; // unknown format id: skip rather than mislabel
    const data = await decompressBlockData(blk); // usually compression 0, but honor the field
    thumbnails.push({ format, width: blk.width, height: blk.height, data });
  }
  return thumbnails;
}
