const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const { Pool } = require("pg");

function sslConfig() {
    if (process.env.DB_SSL === "false") return false;
    const requested = String(process.env.DB_SSL_REJECT_UNAUTHORIZED || "").toLowerCase();
    let rejectUnauthorized;
    if (requested === "true") rejectUnauthorized = true;
    else if (requested === "false") rejectUnauthorized = false;
    else rejectUnauthorized = process.env.NODE_ENV === "production";
    if (!rejectUnauthorized && process.env.NODE_ENV === "production") {
        console.warn("PostgreSQL certificate verification is disabled in production. Set DB_SSL_REJECT_UNAUTHORIZED=true when the server CA is available.");
    }
    const ssl = { rejectUnauthorized };
    if (process.env.DB_SSL_CA) ssl.ca = process.env.DB_SSL_CA.replace(/\\n/g, "\n");
    return ssl;
}

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: sslConfig()
});

module.exports = pool;
