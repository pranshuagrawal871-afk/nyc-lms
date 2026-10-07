const path = require("path");
const pool = require("../config/db");
const { retireObject } = require("./mediaLifecycle");
const { courseReadiness, returnPublishedCourseToDraft } = require("./publishReadiness");

function parsePositiveId(value) {
    const text = String(value ?? "");
    if (!/^[1-9]\d*$/.test(text)) return null;
    const id = Number(text);
    return Number.isSafeInteger(id) ? id : null;
}

function lessonMediaReference(filePath) {
    if (typeof filePath !== "string") return null;
    const value = filePath.trim();
    if (!value || value.includes("..") || value.includes("\\")) return null;
    if (value.startsWith("courses/")) return { bucket: "course-videos", objectPath: value };
    if (value.includes("/")) return null;
    const base = path.basename(value);
    if (!base || base === "." || base === "..") return null;
    return { bucket: "local-uploads", objectPath: base };
}

function thumbnailReference(thumbnail) {
    if (typeof thumbnail !== "string") return null;
    const value = thumbnail.trim();
    if (!value) return null;
    if (/^\/media\/thumbnails\/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp|gif)$/i.test(value)) {
        return { bucket: "local-thumbnails", objectPath: value };
    }
    let url;
    try { url = new URL(value); }
    catch (_) { return null; }
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const marker = "/course-thumbnails/";
    const index = url.pathname.indexOf(marker);
    if (index === -1) return null;
    let objectPath;
    try { objectPath = decodeURIComponent(url.pathname.slice(index + marker.length)); }
    catch (_) { return null; }
    if (!objectPath || objectPath.includes("..") || objectPath.includes("\\") || objectPath.startsWith("/")) return null;
    return { bucket: "course-thumbnails", objectPath };
}

function uniqueMedia(items) {
    const seen = new Set();
    const media = [];
    for (const item of items) {
        if (!item || !item.bucket || !item.objectPath) continue;
        const key = `${item.bucket}\n${item.objectPath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        media.push(item);
    }
    return media;
}

async function deleteWithinTransaction(client, kind, id) {
    if (kind === "lesson") {
        const lesson = await client.query(
            `SELECT l.id, l.file_path, m.course_id, c.published
             FROM lessons l
             JOIN modules m ON m.id = l.module_id
             JOIN courses c ON c.id = m.course_id
             WHERE l.id = $1
             FOR UPDATE OF l`,
            [id]
        );
        if (!lesson.rows.length) return { found: false, media: [] };
        await client.query("DELETE FROM progress WHERE lesson_id = $1", [id]);
        await client.query("DELETE FROM lessons WHERE id = $1", [id]);
        return {
            found: true,
            courseId: lesson.rows[0].course_id,
            wasPublished: lesson.rows[0].published === true,
            media: uniqueMedia([lessonMediaReference(lesson.rows[0].file_path)])
        };
    }

    if (kind === "module") {
        const module = await client.query(
            `SELECT m.id, m.course_id, c.published
             FROM modules m
             JOIN courses c ON c.id = m.course_id
             WHERE m.id = $1
             FOR UPDATE OF m`,
            [id]
        );
        if (!module.rows.length) return { found: false, media: [] };
        const lessons = await client.query(
            "SELECT id, file_path FROM lessons WHERE module_id = $1 FOR UPDATE",
            [id]
        );
        const lessonIds = lessons.rows.map((row) => row.id);
        if (lessonIds.length) {
            await client.query("DELETE FROM progress WHERE lesson_id = ANY($1::int[])", [lessonIds]);
            await client.query("DELETE FROM lessons WHERE module_id = $1", [id]);
        }
        await client.query("DELETE FROM modules WHERE id = $1", [id]);
        return {
            found: true,
            courseId: module.rows[0].course_id,
            wasPublished: module.rows[0].published === true,
            media: uniqueMedia(lessons.rows.map((row) => lessonMediaReference(row.file_path)))
        };
    }

    if (kind === "course") {
        const course = await client.query(
            "SELECT id, thumbnail, published FROM courses WHERE id = $1 FOR UPDATE",
            [id]
        );
        if (!course.rows.length) return { found: false, media: [] };
        const modules = await client.query(
            "SELECT id FROM modules WHERE course_id = $1 FOR UPDATE",
            [id]
        );
        const lessons = await client.query(
            `SELECT l.id, l.file_path
             FROM lessons l
             JOIN modules m ON m.id = l.module_id
             WHERE m.course_id = $1
             FOR UPDATE OF l`,
            [id]
        );
        const lessonIds = lessons.rows.map((row) => row.id);
        const moduleIds = modules.rows.map((row) => row.id);
        if (lessonIds.length) {
            await client.query("DELETE FROM progress WHERE lesson_id = ANY($1::int[])", [lessonIds]);
        }
        if (moduleIds.length) {
            await client.query("DELETE FROM lessons WHERE module_id = ANY($1::int[])", [moduleIds]);
            await client.query("DELETE FROM modules WHERE course_id = $1", [id]);
        }
        await client.query("DELETE FROM enrollments WHERE course_id = $1", [id]);
        await client.query("DELETE FROM courses WHERE id = $1", [id]);
        return {
            found: true,
            courseId: id,
            wasPublished: false,
            media: uniqueMedia([
                ...lessons.rows.map((row) => lessonMediaReference(row.file_path)),
                thumbnailReference(course.rows[0].thumbnail)
            ])
        };
    }

    const error = new Error("Unknown content kind");
    error.status = 500;
    throw error;
}

async function removeContent(kind, id, options = {}) {
    if (!Number.isSafeInteger(id) || id <= 0) {
        const error = new Error("A valid ID is required");
        error.status = 400;
        throw error;
    }
    const client = await pool.connect();
    let committed = null;
    try {
        await client.query("BEGIN");
        const outcome = await deleteWithinTransaction(client, kind, id);
        if (!outcome.found) {
            await client.query("ROLLBACK");
            return { found: false };
        }
        if (typeof options.beforeCommit === "function") await options.beforeCommit(client);
        await client.query("COMMIT");
        committed = outcome;
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) { /* the original error is the one to report */ }
        throw error;
    } finally {
        client.release();
    }

    for (const item of committed.media) {
        try {
            await retireObject(item.bucket, item.objectPath);
        } catch (error) {
            console.error("Could not schedule removal of deleted media:", error.message);
        }
    }

    let courseUnpublished = false;
    if (committed.wasPublished && committed.courseId) {
        try {
            const readiness = await courseReadiness(committed.courseId);
            if (!readiness.ok && readiness.status === 400) {
                courseUnpublished = await returnPublishedCourseToDraft(committed.courseId);
            }
        } catch (error) {
            console.error("Could not re-check publication readiness:", error.message);
        }
    }
    return {
        found: true,
        courseId: committed.courseId,
        course_unpublished: courseUnpublished
    };
}

function confirmProblem(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return "A confirmation body is required";
    if (body.confirm !== true) return "Set confirm to true to delete this record";
    return null;
}

module.exports = {
    parsePositiveId,
    lessonMediaReference,
    thumbnailReference,
    removeContent,
    confirmProblem
};
