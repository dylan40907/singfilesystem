import { supabase } from "./supabaseClient";
import { htmlToSimplified, jsonToSimplified, toSimplified } from "./zh";
import type { Course, CourseObject, CourseSection, CourseSegment } from "./courses";

/**
 * Simplified-Chinese mirrors of the Traditional courses.
 *
 * Traditional is the only place anything is authored. Every Traditional course
 * has one Simplified mirror that is rebuilt from it, so the two can never drift.
 * A mirror can be unlocked (`synced = false`) to be edited by hand; while it is
 * unlocked the sync leaves it completely alone, and relocking rebuilds it from
 * the source, discarding those hand edits.
 *
 * The sync is a full idempotent rebuild rather than an incremental patch: it can
 * be re-run any number of times, and it repairs a mirror that fell behind for
 * any reason (a failed request, an edit made before this feature existed).
 * Rows are matched by `source_*_id` rather than recreated, so a learner's
 * progress — which references object ids — survives a resync.
 */

export type MirrorSyncResult = "synced" | "unlocked" | "not-a-source";

/** Deleting a source cascades to the mirror, so only additions/edits need work. */
export async function ensureSegmentMirrors(): Promise<Map<string, string>> {
  const { data } = await supabase.from("course_segments").select("*");
  const all = (data ?? []) as CourseSegment[];
  const sources = all.filter((s) => s.script !== "simp");
  const mirrorBySource = new Map(
    all.filter((s) => s.source_segment_id).map((s) => [s.source_segment_id as string, s])
  );

  const out = new Map<string, string>();
  for (const src of sources) {
    const name = await toSimplified(src.name);
    const existing = mirrorBySource.get(src.id);
    if (!existing) {
      const { data: made } = await supabase
        .from("course_segments")
        .insert({
          name,
          color: src.color,
          position: src.position,
          script: "simp",
          source_segment_id: src.id,
        })
        .select("id")
        .single();
      if (made) out.set(src.id, made.id as string);
      continue;
    }
    out.set(src.id, existing.id);
    // Only write when something actually changed — this runs on every save.
    if (existing.name !== name || existing.color !== src.color || existing.position !== src.position) {
      await supabase
        .from("course_segments")
        .update({ name, color: src.color, position: src.position })
        .eq("id", existing.id);
    }
  }
  return out;
}

/** Rebuild one Traditional course's Simplified mirror. Safe to call repeatedly. */
export async function syncCourseMirror(sourceCourseId: string): Promise<MirrorSyncResult> {
  const { data: srcRow } = await supabase.from("courses").select("*").eq("id", sourceCourseId).maybeSingle();
  const src = srcRow as Course | null;
  // Mirrors don't have mirrors of their own.
  if (!src || src.script === "simp") return "not-a-source";

  const { data: mirRow } = await supabase
    .from("courses").select("*").eq("source_course_id", sourceCourseId).maybeSingle();
  let mirror = mirRow as Course | null;
  if (mirror && !mirror.synced) return "unlocked";

  const segMap = await ensureSegmentMirrors();
  const mirrorSegmentId = src.segment_id ? segMap.get(src.segment_id) ?? null : null;

  const courseFields = {
    title: await toSimplified(src.title),
    segment_id: mirrorSegmentId,
    status: src.status,
    position: src.position,
    settings: await jsonToSimplified(src.settings ?? {}),
    updated_at: new Date().toISOString(),
  };

  if (!mirror) {
    const { data: made, error } = await supabase
      .from("courses")
      .insert({
        ...courseFields,
        script: "simp",
        source_course_id: src.id,
        synced: true,
        created_by: src.created_by,
      })
      .select("*")
      .single();
    if (error) throw error;
    mirror = made as Course;
  } else {
    const { error } = await supabase.from("courses").update(courseFields).eq("id", mirror.id);
    if (error) throw error;
  }

  await syncSectionsAndObjects(src.id, mirror.id);
  return "synced";
}

