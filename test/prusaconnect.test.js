'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { onTestFinished, test } = require('bun:test');
const {
  ConnectAuth,
  classifyPrinterActivity,
  connectAssetsNeedRefresh,
  mapConnectJobAssets,
  mapConnectToState,
  normalizePrinterState,
  resolveConnectPath,
} = require('../prusaconnect.js');

test('serializes concurrent refreshes of rotating OAuth tokens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-relay-connect-auth-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const auth = new ConnectAuth({ connectRefreshToken: 'seed' }, path.join(dir, 'token.json'));
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  auth.refreshOnce = async () => {
    requests++;
    await gate;
    return 'shared-access-token';
  };

  const first = auth.getAccessToken();
  const second = auth.refresh();
  const third = auth.getAccessToken();
  assert.equal(requests, 1);
  release();

  assert.deepEqual(await Promise.all([first, second, third]),
    ['shared-access-token', 'shared-access-token', 'shared-access-token']);
  assert.equal(requests, 1);
});

test('maps active tool, print telemetry, chamber data, and job identity', () => {
  const mapped = mapConnectToState({
    state: 'PRINTING',
    job_info: {
      display_name: 'camera-idol.bgcode',
      progress: 19,
      time_remaining: 2070,
      time_printing: 870,
      model_weight: 14.6,
      origin_id: 0,
      path: '/usb/camera-idol.bgcode',
    },
    temp: {
      temp_nozzle: 250,
      target_nozzle: 255,
      temp_bed: 89,
      target_bed: 90,
    },
    chamber: { temp: 36.2, target_temp: 40 },
    axis_z: 12.4,
    flow: 98,
    speed: 100,
    tools: {
      1: { active: false, material: 'PLA' },
      3: { active: true, material: 'PETG', fan_hotend: 15113, fan_print: 4200 },
    },
    filament: { material: 'fallback material' },
  }, (name) => `clean:${name}`);

  assert.deepEqual(mapped, {
    state: 'PRINTING',
    activity: null,
    name: 'clean:camera-idol.bgcode',
    chamberTemp: 36.2,
    chamberTarget: 40,
    progress: 19,
    timeRemainingSec: 2070,
    timeElapsedSec: 870,
    nozzleTemp: 250,
    nozzleTarget: 255,
    bedTemp: 89,
    bedTarget: 90,
    axisZ: 12.4,
    flow: 98,
    speed: 100,
    fanHotend: 15113,
    fanPrint: 4200,
    currentTool: 2,
    toolLabel: 3,
    material: 'PETG',
    filamentG: 15,
    jobId: 0,
    connectJobId: null,
    fileName: 'camera-idol.bgcode',
    previewUrl: null,
    printing: true,
  });
});

test('normalizes transient states and accepts flat chamber telemetry', () => {
  const mapped = mapConnectToState({
    state: 'PAUSING',
    job_info: { id: 42, display_name: 'part.gcode', progress: 0, path: 'part.gcode' },
    temp: { temp_chamber: 0, target_chamber: 35 },
    tools: {},
    filament: { material: 'ASA' },
  }, (name) => name.replace('.gcode', ''));

  assert.equal(mapped.state, 'PRINTING');
  assert.equal(mapped.printing, true);
  assert.equal(mapped.progress, 0);
  assert.equal(mapped.name, 'part');
  assert.equal(mapped.chamberTemp, 0);
  assert.equal(mapped.chamberTarget, 35);
  assert.equal(mapped.currentTool, null);
  assert.equal(mapped.toolLabel, null);
  assert.equal(mapped.material, 'ASA');
  assert.equal(mapped.jobId, 42);
  assert.equal(mapped.connectJobId, 42);
  assert.equal(mapped.fileName, 'part.gcode');
});

