'use strict';

// Run at most one task at a time. A newer value cancels the active task and is
// started as soon as that task settles, so stale network work cannot block the
// latest job indefinitely or overlap it.
function createLatestWork(run, onError = () => {}) {
  let active = null;
  let pending = null;
  let hasPending = false;
  let idleWaiters = [];

  function notifyIdle() {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function launch(value) {
    const controller = new AbortController();
    const work = { controller, value };
    active = work;
    work.promise = Promise.resolve()
      .then(() => run(value, controller))
      .catch((error) => {
        if (!controller.signal.aborted) onError(error, value);
      })
      .finally(() => {
        if (active !== work) return;
        active = null;
        if (hasPending) {
          const next = pending;
          pending = null;
          hasPending = false;
          launch(next);
        } else {
          notifyIdle();
        }
      });
  }

  function schedule(value) {
    if (!active) {
      launch(value);
      return;
    }
    if (active.value === value && !hasPending && !active.controller.signal.aborted) return;
    pending = value;
    hasPending = true;
    active.controller.abort();
  }

  function cancel() {
    pending = null;
    hasPending = false;
    if (active) active.controller.abort();
    else notifyIdle();
  }

  function whenIdle() {
    if (!active && !hasPending) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  return { cancel, schedule, whenIdle };
}

module.exports = { createLatestWork };
