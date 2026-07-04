'use strict';
// Ad-hoc validation of the bgcode decoder against a real file.
// Usage: node test-decode.js <path-to.bgcode>
const fs = require('fs');
const { decodeGcodeText, decodeMetadata } = require('./bgcode.js');
const { buildTimeline, mapLive } = require('./toolswaps.js');

const path = process.argv[2];
if (!path) {
  console.error('usage: node test-decode.js <path-to.bgcode>');
  process.exit(1);
}
const buf = fs.readFileSync(path);
console.log(`file: ${path}  (${buf.length} bytes)`);

const meta = decodeMetadata(buf);
console.log('\n== metadata (selected) ==');
for (const k of ['printer_model', 'filament_type', 'estimated printing time (normal mode)', 'total toolchanges']) {
  if (meta[k] !== undefined) console.log(`  ${k} = ${meta[k]}`);
}

console.time('decode');
const text = decodeGcodeText(buf);
console.timeEnd('decode');
console.log(`\ndecoded gcode: ${text.length} chars, ${text.split('\n').length} lines`);

const m73 = (text.match(/^M73P/gm) || []).length;
const tlines = text.match(/^T\d+[^\n]*/gm) || [];
console.log(`M73P lines: ${m73}`);
console.log(`T-lines: ${tlines.length}  (sample: ${[...new Set(tlines)].slice(0, 12).join(' | ')})`);

console.log('\n-- first 12 decoded non-empty lines --');
console.log(text.split('\n').filter(Boolean).slice(0, 12).join('\n'));

const a = buildTimeline(text);
console.log('\n== timeline ==');
console.log(`initialTool=${a.initialTool}  totalSwaps=${a.totalSwaps}  toolsSeen=[${a.toolsSeen}]`);
console.log('first 8 swaps:', a.timeline.slice(0, 8));
console.log('last 3 swaps:', a.timeline.slice(-3));

for (const pct of [0, 5, 20, 22, 50, 90, 100]) {
  console.log(`  live ${pct}% ->`, mapLive(a, pct));
}
