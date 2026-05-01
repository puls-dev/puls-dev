import { S3Client } from '@aws-sdk/client-s3';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { Route53Client } from '@aws-sdk/client-route-53';
import { ACMClient } from '@aws-sdk/client-acm';
import { Config } from '../../core/config.ts';

function getRegion(): string {
  const region = Config.get().providers.aws?.region;
  if (!region) throw new Error('AWS region not configured. Call AWS.init({ region: "..." })');
  return region;
}

export const getS3Client = () => new S3Client({ region: getRegion() });

// CloudFront, Route53, and ACM (for CF) are all global — must use us-east-1
export const getCFClient = () => new CloudFrontClient({ region: 'us-east-1' });
export const getR53Client = () => new Route53Client({ region: 'us-east-1' });
export const getACMClient = () => new ACMClient({ region: 'us-east-1' });
