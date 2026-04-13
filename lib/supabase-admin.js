// lib/supabase-admin.js
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServerConfig } from "./env.js";

const {
  url: supabaseUrl,
  serviceRoleKey: supabaseServiceRoleKey,
} = getSupabaseServerConfig();

if (!supabaseUrl) {
  throw new Error("Missing SUPABASE_URL in environment variables.");
}

if (!supabaseServiceRoleKey) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in environment variables.");
}

export const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseServiceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

export default supabaseAdmin;