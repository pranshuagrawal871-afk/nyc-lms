/* Progress save rules shared by the player.
   Snapshots are immutable. The server, not this module, decides completion. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NYCProgress = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MAX_STREAM_REFRESH = 2;

  function captureSnapshot(fields) {
    const lessonId = Number(fields.lessonId);
    const watchedSeconds = Math.max(0, Math.floor(Number(fields.watchedSeconds) || 0));
    const duration = Math.max(0, Math.floor(Number(fields.duration) || 0));
    return Object.freeze({
      lessonId: lessonId,
      watchedSeconds: watchedSeconds,
      duration: duration,
      completed: fields.completed === true
    });
  }

  function canSaveProgress(syncState) {
    return syncState === "ready";
  }

  function courseProgressView(input) {
    const curriculum = input.curriculumState;
    const progress = input.progressState;
    if (curriculum === "loading" || progress === "loading") {
      return Object.freeze({ kind: "loading", label: "…", percent: null, courseCompleted: false });
    }
    if (curriculum !== "ready" || progress !== "ready") {
      return Object.freeze({ kind: "unknown", label: "—", percent: null, courseCompleted: false });
    }
    const total = Number(input.total) || 0;
    const completed = Number(input.completed) || 0;
    if (total <= 0) {
      return Object.freeze({ kind: "loaded", label: "0%", percent: 0, courseCompleted: false });
    }
    const percent = Math.floor((completed / total) * 100);
    return Object.freeze({
      kind: "loaded",
      label: percent + "%",
      percent: percent,
      courseCompleted: completed === total
    });
  }

  function planStreamRecovery(input) {
    const attempts = Number(input.attempts) || 0;
    const maxAttempts = Number.isFinite(Number(input.maxAttempts)) ? Number(input.maxAttempts) : MAX_STREAM_REFRESH;
    const code = Number(input.errorCode);
    if (attempts >= maxAttempts) return Object.freeze({ action: "fail", reason: "limit" });
    // 1 aborted, 3 decode. 2 network and 4 source are the expiry/auth shapes.
    if (code === 1 || code === 3) return Object.freeze({ action: "fail", reason: "unrecoverable" });
    return Object.freeze({ action: "refresh" });
  }

  async function deliverWithRetry(attempt, delays) {
    const schedule = delays || [0, 400, 1200];
    for (let index = 0; index < schedule.length; index += 1) {
      if (schedule[index]) await new Promise(function (resolve) { setTimeout(resolve, schedule[index]); });
      try {
        const result = await attempt();
        if (result === true || result === false) return result;
      } catch (_) {
        // Transient failures are retried until the schedule is exhausted.
      }
    }
    return false;
  }

  function createProgressQueue(send) {
    const queues = new Map();

    function enqueue(snapshot) {
      const lessonId = Number(snapshot && snapshot.lessonId);
      if (!Number.isInteger(lessonId) || lessonId <= 0) return Promise.resolve(false);
      const frozen = Object.freeze({
        lessonId: lessonId,
        watchedSeconds: Math.max(0, Math.floor(Number(snapshot.watchedSeconds) || 0)),
        duration: Math.max(0, Math.floor(Number(snapshot.duration) || 0)),
        completed: snapshot.completed === true
      });
      let queue = queues.get(lessonId);
      if (!queue) {
        queue = { pumping: false, pending: null, waiters: [] };
        queues.set(lessonId, queue);
      }
      queue.pending = frozen;
      return new Promise(function (resolve) {
        queue.waiters.push(resolve);
        if (!queue.pumping) pump(queue);
      });
    }

    function pump(queue) {
      queue.pumping = true;
      const step = function () {
        if (!queue.pending) {
          queue.pumping = false;
          if (queue.pending) pump(queue);
          return;
        }
        const snapshot = queue.pending;
        const waiters = queue.waiters.splice(0, queue.waiters.length);
        queue.pending = null;
        Promise.resolve()
          .then(function () { return send(snapshot); })
          .then(function (ok) { return ok === true; })
          .catch(function () { return false; })
          .then(function (ok) {
            waiters.forEach(function (resolve) { resolve(ok); });
            step();
          });
      };
      step();
    }

    return { enqueue: enqueue };
  }

  return {
    MAX_STREAM_REFRESH: MAX_STREAM_REFRESH,
    captureSnapshot: captureSnapshot,
    canSaveProgress: canSaveProgress,
    courseProgressView: courseProgressView,
    planStreamRecovery: planStreamRecovery,
    deliverWithRetry: deliverWithRetry,
    createProgressQueue: createProgressQueue
  };
});
