const express = require("express");
const path = require("path");
const pool = require("./config/db");
const courseRoutes = require("./routes/courseRoutes");

const app = express();

app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, "../frontend")));

// Course API
app.use("/api/courses", courseRoutes);

app.get("/", (req, res) => {
    res.send("NYC LMS Backend is running 🚀");
});

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

const PORT = 3000;

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});