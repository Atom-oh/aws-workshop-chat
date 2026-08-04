import { Stack, StackProps, CfnOutput, Duration, RemovalPolicy, CustomResource } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as customResources from "aws-cdk-lib/custom-resources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import * as path from "node:path";

export interface WorkshopChatStackProps extends StackProps {
  workshopName: string;
  scale: "small" | "large";
  bedrockModelId: string;
  /**
   * Region Bedrock (and the KB, if enabled) actually lives in — see lib/bedrock-stack.ts.
   * Defaults to this stack's own region in app.ts; only differs when the environment (e.g. an
   * AWS Workshop Studio participant account) restricts Bedrock to a single region.
   */
  bedrockRegion: string;
  /** Cognito username for the one operator account; a random password is generated at deploy. */
  adminUsername: string;
  participantPassphrase: string;
  participantCount: number;
  /**
   * Owned by bedrock-stack.ts (in bedrockRegion) when the KB is enabled — a Bedrock KB's S3 data
   * source must be in the same region as the KB. Undefined when the KB is disabled, in which
   * case this stack creates its own bucket locally.
   */
  guideBucketName?: string;
  /** Region the guide bucket actually lives in — bedrockRegion when guideBucketName is set, this stack's own region otherwise. Read by the app container's S3Client to avoid a cross-region PermanentRedirect. */
  guideBucketRegion: string;
  /** Both present when enableKnowledgeBase=true (bedrock-stack.ts); absent for the prompt-injection fallback. */
  knowledgeBaseId?: string;
  dataSourceId?: string;
  /** ARN of a CLOUDFRONT-scoped WAFv2 WebACL, created in us-east-1 — see lib/waf-stack.ts. */
  webAclArn: string;
  /** All three required together for a custom domain; omit all to fall back to the raw CloudFront domain. */
  domainName?: string;
  hostedZoneId?: string;
  hostedZoneName?: string;
  certificateArn?: string;
}

