// True per-document indexing status for the lab-guide Knowledge Base.
//
// Bedrock's own document-tracking API (ListKnowledgeBaseDocuments) marks a document "INDEXED"
// as soon as chunking/embedding succeeds — even when the subsequent write to the S3 Vectors
// backend fails (e.g. "Filterable metadata must have at most 2048 bytes"). That failure DOES
// show up in the ingestion job's own statistics/failureReasons, but never gets reconciled back
// onto the per-document record, so trusting that API here would report chapters as indexed when
// they're actually missing from the vector store. The only reliable signal is to count, per
// source document, how many chunks actually exist in the vector index — which is what this
// module does by paginating the whole index. Cheap at a lab guide's scale (a few hundred chunks).
import { BedrockAgentClient, GetKnowledgeBaseCommand } from "@aws-sdk/client-bedrock-agent";
import { S3VectorsClient, ListVectorsCommand } from "@aws-sdk/client-s3vectors";

const KB_ID = process.env.BEDROCK_KB_ID;

const bedrockAgent = new BedrockAgentClient({ region: process.env.BEDROCK_REGION });
// The vector bucket lives in the same region as the KB itself, so this follows BEDROCK_REGION
// too rather than falling back to the task's own default region.
const s3vectors = new S3VectorsClient({ region: process.env.BEDROCK_REGION });

interface VectorStore {
  vectorBucketName: string;
  indexName: string;
}

let cachedStore: VectorStore | null = null;

async function resolveVectorStore(): Promise<VectorStore | null> {
  if (cachedStore) return cachedStore;
  if (!KB_ID) return null;
  const res = await bedrockAgent.send(new GetKnowledgeBaseCommand({ knowledgeBaseId: KB_ID }));
  const cfg = res.knowledgeBase?.storageConfiguration?.s3VectorsConfiguration;
  if (!cfg?.vectorBucketArn || !cfg?.indexArn) return null;
  // Resource name is the ARN's last path segment for both — vector bucket and index ARNs share
  // that shape (…:bucket/<name> and …:bucket/<bucket-name>/index/<index-name>).
  cachedStore = {
    vectorBucketName: cfg.vectorBucketArn.split("/").pop()!,
    indexName: cfg.indexArn.split("/").pop()!,
  };
  return cachedStore;
}

/** Counts indexed chunks per source filename (e.g. "ClaudeCode_Ch5_HandsOnLab.html"). Returns
 * null when the Knowledge Base isn't configured for this deployment (§region fallback). */
export async function countChunksBySource(): Promise<Record<string, number> | null> {
  const store = await resolveVectorStore();
  if (!store) return null;

  const counts: Record<string, number> = {};
  let nextToken: string | undefined;
  do {
    const res = await s3vectors.send(
      new ListVectorsCommand({
        vectorBucketName: store.vectorBucketName,
        indexName: store.indexName,
        returnMetadata: true,
        maxResults: 500,
        nextToken,
      }),
    );
    for (const v of res.vectors ?? []) {
      const raw = (v.metadata as Record<string, unknown> | undefined)?.AMAZON_BEDROCK_METADATA;
      if (typeof raw !== "string") continue;
      try {
        const uri = JSON.parse(raw)?.source?.sourceLocation as string | undefined;
        const name = uri?.split("/").pop();
        if (name) counts[name] = (counts[name] ?? 0) + 1;
      } catch {
        // malformed metadata on one vector shouldn't sink the whole count
      }
    }
    nextToken = res.nextToken;
  } while (nextToken);

  return counts;
}
