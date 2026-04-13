// lib/supabase-browser.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { getSupabasePublicConfig } from "./env.js";

let browserClient = null;

function assertBrowser() {
  if (typeof window === "undefined") {
    throw new Error("supabase-browser.js can only run in the browser.");
  }
}

export function createSupabaseBrowserClient() {
  assertBrowser();

  const {
    url,
    anonKey,
  } = getSupabasePublicConfig();

  if (!url) {
    throw new Error(
      "Missing Supabase URL in browser config. Add NEXT_PUBLIC_SUPABASE_URL, SUPABASE_URL, window.CARDLEO_ENV, or a matching meta tag."
    );
  }

  if (!anonKey) {
    throw new Error(
      "Missing Supabase anon key in browser config. Add NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_ANON_KEY, or matching browser config."
    );
  }

  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      storageKey: "cardleo-supabase-auth",
    },
    global: {
      headers: {
        "x-client-info": "cardleo-rewards-browser",
      },
    },
  });
}

export function getSupabaseBrowser() {
  if (browserClient) return browserClient;
  browserClient = createSupabaseBrowserClient();
  return browserClient;
}

export const supabaseBrowser = new Proxy(
  {},
  {
    get(_, prop) {
      const client = getSupabaseBrowser();
      return client[prop];
    },
  }
);

export default supabaseBrowser;