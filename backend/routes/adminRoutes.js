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
            (SELECT COUNT(DISTINCT e.user_id) FROM enrollments e WHERE NOT EXISTS (
                SELECT 1 FROM modules m JOIN lessons l ON l.module_id = m.id
                LEFT JOIN progress p ON p.lesson_id = l.id AND p.user_id = e.user_id
                WHERE m.course_id = e.course_id AND COALESCE(p.completed, false) = false
            ) AND EXISTS (SELECT 1 FROM modules m JOIN lessons l ON l.module_id = m.id WHERE m.course_id = e.course_id)) AS completed_courses`);
        res.json(result.rows[0]);
    } catch (error) {
        console.error("Admin analytics failed:", error.message);
        res.status(500).json({ message: "Could not load analytics" });
    }
});

router.get("/students", async (req, res) => {
    try {
        const result = await pool.query(`SELECT u.id, u.name, u.email, u.created_at,
            COUNT(DISTINCT e.course_id) AS enrolled_courses,
            COUNT(DISTINCT p.lesson_id) FILTER (WHERE p.completed = true) AS completed_lessons
            FROM users u LEFT JOIN enrollments e ON e.user_id = u.id
            LEFT JOIN progress p ON p.user_id = u.id
            WHERE u.role = 'student'
            GROUP BY u.id ORDER BY u.created_at DESC NULLS LAST, u.id DESC`);
        res.json(result.rows);
    } catch (error) {
        console.error("Student list failed:", error.message);
        res.status(500).json({ message: "Could not load students" });
    }
});

module.exports = router;
