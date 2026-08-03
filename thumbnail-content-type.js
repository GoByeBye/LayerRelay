'use strict';

// Keep thumbnail responses limited to passive raster formats. In particular,
// SVG is an active document format and must never be served from this origin.
const SAFE_THUMBNAIL_CONTENT_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
]);

function safeThumbnailContentType(value) {
  const contentType = String(value || '').split(';')[0].trim().toLowerCase();
  return SAFE_THUMBNAIL_CONTENT_TYPES.has(contentType) ? contentType : null;
}

module.exports = { safeThumbnailContentType };
