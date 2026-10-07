const jwt = require("jsonwebtoken");
const pool = require("../config/db");

function authenticateToken(req, res, next) {
    const authorization = req.get("Authorization") || "";
    const match = authorization.match(/^Bearer\s+(\S+)$/i);

    if (!match) {
        return res.status(401).json({ message: "Authentication token is required" });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
        console.error("JWT_SECRET is not configured");
        return res.status(500).json({ message: "Authentication is not configured" });
    }

    try {
        const payload = jwt.verify(match[1], secret);
        if (!payload.id || !payload.email || !payload.role) {
            return res.status(401).json({ message: "Invalid authentication token" });
        }

        return pool.query("SELECT id, name, email, role, session_version FROM users WHERE id = $1", [payload.id])
            .then(result => {
                if (!result.rows.length) return res.status(401).json({ message: "Invalid authentication token" });
                const user = result.rows[0];
                if (!["admin", "student"].includes(user.role)) return res.status(403).json({ message: "Account role is not authorized" });
                // Tokens issued before session versions existed are treated as version 0.
                const tokenVersion = Number.isInteger(payload.sv) ? payload.sv : 0;
                if (Number(user.session_version) !== tokenVersion) {
                    return res.status(401).json({ message: "Session is no longer valid. Please log in again." });
                }
                req.user = { id: user.id, name: user.name, email: user.email, role: user.role };
                return next();
            })
            .catch(error => {
                console.error("Authentication lookup failed:", error.message);
                return res.status(500).json({ message: "Could not verify authentication" });
            });
    } catch (error) {
        return res.status(401).json({ message: "Invalid or expired authentication token" });
    }
}

function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ message: "Authentication is required" });
    if (req.user.role !== "admin") return res.status(403).json({ message: "Administrator access is required" });
    return next();
}

module.exports = authenticateToken;
module.exports.requireAdmin = requireAdmin;
