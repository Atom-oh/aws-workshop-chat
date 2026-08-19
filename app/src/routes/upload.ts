import type { FastifyInstance } from "fastify";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { requireSession } from "../auth/session.js";

const s3 = new S3Client({});
const MEDIA_BUCKET = process.env.MEDIA_BUCKET;

// §6.4: no video transcoding. Images capped at 15 MB, documents at 25 MB, mp4 at 50 MB.
// Executables are blocked outright regardless of the extension a client claims — only
// content types explicitly listed here can ever get a presigned PUT.
const ALLOWED_MIME: Record<string, number> = {
  "image/png": 15 * 1024 * 1024,
  "image/jpeg": 15 * 1024 * 1024,
  "image/gif": 15 * 1024 * 1024,
  "image/webp": 15 * 1024 * 1024,
  "video/mp4": 50 * 1024 * 1024,
  "application/pdf": 25 * 1024 * 1024,
  "text/plain": 5 * 1024 * 1024,
  "text/csv": 5 * 1024 * 1024,
  "text/html": 5 * 1024 * 1024,
  "application/zip": 25 * 1024 * 1024,
  "application/msword": 25 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 25 * 1024 * 1024,
  "application/vnd.ms-excel": 25 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 25 * 1024 * 1024,
  "application/vnd.ms-powerpoint": 25 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": 25 * 1024 * 1024,
};

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\-가-힣 ]/g, "_").slice(0, 120) || "file";
}

export async function uploadRoutes(app: FastifyInstance) {
  app.post("/api/uploads/presign", async (req, reply) => {
    const session = requireSession(req, reply);
    if (!session) return;
    if (!MEDIA_BUCKET) return reply.code(503).send({ error: "media bucket not configured" });

    const { contentType, sizeBytes, filename } = req.body as { contentType?: string; sizeBytes?: number; filename?: string };
    const limit = contentType ? ALLOWED_MIME[contentType] : undefined;
    if (!limit) return reply.code(400).send({ error: "unsupported content type" });
    if (!sizeBytes || sizeBytes > limit) return reply.code(400).send({ error: `size exceeds ${limit} bytes` });

    // Filename travels inside the key itself (after the uuid) so rendering/download can recover
    // it later without a separate metadata store — messages only carry a `media: string[]` of keys.
    const safeName = sanitizeFilename(filename ?? "file");
    const key = `media/${session.participantId}/${randomUUID()}__${safeName}`;
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: 300 },
    );
    reply.send({ url, key });
  });

  // The media bucket is private (no public read) — any render/download of an uploaded
  // attachment goes through a fresh short-lived presigned GET rather than a bucket URL.
  app.get("/api/media/url", async (req, reply) => {
    const session = requireSession(req, reply);
    if (!session) return;
    if (!MEDIA_BUCKET) return reply.code(503).send({ error: "media bucket not configured" });
    const key = (req.query as any)?.key as string | undefined;
    if (!key || !key.startsWith("media/")) return reply.code(400).send({ error: "invalid key" });
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }), { expiresIn: 300 });
    reply.send({ url });
  });

  // HTML attachments are previewed inline (Attachment.tsx) via a sandboxed <iframe>, not the
  // presigned S3 URL above — two reasons:
  //  1. The media bucket's CORS policy only allows PUT (for uploads), not GET, so a client-side
  //     fetch() of the S3 URL is blocked by CORS; streaming it through this same-origin route
  //     sidesteps that entirely.
  //  2. Uploaded HTML rarely declares its own charset, and S3 stores whatever Content-Type the
  //     uploader's browser guessed (bare "text/html", no charset param) — left alone, the
  //     browser's encoding-sniffing mangles non-ASCII text in a Korean-first app. Proxying lets
  //     us force `charset=utf-8` ourselves.
  // The Content-Security-Policy header is defense-in-depth: this route must NEVER be linked to
  // directly (only ever set as the sandboxed iframe's src) — unlike the cross-origin S3 URL,
  // a direct top-level navigation here would run in the app's own origin with the viewer's
  // session cookie, so an uploaded HTML file could otherwise steal it. `sandbox` on the response
  // blocks scripts/forms/navigation the same way the iframe's own `sandbox=""` attribute does,
  // even if something ever did link to this URL directly.
  app.get("/api/media/html", async (req, reply) => {
    const session = requireSession(req, reply);
    if (!session) return;
    if (!MEDIA_BUCKET) return reply.code(503).send({ error: "media bucket not configured" });
    const key = (req.query as any)?.key as string | undefined;
    if (!key || !key.startsWith("media/") || !/\.html?$/i.test(key)) return reply.code(400).send({ error: "invalid key" });
    const obj = await s3.send(new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }));
    // transformToString(), not reply.send(obj.Body) — piping the SDK's raw Readable through
    // Fastify silently produced an empty (Content-Length: 0) response; decoding to a string
    // ourselves sidesteps that AND guarantees the utf-8 read this route exists for.
    const text = await obj.Body?.transformToString("utf-8");
    reply.header("Content-Security-Policy", "sandbox");
    reply.type("text/html; charset=utf-8");
    reply.send(text ?? "");
  });
}
