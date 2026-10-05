const multer = require("multer");
const path = require("path");

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, "../uploads"));
    },

    filename: (req, file, cb) => {
        const uniqueName =
            Date.now() + "-" + Math.round(Math.random() * 1E9);

        cb(null, uniqueName + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {

    const allowedExtensions = [
        ".mp4",
        ".webm",
        ".mov",
        ".mp3",
        ".wav",
        ".m4a"
    ];

    const extension = path.extname(file.originalname).toLowerCase();

    if (allowedExtensions.includes(extension)) {
        cb(null, true);
    } else {
        cb(new Error("Only video and audio files are allowed"));
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 500 * 1024 * 1024
    }
});

module.exports = upload;