import { supabase } from "./supabaseClient";

export type Folder = {
  id: string;
  name: string;
  parent_id: string | null;
};

export async function fetchFolders(): Promise<Folder[]> {
  const { data, error } = await supabase
    .from("folders")
    .select("id, name, parent_id")
    .order("name");

  if (error) throw error;
  return data ?? [];
}

export async function fetchRootFolder(): Promise<Folder | null> {
  const { data, error } = await supabase
    .from("folders")
    .select("id, name, parent_id")
    .is("parent_id", null)
    .limit(1)
    .single();

  if (error) return null;
  return data;
}

export async function createFolder(name: string, parentId: string | null) {
  const { error } = await supabase.from("folders").insert({
    name,
    parent_id: parentId,
  });

  if (error) throw error;
}
