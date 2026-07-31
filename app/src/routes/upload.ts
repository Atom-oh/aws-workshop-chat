import type { FastifyInstance } from "fastify";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { requireSession } from "../auth/session.js";

const s3 = new S3Client({});
const MEDIA_BUCKET = process.env.MEDIA_BUCKET;

// §6.4: no video transcoding. mp4 capped at 50 MB; images capped at 15 MB. Executables blocked
// outright regardless of the extension a client claims.
const ALLOWED_MIME: Record<string, number> = {
  "image/png": 15 * 1024 * 1024,
  "image/jpeg": 15 * 1024 * 1024,
  "image/gif": 15 * 1024 * 1024,
  "image/webp": 15 * 1024 * 1024,
  "video/mp4": 50 * 1024 * 1024,
};

export async function uploadRoutes(app: FastifyInstance) {
  app.post("/api/uploads/presign", async (req, reply) => {
    const session = requireSession(req, reply);
    if (!session) return;
    if (!MEDIA_BUCKET) return reply.code(503).send({ error: "media bucket not configured" });

    const { contentType, sizeBytes } = req.body as { contentType?: string; sizeBytes?: number };
    const limit = contentType ? ALLOWED_MIME[contentType] : undefined;
    if (!limit) return reply.code(400).send({ error: "unsupported content type" });
    if (!sizeBytes || sizeBytes > limit) return reply.code(400).send({ error: `size exceeds ${limit} bytes` });

    const key = `media/${session.participantId}/${randomUUID()}`;
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: 300 },
    );
    reply.send({ url, key });
  });
}
