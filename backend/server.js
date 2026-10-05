const express = require("express");
const path = require("path");

const pool = require("./config/db");
const courseRoutes = require("./routes/courseRoutes");
const moduleRoutes = require("./routes/moduleRoutes");
const lessonRoutes = require("./routes/lessonRoutes");
const uploadRoutes = require("./routes/uploadRoutes");
const streamRoutes = require("./routes/streamRoutes");
const progressRoutes = require("./routes/progressRoutes");
const authRoutes = require("./routes/authRoutes");
const enrollmentRoutes = require("./routes/enrollmentRoutes");
const adminRoutes = require("./routes/adminRoutes");

const app = express();

app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, "../frontend")));
app.use("/media/thumbnails", express.static(path.join(__dirname, "uploads/thumbnails"), {
    fallthrough: false,
    maxAge: "7d",
    setHeaders(res) { res.setHeader("X-Content-Type-Options", "nosniff"); }
}));

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/courses", courseRoutes);
app.use("/api/modules", moduleRoutes);
app.use("/api/lessons", lessonRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/stream", streamRoutes);
app.use("/api/progress", progressRoutes);
app.use("/api/enrollments", enrollmentRoutes);
app.use("/api/admin", adminRoutes);


// Home route
app.get("/", (req, res) => {
    res.send("NYC LMS Backend is running 🚀");
});


// Database test
app.get("/db-test", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");

        res.json({
            message: "Database connected!",
            time: result.rows[0].now
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Database connection failed"
        });
    }
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error && error.type === "entity.parse.failed") {
        return res.status(400).json({ message: "Request body must contain valid JSON" });
    }
    if (error && (error.name === "MulterError" || error.message === "Only video and audio files are allowed" || error.message === "Choose a valid JPG, PNG, WebP, or GIF image")) {
        const maxSizeMessage = req.path.includes("thumbnail") ? "Thumbnail must be 5 MB or smaller" : "Media file must be 500 MB or smaller";
        return res.status(400).json({ message: error.code === "LIMIT_FILE_SIZE" ? maxSizeMessage : error.message });
    }
    console.error("Unhandled API error:", error && error.message);
    return res.status(500).json({ message: "An unexpected server error occurred" });
});


if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

module.exports = app;