test('maps Connect job assets while retaining the printer-local short filename', () => {
  const mapped = mapConnectJobAssets({
    id: 567,
    file: {
      team_id: 91,
      hash: 'abc123',
      display_name: 'bin-labeled-ramped_0.4n_0.2mm_PETG_COREONEINDX_33m.bgcode',
      name: 'bin-labeled-ramped_0.4n_0.2mm_PETG_COREONEINDX_33m.bgcode',
      preview_url: '/app/teams/91/files/abc123/preview',
      size: '670750',
    },
  }, { fileName: 'BIN-LA~1.BGC' });

  assert.deepEqual(mapped, {
    connectJobId: 567,
    file: {
      name: 'BIN-LA~1.BGC',
      display_name: 'bin-labeled-ramped_0.4n_0.2mm_PETG_COREONEINDX_33m.bgcode',
      size: 670750,
      refs: {},
    },
    previewPath: '/app/teams/91/files/abc123/preview',
    rawPath: '/app/teams/91/files/abc123/raw',
  });
});

test('retries an incomplete matching asset descriptor after a bounded delay', () => {
  const descriptor = {
    jobKey: '42::PART.BGCODE',
    connectJobId: 567,
    previewPath: '/app/teams/91/files/abc123/preview',
    rawPath: null,
    savedAt: 100000,
  };

  assert.equal(connectAssetsNeedRefresh(descriptor, '42::part.bgcode', 567, 129999), false);
  assert.equal(connectAssetsNeedRefresh(descriptor, '42::part.bgcode', 567, 130000), true);
  assert.equal(connectAssetsNeedRefresh({ ...descriptor, rawPath: '/app/teams/91/files/abc123/raw' },
    '42::part.bgcode', 567, 999999), false);
  assert.equal(connectAssetsNeedRefresh({ ...descriptor, previewPath: null,
    rawPath: '/app/teams/91/files/abc123/raw' }, '42::part.bgcode', 567, 129999), false);
  assert.equal(connectAssetsNeedRefresh({ ...descriptor, previewPath: null,
    rawPath: '/app/teams/91/files/abc123/raw' }, '42::part.bgcode', 567, 130000), true);
  assert.equal(connectAssetsNeedRefresh(descriptor, '43::part.bgcode', 567, 100001), true);
});

test('accepts only same-origin resources under the requested Connect API prefix', () => {
  assert.equal(resolveConnectPath(
    'https://connect.prusa3d.com/app/teams/91/files/abc/preview?size=medium', ['/app/teams/']),
  '/app/teams/91/files/abc/preview?size=medium');
  assert.throws(() => resolveConnectPath('https://example.com/app/teams/91/files/abc/raw', ['/app/teams/']),
    /refusing non-Prusa Connect/);
  assert.throws(() => resolveConnectPath('/app/printers/uuid', ['/app/teams/']),
    /refusing non-Prusa Connect/);
});

test('suppresses progress while idle and preserves zero-valued telemetry', () => {
  const mapped = mapConnectToState({
    state: 'READY',
    job_info: { display_name: '', progress: 73, time_remaining: 0, time_printing: 0, model_weight: 0 },
    temp: { temp_nozzle: 0, target_nozzle: 0, temp_bed: 0, target_bed: 0 },
    axis_z: 0,
    flow: 0,
    speed: 0,
  }, (name) => name);

  assert.equal(mapped.state, 'IDLE');
  assert.equal(mapped.printing, false);
  assert.equal(mapped.progress, null);
  assert.equal(mapped.timeRemainingSec, 0);
  assert.equal(mapped.timeElapsedSec, 0);
  assert.equal(mapped.nozzleTemp, 0);
  assert.equal(mapped.bedTemp, 0);
  assert.equal(mapped.axisZ, 0);
  assert.equal(mapped.flow, 0);
  assert.equal(mapped.speed, 0);
  assert.equal(mapped.filamentG, 0);
  assert.equal(mapped.currentTool, null);
  assert.equal(mapped.material, null);
});

