import type { FastifyInstance } from "fastify";
import { requireOperator } from "../auth/session.js";
import { buildCurrentWorkbook } from "../export/xlsx.js";
import { writeSnapshotNow, getExportStatus } from "../export/snapshot.js";

export async function exportRoutes(app: FastifyInstance) {
  // "지금 내보내기" (§8.1): always available, always reflects current state.
  app.get("/api/export", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const wb = await buildCurrentWorkbook();
    const buffer = await wb.xlsx.writeBuffer();
    reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="workshop-export.xlsx"`)
      .send(Buffer.from(buffer));
  });

  app.post("/api/export/now", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    reply.send(await writeSnapshotNow());
  });

  app.get("/api/export/status", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    reply.send(await getExportStatus());
  });
}
