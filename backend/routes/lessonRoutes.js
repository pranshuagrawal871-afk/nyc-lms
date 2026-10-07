const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const requireAdmin = authenticateToken.requireAdmin;
const requireCourseAccess = require("../middleware/courseAccess");
const { parseTitle, respondWithDbError } = require("../lib/validation");
const { returnPublishedCourseToDraft } = require("../lib/publishReadiness");
const { parsePositiveId, removeContent, confirmProblem } = require("../lib/contentRemoval");

const router = express.Router();


// GET lessons for a module
router.get("/module/:moduleId", authenticateToken, requireCourseAccess("module"), async (req, res) => {
    try {
        const { moduleId } = req.params;
        if (!/^\d+$/.test(moduleId) || Number(moduleId) <= 0) return res.status(400).json({ message: "A valid module ID is required" });

        const playableOnly = req.user.role !== "admin";
        const result = await pool.query(
            `SELECT id, module_id, title, type, duration, lesson_order,
                    (file_path IS NOT NULL AND file_path <> '') AS has_media
             FROM lessons
             WHERE module_id = $1
               AND ($2::boolean = false OR (file_path IS NOT NULL AND file_path <> '' AND COALESCE(duration, 0) > 0))
             ORDER BY lesson_order`,
            [moduleId, playableOnly]
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

        const { type, duration, lesson_order } = req.body;
        const parsedTitle = parseTitle(req.body.title, "Lesson title");
        if (parsedTitle.error) return res.status(400).json({ message: parsedTitle.error });

        if (!type || !["video", "audio"].includes(type)) {
            return res.status(400).json({
                message: "Lesson type must be video or audio"
            });
        }
        const order = lesson_order === undefined ? 1 : Number(lesson_order);
        const lessonDuration = duration === undefined ? 0 : Number(duration);
        if (!Number.isInteger(order) || order < 1) return res.status(400).json({ message: "lesson_order must be a positive integer" });
        if (!Number.isFinite(lessonDuration) || lessonDuration < 0) return res.status(400).json({ message: "duration must be a non-negative number" });

        const module = await pool.query(
            "SELECT m.id, m.course_id FROM modules m WHERE m.id = $1",
            [moduleId]
        );
        if (!module.rows.length) return res.status(404).json({ message: "Module not found" });

        const result = await pool.query(
            `INSERT INTO lessons
            (module_id, title, type, duration, lesson_order)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, module_id, title, type, duration, lesson_order,
                      (file_path IS NOT NULL AND file_path <> '') AS has_media`,
            [
                moduleId,
                parsedTitle.value,
                type,
                Math.floor(lessonDuration),
                order
            ]
        );
        const courseUnpublished = await returnPublishedCourseToDraft(module.rows[0].course_id);

        res.status(201).json({
            message: courseUnpublished
                ? "Lesson created. The course was returned to draft until this lesson has playable media and the course is published again."
                : "Lesson created successfully",
            lesson: result.rows[0],
            course_unpublished: courseUnpublished
        });

    } catch (error) {
        return respondWithDbError(res, error, "Failed to create lesson");
    }
});

router.patch("/:lessonId", authenticateToken, requireAdmin, async (req, res) => {
    const id = Number(req.params.lessonId);
    const { title, type, duration, lesson_order } = req.body;
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "A valid lesson ID is required" });
    const parsedTitle = title === undefined ? null : parseTitle(title, "Lesson title");
    if (parsedTitle && parsedTitle.error) return res.status(400).json({ message: parsedTitle.error });
    if (type !== undefined && !["video", "audio"].includes(type)) return res.status(400).json({ message: "Lesson type must be video or audio" });
    if (duration !== undefined && (!Number.isFinite(Number(duration)) || Number(duration) < 0)) return res.status(400).json({ message: "duration must be a non-negative number" });
    if (lesson_order !== undefined && (!Number.isInteger(Number(lesson_order)) || Number(lesson_order) < 1)) return res.status(400).json({ message: "lesson_order must be a positive integer" });
    try {
        const result = await pool.query(`UPDATE lessons SET title = COALESCE($1,title), type = COALESCE($2,type),
            duration = COALESCE($3,duration), lesson_order = COALESCE($4,lesson_order)
            WHERE id = $5 RETURNING id,module_id,title,type,duration,lesson_order,
            (file_path IS NOT NULL AND file_path <> '') AS has_media`, [
            parsedTitle ? parsedTitle.value : null, type === undefined ? null : type,
            duration === undefined ? null : Number(duration), lesson_order === undefined ? null : Number(lesson_order), id
        ]);
        if (!result.rows.length) return res.status(404).json({ message: "Lesson not found" });
        return res.json({ lesson: result.rows[0] });
    } catch (error) {
        return respondWithDbError(res, error, "Could not update lesson");
    }
});

router.delete("/:lessonId", authenticateToken, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.lessonId);
    if (!id) return res.status(400).json({ message: "A valid lesson ID is required" });
    const problem = confirmProblem(req.body);
    if (problem) return res.status(400).json({ message: problem });
    try {
        const outcome = await removeContent("lesson", id);
        if (!outcome.found) return res.status(404).json({ message: "Lesson not found" });
        return res.json({
            message: outcome.course_unpublished
                ? "Lesson deleted. The course was returned to draft because it is no longer ready to publish."
                : "Lesson deleted",
            course_unpublished: outcome.course_unpublished
        });
    } catch (error) {
        if (error && error.status === 400) return res.status(400).json({ message: error.message });
        return respondWithDbError(res, error, "Could not delete lesson");
    }
});


module.exports = router;
