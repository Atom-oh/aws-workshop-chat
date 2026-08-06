// Media keys are `media/<participantId>/<uuid>__<filename>` (see app/src/routes/upload.ts) —
// the filename rides along in the key itself so rendering never needs a separate lookup.
import { upload } from "./api";
import { COLORS } from "./theme";

export function filenameFromKey(key: string): string {
  const base = key.split("/").pop() ?? key;
  const i = base.indexOf("__");
  return i === -1 ? base : decodeURIComponent(base.slice(i + 2));
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function isImageKey(key: string): boolean {
  const name = filenameFromKey(key).toLowerCase();
  const ext = name.slice(name.lastIndexOf("."));
  return IMAGE_EXT.has(ext);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Shared by Chat.tsx (participant composer) and Operator.tsx (operator's own composers) — one
// upload pipeline (presign, then PUT straight to S3) and one "pending attachment" chip UI,
// so the two don't drift into two different upload implementations.
export interface PendingAttachment {
  key: string;
  name: string;
  sizeBytes: number;
}

export async function uploadFile(file: File): Promise<PendingAttachment> {
  const { url, key } = await upload.presign(file.name, file.type || "application/octet-stream", file.size);
  const res = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
  if (!res.ok) throw new Error(`upload failed for ${file.name}: ${res.status} ${res.statusText}`);
  return { key, name: file.name, sizeBytes: file.size };
}

export function AttachmentChips({ attachments, onRemove }: { attachments: PendingAttachment[]; onRemove: (key: string) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
      {attachments.map((a) => (
        <div key={a.key} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 999, background: "rgba(var(--c-w),.08)", fontSize: 12 }}>
          <span>📎 {a.name}</span>
          <span style={{ color: COLORS.dim }}>{formatBytes(a.sizeBytes)}</span>
          <button onClick={() => onRemove(a.key)} style={{ border: "none", background: "transparent", color: "rgba(var(--c-w),.5)", cursor: "pointer", padding: 0, fontSize: 13 }}>×</button>
        </div>
      ))}
    </div>
  );
}
