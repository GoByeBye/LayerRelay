/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Simulated print driver for the static dashboard build. Replays a decoded
 * G-code analysis (see toolswaps.mjs) as a deterministic function of played
 * seconds, so the virtual /api/state endpoint can serve the same telemetry
 * shape the LayerRelay server produces from a live printer.
 */
// Browser ESM. No Node APIs, no timers, no Math.random: stateAt(playedSec) is a
// pure function of its argument so scrubbing and tests are reproducible.
import { mapLive, materialFor } from './toolswaps.mjs';

const AMBIENT_C = 24;
const WARMUP_SEC = 90;
const COOLDOWN_TAU_SEC = 240;
const SWAP_WINDOW_SEC = 12;
const FALLBACK_DURATION_SEC = 3600;

// Material-based temperature targets. Chamber heating only for the materials
// that actually use it on a CORE One style enclosure.
function materialTargets(material) {
  const m = String(material || '').toUpperCase();
  if (m.includes('PETG')) return { nozzle: 240, bed: 85, chamber: null };
  if (m.includes('TPU')) return { nozzle: 230, bed: 50, chamber: null };
  if (m.includes('ASA') || m.includes('ABS')) return { nozzle: 255, bed: 100, chamber: 45 };
  if (m.includes('PC')) return { nozzle: 270, bed: 110, chamber: 45 };
  if (m.includes('PLA')) return { nozzle: 215, bed: 60, chamber: null };
  return { nozzle: 220, bed: 60, chamber: null };
}

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Deterministic wobble standing in for sensor noise: a slow sine of played time.
const wobble = (t, phase, amp) => Math.sin(t / 9 + phase) * amp;

// Print duration: the M73 R value near the start of the file is the slicer's
// total remaining time, so the largest remainingMin seen anywhere in the
// timelines is the whole print in minutes.
function inferDurationSec(analysis) {
  let maxRemMin = 0;
  for (const events of [analysis && analysis.timeline, analysis && analysis.layers]) {
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      if (event && Number.isFinite(event.remainingMin)) {
        maxRemMin = Math.max(maxRemMin, event.remainingMin);
      }
    }
  }
  return maxRemMin > 0 ? maxRemMin * 60 : FALLBACK_DURATION_SEC;
}

export function createReplay({ analysis, name = '', durationSecOverride = null } = {}) {
  if (!analysis || !Array.isArray(analysis.timeline)) {
    throw new TypeError('createReplay requires an analysis with a timeline');
  }
  const durationSec = Number.isFinite(durationSecOverride) && durationSecOverride > 0
    ? durationSecOverride
    : inferDurationSec(analysis);

  // Wall-clock second of each toolchange, from the M73 remaining time recorded
  // at the swap (progress percent as fallback for files without M73 R).
  const swapTimes = analysis.timeline
    .map((event) => (event && Number.isFinite(event.remainingMin)
      ? Math.max(0, durationSec - event.remainingMin * 60)
      : (event ? (event.progressPct / 100) * durationSec : 0)))
    .sort((a, b) => a - b);

  const layers = Array.isArray(analysis.layers) ? analysis.layers : [];

  // Ambient-to-target ramp during warmup, exponential decay after the print.
  function simulatedTemp(t, finished, target, rampSec, noisePhase, noiseAmp) {
    if (target == null) return null;
    if (finished) {
      const sinceEnd = Math.max(0, t - durationSec);
      const cooled = AMBIENT_C + (target - AMBIENT_C) * Math.exp(-sinceEnd / COOLDOWN_TAU_SEC);
      return round1(cooled);
    }
    const ramp = Math.min(1, t / rampSec);
    const value = AMBIENT_C + (target - AMBIENT_C) * ramp + wobble(t, noisePhase, noiseAmp) * ramp;
    return round1(value);
  }

  function stateAt(playedSec) {
    const t = Math.max(0, Number(playedSec) || 0);
    const finished = t >= durationSec;
    const pct = finished ? 100 : clamp((t / durationSec) * 100, 0, 100);
    const remainingSec = finished ? 0 : Math.round(durationSec - t);
    const remMin = remainingSec / 60;

    const live = mapLive(analysis, pct, remMin);
    const currentTool = live.currentTool;
    const material = materialFor(analysis, currentTool);
    const targets = materialTargets(material);

    const swapping = !finished &&
      swapTimes.some((s) => t >= s && t - s < SWAP_WINDOW_SEC);
    const warm = t >= WARMUP_SEC && !finished;

    let nozzleTemp = simulatedTemp(t, finished, targets.nozzle, WARMUP_SEC, 0.4, 0.6);
    // During an INDX toolchange the nozzle parks and sheds heat: dip below the
    // target so the overlay's cool arrow and the swap badge line up.
    if (swapping && nozzleTemp != null) nozzleTemp = round1(nozzleTemp - 20);

    const currentLayer = live.currentLayer;
    let axisZ = null;
    if (layers.length) {
      const layerIndex = currentLayer != null && currentLayer >= 1
        ? Math.min(currentLayer, layers.length) - 1 : 0;
      const z = layers[layerIndex] ? layers[layerIndex].z : null;
      axisZ = z == null ? null : z;
    }

    return {
      state: finished ? 'FINISHED' : 'PRINTING',
      progress: round1(pct),
      timeRemainingSec: remainingSec,
      timeElapsedSec: Math.round(Math.min(t, durationSec)),
      nozzleTemp,
      nozzleTarget: finished ? 0 : targets.nozzle,
      bedTemp: simulatedTemp(t, finished, targets.bed, WARMUP_SEC, 1.7, 0.3),
      bedTarget: finished ? 0 : targets.bed,
      chamberTemp: targets.chamber == null
        ? null : simulatedTemp(t, finished, targets.chamber, WARMUP_SEC * 10, 2.9, 0.4),
      chamberTarget: targets.chamber == null ? null : (finished ? 0 : targets.chamber),
      speed: 100,
      flow: Math.round(100 + wobble(t, 2.2, 2)),
      axisZ,
      fanHotend: warm ? Math.round(7900 + wobble(t, 1.1, 80)) : 0,
      currentTool,
      toolLabel: currentTool == null ? null : currentTool + 1,
      material,
      nextToolLabel: finished || live.nextTool == null ? null : live.nextTool + 1,
      nextSwapInSec: finished || live.nextSwapRemMin == null
        ? null : Math.round(live.nextSwapRemMin * 60),
      currentLayer: finished && live.totalLayers != null ? live.totalLayers : currentLayer,
      totalLayers: live.totalLayers,
      swapsDone: finished && live.swapsTotal != null ? live.swapsTotal : live.swapsDone,
      swapsTotal: live.swapsTotal,
      wasteDone: finished && live.wasteTotal != null
        ? round1(live.wasteTotal) : round1(live.wasteDone),
      wasteTotal: round1(live.wasteTotal),
      filamentG: analysis.totalFilamentG != null ? Math.round(analysis.totalFilamentG) : null,
      swapping,
      name,
    };
  }

  // Scrub helper: live mapping plus clock values for an arbitrary progress %.
  function timelineFor(pct) {
    const clamped = clamp(Number(pct) || 0, 0, 100);
    const playedSec = (clamped / 100) * durationSec;
    const remainingMin = (durationSec - playedSec) / 60;
    return { playedSec, remainingMin, ...mapLive(analysis, clamped, remainingMin) };
  }

  return { analysis, name, durationSec, stateAt, timelineFor };
}
