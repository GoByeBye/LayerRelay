'use strict';

const CLIENT_ERROR_MESSAGES = new Map([
  [400, 'invalid request body'],
  [403, 'request body rejected'],
  [413, 'request body too large'],
  [415, 'unsupported request body'],
]);

function clientErrorStatus(error) {
  for (const value of [error && error.status, error && error.statusCode]) {
    if (Number.isInteger(value) && value >= 400 && value < 500) return value;
  }
  return null;
}

function createHttpErrorHandler(logger = console) {
  return (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'request body too large' });
    }
    if (err instanceof SyntaxError && err && Object.hasOwn(err, 'body')) {
      return res.status(400).json({ error: 'invalid JSON body' });
    }

    const status = clientErrorStatus(err);
    if (status != null) {
      return res.status(status).json({
        error: CLIENT_ERROR_MESSAGES.get(status) || 'invalid request',
      });
    }

    try {
      logger.error(`[http] ${err && err.message ? err.message : 'unknown error'}`);
    } catch { /* Logging must not interfere with the error response. */ }
    return res.status(500).json({ error: 'internal server error' });
  };
}

module.exports = { createHttpErrorHandler };
