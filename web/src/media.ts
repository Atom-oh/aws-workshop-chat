// Media keys are `media/<participantId>/<uuid>__<filename>` (see app/src/routes/upload.ts) —
// the filename rides along in the key itself so rendering never needs a separate lookup.

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
