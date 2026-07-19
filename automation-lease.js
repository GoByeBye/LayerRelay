'use strict';

function clampDuration(value, fallback = 45000) {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return fallback;
  return Math.max(15000, Math.min(300000, Math.round(duration)));
}

class AutomationLease {
  constructor({ durationMs, now } = {}) {
    this.durationMs = clampDuration(durationMs);
    this.now = typeof now === 'function' ? now : Date.now;
    this.expiresAt = 0;
  }

  heartbeat() {
    this.expiresAt = this.now() + this.durationMs;
    return this.status();
  }

  clear() {
    this.expiresAt = 0;
    return this.status();
  }

  isRunning() {
    return this.expiresAt > this.now();
  }

  status() {
    const now = this.now();
    const running = this.expiresAt > now;
    return {
      running,
      expiresAt: running ? this.expiresAt : null,
      expiresInMs: running ? Math.max(0, this.expiresAt - now) : 0,
      leaseMs: this.durationMs,
    };
  }
}

module.exports = {
  AutomationLease,
  clampDuration,
};
