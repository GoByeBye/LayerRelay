'use strict';

const assert = require('node:assert/strict');
const { test } = require('bun:test');
const {
  DEFAULT_OVERLAY_HOST,
  normalizeOverlayHost,
} = require('../overlay-host.js');

test('overlay host defaults to a neutral public identity', () => {
  assert.deepEqual(normalizeOverlayHost(), DEFAULT_OVERLAY_HOST);
  assert.deepEqual(normalizeOverlayHost(null), DEFAULT_OVERLAY_HOST);
  assert.deepEqual(normalizeOverlayHost('not an object'), DEFAULT_OVERLAY_HOST);
});

test('overlay host supports partial field-by-field configuration', () => {
  assert.deepEqual(normalizeOverlayHost({ name: 'Night Shift' }), {
    avatar: '3D',
    name: 'Night Shift',
    badge: 'LIVE',
    modeBadge: 'AUTO MODE',
    icon: null,
    iconMode: 'image',
  });
});

test('overlay host accepts only same-origin static icons and known presentation modes', () => {
  assert.deepEqual(normalizeOverlayHost({
    icon: '/assets/host-spritesheet.webp',
    iconMode: 'pet-atlas',
  }), {
    avatar: '3D',
    name: 'PRINT HOST',
    badge: 'LIVE',
    modeBadge: 'AUTO MODE',
    icon: '/assets/host-spritesheet.webp',
    iconMode: 'pet-atlas',
  });
  assert.equal(normalizeOverlayHost({ icon: 'https://example.com/tracker.png' }).icon, null);
  assert.equal(normalizeOverlayHost({ icon: '/assets/../config.json' }).icon, null);
  assert.equal(normalizeOverlayHost({ icon: '/api/camera.jpg' }).icon, null);
  assert.equal(normalizeOverlayHost({ icon: '/assets/host.png', iconMode: 'unknown' }).iconMode, 'image');
});

test('overlay host removes controls, bidi controls, and excess text without mutating input', () => {
  const input = {
    avatar: 'A\u202eI\n',
    name: '  Night\tHost  ',
    badge: `LIVE${'x'.repeat(40)}`,
    automationRunning: true,
    automationExpiresAt: Date.now() + 60000,
    ignored: 'not copied',
  };
  const before = { ...input };
  const normalized = normalizeOverlayHost(input);

  assert.equal(normalized.avatar, 'A I');
  assert.equal(normalized.name, 'Night Host');
  assert.equal(Array.from(normalized.badge).length, 24);
  assert.deepEqual(Object.keys(normalized), ['avatar', 'name', 'badge', 'modeBadge', 'icon', 'iconMode']);
  assert.equal(Object.hasOwn(normalized, 'automationRunning'), false);
  assert.deepEqual(input, before);
});

test('overlay host truncates by Unicode code point instead of splitting emoji', () => {
  const normalized = normalizeOverlayHost({ avatar: '🤖🤖🤖🤖🤖🤖🤖🤖🤖' });
  assert.equal(Array.from(normalized.avatar).length, 8);
  assert.equal(normalized.avatar, '🤖'.repeat(8));
});
