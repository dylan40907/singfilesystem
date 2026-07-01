import { supabase } from "./supabaseClient";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CourseStatus = "draft" | "published" | "archived";
export type AssignmentStatus = "not_started" | "in_progress" | "completed";
export type ObjectType =
  | "text" | "image" | "video" | "pdf" | "youtube" | "file" | "link" | "audio" | "quiz";

export type CourseSegment = {
  id: string;
  name: string;
  color: string;
  position: number;
  created_at: string;
};

export type Course = {
  id: string;
  title: string;
  segment_id: string | null;
  status: CourseStatus;
  settings: Record<string, any>;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CourseSection = {
  id: string;
  course_id: string;
  title: string;
  position: number;
  created_at: string;
};

export type CourseObject = {
  id: string;
  course_id: string;
  section_id: string;
  type: ObjectType;
  title: string;
  content: Record<string, any>;
  settings: Record<string, any>;
  position: number;
  created_at: string;
};

export type CourseAssignment = {
  id: string;
  course_id: string;
  user_id: string;
  status: AssignmentStatus;
  progress: CourseProgress;
  assigned_by: string | null;
  assigned_at: string;
  last_viewed_at: string | null;
  completed_at: string | null;
};

export type CourseProgress = {
  completedObjectIds?: string[];
  quizResults?: Record<string, { score: number; passed: boolean; answers?: Record<string, string[]> }>;
  lastObjectId?: string | null;
  /** Section the learner was last on, so we can resume there on reopen. */
  lastSectionId?: string | null;
};

// Quiz payload shapes (stored in course_objects.content / .settings for type 'quiz')
export type QuizAnswer = { id: string; text: string; correct: boolean };
export type QuizQuestion = { id: string; prompt: string; attachmentUrl?: string | null; answers: QuizAnswer[] };
export type QuizSettings = {
  passScore?: number;        // 0–100
  showScore?: boolean;       // show final score to user
  feedbackPerQuestion?: boolean; // tell right/wrong after each
  showCorrect?: boolean;     // reveal correct answer when wrong
  randomize?: boolean;       // randomize question order
};

// Text object settings
export type TextSettings = {
  requireScroll?: boolean;   // must scroll to bottom to complete
  confirmLabel?: string | null; // confirmation button label (e.g. "I understand"); null = none
  allowCopy?: boolean;
};

export type CourseWithMeta = Course & {
  segment: CourseSegment | null;
  assignedCount: number;
};

// ─── Segments ────────────────────────────────────────────────────────────────

export async function fetchSegments(): Promise<CourseSegment[]> {
  const { data } = await supabase
    .from("course_segments")
    .select("*")
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  return (data ?? []) as CourseSegment[];
}

export async function createSegment(name: string, color: string): Promise<CourseSegment> {
  const { data: last } = await supabase
    .from("course_segments").select("position").order("position", { ascending: false }).limit(1);
  const position = ((last?.[0]?.position as number | undefined) ?? 0) + 1;
  const { data, error } = await supabase
    .from("course_segments")
    .insert({ name: name.trim(), color, position })
    .select("*")
    .single();
  if (error) throw error;
  return data as CourseSegment;
}

export async function renameSegment(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("course_segments").update({ name: name.trim() }).eq("id", id);
  if (error) throw error;
}

export async function updateSegment(
  id: string,
  patch: { name?: string; color?: string; position?: number }
): Promise<void> {
  const clean: Record<string, any> = { ...patch };
  if (typeof clean.name === "string") clean.name = clean.name.trim();
  const { error } = await supabase.from("course_segments").update(clean).eq("id", id);
  if (error) throw error;
}

export async function deleteSegment(id: string): Promise<void> {
  const { error } = await supabase.from("course_segments").delete().eq("id", id);
  if (error) throw error;
}

// ─── Courses ─────────────────────────────────────────────────────────────────

/** Next position (bottom) for a new course within a segment. */
async function nextCoursePosition(segmentId: string | null): Promise<number> {
  let q = supabase.from("courses").select("position").order("position", { ascending: false }).limit(1);
  q = segmentId ? q.eq("segment_id", segmentId) : q.is("segment_id", null);
  const { data } = await q;
  return ((data?.[0]?.position as number | undefined) ?? 0) + 1;
}

/** Courses (optionally filtered by status) with segment + assignment counts.
 *  Ordered by manual position (then created_at), so within a segment they follow
 *  the admin's chosen order and new courses land at the bottom. */
export async function fetchCourses(status?: CourseStatus): Promise<CourseWithMeta[]> {
  let q = supabase
    .from("courses")
    .select("*")
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (status) q = q.eq("status", status);
  const { data: courses } = await q;
  const list = (courses ?? []) as Course[];
  if (list.length === 0) return [];

  const segments = await fetchSegments();
  const segById = new Map(segments.map((s) => [s.id, s]));

  const { data: assigns } = await supabase
    .from("course_assignments")
    .select("course_id")
    .in("course_id", list.map((c) => c.id));
  const countByCourse = new Map<string, number>();
  (assigns ?? []).forEach((a: any) => {
    countByCourse.set(a.course_id, (countByCourse.get(a.course_id) ?? 0) + 1);
  });

  return list.map((c) => ({
    ...c,
    segment: c.segment_id ? segById.get(c.segment_id) ?? null : null,
    assignedCount: countByCourse.get(c.id) ?? 0,
  }));
}

export async function createCourse(title: string, segmentId: string | null): Promise<Course> {
  const { data: auth } = await supabase.auth.getUser();
  const position = await nextCoursePosition(segmentId);
  const { data, error } = await supabase
    .from("courses")
    .insert({ title: title.trim(), segment_id: segmentId, position, created_by: auth.user?.id ?? null })
    .select("*")
    .single();
  if (error) throw error;
  return data as Course;
}

export async function updateCourse(
  id: string,
  patch: Partial<Pick<Course, "title" | "segment_id" | "settings" | "position">>
): Promise<void> {
  const { error } = await supabase
    .from("courses")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** Move a course into a segment, placing it at the bottom of that segment. */
export async function moveCourseToSegment(id: string, segmentId: string | null): Promise<void> {
  const position = await nextCoursePosition(segmentId);
  await updateCourse(id, { segment_id: segmentId, position });
}

export async function setCourseStatus(id: string, status: CourseStatus): Promise<void> {
  const { error } = await supabase
    .from("courses")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteCourse(id: string): Promise<void> {
  const { error } = await supabase.from("courses").delete().eq("id", id);
  if (error) throw error;
}

// ─── Full course (sections + objects), for the builder + taker ───────────────

export type FullCourse = {
  course: Course;
  sections: CourseSection[];
  objects: CourseObject[];
};

export async function fetchCourseFull(courseId: string): Promise<FullCourse | null> {
  const { data: course } = await supabase.from("courses").select("*").eq("id", courseId).maybeSingle();
  if (!course) return null;
  const [{ data: sections }, { data: objects }] = await Promise.all([
    supabase.from("course_sections").select("*").eq("course_id", courseId).order("position", { ascending: true }),
    supabase.from("course_objects").select("*").eq("course_id", courseId).order("position", { ascending: true }),
  ]);
  return {
    course: course as Course,
    sections: (sections ?? []) as CourseSection[],
    objects: (objects ?? []) as CourseObject[],
  };
}

// ─── Sections ────────────────────────────────────────────────────────────────

export async function createSection(courseId: string, title: string, position: number): Promise<CourseSection> {
  const { data, error } = await supabase
    .from("course_sections")
    .insert({ course_id: courseId, title, position })
    .select("*")
    .single();
  if (error) throw error;
  return data as CourseSection;
}

export async function updateSection(id: string, patch: Partial<Pick<CourseSection, "title" | "position">>): Promise<void> {
  const { error } = await supabase.from("course_sections").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteSection(id: string): Promise<void> {
  const { error } = await supabase.from("course_sections").delete().eq("id", id);
  if (error) throw error;
}

// ─── Objects ─────────────────────────────────────────────────────────────────

export async function createObject(o: {
  courseId: string;
  sectionId: string;
  type: ObjectType;
  title: string;
  content?: Record<string, any>;
  settings?: Record<string, any>;
  position: number;
}): Promise<CourseObject> {
  const { data, error } = await supabase
    .from("course_objects")
    .insert({
      course_id: o.courseId,
      section_id: o.sectionId,
      type: o.type,
      title: o.title,
      content: o.content ?? {},
      settings: o.settings ?? {},
      position: o.position,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as CourseObject;
}

export async function updateObject(
  id: string,
  patch: Partial<Pick<CourseObject, "title" | "content" | "settings" | "position" | "section_id">>
): Promise<void> {
  const { error } = await supabase.from("course_objects").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteObject(id: string): Promise<void> {
  const { error } = await supabase.from("course_objects").delete().eq("id", id);
  if (error) throw error;
}

// ─── Assignments (admin) ─────────────────────────────────────────────────────

export type AssignmentWithUser = CourseAssignment & {
  full_name: string | null;
  username: string | null;
  email: string | null;
};

export async function fetchAssignments(courseId: string): Promise<AssignmentWithUser[]> {
  const { data: rows } = await supabase
    .from("course_assignments")
    .select("*")
    .eq("course_id", courseId);
  const list = (rows ?? []) as CourseAssignment[];
  if (list.length === 0) return [];
  const { data: profs } = await supabase
    .from("user_profiles")
    .select("id, full_name, username, email")
    .in("id", list.map((a) => a.user_id));
  const byId = new Map((profs ?? []).map((p: any) => [p.id, p]));
  return list.map((a) => {
    const p = byId.get(a.user_id);
    return { ...a, full_name: p?.full_name ?? null, username: p?.username ?? null, email: p?.email ?? null };
  });
}

/** Assign a course to a set of users (idempotent — skips existing). */
export async function assignUsers(courseId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const { data: auth } = await supabase.auth.getUser();
  const { data: existing } = await supabase
    .from("course_assignments")
    .select("user_id")
    .eq("course_id", courseId)
    .in("user_id", userIds);
  const have = new Set((existing ?? []).map((r: any) => r.user_id));
  const toAdd = userIds.filter((id) => !have.has(id));
  if (toAdd.length === 0) return;
  const { error } = await supabase.from("course_assignments").insert(
    toAdd.map((uid) => ({ course_id: courseId, user_id: uid, assigned_by: auth.user?.id ?? null }))
  );
  if (error) throw error;
}

export async function unassignUser(courseId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from("course_assignments")
    .delete()
    .eq("course_id", courseId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function sendReminder(courseId: string, userIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc("course_send_reminder", { p_course: courseId, p_user_ids: userIds });
  if (error) throw error;
  return (data as number) ?? 0;
}

// ─── People groups (admin-only, for bulk assignment) ─────────────────────────

export type CourseGroup = { id: string; name: string; created_at: string; memberCount: number };

export async function fetchGroups(): Promise<CourseGroup[]> {
  const { data: groups } = await supabase
    .from("course_groups")
    .select("id, name, created_at")
    .order("name", { ascending: true });
  const list = (groups ?? []) as Omit<CourseGroup, "memberCount">[];
  if (list.length === 0) return [];
  const { data: members } = await supabase
    .from("course_group_members")
    .select("group_id")
    .in("group_id", list.map((g) => g.id));
  const counts = new Map<string, number>();
  (members ?? []).forEach((m: any) => counts.set(m.group_id, (counts.get(m.group_id) ?? 0) + 1));
  return list.map((g) => ({ ...g, memberCount: counts.get(g.id) ?? 0 }));
}

export async function createGroup(name: string): Promise<CourseGroup> {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("course_groups")
    .insert({ name: name.trim(), created_by: auth.user?.id ?? null })
    .select("id, name, created_at")
    .single();
  if (error) throw error;
  return { ...(data as any), memberCount: 0 };
}

export async function renameGroup(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("course_groups").update({ name: name.trim() }).eq("id", id);
  if (error) throw error;
}

export async function deleteGroup(id: string): Promise<void> {
  const { error } = await supabase.from("course_groups").delete().eq("id", id);
  if (error) throw error;
}

export async function fetchGroupMembers(groupId: string): Promise<string[]> {
  const { data } = await supabase.from("course_group_members").select("user_id").eq("group_id", groupId);
  return (data ?? []).map((r: any) => r.user_id);
}

/** Map of groupId → member user ids (one round-trip for several groups). */
export async function fetchGroupMembersMap(groupIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (groupIds.length === 0) return map;
  const { data } = await supabase.from("course_group_members").select("group_id, user_id").in("group_id", groupIds);
  (data ?? []).forEach((r: any) => {
    const arr = map.get(r.group_id) ?? [];
    arr.push(r.user_id);
    map.set(r.group_id, arr);
  });
  return map;
}

/** Replace a group's membership with exactly `userIds`. */
export async function setGroupMembers(groupId: string, userIds: string[]): Promise<void> {
  await supabase.from("course_group_members").delete().eq("group_id", groupId);
  if (userIds.length > 0) {
    const { error } = await supabase.from("course_group_members").insert(userIds.map((uid) => ({ group_id: groupId, user_id: uid })));
    if (error) throw error;
  }
}

// ─── Bulk course actions ─────────────────────────────────────────────────────

export async function archiveCourses(courseIds: string[]): Promise<void> {
  if (courseIds.length === 0) return;
  const { error } = await supabase
    .from("courses")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .in("id", courseIds);
  if (error) throw error;
}

/** Assign every course in `courseIds` to every user in `userIds`. */
export async function assignToCourses(courseIds: string[], userIds: string[]): Promise<void> {
  for (const cid of courseIds) await assignUsers(cid, userIds);
}

/** Remind everyone who hasn't completed the given course. Returns count reminded. */
export async function remindIncomplete(courseId: string): Promise<number> {
  const { data } = await supabase
    .from("course_assignments")
    .select("user_id, status")
    .eq("course_id", courseId)
    .neq("status", "completed");
  const ids = (data ?? []).map((r: any) => r.user_id);
  if (ids.length === 0) return 0;
  return sendReminder(courseId, ids);
}

// ─── Employee side (take a course) ───────────────────────────────────────────

export type MyCourse = {
  assignment: CourseAssignment;
  course: Course;
  segment: CourseSegment | null;
};

export async function fetchMyCourses(myId: string): Promise<MyCourse[]> {
  const { data: assigns } = await supabase
    .from("course_assignments")
    .select("*")
    .eq("user_id", myId)
    .order("assigned_at", { ascending: false });
  const list = (assigns ?? []) as CourseAssignment[];
  if (list.length === 0) return [];
  const { data: courses } = await supabase
    .from("courses")
    .select("*")
    .in("id", list.map((a) => a.course_id))
    .eq("status", "published");
  const courseById = new Map((courses ?? []).map((c: any) => [c.id, c as Course]));
  const segments = await fetchSegments();
  const segById = new Map(segments.map((s) => [s.id, s]));
  return list
    .filter((a) => courseById.has(a.course_id)) // only published courses
    .map((a) => {
      const course = courseById.get(a.course_id)!;
      return { assignment: a, course, segment: course.segment_id ? segById.get(course.segment_id) ?? null : null };
    });
}

/** Persist progress for my assignment; flips status to in_progress/completed. */
export async function saveProgress(
  assignmentId: string,
  progress: CourseProgress,
  status: AssignmentStatus
): Promise<void> {
  const patch: any = { progress, status, last_viewed_at: new Date().toISOString() };
  if (status === "completed") patch.completed_at = new Date().toISOString();
  const { error } = await supabase.from("course_assignments").update(patch).eq("id", assignmentId);
  if (error) throw error;
}

// ─── Media upload (images / files used inside courses) ───────────────────────

export async function uploadCourseMedia(file: File): Promise<{ url: string; name: string }> {
  const safe = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}-${safe}`;
  const { error } = await supabase.storage.from("course-media").upload(path, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from("course-media").getPublicUrl(path);
  return { url: data.publicUrl, name: file.name };
}
