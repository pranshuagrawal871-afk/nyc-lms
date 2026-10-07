const express = require("express");
const fs = require("fs");
const path = require("path");
const pool = require("../config/db");
const jwt = require("jsonwebtoken");
const authenticateToken = require("../middleware/auth");
const getSupabase = require("../config/supabase");
const { authorizeLesson } = require("../lib/entitlement");

const router = express.Router();

// Revocation window: stream JWTs are checked again when redeemed (enrollment
// and session version). The response then redirects to a Supabase signed URL.
// That signed URL cannot be revoked early and stays valid for
// STREAM_URL_TTL_SECONDS (default 1 hour). Password changes reject new stream
// tokens immediately. The player refreshes the token when playback fails.
function streamTtlSeconds() {
    const configured = Number(process.env.STREAM_URL_TTL_SECONDS);
    if (Number.isInteger(configured) && configured >= 60 && configured <= 60 * 60) return configured;
    return 60 * 60;
}

router.get("/token/:lessonId", authenticateToken, async (req, res) => {
    const lessonId = Number(req.params.lessonId);
    if (!Number.isSafeInteger(lessonId) || lessonId <= 0) return res.status(400).json({ message: "A valid lesson ID is required" });
    try {
        const access = await authorizeLesson(req.user, lessonId);
        if (!access.ok) return res.status(access.status).json({ message: access.message });
        const version = await pool.query("SELECT session_version FROM users WHERE id = $1", [req.user.id]);
        const ttl = streamTtlSeconds();
        const token = jwt.sign({
            scope: "lesson-stream",
            lessonId,
            userId: req.user.id,
            role: req.user.role,
            sv: Number(version.rows[0] && version.rows[0].session_version) || 0
        }, process.env.JWT_SECRET, { expiresIn: ttl });
        return res.json({ url: `/api/stream/${lessonId}?token=${encodeURIComponent(token)}`, expires_in: ttl });
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
        const viewer = await pool.query("SELECT id, role, session_version FROM users WHERE id = $1", [access.userId]);
        if (!viewer.rows.length) return res.status(401).json({ message: "A valid stream token is required" });
        const tokenVersion = Number.isInteger(access.sv) ? access.sv : 0;
        if (Number(viewer.rows[0].session_version) !== tokenVersion) {
            return res.status(401).json({ message: "Stream authorization expired. Reload the lesson." });
        }
        const lessonAccess = await authorizeLesson(
            { id: viewer.rows[0].id, role: viewer.rows[0].role },
            lessonId
        );
        if (!lessonAccess.ok) return res.status(lessonAccess.status).json({ message: lessonAccess.message });

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
                .createSignedUrl(lesson.file_path, streamTtlSeconds());
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
