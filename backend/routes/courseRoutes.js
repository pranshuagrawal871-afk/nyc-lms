const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const requireAdmin = authenticateToken.requireAdmin;

const router = express.Router();
const courseListSql = `SELECT c.*,
    (SELECT COUNT(*) FROM modules m JOIN lessons l ON l.module_id = m.id WHERE m.course_id = c.id) AS lesson_count
    FROM courses c`;

function validThumbnail(value) {
    if (value === undefined || value === null || value === "") return true;
    if (typeof value !== "string" || value.length > 2048) return false;
    if (/^\/media\/thumbnails\/[a-f0-9-]+\.(?:jpe?g|png|webp|gif)$/i.test(value)) return true;
    try { return ["http:", "https:"].includes(new URL(value).protocol); }
    catch (_) { return false; }
}

// GET all courses
router.get("/", async (req, res) => {
    try {
        const authorization = req.get("Authorization") || "";
        if (/^Bearer\s+\S+$/i.test(authorization)) {
            return authenticateToken(req, res, async () => {
                try {
                    const sql = req.user.role === "admin" ? `${courseListSql} ORDER BY c.id` : `${courseListSql} WHERE c.published = true ORDER BY c.id`;
                    const result = await pool.query(sql);
                    res.json(result.rows);
                } catch (error) {
                    console.error("Error fetching courses:", error.message);
                    res.status(500).json({ message: "Failed to fetch courses" });
                }
            });
        }
        const result = await pool.query(`${courseListSql} WHERE c.published = true ORDER BY c.id`);

        res.json(result.rows);

    } catch (error) {
        console.error("Error fetching courses:", error);

        res.status(500).json({
            message: "Failed to fetch courses"
        });
    }
});


// POST create a new course
router.post("/", authenticateToken, requireAdmin, async (req, res) => {
    try {
        const {
            title,
            description,
            thumbnail,
            published = false
        } = req.body;
        if (typeof published !== "boolean") return res.status(400).json({ message: "published must be true or false" });
        if (!validThumbnail(thumbnail)) return res.status(400).json({ message: "Thumbnail must be an HTTP(S) image URL or an uploaded thumbnail" });

        // Validate title
        if (typeof title !== "string" || title.trim() === "") {
            return res.status(400).json({
                message: "Course title is required"
            });
        }

        const result = await pool.query(
            `INSERT INTO courses
            (title, description, thumbnail, published)
            VALUES ($1, $2, $3, $4)
            RETURNING *`,
            [
                title.trim(),
                description || null,
                thumbnail || null,
                published === true
            ]
        );

        res.status(201).json({
            message: "Course created successfully",
            course: result.rows[0]
        });

    } catch (error) {
        console.error("Error creating course:", error);

        res.status(500).json({
            message: "Failed to create course"
        });
    }
});

router.patch("/:courseId", authenticateToken, requireAdmin, async (req, res) => {
    const id = Number(req.params.courseId);
    const { title, description, thumbnail, published } = req.body;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "A valid course ID is required" });
    if (title !== undefined && (typeof title !== "string" || !title.trim())) return res.status(400).json({ message: "Course title is required" });
    if (published !== undefined && typeof published !== "boolean") return res.status(400).json({ message: "Published must be true or false" });
    if (!validThumbnail(thumbnail)) return res.status(400).json({ message: "Thumbnail must be an HTTP(S) image URL or an uploaded thumbnail" });
    try {
        const result = await pool.query(
            `UPDATE courses SET title = COALESCE($1, title), description = COALESCE($2, description),
             thumbnail = COALESCE($3, thumbnail), published = COALESCE($4, published)
             WHERE id = $5 RETURNING *`,
            [title === undefined ? null : title.trim(), description === undefined ? null : description,
             thumbnail === undefined ? null : thumbnail, published === undefined ? null : published, id]
        );
        if (!result.rows.length) return res.status(404).json({ message: "Course not found" });
        return res.json({ course: result.rows[0] });
    } catch (error) {
        console.error("Course update failed:", error.message);
        return res.status(500).json({ message: "Could not update course" });
    }
});


module.exports = router;
