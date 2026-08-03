import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";

// Same reasoning as the WAF stack (lib/waf-stack.ts): Amazon Bedrock (models, Knowledge Bases,
// S3 Vectors) is only available in specific regions — in an AWS Workshop Studio participant
// account it's us-east-1 only — while the rest of the app (DynamoDB, ECS, ALB) should be able to
// deploy wherever's closest to participants. This stack owns every Bedrock/S3-Vectors resource
// and is pinned to its own region via `env.region`; the main stack (workshop-chat-stack.ts)
// consumes its outputs as plain cross-region references, same pattern as the WAF WebACL ARN.
const EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";
const EMBEDDING_DIMENSION = 1024;

export interface WorkshopChatBedrockStackProps extends StackProps {
  workshopName: string;
  /**
   * ARN of the guide-docs S3 bucket, owned by the main stack (possibly a different region).
   * Passed as a plain string rather than an `s3.Bucket` construct reference — S3 bucket ARNs
   * work cross-region for both Bedrock's data-source config and the IAM grant below, and this
   * sidesteps needing the bucket's *name* to be deterministic just to break a circular
   * stack dependency (main stack needs this stack's KB id; this stack needs the main stack's
   * bucket ARN).
   */
  guideBucketArn: string;
}

export class WorkshopChatBedrockStack extends Stack {
  public readonly knowledgeBaseId: string;
  public readonly dataSourceId: string;

  constructor(scope: Construct, id: string, props: WorkshopChatBedrockStackProps) {
    super(scope, id, props);

    // "-v2" avoids a name collision with the old main-stack-owned vector bucket of the same
    // base name — CloudFormation refuses to let a different stack create a resource with a
    // physical name still tracked as owned by another stack, even after that resource has been
    // deleted out-of-band. The old bucket is deleted for real once the main stack's own deploy
    // (which no longer defines it) runs and formally releases it.
    const vectorBucket = new s3vectors.CfnVectorBucket(this, "VectorBucket", {
      vectorBucketName: `${props.workshopName}-guide-vectors-v2`.toLowerCase().slice(0, 63),
    });
    const index = new s3vectors.CfnIndex(this, "VectorIndex", {
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      indexName: "guide",
      dataType: "float32",
      dimension: EMBEDDING_DIMENSION,
      distanceMetric: "cosine",
      // Without this, Bedrock stores each chunk's raw text as FILTERABLE metadata (key
      // AMAZON_BEDROCK_TEXT), which S3 Vectors caps at 2048 bytes per vector — a single chunk of
      // dense-UTF-8 (Korean) HTML content blows past that easily and the whole document fails
      // ingestion with "Filterable metadata must have at most 2048 bytes". Marking it
      // non-filterable moves it into the separate 40KB-per-vector allowance instead. Can only be
      // set at index creation — not updatable after the fact.
      metadataConfiguration: { nonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT"] },
    });

    const kbRole = new iam.Role(this, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
    });
    const invokeModelGrant = kbRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [`arn:aws:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL_ID}`],
      }),
    );
    const s3vectorsGrant = kbRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // DeleteVectors is required even for a first-time deploy: re-syncing an already-known
        // document (any edit-and-reingest, or a stuck document needing a delete+recreate to
        // clear corrupted per-document tracking) has Bedrock delete the old vectors before
        // writing new ones. Without it, ingestion fails with "not authorized to perform:
        // s3vectors:DeleteVectors" — confirmed live against this exact KB/index.
        actions: ["s3vectors:GetVectors", "s3vectors:PutVectors", "s3vectors:DeleteVectors", "s3vectors:QueryVectors", "s3vectors:GetIndex"],
        resources: [index.attrIndexArn, vectorBucket.attrVectorBucketArn],
      }),
    );
    // Grant by ARN string, not `guideBucket.grantRead(kbRole)` — the bucket construct lives in
    // the main stack's (possibly different) region, and cross-region construct-level grants
    // fight CDK's same-stack assumptions. A plain IAM policy statement works fine cross-region.
    kbRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [props.guideBucketArn, `${props.guideBucketArn}/*`],
      }),
    );

    const kb = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: `${props.workshopName}-guide-kb`,
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL_ID}`,
        },
      },
      storageConfiguration: {
        type: "S3_VECTORS",
        s3VectorsConfiguration: {
          vectorBucketArn: vectorBucket.attrVectorBucketArn,
          indexArn: index.attrIndexArn,
        },
      },
    });
    kb.node.addDependency(index);
    // IAM policy attachment (a separate CFN resource from the Role itself) has no implicit
    // dependency edge to KB — without this, KB creation can race the policy attach and fail
    // with an AccessDenied on s3vectors:QueryVectors.
    if (invokeModelGrant.policyDependable) kb.node.addDependency(invokeModelGrant.policyDependable);
    if (s3vectorsGrant.policyDependable) kb.node.addDependency(s3vectorsGrant.policyDependable);

    const dataSource = new bedrock.CfnDataSource(this, "GuideDataSource", {
      knowledgeBaseId: kb.attrKnowledgeBaseId,
      name: `${props.workshopName}-guide-source`,
      dataSourceConfiguration: {
        type: "S3",
        s3Configuration: {
          bucketArn: props.guideBucketArn,
          inclusionPrefixes: ["guide/"],
        },
      },
    });

    this.knowledgeBaseId = kb.attrKnowledgeBaseId;
    this.dataSourceId = dataSource.attrDataSourceId;

    new CfnOutput(this, "KnowledgeBaseId", { value: this.knowledgeBaseId });
    new CfnOutput(this, "DataSourceId", { value: this.dataSourceId });
  }
}
