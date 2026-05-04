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
  private _region?: string;

  constructor(public bucketName: string) {
    super(bucketName);
    this.discoveryPromise = this.discoverBucket(bucketName);
  }

  region(r: string) {
    this._region = r;
    this.discoveryPromise = this.discoverBucket(this.bucketName);
    return this;
  }

  private async discoverBucket(name: string): Promise<boolean> {
    try {
      await getS3Client(this._region).send(new HeadBucketCommand({ Bucket: name }));
      return true;
    } catch (e: any) {
      const status = e.$metadata?.httpStatusCode;
      if (status === 404 || e.name === 'NotFound') return false;
      if (status === 301 || status === 403) return true; // exists in different region or access denied
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
    const region = this._region ?? Config.get().providers.aws?.region ?? 'us-east-1';
    const s3 = getS3Client(region);

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

    // Find any existing CloudFront-principal statement regardless of Sid
    let stmt = policy.Statement.find((s: any) =>
      s.Principal?.Service === 'cloudfront.amazonaws.com' && s.Effect === 'Allow',
    );
    if (!stmt) {
      stmt = {
        Sid: 'AllowCloudFrontServicePrincipal',
        Effect: 'Allow',
        Principal: { Service: 'cloudfront.amazonaws.com' },
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${this.bucketName}/*`,
        Condition: { StringEquals: { 'AWS:SourceArn': [] } },
      };
      policy.Statement.push(stmt);
    }

    // Condition key may be 'aws:SourceArn' or 'AWS:SourceArn' depending on how it was created
    const cond = stmt.Condition?.StringEquals ?? {};
    const sourceArnKey = Object.keys(cond).find(k => k.toLowerCase() === 'aws:sourcearn') ?? 'AWS:SourceArn';
    if (!stmt.Condition) stmt.Condition = { StringEquals: {} };
    if (!stmt.Condition.StringEquals) stmt.Condition.StringEquals = {};

    const existing = stmt.Condition.StringEquals[sourceArnKey];
    const existingArns: string[] = Array.isArray(existing) ? existing : existing ? [existing] : [];
    const merged = [...new Set([...existingArns, ...newArns])];
    stmt.Condition.StringEquals[sourceArnKey] = merged;

    await s3.send(new PutBucketPolicyCommand({
      Bucket: this.bucketName,
      Policy: JSON.stringify(policy),
    }));

    console.log(`   ✅ Updated bucket policy — ${merged.length} distribution ARN(s) allowed`);
    for (const arn of newArns) console.log(`      └─ ${arn}`);
  }
}
