const TITLE_MAX = 200;

function parseTitle(value, label) {
    if (typeof value !== "string") {
        return { error: `${label} must be a string` };
    }
    const trimmed = value.trim();
    if (!trimmed) return { error: `${label} is required` };
    if (trimmed.length > TITLE_MAX) {
        return { error: `${label} must be at most ${TITLE_MAX} characters` };
    }
    return { value: trimmed };
}

function respondWithDbError(res, error, fallbackMessage) {
    if (error && error.code === "23503") {
        return res.status(404).json({ message: "The related course or module was not found" });
    }
    if (error && error.code === "23505") {
        return res.status(409).json({ message: "This record already exists" });
    }
    if (error && (error.code === "22P02" || error.code === "22001" || error.code === "22003")) {
        return res.status(400).json({ message: "A value has the wrong type or is out of range" });
    }
    console.error(fallbackMessage, error && error.message);
    return res.status(500).json({ message: fallbackMessage });
}

module.exports = { TITLE_MAX, parseTitle, respondWithDbError };
