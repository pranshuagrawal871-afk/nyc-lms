const express = require("express");
const pool = require("../config/db");

const router = express.Router();

// GET all courses
router.get("/", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM courses ORDER BY id"
        );

        res.json(result.rows);

    } catch (error) {
        console.error("Error fetching courses:", error);

        res.status(500).json({
            message: "Failed to fetch courses"
        });
    }
});


// POST create a new course
router.post("/", async (req, res) => {
    try {
        const {
            title,
            description,
            thumbnail,
            published = false
        } = req.body;

        // Validate title
        if (!title || title.trim() === "") {
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
                published
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


module.exports = router;