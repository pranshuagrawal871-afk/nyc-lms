const pool = require("../config/db");

/**
 * MVP entitlement policy
 * ----------------------
 * Courses are free. This application does not take payments.
 *
 * Three checks stay separate so a future paid or approval gate can be
 * added here without rewriting routes:
 *   1. Discovery / publication — public lists show published courses only.
 *   2. Enrollment — the enrollments row is the entitlement record.
 *      New enrollment is allowed only for published courses (authorizeEnrollment).
 *   3. Access — lessons, media, and progress require that entitlement.
 *      Administrators bypass enrollment for preview.
 *
 * Unpublish removes a course from discovery and blocks new enrollment.
 * Students who are already enrolled keep access, including direct player
 * URLs, course metadata, and stream tokens.
 */

const PLAYABLE_LESSON_SQL = "(l.file_path IS NOT NULL AND l.file_path <> '' AND COALESCE(l.duration, 0) > 0)";

function isAdmin(user) {
    return Boolean(user && user.role === "admin");
}

async function lessonContext(lessonId) {
    const result = await pool.query(
        `SELECT l.id, l.module_id, l.title, l.duration, l.file_path, l.type,
                m.course_id, c.published, c.title AS course_title
         FROM lessons l
         JOIN modules m ON m.id = l.module_id
         JOIN courses c ON c.id = m.course_id
         WHERE l.id = $1`,
        [lessonId]
    );
    return result.rows[0] || null;
}

async function enrollmentFor(userId, courseId) {
    const result = await pool.query(
        `SELECT id, enrolled_at
         FROM enrollments
         WHERE user_id = $1 AND course_id = $2`,
        [userId, courseId]
    );
    return result.rows[0] || null;
}

async function authorizeLesson(user, lessonId) {
    const lesson = await lessonContext(lessonId);
    if (!lesson || !lesson.course_id || !lesson.module_id) {
        return { ok: false, status: 404, message: "Lesson not found" };
    }
    if (isAdmin(user)) return { ok: true, lesson, enrollment: null };
    const enrollment = await enrollmentFor(user.id, lesson.course_id);
    if (!enrollment) {
        return { ok: false, status: 403, message: "Enroll in this course to access this lesson" };
    }
    return { ok: true, lesson, enrollment };
}

async function authorizeCourseRead(user, courseId) {
    const result = await pool.query("SELECT * FROM courses WHERE id = $1", [courseId]);
    if (!result.rows.length) return { ok: false, status: 404, message: "Course not found" };
    const course = result.rows[0];
    if (isAdmin(user) || course.published === true) return { ok: true, course };
    if (user) {
        const enrollment = await enrollmentFor(user.id, course.id);
        if (enrollment) return { ok: true, course, enrollment };
    }
    return { ok: false, status: 403, message: "This course is not available" };
}

async function authorizeEnrollment(course) {
    if (course.published !== true) {
        return { ok: false, status: 403, message: "This course is not open for enrollment" };
    }
    return { ok: true, policy: "free_published" };
}

module.exports = {
    PLAYABLE_LESSON_SQL,
    isAdmin,
    lessonContext,
    enrollmentFor,
    authorizeLesson,
    authorizeCourseRead,
    authorizeEnrollment
};
