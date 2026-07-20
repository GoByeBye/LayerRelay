'use strict';

const { spawn } = require('child_process');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const FRAME_TRAILER = Buffer.from('\r\n');
const BOUNDARY = 'frame';

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInteger(value, fallback, min, max) {
  return Math.max(min, Math.min(max, Math.round(finiteNumber(value, fallback))));
}

function cleanCommand(value) {
  if (typeof value !== 'string') return null;
  const command = value.trim();
  return command && !/[\u0000\r\n]/.test(command) ? command : null;
}

function normalizeCameraOptions(config = {}) {
  const url = typeof config.cameraRtspUrl === 'string' ? config.cameraRtspUrl.trim() : '';
  const restartBaseMs = clampInteger(config.cameraStreamRestartBaseMs, 1000, 250, 30000);
  const requestedWidth = clampInteger(config.cameraStreamWidth, 1920, 320, 3840);

  return {
    enabled: !!url && config.cameraStreamEnabled !== false,
    url,
    ffmpegPath: cleanCommand(config.cameraFfmpegPath) || 'ffmpeg',
    fps: clampInteger(config.cameraStreamFps, 24, 1, 30),
    // An even width avoids encoder failures with common YUV pixel formats.
    width: requestedWidth - (requestedWidth % 2),
    jpegQuality: clampInteger(config.cameraStreamJpegQuality, 5, 2, 31),
    threads: clampInteger(config.cameraStreamThreads, 4, 1, 16),
    killGraceMs: clampInteger(config.cameraStreamKillGraceMs, 3000, 500, 10000),
    idleMs: clampInteger(config.cameraStreamIdleMs, 10000, 1000, 300000),
    stallMs: clampInteger(config.cameraStreamStallMs, 20000, 5000, 120000),
    ioTimeoutMs: clampInteger(config.cameraStreamIoTimeoutMs, 15000, 3000, 120000),
    restartBaseMs,
    restartMaxMs: Math.max(
      restartBaseMs,
      clampInteger(config.cameraStreamRestartMaxMs, 15000, 1000, 120000),
    ),
    maxFrameBytes: clampInteger(
      config.cameraStreamMaxFrameBytes,
      16 * 1024 * 1024,
      1024 * 1024,
      64 * 1024 * 1024,
    ),
  };
}

function buildFfmpegArgs(options) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-filter_threads', String(options.threads),
    '-rtsp_transport', 'tcp',
    // The RTSP demuxer calls this option `timeout`; the similarly named generic
    // `rw_timeout` appears in `-h full` but is rejected for RTSP by FFmpeg 8.x.
    '-timeout', String(options.ioTimeoutMs * 1000),
    // Auto thread selection used all 24 logical cores on the stream host and retained
    // hundreds of megabytes of codec buffers. Four threads comfortably sustain 1080p24.
    '-threads', String(options.threads),
    '-i', options.url,
    '-an',
    '-sn',
    '-dn',
    '-vf', `fps=${options.fps},scale=${options.width}:-2:flags=fast_bilinear`,
    '-q:v', String(options.jpegQuality),
    '-c:v', 'mjpeg',
    '-threads', String(options.threads),
    '-f', 'image2pipe',
    'pipe:1',
  ];
}

