'use strict';

const assert = require('node:assert/strict');
const { test } = require('bun:test');
const { analyzeBgcode, buildTimeline, mapLive, materialFor, parseMaterials } = require('../toolswaps.js');

test('preserves tool indexes when slicer metadata has empty material slots', () => {
  const materials = parseMaterials({ filament_type: 'PETG;;PLA; ' });

  assert.deepEqual(materials, ['PETG', null, 'PLA', null]);
  assert.equal(materialFor({ materials }, 0), 'PETG');
  assert.equal(materialFor({ materials }, 1), null);
  assert.equal(materialFor({ materials }, 2), 'PLA');
});

test('parses comma metadata, falls back to settings ids, and handles absent metadata', () => {
  assert.deepEqual(parseMaterials({ filament_type: ' PETG,PLA ' }), ['PETG', 'PLA']);
  assert.deepEqual(
    parseMaterials({ filament_settings_id: 'Generic PETG @ CORE One;;PLA' }),
    ['Generic PETG @ CORE One', null, 'PLA'],
  );
  assert.deepEqual(parseMaterials({}), []);
  assert.equal(materialFor(null, 0), null);
  assert.equal(materialFor({ materials: ['PETG'] }, null), null);
});

test('builds tool, layer, and purge timelines from decoded gcode', () => {
  const gcode = [
    'M73P0R100',
    'T2',
    ';LAYER_CHANGE',
    ';Z:0.20',
    ';FLUSH_START',
    'G1 X1 E10',
    'G1 E-2',
    ';FLUSH_END',
    'M73P10R90',
    'T5',
    ';EXCLUDE_E_START',
    'G1 X2 E2.5',
    ';EXCLUDE_E_END',
    ';LAYER_CHANGE',
    ';Z:0.40',
    'M73P10R80',
    'T5',
    'T1',
  ].join('\n');

  const analysis = buildTimeline(gcode);

  assert.equal(analysis.initialTool, 2);
  assert.equal(analysis.totalSwaps, 2);
  assert.equal(analysis.totalWasteMm, 12.5);
  assert.deepEqual(analysis.toolsSeen, [1, 2, 5]);
  assert.deepEqual(analysis.layers, [
    { progressPct: 0, remainingMin: 100, z: 0.2 },
    { progressPct: 10, remainingMin: 90, z: 0.4 },
  ]);
  assert.deepEqual(analysis.timeline, [
    { progressPct: 10, remainingMin: 90, toolIndex: 5, cumulativeSwaps: 1, cumulativeWasteMm: 10 },
    { progressPct: 10, remainingMin: 80, toolIndex: 1, cumulativeSwaps: 2, cumulativeWasteMm: 12.5 },
  ]);
});

test('analyzes plain-text gcode returned by Connect', () => {
  const analysis = analyzeBgcode(Buffer.from([
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
  ].join('\n')));

  assert.equal(analysis.initialTool, 0);
  assert.equal(analysis.totalSwaps, 1);
  assert.equal(analysis.totalWasteMm, 10);
  assert.deepEqual(analysis.materials, ['PETG', 'PLA']);
  assert.equal(analysis.totalFilamentG, 12.5);
  assert.ok(analysis.totalWasteG > 0);
});

test('rejects empty and non-G-code cloud payloads before caching analysis', () => {
  assert.throws(() => analyzeBgcode(Buffer.alloc(0)), /empty G-code response/);
  assert.throws(
    () => analyzeBgcode(Buffer.from('<!doctype html><title>temporary error</title>')),
    /not plausible plain-text G-code/,
  );
});

test('maps same-percent swaps using remaining time and reports waste, layers, and next tool', () => {
  const analysis = {
    initialTool: 2,
    totalSwaps: 2,
    totalWasteG: 0.125,
    gPerMm: 0.01,
    timeline: [
      { progressPct: 10, remainingMin: 90, toolIndex: 5, cumulativeSwaps: 1, cumulativeWasteMm: 10 },
      { progressPct: 10, remainingMin: 80, toolIndex: 1, cumulativeSwaps: 2, cumulativeWasteMm: 12.5 },
    ],
    layers: [
      { progressPct: 0, remainingMin: 100, z: 0.2 },
      { progressPct: 10, remainingMin: 90, z: 0.4 },
    ],
  };

  assert.deepEqual(mapLive(analysis, 10, 95), {
    currentTool: 2,
    swapsDone: 0,
    swapsTotal: 2,
    wasteDone: 0,
    wasteTotal: 0.125,
    nextTool: 5,
    nextSwapRemMin: 5,
    currentLayer: 1,
    totalLayers: 2,
  });

  assert.deepEqual(mapLive(analysis, 10, 85), {
    currentTool: 5,
    swapsDone: 1,
    swapsTotal: 2,
    wasteDone: 0.1,
    wasteTotal: 0.125,
    nextTool: 1,
    nextSwapRemMin: 5,
    currentLayer: 2,
    totalLayers: 2,
  });

  assert.deepEqual(mapLive(analysis, 10, 75), {
    currentTool: 1,
    swapsDone: 2,
    swapsTotal: 2,
    wasteDone: 0.125,
    wasteTotal: 0.125,
    nextTool: null,
    nextSwapRemMin: null,
    currentLayer: 2,
    totalLayers: 2,
  });
});

test('maps an analysis without swaps or layer metadata', () => {
  assert.deepEqual(mapLive({
    initialTool: 3,
    totalSwaps: 0,
    totalWasteG: null,
    timeline: [],
  }, 50, null), {
    currentTool: 3,
    swapsDone: 0,
    swapsTotal: 0,
    wasteDone: 0,
    wasteTotal: null,
    nextTool: null,
    nextSwapRemMin: null,
    currentLayer: null,
    totalLayers: null,
  });
});
