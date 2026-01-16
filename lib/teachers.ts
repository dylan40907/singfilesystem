import { supabase } from "./supabaseClient";

export type TeacherProfile = {
  id: string;
  email: string | null;
  username: string | null;
  full_name: string | null;
  role: "admin" | "supervisor" | "teacher" | "employee";
  is_active: boolean;
};

export async function fetchActiveTeachers(): Promise<TeacherProfile[]> {
  const { data, error } = await supabase.rpc("list_review_teachers");
  if (error) throw error;
  return (data ?? []) as TeacherProfile[];
}

export async function fetchMyProfile(): Promise<TeacherProfile | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData.session?.user?.id;
  if (!uid) return null;

  const { data, error } = await supabase
    .from("user_profiles")
    .select("id, email, username, full_name, role, is_active")
    .eq("id", uid)
    .single();

  if (error) return null;
  return data as TeacherProfile;
}
