'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('bun:test');
const vm = require('node:vm');

const overlayPath = path.join(__dirname, '..', 'public', 'overlay.html');
const html = fs.readFileSync(overlayPath, 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const rawScript = html.slice(scriptStart, html.lastIndexOf('</script>'));

function makeToolSettingsView({
  toolCount = null,
  toolSlots = {},
  detected = {
    source: 'connect',
    status: 'fresh',
    toolCount: 2,
    toolSlots: [
      { toolIndex: 0, toolLabel: 1, loaded: true, name: 'Auto PLA', material: 'PLA', color: '#AA0000' },
      { toolIndex: 1, toolLabel: 2, loaded: false, name: null, material: null, color: null },
    ],
  },
} = {}) {
  const normalizedDetected = JSON.parse(JSON.stringify(detected));
  const highestOverride = Object.keys(toolSlots).reduce((highest, key) => Math.max(highest, Number(key)), 0);
  const effectiveCount = toolCount ?? normalizedDetected.toolCount ?? Math.max(1, highestOverride);
  const detectedByLabel = new Map((normalizedDetected.toolSlots || []).map((slot) => [slot.toolLabel, slot]));
  const effectiveSlots = Array.from({ length: effectiveCount }, (_, toolIndex) => {
    const toolLabel = toolIndex + 1;
    const automatic = detectedByLabel.get(toolLabel) || {};
    const override = toolSlots[String(toolLabel)] || {};
    const has = (key) => Object.hasOwn(override, key);
    return {
      toolIndex,
      toolLabel,
      loaded: has('loaded') ? override.loaded : typeof automatic.loaded === 'boolean' ? automatic.loaded : null,
      name: has('name') ? override.name : automatic.name || null,
      material: automatic.material || null,
      color: has('color') ? String(override.color).toUpperCase() : automatic.color || null,
      sources: {
        loaded: has('loaded') ? 'override' : typeof automatic.loaded === 'boolean' ? 'connect' : 'none',
        name: has('name') ? 'override' : automatic.name ? 'connect' : 'none',
        material: automatic.material ? 'connect' : 'none',
        color: has('color') ? 'override' : automatic.color ? 'connect' : 'none',
      },
    };
  });
  return {
    toolCount,
    toolSlots: JSON.parse(JSON.stringify(toolSlots)),
    detected: normalizedDetected,
    effective: {
      toolCount: effectiveCount,
      toolCountSource: toolCount != null ? 'override' : normalizedDetected.toolCount != null ? 'connect' : 'fallback',
      toolSlots: effectiveSlots,
    },
  };
}

class FakeClassList {
  constructor(owner, value = '') {
    this.owner = owner;
    this.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  add(...names) { names.forEach((name) => this.values.add(name)); this.sync(); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); this.sync(); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name); else this.values.delete(name);
    this.sync();
    return enabled;
  }
  sync() { this.owner._className = [...this.values].join(' '); }
}

