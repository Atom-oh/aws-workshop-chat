import { useEffect, useState } from "react";
import { upload } from "./api";
import { filenameFromKey, isImageKey } from "./media";
import { COLORS } from "./theme";

// Presigned GET URLs are short-lived (300s) and the media bucket has no public read, so every
// render fetches (and caches, module-lifetime) a fresh one rather than storing a URL anywhere.
const urlCache = new Map<string, Promise<string>>();

function resolveUrl(key: string): Promise<string> {
  let p = urlCache.get(key);
  if (!p) {
    p = upload.downloadUrl(key).then((r) => r.url);
    urlCache.set(key, p);
  }
  return p;
}

export default function Attachment({ mediaKey }: { mediaKey: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const name = filenameFromKey(mediaKey);
  const image = isImageKey(mediaKey);

  useEffect(() => {
    resolveUrl(mediaKey).then(setUrl).catch(() => setUrl(null));
  }, [mediaKey]);

  async function download() {
    urlCache.delete(mediaKey); // presign may have expired since mount — refetch on click
    const fresh = await resolveUrl(mediaKey);
    window.open(fresh, "_blank");
  }

  if (image) {
    return (
      <div style={{ marginTop: 8, maxWidth: 320 }}>
        {url ? (
          <img src={url} alt={name} onClick={download} style={{ maxWidth: "100%", borderRadius: 8, cursor: "pointer", display: "block" }} />
        ) : (
          <div style={{ height: 120, borderRadius: 8, background: "rgba(255,255,255,.06)" }} />
        )}
      </div>
    );
  }

  return (
    <div
      onClick={download}
      style={{
        marginTop: 8, display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 12px",
        borderRadius: 8, background: "rgba(255,255,255,.05)", border: `1px solid ${COLORS.border}`,
        cursor: "pointer", fontSize: 13, maxWidth: 280,
      }}
    >
      <span>📎</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
    </div>
  );
}