async function syncSectionsAndObjects(sourceCourseId: string, mirrorCourseId: string): Promise<void> {
  const [{ data: srcSecRaw }, { data: srcObjRaw }, { data: mirSecRaw }, { data: mirObjRaw }] = await Promise.all([
    supabase.from("course_sections").select("*").eq("course_id", sourceCourseId).order("position"),
    supabase.from("course_objects").select("*").eq("course_id", sourceCourseId).order("position"),
    supabase.from("course_sections").select("*").eq("course_id", mirrorCourseId),
    supabase.from("course_objects").select("*").eq("course_id", mirrorCourseId),
  ]);
  const srcSections = (srcSecRaw ?? []) as CourseSection[];
  const srcObjects = (srcObjRaw ?? []) as CourseObject[];
  const mirSections = (mirSecRaw ?? []) as CourseSection[];
  const mirObjects = (mirObjRaw ?? []) as CourseObject[];

  // Rows added by hand while the mirror was unlocked have no source. A resync
  // is defined as "become the source again", so they go.
  const strayObjectIds = mirObjects.filter((o) => !o.source_object_id).map((o) => o.id);
  const straySectionIds = mirSections.filter((s) => !s.source_section_id).map((s) => s.id);
  if (strayObjectIds.length) await supabase.from("course_objects").delete().in("id", strayObjectIds);
  if (straySectionIds.length) await supabase.from("course_sections").delete().in("id", straySectionIds);

  // ── Sections ──────────────────────────────────────────────────────────────
  const mirSecBySource = new Map(
    mirSections.filter((s) => s.source_section_id).map((s) => [s.source_section_id as string, s])
  );
  const sectionIdBySource = new Map<string, string>();

  for (const s of srcSections) {
    const title = await toSimplified(s.title);
    const existing = mirSecBySource.get(s.id);
    if (existing) {
      sectionIdBySource.set(s.id, existing.id);
      if (existing.title !== title || existing.position !== s.position) {
        await supabase.from("course_sections").update({ title, position: s.position }).eq("id", existing.id);
      }
    } else {
      const { data: made, error } = await supabase
        .from("course_sections")
        .insert({ course_id: mirrorCourseId, source_section_id: s.id, title, position: s.position })
        .select("id")
        .single();
      if (error) throw error;
      sectionIdBySource.set(s.id, made.id as string);
    }
  }

  // ── Objects ───────────────────────────────────────────────────────────────
  const mirObjBySource = new Map(
    mirObjects.filter((o) => o.source_object_id).map((o) => [o.source_object_id as string, o])
  );

  for (const o of srcObjects) {
    const sectionId = sectionIdBySource.get(o.section_id);
    if (!sectionId) continue; // source object in a section that vanished mid-sync
    const [title, content, settings] = await Promise.all([
      toSimplified(o.title),
      convertObjectContent(o),
      jsonToSimplified(o.settings ?? {}),
    ]);
    const existing = mirObjBySource.get(o.id);
    if (existing) {
      await supabase
        .from("course_objects")
        .update({ title, content, settings, position: o.position, section_id: sectionId })
        .eq("id", existing.id);
    } else {
      const { error } = await supabase.from("course_objects").insert({
        course_id: mirrorCourseId,
        section_id: sectionId,
        source_object_id: o.id,
        type: o.type,
        title,
        content,
        settings,
        position: o.position,
      });
      if (error) throw error;
    }
  }
}

/**
 * Media is referenced, never copied: the mirror points at the same R2 objects,
 * so a video uploaded once serves both courses. Only the readable strings are
 * converted — `jsonToSimplified` works from a key allow-list, so `url` and
 * generated ids pass through untouched.
 */
async function convertObjectContent(o: CourseObject): Promise<Record<string, unknown>> {
  const content = { ...(o.content ?? {}) };
  if (o.type === "text" && typeof content.html === "string") {
    content.html = await htmlToSimplified(content.html);
  }
  return jsonToSimplified(content);
}

/** Every Traditional course, rebuilt. Used for the first pass and "Resync all". */
export async function syncAllMirrors(): Promise<{ synced: number; unlocked: number }> {
  await ensureSegmentMirrors();
  const { data } = await supabase.from("courses").select("id").neq("script", "simp");
  let synced = 0;
  let unlocked = 0;
  for (const row of (data ?? []) as { id: string }[]) {
    const r = await syncCourseMirror(row.id);
    if (r === "synced") synced += 1;
    else if (r === "unlocked") unlocked += 1;
  }
  return { synced, unlocked };
}

/** Let an admin hand-edit this mirror; the sync will stop touching it. */
export async function unlockMirror(mirrorCourseId: string): Promise<void> {
  const { error } = await supabase.from("courses").update({ synced: false }).eq("id", mirrorCourseId);
  if (error) throw error;
}

/** Relock: throw away the hand edits and rebuild from the Traditional source. */
export async function relockMirror(mirrorCourseId: string): Promise<void> {
  const { data } = await supabase
    .from("courses").select("source_course_id").eq("id", mirrorCourseId).maybeSingle();
  const sourceId = (data?.source_course_id as string | null) ?? null;
  const { error } = await supabase.from("courses").update({ synced: true }).eq("id", mirrorCourseId);
  if (error) throw error;
  if (sourceId) await syncCourseMirror(sourceId);
}

/**
 * Fire-and-forget mirroring for the edit screens: a failed sync must never cost
 * someone the edit they just made, so it reports instead of throwing.
 */
export function mirrorInBackground(sourceCourseId: string, onError?: (msg: string) => void): void {
  syncCourseMirror(sourceCourseId).catch((e: unknown) => {
    onError?.("Simplified copy did not update: " + ((e as Error)?.message ?? "unknown"));
  });
}
