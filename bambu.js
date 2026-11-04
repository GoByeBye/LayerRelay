'use strict';

const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');

const MAX_REPORT_BYTES = 1024 * 1024;
const JOB_FIELDS = new Set(['gcode_state', 'mc_percent', 'mc_remaining_time', 'layer_num',
  'total_layer_num', 'subtask_name', 'gcode_file', 'task_id', 'job_id', 'project_id',
  'subtask_id', 'profile_id', 'gcode_start_time']);
const PRINT_FIELDS = new Set([...JOB_FIELDS, 'nozzle_temper', 'nozzle_target_temper',
  'bed_temper', 'bed_target_temper', 'chamber_temper', 'ctt', 'spd_mag', 'ams', 'vt_tray', 'device']);
const ACTIVE_STATES = new Set(['RUNNING', 'PAUSE', 'PREPARE']);

function object(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function number(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function text(value, maximum = 256) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximum);
}

function meaningfulId(value) {
  const result = text(value);
  return result && result !== '0' ? result : '';
}

function pickScalars(value, fields) {
  if (!object(value)) return {};
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(value, key)).map((key) => {
    const scalar = value[key];
    return [key, typeof scalar === 'string' ? text(scalar) :
      typeof scalar === 'number' || scalar == null ? scalar : null];
  }));
}

function selectReport(value) {
  const selected = pickScalars(value, [...PRINT_FIELDS].filter((key) => !['ams', 'vt_tray', 'device'].includes(key)));
  if (Object.hasOwn(value, 'msg')) selected.msg = value.msg;
  if (Object.hasOwn(value, 'vt_tray')) selected.vt_tray = value.vt_tray === null ? null : pickScalars(value.vt_tray, ['tray_type', 'tray_color']);
  if (Object.hasOwn(value, 'ams')) {
    selected.ams = value.ams === null ? null : pickScalars(value.ams, ['tray_now', 'ams_exist_bits', 'tray_exist_bits']);
    if (Array.isArray(value.ams?.ams)) {
      selected.ams.ams = value.ams.ams.slice(0, 32).filter((unit) => Number.isInteger(number(unit?.id, 0, 3)))
        .map((unit) => {
          const entry = pickScalars(unit, ['id']);
          if (Array.isArray(unit.tray)) entry.tray = unit.tray.slice(0, 32)
            .filter((tray) => Number.isInteger(number(tray?.id, 0, 3)))
            .map((tray) => pickScalars(tray, ['id', 'tray_type', 'tray_color']));
          return entry;
        });
    }
  }
  if (Object.hasOwn(value, 'device')) {
    selected.device = pickScalars(value.device, ['bed_temp']);
    if (object(value.device?.ctc?.info)) {
      selected.device.ctc = { info: pickScalars(value.device.ctc.info, ['temp']) };
    }
  }
  return selected;
}

function mergeReport(base, delta, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(delta)) {
    // Bambu's protocol-1 diff treats arrays as atomic values, including AMS
    // units/trays. Retaining entries or metadata absent from a replacement
    // array would show an old spool after the printer removed its identity.
    return delta.slice(0, 32).map((entry) => mergeReport(null, entry, depth + 1));
  }
  if (!object(delta)) return delta;
  const result = object(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(delta)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    result[key] = mergeReport(result[key], value, depth + 1);
  }
  return result;
}

function hexBits(value) {
  return typeof value === 'string' && /^[0-9a-f]{1,8}$/i.test(value) ? parseInt(value, 16) : null;
}

function mapBambuInventory(print) {
  const ams = print.ams;
  if (!object(ams) || !Array.isArray(ams.ams)) return null;
  const present = hexBits(ams.ams_exist_bits);
  const loaded = hexBits(ams.tray_exist_bits);
  const toolSlots = [];
  for (const unit of ams.ams) {
    const id = number(unit?.id, 0, 3);
    if (!Number.isInteger(id) || (present != null && !(present & (1 << id)))) continue;
    for (let slot = 0; slot < 4; slot++) {
      const toolIndex = id * 4 + slot;
      const tray = Array.isArray(unit.tray)
        ? unit.tray.find((entry) => String(entry?.id) === String(slot)) : null;
      const isLoaded = loaded == null ? null : !!(loaded & (1 << toolIndex));
      const color = text(tray?.tray_color);
      toolSlots.push({
        toolIndex,
        toolLabel: toolIndex + 1,
        loaded: isLoaded,
        name: null,
        material: isLoaded === false ? null : text(tray?.tray_type, 80) || null,
        color: isLoaded === false || !/^[0-9a-f]{8}$/i.test(color) ? null : `#${color.slice(0, 6).toUpperCase()}`,
      });
    }
  }
  if (!toolSlots.length) return null;
  toolSlots.sort((left, right) => left.toolIndex - right.toolIndex);
  return {
    toolCount: toolSlots[toolSlots.length - 1].toolLabel,
    countAuthoritative: true,
    toolSlots,
  };
}

