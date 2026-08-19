import { useEffect, useState } from "react";
import { upload } from "./api";
import { filenameFromKey, isImageKey, isPdfKey, isHtmlKey } from "./media";
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
  const pdf = isPdfKey(mediaKey);
  const html = isHtmlKey(mediaKey);
  // Same-origin proxy (app/src/routes/upload.ts) rather than the presigned S3 URL used for
  // everything else — the media bucket's CORS policy only allows PUT, and S3 stores whatever
  // charset-less Content-Type the uploader's browser guessed, which mangles non-ASCII text in
  // this Korean-first app if the iframe navigates straight to it. Only ever used as the
  // sandboxed iframe's src below, never for the plain download link.
  const htmlPreviewSrc = html ? `/api/media/html?key=${encodeURIComponent(mediaKey)}` : undefined;

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

  if (pdf || html) {
    const ready = pdf ? !!url : true;
    return (
      <div style={{ marginTop: 8, maxWidth: 480 }}>
        {ready ? (
          <iframe
            src={html ? htmlPreviewSrc : url!}
            title={name}
            // HTML attachments are participant-uploaded and untrusted — an empty sandbox blocks
            // script execution, form submission, and top-level navigation so a malicious upload
            // can't act with this page's origin. PDFs have no scripting surface, so this is a
            // no-op restriction for them.
            sandbox={html ? "" : undefined}
            style={{ width: "100%", height: 360, border: `1px solid ${COLORS.border}`, borderRadius: 8, background: "#fff" }}
          />
        ) : (
          <div style={{ height: 360, borderRadius: 8, background: "rgba(255,255,255,.06)" }} />
        )}
        <div
          onClick={download}
          style={{ marginTop: 4, display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: COLORS.dim }}
        >
          📎 {name}
        </div>
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
