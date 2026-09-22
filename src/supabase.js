const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// Backend-only client. Prefer the Supabase Secret key so production can
// enable RLS while the scheduler retains privileged server-side access.
const apiKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL is not configured");
if (!apiKey) throw new Error("SUPABASE_SECRET_KEY (preferred) or SUPABASE_KEY is not configured");

const supabase = createClient(process.env.SUPABASE_URL, apiKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

module.exports = supabase;