function mapBambuToState(print, { serial = '', jobKey = null } = {}) {
  const rawState = text(print.gcode_state).toUpperCase();
  const state = ({ RUNNING: 'PRINTING', PAUSE: 'PAUSED', PREPARE: 'PRINTING',
    FINISH: 'FINISHED', FAILED: 'ERROR', IDLE: 'IDLE' })[rawState] || 'UNKNOWN';
  const hasJob = ACTIVE_STATES.has(rawState) || rawState === 'FINISH' || rawState === 'FAILED';
  const fileName = text(print.gcode_file);
  const displayName = text(print.subtask_name) || fileName.replace(/^.*[\\/]/, '');
  const ids = ['project_id', 'subtask_id', 'job_id', 'task_id', 'gcode_start_time']
    .map((key) => meaningfulId(print[key])).filter(Boolean);
  const identity = ids.join(':') || fileName || displayName;
  const key = hasJob ? jobKey || (identity ? `bambu:${serial}::${identity}` : null) : null;
  const inventory = mapBambuInventory(print);
  const trayNow = number(print.ams?.tray_now, 0, 255);
  const currentTool = Number.isInteger(trayNow) && trayNow <= 15 ? trayNow : null;
  const activeSlot = inventory?.toolSlots.find((slot) => slot.toolIndex === currentTool);
  const material = trayNow === 254 ? text(print.vt_tray?.tray_type, 80) || null : activeSlot?.material || null;
  const bedPacked = number(print.device?.bed_temp, 0, 0xffffffff);
  const chamberPacked = number(print.device?.ctc?.info?.temp, 0, 0xffffffff);
  return {
    state,
    activity: null,
    name: hasJob ? displayName.replace(/\.(?:gcode|3mf)$/i, '') : '',
    jobKey: key,
    thumbnailKey: key,
    thumbnailUrl: null,
    progress: hasJob ? number(print.mc_percent, 0, 100) : null,
    timeRemainingSec: hasJob && number(print.mc_remaining_time) != null ? number(print.mc_remaining_time) * 60 : null,
    timeElapsedSec: null,
    nozzleTemp: number(print.nozzle_temper, 0, 1000),
    nozzleTarget: number(print.nozzle_target_temper, 0, 1000),
    bedTemp: bedPacked == null ? number(print.bed_temper, 0, 1000) : bedPacked & 0xffff,
    bedTarget: bedPacked == null ? number(print.bed_target_temper, 0, 1000) : bedPacked >>> 16,
    chamberTemp: chamberPacked == null ? number(print.chamber_temper, 0, 1000) : chamberPacked & 0xffff,
    chamberTarget: chamberPacked == null ? number(print.ctt, 0, 1000) : chamberPacked >>> 16,
    currentLayer: hasJob ? number(print.layer_num) : null,
    totalLayers: hasJob ? number(print.total_layer_num) : null,
    currentTool,
    toolLabel: currentTool == null ? null : currentTool + 1,
    material,
    toolInventory: inventory,
    speed: number(print.spd_mag, 0, 1000),
    flow: null,
    axisZ: null,
    // Bambu fan telemetry is a speed scale, not the RPM required by this API.
    fanHotend: null,
    fanPrint: null,
    nextToolLabel: null,
    nextSwapInSec: null,
    swapsDone: null,
    swapsTotal: null,
    wasteDone: null,
    wasteTotal: null,
    filamentG: null,
    swapping: false,
    analyzing: false,
  };
}

class BambuClient extends EventEmitter {
  constructor(config, { connect = null, now = Date.now } = {}) {
    super();
    this.config = config;
    this.connect = connect || require('mqtt').connect;
    this.now = now;
    this.client = null;
    this.closed = false;
    this.report = {};
    this.lastIdentity = {};
    this.jobKey = null;
    this.jobSequence = 0;
    this.lastState = null;
    this.connectionEpoch = 0;
    this.lastErrorAt = -Infinity;
    this.retryTimer = null;
    this.reportTopic = `device/${config.bambuSerial}/report`;
    this.requestTopic = `device/${config.bambuSerial}/request`;
  }

