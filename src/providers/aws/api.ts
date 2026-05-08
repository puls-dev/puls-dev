import { S3Client } from '@aws-sdk/client-s3';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { Route53Client } from '@aws-sdk/client-route-53';
import { Route53DomainsClient } from '@aws-sdk/client-route-53-domains';
import { ACMClient } from '@aws-sdk/client-acm';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { IAMClient } from '@aws-sdk/client-iam';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { ECSClient } from '@aws-sdk/client-ecs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { RDSClient } from '@aws-sdk/client-rds';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Config } from '../../core/config.ts';

function getRegion(): string {
  const region = Config.get().providers.aws?.region;
  if (!region) throw new Error('AWS region not configured. Call AWS.init({ region: "..." })');
  return region;
}

export const getS3Client = (region?: string) => new S3Client({ region: region ?? getRegion() });

// CloudFront, Route53, ACM, Route53 Domains, and IAM are all global — must use us-east-1
export const getCFClient = () => new CloudFrontClient({ region: 'us-east-1' });
export const getR53Client = () => new Route53Client({ region: 'us-east-1' });
export const getR53DomainsClient = () => new Route53DomainsClient({ region: 'us-east-1' });
export const getACMClient = () => new ACMClient({ region: 'us-east-1' });
export const getIAMClient = () => new IAMClient({ region: 'us-east-1' });
export const getLambdaClient = (region?: string) => new LambdaClient({ region: region ?? getRegion() });
export const getAPIGWClient = (region?: string) => new ApiGatewayV2Client({ region: region ?? getRegion() });
export const getECSClient = (region?: string) => new ECSClient({ region: region ?? getRegion() });
export const getEC2Client = (region?: string) => new EC2Client({ region: region ?? getRegion() });
export const getCWLogsClient = (region?: string) => new CloudWatchLogsClient({ region: region ?? getRegion() });
export const getRDSClient = (region?: string) => new RDSClient({ region: region ?? getRegion() });
export const getSQSClient = (region?: string) => new SQSClient({ region: region ?? getRegion() });
