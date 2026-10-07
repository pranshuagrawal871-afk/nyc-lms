const test = require("node:test");
const assert = require("node:assert/strict");
const progress = require("../../frontend/js/progressClient");

test("completion snapshot does not follow later player state", () => {
    const source = { lessonId: 4, watchedSeconds: 100.9, duration: 100.2, completed: true };
    const snapshot = progress.captureSnapshot(source);
    source.lessonId = 9;
    source.watchedSeconds = 900;
    source.duration = 900;
    source.completed = false;
    assert.deepEqual(snapshot, { lessonId: 4, watchedSeconds: 100, duration: 100, completed: true });
    assert.equal(Object.isFrozen(snapshot), true);
});

test("progress saves wait until a successful read", () => {
    assert.equal(progress.canSaveProgress("ready"), true);
    assert.equal(progress.canSaveProgress("unknown"), false);
    assert.equal(progress.canSaveProgress("error"), false);
    assert.equal(progress.canSaveProgress("loading"), false);
});

test("partial curriculum cannot be presented as course completion", () => {
    assert.equal(progress.courseProgressView({
        curriculumState: "incomplete",
        progressState: "ready",
        total: 1,
        completed: 1
    }).courseCompleted, false);
    assert.equal(progress.courseProgressView({
        curriculumState: "ready",
        progressState: "ready",
        total: 2,
        completed: 0
    }).label, "0%");
    assert.equal(progress.courseProgressView({
        curriculumState: "ready",
        progressState: "ready",
        total: 2,
        completed: 2
    }).courseCompleted, true);
    assert.equal(progress.courseProgressView({
        curriculumState: "loading",
        progressState: "loading",
        total: 0,
        completed: 0
    }).kind, "loading");
    assert.equal(progress.courseProgressView({
        curriculumState: "error",
        progressState: "unknown",
        total: 1,
        completed: 1
    }).kind, "unknown");
});

test("latest progress snapshot is sent and lessons are not mixed", async () => {
    const sent = [];
    let releaseFirst;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    const queue = progress.createProgressQueue(async (snapshot) => {
        sent.push({ lessonId: snapshot.lessonId, watchedSeconds: snapshot.watchedSeconds, duration: snapshot.duration });
        if (snapshot.lessonId === 1 && snapshot.watchedSeconds === 10) await gate;
        return true;
    });

    const first = queue.enqueue({ lessonId: 1, watchedSeconds: 10, duration: 100, completed: false });
    await new Promise((resolve) => setImmediate(resolve));
    const latest = queue.enqueue({ lessonId: 1, watchedSeconds: 90, duration: 100, completed: false });
    const other = queue.enqueue({ lessonId: 2, watchedSeconds: 5, duration: 40, completed: false });
    releaseFirst();
    assert.deepEqual(await Promise.all([first, latest, other]), [true, true, true]);

    const lessonOne = sent.filter((item) => item.lessonId === 1).map((item) => item.watchedSeconds);
    assert.deepEqual(lessonOne, [10, 90]);
    assert.deepEqual(sent.find((item) => item.lessonId === 2), { lessonId: 2, watchedSeconds: 5, duration: 40 });
    assert.ok(sent.filter((item) => item.lessonId === 1).every((item) => item.duration === 100));
});

test("a failed progress delivery is retried", async () => {
    let calls = 0;
    const saved = await progress.deliverWithRetry(async () => {
        calls += 1;
        if (calls < 3) return "retry";
        return true;
    }, [0, 0, 0]);
    assert.equal(saved, true);
    assert.equal(calls, 3);
});

test("stream authorization refresh stops after the attempt limit", () => {
    assert.equal(progress.planStreamRecovery({ errorCode: 2, attempts: 0, maxAttempts: 2 }).action, "refresh");
    assert.equal(progress.planStreamRecovery({ errorCode: 4, attempts: 1, maxAttempts: 2 }).action, "refresh");
    assert.equal(progress.planStreamRecovery({ errorCode: 2, attempts: 2, maxAttempts: 2 }).reason, "limit");
    assert.equal(progress.planStreamRecovery({ errorCode: 3, attempts: 0, maxAttempts: 2 }).action, "fail");
});
