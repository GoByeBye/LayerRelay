/*
 * Copyright (C) 2026 GoByeBye and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Added 2026-08-19 for the static GitHub Pages build: bundle entry for
 * dist/pages/lr-static.js. Installs the window.fetch shim synchronously at
 * evaluation time (the built script tag precedes overlay.html's inline
 * script), creates the in-browser state engine, and mounts the injected
 * control panel on DOMContentLoaded. See NOTICE.md and docs/static-hosting.md.
 */
// Browser ESM bundled by Bun.build (target browser, format iife). Nothing in
// this module graph may use top-level await: the fetch shim must be installed
// before this script finishes evaluating, because overlay.html's inline script
// runs immediately afterwards and issues its first /api/state poll.

import { createEngine } from './state-engine.mjs';
import { createStaticApp, installFetchShim } from './adapter.js';

let engine = null;
let engineError = null;
try {
  engine = createEngine();
} catch (err) {
  engineError = err;
  if (typeof console !== 'undefined') {
    console.error('LayerRelay static engine failed to start:', err);
  }
}

// Synchronous install: from here on every root-relative /api/* fetch is
// answered by the in-browser engine. When the engine failed to start (or does
// not handle a path) the request falls through to the real fetch, where a
// static host answers 404 and the overlay renders its offline shell.
installFetchShim({ win: window, engine: engine });

// Debug/test hook: tests and the browser console reach the engine through
// window.__lrStatic.engine.
window.__lrStatic = { engine: engine, engineError: engineError };

const app = createStaticApp({ win: window, engine: engine, engineError: engineError });
window.__lrStatic.app = app;

// DOM-free: activates the persisted / URL-selected data source (demo replay,
// live bridge) so the overlay's very first poll already has data even when
// ?controls=0 hides the panel.
app.boot();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { app.mountPanel(); }, { once: true });
} else {
  app.mountPanel();
}
