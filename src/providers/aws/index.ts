import { Config } from '../../core/config.ts';
import { S3BucketBuilder } from './s3.ts';
import { Route53Builder } from './route53.ts';
import { CloudFrontBuilder } from './cloudfront.ts';

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
  Route53: (name: string = '') => new Route53Builder(name),
  CloudFront: (name: string) => new CloudFrontBuilder(name),
};
