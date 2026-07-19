'use strict';
// Set or clear the overlay's sticky on-screen banner (persists across polls/restarts).
//   bun tools/overlay-message.mjs set "your text"
//   bun tools/overlay-message.mjs clear
import {
  overlayApiUrl,
  overlayRequestHeaders,
  resolveOverlayBaseUrl,
} from './_overlay-client.mjs';

const endpoint = overlayApiUrl(resolveOverlayBaseUrl(), '/api/message');
const action = process.argv[2];
const text = process.argv.slice(3).join(' ');

if (action === 'set') {
  if (!text) { console.error('usage: overlay-message.mjs set "text"'); process.exit(2); }
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: overlayRequestHeaders('POST', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ text }),
  });
  if (r.ok) console.log('OK message set');
  else { console.error(`FAILED ${r.status}: ${await r.text()}`); process.exitCode = 1; }
} else if (action === 'clear') {
  const r = await fetch(endpoint, { method: 'DELETE', headers: overlayRequestHeaders('DELETE') });
  if (r.ok) console.log('OK message cleared');
  else { console.error(`FAILED ${r.status}: ${await r.text()}`); process.exitCode = 1; }
} else {
  console.error('usage: overlay-message.mjs <set "text" | clear>');
  process.exit(2);
}
