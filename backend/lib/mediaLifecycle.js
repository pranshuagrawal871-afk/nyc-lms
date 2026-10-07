const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const pool = require("../config/db");
const getSupabase = require("../config/supabase");

const UPLOAD_ROOT = path.resolve(__dirname, "../uploads");
const DEFAULT_RETENTION_HOURS = 24;

const BROWSER_VIDEO = {
    ".mp4": { video: new Set(["h264"]), audio: new Set(["aac", "mp3"]) },
    ".mov": { video: new Set(["h264"]), audio: new Set(["aac", "mp3"]) },
    ".webm": { video: new Set(["vp8", "vp9", "av1"]), audio: new Set(["opus", "vorbis"]) }
};

const BROWSER_AUDIO = {
    ".mp3": new Set(["mp3"]),
    ".wav": new Set(["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_u8", "pcm_f32le"]),
    ".m4a": new Set(["aac"])
};

function retentionHours() {
    const configured = Number(process.env.MEDIA_RETENTION_HOURS);
    if (Number.isFinite(configured) && configured >= 1 && configured <= 24 * 30) return configured;
    return DEFAULT_RETENTION_HOURS;
}

function localMediaPath(filePath) {
    const resolved = path.resolve(UPLOAD_ROOT, path.basename(String(filePath || "")));
    if (!resolved.startsWith(UPLOAD_ROOT + path.sep)) return null;
    return resolved;
}

function localThumbnailPath(filePath) {
    const base = path.basename(String(filePath || ""));
    if (!base || base === "." || base === "..") return null;
    const directory = path.resolve(UPLOAD_ROOT, "thumbnails");
    const resolved = path.resolve(directory, base);
    if (!resolved.startsWith(directory + path.sep)) return null;
    return resolved;
}

async function mediaExists(filePath) {
    if (!filePath) return false;
    if (!String(filePath).startsWith("courses/")) {
        const local = localMediaPath(filePath);
        return Boolean(local && fs.existsSync(local));
    }
    const directory = path.posix.dirname(filePath);
    const name = path.posix.basename(filePath);
    const { data, error } = await getSupabase().storage.from("course-videos").list(directory, {
        search: name,
        limit: 20
    });
    if (error) {
        const failure = new Error("Could not verify lesson media");
        failure.status = 503;
        throw failure;
    }
    return Array.isArray(data) && data.some((item) => item.name === name);
}

async function retireObject(bucket, objectPath) {
    if (!objectPath) return;
    await pool.query(
        `INSERT INTO retired_media (bucket, object_path, delete_after)
         VALUES ($1, $2, CURRENT_TIMESTAMP + ($3 * INTERVAL '1 hour'))`,
        [bucket, objectPath, retentionHours()]
    );
}

async function cleanupRetiredMedia(limit = 20) {
    const due = await pool.query(
        `SELECT id, bucket, object_path
         FROM retired_media
         WHERE deleted_at IS NULL AND delete_after <= CURRENT_TIMESTAMP
         ORDER BY id
         LIMIT $1`,
        [limit]
    );
    for (const row of due.rows) {
        try {
            if (row.bucket === "course-thumbnails" || row.bucket === "local-thumbnails") {
                const referenced = await pool.query(
                    "SELECT 1 FROM courses WHERE thumbnail LIKE '%' || $1 || '%' ESCAPE '\\' LIMIT 1",
                    [row.object_path.replace(/[\\%_]/g, "\\$&")]
                );
                if (referenced.rows.length) {
                    await pool.query("UPDATE retired_media SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1", [row.id]);
                    continue;
                }
            }
            if (row.bucket === "local-thumbnails") {
                const local = localThumbnailPath(row.object_path);
                if (local) {
                    try { await fs.promises.unlink(local); }
                    catch (error) { if (error.code !== "ENOENT") throw error; }
                }
                await pool.query("UPDATE retired_media SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1", [row.id]);
                continue;
            }
            if (row.bucket === "course-videos" || row.bucket === "local-uploads") {
                const stillUsed = await pool.query("SELECT 1 FROM lessons WHERE file_path = $1 LIMIT 1", [row.object_path]);
                if (stillUsed.rows.length) {
                    await pool.query("UPDATE retired_media SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1", [row.id]);
                    continue;
                }
            }
            if (row.bucket === "course-videos" || row.bucket === "course-thumbnails") {
                const { error } = await getSupabase().storage.from(row.bucket).remove([row.object_path]);
                if (error) throw error;
            } else if (row.bucket === "local-uploads") {
                const local = localMediaPath(row.object_path);
                if (local) {
                    try { await fs.promises.unlink(local); }
                    catch (error) { if (error.code !== "ENOENT") throw error; }
                }
            }
            await pool.query("UPDATE retired_media SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1", [row.id]);
        } catch (error) {
            console.error("Retired media cleanup failed:", error.message);
        }
    }
}

function runFfprobe(binary, filePath) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, [
            "-v", "error",
            "-show_entries", "format=duration:stream=codec_type,codec_name",
            "-of", "json",
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
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timeout);
            if (code !== 0) return reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
            try { resolve(JSON.parse(stdout)); }
            catch (_) { reject(new Error("ffprobe did not return media metadata")); }
        });
    });
}

function compatibilityError(extension, streams) {
    const video = (streams || []).filter((stream) => stream.codec_type === "video" && !["mjpeg", "png", "jpeg"].includes(stream.codec_name));
    const audio = (streams || []).filter((stream) => stream.codec_type === "audio");
    const videoRule = BROWSER_VIDEO[extension];
    if (videoRule) {
        const videoCodec = video[0] && video[0].codec_name;
        if (!videoCodec || !videoRule.video.has(videoCodec)) {
            return `This ${extension} file is not browser-playable. Use H.264 video in MP4, or VP8/VP9 video in WebM.`;
        }
        const audioCodec = audio[0] && audio[0].codec_name;
        if (audioCodec && !videoRule.audio.has(audioCodec)) {
            return `The audio codec "${audioCodec}" may not play in the browser. Use AAC in MP4 or Opus in WebM.`;
        }
        return null;
    }
    const audioRule = BROWSER_AUDIO[extension];
    if (audioRule) {
        const audioCodec = audio[0] && audio[0].codec_name;
        if (!audioCodec || !audioRule.has(audioCodec)) {
            return "This audio file may not play in the browser. Use MP3, AAC, or WAV PCM.";
        }
        return null;
    }
    return "Only video and audio files are allowed";
}

async function inspectUploadedMedia(filePath, extension) {
    let binary = "ffprobe";
    try {
        const bundled = require("ffprobe-static");
        if (bundled && bundled.path) binary = bundled.path;
    } catch (error) {
        if (error.code !== "MODULE_NOT_FOUND") throw error;
    }

    let metadata;
    try {
        metadata = await runFfprobe(binary, filePath);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const { parseFile } = await import("music-metadata");
        const parsed = await parseFile(filePath);
        metadata = {
            format: { duration: parsed.format.duration },
            streams: [{ codec_type: "audio", codec_name: String(parsed.format.codec || "").toLowerCase() }]
        };
    }

    const seconds = Number(metadata.format && metadata.format.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error("No valid duration was found in the media metadata");
    }
    const problem = compatibilityError(extension, metadata.streams || []);
    if (problem) {
        const incompatible = new Error(problem);
        incompatible.status = 422;
        throw incompatible;
    }
    return { duration: Math.round(seconds), streams: metadata.streams || [] };
}

module.exports = {
    mediaExists,
    retireObject,
    cleanupRetiredMedia,
    inspectUploadedMedia,
    compatibilityError,
    retentionHours
};
