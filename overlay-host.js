'use strict';

const DEFAULT_OVERLAY_HOST = Object.freeze({
  avatar: '3D',
  name: 'PRINT HOST',
  badge: 'LIVE',
  modeBadge: 'AUTO MODE',
  icon: null,
  iconMode: 'image',
});

const FIELD_LIMITS = Object.freeze({
  avatar: 8,
  name: 40,
  badge: 24,
  modeBadge: 24,
});

function cleanHostText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, maxLength).join('').trim();
}

function cleanHostIcon(value) {
  const path = cleanHostText(value, 200);
  if (!/^\/assets\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)) return null;
  if (path.includes('..') || path.includes('\\')) return null;
  return path;
}

function normalizeOverlayHost(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const icon = cleanHostIcon(input.icon);
  return Object.freeze({
    avatar: cleanHostText(input.avatar, FIELD_LIMITS.avatar) || DEFAULT_OVERLAY_HOST.avatar,
    name: cleanHostText(input.name, FIELD_LIMITS.name) || DEFAULT_OVERLAY_HOST.name,
    badge: cleanHostText(input.badge, FIELD_LIMITS.badge) || DEFAULT_OVERLAY_HOST.badge,
    modeBadge: cleanHostText(input.modeBadge, FIELD_LIMITS.modeBadge) || DEFAULT_OVERLAY_HOST.modeBadge,
    icon,
    iconMode: icon && input.iconMode === 'pet-atlas' ? 'pet-atlas' : 'image',
  });
}

module.exports = {
  DEFAULT_OVERLAY_HOST,
  FIELD_LIMITS,
  cleanHostIcon,
  cleanHostText,
  normalizeOverlayHost,
};
