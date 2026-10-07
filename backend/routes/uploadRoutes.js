const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const pool = require("../config/db");
const getSupabase = require("../config/supabase");
const upload = require("../middleware/upload");
const authenticateToken = require("../middleware/auth");
const requireAdmin = authenticateToken.requireAdmin;
const thumbnailUpload = require("../middleware/thumbnailUpload");
const { inspectUploadedMedia, retireObject, cleanupRetiredMedia } = require("../lib/mediaLifecycle");

const router = express.Router();

router.post("/thumbnail", authenticateToken, requireAdmin, thumbnailUpload.single("thumbnail"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Select a thumbnail image to upload" });
    try {
        const header = await fs.readFile(req.file.path).then(buffer => buffer.subarray(0, 12));
        const extension = path.extname(req.file.filename).toLowerCase();
        const valid = extension === ".png" ? header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
            : extension === ".jpg" || extension === ".jpeg" ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
            : extension === ".gif" ? header.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)
            : extension === ".webp" ? header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP"
            : false;
        if (!valid) {
            return res.status(400).json({ message: "The selected file is not a valid image" });
        }
        const storagePath = `courses/pending/${crypto.randomUUID()}${extension}`;
        const { data, error } = await getSupabase().storage
            .from("course-thumbnails")
            .upload(storagePath, require("fs").createReadStream(req.file.path), {
                contentType: req.file.mimetype,
                upsert: false
            });
        if (error) throw error;
        const { data: publicData } = getSupabase().storage.from("course-thumbnails").getPublicUrl(data.path);
        try {
            await retireObject("course-thumbnails", data.path);
        } catch (retireError) {
            console.error("Could not schedule thumbnail cleanup:", retireError.message);
        }
        return res.status(201).json({
            message: "Thumbnail uploaded successfully",
            thumbnailUrl: publicData.publicUrl
        });
    } catch (error) {
        console.error("Thumbnail upload failed:", error.message);
        return res.status(502).json({ message: "Could not upload thumbnail. Check Storage configuration and try again." });
    } finally {
        await removeUploadedFile(req.file.path);
    }
});

async function removeUploadedFile(filePath) {
    if (!filePath) return;
    try {
        await fs.unlink(filePath);
    } catch (error) {
        if (error.code !== "ENOENT") {
            console.error("Could not remove failed upload:", error.message);
        }
    }
}

// Upload media for a lesson
router.post("/lesson/:lessonId", authenticateToken, requireAdmin, upload.single("media"), async (req, res) => {
    let storagePath;
    let storageClient;
    let databaseUpdated = false;
    try {
        const { lessonId } = req.params;

        // Check if a file was uploaded
        if (!req.file) {
            return res.status(400).json({
                message: "No media file uploaded"
            });
        }

        // Determine type from file extension
        // This is more reliable than MIME type because
        // some downloaded MP4 files are detected as application/octet-stream.
        const extension = path.extname(
            req.file.originalname
        ).toLowerCase();

        const videoExtensions = [
            ".mp4",
            ".webm",
            ".mov"
        ];

        const fileType = videoExtensions.includes(extension)
            ? "video"
            : "audio";

        const filePath = req.file.path;

        const lessonInfo = await pool.query(
            `SELECT l.id, l.file_path, m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1`,
            [lessonId]
        );
        if (!lessonInfo.rows.length) {
            await removeUploadedFile(filePath);
            return res.status(404).json({ message: "Lesson not found" });
        }

        let duration;
        try {
            const inspected = await inspectUploadedMedia(filePath, extension);
            duration = inspected.duration;
        } catch (error) {
            await removeUploadedFile(filePath);
            console.error("Uploaded media was rejected:", error.message);
            return res.status(error.status || 422).json({
                message: error.message || "Could not determine media duration. The uploaded file was discarded; try a valid video or audio file."
            });
        }

        storageClient = getSupabase();
        storagePath = `courses/${lessonInfo.rows[0].course_id}/lessons/${lessonId}/${crypto.randomUUID()}${extension}`;
        const { error: storageError } = await storageClient.storage
            .from("course-videos")
            .upload(storagePath, require("fs").createReadStream(filePath), {
                contentType: req.file.mimetype || "application/octet-stream",
                upsert: false
            });
        if (storageError) throw storageError;

        const result = await pool.query(
            `UPDATE lessons
             SET file_path = $1,
                 type = $2,
                 duration = $3
             WHERE id = $4
             RETURNING *`,
            [
                storagePath,
                fileType,
                duration,
                lessonId
            ]
        );

        if (result.rows.length === 0) {
            await storageClient.storage.from("course-videos").remove([storagePath]);
            await removeUploadedFile(filePath);
            return res.status(404).json({
                message: "Lesson not found"
            });
        }

        databaseUpdated = true;
        const previousPath = lessonInfo.rows[0].file_path;
        if (previousPath && previousPath !== storagePath) {
            const bucket = String(previousPath).startsWith("courses/") ? "course-videos" : "local-uploads";
            try {
                await retireObject(bucket, previousPath);
            } catch (retireError) {
                console.error("Could not schedule removal of replaced media:", retireError.message);
            }
        }
        cleanupRetiredMedia().catch((cleanupError) => {
            console.error("Retired media cleanup failed:", cleanupError.message);
        });
        await removeUploadedFile(filePath);

        // Success response
        res.json({
            message: "Media uploaded successfully",

            lesson: {
                id: result.rows[0].id,
                module_id: result.rows[0].module_id,
                title: result.rows[0].title,
                type: result.rows[0].type,
                duration: result.rows[0].duration,
                lesson_order: result.rows[0].lesson_order,
                has_media: true
            },

            file: {
                filename: req.file.filename,
                originalName: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size,
                type: fileType
            }
        });

    } catch (error) {
        console.error("Media upload failed:", error.message);
        if (storagePath && storageClient && !databaseUpdated) {
            const { error: cleanupError } = await storageClient.storage.from("course-videos").remove([storagePath]);
            if (cleanupError) console.error("Could not remove unreferenced Storage upload:", cleanupError.message);
        }
        if (req.file) await removeUploadedFile(req.file.path);

        res.status(502).json({
            message: "Media upload failed. Check Storage configuration and try again."
        });
    }
});

module.exports = router;
