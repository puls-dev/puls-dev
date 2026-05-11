import { Config } from "../../core/config.ts";
import { S3BucketBuilder } from "./s3.ts";
import { Route53Builder } from "./route53.ts";
import { CloudFrontBuilder } from "./cloudfront.ts";
import { LambdaBuilder } from "./lambda.ts";
import { APIGatewayBuilder } from "./apigateway.ts";
import { FargateBuilder } from "./fargate.ts";
import { RDSBuilder } from "./rds.ts";
import { SQSBuilder } from "./sqs.ts";
import { SecretsBuilder } from "./secrets.ts";

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
};
