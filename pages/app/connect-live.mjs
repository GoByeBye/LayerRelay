/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Prusa Connect MQTT telemetry mapped onto the /api/state field names the
 * dashboard and overlay already read. Cloud mode feeds every retained and
 * live topic through apply() and renders from snapshot().
 */
// Browser ESM. Pure: no I/O, no timers, no Node APIs. The caller owns the
// MQTT link, the reconnect policy, and everything the file analysis fills in.

// Ported from prusaconnect.js rather than imported: that module is CommonJS
// and Node bound. Keep the vocabulary identical so cloud mode and server mode
// hand the overlay the same state strings.
export const CONNECT_STATE_MAP = Object.freeze({
  PRINTING: 'PRINTING', PAUSED: 'PAUSED', PAUSING: 'PRINTING', RESUMING: 'PRINTING',
  FINISHED: 'FINISHED', STOPPED: 'IDLE', IDLE: 'IDLE', READY: 'IDLE',
  ATTENTION: 'ERROR', ERROR: 'ERROR',
});

// Only the OPERATION label is reachable here: MQTT publishes a dialog with
// free text, never the operation kinds prusaconnect.js classifies from the
// Connect REST job payload, so the kind stays pinned and the dialog wording
// travels in detail exactly as it does in server mode.
const OPERATION_LABEL = 'Printer busy';

const TOPIC_PREFIX = /^v1\/devices\/printers\/[^/]+\//;
const JOB_TOPIC = /^jobs\/([^/]{1,64})\/data\/(progress|state|time-remaining)$/;
const TOOL_TEMP_TOPIC = /^data\/tools\/([0-9]{1,3})\/temp\/nozzle\/(current|target)$/;

const MAX_TOOL_LABEL = 32;
const MAX_JOB_SLOTS = 8;
const MAX_JOB_KEY_LENGTH = 64;
const MAX_MATERIAL_LENGTH = 80;
const MAX_ACTIVITY_LENGTH = 160;
const MAX_STATE_LENGTH = 40;

let sharedDecoder = null;