export class WorkshopChatStack extends Stack {
  constructor(scope: Construct, id: string, props: WorkshopChatStackProps) {
    super(scope, id, props);

    // ---------- DynamoDB ----------
    const table = new dynamodb.TableV2(this, "Table", {
      tableName: `${props.workshopName}-WorkshopChat`,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: RemovalPolicy.DESTROY, // §3: no resource may outlive the 3-day account
    });

    // ---------- S3 buckets (media/guide/exports — all disposable) ----------
    const bucketProps = {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    } as const;
    const mediaBucket = new s3.Bucket(this, "MediaBucket", { ...bucketProps, cors: [
      { allowedMethods: [s3.HttpMethods.PUT], allowedOrigins: ["*"], allowedHeaders: ["*"] },
    ] });
    // When the KB is enabled, bedrock-stack.ts owns the actual bucket (must be co-located with
    // the KB) and only hands back its name; imported here by name rather than constructed. When
    // disabled, this stack owns it directly, same as before.
    const guideBucket: s3.IBucket = props.guideBucketName
      ? s3.Bucket.fromBucketName(this, "GuideBucket", props.guideBucketName)
      : new s3.Bucket(this, "GuideBucket", {
          ...bucketProps,
          cors: [{ allowedMethods: [s3.HttpMethods.PUT], allowedOrigins: ["*"], allowedHeaders: ["*"] }],
        });
    const exportsBucket = new s3.Bucket(this, "ExportsBucket", bucketProps);

    if (!props.guideBucketName) {
      new s3deploy.BucketDeployment(this, "GuideDeployment", {
        sources: [s3deploy.Source.asset(path.join(__dirname, "../../guide"))],
        destinationBucket: guideBucket,
        destinationKeyPrefix: "guide",
        prune: false, // operator-uploaded guide docs (§ops) must survive later `cdk deploy` runs
      });
    }

    // ---------- Cognito ----------
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${props.workshopName}-participants`,
      selfSignUpEnabled: false, // every user is created by the credentials provisioner below
      signInAliases: { username: true },
      removalPolicy: RemovalPolicy.DESTROY,
      standardAttributes: {}, // no email/phone/name collected — §3.1: no PII, ever
    });
    const userPoolClient = userPool.addClient("AppClient", {
      authFlows: { adminUserPassword: true },
    });

    // Role membership lives in Cognito groups, not a naming convention or a single hardcoded
    // username — the credentials provisioner adds every user to exactly one of these at
    // creation time, and the app checks group membership at login instead of comparing against
    // a fixed adminUsername string.
    const adminGroup = new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "admin",
    });
    const participantGroup = new cognito.CfnUserPoolGroup(this, "ParticipantGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "participant",
    });

    // One secret, two jobs: the credentials-provider Lambda uses it to derive each participant's
    // Cognito ID/password (§5.1), and the app container reuses the exact same value as its
    // session-token signing secret (SESSION_SECRET below). That lets the operator console
    // re-derive any participant's ID and mint their join link on demand, with no separate
    // roster to keep in sync. Secrets Manager, not a plain CFN parameter, so the value never
    // appears in the stack template or CloudFormation console.
    const credentialSeed = new secretsmanager.Secret(this, "CredentialSeed", {
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
      removalPolicy: RemovalPolicy.DESTROY, // §3: no resource may outlive the 3-day account
    });

    // The one operator account. Unlike participants (derived from credentialSeed, many of them,
    // recreated as participantCount grows), there's exactly one of these, so it gets its own
    // secret rather than a derivation — the value never appears in the stack template, only
    // retrievable via `aws secretsmanager get-secret-value` (see the OperatorCredentialsCommand
    // output).
    const operatorPassword = new secretsmanager.Secret(this, "OperatorPassword", {
      generateSecretString: {
        passwordLength: 20,
        // no quotes/backslash/@ (breaks JSON/shell/ARN copy-paste), no comma (breaks the AWS
        // CLI's key=val,key=val shorthand parsing if anyone pastes this into --auth-parameters)
        excludeCharacters: '"@/\\\'`, ',
        requireEachIncludedType: true, // Cognito's default password policy needs all four classes
      },
      removalPolicy: RemovalPolicy.DESTROY, // §3: no resource may outlive the 3-day account
    });

    // ---------- Networking ----------
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0, // ponytail: the app task needs no private egress; public subnets + a
      // security group are enough, and this is the difference between a NAT gateway bill and
      // none for a 3-day stack.
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC }],
    });

    // ---------- Fargate ----------
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    table.grantReadWriteData(taskRole);
    mediaBucket.grantReadWrite(taskRole);
    guideBucket.grantReadWrite(taskRole); // operator console manages guide docs (upload/toggle/delete)
    exportsBucket.grantReadWrite(taskRole);
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream", // required by ConverseStream, distinct from InvokeModel
          "bedrock:Retrieve",
          "bedrock:StartIngestionJob",
          "bedrock:GetIngestionJob",
          "bedrock:GetKnowledgeBase", // resolves the KB's vector-bucket/index ARNs, see guide-index.ts
        ],
        resources: ["*"], // model/KB ARNs vary by region+model; scoping further needs the ARN at synth time
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        // The reindex retry loop (app/src/ai/guide-index.ts) counts chunks per source document
        // directly from the vector index — Bedrock's own per-document status API can report a
        // document "indexed" even when its write to S3 Vectors actually failed. Wildcard for the
        // same reason as the bedrock:* grant above: the vector bucket/index now live in a
        // separate cross-region stack (bedrock-stack.ts) and their ARNs aren't available here.
        // ListVectors with returnMetadata:true (as used here) requires GetVectors, not just
        // ListVectors — confirmed live via a 403 AccessDeniedException naming GetVectors even
        // though the SDK call is ListVectorsCommand.
        actions: ["s3vectors:ListVectors", "s3vectors:GetVectors"],
        resources: ["*"],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        // AdminInitiateAuth verifies the password; AdminListGroupsForUser checks which of
        // admin/participant the authenticated user belongs to (role now comes from Cognito
        // group membership, not a hardcoded adminUsername comparison).
        actions: ["cognito-idp:AdminInitiateAuth", "cognito-idp:AdminListGroupsForUser"],
        resources: [userPool.userPoolArn],
      }),
    );

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: 1024,
      memoryLimitMiB: 2048, // sized for the documented single-task ceiling of ~500 WebSocket clients
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const container = taskDef.addContainer("app", {
      // Built and pushed by CDK itself at deploy time — no empty-repo/first-deploy chicken-and-egg,
      // no manual `docker build && docker push` step. Must match the task's ARM64 runtimePlatform.
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, "../.."), {
        file: "app/Dockerfile",
        platform: ecrAssets.Platform.LINUX_ARM64,
      }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "app", logRetention: logs.RetentionDays.THREE_DAYS }),
      environment: {
        TABLE_NAME: table.tableName,
        MEDIA_BUCKET: mediaBucket.bucketName,
        GUIDE_BUCKET: guideBucket.bucketName,
        GUIDE_BUCKET_REGION: props.guideBucketRegion,
        EXPORT_BUCKET: exportsBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_ADMIN_GROUP: adminGroup.groupName!,
        COGNITO_PARTICIPANT_GROUP: participantGroup.groupName!,
        BEDROCK_MODEL_ID: props.bedrockModelId,
        BEDROCK_REGION: props.bedrockRegion,
        ...(props.knowledgeBaseId && props.dataSourceId
          ? { BEDROCK_KB_ID: props.knowledgeBaseId, BEDROCK_KB_DATA_SOURCE_ID: props.dataSourceId }
          : {}),
        SCALE: props.scale,
        ADMIN_USERNAME: props.adminUsername,
        PARTICIPANT_PASSPHRASE: props.participantPassphrase,
        PARTICIPANT_COUNT: String(props.participantCount),
        PORT: "3000",
      },
      secrets: {
        SESSION_SECRET: ecs.Secret.fromSecretsManager(credentialSeed),
      },
    });
    container.addPortMappings({ containerPort: 3000 });

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1, // ponytail: single task by design — see plan's §7 deviation on realtime
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", { vpc, internetFacing: true });
    const listener = alb.addListener("Listener", { port: 80, open: true });
    listener.addTargets("AppTargets", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: { path: "/api/labstep", interval: Duration.seconds(30) },
    });

    // ---------- CloudFront ----------
    const origin = new origins.LoadBalancerV2Origin(alb, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY });
    const noCacheBehavior: cloudfront.BehaviorOptions = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // AllViewer forwards Upgrade/Connection/Sec-WebSocket-* — required for the /ws handshake
      // and harmless (if unused) on /api and /j.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    };

    const hasCustomDomain = !!(props.domainName && props.hostedZoneId && props.certificateArn);
    const certificate = hasCustomDomain
      ? acm.Certificate.fromCertificateArn(this, "Cert", props.certificateArn!)
      : undefined;

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        "/ws*": noCacheBehavior,
        "/api/*": noCacheBehavior,
        "/j": noCacheBehavior,
      },
      webAclId: props.webAclArn,
      // §7.2: the /j?t=<token> querystring must never persist in access logs.
      logIncludesCookies: false,
      ...(hasCustomDomain ? { domainNames: [props.domainName!], certificate } : {}),
    });

    if (hasCustomDomain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
        hostedZoneId: props.hostedZoneId!,
        zoneName: props.hostedZoneName ?? props.domainName!.split(".").slice(-2).join("."),
      });
      const target = route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution));
      new route53.ARecord(this, "AliasA", { zone, recordName: props.domainName!, target });
      new route53.AaaaRecord(this, "AliasAaaa", { zone, recordName: props.domainName!, target });
    }

    const appHostname = hasCustomDomain ? props.domainName! : distribution.distributionDomainName;

    // ---------- Credential provisioning (Custom Resource) ----------
    const credentialsFn = new NodejsFunction(this, "CredentialsProvider", {
      entry: path.join(__dirname, "../lambda/credentials-handler.ts"),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.minutes(14),
      memorySize: 512,
    });
    userPool.grant(
      credentialsFn,
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminSetUserPassword",
      "cognito-idp:AdminAddUserToGroup",
    );
    credentialSeed.grantRead(credentialsFn);
    operatorPassword.grantRead(credentialsFn);
    credentialsFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["cloudwatch:PutMetricData"], resources: ["*"] }),
    );

    const provider = new customResources.Provider(this, "CredentialsProviderResource", {
      onEventHandler: credentialsFn,
    });
    const credentialsResource = new CustomResource(this, "Credentials", {
      serviceToken: provider.serviceToken,
      properties: {
        UserPoolId: userPool.userPoolId,
        // ARNs, not values: CloudFormation dynamic references to Secrets Manager are NOT
        // resolved in custom resource properties (AWS docs — "can't be used for secure values
        // ... in custom resources"), so passing secretValue.unsafeUnwrap() here would hand the
        // Lambda the literal unresolved "{{resolve:secretsmanager:...}}" token string instead of
        // the real secret. The Lambda fetches both via GetSecretValue itself (grantRead above).
        SeedArn: credentialSeed.secretArn,
        ParticipantCount: props.participantCount,
        AdminUsername: props.adminUsername,
        AdminPasswordArn: operatorPassword.secretArn,
        AdminGroupName: adminGroup.groupName,
        ParticipantGroupName: participantGroup.groupName,
      },
    });
    // AdminAddUserToGroup needs the group to already exist — CfnUserPoolGroup isn't referenced
    // by ARN/attribute above, so there's no implicit dependency edge without this.
    credentialsResource.node.addDependency(adminGroup, participantGroup);

    // ---------- Outputs (§10) ----------
    new CfnOutput(this, "AppUrl", { value: `https://${appHostname}` });
    new CfnOutput(this, "OperatorConsoleUrl", { value: `https://${appHostname}/operator` });
    new CfnOutput(this, "ExportBucketPath", { value: `s3://${exportsBucket.bucketName}/exports/latest.xlsx` });
    new CfnOutput(this, "GuideBucketPath", { value: `s3://${guideBucket.bucketName}/guide/` });
    new CfnOutput(this, "CloudWatchMetricsLink", {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#metricsV2:namespace=WorkshopChat`,
    });
    new CfnOutput(this, "OperatorUsername", { value: props.adminUsername });
    new CfnOutput(this, "OperatorCredentialsCommand", {
      value: `aws secretsmanager get-secret-value --region ${this.region} --secret-id ${operatorPassword.secretArn} --query SecretString --output text`,
    });
    // Lets `scripts/gen-links.ts` re-derive join links from the command line without guessing
    // the CDK-generated secret name — same seed the app container and the credentials
    // provisioner both already use (see the comment on `credentialSeed` above).
    new CfnOutput(this, "CredentialSeedArn", { value: credentialSeed.secretArn });
    if (props.knowledgeBaseId && props.dataSourceId) {
      // Ingestion is not automatic on upload — this is the exact command to re-run after every
      // guide change (see README "Guide documents"). Runs against bedrockRegion, not this
      // stack's own region — the KB lives wherever lib/bedrock-stack.ts was deployed.
      new CfnOutput(this, "GuideSyncCommand", {
        value: `aws bedrock-agent start-ingestion-job --region ${props.bedrockRegion} --knowledge-base-id ${props.knowledgeBaseId} --data-source-id ${props.dataSourceId}`,
      });
    }
  }
}
