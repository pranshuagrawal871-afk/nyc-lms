const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const { spawn } = require("child_process");
const crypto = require("crypto");
const pool = require("../config/db");
const getSupabase = require("../config/supabase");
const upload = require("../middleware/upload");
const authenticateToken = require("../middleware/auth");
const requireAdmin = authenticateToken.requireAdmin;
const thumbnailUpload = require("../middleware/thumbnailUpload");

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

function runFfprobe(binary, filePath) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            filePath
        ], { windowsHide: true });

        let stdout = "";
        let stderr = "";
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("ffprobe timed out while reading media metadata"));
        }, 20000);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.once("error", error => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once("close", code => {
            clearTimeout(timeout);
            if (code !== 0) {
                return reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
            }

            const seconds = Number(stdout.trim());
            if (!Number.isFinite(seconds) || seconds < 0) {
                return reject(new Error("ffprobe did not return a valid media duration"));
            }
            resolve(Math.round(seconds));
        });
    });
}

async function detectDuration(filePath) {
    let binary = "ffprobe";
    try {
        const bundled = require("ffprobe-static");
        if (bundled && bundled.path) binary = bundled.path;
    } catch (error) {
        if (error.code !== "MODULE_NOT_FOUND") throw error;
    }

    try {
        return await runFfprobe(binary, filePath);
    } catch (error) {
        // Keep existing deployments working when they have not yet installed
        // the bundled binary; metadata is still read from the uploaded file.
        if (error.code !== "ENOENT") throw error;
        const { parseFile } = await import("music-metadata");
        const metadata = await parseFile(filePath);
        const seconds = metadata.format.duration;
        if (!Number.isFinite(seconds) || seconds < 0) {
            throw new Error("No valid duration was found in the media metadata");
        }
        return Math.round(seconds);
    }
}

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
            `SELECT l.id, m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1`,
            [lessonId]
        );
        if (!lessonInfo.rows.length) {
            await removeUploadedFile(filePath);
            return res.status(404).json({ message: "Lesson not found" });
        }

        let duration;
        try {
            duration = await detectDuration(filePath);
        } catch (error) {
            await removeUploadedFile(filePath);
            console.error("Unable to determine uploaded media duration:", error.message);
            return res.status(422).json({
                message: "Could not determine media duration. The uploaded file was discarded; try a valid video or audio file."
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
