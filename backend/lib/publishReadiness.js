const pool = require("../config/db");
const { mediaExists } = require("./mediaLifecycle");

async function courseReadiness(courseId) {
    const courseResult = await pool.query("SELECT id, title FROM courses WHERE id = $1", [courseId]);
    if (!courseResult.rows.length) return { ok: false, status: 404, message: "Course not found" };
    const course = courseResult.rows[0];
    const problems = [];
    if (typeof course.title !== "string" || !course.title.trim()) problems.push("a title is required");

    const modules = await pool.query(
        "SELECT id, title FROM modules WHERE course_id = $1 ORDER BY module_order, id",
        [courseId]
    );
    if (!modules.rows.length) problems.push("at least one module is required");

    for (const module of modules.rows) {
        const lessons = await pool.query(
            `SELECT id, title, file_path, duration
             FROM lessons
             WHERE module_id = $1
             ORDER BY lesson_order, id`,
            [module.id]
        );
        if (!lessons.rows.length) {
            problems.push(`module "${module.title}" has no lessons`);
            continue;
        }
        for (const lesson of lessons.rows) {
            if (!lesson.file_path) {
                problems.push(`lesson "${lesson.title}" has no media`);
                continue;
            }
            if (!(Number(lesson.duration) > 0)) {
                problems.push(`lesson "${lesson.title}" has no valid duration`);
                continue;
            }
            const exists = await mediaExists(lesson.file_path);
            if (!exists) problems.push(`lesson "${lesson.title}" media is missing from storage`);
        }
    }

    if (problems.length) {
        return {
            ok: false,
            status: 400,
            message: `This course is not ready to publish: ${problems.join("; ")}`
        };
    }
    return { ok: true };
}

async function returnPublishedCourseToDraft(courseId) {
    const result = await pool.query(
        "UPDATE courses SET published = false WHERE id = $1 AND published = true RETURNING id",
        [courseId]
    );
    return result.rows.length > 0;
}

module.exports = { courseReadiness, returnPublishedCourseToDraft };
