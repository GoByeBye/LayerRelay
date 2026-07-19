'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

function normalizedIpAddress(address) {
  const value = String(address || '').trim().toLowerCase().split('%')[0];
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}

function isLoopbackAddress(address) {
  const value = normalizedIpAddress(address);
  if (value === '::1') return true;
  return net.isIP(value) === 4 && value.split('.')[0] === '127';
}

function safeTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parsedAuthority(value, protocol = 'http:') {
  const raw = String(value || '').trim();
  if (!raw || /[\r\n]/.test(raw)) return null;
  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`${protocol}//${raw}`);
    if (url.username || url.password) return null;
    return { host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase().replace(/\.$/, '') };
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return value === 'localhost' || isLoopbackAddress(value);
}

function isSafeLocalBrowserRequest({ host, origin, secFetchSite }) {
  // A Host header is an authority, never a full URL. Rejecting schemes also keeps
  // URL's permissive parser from accepting browser-controlled lookalikes.
  if (String(host || '').includes('://')) return false;
  const requestAuthority = parsedAuthority(host);
  if (!requestAuthority || !isLoopbackHostname(requestAuthority.hostname)) return false;

  const fetchSite = String(secFetchSite || '').trim().toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  if (!origin) return true;

  const originText = String(origin || '').trim();
  if (!/^https?:\/\//i.test(originText)) return false;
  const originAuthority = parsedAuthority(originText);
  return !!originAuthority && isLoopbackHostname(originAuthority.hostname) &&
    originAuthority.host === requestAuthority.host;
}

function canWrite({ remoteAddress, host, origin, secFetchSite, suppliedToken, expectedToken }) {
  // Once an operator configures a token, require it everywhere. This avoids a local
  // reverse proxy silently turning socket-loopback into an authentication bypass.
  if (expectedToken) return safeTokenEqual(suppliedToken, expectedToken);

  // Tokenless mode is a convenience for a strictly local native install. Check both
  // the socket and browser-controlled headers to reject remote clients, DNS rebinding,
  // and cross-origin browser POSTs.
  return isLoopbackAddress(remoteAddress) && isSafeLocalBrowserRequest({ host, origin, secFetchSite });
}

module.exports = {
  canWrite,
  isLoopbackAddress,
  isLoopbackHostname,
  isSafeLocalBrowserRequest,
  parsedAuthority,
  safeTokenEqual,
};
