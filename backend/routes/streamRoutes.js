const express = require("express");
const fs = require("fs");
const path = require("path");
const pool = require("../config/db");
const jwt = require("jsonwebtoken");
const authenticateToken = require("../middleware/auth");
const getSupabase = require("../config/supabase");

const router = express.Router();

router.get("/token/:lessonId", authenticateToken, async (req, res) => {
    const lessonId = Number(req.params.lessonId);
    if (!Number.isSafeInteger(lessonId) || lessonId <= 0) return res.status(400).json({ message: "A valid lesson ID is required" });
    try {
        const lesson = await pool.query(`SELECT l.id, m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1`, [lessonId]);
        if (!lesson.rows.length) return res.status(404).json({ message: "Lesson not found" });
        if (req.user.role !== "admin") {
            const enrollment = await pool.query("SELECT 1 FROM enrollments WHERE user_id = $1 AND course_id = $2", [req.user.id, lesson.rows[0].course_id]);
            if (!enrollment.rows.length) return res.status(403).json({ message: "Enroll in this course to watch its lessons" });
        }
        const token = jwt.sign({ scope: "lesson-stream", lessonId, userId: req.user.id }, process.env.JWT_SECRET, { expiresIn: "1h" });
        return res.json({ url: `/api/stream/${lessonId}?token=${encodeURIComponent(token)}` });
    } catch (error) {
        console.error("Stream authorization failed:", error.message);
        return res.status(500).json({ message: "Could not authorize media playback" });
    }
});

router.get("/:lessonId", async (req, res) => {
    try {
        const lessonId = Number(req.params.lessonId);
        if (!Number.isSafeInteger(lessonId) || lessonId <= 0) return res.status(400).json({ message: "A valid lesson ID is required" });
        let access;
        try { access = jwt.verify(String(req.query.token || ""), process.env.JWT_SECRET); }
        catch (_) { return res.status(401).json({ message: "A valid stream token is required" }); }
        if (access.scope !== "lesson-stream" || Number(access.lessonId) !== lessonId) return res.status(403).json({ message: "Stream token does not grant access to this lesson" });

        // Get lesson information
        const result = await pool.query(
            `SELECT file_path, type
             FROM lessons
             WHERE id = $1`,
            [lessonId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Lesson not found"
            });
        }

        const lesson = result.rows[0];

        if (!lesson.file_path) {
            return res.status(404).json({
                message: "No media file attached to this lesson"
            });
        }

        // New media is stored as a private-bucket object key. Preserve the
        // existing local byte-range stream for records created before migration.
        if (String(lesson.file_path).startsWith("courses/")) {
            const { data, error } = await getSupabase().storage
                .from("course-videos")
                .createSignedUrl(lesson.file_path, 60 * 60);
            if (error || !data || !data.signedUrl) {
                console.error("Could not create lesson media URL:", error && error.message);
                return res.status(502).json({ message: "Could not prepare lesson playback" });
            }
            return res.redirect(302, data.signedUrl);
        }

        // Convert stored path into absolute path
        const uploadRoot = path.resolve(__dirname, "../uploads");
        const filePath = path.resolve(uploadRoot, path.basename(String(lesson.file_path)));
        if (!filePath.startsWith(uploadRoot + path.sep)) return res.status(404).json({ message: "Media file not found" });

        // Check file exists
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({
                message: "Media file not found"
            });
        }

        const stat = fs.statSync(filePath);
        const fileSize = stat.size;

        // Determine content type
        const extension = path.extname(filePath).toLowerCase();

        const mimeTypes = {
            ".mp4": "video/mp4",
            ".webm": "video/webm",
            ".mov": "video/quicktime",
            ".mp3": "audio/mpeg",
            ".wav": "audio/wav",
            ".m4a": "audio/mp4"
        };

        const contentType =
            mimeTypes[extension] || "application/octet-stream";

        // Check Range header
        const range = req.headers.range;

        if (!range) {
            res.writeHead(200, {
                "Content-Length": fileSize,
                "Content-Type": contentType,
                "Accept-Ranges": "bytes"
            });

            fs.createReadStream(filePath).pipe(res);

            return;
        }

        // Example:
        // Range: bytes=1000-2000

        if (!/^bytes=\d*-\d*$/.test(range) || range === "bytes=-") return res.status(416).set({ "Content-Range": `bytes */${fileSize}` }).end();
        const parts = range.replace(/bytes=/, "").split("-");

        let start = parts[0] ? parseInt(parts[0], 10) : NaN;
        let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (Number.isNaN(start)) {
            const suffixLength = end;
            if (!Number.isFinite(suffixLength) || suffixLength <= 0) return res.status(416).set({ "Content-Range": `bytes */${fileSize}` }).end();
            start = Math.max(0, fileSize - suffixLength);
            end = fileSize - 1;
        }
        end = Math.min(end, fileSize - 1);

        if (
            !Number.isFinite(start) || start < 0 ||
            start >= fileSize ||
            start > end
        ) {
            res.status(416).set({
                "Content-Range": `bytes */${fileSize}`
            });

            return res.end();
        }

        const chunkSize = end - start + 1;

        res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Content-Type": contentType
        });

        const stream = fs.createReadStream(filePath, {
            start,
            end
        });

        stream.pipe(res);

    } catch (error) {
        console.error("Streaming error:", error);

        res.status(500).json({
            message: "Streaming failed"
        });
    }
});

module.exports = router;
