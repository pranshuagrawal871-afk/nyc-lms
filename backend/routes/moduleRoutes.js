const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const requireAdmin = authenticateToken.requireAdmin;
const requireCourseAccess = require("../middleware/courseAccess");

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
    if (title !== undefined && (typeof title !== "string" || !title.trim())) return res.status(400).json({ message: "Module title is required" });
    if (module_order !== undefined && (!Number.isInteger(Number(module_order)) || Number(module_order) < 1)) return res.status(400).json({ message: "module_order must be a positive integer" });
    try {
        const result = await pool.query(`UPDATE modules SET title = COALESCE($1,title), module_order = COALESCE($2,module_order)
            WHERE id = $3 RETURNING *`, [title === undefined ? null : title.trim(), module_order === undefined ? null : Number(module_order), id]);
        if (!result.rows.length) return res.status(404).json({ message: "Module not found" });
        return res.json({ module: result.rows[0] });
    } catch (error) {
        console.error("Module update failed:", error.message);
        return res.status(500).json({ message: "Could not update module" });
    }
});


// POST create a module
router.post("/course/:courseId", authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { courseId } = req.params;
        if (!/^\d+$/.test(courseId) || Number(courseId) <= 0) return res.status(400).json({ message: "A valid course ID is required" });
        const { title, module_order } = req.body;

        if (!title || title.trim() === "") {
            return res.status(400).json({
                message: "Module title is required"
            });
        }
        const order = module_order === undefined ? 1 : Number(module_order);
        if (!Number.isInteger(order) || order < 1) return res.status(400).json({ message: "module_order must be a positive integer" });

        const result = await pool.query(
            `INSERT INTO modules
            (course_id, title, module_order)
            VALUES ($1, $2, $3)
            RETURNING *`,
            [
                courseId,
                title.trim(),
                order
            ]
        );

        res.status(201).json({
            message: "Module created successfully",
            module: result.rows[0]
        });

    } catch (error) {
        console.error("Error creating module:", error);

        res.status(500).json({
            message: "Failed to create module"
        });
    }
});


module.exports = router;
