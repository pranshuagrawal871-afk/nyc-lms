const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const app = require("../server");
const pool = require("../config/db");
const { ensureSchema } = require("../lib/schema");
const { cleanupRetiredMedia, compatibilityError } = require("../lib/mediaLifecycle");
const { removeContent } = require("../lib/contentRemoval");

const password = "test-pass-1234";
const userIds = [];
const courseIds = [];
const markerName = `integrity-${Date.now()}.bin`;
const markerPath = path.join(__dirname, "../uploads", markerName);
let server;
let adminToken;
let passwordHash;

function request(method, requestPath, { token, body } = {}) {
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port: server.address().port,
            path: requestPath,
            method,
            headers: {
                ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            }
        }, (res) => {
            let raw = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { raw += chunk; });
            res.on("end", () => {
                let parsed = {};
                if (raw) {
                    try { parsed = JSON.parse(raw); }
                    catch (_) { parsed = { raw }; }
                }
                resolve({ status: res.statusCode, body: parsed, raw });
            });
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function createUser(role) {
    const email = `integrity-${role}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    const result = await pool.query(
        `INSERT INTO users (name, email, password, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email`,
        [`Integrity ${role}`, email, passwordHash, role]
    );
    userIds.push(result.rows[0].id);
    const login = await request("POST", "/api/auth/login", { body: { email, password } });
    assert.equal(login.status, 200, login.raw);
    return { id: result.rows[0].id, email, token: login.body.token };
}

async function createDraftCourse() {
    const created = await request("POST", "/api/courses", {
        token: adminToken,
        body: { title: `Integrity ${Date.now()}`, description: "Test course", published: false }
    });
    assert.equal(created.status, 201, created.raw);
    courseIds.push(created.body.course.id);
    return created.body.course;
}

async function createPlayableLesson(courseId) {
    const module = await request("POST", `/api/modules/course/${courseId}`, {
        token: adminToken,
        body: { title: "Module", module_order: 1 }
    });
    assert.equal(module.status, 201, module.raw);
    const lesson = await request("POST", `/api/lessons/module/${module.body.module.id}`, {
        token: adminToken,
        body: { title: "Lesson", type: "video", lesson_order: 1 }
    });
    assert.equal(lesson.status, 201, lesson.raw);
    await pool.query(
        "UPDATE lessons SET file_path = $1, duration = 100 WHERE id = $2",
        [markerName, lesson.body.lesson.id]
    );
    return { moduleId: module.body.module.id, lessonId: lesson.body.lesson.id };
}

test.describe("learning integrity", { concurrency: 1 }, () => {
    test.before(async () => {
        await ensureSchema();
        passwordHash = await bcrypt.hash(password, 4);
        await fs.writeFile(markerPath, "integrity-marker");
        server = await new Promise((resolve) => {
            const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
        });
        const admin = await createUser("admin");
        adminToken = admin.token;
    });

    test.after(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
        if (courseIds.length) await pool.query("DELETE FROM courses WHERE id = ANY($1::int[])", [courseIds]);
        if (userIds.length) await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [userIds]);
        await pool.query("DELETE FROM retired_media WHERE object_path = $1", [markerName]);
        await fs.unlink(markerPath).catch(() => {});
        await pool.end();
    });

    test("completion survives an ordinary progress save and a concurrent false save", async () => {
        const course = await createDraftCourse();
        const { lessonId } = await createPlayableLesson(course.id);
        const student = await createUser("student");
        const enrolled = await request("POST", "/api/enrollments", {
            token: student.token,
            body: { course_id: course.id }
        });
        assert.equal(enrolled.status, 403);

        await request("PATCH", `/api/courses/${course.id}`, {
            token: adminToken,
            body: { published: true }
        });
        const open = await request("POST", "/api/enrollments", {
            token: student.token,
            body: { course_id: course.id }
        });
        assert.equal(open.status, 201, open.raw);

        const saved = await request("POST", "/api/progress", {
            token: student.token,
            body: { lesson_id: lessonId, watched_seconds: 100, duration: 100, completed: true }
        });
        assert.equal(saved.status, 200, saved.raw);
        assert.equal(saved.body.progress.completed, true);

        const ordinary = await request("POST", "/api/progress", {
            token: student.token,
            body: { lesson_id: lessonId, watched_seconds: 12, duration: 100, completed: false }
        });
        assert.equal(ordinary.status, 200, ordinary.raw);
        assert.equal(ordinary.body.progress.completed, true);
        assert.equal(Number(ordinary.body.progress.watched_seconds), 12);

        await Promise.all([
            request("POST", "/api/progress", {
                token: student.token,
                body: { lesson_id: lessonId, watched_seconds: 20, duration: 100, completed: false }
            }),
            request("POST", "/api/progress", {
                token: student.token,
                body: { lesson_id: lessonId, watched_seconds: 30, duration: 100, completed: false }
            })
        ]);
        const stored = await pool.query(
            "SELECT completed, watched_seconds FROM progress WHERE user_id = $1 AND lesson_id = $2",
            [student.id, lessonId]
        );
        assert.equal(stored.rows[0].completed, true);

        const reset = await request("POST", `/api/progress/${lessonId}/reset`, {
            token: student.token,
            body: { reset_completion: true }
        });
        assert.equal(reset.status, 200, reset.raw);
        assert.equal(reset.body.progress.completed, false);
    });

    test("a non-enrolled student cannot create progress", async () => {
        const course = await createDraftCourse();
        const { lessonId } = await createPlayableLesson(course.id);
        await request("PATCH", `/api/courses/${course.id}`, { token: adminToken, body: { published: true } });
        const stranger = await createUser("student");
        const before = await pool.query("SELECT COUNT(*) FROM progress WHERE user_id = $1 AND lesson_id = $2", [stranger.id, lessonId]);
        const denied = await request("POST", "/api/progress", {
            token: stranger.token,
            body: { lesson_id: lessonId, watched_seconds: 10, duration: 100, completed: true }
        });
        assert.equal(denied.status, 403);
        const after = await pool.query("SELECT COUNT(*) FROM progress WHERE user_id = $1 AND lesson_id = $2", [stranger.id, lessonId]);
        assert.equal(after.rows[0].count, before.rows[0].count);
        const missing = await request("POST", "/api/progress", {
            token: stranger.token,
            body: { lesson_id: 99999999, watched_seconds: 1, duration: 10, completed: true }
        });
        assert.equal(missing.status, 404);
        const badId = await request("GET", "/api/progress/-1", { token: stranger.token });
        assert.equal(badId.status, 400);
    });

    test("watched seconds cannot exceed the lesson duration", async () => {
        const course = await createDraftCourse();
        const { lessonId } = await createPlayableLesson(course.id);
        await request("PATCH", `/api/courses/${course.id}`, { token: adminToken, body: { published: true } });
        const student = await createUser("student");
        await request("POST", "/api/enrollments", { token: student.token, body: { course_id: course.id } });
        const rejected = await request("POST", "/api/progress", {
            token: student.token,
            body: { lesson_id: lessonId, watched_seconds: 900, duration: 900, completed: true }
        });
        assert.equal(rejected.status, 400);
        assert.equal(rejected.raw.includes("stack"), false);
        const rows = await pool.query("SELECT COUNT(*) FROM progress WHERE user_id = $1 AND lesson_id = $2", [student.id, lessonId]);
        assert.equal(Number(rows.rows[0].count), 0);
    });

    test("unpublished courses stay available to enrolled students only", async () => {
        const course = await createDraftCourse();
        const { moduleId, lessonId } = await createPlayableLesson(course.id);
        const published = await request("PATCH", `/api/courses/${course.id}`, {
            token: adminToken,
            body: { published: true }
        });
        assert.equal(published.status, 200, published.raw);

        const enrolled = await createUser("student");
        const outsider = await createUser("student");
        assert.equal((await request("POST", "/api/enrollments", {
            token: enrolled.token,
            body: { course_id: course.id }
        })).status, 201);

        const hidden = await request("PATCH", `/api/courses/${course.id}`, {
            token: adminToken,
            body: { published: false }
        });
        assert.equal(hidden.status, 200, hidden.raw);

        const enrolledCourse = await request("GET", `/api/courses/${course.id}`, { token: enrolled.token });
        assert.equal(enrolledCourse.status, 200, enrolledCourse.raw);
        const outsiderCourse = await request("GET", `/api/courses/${course.id}`, { token: outsider.token });
        assert.equal(outsiderCourse.status, 403);
        const adminCourse = await request("GET", `/api/courses/${course.id}`, { token: adminToken });
        assert.equal(adminCourse.status, 200);
        const catalog = await request("GET", "/api/courses", { token: outsider.token });
        assert.equal(catalog.body.some((item) => Number(item.id) === Number(course.id)), false);

        const modules = await request("GET", `/api/modules/course/${course.id}`, { token: enrolled.token });
        assert.equal(modules.status, 200, modules.raw);
        const blockedModules = await request("GET", `/api/modules/course/${course.id}`, { token: outsider.token });
        assert.equal(blockedModules.status, 403);
        const stream = await request("GET", `/api/stream/token/${lessonId}`, { token: enrolled.token });
        assert.equal(stream.status, 200, stream.raw);
        const blockedStream = await request("GET", `/api/stream/token/${lessonId}`, { token: outsider.token });
        assert.equal(blockedStream.status, 403);
        const newEnrollment = await request("POST", "/api/enrollments", {
            token: outsider.token,
            body: { course_id: course.id }
        });
        assert.equal(newEnrollment.status, 403);
        assert.equal(moduleId > 0, true);
    });

    test("incomplete courses cannot be published and a new lesson returns a published course to draft", async () => {
        const course = await createDraftCourse();
        const blocked = await request("PATCH", `/api/courses/${course.id}`, {
            token: adminToken,
            body: { published: true }
        });
        assert.equal(blocked.status, 400);

        const { lessonId } = await createPlayableLesson(course.id);
        const ready = await request("PATCH", `/api/courses/${course.id}`, {
            token: adminToken,
            body: { published: true }
        });
        assert.equal(ready.status, 200, ready.raw);

        const added = await request("POST", `/api/lessons/module/${(await pool.query("SELECT module_id FROM lessons WHERE id = $1", [lessonId])).rows[0].module_id}`, {
            token: adminToken,
            body: { title: "Missing media", type: "video", lesson_order: 2 }
        });
        assert.equal(added.status, 201, added.raw);
        assert.equal(added.body.course_unpublished, true);
        const stored = await pool.query("SELECT published FROM courses WHERE id = $1", [course.id]);
        assert.equal(stored.rows[0].published, false);

        const student = await createUser("student");
        await pool.query("UPDATE courses SET published = true WHERE id = $1", [course.id]);
        await request("POST", "/api/enrollments", { token: student.token, body: { course_id: course.id } });
        const visible = await request("GET", `/api/lessons/module/${(await pool.query("SELECT module_id FROM lessons WHERE id = $1", [lessonId])).rows[0].module_id}`, {
            token: student.token
        });
        assert.equal(visible.body.some((lesson) => lesson.title === "Missing media"), false);
        assert.equal(visible.body.some((lesson) => Number(lesson.id) === Number(lessonId)), true);
    });

    test("module and lesson titles reject non-strings before trim", async () => {
        const course = await createDraftCourse();
        const values = [1, ["Module"], { title: "Module" }, null, "", "   ", "x".repeat(201)];
        for (const title of values) {
            const response = await request("POST", `/api/modules/course/${course.id}`, {
                token: adminToken,
                body: { title, module_order: 1 }
            });
            assert.equal(response.status, 400, `${JSON.stringify(title)} -> ${response.raw}`);
            assert.equal(response.raw.includes("stack"), false);
        }
        const module = await request("POST", `/api/modules/course/${course.id}`, {
            token: adminToken,
            body: { title: "Valid module", module_order: 1 }
        });
        assert.equal(module.status, 201, module.raw);
        for (const title of [2, ["Lesson"], { title: "Lesson" }, null, "", "   ", "y".repeat(201)]) {
            const response = await request("POST", `/api/lessons/module/${module.body.module.id}`, {
                token: adminToken,
                body: { title, type: "video", lesson_order: 1 }
            });
            assert.equal(response.status, 400, `${JSON.stringify(title)} -> ${response.raw}`);
        }
        const missing = await request("POST", "/api/modules/course/99999999", {
            token: adminToken,
            body: { title: "Orphan", module_order: 1 }
        });
        assert.equal(missing.status, 404);
        const missingLesson = await request("POST", "/api/lessons/module/99999999", {
            token: adminToken,
            body: { title: "Orphan lesson", type: "video" }
        });
        assert.equal(missingLesson.status, 404);
    });

    test("repeated enrollment is idempotent", async () => {
        const course = await createDraftCourse();
        await createPlayableLesson(course.id);
        await request("PATCH", `/api/courses/${course.id}`, { token: adminToken, body: { published: true } });
        const student = await createUser("student");
        const responses = await Promise.all([
            request("POST", "/api/enrollments", { token: student.token, body: { course_id: course.id } }),
            request("POST", "/api/enrollments", { token: student.token, body: { course_id: course.id } }),
            request("POST", "/api/enrollments", { token: student.token, body: { course_id: course.id } })
        ]);
        assert.ok(responses.every((response) => response.status === 200 || response.status === 201));
        const rows = await pool.query(
            "SELECT COUNT(*) FROM enrollments WHERE user_id = $1 AND course_id = $2",
            [student.id, course.id]
        );
        assert.equal(Number(rows.rows[0].count), 1);
    });

    test("completed courses count enrollments rather than distinct students", async () => {
        const before = await request("GET", "/api/admin/analytics", { token: adminToken });
        assert.equal(before.status, 200, before.raw);
        const student = await createUser("student");
        for (let index = 0; index < 2; index += 1) {
            const course = await createDraftCourse();
            const { lessonId } = await createPlayableLesson(course.id);
            await request("PATCH", `/api/courses/${course.id}`, { token: adminToken, body: { published: true } });
            await request("POST", "/api/enrollments", { token: student.token, body: { course_id: course.id } });
            const saved = await request("POST", "/api/progress", {
                token: student.token,
                body: { lesson_id: lessonId, watched_seconds: 100, duration: 100, completed: true }
            });
            assert.equal(saved.status, 200, saved.raw);
        }
        const after = await request("GET", "/api/admin/analytics", { token: adminToken });
        assert.equal(
            Number(after.body.completed_courses),
            Number(before.body.completed_courses) + 2
        );
    });

    test("password change revokes old tokens and accepts the new password", async () => {
        const student = await createUser("student");
        const changed = await request("POST", "/api/auth/change-password", {
            token: student.token,
            body: { currentPassword: password, newPassword: "new-pass-1234" }
        });
        assert.equal(changed.status, 200, changed.raw);
        assert.equal(JSON.stringify(changed.body).includes(password), false);
        const oldSession = await request("GET", "/api/auth/me", { token: student.token });
        assert.equal(oldSession.status, 401);
        const loggedIn = await request("POST", "/api/auth/login", {
            body: { email: student.email, password: "new-pass-1234" }
        });
        assert.equal(loggedIn.status, 200, loggedIn.raw);
        const fresh = await request("GET", "/api/auth/me", { token: loggedIn.body.token });
        assert.equal(fresh.status, 200, fresh.raw);
        const forged = jwt.sign(
            { id: student.id, role: "student", email: student.email, sv: 0 },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        );
        const rejected = await request("GET", "/api/auth/me", { token: forged });
        assert.equal(rejected.status, 401);
    });

    test("login attempts are rate limited by account", async () => {
        const student = await createUser("student");
        let limited = null;
        for (let attempt = 0; attempt < 25; attempt += 1) {
            limited = await request("POST", "/api/auth/login", {
                body: { email: student.email, password: "wrong-password" }
            });
            if (limited.status === 429) break;
        }
        assert.equal(limited.status, 429);
    });

    test("retired media is kept until its grace period and a referenced file is not deleted", async () => {
        const future = await pool.query(
            `INSERT INTO retired_media (bucket, object_path, delete_after)
             VALUES ('local-uploads', $1, CURRENT_TIMESTAMP + INTERVAL '2 days')
             RETURNING id`,
            [markerName]
        );
        await cleanupRetiredMedia();
        const waiting = await pool.query("SELECT deleted_at FROM retired_media WHERE id = $1", [future.rows[0].id]);
        assert.equal(waiting.rows[0].deleted_at, null);
        await fs.access(markerPath);

        const course = await createDraftCourse();
        const { lessonId } = await createPlayableLesson(course.id);
        await pool.query("UPDATE lessons SET file_path = $1 WHERE id = $2", [markerName, lessonId]);
        const due = await pool.query(
            `INSERT INTO retired_media (bucket, object_path, delete_after)
             VALUES ('local-uploads', $1, CURRENT_TIMESTAMP - INTERVAL '1 minute')
             RETURNING id`,
            [markerName]
        );
        await cleanupRetiredMedia();
        await fs.access(markerPath);
        const kept = await pool.query("SELECT deleted_at FROM retired_media WHERE id = $1", [due.rows[0].id]);
        assert.ok(kept.rows[0].deleted_at);
        await pool.query("DELETE FROM retired_media WHERE id = ANY($1::bigint[])", [[future.rows[0].id, due.rows[0].id]]);
    });

    test("browser compatibility is based on codec, not duration alone", () => {
        assert.equal(compatibilityError(".mp4", [
            { codec_type: "video", codec_name: "hevc" },
            { codec_type: "audio", codec_name: "aac" }
        ]) !== null, true);
        assert.equal(compatibilityError(".mp4", [
            { codec_type: "video", codec_name: "h264" },
            { codec_type: "audio", codec_name: "aac" }
        ]), null);
    });

    test("student pages do not multiply rows", async () => {
        const page = await request("GET", "/api/admin/students?page=1&limit=5", { token: adminToken });
        assert.equal(page.status, 200, page.raw);
        assert.ok(Array.isArray(page.body.students));
        assert.equal(page.body.limit, 5);
        assert.ok(page.body.total >= page.body.students.length);
        const badTitle = await request("POST", "/api/modules/course/0", {
            token: adminToken,
            body: { title: "Nope" }
        });
        assert.equal(badTitle.status, 400);
    });

    test("an admin can delete a lesson and a non-admin cannot", async () => {
        const course = await createDraftCourse();
        const { lessonId, moduleId } = await createPlayableLesson(course.id);
        const student = await createUser("student");
        const denied = await request("DELETE", `/api/lessons/${lessonId}`, {
            token: student.token,
            body: { confirm: true }
        });
        assert.equal(denied.status, 403, denied.raw);
        const moduleDenied = await request("DELETE", `/api/modules/${moduleId}`, {
            token: student.token,
            body: { confirm: true }
        });
        assert.equal(moduleDenied.status, 403, moduleDenied.raw);
        const courseDenied = await request("DELETE", `/api/courses/${course.id}`, {
            token: student.token,
            body: { confirm: true }
        });
        assert.equal(courseDenied.status, 403, courseDenied.raw);
        const anonymous = await request("DELETE", `/api/lessons/${lessonId}`, { body: { confirm: true } });
        assert.equal(anonymous.status, 401, anonymous.raw);
        const stillThere = await pool.query("SELECT id FROM lessons WHERE id = $1", [lessonId]);
        assert.equal(stillThere.rows.length, 1);

        const removed = await request("DELETE", `/api/lessons/${lessonId}`, {
            token: adminToken,
            body: { confirm: true }
        });
        assert.equal(removed.status, 200, removed.raw);
        const gone = await pool.query("SELECT id FROM lessons WHERE id = $1", [lessonId]);
        assert.equal(gone.rows.length, 0);
        const moduleRemains = await pool.query("SELECT id FROM modules WHERE id = $1", [moduleId]);
        assert.equal(moduleRemains.rows.length, 1);
        await pool.query("DELETE FROM retired_media WHERE object_path = $1 AND bucket = 'local-uploads'", [markerName]);
    });

    test("deleting a lesson removes its progress and schedules its media", async () => {
        const course = await createDraftCourse();
        const { lessonId } = await createPlayableLesson(course.id);
        const mediaName = `integrity-crud-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`;
        const mediaPath = path.join(__dirname, "../uploads", mediaName);
        await fs.writeFile(mediaPath, "lesson-media");
        await pool.query("UPDATE lessons SET file_path = $1, duration = 100 WHERE id = $2", [mediaName, lessonId]);
        await request("PATCH", `/api/courses/${course.id}`, { token: adminToken, body: { published: true } });
        const student = await createUser("student");
        const enrolled = await request("POST", "/api/enrollments", {
            token: student.token,
            body: { course_id: course.id }
        });
        assert.equal(enrolled.status, 201, enrolled.raw);
        const saved = await request("POST", "/api/progress", {
            token: student.token,
            body: { lesson_id: lessonId, watched_seconds: 40, duration: 100, completed: true }
        });
        assert.equal(saved.status, 200, saved.raw);
        try {
            const removed = await request("DELETE", `/api/lessons/${lessonId}`, {
                token: adminToken,
                body: { confirm: true }
            });
            assert.equal(removed.status, 200, removed.raw);
            const progress = await pool.query("SELECT id FROM progress WHERE lesson_id = $1", [lessonId]);
            assert.equal(progress.rows.length, 0);
            const lesson = await pool.query("SELECT id FROM lessons WHERE id = $1", [lessonId]);
            assert.equal(lesson.rows.length, 0);
            await fs.access(mediaPath);
            const retired = await pool.query(
                "SELECT bucket, deleted_at FROM retired_media WHERE object_path = $1 AND bucket = 'local-uploads'",
                [mediaName]
            );
            assert.equal(retired.rows.length, 1);
            assert.equal(retired.rows[0].deleted_at, null);
        } finally {
            await pool.query("DELETE FROM retired_media WHERE object_path = $1", [mediaName]);
            await fs.unlink(mediaPath).catch(() => {});
        }
    });

    test("deleting a module removes its lessons and progress and leaves the rest of the course", async () => {
        const course = await createDraftCourse();
        const first = await createPlayableLesson(course.id);
        const secondModule = await request("POST", `/api/modules/course/${course.id}`, {
            token: adminToken,
            body: { title: "Kept module", module_order: 2 }
        });
        assert.equal(secondModule.status, 201, secondModule.raw);
        const keptLesson = await request("POST", `/api/lessons/module/${secondModule.body.module.id}`, {
            token: adminToken,
            body: { title: "Kept lesson", type: "video", lesson_order: 1 }
        });
        assert.equal(keptLesson.status, 201, keptLesson.raw);
        const removedName = `integrity-crud-mod-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`;
        const keptName = `integrity-crud-keep-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`;
        const removedPath = path.join(__dirname, "../uploads", removedName);
        const keptPath = path.join(__dirname, "../uploads", keptName);
        await fs.writeFile(removedPath, "module-lesson");
        await fs.writeFile(keptPath, "kept-lesson");
        await pool.query("UPDATE lessons SET file_path = $1, duration = 80 WHERE id = $2", [removedName, first.lessonId]);
        await pool.query("UPDATE lessons SET file_path = $1, duration = 80 WHERE id = $2", [keptName, keptLesson.body.lesson.id]);
        await request("PATCH", `/api/courses/${course.id}`, { token: adminToken, body: { published: true } });
        const student = await createUser("student");
        assert.equal((await request("POST", "/api/enrollments", {
            token: student.token,
            body: { course_id: course.id }
        })).status, 201);
        assert.equal((await request("POST", "/api/progress", {
            token: student.token,
            body: { lesson_id: first.lessonId, watched_seconds: 10, duration: 80, completed: true }
        })).status, 200);
        try {
            const removed = await request("DELETE", `/api/modules/${first.moduleId}`, {
                token: adminToken,
                body: { confirm: true }
            });
            assert.equal(removed.status, 200, removed.raw);
            assert.equal((await pool.query("SELECT id FROM modules WHERE id = $1", [first.moduleId])).rows.length, 0);
            assert.equal((await pool.query("SELECT id FROM lessons WHERE id = $1", [first.lessonId])).rows.length, 0);
            assert.equal((await pool.query("SELECT id FROM progress WHERE lesson_id = $1", [first.lessonId])).rows.length, 0);
            assert.equal((await pool.query("SELECT id FROM modules WHERE id = $1", [secondModule.body.module.id])).rows.length, 1);
            assert.equal((await pool.query("SELECT file_path FROM lessons WHERE id = $1", [keptLesson.body.lesson.id])).rows[0].file_path, keptName);
            assert.equal((await pool.query("SELECT id FROM courses WHERE id = $1", [course.id])).rows.length, 1);
            await fs.access(removedPath);
            const retired = await pool.query(
                "SELECT id FROM retired_media WHERE bucket = 'local-uploads' AND object_path = $1 AND deleted_at IS NULL",
                [removedName]
            );
            assert.equal(retired.rows.length, 1);
            const keptRetired = await pool.query("SELECT id FROM retired_media WHERE object_path = $1", [keptName]);
            assert.equal(keptRetired.rows.length, 0);
        } finally {
            await pool.query("DELETE FROM retired_media WHERE object_path = ANY($1::text[])", [[removedName, keptName]]);
            await fs.unlink(removedPath).catch(() => {});
            await fs.unlink(keptPath).catch(() => {});
        }
    });

    test("deleting a course removes enrollments, curriculum, progress, and schedules media", async () => {
        const course = await createDraftCourse();
        const { lessonId, moduleId } = await createPlayableLesson(course.id);
        const mediaName = `integrity-crud-course-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`;
        const thumbName = `crud-thumb-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`;
        const mediaPath = path.join(__dirname, "../uploads", mediaName);
        const thumbPath = path.join(__dirname, "../uploads/thumbnails", thumbName);
        const thumbUrl = `/media/thumbnails/${thumbName}`;
        const remoteThumb = `https://cdn.example.com/storage/v1/object/public/course-thumbnails/courses/pending/${thumbName}`;
        await fs.writeFile(mediaPath, "course-media");
        await fs.writeFile(thumbPath, "thumb");
        await pool.query("UPDATE lessons SET file_path = $1, duration = 90 WHERE id = $2", [mediaName, lessonId]);
        await pool.query("UPDATE courses SET thumbnail = $1 WHERE id = $2", [thumbUrl, course.id]);
        const edited = await request("PATCH", `/api/courses/${course.id}`, {
            token: adminToken,
            body: { title: "Renamed course", description: "Updated description", thumbnail: remoteThumb }
        });
        assert.equal(edited.status, 200, edited.raw);
        assert.equal(edited.body.course.title, "Renamed course");
        assert.equal(edited.body.course.description, "Updated description");
        assert.equal(edited.body.course.thumbnail, remoteThumb);
        await request("PATCH", `/api/courses/${course.id}`, { token: adminToken, body: { published: true } });
        const student = await createUser("student");
        assert.equal((await request("POST", "/api/enrollments", {
            token: student.token,
            body: { course_id: course.id }
        })).status, 201);
        assert.equal((await request("POST", "/api/progress", {
            token: student.token,
            body: { lesson_id: lessonId, watched_seconds: 15, duration: 90, completed: true }
        })).status, 200);
        try {
            const scheduledThumb = await pool.query(
                "SELECT bucket, object_path FROM retired_media WHERE object_path = $1",
                [thumbUrl]
            );
            assert.equal(scheduledThumb.rows.length, 1);
            assert.equal(scheduledThumb.rows[0].bucket, "local-thumbnails");
            await fs.access(thumbPath);

            const removed = await request("DELETE", `/api/courses/${course.id}`, {
                token: adminToken,
                body: { confirm: true }
            });
            assert.equal(removed.status, 200, removed.raw);
            assert.equal((await pool.query("SELECT id FROM courses WHERE id = $1", [course.id])).rows.length, 0);
            assert.equal((await pool.query("SELECT id FROM modules WHERE id = $1", [moduleId])).rows.length, 0);
            assert.equal((await pool.query("SELECT id FROM lessons WHERE id = $1", [lessonId])).rows.length, 0);
            assert.equal((await pool.query("SELECT id FROM progress WHERE lesson_id = $1", [lessonId])).rows.length, 0);
            assert.equal((await pool.query("SELECT id FROM enrollments WHERE course_id = $1", [course.id])).rows.length, 0);
            await fs.access(mediaPath);
            const retiredMedia = await pool.query(
                "SELECT bucket FROM retired_media WHERE object_path = $1 AND deleted_at IS NULL",
                [mediaName]
            );
            assert.equal(retiredMedia.rows[0].bucket, "local-uploads");
            const retiredRemote = await pool.query(
                "SELECT bucket FROM retired_media WHERE object_path = $1 AND deleted_at IS NULL",
                [`courses/pending/${thumbName}`]
            );
            assert.equal(retiredRemote.rows[0].bucket, "course-thumbnails");
        } finally {
            await pool.query(
                "DELETE FROM retired_media WHERE object_path = ANY($1::text[])",
                [[mediaName, thumbUrl, `courses/pending/${thumbName}`]]
            );
            await fs.unlink(mediaPath).catch(() => {});
            await fs.unlink(thumbPath).catch(() => {});
        }
    });

    test("invalid delete ids and confirmation bodies do not remove records", async () => {
        const course = await createDraftCourse();
        const { lessonId } = await createPlayableLesson(course.id);
        const before = await pool.query(
            `SELECT
                (SELECT COUNT(*) FROM courses WHERE id = $1) AS courses,
                (SELECT COUNT(*) FROM modules WHERE course_id = $1) AS modules,
                (SELECT COUNT(*) FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = $1) AS lessons,
                (SELECT COUNT(*) FROM progress p JOIN lessons l ON l.id = p.lesson_id JOIN modules m ON m.id = l.module_id WHERE m.course_id = $1) AS progress,
                (SELECT COUNT(*) FROM enrollments WHERE course_id = $1) AS enrollments`,
            [course.id]
        );
        const badRequests = [
            ["/api/lessons/0", { confirm: true }],
            ["/api/lessons/abc", { confirm: true }],
            ["/api/lessons/1.5", { confirm: true }],
            ["/api/lessons/-4", { confirm: true }],
            ["/api/modules/0", { confirm: true }],
            ["/api/courses/nope", { confirm: true }],
            ["/api/courses/1e2", { confirm: true }],
            [`/api/lessons/${lessonId}`, {}],
            [`/api/lessons/${lessonId}`, { confirm: false }],
            [`/api/lessons/${lessonId}`, { confirm: "true" }],
            ["/api/lessons/99999999", { confirm: true }]
        ];
        for (const [requestPath, body] of badRequests) {
            const response = await request("DELETE", requestPath, { token: adminToken, body });
            assert.ok(response.status === 400 || response.status === 404, `${requestPath} -> ${response.status} ${response.raw}`);
            if (requestPath.includes("99999999")) assert.equal(response.status, 404, response.raw);
            else if (requestPath.endsWith(`/${lessonId}`)) assert.equal(response.status, 400, response.raw);
            else assert.equal(response.status, 400, response.raw);
        }
        const badDescription = await request("PATCH", `/api/courses/${course.id}`, {
            token: adminToken,
            body: { description: 12 }
        });
        assert.equal(badDescription.status, 400, badDescription.raw);
        const after = await pool.query(
            `SELECT
                (SELECT COUNT(*) FROM courses WHERE id = $1) AS courses,
                (SELECT COUNT(*) FROM modules WHERE course_id = $1) AS modules,
                (SELECT COUNT(*) FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = $1) AS lessons,
                (SELECT COUNT(*) FROM progress p JOIN lessons l ON l.id = p.lesson_id JOIN modules m ON m.id = l.module_id WHERE m.course_id = $1) AS progress,
                (SELECT COUNT(*) FROM enrollments WHERE course_id = $1) AS enrollments`,
            [course.id]
        );
        assert.deepEqual(after.rows[0], before.rows[0]);
        const description = await pool.query("SELECT description FROM courses WHERE id = $1", [course.id]);
        assert.equal(description.rows[0].description, "Test course");
        const lesson = await pool.query("SELECT id FROM lessons WHERE id = $1", [lessonId]);
        assert.equal(lesson.rows.length, 1);
    });

    test("a failed deletion rolls back and does not schedule media removal", async () => {
        const course = await createDraftCourse();
        const { lessonId, moduleId } = await createPlayableLesson(course.id);
        await request("PATCH", `/api/courses/${course.id}`, { token: adminToken, body: { published: true } });
        const student = await createUser("student");
        assert.equal((await request("POST", "/api/enrollments", {
            token: student.token,
            body: { course_id: course.id }
        })).status, 201);
        assert.equal((await request("POST", "/api/progress", {
            token: student.token,
            body: { lesson_id: lessonId, watched_seconds: 25, duration: 100, completed: true }
        })).status, 200);
        const retiredBefore = await pool.query(
            "SELECT COUNT(*)::int AS count FROM retired_media WHERE object_path = $1",
            [markerName]
        );
        await assert.rejects(
            () => removeContent("course", course.id, {
                beforeCommit: async () => {
                    throw new Error("simulated failure");
                }
            }),
            /simulated failure/
        );
        assert.equal((await pool.query("SELECT id, published FROM courses WHERE id = $1", [course.id])).rows.length, 1);
        assert.equal((await pool.query("SELECT id FROM modules WHERE id = $1", [moduleId])).rows.length, 1);
        assert.equal((await pool.query("SELECT file_path FROM lessons WHERE id = $1", [lessonId])).rows[0].file_path, markerName);
        const progress = await pool.query(
            "SELECT completed, watched_seconds FROM progress WHERE user_id = $1 AND lesson_id = $2",
            [student.id, lessonId]
        );
        assert.equal(progress.rows.length, 1);
        assert.equal(progress.rows[0].completed, true);
        assert.equal((await pool.query("SELECT id FROM enrollments WHERE course_id = $1 AND user_id = $2", [course.id, student.id])).rows.length, 1);
        const retiredAfter = await pool.query(
            "SELECT COUNT(*)::int AS count FROM retired_media WHERE object_path = $1",
            [markerName]
        );
        assert.equal(retiredAfter.rows[0].count, retiredBefore.rows[0].count);
        await fs.access(markerPath);
    });
});
