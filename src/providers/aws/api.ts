import { S3Client } from "@aws-sdk/client-s3";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { Route53Client } from "@aws-sdk/client-route-53";
import { Route53DomainsClient } from "@aws-sdk/client-route-53-domains";
import { ACMClient } from "@aws-sdk/client-acm";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { IAMClient } from "@aws-sdk/client-iam";
import { ApiGatewayV2Client } from "@aws-sdk/client-apigatewayv2";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { RDSClient } from "@aws-sdk/client-rds";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { SNSClient } from "@aws-sdk/client-sns";
import { Config } from "../../core/config.js";
import { withRetry } from "../../core/retry.js";

function getRegion(): string {
  const region = Config.get().providers.aws?.region;
  if (!region)
    throw new Error(
      'AWS region not configured. Call AWS.init({ region: "..." })',
    );
  return region;
}

function wrapClient<T extends { send: Function }>(client: T): T {
  const originalSend = client.send;
  client.send = function (command: any, options?: any) {
    return withRetry(
      () => originalSend.call(client, command, options),
      {
        retryable: (err) => {
          const code = err.name || err.code;
          const status = err.$metadata?.httpStatusCode;
          return (
            code === "ThrottlingException" ||
            code === "ProvisionedThroughputExceededException" ||
            code === "RequestLimitExceeded" ||
            (status && status >= 500)
          );
        }
      }
    );
  };
  return client;
}

export const getS3Client = (region?: string) =>
  wrapClient(new S3Client({ region: region ?? getRegion() }));

// CloudFront, Route53, ACM, Route53 Domains, and IAM are all global - must use us-east-1
export const getCFClient = () => wrapClient(new CloudFrontClient({ region: "us-east-1" }));
export const getR53Client = () => wrapClient(new Route53Client({ region: "us-east-1" }));
export const getR53DomainsClient = () =>
  wrapClient(new Route53DomainsClient({ region: "us-east-1" }));
export const getACMClient = () => wrapClient(new ACMClient({ region: "us-east-1" }));
export const getIAMClient = () => wrapClient(new IAMClient({ region: "us-east-1" }));
export const getLambdaClient = (region?: string) =>
  wrapClient(new LambdaClient({ region: region ?? getRegion() }));
export const getAPIGWClient = (region?: string) =>
  wrapClient(new ApiGatewayV2Client({ region: region ?? getRegion() }));
export const getECSClient = (region?: string) =>
  wrapClient(new ECSClient({ region: region ?? getRegion() }));
export const getEC2Client = (region?: string) =>
  wrapClient(new EC2Client({ region: region ?? getRegion() }));
export const getCWLogsClient = (region?: string) =>
  wrapClient(new CloudWatchLogsClient({ region: region ?? getRegion() }));
export const getRDSClient = (region?: string) =>
  wrapClient(new RDSClient({ region: region ?? getRegion() }));
export const getSQSClient = (region?: string) =>
  wrapClient(new SQSClient({ region: region ?? getRegion() }));
export const getSecretsClient = (region?: string) =>
  wrapClient(new SecretsManagerClient({ region: region ?? getRegion() }));
export const getCWClient = (region?: string) =>
  wrapClient(new CloudWatchClient({ region: region ?? getRegion() }));
export const getSNSClient = (region?: string) =>
  wrapClient(new SNSClient({ region: region ?? getRegion() }));
