'use strict';

const https = require('node:https');
const { armRequestDeadline } = require('./request-deadline.js');

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function createHttpsRequest(options = {}) {
  const requestImpl = options.requestImpl || https.request;
  const agent = options.agent === undefined
    ? new https.Agent({ keepAlive: true, maxSockets: 2 })
    : options.agent;
  const maxResponseBytes = options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES;

  return function httpsRequest(host, { method, path, headers, signal }, body, timeoutMs = 12000, responseOptions = {}) {
    return new Promise((resolve, reject) => {
      const responseLimit = Number.isFinite(Number(responseOptions.maxResponseBytes))
        ? Math.max(1, Number(responseOptions.maxResponseBytes))
        : maxResponseBytes;
      let settled = false;
      let clearDeadline = () => {};
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearDeadline();
        reject(error);
      };
      const requestOptions = {
        host,
        method,
        path,
        headers: headers || {},
        timeout: timeoutMs,
        agent,
      };
      if (signal) requestOptions.signal = signal;
      let req;
      const timeoutRequest = () => {
        const error = new Error('request timeout');
        fail(error);
        if (req) req.destroy(error);
      };
      req = requestImpl(requestOptions, (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('aborted', () => fail(new Error('response aborted')));
        res.on('error', fail);
        const contentLength = Number(res.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > responseLimit) {
          const error = new Error(`response exceeds ${responseLimit} bytes`);
          fail(error);
          res.destroy(error);
          return;
        }
        res.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > responseLimit) {
            const error = new Error(`response exceeds ${responseLimit} bytes`);
            fail(error);
            res.destroy(error);
            return;
          }
          chunks.push(buffer);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearDeadline();
          const responseBody = Buffer.concat(chunks, bytes);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: responseOptions.asBuffer ? responseBody : responseBody.toString('utf8'),
          });
        });
      });
      req.on('error', fail);
      req.on('timeout', timeoutRequest);
      clearDeadline = armRequestDeadline(timeoutMs, timeoutRequest);
      if (body != null) req.write(body);
      req.end();
    });
  };
}

module.exports = {
  createHttpsRequest,
};
