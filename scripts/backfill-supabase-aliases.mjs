/**
 * Make the *new* keys resolvable in Supabase Storage as well as R2.
 *
 * The migration repointed every database row to a prefixed key (albums/… ,
 * chat/…). R2 has those; Supabase Storage still holds the same bytes under the
 * old bare key. So any client still running a pre-migration build asks Supabase
 * for a key it has never heard of and shows nothing — which is how a routine
 * migration turned into "all our images are gone" for anyone who hadn't taken
 * the update yet.
 *
 * This copies each object to its prefixed name *within Supabase*, server-side,
 * so old and new builds both work and nobody has to rush an update. It's
 * additive: the original objects stay exactly where they are.
 *
 * Delete these aliases once every client is known to be on the new build.
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

for (const line of fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PREFIX = {
  albums: "albums",
  "chat-attachments": "chat",
  "sales-email-assets": "sales-email",
};

async function listAll(bucket, prefix = "", acc = []) {
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error(`${bucket}: ${error.message}`);
  for (const entry of data ?? []) {
    const full = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) await listAll(bucket, full, acc);
    else acc.push(full);
  }
  return acc;
}

let copied = 0, skipped = 0, failed = 0;

for (const [bucket, prefix] of Object.entries(PREFIX)) {
  const keys = await listAll(bucket);
  // Anything already under the prefix is an alias from a previous run.
  const originals = keys.filter((k) => !k.startsWith(`${prefix}/`));
  const existing = new Set(keys.filter((k) => k.startsWith(`${prefix}/`)));
  console.log(`\n${bucket}: ${originals.length} original(s), ${existing.size} alias(es) already present`);

  for (const key of originals) {
    const alias = `${prefix}/${key}`;
    if (existing.has(alias)) { skipped++; continue; }
    const { error } = await supabase.storage.from(bucket).copy(key, alias);
    if (error) {
      // "already exists" is fine — treat anything else as a real failure.
      if (/exists/i.test(error.message)) { skipped++; continue; }
      failed++;
      console.error(`  FAILED ${key}: ${error.message}`);
      continue;
    }
    copied++;
    if (copied % 50 === 0) console.log(`  …${copied} aliased`);
  }
}

console.log(`\nDone — aliased ${copied}, already present ${skipped}, failed ${failed}.`);
if (failed > 0) process.exitCode = 1;