class FakeElement {
  constructor(id = '', className = '', networkLog = [], tagName = 'div') {
    this.id = id;
    this.tagName = String(tagName).toUpperCase();
    this._className = className;
    this.classList = new FakeClassList(this, className);
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this._innerHTML = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.children = [];
    this.parentNode = null;
    this.ownerDocument = null;
    this.focused = false;
    this.networkLog = networkLog;
    this.slots = [];
    this.clientWidth = 1500;
  }
  get className() { return this._className; }
  set className(value) {
    this._className = String(value || '');
    this.classList = new FakeClassList(this, this._className);
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = String(value || '');
    if (this.id === 'tool') {
      const count = (this._innerHTML.match(/class="slot/g) || []).length;
      this.slots = Array.from({ length: count }, (_, index) => new FakeElement(`slot-${index + 1}`));
    }
  }
  get src() { return this._src; }
  set src(value) {
    this._src = String(value);
    if (this._src.startsWith('/api/camera.mjpeg')) this.networkLog.push(this._src);
  }
  setAttribute(name, value) {
    if (name === 'class') this.className = value;
    else if (name === 'src') this.src = value;
    else if (name === 'hidden') { this.hidden = true; this.attributes.set(name, ''); }
    else this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name === 'src') return this._src == null ? null : this._src;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    if (name === 'src') this._src = undefined;
    else if (name === 'hidden') { this.hidden = false; this.attributes.delete(name); }
    else this.attributes.delete(name);
  }
  appendChild(child) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  dispatch(name, event = {}) {
    if (!event.target) event.target = this;
    if (!event.preventDefault) event.preventDefault = () => { event.defaultPrevented = true; };
    if (!event.stopPropagation) event.stopPropagation = () => { event.propagationStopped = true; };
    for (const listener of this.listeners.get(name) || []) listener(event);
    return event;
  }
  focus() {
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  querySelectorAll(selector) { return selector === '.slot' ? this.slots : []; }
}

function openingTagAttributes(source) {
  const result = [];
  const tags = source.match(/<[^!][^>]*\bid="[^"]+"[^>]*>/g) || [];
  for (const tag of tags) {
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const className = /\bclass="([^"]*)"/.exec(tag)?.[1] || '';
    const attrs = {};
    for (const match of tag.matchAll(/\b([\w-]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
    result.push({ id, className, attrs });
  }
  return result;
}

function createRuntime({
  height = 1080,
  search = '',
  storedRoom = null,
  cameraStatus,
  stateFailure = false,
  state,
  toolSettings = makeToolSettingsView(),
  toolSettingsPromise,
  settingsFailure = false,
  filamentPayload = { suggestions: [], stale: false, unavailable: false },
  saveFailure = false,
  saveResponse,
} = {}) {
  const imageRequests = [];
  const fetchRequests = [];
  const fetchCalls = [];
  const elements = new Map();
  for (const { id, className, attrs } of openingTagAttributes(html)) {
    const element = new FakeElement(id, className, imageRequests);
    for (const [name, value] of Object.entries(attrs)) {
      if (name !== 'id' && name !== 'class' && name !== 'src') element.setAttribute(name, value);
    }
    elements.set(id, element);
  }
  const track = new FakeElement('track', 'track empty', imageRequests);
  const body = new FakeElement('body');
  const documentListeners = new Map();
  const windowListeners = new Map();
  const storage = new Map();
  const timers = new Map();
  if (storedRoom != null) storage.set('layer-relay.room-visible', storedRoom ? '1' : '0');
  let timerId = 0;

  const document = {
    body,
    hidden: false,
    activeElement: null,
    getElementById: (id) => elements.get(id),
    querySelector: (selector) => selector === '.track' ? track : null,
    createElement: (tag) => tag === 'canvas' ? {
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: '', fillRect() {} }),
      toDataURL: () => 'data:image/png;base64,',
    } : Object.assign(new FakeElement('', '', imageRequests, tag), { ownerDocument: document }),
    addEventListener(name, listener) {
      if (!documentListeners.has(name)) documentListeners.set(name, []);
      documentListeners.get(name).push(listener);
    },
  };
  for (const element of [...elements.values(), track, body]) element.ownerDocument = document;
  const window = {
    innerHeight: height,
    addEventListener(name, listener) {
      if (!windowListeners.has(name)) windowListeners.set(name, []);
      windowListeners.get(name).push(listener);
    },
  };

  const context = {
    AbortController,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    String,
    URLSearchParams,
    clearInterval() {},
    clearTimeout(id) { timers.delete(id); },
    console,
    document,
    encodeURIComponent,
    fetch(url, options = {}) {
      fetchRequests.push(url);
      fetchCalls.push({ url, options });
      if (url === '/api/state') {
        if (stateFailure) return Promise.reject(new Error('state unavailable'));
        const payload = cameraStatus === undefined ?
          { enabled: true, running: true, online: true } : cameraStatus;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(state || { camera: payload }) });
      }
      if (url === '/api/settings/tools' && options.method === 'PUT') {
        const payload = JSON.parse(options.body);
        if (saveFailure) return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'save failed' }) });
        const body = typeof saveResponse === 'function' ? saveResponse(payload) :
          saveResponse || makeToolSettingsView({
            toolCount: payload.toolCount,
            toolSlots: payload.toolSlots,
            detected: toolSettings.detected,
          });
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
      }
      if (url === '/api/settings/tools') {
        if (settingsFailure) return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'unavailable' }) });
        return Promise.resolve({ ok: true, json: () => toolSettingsPromise || Promise.resolve(toolSettings) });
      }
      if (String(url).startsWith('/api/filaments?')) {
        const payload = typeof filamentPayload === 'function' ? filamentPayload(url) : filamentPayload;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    },
    isFinite,
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    location: { search },
    performance: { now: () => 1000 },
    setInterval: () => ++timerId,
    setTimeout(callback, delay = 0) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    window,
  };
  context.globalThis = context;
  vm.createContext(context);
  const marker = rawScript.lastIndexOf('})();');
  const instrumented = rawScript.slice(0, marker) + `
    globalThis.__overlay = {
      S: S,
      el: el,
      applyCameraStatus: applyCameraStatus,
      applyToolSettingsToState: applyToolSettingsToState,
      closeToolEditor: closeToolEditor,
      displayMaterial: displayMaterial,
      getToolEditorRows: function () { return toolEditorRowRefs; },
      normalizeToolSlots: normalizeToolSlots,
      normalizeToolSettings: normalizeToolSettings,
      normalizeToolSettingsView: normalizeToolSettingsView,
      openToolEditor: openToolEditor,
      render: render,
      renderFilamentSuggestions: renderFilamentSuggestions,
      sameJobKey: sameJobKey,
      saveToolSettings: saveToolSettings,
      searchFilamentsNow: searchFilamentsNow,
      selectFilamentSuggestion: selectFilamentSuggestion,
      setRoomVisible: setRoomVisible,
      syncCameraMode: syncCameraMode,
      syncToolSlots: syncToolSlots,
      toolSettingsPayload: toolSettingsPayload
    };
  ` + rawScript.slice(marker);
  vm.runInContext(instrumented, context, { filename: 'overlay.html' });

  function runTimers(delay) {
    for (const [id, timer] of [...timers]) {
      if (delay != null && timer.delay !== delay) continue;
      timers.delete(id);
      timer.callback();
    }
  }

  return {
    api: context.__overlay,
    body,
    elements,
    fetchCalls,
    fetchRequests,
    imageRequests,
    runTimers,
    storage,
    timers,
    window,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('camera image has no static src and viewport mode protects the legacy 420px source', () => {
  assert.doesNotMatch(html, /<img id="camera-feed"[^>]+src=/);

  const legacy = createRuntime({ height: 420 });
  assert.equal(legacy.imageRequests.length, 0);
  assert.equal(legacy.fetchRequests.includes('/api/camera/status'), false);
  assert.equal(legacy.body.classList.contains('overlay-only'), true);

  const dashboard = createRuntime({ height: 1080 });
  assert.equal(dashboard.imageRequests.length, 1);
  assert.match(dashboard.imageRequests[0], /^\/api\/camera\.mjpeg\?/);
  assert.equal(dashboard.fetchRequests.includes('/api/camera/status'), false);
  assert.equal(dashboard.fetchRequests.includes('/api/state'), true);
  assert.equal(dashboard.body.classList.contains('overlay-only'), false);
  assert.equal(dashboard.elements.get('dashboard-mode-note').textContent, 'Camera on · 1080px dashboard layout.');
});

test('dashboard controls offer corresponding source without adding a passive overlay element', () => {
  const runtime = createRuntime({ height: 1080 });
  const sourceLink = runtime.elements.get('source-link');
  assert.equal(sourceLink.getAttribute('href'), '/source');
  assert.equal(sourceLink.getAttribute('target'), '_blank');
  assert.equal(sourceLink.getAttribute('rel'), 'noopener');
  assert.match(html, /Source &amp; AGPL license/);
  assert.match(html, /Tools &amp; filament/);
  assert.match(html, /Search text is sent by this server to[\s\S]+FilamentColors\.xyz[\s\S]+Joe Kaufeld[\s\S]+CC BY 4\.0[\s\S]+normalized by LayerRelay/);
});

test('job-map identities tolerate casing differences between local and cloud filenames', () => {
  const runtime = createRuntime({ height: 420 });
  assert.equal(runtime.api.sameJobKey('42::PART.BGCODE', '42::part.bgcode'), true);
  assert.equal(runtime.api.sameJobKey('42::part.bgcode', '43::part.bgcode'), false);
});

test('camera query overrides viewport mode without ever making a speculative request', () => {
  const forcedOff = createRuntime({ height: 1080, search: '?camera=0' });
  assert.equal(forcedOff.imageRequests.length, 0);
  assert.equal(forcedOff.elements.get('camera-feed').getAttribute('src'), null);

  const forcedOn = createRuntime({ height: 420, search: '?camera=1' });
  assert.equal(forcedOn.imageRequests.length, 1);
  assert.equal(forcedOn.body.classList.contains('overlay-only'), false);
});

test('status booleans drive the badge without replacing a healthy MJPEG subscriber', async () => {
  const runtime = createRuntime({ height: 1080 });
  await flushPromises();
  const initialSrc = runtime.elements.get('camera-feed').getAttribute('src');

  assert.equal(runtime.api.S.cameraState, 'live');
  runtime.api.applyCameraStatus({ enabled: true, running: false, online: false, restartInMs: 3000 });
  assert.equal(runtime.api.S.cameraState, 'connecting');
  assert.equal(runtime.elements.get('camera-feed').getAttribute('src'), initialSrc);

  runtime.api.applyCameraStatus({ enabled: true, running: true, online: false });
  assert.equal(runtime.api.S.cameraState, 'unavailable');
  assert.equal(runtime.elements.get('camera-feed').getAttribute('src'), initialSrc);

  runtime.api.applyCameraStatus({ enabled: true });
  assert.equal(runtime.api.S.cameraState, 'connecting');
  assert.equal(runtime.elements.get('camera-feed').getAttribute('src'), initialSrc);

  runtime.api.applyCameraStatus({ enabled: false, running: false, online: false });
  assert.equal(runtime.elements.get('camera-feed').getAttribute('src'), null);
});

test('state failures cannot leave the camera badge claiming live', async () => {
  const runtime = createRuntime({ height: 1080, stateFailure: true });
  runtime.api.applyCameraStatus({ enabled: true, running: true, online: true });
  await flushPromises();
  assert.equal(runtime.api.S.cameraState, 'connecting');
});

test('leaving viewport dashboard mode closes the subscriber and re-entering reconnects it', () => {
  const runtime = createRuntime({ height: 1080 });
  assert.equal(runtime.imageRequests.length, 1);

  runtime.api.syncCameraMode(false);
  assert.equal(runtime.elements.get('camera-feed').getAttribute('src'), null);
  assert.equal(runtime.body.classList.contains('overlay-only'), true);

  runtime.api.syncCameraMode(true);
  assert.equal(runtime.imageRequests.length, 2);
  assert.equal(runtime.body.classList.contains('overlay-only'), false);
});

test('room temperature is opt-in, persisted per browser, and URL-overridable', () => {
  const reading = { state: 'IDLE', online: true, staleSec: 0, roomTemp: 25, toolCount: 8 };

  const hidden = createRuntime({ height: 420 });
  hidden.api.S.data = reading;
  hidden.api.render();
  assert.equal(hidden.elements.get('stats1').classList.contains('has-room'), false);

  hidden.api.setRoomVisible(true, true);
  assert.equal(hidden.elements.get('stats1').classList.contains('has-room'), true);
  assert.equal(hidden.storage.get('layer-relay.room-visible'), '1');

  const stored = createRuntime({ height: 420, storedRoom: true });
  stored.api.S.data = reading;
  stored.api.render();
  assert.equal(stored.elements.get('stats1').classList.contains('has-room'), true);

  const overridden = createRuntime({ height: 420, search: '?room=0', storedRoom: true });
  overridden.api.S.data = reading;
  overridden.api.render();
  assert.equal(overridden.elements.get('stats1').classList.contains('has-room'), false);
});

test('tool slots consume the canonical server state', () => {
  const { api } = createRuntime({ height: 420 });
  const normalized = api.normalizeToolSlots({
    toolCount: 2,
    toolLabel: 2,
    material: 'PETG',
    toolSlots: [
      { toolIndex: 0, toolLabel: 1, loaded: null, name: null, material: null, color: null },
      {
        toolIndex: 1, toolLabel: 2, loaded: false, name: 'Galaxy Black', material: null, color: '#112233',
        sources: { loaded: 'override', name: 'override', material: 'none', color: 'override' },
      },
    ],
  });
  assert.equal(normalized.list.length, 2);
  assert.equal(normalized.list[0].loaded, null);
  assert.equal(normalized.byLabel[2].loaded, false);
  assert.equal(normalized.byLabel[2].name, 'Galaxy Black');
  assert.equal(normalized.byLabel[2].liveMaterial, 'PETG');
  assert.equal(normalized.byLabel[2].color, '#112233');
});

test('an explicit material-name override wins over a conflicting live material family', () => {
  const { api } = createRuntime({ height: 420 });
  assert.equal(api.displayMaterial({
    name: 'Custom PLA',
    material: 'PLA',
    sources: { name: 'override', material: 'connect' },
  }, 'PETG'), 'Custom PLA');
  assert.equal(api.displayMaterial({
    name: 'Detected PLA',
    material: 'PLA',
    sources: { name: 'connect', material: 'connect' },
  }, 'PETG'), 'PETG');
});

test('explicit tool counts win while legacy state retains the eight-slot fallback and dense rows stay bounded', () => {
  const { api, elements } = createRuntime({ height: 420 });
  assert.equal(api.normalizeToolSlots({ toolSlots: [] }).list.length, 8);
  assert.equal(api.normalizeToolSlots({ toolCount: 1, toolSlots: new Array(8).fill({}) }).list.length, 1);
  assert.equal(api.normalizeToolSlots({ toolCount: 32, toolSlots: [] }).list.length, 32);

  api.syncToolSlots({ toolCount: 9, toolSlots: [] });
  assert.equal(elements.get('tool').classList.contains('compact'), true);
  assert.equal(elements.get('tool').classList.contains('dense'), false);
  api.syncToolSlots({ toolCount: 17, toolSlots: [] });
  assert.equal(elements.get('tool').classList.contains('dense'), true);
});

test('tool editor shows automatic Connect values without copying them into overrides', async () => {
  const toolSettings = makeToolSettingsView({
    toolCount: null,
    toolSlots: { 1: { name: 'Custom label' }, 8: { loaded: false, name: 'Hidden reserve' } },
    detected: {
      source: 'connect', status: 'fresh', toolCount: 3,
      toolSlots: [
        { toolIndex: 0, toolLabel: 1, loaded: true, name: 'Auto PLA', color: '#AA0000' },
        { toolIndex: 1, toolLabel: 2, loaded: false, name: null, color: null },
        { toolIndex: 2, toolLabel: 3, loaded: null, name: 'Auto PETG', color: '#00AA00' },
      ],
    },
  });
  const runtime = createRuntime({ height: 420, toolSettings });

  runtime.elements.get('tools-configure').dispatch('click');
  await flushPromises();
  assert.equal(runtime.elements.get('controls-main').hidden, true);
  assert.equal(runtime.elements.get('tools-editor').hidden, false);
  assert.equal(runtime.elements.get('tool-count-mode').value, 'auto');
  assert.equal(runtime.elements.get('tool-count-input').value, '3');
  assert.equal(runtime.elements.get('tool-count-input').disabled, true);
  assert.equal(runtime.elements.get('tool-count-source').textContent, '3 detected by Connect');
  assert.equal(runtime.api.getToolEditorRows().length, 3);
  assert.equal(runtime.api.getToolEditorRows()[0].input.value, 'Custom label');
  assert.equal(runtime.api.getToolEditorRows()[1].loaded.value, 'auto');
  assert.equal(runtime.api.getToolEditorRows()[2].input.value, 'Auto PETG');
  assert.match(runtime.api.getToolEditorRows()[2].source.textContent, /Auto · Connect fresh/);
  assert.equal(runtime.elements.get('tool-settings-summary').textContent, '3 tools · 1 loaded · Auto · Connect fresh');

  runtime.api.closeToolEditor(true);
  assert.equal(runtime.elements.get('controls-main').hidden, false);
  assert.equal(runtime.elements.get('tools-configure').focused, true);
});

test('Auto and Override count modes preserve hidden slot overrides', async () => {
  const runtime = createRuntime({
    height: 420,
    toolSettings: makeToolSettingsView({
      toolCount: null,
      toolSlots: { 8: { loaded: false, name: 'Reserve PETG' } },
      detected: { source: 'connect', status: 'fresh', toolCount: 4, toolSlots: [] },
    }),
  });
  runtime.api.openToolEditor();
  await flushPromises();
  const mode = runtime.elements.get('tool-count-mode');
  const count = runtime.elements.get('tool-count-input');

  mode.value = 'override';
  mode.dispatch('change');
  assert.equal(count.disabled, false);
  assert.equal(count.value, '4');
  count.value = '2';
  count.dispatch('input');
  assert.equal(runtime.api.getToolEditorRows().length, 2);
  mode.value = 'auto';
  mode.dispatch('change');
  assert.equal(runtime.api.getToolEditorRows().length, 4);

  await runtime.api.saveToolSettings();
  const saveCall = runtime.fetchCalls.find((call) => call.url === '/api/settings/tools' && call.options.method === 'PUT');
  assert.deepEqual(JSON.parse(saveCall.options.body), {
    toolCount: null,
    toolSlots: { 8: { loaded: false, name: 'Reserve PETG' } },
  });
});

test('ARIA picker creates name and color overrides without changing automatic presence', async () => {
  const runtime = createRuntime({
    height: 420,
    toolSettings: makeToolSettingsView({
      detected: {
        source: 'connect', status: 'fresh', toolCount: 1,
        toolSlots: [{ toolIndex: 0, toolLabel: 1, loaded: false, name: 'Auto PLA', color: '#111111' }],
      },
    }),
  });
  runtime.api.openToolEditor();
  await flushPromises();
  const row = runtime.api.getToolEditorRows()[0];
  const customEnter = row.input.dispatch('keydown', { key: 'Enter' });
  assert.equal(customEnter.defaultPrevented, undefined);
  runtime.api.renderFilamentSuggestions(row, {
    suggestions: [{
      id: 'safe-1', label: '<img src=x> Shimmer PETG', manufacturer: 'Prusament',
      material: 'PETG', colorName: 'Violet', color: '#452060',
    }],
    stale: false, unavailable: false,
  });
  assert.equal(row.input.getAttribute('role'), 'combobox');
  row.input.dispatch('keydown', { key: 'ArrowDown' });
  row.input.dispatch('keydown', { key: 'Enter' });
  assert.equal(row.input.value, '<img src=x> Shimmer PETG');
  assert.equal(row.color.value, '#452060');
  assert.equal(row.loaded.value, 'auto');
  assert.equal(row.input.getAttribute('aria-expanded'), 'false');

  await runtime.api.saveToolSettings();
  const saveCall = runtime.fetchCalls.find((call) => call.url === '/api/settings/tools' && call.options.method === 'PUT');
  assert.deepEqual(JSON.parse(saveCall.options.body), {
    toolCount: null,
    toolSlots: { 1: { name: '<img src=x> Shimmer PETG', color: '#452060' } },
  });
});

test('Auto type preserves the independently selected catalog color override', async () => {
  const runtime = createRuntime({
    height: 420,
    toolSettings: makeToolSettingsView({
      detected: {
        source: 'connect', status: 'fresh', toolCount: 1,
        toolSlots: [{ toolIndex: 0, toolLabel: 1, loaded: true, name: 'Auto PLA', color: '#111111' }],
      },
    }),
  });
  runtime.api.openToolEditor();
  await flushPromises();
  const row = runtime.api.getToolEditorRows()[0];
  assert.equal(Object.hasOwn(row, 'colorAuto'), false);
  assert.equal(html.includes('Auto color'), false);
  assert.equal(row.nameAuto.textContent, 'Auto type');

  runtime.api.selectFilamentSuggestion(row, {
    id: 'petg-violet', label: 'Shimmer PETG', material: 'PETG', color: '#452060',
  });
  row.nameAuto.dispatch('click');

  assert.equal(row.input.value, 'Auto PLA');
  assert.equal(row.color.value, '#452060');
  assert.equal(row.nameAuto.disabled, true);

  await runtime.api.saveToolSettings();
  const saveCall = runtime.fetchCalls.find((call) => call.url === '/api/settings/tools' && call.options.method === 'PUT');
  assert.deepEqual(JSON.parse(saveCall.options.body), {
    toolCount: null,
    toolSlots: { 1: { color: '#452060' } },
  });
});

test('Auto type and presence reset cancel stale searches while preserving the color override', async () => {
  let resolveOld;
  const oldPayload = new Promise((resolve) => { resolveOld = resolve; });
  const runtime = createRuntime({
    height: 420,
    toolSettings: makeToolSettingsView({
      toolSlots: { 1: { loaded: false, name: 'Custom PETG', color: '#123456' } },
      detected: {
        source: 'connect', status: 'fresh', toolCount: 1,
        toolSlots: [{ toolIndex: 0, toolLabel: 1, loaded: true, name: 'Auto PLA', color: '#ABCDEF' }],
      },
    }),
    filamentPayload: oldPayload,
  });
  runtime.api.openToolEditor();
  await flushPromises();
  const row = runtime.api.getToolEditorRows()[0];
  row.input.value = 'old';
  row.input.dispatch('input');
  const pending = runtime.api.searchFilamentsNow(row, 'old');

  row.nameAuto.dispatch('click');
  row.loaded.value = 'auto';
  row.loaded.dispatch('change');
  assert.equal(row.input.value, 'Auto PLA');
  assert.equal(row.color.value, '#123456');
  assert.equal(row.loaded.value, 'auto');
  assert.equal(row.listbox.hidden, true);

  resolveOld({ suggestions: [{ id: 'old', label: 'Late result', color: '#000000' }] });
  await pending;
  assert.equal(row.input.value, 'Auto PLA');
  assert.equal(row.suggestions.length, 0);
  await runtime.api.saveToolSettings();
  const saveCall = runtime.fetchCalls.find((call) => call.url === '/api/settings/tools' && call.options.method === 'PUT');
  assert.deepEqual(JSON.parse(saveCall.options.body), {
    toolCount: null,
    toolSlots: { 1: { color: '#123456' } },
  });
});

test('custom values remain saveable while Connect and the catalog are unavailable', async () => {
  const runtime = createRuntime({
    height: 420,
    toolSettings: makeToolSettingsView({
      detected: { source: null, status: 'unavailable', toolCount: null, toolSlots: [] },
    }),
    filamentPayload: { suggestions: [], stale: false, unavailable: true },
  });
  runtime.api.openToolEditor();
  await flushPromises();
  const row = runtime.api.getToolEditorRows()[0];
  assert.match(runtime.elements.get('tool-count-source').textContent, /Connect unavailable/);
  assert.match(row.feedback.textContent, /Auto unavailable/);
  row.input.value = 'My custom PLA';
  row.input.dispatch('input');
  runtime.runTimers(500);
  await flushPromises();
  assert.match(row.feedback.textContent, /Catalog unavailable/);
  row.color.value = '#345678';
  row.color.dispatch('input');
  runtime.api.renderFilamentSuggestions(row, {
    suggestions: [{ id: 'late', label: 'Late click PLA', color: '#999999' }],
  });
  const lateOption = row.optionNodes[0];

  const saving = runtime.api.saveToolSettings();
  assert.equal(row.loaded.disabled, true);
  assert.equal(row.color.disabled, true);
  assert.equal(row.nameAuto.disabled, true);
  assert.equal(row.input.disabled, true);
  assert.equal(row.listbox.hidden, true);
  lateOption.dispatch('click');
  assert.equal(row.input.value, 'My custom PLA');
  await saving;
  const saveCall = runtime.fetchCalls.find((call) => call.url === '/api/settings/tools' && call.options.method === 'PUT');
  assert.equal(saveCall.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(saveCall.options.body), {
    toolCount: null,
    toolSlots: { 1: { name: 'My custom PLA', color: '#345678' } },
  });
  assert.equal(runtime.elements.get('tool-settings-summary').textContent, '1 tool · 0 loaded · Auto · fallback');
});

test('a superseded catalog response cannot replace newer type-ahead results', async () => {
  let resolveOld;
  const oldPayload = new Promise((resolve) => { resolveOld = resolve; });
  let requestCount = 0;
  const runtime = createRuntime({
    height: 420,
    toolSettings: makeToolSettingsView({ detected: { source: 'connect', status: 'stale', toolCount: 1, toolSlots: [] } }),
    filamentPayload() {
      requestCount++;
      return requestCount === 1 ? oldPayload : {
        suggestions: [{ id: 'new', label: 'New result PETG', color: '#123456' }],
        stale: false, unavailable: false,
      };
    },
  });
  runtime.api.openToolEditor();
  await flushPromises();
  const row = runtime.api.getToolEditorRows()[0];
  row.input.value = 'old';
  row.input.dispatch('input');
  const first = runtime.api.searchFilamentsNow(row, 'old');
  row.input.value = 'new';
  await runtime.api.searchFilamentsNow(row, 'new');
  assert.equal(row.suggestions[0].label, 'New result PETG');
  resolveOld({ suggestions: [{ id: 'old', label: 'Old result PLA' }], stale: true });
  await first;
  assert.equal(row.suggestions[0].label, 'New result PETG');
});

test('a delayed settings refresh restores focus without persisting effective values', async () => {
  let resolveSettings;
  const toolSettingsPromise = new Promise((resolve) => { resolveSettings = resolve; });
  const initial = makeToolSettingsView({
    detected: { source: null, status: 'unavailable', toolCount: null, toolSlots: [] },
  });
  const runtime = createRuntime({ height: 420, toolSettingsPromise });
  runtime.api.S.data = Object.assign({}, initial.effective, { toolSettings: initial });
  runtime.api.openToolEditor();
  const initialInput = runtime.api.getToolEditorRows()[0].input;
  initialInput.focus();

  resolveSettings(makeToolSettingsView({
    detected: {
      source: 'connect', status: 'fresh', toolCount: 2,
      toolSlots: [{ toolIndex: 0, toolLabel: 1, loaded: true, name: 'Refreshed PLA' }],
    },
  }));
  await flushPromises();
  const refreshedInput = runtime.api.getToolEditorRows()[0].input;
  assert.notEqual(refreshedInput, initialInput);
  assert.equal(refreshedInput.focused, true);
  assert.equal(refreshedInput.value, 'Refreshed PLA');
  assert.equal(runtime.elements.get('tool-editor-save').disabled, true);
});

test('invalid custom counts and failed saves keep the independent draft open', async () => {
  const runtime = createRuntime({
    height: 420,
    toolSettings: makeToolSettingsView({ toolCount: 1 }),
    saveFailure: true,
  });
  runtime.api.openToolEditor();
  await flushPromises();
  const count = runtime.elements.get('tool-count-input');
  count.value = '33';
  count.dispatch('input');
  assert.equal(count.getAttribute('aria-invalid'), 'true');
  const row = runtime.api.getToolEditorRows()[0];
  row.input.value = 'Unsaved custom PLA';
  row.input.dispatch('input');
  assert.equal(runtime.elements.get('tool-editor-save').disabled, true);
  assert.match(runtime.elements.get('tool-editor-status').textContent, /1 to 32/);
  count.value = '1';
  count.dispatch('input');
  assert.equal(count.getAttribute('aria-invalid'), null);
  assert.equal(runtime.elements.get('tool-editor-save').disabled, false);
  await runtime.api.saveToolSettings();
  assert.match(runtime.elements.get('tool-editor-status').textContent, /save failed/);
  assert.equal(runtime.elements.get('tools-editor').hidden, false);
  assert.equal(runtime.api.getToolEditorRows()[0].input.value, 'Unsaved custom PLA');
});

test('overlay has no stream-control, operator-message, or away-mode remnants', () => {
  for (const pattern of [
    /\/api\/(?:message|announce|automation)\b/i,
    /\b(?:overlayHost|automationRunning|automationExpiresAt|AUTO MODE|bedmsg)\b/i,
    /id="(?:feed|feed-avatar|msg-banner|sleep-msg)"/i,
    /(?:gone to bed|chat is muted|won't see chat)/i,
  ]) {
    assert.doesNotMatch(html, pattern);
  }
});