// The MQTT client hands over decoded strings, but accept raw bytes too so a
// different transport cannot silently drop every payload.
function decodePayload(payload) {
  if (typeof payload === 'string') return payload;
  if (payload == null) return null;
  let bytes = null;
  if (payload instanceof Uint8Array) bytes = payload;
  else if (typeof ArrayBuffer === 'function' && payload instanceof ArrayBuffer) {
    bytes = new Uint8Array(payload);
  } else if (typeof ArrayBuffer === 'function' && ArrayBuffer.isView(payload)) {
    bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (!bytes || typeof TextDecoder !== 'function') return null;
  try {
    if (!sharedDecoder) sharedDecoder = new TextDecoder();
    return sharedDecoder.decode(bytes);
  } catch { return null; }
}

function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

// Empty and non-finite payloads are rejected rather than coerced: Number('')
// is 0 and Number('Infinity') passes a naive truthiness check, and either
// would publish a fabricated reading to the overlay.
function parseNumber(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function parsePercent(value) {
  const number = parseNumber(value);
  if (number == null) return null;
  return Math.max(0, Math.min(100, number));
}

function parseBoolean(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  const number = parseNumber(text);
  return number == null ? null : number !== 0;
}

// Mirrors normalizeConnectMaterial: a blank or '---' payload is the printer
// reporting no filament, which is a real value and clears the field.
function parseMaterial(value) {
  const text = cleanText(value, MAX_MATERIAL_LENGTH);
  return !text || text === '---' ? null : text;
}

// Ported normalizePrinterState semantics for the vocabulary MQTT publishes.
// The REST-only activity promotion is not ported: it reads Connect job
// objects that do not exist on this transport. BUSY still splits on job
// identity, which here is the presence of a current job id.
export function normalizeConnectState(rawState, hasJob = false) {
  const raw = cleanText(rawState, MAX_STATE_LENGTH).toUpperCase();
  if (!raw) return null;
  if (raw === 'BUSY') return hasJob ? 'PRINTING' : 'BUSY';
  return CONNECT_STATE_MAP[raw] || 'UNKNOWN';
}

export function createConnectState(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let rawPrinterState = null;
  let online = null;
  let material = null;
  let axisZ = null;
  let printerProgress = null;
  let currentJobKey = null;
  let toolLabel = null;
  let currentTool = null;
  let nozzleTemp = null;
  let nozzleTarget = null;
  let bedTemp = null;
  let bedTarget = null;
  let chamberTemp = null;
  let activity = null;
  let lastMessageAt = null;

  // Per-job buffers, not a write-time filter. All 16 topics are retained and
  // arrive in arbitrary order on subscribe, so jobs/650/... can land before
  // data/current-job says 650. Buffering by job id lets a later current-job
  // select the right values retroactively, while a previous job's retained
  // values sit in their own slot and are never read.
  const jobs = new Map();
  const toolTemps = new Map();
  const seenTopics = new Set();

  function jobSlot(key) {
    let entry = jobs.get(key);
    if (!entry) {
      entry = { progress: null, state: null, timeRemainingSec: null };
      jobs.set(key, entry);
      if (jobs.size > MAX_JOB_SLOTS) {
        for (const existing of jobs.keys()) {
          if (existing !== key && existing !== currentJobKey) {
            jobs.delete(existing);
            break;
          }
        }
      }
    }
    return entry;
  }

  function applyJobTopic(match, text) {
    const key = match[1].trim();
    if (!key) return false;
    const entry = jobSlot(key);
    if (match[2] === 'progress') {
      const value = parsePercent(text);
      if (value == null) return false;
      entry.progress = value;
      return true;
    }
    if (match[2] === 'state') {
      const value = cleanText(text, MAX_STATE_LENGTH);
      if (!value) return false;
      entry.state = value;
      return true;
    }
    // time-remaining is published in SECONDS, verified against the live tree.
    const seconds = parseNumber(text);
    if (seconds == null) return false;
    entry.timeRemainingSec = Math.max(0, seconds);
    return true;
  }

  // data/tools/active is 1-BASED: a payload of 3 was cross-checked against the
  // server's own /api/state reporting toolLabel 3 and currentTool 2 at the
  // same instant. 0 means no active tool, matching numericActiveTool in
  // prusaconnect.js, which also bounds the value to 0..32 and treats anything
  // outside that range as no update at all.
  function applyActiveTool(text) {
    const value = parseNumber(text);
    if (value == null || !Number.isInteger(value) || value < 0 || value > MAX_TOOL_LABEL) {
      return false;
    }
    toolLabel = value === 0 ? null : value;
    currentTool = value === 0 ? null : value - 1;
    return true;
  }

  function applyToolTemp(match, text) {
    const value = parseNumber(text);
    if (value == null) return false;
    let entry = toolTemps.get(match[1]);
    if (!entry) {
      entry = { nozzleTemp: null, nozzleTarget: null };
      toolTemps.set(match[1], entry);
    }
    if (match[2] === 'current') entry.nozzleTemp = value;
    else entry.nozzleTarget = value;
    return true;
  }

  // The only JSON payload in the tree. Invalid JSON leaves the previous
  // activity standing; valid JSON that is not an object clears it.
  function applyDialog(text) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return false; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      activity = null;
      return true;
    }
    const detail = cleanText(parsed.title, MAX_ACTIVITY_LENGTH) ||
      cleanText(parsed.text, MAX_ACTIVITY_LENGTH);
    activity = detail
      ? { active: true, kind: 'OPERATION', label: OPERATION_LABEL, detail, progress: null }
      : null;
    return true;
  }

  function route(name, text) {
    switch (name) {
      case 'data/state': {
        const value = cleanText(text, MAX_STATE_LENGTH);
        if (!value) return false;
        rawPrinterState = value;
        return true;
      }
      case 'data/online': {
        const value = parseBoolean(text);
        if (value == null) return false;
        online = value;
        return true;
      }
      case 'data/job-progress': {
        const value = parsePercent(text);
        if (value == null) return false;
        printerProgress = value;
        return true;
      }
      case 'data/current-job': {
        const key = text.trim().slice(0, MAX_JOB_KEY_LENGTH);
        if (!key) return false;
        currentJobKey = key;
        return true;
      }
      case 'data/material':
        material = parseMaterial(text);
        return true;
      case 'data/axis-z': {
        const value = parseNumber(text);
        if (value == null) return false;
        axisZ = value;
        return true;
      }
      case 'data/tools/active':
        return applyActiveTool(text);
      case 'data/temp/nozzle/current': {
        const value = parseNumber(text);
        if (value == null) return false;
        nozzleTemp = value;
        return true;
      }
      case 'data/temp/nozzle/target': {
        const value = parseNumber(text);
        if (value == null) return false;
        nozzleTarget = value;
        return true;
      }
      case 'data/temp/heatbed/current': {
        const value = parseNumber(text);
        if (value == null) return false;
        bedTemp = value;
        return true;
      }
      case 'data/temp/heatbed/target': {
        const value = parseNumber(text);
        if (value == null) return false;
        bedTarget = value;
        return true;
      }
      case 'data/temp/chamber/current': {
        const value = parseNumber(text);
        if (value == null) return false;
        chamberTemp = value;
        return true;
      }
      case 'dialog':
        return applyDialog(text);
      default:
        break;
    }
    const jobMatch = JOB_TOPIC.exec(name);
    if (jobMatch) return applyJobTopic(jobMatch, text);
    const toolMatch = TOOL_TEMP_TOPIC.exec(name);
    if (toolMatch) return applyToolTemp(toolMatch, text);
    return false;
  }

  // Accepts either the full broker topic or the per-printer suffix, so the
  // caller can forward messages without knowing whether it already stripped
  // the subscription prefix.
  function apply(topic, payload) {
    if (typeof topic !== 'string') return false;
    const name = topic.trim().replace(/^\/+/, '').replace(TOPIC_PREFIX, '');
    if (!name) return false;
    // Any message at all proves the link is alive, even an unmapped topic.
    lastMessageAt = now();
    const text = decodePayload(payload);
    if (text == null) return false;
    const applied = route(name, text);
    if (applied) seenTopics.add(name);
    return applied;
  }

  function jobIdNumber() {
    if (currentJobKey == null) return null;
    const value = Number(currentJobKey);
    return Number.isFinite(value) ? value : null;
  }

  function toolTempsView() {
    const view = {};
    for (const [key, entry] of toolTemps) {
      view[key] = { nozzleTemp: entry.nozzleTemp, nozzleTarget: entry.nozzleTarget };
    }
    return view;
  }

  function snapshot() {
    const job = currentJobKey != null ? jobs.get(currentJobKey) || null : null;
    return {
      state: normalizeConnectState(rawPrinterState, currentJobKey != null),
      online,
      // A live job's own progress wins; data/job-progress is the fallback.
      progress: job && job.progress != null ? job.progress : printerProgress,
      timeRemainingSec: job ? job.timeRemainingSec : null,
      jobState: job ? normalizeConnectState(job.state, true) : null,
      jobId: jobIdNumber(),
      material,
      axisZ,
      currentTool,
      toolLabel,
      nozzleTemp,
      nozzleTarget,
      bedTemp,
      bedTarget,
      chamberTemp,
      // No chamber target is published anywhere in the tree.
      chamberTarget: null,
      activity: activity ? { ...activity } : null,
      toolTemps: toolTempsView(),
      lastMessageAt,
      topicCount: seenTopics.size,
      // No MQTT source exists for these. The engine fills what it can from a
      // decoded file; without one the overlay degrades to blanks.
      name: null,
      thumbnailUrl: null,
      speed: null,
      flow: null,
      fanHotend: null,
      timeElapsedSec: null,
      filamentG: null,
    };
  }

  function reset() {
    rawPrinterState = null;
    online = null;
    material = null;
    axisZ = null;
    printerProgress = null;
    currentJobKey = null;
    toolLabel = null;
    currentTool = null;
    nozzleTemp = null;
    nozzleTarget = null;
    bedTemp = null;
    bedTarget = null;
    chamberTemp = null;
    activity = null;
    lastMessageAt = null;
    jobs.clear();
    toolTemps.clear();
    seenTopics.clear();
  }

  return {
    apply,
    snapshot,
    reset,
    get jobId() { return jobIdNumber(); },
  };
}
