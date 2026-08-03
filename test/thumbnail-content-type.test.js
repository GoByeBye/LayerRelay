'use strict';

const assert = require('node:assert/strict');
const { test } = require('bun:test');
const { safeThumbnailContentType } = require('../thumbnail-content-type.js');

test('accepts supported raster thumbnail content types', () => {
  assert.equal(safeThumbnailContentType('image/png'), 'image/png');
  assert.equal(safeThumbnailContentType('IMAGE/JPEG; charset=binary'), 'image/jpeg');
  assert.equal(safeThumbnailContentType(' image/webp '), 'image/webp');
});

test('rejects active and non-image thumbnail content types', () => {
  assert.equal(safeThumbnailContentType('image/svg+xml'), null);
  assert.equal(safeThumbnailContentType('text/html'), null);
  assert.equal(safeThumbnailContentType(''), null);
  assert.equal(safeThumbnailContentType(null), null);
});
