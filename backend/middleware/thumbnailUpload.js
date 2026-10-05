const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const destination = path.resolve(__dirname, "../uploads/thumbnails");
fs.mkdirSync(destination, { recursive: true });

const mimeByExtension = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif"
};

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, callback) => callback(null, destination),
        filename: (_req, file, callback) => {
            const extension = path.extname(file.originalname).toLowerCase();
            callback(null, `${crypto.randomUUID()}${extension}`);
        }
    }),
    fileFilter: (_req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        if (mimeByExtension[extension] !== file.mimetype) return callback(new Error("Choose a valid JPG, PNG, WebP, or GIF image"));
        return callback(null, true);
    },
    limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

module.exports = upload;
