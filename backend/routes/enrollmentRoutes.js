const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const { authorizeEnrollment, PLAYABLE_LESSON_SQL } = require("../lib/entitlement");

const router = express.Router();

// GET all courses the logged-in student is enrolled in,
// with progress computed from the existing progress table.
router.get("/my", authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                e.course_id,
                e.enrolled_at,
                c.title,
                c.description,
                c.thumbnail,
                c.published,
                COUNT(l.id) FILTER (WHERE ${PLAYABLE_LESSON_SQL}) AS total_lessons,
                COUNT(l.id) FILTER (WHERE ${PLAYABLE_LESSON_SQL} AND p.completed) AS completed_lessons
             FROM enrollments e
             JOIN courses c ON c.id = e.course_id
             LEFT JOIN modules m ON m.course_id = c.id
             LEFT JOIN lessons l ON l.module_id = m.id
             LEFT JOIN progress p ON p.lesson_id = l.id AND p.user_id = $1
             WHERE e.user_id = $1
             GROUP BY e.id, c.id
             ORDER BY e.enrolled_at DESC`,
            [req.user.id]
        );

        const courses = result.rows.map(function (row) {
            const total = Number(row.total_lessons);
            const done = Number(row.completed_lessons);

            return {
                course_id: Number(row.course_id),
                enrolled_at: row.enrolled_at,
                title: row.title,
                description: row.description,
                thumbnail: row.thumbnail,
                published: row.published,
                total_lessons: total,
                completed_lessons: done,
                progress_percent: total > 0 ? Math.round((done / total) * 100) : 0,
                completed: total > 0 && done === total
            };
        });

        res.json(courses);

    } catch (error) {
        console.error("Error fetching enrollments:", error);

        res.status(500).json({
            message: "Failed to fetch enrolled courses"
        });
    }
});


// GET enrollment status for a single course
router.get("/course/:courseId", authenticateToken, async (req, res) => {
    try {
        const courseId = Number(req.params.courseId);
        if (!Number.isInteger(courseId) || courseId <= 0) {
            return res.status(400).json({ message: "A valid course ID is required" });
        }

        const result = await pool.query(
            `SELECT id, enrolled_at
             FROM enrollments
             WHERE user_id = $1 AND course_id = $2`,
            [req.user.id, courseId]
        );

        res.json({
            enrolled: result.rows.length > 0,
            enrolled_at: result.rows.length > 0 ? result.rows[0].enrolled_at : null
        });

    } catch (error) {
        console.error("Enrollment check error:", error);

        res.status(500).json({
            message: "Failed to check enrollment"
        });
    }
});


// POST enroll in a published course
router.post("/", authenticateToken, async (req, res) => {
    try {
        const courseId = Number(req.body.course_id);
        if (!Number.isInteger(courseId) || courseId <= 0) {
            return res.status(400).json({ message: "A valid course_id is required" });
        }

        const courseResult = await pool.query(
            "SELECT id, published FROM courses WHERE id = $1",
            [courseId]
        );

        if (courseResult.rows.length === 0) {
            return res.status(404).json({ message: "Course not found" });
        }

        const existing = await pool.query(
            `SELECT id, course_id, enrolled_at
             FROM enrollments
             WHERE user_id = $1 AND course_id = $2`,
            [req.user.id, courseId]
        );

        if (existing.rows.length > 0) {
            return res.json({
                message: "Already enrolled",
                alreadyEnrolled: true,
                enrollment: existing.rows[0]
            });
        }

        const entitlement = await authorizeEnrollment(courseResult.rows[0]);
        if (!entitlement.ok) return res.status(entitlement.status).json({ message: entitlement.message });

        const result = await pool.query(
            `INSERT INTO enrollments (user_id, course_id)
             VALUES ($1, $2)
             ON CONFLICT (user_id, course_id) DO NOTHING
             RETURNING id, user_id, course_id, enrolled_at`,
            [req.user.id, courseId]
        );

        if (!result.rows.length) {
            const raced = await pool.query(
                `SELECT id, course_id, enrolled_at
                 FROM enrollments
                 WHERE user_id = $1 AND course_id = $2`,
                [req.user.id, courseId]
            );
            return res.json({
                message: "Already enrolled",
                alreadyEnrolled: true,
                enrollment: raced.rows[0]
            });
        }

        res.status(201).json({
            message: "Enrolled successfully",
            enrollment: result.rows[0]
        });

    } catch (error) {
        if (error.code === "23505") {
            return res.json({ message: "Already enrolled", alreadyEnrolled: true });
        }
        console.error("Enrollment error:", error.message);
        res.status(500).json({
            message: "Failed to enroll in course"
        });
    }
});


module.exports = router;
