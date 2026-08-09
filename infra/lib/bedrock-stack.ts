import { Stack, StackProps, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as path from "node:path";

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
}

export class WorkshopChatBedrockStack extends Stack {
  public readonly knowledgeBaseId: string;
  public readonly dataSourceId: string;
  public readonly guideBucketName: string;

  constructor(scope: Construct, id: string, props: WorkshopChatBedrockStackProps) {
    super(scope, id, props);

    // The guide-docs bucket has to live here, not in the main stack: a Bedrock Knowledge Base's
    // S3 data source must be in the *same region* as the KB itself (AWS requirement, not just an
    // SDK client setting) — see docs.aws.amazon.com/bedrock/latest/userguide/s3-data-source-connector.html.
    // Since this stack is the one pinned to bedrockRegion, it has to own the bucket too whenever
    // a KB exists at all.
    const guideBucket = new s3.Bucket(this, "GuideBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [{ allowedMethods: [s3.HttpMethods.PUT], allowedOrigins: ["*"], allowedHeaders: ["*"] }],
    });
    new s3deploy.BucketDeployment(this, "GuideDeployment", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../../guide"))],
      destinationBucket: guideBucket,
      destinationKeyPrefix: "guide",
      prune: false, // operator-uploaded guide docs (§ops) must survive later `cdk deploy` runs
    });
    this.guideBucketName = guideBucket.bucketName;

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
      // Without this, Bedrock stores each chunk's raw text (key AMAZON_BEDROCK_TEXT) and its own
      // ingestion metadata (key AMAZON_BEDROCK_METADATA — source location, create/modify dates)
      // as FILTERABLE metadata, which S3 Vectors caps at 2048 bytes combined per vector — a
      // single chunk of dense-UTF-8 (Korean) HTML content blows past that easily and the whole
      // document fails ingestion with "Filterable metadata must have at most 2048 bytes".
      // AMAZON_BEDROCK_TEXT alone wasn't enough: confirmed live (2026-08-09) that most guide
      // docs still failed with only it excluded — inspecting the successfully-written vectors
      // directly (`s3vectors list-vectors --return-metadata`) showed AMAZON_BEDROCK_METADATA is
      // a second, separate reserved key Bedrock always writes. AWS's own console instructions
      // for this exact setup (docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-setup.html,
      // "Using Amazon S3 Vectors") do call out both keys — this CDK code had only copied the
      // first one from an earlier example. Neither key is ever used as a query filter by this
      // app (ask.ts's RetrieveCommand has no metadata filter), so excluding both only removes
      // filterability nothing here relies on. Marking them non-filterable moves them into the
      // separate 40KB-per-vector allowance instead. Can only be set at index creation — not
      // updatable after the fact, so this replaces the index (and loses whatever's already
      // indexed) on deploy; re-ingest afterward.
      metadataConfiguration: { nonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"] },
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
    guideBucket.grantRead(kbRole);

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
          bucketArn: guideBucket.bucketArn,
          inclusionPrefixes: ["guide/"],
        },
      },
    });
    dataSource.node.addDependency(guideBucket);

    this.knowledgeBaseId = kb.attrKnowledgeBaseId;
    this.dataSourceId = dataSource.attrDataSourceId;

    new CfnOutput(this, "KnowledgeBaseId", { value: this.knowledgeBaseId });
    new CfnOutput(this, "DataSourceId", { value: this.dataSourceId });
    new CfnOutput(this, "GuideBucketName", { value: this.guideBucketName });
  }
}
