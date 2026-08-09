// Shared between routes/operator.ts (new uploads) and ai/reindex-retry.ts (re-touching existing
// S3 objects) — both need to set the *correct* Content-Type by filename extension rather than
// trust an unreliable source (a browser's File.type sniff, or S3's own no-Content-Type-given
// default of "binary/octet-stream"). Bedrock's Knowledge Base ingestion can parse a PDF
// regardless of its declared Content-Type (it sniffs the format directly), but for text-based
// formats like .html/.md it trusts the declared type — get it wrong and ingestion silently
// fails the document with no error message, forever, on every retry.
export const GUIDE_EXTENSIONS = new Set([".txt", ".md", ".html", ".doc", ".docx", ".csv", ".xls", ".xlsx", ".pdf"]);
export const IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png"]);

export const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".csv": "text/csv",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

export function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
}
