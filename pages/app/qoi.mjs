/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * QOI (Quite OK Image) decoder for thumbnails embedded in Prusa .bgcode
 * files. Implements the qoiformat.org specification: 14-byte header with
 * 'qoif' magic and big-endian dimensions, chunk ops RGB / RGBA / INDEX /
 * DIFF / LUMA / RUN, and an 8-byte end marker. Browsers have no native QOI
 * support, so QOI thumbnails are decoded to RGBA and drawn to a canvas.
 */

const OP_RGB = 0xfe;
const OP_RGBA = 0xff;
// 2-bit tags in the top bits of the chunk byte.
const TAG_INDEX = 0;
const TAG_DIFF = 1;
const TAG_LUMA = 2;

// Decode a QOI byte stream to { width, height, rgba }. Output is always
// 4 channels regardless of the header's channel count, matching the
// reference decoder. Throws on bad magic, bad header, or truncation.
export function decodeQoi(u8) {
  if (!u8 || typeof u8.length !== 'number' || u8.length < 22) {
    // 14-byte header + at least the 8-byte end marker.
    throw new Error('qoi: truncated file');
  }
  if (u8[0] !== 0x71 || u8[1] !== 0x6f || u8[2] !== 0x69 || u8[3] !== 0x66) {
    throw new Error('qoi: bad magic');
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const width = dv.getUint32(4, false);   // big-endian per spec
  const height = dv.getUint32(8, false);
  const channels = u8[12];
  const colorspace = u8[13];
  if (!width || !height) throw new Error('qoi: invalid dimensions');
  if (channels !== 3 && channels !== 4) throw new Error('qoi: invalid channel count ' + channels);
  if (colorspace > 1) throw new Error('qoi: invalid colorspace ' + colorspace);

  const pixelCount = width * height;
  const rgba = new Uint8Array(pixelCount * 4);
  const index = new Uint8Array(64 * 4); // 64-entry running color index
  let r = 0, g = 0, b = 0, a = 255;     // spec start pixel
  let p = 14;
  const end = u8.length - 8;            // chunks stop before the end marker
  let run = 0;

  for (let i = 0; i < pixelCount; i++) {
    if (run > 0) {
      run--;
    } else {
      if (p >= end) throw new Error('qoi: truncated stream');
      const b1 = u8[p++];
      if (b1 === OP_RGB) {
        if (p + 3 > end) throw new Error('qoi: truncated stream');
        r = u8[p++]; g = u8[p++]; b = u8[p++];
      } else if (b1 === OP_RGBA) {
        if (p + 4 > end) throw new Error('qoi: truncated stream');
        r = u8[p++]; g = u8[p++]; b = u8[p++]; a = u8[p++];
      } else {
        const tag = b1 >> 6;
        if (tag === TAG_INDEX) {
          const j = (b1 & 0x3f) * 4;
          r = index[j]; g = index[j + 1]; b = index[j + 2]; a = index[j + 3];
        } else if (tag === TAG_DIFF) {
          // Channel diffs, 2 bits each, bias 2, with wraparound.
          r = (r + ((b1 >> 4) & 0x03) - 2) & 0xff;
          g = (g + ((b1 >> 2) & 0x03) - 2) & 0xff;
          b = (b + (b1 & 0x03) - 2) & 0xff;
        } else if (tag === TAG_LUMA) {
          if (p >= end) throw new Error('qoi: truncated stream');
          const b2 = u8[p++];
          const dg = (b1 & 0x3f) - 32; // green diff, 6 bits, bias 32
          r = (r + dg - 8 + ((b2 >> 4) & 0x0f)) & 0xff;
          g = (g + dg) & 0xff;
          b = (b + dg - 8 + (b2 & 0x0f)) & 0xff;
        } else {
          run = b1 & 0x3f; // TAG_RUN: bias -1, so this many MORE pixels
        }
      }
      // The reference decoder refreshes the index after every chunk read
      // (including RUN chunks, which rewrite the current pixel's slot).
      const h = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
      index[h] = r; index[h + 1] = g; index[h + 2] = b; index[h + 3] = a;
    }
    const o = i * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
  }
  return { width, height, rgba };
}
