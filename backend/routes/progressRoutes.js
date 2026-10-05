const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

// Save / update progress
router.post("/", authenticateToken, async (req, res) => {
    try {
        const {
            lesson_id,
            watched_seconds,
            completed
        } = req.body;

        const lessonId = Number(lesson_id);
        if (!Number.isInteger(lessonId) || lessonId <= 0) {
            return res.status(400).json({
                message: "A valid lesson_id is required"
            });
        }

        const watchedSeconds = Number(watched_seconds ?? 0);
        if (!Number.isFinite(watchedSeconds) || watchedSeconds < 0) {
            return res.status(400).json({ message: "watched_seconds must be a non-negative number" });
        }

        const result = await pool.query(
            `INSERT INTO progress
            (user_id, lesson_id, watched_seconds, completed, updated_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)

            ON CONFLICT (user_id, lesson_id)
            DO UPDATE SET
                watched_seconds = EXCLUDED.watched_seconds,
                completed = EXCLUDED.completed,
                updated_at = CURRENT_TIMESTAMP

            RETURNING *`,
            [
                req.user.id,
                lessonId,
                Math.floor(watchedSeconds),
                completed === true
            ]
        );

        res.json({
            message: "Progress saved",
            progress: result.rows[0]
        });

    } catch (error) {
        console.error("Progress save error:", error);

        res.status(500).json({
            message: "Failed to save progress"
        });
    }
});


// Get progress for a lesson
router.get("/:lessonId", authenticateToken, async (req, res) => {
    try {
        const lessonId = Number(req.params.lessonId);
        if (!Number.isInteger(lessonId) || lessonId <= 0) {
            return res.status(400).json({ message: "A valid lesson ID is required" });
        }

        const result = await pool.query(
            `SELECT *
             FROM progress
             WHERE user_id = $1
             AND lesson_id = $2`,
            [req.user.id, lessonId]
        );

        if (result.rows.length === 0) {
            return res.json({
                watched_seconds: 0,
                completed: false
            });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error("Progress fetch error:", error);

        res.status(500).json({
            message: "Failed to fetch progress"
        });
    }
});


module.exports = router;
