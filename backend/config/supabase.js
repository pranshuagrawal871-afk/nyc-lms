const { createClient } = require("@supabase/supabase-js");

let client;

function getSupabase() {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey) {
        throw new Error("Supabase Storage is not configured");
    }
    if (!client) {
        client = createClient(url, serviceRoleKey, {
            auth: { autoRefreshToken: false, persistSession: false }
        });
    }
    return client;
}

module.exports = getSupabase;
