import { supabase } from "@/lib/supabaseClient";

export type LessonPlanRow = {
  id: string;
  created_at: string;
  updated_at: string;
  title: string;
  status: "draft" | "submitted" | "changes_requested" | "approved";
  folder_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  last_reviewed_at: string | null;
  // NEW (useful for UI even if ignored elsewhere)
  owner_user_id?: string;
  owner_email?: string | null;
};

export type LessonPlanDetail = {
  id: string;
  created_at: string;
  updated_at: string;
  title: string;
  status: "draft" | "submitted" | "changes_requested" | "approved";
  folder_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  last_reviewed_at: string | null;
  content: string;
  owner_user_id: string;
  // NEW
  owner_email?: string | null;
};

async function fetchEmailsByUserIds(userIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const unique = Array.from(new Set(userIds.filter(Boolean)));

  if (unique.length === 0) return map;

  const { data, error } = await supabase
    .from("teacher_profiles")
    .select("user_id, email")
    .in("user_id", unique);

  if (error) throw error;

  for (const row of data ?? []) {
    map.set((row as any).user_id as string, ((row as any).email as string | null) ?? null);
  }

  return map;
}

export async function listLessonPlansForTeacher(targetUserId: string): Promise<LessonPlanRow[]> {
  // RPC should already filter access via RLS/SECURITY DEFINER as you configured
  const { data, error } = await supabase.rpc("list_user_lesson_plans", {
    target_user: targetUserId,
  });
  if (error) throw error;

  const rows = (data ?? []) as LessonPlanRow[];

  // Best-effort attach email if RPC includes owner_user_id; if not, caller can still display using other info
  const ownerIds = rows.map((r: any) => r.owner_user_id).filter(Boolean);
  if (ownerIds.length === 0) return rows;

  const emailMap = await fetchEmailsByUserIds(ownerIds);
  return rows.map((r: any) => ({
    ...r,
    owner_email: r.owner_user_id ? emailMap.get(r.owner_user_id) ?? null : null,
  }));
}

export async function getLessonPlan(planId: string): Promise<LessonPlanDetail> {
  // RLS allows: owner OR admin/supervisor
  const { data, error } = await supabase
    .from("lesson_plans")
    .select(
      "id, created_at, updated_at, title, status, folder_id, approved_by, approved_at, last_reviewed_at, content, owner_user_id"
    )
    .eq("id", planId)
    .single();

  if (error) throw error;

  const plan = data as LessonPlanDetail;

  // Best-effort attach creator email (doesn't require FK join)
  try {
    const emailMap = await fetchEmailsByUserIds([plan.owner_user_id]);
    plan.owner_email = emailMap.get(plan.owner_user_id) ?? null;
  } catch {
    // If RLS prevents reading teacher_profiles for this user, we still return the plan.
    plan.owner_email = null;
  }

  return plan;
}

export async function reviewLessonPlan(planId: string, newStatus: "approved" | "changes_requested") {
  const { error } = await supabase.rpc("review_lesson_plan", {
    plan_uuid: planId,
    new_status: newStatus,
  });
  if (error) throw error;
}

export async function submitLessonPlan(planId: string) {
  const { error } = await supabase.rpc("submit_lesson_plan", { plan_uuid: planId });
  if (error) throw error;
}
