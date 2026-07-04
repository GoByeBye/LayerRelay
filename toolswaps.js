'use strict';
// Build a tool-change timeline from decoded G-code and map live progress onto it.
// Decoded non-comment M/T lines have NO spaces (MeatPack no-spaces mode): "M73P42R37", "T3".
const { decodeGcodeText, decodeMetadata } = require('./bgcode.js');

// Parse per-tool materials from bgcode metadata.
// filament_type is one entry per tool, e.g. "PETG;PETG;PLA;..." (0-indexed by tool).
function parseMaterials(meta) {
  const raw = meta.filament_type || meta.filament_settings_id || '';
  if (!raw) return [];
  const sep = raw.includes(';') ? ';' : ',';
  return raw.split(sep).map((s) => s.trim()).filter(Boolean);
}

// Parse decoded gcode text into a timeline of tool-change events.
// Returns { initialTool, totalSwaps, timeline:[{progressPct, remainingMin, toolIndex, cumulativeSwaps}], toolsSeen:[...] }
function buildTimeline(gcodeText) {
  let lastPct = 0, lastRemMin = null, tool = null, initialTool = null, swaps = 0;
  const timeline = [];
  const toolsSeen = new Set();
  // Waste = filament purged during toolchanges. PrusaSlicer marks it with ;FLUSH_START/END
  // (the color flush) and ;EXCLUDE_E_START/END (the tool-load prime); sum the E in those.
  let wasteMm = 0, inFlush = false, inExcl = false;

  const lines = gcodeText.split('\n');
  for (let raw of lines) {
    if (!raw) continue;
    // Some lines (notably the ;FLUSH/;EXCLUDE_E markers) are indented in the decoded g-code,
    // so trim leading whitespace before any prefix check.
    const line = raw.trim();
    if (!line) continue;

    if (line[0] === ';') {
      if (line.indexOf(';FLUSH_START') === 0) inFlush = true;
      else if (line.indexOf(';FLUSH_END') === 0) inFlush = false;
      else if (line.indexOf(';EXCLUDE_E_START') === 0) inExcl = true;
      else if (line.indexOf(';EXCLUDE_E_END') === 0) inExcl = false;
      continue;
    }

    if ((inFlush || inExcl) && line[0] === 'G') {
      const e = /(?:^|\s)E(-?\d*\.?\d+)/.exec(line);
      if (e) { const v = parseFloat(e[1]); if (v > 0) wasteMm += v; }
      continue;
    }

    if (line[0] === 'M' && line[1] === '7' && line[2] === '3') {
      const p = /P(\d+(?:\.\d+)?)/.exec(line);
      const r = /R(\d+)/.exec(line);
      if (p) lastPct = parseFloat(p[1]);
      if (r) lastRemMin = parseInt(r[1], 10);
      continue;
    }
    // Tool select: leading T followed by digits, then end or a non-digit param (F/S/M/L/D/P...).
    if (line[0] === 'T') {
      const m = /^T(\d+)(?:\D|$)/.exec(line);
      if (!m) continue;
      const t = parseInt(m[1], 10);
      toolsSeen.add(t);
      if (tool === null) {
        tool = t;
        initialTool = t; // initial selection, not a swap
      } else if (t !== tool) {
        tool = t;
        swaps++;
        timeline.push({ progressPct: lastPct, remainingMin: lastRemMin, toolIndex: t, cumulativeSwaps: swaps, cumulativeWasteMm: wasteMm });
      }
    }
  }

  return {
    initialTool: initialTool == null ? 0 : initialTool,
    totalSwaps: swaps,
    totalWasteMm: wasteMm,
    timeline,
    toolsSeen: [...toolsSeen].sort((a, b) => a - b),
  };
}

// Coarse progress-based estimate of the swap index. Only ~usable to a resolution of however many
// swaps share one integer progress percent (for a 1000-swap print that's ~10 swaps), so it is used
// ONLY to seed / sanity-anchor the physical dip count, never as the live tool source.
// Returns { currentTool, swapsDone, swapsTotal }.
function mapLive(analysis, livePct, liveRemMin) {
  const tl = analysis.timeline;
  const swapsTotal = analysis.totalSwaps;
  if (!tl.length) return { currentTool: analysis.initialTool, swapsDone: 0, swapsTotal };

  // Binary search: last event with progressPct <= livePct.
  let lo = 0, hi = tl.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tl[mid].progressPct <= livePct) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }

  const wasteTotal = analysis.totalWasteG ?? null;
  if (idx < 0) return { currentTool: analysis.initialTool, swapsDone: 0, swapsTotal, wasteDone: 0, wasteTotal };

  // Resolution fix: several swaps can share one integer percent. Among events at the
  // same percent as the boundary, use live remaining time (monotonically decreasing)
  // to decide which have actually happened.
  if (liveRemMin != null) {
    const pct = tl[idx].progressPct;
    while (idx >= 0 && tl[idx].progressPct === pct && tl[idx].remainingMin != null &&
           tl[idx].remainingMin < liveRemMin) {
      idx--;
    }
    if (idx < 0) return { currentTool: analysis.initialTool, swapsDone: 0, swapsTotal, wasteDone: 0, wasteTotal };
  }

  const gPerMm = analysis.gPerMm || 0;
  const wasteDone = tl[idx].cumulativeWasteMm != null ? tl[idx].cumulativeWasteMm * gPerMm : null;
  return { currentTool: tl[idx].toolIndex, swapsDone: tl[idx].cumulativeSwaps, swapsTotal, wasteDone, wasteTotal };
}

// grams of filament per mm of extruded length, from diameter (mm) and density (g/cm3).
function gramsPerMm(diameterMm, densityGcm3) {
  const areaMm2 = Math.PI * Math.pow(diameterMm / 2, 2);
  return areaMm2 * densityGcm3 / 1000; // mm3 -> cm3 (/1000) * g/cm3
}

const ANALYSIS_VERSION = 4; // bump when the analysis shape changes so stale caches are rebuilt

const firstNum = (csv, dflt) => {
  if (!csv) return dflt;
  const v = parseFloat(String(csv).split(/[,;]/)[0]);
  return isNaN(v) ? dflt : v;
};

// Convenience: decode a bgcode buffer straight to an analysis object.
function analyzeBgcode(fileBuf) {
  const a = buildTimeline(decodeGcodeText(fileBuf));
  const meta = decodeMetadata(fileBuf);
  a.materials = parseMaterials(meta);       // 0-indexed by tool
  // Waste in grams from the purge length + filament geometry (defaults: 1.75mm, 1.27 g/cm3).
  a.gPerMm = gramsPerMm(firstNum(meta.filament_diameter, 1.75), firstNum(meta.filament_density, 1.27));
  a.totalWasteG = (a.totalWasteMm || 0) * a.gPerMm;
  // Total filament for the whole print, straight from the slicer metadata.
  a.totalFilamentG = firstNum(meta['total filament used [g]'], null);
  a.version = ANALYSIS_VERSION;
  return a;
}

// Material name for a given 0-based tool index (or null).
function materialFor(analysis, toolIndex) {
  if (!analysis || !analysis.materials || toolIndex == null) return null;
  return analysis.materials[toolIndex] || null;
}

module.exports = { buildTimeline, mapLive, analyzeBgcode, materialFor, ANALYSIS_VERSION };
