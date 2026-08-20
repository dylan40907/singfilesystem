/**
 * Copy albums / chat attachments / sales email assets from Supabase Storage
 * into R2, preserving each object's key.
 *
 *   node scripts/migrate-storage-to-r2.mjs           # copy everything
 *   node scripts/migrate-storage-to-r2.mjs albums    # one bucket
 *   node scripts/migrate-storage-to-r2.mjs --verify  # report only, copy nothing
 *
 * Safe to re-run: an object already present in R2 with a matching size is
 * skipped, so an interrupted run resumes where it stopped. It only ever reads
 * from Supabase — nothing is deleted there, so the old copies stay put until
 * the migration is confirmed good.
 *
 * Keys are rewritten to the R2 prefix scheme (albums/… , chat/… ,
 * sales-email/…) and the new key is written back to the database, so the two
 * stay in step for every row.
 */

import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import fs from "node:fs";
import path from "node:path";

// .env.local isn't loaded automatically outside Next.
function loadEnv() {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
}
loadEnv();

const need = (n) => {
  const v = process.env[n];
  if (!v) { console.error(`Missing env var: ${n}`); process.exit(1); }
  return v;
};

const supabase = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"));
const s3 = new S3Client({
  region: "auto",
  endpoint: need("R2_ENDPOINT"),
  credentials: {
    accessKeyId: need("R2_ACCESS_KEY_ID"),
    secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
  },
});
const BUCKET = need("R2_BUCKET");

/**
 * Which table column holds the key for each bucket, so the database can be
 * repointed as each object lands.
 */
const PLAN = {
  albums:               { prefix: "albums",      table: "album_items",           column: "path" },
  "chat-attachments":   { prefix: "chat",        table: "chat_messages",         column: "attachment_path" },
  "sales-email-assets": { prefix: "sales-email", table: "sales_email_templates", column: null }, // keys live inside jsonb
};

const TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm",
  pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
};
function guessType(key) {
  return TYPES[(key.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream";
}

const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify");
const only = args.filter((a) => !a.startsWith("--"));
const buckets = only.length ? only : Object.keys(PLAN);

/** Every object in a bucket, walking the pagination. */
async function listAll(bucket, prefix = "", acc = []) {
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error(`${bucket}: ${error.message}`);
  for (const entry of data ?? []) {
    const full = prefix ? `${prefix}/${entry.name}` : entry.name;
    // A folder has no id; recurse into it.
    if (entry.id === null) await listAll(bucket, full, acc);
    else acc.push({ key: full, size: entry.metadata?.size ?? 0 });
  }
  return acc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry with backoff.
 *
 * Supabase's TLS connection intermittently fails mid-download with
 * "bad record mac" — a transient fault, not a bad object. Without a retry the
 * first run gave up on 379 of 468 files.
 */
async function withRetry(label, fn, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(400 * 2 ** i);
    }
  }
  throw new Error(`${label}: ${lastErr?.message ?? lastErr}`);
}

async function existsInR2(key, size) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return size === 0 || head.ContentLength === size;
  } catch {
    return false;
  }
}

async function run() {
  let copied = 0, skipped = 0, failed = 0, repointed = 0;

  for (const bucket of buckets) {
    const plan = PLAN[bucket];
    if (!plan) { console.error(`Unknown bucket: ${bucket}`); continue; }

    const objects = await listAll(bucket);
    console.log(`\n${bucket}: ${objects.length} object(s)`);

    for (const obj of objects) {
      const newKey = `${plan.prefix}/${obj.key}`;

      if (await existsInR2(newKey, obj.size)) {
        skipped++;
        continue;
      }
      if (verifyOnly) {
        console.log(`  MISSING in R2: ${newKey}`);
        failed++;
        continue;
      }

      try {
        // A fresh signed URL fetched directly, rather than the supabase-js
        // download helper — it reuses a pooled TLS connection that is what
        // keeps breaking on larger files.
        const body = await withRetry(`download ${obj.key}`, async () => {
          const { data: signed, error: sErr } = await supabase.storage
            .from(bucket).createSignedUrl(obj.key, 600);
          if (sErr || !signed?.signedUrl) throw new Error(sErr?.message ?? "could not sign");
          const r = await fetch(signed.signedUrl);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return Buffer.from(await r.arrayBuffer());
        });

        await withRetry(`upload ${newKey}`, () => s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: newKey,
          Body: body,
          ContentType: guessType(obj.key),
        })));
        copied++;

        // Repoint the row only after the object is safely in R2.
        if (plan.column) {
          const { error: upErr } = await supabase
            .from(plan.table)
            .update({ [plan.column]: newKey })
            .eq(plan.column, obj.key);
          if (upErr) console.warn(`  ! row not repointed for ${obj.key}: ${upErr.message}`);
          else repointed++;
        }

        if (copied % 25 === 0) console.log(`  …${copied} copied`);
      } catch (e) {
        failed++;
        console.error(`  FAILED ${obj.key}: ${e.message}`);
      }
    }
  }

  console.log(
    `\n${verifyOnly ? "Verify" : "Migration"} complete — ` +
    `copied ${copied}, already present ${skipped}, rows repointed ${repointed}, failed ${failed}.`
  );
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error(e); process.exit(1); });
