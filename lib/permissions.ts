import { supabase } from "./supabaseClient";

export async function shareFolderWithTeacher(params: {
  teacherId: string;
  folderId: string;
  access: "view" | "download" | "manage";
  inherit: boolean;
}) {
  const { teacherId, folderId, access, inherit } = params;

  const { error } = await supabase.from("permissions").insert({
    principal_user_id: teacherId,
    resource_type: "folder",
    resource_id: folderId,
    access,
    inherit,
  });

  if (error) throw error;
}