test('keeps BUSY without a job identity as a non-print operation', () => {
  const idleBusy = mapConnectToState({
    state: 'BUSY',
    job_info: { display_name: '', progress: null },
    temp: { temp_nozzle: 25, target_nozzle: 0, temp_bed: 24, target_bed: 0 },
  }, (name) => name);

  assert.equal(idleBusy.state, 'BUSY');
  assert.equal(idleBusy.printing, false);
  assert.equal(idleBusy.progress, null);
  assert.deepEqual(idleBusy.activity, {
    active: true, kind: 'OPERATION', label: 'Printer busy', detail: null, progress: null,
  });
  assert.equal(normalizePrinterState('BUSY', null, {}), 'BUSY');
  assert.equal(normalizePrinterState('BUSY', { id: 0 }), 'PRINTING');
  assert.equal(normalizePrinterState('BUSY', { file: { name: 'active.bgcode' } }), 'PRINTING');
});

test('maps unknown printer states without inventing live values', () => {
  const mapped = mapConnectToState({ state: 'SLEEPING' }, (name) => name);

  assert.equal(mapped.state, 'UNKNOWN');
  assert.equal(mapped.printing, false);
  assert.equal(mapped.progress, null);
  assert.equal(mapped.currentTool, null);
  assert.equal(mapped.fileName, null);
  assert.equal(mapped.jobId, null);
});

test('classifies explicit maintenance activity before conservative filename inference', () => {
  const maintenance = mapConnectToState({ state: 'MAINTENANCE' }, (name) => name);
  assert.equal(maintenance.state, 'BUSY');
  assert.deepEqual(maintenance.activity, {
    active: true, kind: 'MAINTENANCE', label: 'Maintenance', detail: null, progress: null,
  });

  assert.deepEqual(classifyPrinterActivity('READY', {
    operation: { type: 'unloading_filament', progress: 55 },
  }), {
    active: true,
    kind: 'FILAMENT_UNLOAD',
    label: 'Unloading filament',
    detail: 'unloading_filament',
    progress: 55,
  });
  assert.equal(classifyPrinterActivity('READY', { status: 'Calibration required' }), null);
  assert.equal(normalizePrinterState('READY', { status: 'Calibration required' }), 'IDLE');

  assert.deepEqual(classifyPrinterActivity('BUSY', {
    title: 'Homing',
    text: 'Homing axes',
    dialog_id: 42,
  }), {
    active: true,
    kind: 'HOMING',
    label: 'Homing',
    detail: 'Homing',
    progress: null,
  });
  assert.equal(classifyPrinterActivity('BUSY', { dialog_id: 42 }).kind, 'OPERATION');
  assert.equal(classifyPrinterActivity('READY', { dialog_id: 42 }), null);
  assert.equal(classifyPrinterActivity('READY', { text: 'Filament loading' }).kind, 'FILAMENT_LOAD');
  assert.equal(normalizePrinterState('READY', { text: 'Filament loading' }), 'BUSY');

  const inferred = mapConnectToState({
    state: 'PRINTING',
    job_info: { id: 7, display_name: 'input_shaper_calibration.bgcode', progress: 12 },
  }, (name) => name.replace('.bgcode', ''));
  assert.equal(inferred.state, 'PRINTING');
  assert.equal(inferred.activity.kind, 'CALIBRATION');
  assert.equal(inferred.activity.progress, 12);
});

test('covers the canonical explicit activity kinds', () => {
  const cases = {
    CALIBRATING: 'CALIBRATION',
    SELFTEST: 'SELFTEST',
    HOMING: 'HOMING',
    LOAD_FILAMENT: 'FILAMENT_LOAD',
    UNLOAD_FILAMENT: 'FILAMENT_UNLOAD',
    MAINTENANCE: 'MAINTENANCE',
    BUSY: 'OPERATION',
  };
  for (const [rawState, kind] of Object.entries(cases)) {
    const activity = classifyPrinterActivity(rawState);
    assert.equal(activity.active, true);
    assert.equal(activity.kind, kind);
    assert.equal(activity.detail, null);
    assert.equal(activity.progress, null);
    assert.equal(normalizePrinterState(rawState), 'BUSY');
  }
});
