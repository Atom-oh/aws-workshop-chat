import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";

export interface WorkshopChatWafStackProps extends StackProps {
  workshopName: string;
}

// CLOUDFRONT-scoped WAFv2 WebACLs can only be created via the us-east-1 API endpoint, regardless
// of which region the rest of the stack deploys to — hence this stack always targets us-east-1
// (see bin/app.ts) while WorkshopChatStack can deploy anywhere.
export class WorkshopChatWafStack extends Stack {
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: WorkshopChatWafStackProps) {
    super(scope, id, props);

    this.webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${props.workshopName}Waf`.replace(/[^a-zA-Z0-9]/g, ""),
      },
      rules: [
        {
          name: "RateLimit",
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" } },
          visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: "RateLimit" },
        },
      ],
    });
  }
}
