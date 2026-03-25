// Shared file-type detection, CSV parsing, and preview mode helpers.
// Used by FilePreviewModal and all pages that open file previews.

export type PreviewMode =
  | "pdf"
  | "image"
  | "text"
  | "csv"
  | "office"
  | "video"
  | "audio"
  | "link"
  | "unknown";

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

// Includes older Office formats (doc/ppt/xls) in addition to the modern x-variants.
export function isOfficeExt(ext: string): boolean {
  return (
    ext === "doc" ||
    ext === "docx" ||
    ext === "ppt" ||
    ext === "pptx" ||
    ext === "xls" ||
    ext === "xlsx"
  );
}

export function isPdfExt(ext: string): boolean {
  return ext === "pdf";
}

export function isImageExt(ext: string): boolean {
  return (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "gif" ||
    ext === "webp" ||
    ext === "svg"
  );
}

// Note: "csv" is intentionally excluded — it has special fetch+parse handling.
export function isTextExt(ext: string): boolean {
  return ext === "txt" || ext === "md" || ext === "json" || ext === "log";
}

export function isVideoExt(ext: string): boolean {
  return (
    ext === "mp4" ||
    ext === "mov" ||
    ext === "webm" ||
    ext === "m4v" ||
    ext === "avi" ||
    ext === "mkv" ||
    ext === "mpeg" ||
    ext === "mpg"
  );
}

export function isAudioExt(ext: string): boolean {
  return (
    ext === "mp3" ||
    ext === "wav" ||
    ext === "m4a" ||
    ext === "aac" ||
    ext === "ogg" ||
    ext === "flac"
  );
}

/**
 * Determines the preview mode for a file by its name.
 * CSV is handled separately (requires fetching) so callers should check for
 * "csv" mode and fetch/parse the content themselves before showing the modal.
 */
export function previewModeForFile(name: string): PreviewMode {
  const ext = extOf(name);
  if (isPdfExt(ext)) return "pdf";
  if (isOfficeExt(ext)) return "office";
  if (isImageExt(ext)) return "image";
  if (ext === "csv") return "csv";
  if (isTextExt(ext)) return "text";
  if (isVideoExt(ext)) return "video";
  if (isAudioExt(ext)) return "audio";
  return "unknown";
}

/** RFC 4180-compatible CSV parser that handles quoted fields and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }

    if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i += 1;
      continue;
    }

    if (c === "\r") {
      i += 1;
      if (text[i] === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        i += 1;
      }
      continue;
    }

    field += c;
    i += 1;
  }

  row.push(field);
  rows.push(row);

  // Trim trailing empty row left by a file ending in a newline.
  const last = rows[rows.length - 1];
  if (text.endsWith("\n") && last.length === 1 && last[0] === "") rows.pop();

  return rows;
}
