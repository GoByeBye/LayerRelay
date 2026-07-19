'use strict';

const ACTIVE_JOB_STATES = new Set(['PRINTING', 'PAUSED']);
const NONTERMINAL_JOB_STATES = new Set(['BUSY', 'UNKNOWN']);

function normalizeState(value) {
  return String(value || '').trim().toUpperCase();
}

function isActiveJobState(value) {
  return ACTIVE_JOB_STATES.has(normalizeState(value));
}

function selectJobId(statusJob, job) {
  if (statusJob && statusJob.id != null) return statusJob.id;
  return job && job.id != null ? job.id : null;
}

function sameJobKey(left, right) {
  return !!(left && right && String(left).toLowerCase() === String(right).toLowerCase());
}

function jobKeysEqual(left, right) {
  return left === right || sameJobKey(left, right);
}

// BUSY is a bridge between a print and its eventual terminal state. Finalizing on
// BUSY would publish a fake BUSY completion before the printer reports IDLE/FINISHED.
function shouldFinalizeJobSnapshot(value) {
  const state = normalizeState(value);
  return !!state && !ACTIVE_JOB_STATES.has(state) && !NONTERMINAL_JOB_STATES.has(state);
}

module.exports = { isActiveJobState, jobKeysEqual, sameJobKey, selectJobId, shouldFinalizeJobSnapshot };
