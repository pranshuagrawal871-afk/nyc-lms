const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const { authorizeLesson, authorizeCourseRead, PLAYABLE_LESSON_SQL } = require("../lib/entitlement");

const router = express.Router();
const MAX_MEDIA_SECONDS = 24 * 60 * 60;
const POSITION_TOLERANCE_SECONDS = 5;

function positionError(watchedSeconds, duration, lessonDuration) {
    if (!Number.isFinite(watchedSeconds) || watchedSeconds < 0) {
        return "watched_seconds must be a non-negative number";
    }
    if (watchedSeconds > MAX_MEDIA_SECONDS) return "watched_seconds is outside the allowed range";

    let cap = MAX_MEDIA_SECONDS;
    if (duration !== undefined && duration !== null && duration !== "") {
        const parsedDuration = Number(duration);
        if (!Number.isFinite(parsedDuration) || parsedDuration <= 0 || parsedDuration > MAX_MEDIA_SECONDS) {
            return "duration is outside the allowed range";
        }
        cap = Math.min(cap, parsedDuration);
    }
    const storedDuration = Number(lessonDuration);
    if (Number.isFinite(storedDuration) && storedDuration > 0) {
        cap = Math.min(cap, storedDuration);
    }
    if (watchedSeconds > cap + POSITION_TOLERANCE_SECONDS) {
        return "watched_seconds cannot exceed the lesson duration";
    }
    return null;
}

async function requirePlayableLesson(req, res) {
    const lessonId = Number(req.body?.lesson_id ?? req.params.lessonId);
    if (!Number.isInteger(lessonId) || lessonId <= 0) {
        res.status(400).json({ message: "A valid lesson_id is required" });
        return null;
    }
    const access = await authorizeLesson(req.user, lessonId);
    if (!access.ok) {
        res.status(access.status).json({ message: access.message });
        return null;
    }
    return access.lesson;
}

// Course totals come from the database so a partial curriculum cannot claim 100%.
router.get("/course/:courseId", authenticateToken, async (req, res) => {
    const courseId = Number(req.params.courseId);
    if (!Number.isInteger(courseId) || courseId <= 0) {
        return res.status(400).json({ message: "A valid course ID is required" });
    }
    try {
        const access = await authorizeCourseRead(req.user, courseId);
        if (!access.ok) return res.status(access.status).json({ message: access.message });
        if (req.user.role !== "admin") {
            const enrolled = await pool.query(
                "SELECT 1 FROM enrollments WHERE user_id = $1 AND course_id = $2",
                [req.user.id, courseId]
            );
            if (!enrolled.rows.length) {
                return res.status(403).json({ message: "Enroll in this course to view progress" });
            }
        }
        const result = await pool.query(
            `SELECT
                COUNT(l.id) FILTER (WHERE ${PLAYABLE_LESSON_SQL}) AS total_lessons,
                COUNT(l.id) FILTER (WHERE ${PLAYABLE_LESSON_SQL} AND p.completed) AS completed_lessons
             FROM modules m
             LEFT JOIN lessons l ON l.module_id = m.id
             LEFT JOIN progress p ON p.lesson_id = l.id AND p.user_id = $2
             WHERE m.course_id = $1`,
            [courseId, req.user.id]
        );
        const total = Number(result.rows[0].total_lessons) || 0;
        const completed = Number(result.rows[0].completed_lessons) || 0;
        return res.json({
            status: "loaded",
            total_lessons: total,
            completed_lessons: completed,
            progress_percent: total > 0 ? Math.floor((completed / total) * 100) : 0,
            completed: total > 0 && completed === total
        });
    } catch (error) {
        console.error("Course progress error:", error.message);
        return res.status(500).json({ message: "Failed to fetch course progress" });
    }
});

// Ordinary progress saves. completed=true is monotonic.
// Sending completed:false, or omitting it, never clears an existing completion.
// Resetting completion is POST /:lessonId/reset and is not used by the player.
router.post("/", authenticateToken, async (req, res) => {
    try {
        const lesson = await requirePlayableLesson(req, res);
        if (!lesson) return;
        if (!lesson.file_path) {
            return res.status(409).json({ message: "This lesson has no playable media" });
        }

        const watchedSeconds = Number(req.body.watched_seconds ?? 0);
        const problem = positionError(watchedSeconds, req.body.duration, lesson.duration);
        if (problem) return res.status(400).json({ message: problem });

        const markComplete = req.body.completed === true;
        const result = await pool.query(
            `INSERT INTO progress
                (user_id, lesson_id, watched_seconds, completed, updated_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, lesson_id)
             DO UPDATE SET
                watched_seconds = EXCLUDED.watched_seconds,
                completed = progress.completed OR EXCLUDED.completed,
                updated_at = CURRENT_TIMESTAMP
             RETURNING id, user_id, lesson_id, watched_seconds, completed, updated_at`,
            [req.user.id, lesson.id, Math.floor(watchedSeconds), markComplete]
        );

        return res.json({ message: "Progress saved", progress: result.rows[0] });
    } catch (error) {
        console.error("Progress save error:", error.message);
        return res.status(500).json({ message: "Failed to save progress" });
    }
});

router.post("/:lessonId/reset", authenticateToken, async (req, res) => {
    if (req.body?.reset_completion !== true) {
        return res.status(400).json({ message: "reset_completion must be true" });
    }
    try {
        const lesson = await requirePlayableLesson(req, res);
        if (!lesson) return;
        const result = await pool.query(
            `UPDATE progress
             SET completed = false, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $1 AND lesson_id = $2
             RETURNING id, user_id, lesson_id, watched_seconds, completed, updated_at`,
            [req.user.id, lesson.id]
        );
        if (!result.rows.length) {
            return res.json({
                message: "No progress to reset",
                progress: { lesson_id: lesson.id, watched_seconds: 0, completed: false }
            });
        }
        return res.json({ message: "Lesson completion reset", progress: result.rows[0] });
    } catch (error) {
        console.error("Progress reset error:", error.message);
        return res.status(500).json({ message: "Failed to reset progress" });
    }
});

router.get("/:lessonId", authenticateToken, async (req, res) => {
    const lessonId = Number(req.params.lessonId);
    if (!Number.isInteger(lessonId) || lessonId <= 0) {
        return res.status(400).json({ message: "A valid lesson ID is required" });
    }
    try {
        const access = await authorizeLesson(req.user, lessonId);
        if (!access.ok) return res.status(access.status).json({ message: access.message });

        const result = await pool.query(
            `SELECT id, user_id, lesson_id, watched_seconds, completed, updated_at
             FROM progress
             WHERE user_id = $1 AND lesson_id = $2`,
            [req.user.id, lessonId]
        );
        if (!result.rows.length) return res.json({ watched_seconds: 0, completed: false });
        return res.json(result.rows[0]);
    } catch (error) {
        console.error("Progress fetch error:", error.message);
        return res.status(500).json({ message: "Failed to fetch progress" });
    }
});

module.exports = router;
