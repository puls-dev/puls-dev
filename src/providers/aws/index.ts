import { Config } from "../../core/config.js";
import { S3BucketBuilder } from "./s3.js";
import { Route53Builder } from "./route53.js";
import { CloudFrontBuilder } from "./cloudfront.js";
import { LambdaBuilder } from "./lambda.js";
import { APIGatewayBuilder } from "./apigateway.js";
import { FargateBuilder } from "./fargate.js";
import { RDSBuilder } from "./rds.js";
import { SQSBuilder } from "./sqs.js";
import { SecretsBuilder } from "./secrets.js";
import { IAMRoleBuilder, IAMPolicyBuilder } from "./iam.js";
import { SNSTopicBuilder } from "./sns.js";
import { CloudWatchAlarmBuilder } from "./cloudwatch.js";
import { EC2VMBuilder } from "./ec2.js";
import { EC2TemplateBuilder } from "./template.js";

export const AWS = {
  init: (opts: { region: string }) => {
    Config.set({
      providers: {
        ...Config.get().providers,
        aws: opts,
      },
    });
  },
  S3: (name: string) => new S3BucketBuilder(name),
  Route53: (name: string = "") => new Route53Builder(name),
  CloudFront: (name: string) => new CloudFrontBuilder(name),
  Lambda: (name: string) => new LambdaBuilder(name),
  APIGateway: (name: string) => new APIGatewayBuilder(name),
  Fargate: (name: string) => new FargateBuilder(name),
  RDS: (name: string) => new RDSBuilder(name),
  SQS: (name: string) => new SQSBuilder(name),
  Secret: (secretId: string) => new SecretsBuilder(secretId),
  IAMRole: (name: string) => new IAMRoleBuilder(name),
  IAMPolicy: (name: string) => new IAMPolicyBuilder(name),
  SNS: (name: string) => new SNSTopicBuilder(name),
  Alarm: (name: string) => new CloudWatchAlarmBuilder(name),
  EC2: (name: string) => new EC2VMBuilder(name),
  Template: (name: string) => new EC2TemplateBuilder(name),
};

export * from "../../types/aws.js";

