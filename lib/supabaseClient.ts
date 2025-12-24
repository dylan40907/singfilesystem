// lib/supabaseClient.ts
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase =
  typeof window === "undefined"
    ? // prevent server build from exploding if someone accidentally imports this
      // (still better to NOT import it on server at all)
      createClient(url, anon)
    : createClient(url, anon);
