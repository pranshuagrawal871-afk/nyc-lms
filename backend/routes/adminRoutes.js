const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const router = express.Router();

router.use(authenticateToken, authenticateToken.requireAdmin);

router.get("/analytics", async (req, res) => {
    try {
        const result = await pool.query(`SELECT
            (SELECT COUNT(*) FROM users WHERE role = 'student') AS total_students,
            (SELECT COUNT(*) FROM courses) AS total_courses,
            (SELECT COUNT(*) FROM courses WHERE published = true) AS published_courses,
            (SELECT COUNT(*) FROM lessons) AS total_lessons,
            (SELECT COUNT(*) FROM enrollments) AS total_enrollments,
            (SELECT COUNT(*) FROM progress WHERE completed = true) AS completed_lessons,
            (SELECT COUNT(*) FROM enrollments e WHERE NOT EXISTS (
                SELECT 1 FROM modules m JOIN lessons l ON l.module_id = m.id
                LEFT JOIN progress p ON p.lesson_id = l.id AND p.user_id = e.user_id
                WHERE m.course_id = e.course_id
                  AND l.file_path IS NOT NULL AND l.file_path <> '' AND COALESCE(l.duration, 0) > 0
                  AND COALESCE(p.completed, false) = false
            ) AND EXISTS (
                SELECT 1 FROM modules m JOIN lessons l ON l.module_id = m.id
                WHERE m.course_id = e.course_id
                  AND l.file_path IS NOT NULL AND l.file_path <> '' AND COALESCE(l.duration, 0) > 0
            )) AS completed_courses`);
        res.json(result.rows[0]);
    } catch (error) {
        console.error("Admin analytics failed:", error.message);
        res.status(500).json({ message: "Could not load analytics" });
    }
});

function escapeLike(value) {
    return String(value || "").replace(/[\\%_]/g, (character) => `\\${character}`);
}

router.get("/students", async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 50;
    const offset = (page - 1) * limit;
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 150) : "";
    try {
        const like = `%${escapeLike(query)}%`;
        const countFilter = query ? "AND (u.name ILIKE $1 ESCAPE '\\' OR u.email ILIKE $1 ESCAPE '\\')" : "";
        const listFilter = query ? "AND (u.name ILIKE $3 ESCAPE '\\' OR u.email ILIKE $3 ESCAPE '\\')" : "";
        const total = await pool.query(
            `SELECT COUNT(*) FROM users u WHERE u.role = 'student' ${countFilter}`,
            query ? [like] : []
        );
        const result = await pool.query(
            `SELECT u.id, u.name, u.email, u.created_at,
                (SELECT COUNT(*) FROM enrollments e WHERE e.user_id = u.id) AS enrolled_courses,
                (SELECT COUNT(*) FROM progress p WHERE p.user_id = u.id AND p.completed = true) AS completed_lessons
             FROM users u
             WHERE u.role = 'student' ${listFilter}
             ORDER BY u.created_at DESC NULLS LAST, u.id DESC
             LIMIT $1 OFFSET $2`,
            query ? [limit, offset, like] : [limit, offset]
        );
        res.json({
            students: result.rows,
            page,
            limit,
            total: Number(total.rows[0].count) || 0
        });
    } catch (error) {
        console.error("Student list failed:", error.message);
        res.status(500).json({ message: "Could not load students" });
    }
});

module.exports = router;
