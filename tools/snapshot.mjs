#!/usr/bin/env bun
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const [requestedOutput, requestedUrl] = process.argv.slice(2);
if (!requestedOutput) {
  console.error('usage: snapshot.mjs <out.jpg> [rtspUrl]');
  process.exit(2);
}

let config = {};
if (!requestedUrl) {
  try { config = require('../config.js').loadRuntimeConfig().config; }
  catch (error) {
    console.error(`FAILED: ${error.message}`);
    process.exit(1);
  }
}

const cameraUrl = String(requestedUrl || process.env.CAMERA_RTSP_URL || config.cameraRtspUrl || '').trim();
let parsedUrl;
try { parsedUrl = new URL(cameraUrl); }
catch { /* Report one credential-safe error below. */ }
if (!parsedUrl || (parsedUrl.protocol !== 'rtsp:' && parsedUrl.protocol !== 'rtsps:')) {
  console.error('FAILED: provide an rtsp:// URL or configure cameraRtspUrl');
  process.exit(1);
}

const output = path.resolve(requestedOutput);
fs.mkdirSync(path.dirname(output), { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH || config.cameraFfmpegPath || 'ffmpeg';
const result = spawnSync(ffmpeg, [
  '-y',
  '-loglevel', 'error',
  '-rtsp_transport', 'tcp',
  '-i', cameraUrl,
  '-frames:v', '1',
  output,
], {
  stdio: 'inherit',
  timeout: 30000,
  windowsHide: true,
});

if (result.error) {
  console.error(`FAILED: FFmpeg could not capture a frame (${result.error.code || result.error.message})`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`FAILED: FFmpeg exited with status ${result.status}`);
  process.exit(1);
}

let stat;
try { stat = fs.statSync(output); } catch { /* handled below */ }
if (!stat || !stat.isFile() || stat.size === 0) {
  console.error('FAILED: FFmpeg did not create a non-empty image');
  process.exit(1);
}
console.log(`OK snapshot -> ${output}`);
