'use strict';
// Pure-JS Prusa binary G-code (.bgcode) decoder.
// Container iteration + Heatshrink (11/4, 12/4) decompression + MeatPack unbinarize.
// Ported from prusa3d/libbgcode (specifications.md, binarize/meatpack.cpp) verified this session.
const zlib = require('zlib');

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
  const window = Buffer.alloc(1 << windowSz2);
  const out = Buffer.alloc(outLen);
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
      case 0xC: return 10 /* \n */; case 0xD: return 71 /* G */; case 0xE: return 88 /* X */;
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

// ---- Container ---------------------------------------------------------------
function decompressBlockData(blk) {
  switch (blk.compression) {
    case 0: return blk.data;
    case 1: // Deflate
      try { return zlib.inflateRawSync(blk.data); } catch { return zlib.inflateSync(blk.data); }
    case 2: return heatshrinkDecode(blk.data, blk.uncompressedSize, 11, 4);
    case 3: return heatshrinkDecode(blk.data, blk.uncompressedSize, 12, 4);
    default: throw new Error('unknown bgcode compression ' + blk.compression);
  }
}

function* iterBlocks(buf) {
  if (buf.toString('ascii', 0, 4) !== 'GCDE') throw new Error('not a bgcode file (bad magic)');
  const checksumType = buf.readUInt16LE(8);
  let off = 10;
  while (off + 8 <= buf.length) {
    const type = buf.readUInt16LE(off);
    const compression = buf.readUInt16LE(off + 2);
    const uncompressedSize = buf.readUInt32LE(off + 4);
    let p = off + 8;
    let compressedSize = uncompressedSize;
    if (compression !== 0) { compressedSize = buf.readUInt32LE(p); p += 4; }
    const paramSize = type === 5 ? 6 : 2; // Thumbnail=6, else Encoding u16=2
    const encoding = buf.readUInt16LE(p);
    p += paramSize;
    const dataSize = compression !== 0 ? compressedSize : uncompressedSize;
    if (p + dataSize > buf.length) break;
    const data = buf.subarray(p, p + dataSize);
    p += dataSize;
    if (checksumType !== 0) p += 4; // CRC32 (not verified; sizes drive iteration)
    yield { type, compression, uncompressedSize, encoding, data };
    off = p;
  }
}

// Return the full ASCII G-code text of all GCode blocks concatenated.
function decodeGcodeText(fileBuf) {
  let text = '';
  for (const blk of iterBlocks(fileBuf)) {
    if (blk.type !== 1) continue; // 1 = GCode
    const raw = decompressBlockData(blk);
    // encoding: 0 none, 1 MeatPack, 2 MeatPackComments
    text += blk.encoding === 0 ? raw.toString('latin1') : meatpackUnbinarize(raw);
  }
  return text;
}

// Return plaintext key=value metadata (FileMetadata/PrinterMetadata/etc, INI encoded).
function decodeMetadata(fileBuf) {
  const meta = {};
  for (const blk of iterBlocks(fileBuf)) {
    if (blk.type === 1 || blk.type === 5) continue; // skip gcode + thumbnails
    const raw = decompressBlockData(blk).toString('latin1');
    for (const line of raw.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) meta[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return meta;
}

module.exports = { decodeGcodeText, decodeMetadata };
