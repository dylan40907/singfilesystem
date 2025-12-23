import { supabase } from "@/lib/supabaseClient";

export type LessonPlanComment = {
  id: string;
  created_at: string;
  author_user_id: string;
  body: string;
};

export async function fetchLessonPlanComments(planId: string): Promise<LessonPlanComment[]> {
  const { data, error } = await supabase
    .from("lesson_plan_comments")
    .select("id, created_at, author_user_id, body")
    .eq("plan_id", planId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as LessonPlanComment[];
}

export async function addLessonPlanComment(planId: string, body: string) {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Comment cannot be empty.");

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) throw new Error("Not signed in.");

  const { error } = await supabase.from("lesson_plan_comments").insert({
    plan_id: planId,
    author_user_id: userData.user.id,
    body: trimmed,
  });

  if (error) throw error;
}
