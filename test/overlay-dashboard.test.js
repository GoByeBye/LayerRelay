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
  constructor(id = '', className = '', networkLog = []) {
    this.id = id;
    this._className = className;
    this.classList = new FakeClassList(this, className);
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this._innerHTML = '';
    this.textContent = '';
    this.disabled = false;
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
    else this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name === 'src') return this._src == null ? null : this._src;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    if (name === 'src') this._src = undefined;
    else this.attributes.delete(name);
  }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) listener(event);
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
} = {}) {
  const imageRequests = [];
  const fetchRequests = [];
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
  if (storedRoom != null) storage.set('layer-relay.room-visible', storedRoom ? '1' : '0');
  let timerId = 0;

  const document = {
    body,
    hidden: false,
    getElementById: (id) => elements.get(id),
    querySelector: (selector) => selector === '.track' ? track : null,
    createElement: (tag) => tag === 'canvas' ? {
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: '', fillRect() {} }),
      toDataURL: () => 'data:image/png;base64,',
    } : new FakeElement(tag),
    addEventListener(name, listener) {
      if (!documentListeners.has(name)) documentListeners.set(name, []);
      documentListeners.get(name).push(listener);
    },
  };
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
    clearTimeout() {},
    console,
    document,
    fetch(url) {
      fetchRequests.push(url);
      if (url === '/api/state') {
        if (stateFailure) return Promise.reject(new Error('state unavailable'));
        const payload = cameraStatus === undefined ?
          { enabled: true, running: true, online: true } : cameraStatus;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ camera: payload }) });
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
    setTimeout: () => ++timerId,
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
      normalizeToolSlots: normalizeToolSlots,
      render: render,
      sameJobKey: sameJobKey,
      setRoomVisible: setRoomVisible,
      syncCameraMode: syncCameraMode
    };
  ` + rawScript.slice(marker);
  vm.runInContext(instrumented, context, { filename: 'overlay.html' });

  return { api: context.__overlay, body, elements, fetchRequests, imageRequests, storage, window };
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
      { toolIndex: 1, toolLabel: 2, loaded: true, name: 'Galaxy Black', material: null, color: '#112233' },
    ],
  });
  assert.equal(normalized.list.length, 8);
  assert.equal(normalized.list[0].loaded, null);
  assert.equal(normalized.list[2].loaded, false);
  assert.equal(normalized.byLabel[2].name, 'Galaxy Black');
  assert.equal(normalized.byLabel[2].liveMaterial, 'PETG');
  assert.equal(normalized.byLabel[2].color, '#112233');
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
