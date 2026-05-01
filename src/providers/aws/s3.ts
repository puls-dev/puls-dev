import {
  HeadBucketCommand,
  CreateBucketCommand,
  GetBucketPolicyCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import { BaseBuilder } from '../../core/resource.ts';
import { CloudFrontBuilder } from './cloudfront.ts';
import { getS3Client } from './api.ts';
import { Config } from '../../core/config.ts';

export class S3BucketBuilder extends BaseBuilder {
  private _versioning: boolean = false;
  private _allowedDistributions: CloudFrontBuilder[] = [];

  constructor(public bucketName: string) {
    super(bucketName);
    this.discoveryPromise = this.discoverBucket(bucketName);
  }

  private async discoverBucket(name: string): Promise<boolean> {
    try {
      await getS3Client().send(new HeadBucketCommand({ Bucket: name }));
      return true;
    } catch (e: any) {
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
      if (e.name === 'CredentialsProviderError') return false;
      throw e;
    }
  }

  versioning(enabled: boolean = true) {
    this._versioning = enabled;
    return this;
  }

  allowFrom(...distributions: CloudFrontBuilder[]) {
    this._allowedDistributions.push(...distributions);
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const exists = await this.discoveryPromise;
    const s3 = getS3Client();
    const region = Config.get().providers.aws?.region ?? 'us-east-1';

    console.log(`\n🪣  Finalizing S3 Bucket "${this.bucketName}"...`);

    if (!exists) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create bucket ${this.bucketName} (${region})`);
      } else {
        const createCmd: any = { Bucket: this.bucketName };
        if (region !== 'us-east-1') {
          createCmd.CreateBucketConfiguration = { LocationConstraint: region };
        }
        await s3.send(new CreateBucketCommand(createCmd));
        console.log(`🚀 Created bucket ${this.bucketName}`);
      }
    } else {
      console.log(`   ✅ Bucket ${this.bucketName} already exists.`);
    }

    if (this._allowedDistributions.length > 0) {
      const unresolved = this._allowedDistributions.filter(d => !d.resolvedArn);
      if (unresolved.length > 0) {
        throw new Error(
          `[S3:${this.bucketName}] allowFrom() has unresolved distributions: ` +
          unresolved.map(d => `"${d.name}"`).join(', ') +
          '. Declare the bucket after all CloudFront distributions in your Stack.',
        );
      }

      const newArns = this._allowedDistributions.map(d => d.resolvedArn as string);

      if (dryRun) {
        console.log(`   📝 [PLAN] Append ${newArns.length} CloudFront OAC ARN(s) to bucket policy`);
        for (const arn of newArns) console.log(`      └─ ${arn}`);
      } else {
        await this.updateBucketPolicy(s3, newArns);
      }
    }

    await this.deploySidecars();
    return { name: this.bucketName };
  }

  private async updateBucketPolicy(s3: ReturnType<typeof getS3Client>, newArns: string[]) {
    let policy: any = { Version: '2012-10-17', Statement: [] };

    try {
      const existing = await s3.send(new GetBucketPolicyCommand({ Bucket: this.bucketName }));
      if (existing.Policy) policy = JSON.parse(existing.Policy);
    } catch (e: any) {
      if (e.name !== 'NoSuchBucketPolicy') throw e;
    }

    // Find or create the OAC statement
    let stmt = policy.Statement.find((s: any) => s.Sid === 'AllowCloudFrontOAC');
    if (!stmt) {
      stmt = {
        Sid: 'AllowCloudFrontOAC',
        Effect: 'Allow',
        Principal: { Service: 'cloudfront.amazonaws.com' },
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${this.bucketName}/*`,
        Condition: { StringEquals: { 'AWS:SourceArn': [] } },
      };
      policy.Statement.push(stmt);
    }

    const existing = stmt.Condition.StringEquals['AWS:SourceArn'];
    const existingArns: string[] = Array.isArray(existing) ? existing : existing ? [existing] : [];
    const merged = [...new Set([...existingArns, ...newArns])];
    stmt.Condition.StringEquals['AWS:SourceArn'] = merged;

    await s3.send(new PutBucketPolicyCommand({
      Bucket: this.bucketName,
      Policy: JSON.stringify(policy),
    }));

    console.log(`   ✅ Updated bucket policy — ${merged.length} distribution ARN(s) allowed`);
    for (const arn of newArns) console.log(`      └─ ${arn}`);
  }
}
