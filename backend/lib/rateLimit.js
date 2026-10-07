function createRateLimiter({ windowMs, max }) {
    const hits = new Map();

    return function rateLimit(req, res, next) {
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
        const ip = req.ip || req.socket?.remoteAddress || "unknown";
        const key = email ? `email:${email}` : `ip:${ip}`;
        const now = Date.now();
        const recent = (hits.get(key) || []).filter((stamp) => now - stamp < windowMs);
        if (recent.length >= max) {
            const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
            res.set("Retry-After", String(retryAfter));
            return res.status(429).json({ message: "Too many attempts. Please wait and try again." });
        }
        recent.push(now);
        hits.set(key, recent);
        if (hits.size > 5000) {
            for (const [entryKey, stamps] of hits) {
                if (!stamps.some((stamp) => now - stamp < windowMs)) hits.delete(entryKey);
            }
        }
        return next();
    };
}

module.exports = { createRateLimiter };