function redactCameraError(value, url) {
  let text = String(value || '')
    .replace(/rtsps?:\/\/[^\s'"<>]+/gi, 'rtsp://[redacted]')
    .replace(/\/\/[^\s/@:]+:[^\s/@]+@/g, '//[redacted]@');
  if (url) text = text.split(url).join('[camera]');
  return text.replace(/\s+/g, ' ').trim().slice(-400);
}

class CameraStream {
  constructor(config, dependencies = {}) {
    this.options = normalizeCameraOptions(config);
    this.spawn = dependencies.spawn || spawn;
    this.now = dependencies.now || Date.now;
    this.setTimeout = dependencies.setTimeout || setTimeout;
    this.clearTimeout = dependencies.clearTimeout || clearTimeout;
    this.clients = new Map();
    this.active = null;
    this.generation = 0;
    this.pending = Buffer.alloc(0);
    this.latestFrame = null;
    this.lastFrameAt = 0;
    this.frames = 0;
    this.rateWindowAt = 0;
    this.rateWindowFrames = 0;
    this.rateWindowBytes = 0;
    this.measuredFps = null;
    this.outputBytesPerSec = null;
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.nextRetryAt = 0;
    this.idleTimer = null;
    this.lastError = null;
    this.closed = false;
  }

  get enabled() {
    return this.options.enabled;
  }

  getStatus() {
    const now = this.now();
    const active = this.active;
    const currentFrame = !!active && active.frames > 0;
    const lastFrameAgeMs = this.lastFrameAt ? Math.max(0, now - this.lastFrameAt) : null;
    const online = !!(
      this.options.enabled
      && active
      && !active.expectedStop
      && currentFrame
      && lastFrameAgeMs <= this.options.stallMs
    );
    let state = 'idle';
    if (!this.options.enabled) state = 'disabled';
    else if (online) state = 'live';
    else if (this.clients.size && (this.restartTimer || this.restartAttempts)) state = 'reconnecting';
    else if (this.clients.size || active) state = 'connecting';

    return {
      enabled: this.options.enabled,
      running: !!active,
      online,
      state,
      subscribers: this.clients.size,
      lastFrameAt: this.lastFrameAt || null,
      lastFrameAgeMs,
      frames: this.frames,
      targetFps: this.options.fps,
      measuredFps: online ? this.measuredFps : null,
      outputWidth: this.options.width,
      jpegQuality: this.options.jpegQuality,
      threads: this.options.threads,
      latestFrameBytes: this.latestFrame ? this.latestFrame.length : null,
      outputBytesPerSec: online ? this.outputBytesPerSec : null,
      estimatedEgressBytesPerSec: online && this.outputBytesPerSec != null
        ? Math.round(this.outputBytesPerSec * this.clients.size)
        : null,
      restartAttempts: this.restartAttempts,
      restartInMs: this.nextRetryAt ? Math.max(0, this.nextRetryAt - now) : null,
      error: this.lastError,
    };
  }

  handleMjpeg(req, res) {
    if (!this.options.enabled || this.closed) {
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({ error: 'camera stream is disabled' });
    }

    res.status(200);
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const client = { res, blocked: false, closed: false };
    this.clients.set(res, client);
    this._clearIdleTimer();

    const remove = () => this._removeClient(client);
    req.once('aborted', remove);
    // IncomingMessage `close` means the request message completed on current Node
    // releases; for a bodyless GET that is not a subscriber disconnect. The response
    // close event remains tied to the streaming socket and aborted covers early requests.
    res.once('close', remove);

    if (this.latestFrame && this.lastFrameAt && this.now() - this.lastFrameAt <= this.options.stallMs) {
      this._writeFrame(client, this.latestFrame);
    }
    this._ensureStarted();
    return undefined;
  }

  handleSnapshot(_req, res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    if (!this.options.enabled || this.closed) {
      return res.status(503).json({ error: 'camera stream is disabled' });
    }
    if (!this.latestFrame) {
      res.set('Retry-After', '1');
      return res.status(503).json({ error: 'camera frame is not ready' });
    }
    res.set('X-Camera-Frame-Age-Ms', String(Math.max(0, this.now() - this.lastFrameAt)));
    return res.type('image/jpeg').send(this.latestFrame);
  }

  _ensureStarted() {
    if (!this.options.enabled || this.closed || this.active || this.restartTimer || !this.clients.size) return;
    this._startProcess();
  }

  _startProcess() {
    const record = {
      generation: ++this.generation,
      child: null,
      startedAt: this.now(),
      expectedStop: false,
      finished: false,
      frames: 0,
      watchdog: null,
      forceKillTimer: null,
      stderr: '',
    };
    this.pending = Buffer.alloc(0);
    this.rateWindowAt = 0;
    this.rateWindowFrames = 0;
    this.rateWindowBytes = 0;
    this.measuredFps = null;
    this.outputBytesPerSec = null;

    let child;
    try {
      child = this.spawn(this.options.ffmpegPath, buildFfmpegArgs(this.options), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      this.lastError = this._safeSpawnError(error);
      this.restartAttempts += 1;
      this._scheduleRestart();
      return;
    }

    record.child = child;
    this.active = record;
    this.nextRetryAt = 0;
    this.lastError = null;

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        if (this.active === record && !record.finished) this._consume(chunk, record);
      });
      child.stdout.once('error', (error) => {
        if (this.active === record && !record.finished) {
          this.lastError = redactCameraError(error && error.message, this.options.url) || 'Camera output failed';
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (record.finished) return;
        const safe = redactCameraError(chunk, this.options.url);
        record.stderr = `${record.stderr} ${safe}`.trim().slice(-400);
      });
    }

    child.once('error', (error) => {
      // A spawn failure has no pid and is safe to retry. An error from an already
      // running child (for example, a failed kill signal) is not proof that the old
      // ffmpeg exited; keep it authoritative until `close` so two readers can never
      // overlap.
      if (child.pid == null) this._finishProcess(record, this._safeSpawnError(error));
      else {
        this.lastError = this._safeSpawnError(error);
        this._armWatchdog(record);
      }
    });
    child.once('close', (code, signal) => {
      const detail = record.stderr || (signal ? `Camera relay stopped (${signal})` : `Camera relay exited (${code})`);
      this._finishProcess(record, detail);
    });
    this._armWatchdog(record);
  }

  _safeSpawnError(error) {
    if (error && error.code === 'ENOENT') return 'ffmpeg was not found';
    if (error && error.code === 'EACCES') return 'ffmpeg could not be executed';
    return redactCameraError(error && error.message, this.options.url) || 'Camera relay could not start';
  }

  _consume(chunk, record) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;

    while (this.pending.length) {
      const start = this.pending.indexOf(SOI);
      if (start < 0) {
        this.pending = this.pending[this.pending.length - 1] === 0xff
          ? this.pending.subarray(this.pending.length - 1)
          : Buffer.alloc(0);
        return;
      }
      if (start > 0) this.pending = this.pending.subarray(start);

      const end = this.pending.indexOf(EOI, 2);
      if (end < 0) {
        if (this.pending.length > this.options.maxFrameBytes) {
          const nextStart = this.pending.lastIndexOf(SOI);
          this.pending = nextStart > 0
            ? this.pending.subarray(nextStart)
            : Buffer.alloc(0);
          this.lastError = 'Oversized camera frame dropped';
        }
        return;
      }

      const frameEnd = end + EOI.length;
      const frame = this.pending.subarray(0, frameEnd);
      this.pending = this.pending.subarray(frameEnd);
      if (frame.length > this.options.maxFrameBytes) {
        this.lastError = 'Oversized camera frame dropped';
        continue;
      }
      this._publish(frame, record);
    }
  }

  _publish(frame, record) {
    if (this.active !== record || record.finished) return;
    // Copy once because stdout's backing buffer may be reused after this callback.
    this.latestFrame = Buffer.from(frame);
    this.lastFrameAt = this.now();
    this.frames += 1;
    record.frames += 1;
    this._recordRate(this.lastFrameAt, this.latestFrame.length);
    this.restartAttempts = 0;
    this.lastError = null;
    this._armWatchdog(record);
    for (const client of this.clients.values()) this._writeFrame(client, this.latestFrame);
  }

  _writeFrame(client, frame) {
    if (client.closed || client.blocked || client.res.destroyed || client.res.writableEnded) return;
    const header = `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
    let writable = true;
    const onDrain = () => {
      if (!client.closed) client.blocked = false;
    };
    // Arm backpressure before writing: a local browser can drain a frame before code
    // after `write()` gets another turn. Pessimistically block until every write succeeds
    // or the response confirms its queued bytes have drained.
    client.blocked = true;
    client.res.once('drain', onDrain);
    try {
      // Keep these as separate writes so the shared immutable JPEG is not copied into a
      // per-viewer multipart Buffer. ServerResponse.cork() cannot be used here: on current
      // Node releases it can leave writableNeedDrain set without emitting `drain`.
      const headerOk = client.res.write(header);
      const frameOk = client.res.write(frame);
      const trailerOk = client.res.write(FRAME_TRAILER);
      writable = headerOk && frameOk && trailerOk;
      if (writable) {
        client.res.removeListener('drain', onDrain);
        client.blocked = false;
      }
    } catch (_error) {
      client.res.removeListener('drain', onDrain);
      this._removeClient(client);
      return;
    }
  }

  _recordRate(now, bytes) {
    if (!this.rateWindowAt) {
      this.rateWindowAt = now;
      return;
    }
    this.rateWindowFrames += 1;
    this.rateWindowBytes += bytes;
    const elapsedMs = now - this.rateWindowAt;
    if (elapsedMs < 1000) return;
    this.measuredFps = Math.round((this.rateWindowFrames * 100000) / elapsedMs) / 100;
    this.outputBytesPerSec = Math.round((this.rateWindowBytes * 1000) / elapsedMs);
    this.rateWindowAt = now;
    this.rateWindowFrames = 0;
    this.rateWindowBytes = 0;
  }

  _removeClient(client) {
    if (!client || client.closed) return;
    client.closed = true;
    this.clients.delete(client.res);
    if (!this.clients.size && !this.closed) this._scheduleIdleStop();
  }

  _scheduleIdleStop() {
    this._clearIdleTimer();
    this.idleTimer = this.setTimeout(() => {
      this.idleTimer = null;
      if (!this.clients.size) {
        this._clearRestartTimer();
        this._stopActive(true);
      }
    }, this.options.idleMs);
    if (this.idleTimer && typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  _clearIdleTimer() {
    if (!this.idleTimer) return;
    this.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  _armWatchdog(record) {
    if (record.watchdog) this.clearTimeout(record.watchdog);
    record.watchdog = this.setTimeout(() => {
      record.watchdog = null;
      if (this.active !== record || record.finished || record.expectedStop) return;
      this.lastError = 'Camera stream stalled';
      const killed = record.child && record.child.kill('SIGTERM');
      if (!killed) this._finishProcess(record, this.lastError);
      else this._armForceKill(record);
    }, this.options.stallMs);
    if (record.watchdog && typeof record.watchdog.unref === 'function') record.watchdog.unref();
  }

  _stopActive(expected) {
    const record = this.active;
    if (!record || record.finished) return;
    record.expectedStop = expected;
    if (record.watchdog) {
      this.clearTimeout(record.watchdog);
      record.watchdog = null;
    }
    const killed = record.child && record.child.kill('SIGTERM');
    if (!killed) this._finishProcess(record, expected ? null : this.lastError);
    else this._armForceKill(record);
  }

  _armForceKill(record) {
    if (!record || record.finished || record.forceKillTimer) return;
    record.forceKillTimer = this.setTimeout(() => {
      record.forceKillTimer = null;
      if (record.finished || this.active !== record) return;
      const killed = record.child && record.child.kill('SIGKILL');
      if (!killed) this._finishProcess(record, record.expectedStop ? null : this.lastError);
    }, this.options.killGraceMs);
    if (record.forceKillTimer && typeof record.forceKillTimer.unref === 'function') {
      record.forceKillTimer.unref();
    }
  }

  _finishProcess(record, detail) {
    if (!record || record.finished) return;
    record.finished = true;
    if (record.watchdog) this.clearTimeout(record.watchdog);
    record.watchdog = null;
    if (record.forceKillTimer) this.clearTimeout(record.forceKillTimer);
    record.forceKillTimer = null;
    if (this.active === record) this.active = null;
    this.pending = Buffer.alloc(0);

    if (this.closed) return;
    if (record.expectedStop) {
      if (this.clients.size) this._ensureStarted();
      return;
    }

    this.lastError = redactCameraError(detail, this.options.url) || 'Camera relay stopped';
    this.restartAttempts += 1;
    if (this.clients.size) this._scheduleRestart();
  }

  _scheduleRestart() {
    if (this.closed || this.restartTimer || this.active || !this.clients.size) return;
    const exponent = Math.max(0, this.restartAttempts - 1);
    const delay = Math.min(this.options.restartBaseMs * (2 ** Math.min(exponent, 10)), this.options.restartMaxMs);
    this.nextRetryAt = this.now() + delay;
    this.restartTimer = this.setTimeout(() => {
      this.restartTimer = null;
      this.nextRetryAt = 0;
      this._ensureStarted();
    }, delay);
    if (this.restartTimer && typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
  }

  _clearRestartTimer() {
    if (!this.restartTimer) return;
    this.clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.nextRetryAt = 0;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._clearIdleTimer();
    this._clearRestartTimer();
    for (const client of this.clients.values()) {
      client.closed = true;
      try { client.res.end(); } catch (_error) { /* already closed */ }
    }
    this.clients.clear();
    this._stopActive(true);
  }
}

module.exports = {
  BOUNDARY,
  CameraStream,
  buildFfmpegArgs,
  normalizeCameraOptions,
  redactCameraError,
};
