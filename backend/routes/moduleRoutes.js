const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const requireAdmin = authenticateToken.requireAdmin;
const requireCourseAccess = require("../middleware/courseAccess");
const { parseTitle, respondWithDbError } = require("../lib/validation");
const { returnPublishedCourseToDraft } = require("../lib/publishReadiness");
const { parsePositiveId, removeContent, confirmProblem } = require("../lib/contentRemoval");

const router = express.Router();


// GET all modules for a course
router.get("/course/:courseId", authenticateToken, requireCourseAccess("course"), async (req, res) => {
    try {
        const { courseId } = req.params;
        if (!/^\d+$/.test(courseId) || Number(courseId) <= 0) return res.status(400).json({ message: "A valid course ID is required" });

        const result = await pool.query(
            `SELECT *
             FROM modules
             WHERE course_id = $1
             ORDER BY module_order`,
            [courseId]
        );

        res.json(result.rows);

    } catch (error) {
        console.error("Error fetching modules:", error);

        res.status(500).json({
            message: "Failed to fetch modules"
        });
    }
});

router.patch("/:moduleId", authenticateToken, requireAdmin, async (req, res) => {
    const id = Number(req.params.moduleId);
    const { title, module_order } = req.body;
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "A valid module ID is required" });
    const parsedTitle = title === undefined ? null : parseTitle(title, "Module title");
    if (parsedTitle && parsedTitle.error) return res.status(400).json({ message: parsedTitle.error });
    if (module_order !== undefined && (!Number.isInteger(Number(module_order)) || Number(module_order) < 1)) return res.status(400).json({ message: "module_order must be a positive integer" });
    try {
        const result = await pool.query(`UPDATE modules SET title = COALESCE($1,title), module_order = COALESCE($2,module_order)
            WHERE id = $3 RETURNING *`, [parsedTitle ? parsedTitle.value : null, module_order === undefined ? null : Number(module_order), id]);
        if (!result.rows.length) return res.status(404).json({ message: "Module not found" });
        return res.json({ module: result.rows[0] });
    } catch (error) {
        return respondWithDbError(res, error, "Could not update module");
    }
});

router.delete("/:moduleId", authenticateToken, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.moduleId);
    if (!id) return res.status(400).json({ message: "A valid module ID is required" });
    const problem = confirmProblem(req.body);
    if (problem) return res.status(400).json({ message: problem });
    try {
        const outcome = await removeContent("module", id);
        if (!outcome.found) return res.status(404).json({ message: "Module not found" });
        return res.json({
            message: outcome.course_unpublished
                ? "Module deleted. The course was returned to draft because it is no longer ready to publish."
                : "Module deleted",
            course_unpublished: outcome.course_unpublished
        });
    } catch (error) {
        if (error && error.status === 400) return res.status(400).json({ message: error.message });
        return respondWithDbError(res, error, "Could not delete module");
    }
});


// POST create a module
router.post("/course/:courseId", authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { courseId } = req.params;
        if (!/^\d+$/.test(courseId) || Number(courseId) <= 0) return res.status(400).json({ message: "A valid course ID is required" });
        const parsedTitle = parseTitle(req.body.title, "Module title");
        if (parsedTitle.error) return res.status(400).json({ message: parsedTitle.error });
        const { module_order } = req.body;
        const order = module_order === undefined ? 1 : Number(module_order);
        if (!Number.isInteger(order) || order < 1) return res.status(400).json({ message: "module_order must be a positive integer" });

        const course = await pool.query("SELECT id, published FROM courses WHERE id = $1", [courseId]);
        if (!course.rows.length) return res.status(404).json({ message: "Course not found" });

        const result = await pool.query(
            `INSERT INTO modules
            (course_id, title, module_order)
            VALUES ($1, $2, $3)
            RETURNING *`,
            [
                courseId,
                parsedTitle.value,
                order
            ]
        );
        const courseUnpublished = await returnPublishedCourseToDraft(courseId);

        res.status(201).json({
            message: courseUnpublished
                ? "Module created. The course was returned to draft because it is no longer ready to publish."
                : "Module created successfully",
            module: result.rows[0],
            course_unpublished: courseUnpublished
        });

    } catch (error) {
        return respondWithDbError(res, error, "Failed to create module");
    }
});


module.exports = router;
