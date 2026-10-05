const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const requireAdmin = authenticateToken.requireAdmin;
const requireCourseAccess = require("../middleware/courseAccess");

const router = express.Router();


// GET lessons for a module
router.get("/module/:moduleId", authenticateToken, requireCourseAccess("module"), async (req, res) => {
    try {
        const { moduleId } = req.params;
        if (!/^\d+$/.test(moduleId) || Number(moduleId) <= 0) return res.status(400).json({ message: "A valid module ID is required" });

        const result = await pool.query(
            `SELECT id, module_id, title, type, duration, lesson_order,
                    (file_path IS NOT NULL AND file_path <> '') AS has_media
             FROM lessons
             WHERE module_id = $1
             ORDER BY lesson_order`,
            [moduleId]
        );

        res.json(result.rows);

    } catch (error) {
        console.error("Error fetching lessons:", error);

        res.status(500).json({
            message: "Failed to fetch lessons"
        });
    }
});


// CREATE a lesson
router.post("/module/:moduleId", authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { moduleId } = req.params;
        if (!/^\d+$/.test(moduleId) || Number(moduleId) <= 0) return res.status(400).json({ message: "A valid module ID is required" });

        const { title, type, duration, lesson_order } = req.body;

        if (!title || title.trim() === "") {
            return res.status(400).json({
                message: "Lesson title is required"
            });
        }

        if (!type || !["video", "audio"].includes(type)) {
            return res.status(400).json({
                message: "Lesson type must be video or audio"
            });
        }
        const order = lesson_order === undefined ? 1 : Number(lesson_order);
        const lessonDuration = duration === undefined ? 0 : Number(duration);
        if (!Number.isInteger(order) || order < 1) return res.status(400).json({ message: "lesson_order must be a positive integer" });
        if (!Number.isFinite(lessonDuration) || lessonDuration < 0) return res.status(400).json({ message: "duration must be a non-negative number" });

        const result = await pool.query(
            `INSERT INTO lessons
            (module_id, title, type, duration, lesson_order)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, module_id, title, type, duration, lesson_order,
                      (file_path IS NOT NULL AND file_path <> '') AS has_media`,
            [
                moduleId,
                title.trim(),
                type,
                Math.floor(lessonDuration),
                order
            ]
        );

        res.status(201).json({
            message: "Lesson created successfully",
            lesson: result.rows[0]
        });

    } catch (error) {
        console.error("Error creating lesson:", error);

        res.status(500).json({
            message: "Failed to create lesson"
        });
    }
});

router.patch("/:lessonId", authenticateToken, requireAdmin, async (req, res) => {
    const id = Number(req.params.lessonId);
    const { title, type, duration, lesson_order } = req.body;
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "A valid lesson ID is required" });
    if (title !== undefined && (typeof title !== "string" || !title.trim())) return res.status(400).json({ message: "Lesson title is required" });
    if (type !== undefined && !["video", "audio"].includes(type)) return res.status(400).json({ message: "Lesson type must be video or audio" });
    if (duration !== undefined && (!Number.isFinite(Number(duration)) || Number(duration) < 0)) return res.status(400).json({ message: "duration must be a non-negative number" });
    if (lesson_order !== undefined && (!Number.isInteger(Number(lesson_order)) || Number(lesson_order) < 1)) return res.status(400).json({ message: "lesson_order must be a positive integer" });
    try {
        const result = await pool.query(`UPDATE lessons SET title = COALESCE($1,title), type = COALESCE($2,type),
            duration = COALESCE($3,duration), lesson_order = COALESCE($4,lesson_order)
            WHERE id = $5 RETURNING id,module_id,title,type,duration,lesson_order,
            (file_path IS NOT NULL AND file_path <> '') AS has_media`, [
            title === undefined ? null : title.trim(), type === undefined ? null : type,
            duration === undefined ? null : Number(duration), lesson_order === undefined ? null : Number(lesson_order), id
        ]);
        if (!result.rows.length) return res.status(404).json({ message: "Lesson not found" });
        return res.json({ lesson: result.rows[0] });
    } catch (error) {
        console.error("Lesson update failed:", error.message);
        return res.status(500).json({ message: "Could not update lesson" });
    }
});


module.exports = router;
