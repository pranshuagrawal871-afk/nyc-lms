const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

function configuredSecret(res) {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    console.error("JWT_SECRET is not configured");
    res.status(500).json({ message: "Authentication is not configured" });
    return null;
}

router.post("/register", async (req, res) => {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!name || name.length > 100) {
        return res.status(400).json({ message: "Name is required and must be at most 100 characters" });
    }
    if (!email || email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ message: "Enter a valid email address" });
    }
    if (password.length < 8 || password.length > 72) {
        return res.status(400).json({ message: "Password must be between 8 and 72 characters" });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 12);
        const result = await pool.query(
            `INSERT INTO users (name, email, password, role)
             VALUES ($1, $2, $3, 'student')
             RETURNING id, name, email, role, created_at`,
            [name, email, passwordHash]
        );
        return res.status(201).json({
            message: "Account created successfully. Please log in.",
            user: result.rows[0]
        });
    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({ message: "An account with this email already exists" });
        }
        console.error("Registration error:", error);
        return res.status(500).json({ message: "Could not create account" });
    }
});

router.post("/login", async (req, res) => {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
    }

    const secret = configuredSecret(res);
    if (!secret) return;

    try {
        const result = await pool.query(
            "SELECT id, name, email, role, password FROM users WHERE email = $1",
            [email]
        );
        const user = result.rows[0];
        if (!user) {
            return res.status(401).json({ message: "Invalid email or password" });
        }
        const isHash = /^\$2[aby]\$\d{2}\$/.test(user.password || "");
        const validPassword = isHash
            ? await bcrypt.compare(password, user.password)
            : password === user.password;
        if (!validPassword) return res.status(401).json({ message: "Invalid email or password" });
        if (!isHash) {
            const upgradedHash = await bcrypt.hash(password, 12);
            await pool.query("UPDATE users SET password = $1 WHERE id = $2", [upgradedHash, user.id]);
        }

        const token = jwt.sign(
            { id: user.id, role: user.role, email: user.email },
            secret,
            { expiresIn: "1d" }
        );

        return res.json({
            message: "Login successful",
            token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role }
        });
    } catch (error) {
        console.error("Login error:", error);
        return res.status(500).json({ message: "Could not log in" });
    }
});

router.get("/me", authenticateToken, (req, res) => {
    res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role } });
});

router.post("/change-password", authenticateToken, async (req, res) => {
    const currentPassword = typeof req.body.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body.newPassword === "string" ? req.body.newPassword : "";
    if (!currentPassword || !newPassword) return res.status(400).json({ message: "Current and new passwords are required" });
    if (newPassword.length < 8 || newPassword.length > 72) return res.status(400).json({ message: "New password must be between 8 and 72 characters" });
    if (currentPassword === newPassword) return res.status(400).json({ message: "Choose a new password different from your current password" });
    try {
        const result = await pool.query("SELECT password FROM users WHERE id = $1", [req.user.id]);
        if (!result.rows.length) return res.status(404).json({ message: "Account not found" });
        const stored = result.rows[0].password || "";
        const isHash = /^\$2[aby]\$\d{2}\$/.test(stored);
        const valid = isHash ? await bcrypt.compare(currentPassword, stored) : currentPassword === stored;
        if (!valid) return res.status(401).json({ message: "Current password is incorrect" });
        const passwordHash = await bcrypt.hash(newPassword, 12);
        await pool.query("UPDATE users SET password = $1 WHERE id = $2", [passwordHash, req.user.id]);
        return res.json({ message: "Password changed successfully" });
    } catch (error) {
        console.error("Password change failed:", error.message);
        return res.status(500).json({ message: "Could not change password" });
    }
});

module.exports = router;
