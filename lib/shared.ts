import { supabase } from "./supabaseClient";
import type { Folder } from "./folders";

export async function fetchSharedFoldersDirect(): Promise<Folder[]> {
  const { data, error } = await supabase.rpc("get_my_shared_folders");

  if (error) throw error;

  return (data ?? []) as Folder[];
}
