// lib/files.ts
import { supabase } from "@/lib/supabaseClient";

export type FileRow = {
  id: string;
  folder_id: string;
  name: string; // display name
  storage_key: string; // canonical storage key
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
};

export async function fetchFilesInFolder(folderId: string): Promise<FileRow[]> {
  const { data, error } = await supabase
    .from("files")
    .select(
      "id, folder_id, name, original_name, storage_key, object_key, mime_type, size_bytes, created_at"
    )
    .eq("folder_id", folderId)
    .order("created_at", { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row: any) => ({
    id: row.id,
    folder_id: row.folder_id,
    name: row.original_name ?? row.name ?? "(unnamed)",
    storage_key: row.storage_key ?? row.object_key,
    mime_type: row.mime_type ?? null,
    size_bytes: row.size_bytes ?? null,
    created_at: row.created_at,
  }));
}

export async function createFileRow(params: {
  folderId: string;
  name: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
}) {
  const insertPayload: any = {
    folder_id: params.folderId,

    // satisfy required columns
    original_name: params.name,
    storage_key: params.objectKey,

    // keep compat columns if they exist in schema
    name: params.name,
    object_key: params.objectKey,

    mime_type: params.mimeType ?? "application/octet-stream",
    size_bytes: params.sizeBytes ?? null,
  };

  const { error } = await supabase.from("files").insert(insertPayload);
  if (error) throw error;
}