  start() {
    if (this.client || this.closed) return;
    let client;
    try {
      client = this.connect({
        protocol: 'mqtts',
        host: this.config.printerHost,
        port: 8883,
        username: 'bblp',
        password: this.config.bambuAccessCode,
        clientId: `layerrelay_${randomBytes(8).toString('hex')}`,
        protocolVersion: 4,
        clean: true,
        keepalive: 30,
        connectTimeout: 10000,
        reconnectPeriod: 5000,
        resubscribe: false,
        queueQoSZero: false,
        // Printer LAN certificates are self-signed. This applies only to this
        // private-LAN MQTT connection, never to cloud HTTPS or camera traffic.
        rejectUnauthorized: false,
      });
    } catch {
      this.failure();
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.start(); }, 5000);
      this.retryTimer.unref?.();
      return;
    }
    this.client = client;
    client.on('connect', () => {
      if (this.closed) return;
      const epoch = ++this.connectionEpoch;
      this.report = {};
      client.subscribe(this.reportTopic, { qos: 0 }, (error, granted) => {
        if (this.closed || !client.connected || epoch !== this.connectionEpoch) return;
        if (error || !Array.isArray(granted) || !granted.some((grant) => grant.topic === this.reportTopic && grant.qos !== 128)) {
          this.failure();
          // Closing the transport lets MQTT's five-second reconnect cadence
          // retry a denied/timed-out subscription without stacking sessions.
          client.stream?.destroy();
          return;
        }
        // This is the sole application publish: request a telemetry snapshot.
        // No print, motion, heater, upload, pause or stop commands are exposed.
        const payload = JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall', version: 1, push_target: 1 } });
        client.publish(this.requestTopic, payload, { qos: 0, retain: false }, (publishError) => {
          if (publishError && !this.closed) {
            this.failure();
            client.stream?.destroy();
          }
        });
      });
    });
    client.on('message', (topic, payload) => this.onMessage(topic, payload));
    client.on('error', () => this.failure());
    for (const event of ['offline', 'close']) client.on(event, () => {
      if (!this.closed) { this.connectionEpoch++; this.emit('offline'); }
    });
  }

  failure() {
    if (this.closed) return;
    this.emit('offline');
    // Never forward MQTT errors: broker/transport strings can include secrets.
    if (this.listenerCount('error') && this.now() - this.lastErrorAt >= 30000) {
      this.lastErrorAt = this.now();
      this.emit('error', new Error('Bambu LAN telemetry connection failed'));
    }
  }

  onMessage(topic, payload) {
    if (this.closed || topic !== this.reportTopic || !payload || payload.length > MAX_REPORT_BYTES) return;
    let delta;
    try { delta = JSON.parse(payload.toString()); } catch { return; }
    if (!object(delta) || !object(delta.print)) return;
    // Keep only the bounded fields understood by this adapter. Otherwise many
    // small delta reports could accumulate unbounded, unused metadata in RAM.
    delta = selectReport(delta.print);
    if (!Object.keys(delta).some((key) => PRINT_FIELDS.has(key))) return;
    const incomingState = text(delta.gcode_state).toUpperCase();
    const newRun = ACTIVE_STATES.has(incomingState) && this.lastState != null &&
      !ACTIVE_STATES.has(this.lastState);
    const changedIdentity = ['job_id', 'subtask_id', 'task_id', 'gcode_start_time', 'gcode_file', 'subtask_name'].some((field) => {
      const previous = meaningfulId(this.lastIdentity[field]);
      const next = meaningfulId(delta[field]);
      return previous && next && previous !== next;
    });
    if (newRun || changedIdentity) {
      for (const field of JOB_FIELDS) if (field !== 'gcode_state') delete this.report[field];
      this.lastIdentity = {};
      this.jobKey = null;
    }
    if (delta.msg === 0) this.report = {};
    delete delta.msg;
    this.report = mergeReport(this.report, delta);
    if (typeof this.report.gcode_state !== 'string' || !this.report.gcode_state.trim()) return;
    for (const field of JOB_FIELDS) {
      if (delta[field] != null) this.lastIdentity[field] = delta[field];
    }
    const rawState = text(this.report.gcode_state).toUpperCase();
    const hasJob = ACTIVE_STATES.has(rawState) || rawState === 'FINISH' || rawState === 'FAILED';
    if (hasJob && !this.jobKey) {
      const mapped = mapBambuToState(this.report, { serial: this.config.bambuSerial });
      this.jobKey = mapped.jobKey || `bambu:${this.config.bambuSerial}::local-${this.now()}-${++this.jobSequence}`;
      // Repeated local jobs can expose the same file and zero IDs. Give a new
      // run its own identity while keeping that identity throughout reconnects.
      if (newRun && !['job_id', 'subtask_id', 'task_id', 'gcode_start_time'].some((field) => meaningfulId(this.report[field]))) {
        this.jobKey += `::run-${this.now()}-${++this.jobSequence}`;
      }
    }
    this.lastState = rawState;
    this.emit('telemetry', mapBambuToState(this.report, { serial: this.config.bambuSerial, jobKey: this.jobKey }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.client?.end(true);
    this.client = null;
    this.report = {};
  }
}

module.exports = { BambuClient, mapBambuToState, mapBambuInventory, MAX_REPORT_BYTES };
