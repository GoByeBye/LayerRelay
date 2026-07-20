'use strict';

// Node/Bun request `timeout` is a socket-idle timeout. It may never fire while a request is
// queued for an agent socket, resolving DNS, or recovering after system sleep. This independent
// wall-clock timer guarantees the caller settles and can schedule its next non-overlapping poll.
function armRequestDeadline(timeoutMs, onTimeout) {
  const delay = Math.max(1, Number(timeoutMs) || 10000);
  const timer = setTimeout(onTimeout, delay);
  return () => clearTimeout(timer);
}

module.exports = { armRequestDeadline };
