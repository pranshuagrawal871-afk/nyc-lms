const pool = require("../config/db");

function requireCourseAccess(source) {
    return async function (req, res, next) {
        try {
            let courseId;
            if (source === "course") {
                courseId = Number(req.params.courseId);
            } else {
                const moduleId = Number(req.params.moduleId);
                if (!Number.isSafeInteger(moduleId) || moduleId <= 0) return res.status(400).json({ message: "A valid module ID is required" });
                const result = await pool.query("SELECT course_id FROM modules WHERE id = $1", [moduleId]);
                if (!result.rows.length) return res.status(404).json({ message: "Module not found" });
                courseId = Number(result.rows[0].course_id);
            }
            if (!Number.isSafeInteger(courseId) || courseId <= 0) return res.status(400).json({ message: "A valid course ID is required" });
            if (req.user.role === "admin") return next();
            const result = await pool.query("SELECT 1 FROM enrollments WHERE user_id = $1 AND course_id = $2", [req.user.id, courseId]);
            if (!result.rows.length) return res.status(403).json({ message: "Enroll in this course to access its lessons" });
            return next();
        } catch (error) {
            console.error("Course access check failed:", error.message);
            return res.status(500).json({ message: "Could not verify course access" });
        }
    };
}

module.exports = requireCourseAccess;
