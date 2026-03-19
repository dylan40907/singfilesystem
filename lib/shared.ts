import { supabase } from "./supabaseClient";
import type { Folder } from "./folders";

export type SharedFolderGrant = Folder & {
  access: "view" | "download" | "manage";
};

export async function fetchSharedFoldersDirect(): Promise<SharedFolderGrant[]> {
  const { data, error } = await supabase.rpc("get_my_shared_folders");

  if (error) throw error;

  return (data ?? []) as SharedFolderGrant[];
}
