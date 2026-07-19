'use strict';
// Post a line to the overlay's configurable stream-host feed (newest shows big, previous as history).
//   bun tools/announce.mjs add "Layer 314 down, hull looks clean."
//   bun tools/announce.mjs add --auto "Watching layer 314."
//   bun tools/announce.mjs auto-pulse | auto-status | auto-stop
//   bun tools/announce.mjs list
//   bun tools/announce.mjs clear
import {
  overlayApiUrl,
  overlayRequestHeaders,
  resolveOverlayBaseUrl,
} from './_overlay-client.mjs';

const overlayBaseUrl = resolveOverlayBaseUrl();
const endpoint = overlayApiUrl(overlayBaseUrl, '/api/announce');
const automationEndpoint = overlayApiUrl(overlayBaseUrl, '/api/automation');
const action = process.argv[2];
const automatic = process.argv[3] === '--auto';
const text = process.argv.slice(automatic ? 4 : 3).join(' ');

async function automationRequest(method, suffix) {
  const response = await fetch(`${automationEndpoint}/${suffix}`, {
    method,
    headers: overlayRequestHeaders(method, { 'X-Automation-Heartbeat': '1' }),
  });
  if (!response.ok) throw new Error(`automation endpoint returned ${response.status}: ${await response.text()}`);
  return response.json();
}

if (action === 'add') {
  if (!text) { console.error('usage: announce.mjs add [--auto] "text"'); process.exit(2); }
  if (automatic) {
    try { await automationRequest('POST', 'heartbeat'); }
    catch (error) { console.error(`FAILED ${error.message}`); process.exit(1); }
  }
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: overlayRequestHeaders('POST', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ text }),
  });
  console.log(r.ok ? 'OK announced' : `FAILED ${r.status}: ${await r.text()}`);
  if (!r.ok) process.exitCode = 1;
} else if (action === 'list') {
  const r = await fetch(endpoint);
  if (!r.ok) { console.error(`FAILED ${r.status}`); process.exit(1); }
  const items = await r.json();
  if (!Array.isArray(items)) { console.error('FAILED unexpected payload'); process.exit(1); }
  for (const a of items) console.log(`${new Date(a.at * 1000).toLocaleTimeString()}  ${a.text}`);
  if (!items.length) console.log('(empty)');
} else if (action === 'clear') {
  const r = await fetch(endpoint, { method: 'DELETE', headers: overlayRequestHeaders('DELETE') });
  console.log(r.ok ? 'OK feed cleared' : `FAILED ${r.status}`);
  if (!r.ok) process.exitCode = 1;
} else if (action === 'auto-pulse') {
  try {
    const status = await automationRequest('POST', 'heartbeat');
    console.log(`OK AUTO MODE leased for ${Math.ceil(status.expiresInMs / 1000)}s`);
  } catch (error) { console.error(`FAILED ${error.message}`); process.exitCode = 1; }
} else if (action === 'auto-status') {
  try {
    const status = await automationRequest('GET', 'status');
    console.log(status.running ? `AUTO MODE active · ${Math.ceil(status.expiresInMs / 1000)}s left` : 'AUTO MODE inactive');
  } catch (error) { console.error(`FAILED ${error.message}`); process.exitCode = 1; }
} else if (action === 'auto-stop') {
  try {
    await automationRequest('DELETE', 'heartbeat');
    console.log('OK AUTO MODE stopped');
  } catch (error) { console.error(`FAILED ${error.message}`); process.exitCode = 1; }
} else {
  console.error('usage: announce.mjs <add [--auto] "text" | list | clear | auto-pulse | auto-status | auto-stop>');
  process.exit(2);
}
