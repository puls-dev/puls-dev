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
import { resourceContextStorage } from "../../core/context.js";
import { fromIni } from "@aws-sdk/credential-providers";

function getRegion(): string {
  const context = resourceContextStorage.getStore();
  const region = context?.aws?.region ?? Config.get().providers.aws?.region;
  if (!region) {
    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return "us-east-1";
    }
    throw new Error(
      'AWS region not configured. Call AWS.init({ region: "..." }) or supply config in @Deploy',
    );
  }
  return region;
}

function getAwsClientConfig(region?: string): any {
  const context = resourceContextStorage.getStore();
  const aws = context?.aws;
  const targetRegion = region ?? getRegion();
  const config: any = { region: targetRegion };

  if (aws) {
    if (aws.accessKeyId && aws.secretAccessKey) {
      config.credentials = {
        accessKeyId: aws.accessKeyId,
        secretAccessKey: aws.secretAccessKey,
      };
    } else if (aws.profile) {
      config.credentials = fromIni({ profile: aws.profile });
    }
  }
  return config;
}

function createAwsOfflineMock(command: any): any {
  const name = command.constructor.name;
  if (name.includes("RunInstances")) {
    return {
      Instances: [
        {
          InstanceId: "i-mock1234567890abcdef0",
          State: { Name: "running" },
          PublicIpAddress: "54.210.12.34",
          PrivateIpAddress: "10.0.1.10",
        }
      ]
    };
  }
  if (name.includes("CreateVpc")) {
    return { Vpc: { VpcId: "vpc-mock123456" } };
  }
  if (name.includes("CreateSubnet")) {
    return { Subnet: { SubnetId: "subnet-mock123456" } };
  }
  if (name.includes("CreateSecurityGroup")) {
    return { GroupId: "sg-mock123456" };
  }
  if (name.includes("CreateBucket")) {
    return { Location: "/mock-bucket" };
  }
  if (name.includes("CreateKeyPair")) {
    return { KeyMaterial: "mock-private-key", KeyName: "mock-key" };
  }
  const mockProxy: any = new Proxy({}, {
    get(target, prop: string) {
      if (prop === "then") return undefined;
      // Pagination tokens must be undefined so discovery loops exit cleanly
      if (prop === "NextToken" || prop === "NextMarker" || prop === "Marker" || prop === "ContinuationToken") return undefined;
      if (prop === "CertificateArn") return "arn:aws:acm:us-east-1:123456789012:certificate/mock-cert-uuid";
      if (prop === "HostedZoneId") return "Z2FDTNDATAQYW2";
      if (prop === "Id" || prop === "id") return "mock-id-12345";
      if (prop === "Arn" || prop === "arn") return `arn:aws:mock:::resource/mock-id`;
      if (prop === "Status" || prop === "status") return "Active";
      if (prop === "DNSName") return "mock.cloudfront.net";
      if (prop.endsWith("s")) return [];
      return `mock-${prop.toLowerCase()}`;
    }
  });
  return mockProxy;
}

function wrapClient<T extends { send: Function }>(client: T): T {
  const originalSend = client.send;
  client.send = function (command: any, options?: any) {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    const name = command.constructor.name;
    const isWrite = !(
      name.startsWith("List") ||
      name.startsWith("Get") ||
      name.startsWith("Describe") ||
      name.startsWith("Head") ||
      name.startsWith("Search")
    );

    if (Config.isOfflineMode() || (Config.isGlobalDryRun() && isWrite)) {
      return Promise.resolve(createAwsOfflineMock(command));
    }

    const opts = abortSignal ? { abortSignal, ...options } : options;

    return withRetry(
      () => originalSend.call(client, command, opts),
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
  wrapClient(new S3Client(getAwsClientConfig(region)));

// CloudFront, Route53, ACM, Route53 Domains, and IAM are all global - must use us-east-1
export const getCFClient = () => wrapClient(new CloudFrontClient(getAwsClientConfig("us-east-1")));
export const getR53Client = () => wrapClient(new Route53Client(getAwsClientConfig("us-east-1")));
export const getR53DomainsClient = () =>
  wrapClient(new Route53DomainsClient(getAwsClientConfig("us-east-1")));
export const getACMClient = () => wrapClient(new ACMClient(getAwsClientConfig("us-east-1")));
export const getIAMClient = () => wrapClient(new IAMClient(getAwsClientConfig("us-east-1")));
export const getLambdaClient = (region?: string) =>
  wrapClient(new LambdaClient(getAwsClientConfig(region)));
export const getAPIGWClient = (region?: string) =>
  wrapClient(new ApiGatewayV2Client(getAwsClientConfig(region)));
export const getECSClient = (region?: string) =>
  wrapClient(new ECSClient(getAwsClientConfig(region)));
export const getEC2Client = (region?: string) =>
  wrapClient(new EC2Client(getAwsClientConfig(region)));
export const getCWLogsClient = (region?: string) =>
  wrapClient(new CloudWatchLogsClient(getAwsClientConfig(region)));
export const getRDSClient = (region?: string) =>
  wrapClient(new RDSClient(getAwsClientConfig(region)));
export const getSQSClient = (region?: string) =>
  wrapClient(new SQSClient(getAwsClientConfig(region)));
export const getSecretsClient = (region?: string) =>
  wrapClient(new SecretsManagerClient(getAwsClientConfig(region)));
export const getCWClient = (region?: string) =>
  wrapClient(new CloudWatchClient(getAwsClientConfig(region)));
export const getSNSClient = (region?: string) =>
  wrapClient(new SNSClient(getAwsClientConfig(region)));
