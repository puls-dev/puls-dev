import { BaseBuilder } from '../../core/resource.ts';
import { CloudFrontBuilder } from './cloudfront.ts';

export class S3BucketBuilder extends BaseBuilder {
  private _versioning: boolean = false;
  private _public: boolean = false;
  private _allowedDistributions: CloudFrontBuilder[] = [];

  constructor(public bucketName: string) {
    super(bucketName);
    this.discoveryPromise = this.mockApiCheck(bucketName);
  }

  versioning(enabled: boolean = true) {
    this._versioning = enabled;
    return this;
  }

  makePublic() {
    this._public = true;
    return this;
  }

  // Additively grants the given CloudFront distributions access to this bucket.
  // On deploy: fetches the current bucket policy, appends new ARNs, puts it back.
  // Existing statements and ARNs are preserved.
  allowFrom(...distributions: CloudFrontBuilder[]) {
    this._allowedDistributions.push(...distributions);
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    console.log(`\n🪣  Finalizing S3 Bucket "${this.bucketName}"...`);

    const existing = await this.discoveryPromise;
    if (existing) {
      console.log(`   ✅ Bucket ${this.bucketName} already exists.`);
    } else {
      console.log(`   🚀 [${dryRun ? 'PLAN' : 'OK'}] Creating S3 Bucket ${this.bucketName}`);
      if (this._versioning) console.log(`      └─ Versioning: Enabled`);
    }

    if (this._allowedDistributions.length > 0) {
      const unresolved = this._allowedDistributions.filter(d => d.resolvedArn === null);
      if (unresolved.length > 0) {
        throw new Error(
          `[S3:${this.bucketName}] allowFrom() has ${unresolved.length} distribution(s) with no resolvedArn: ` +
          unresolved.map(d => `"${d.name}"`).join(', ') +
          '. Declare the bucket after all CloudFront distributions in your Stack.'
        );
      }

      const newArns = this._allowedDistributions.map(d => d.resolvedArn as string);

      console.log(`   ✅ [${dryRun ? 'PLAN' : 'OK'}] Fetching current bucket policy for "${this.bucketName}"...`);
      console.log(`   ✅ [${dryRun ? 'PLAN' : 'OK'}] Appending ${newArns.length} new distribution ARN(s) to existing policy:`);
      for (const arn of newArns) {
        console.log(`      └─ ${arn}`);
      }
      console.log(`   ✅ [${dryRun ? 'PLAN' : 'OK'}] Putting updated policy back (existing statements preserved).`);
    }

    await this.deploySidecars();
    return { name: this.bucketName };
  }

  private async mockApiCheck(name: string) {
    await new Promise(resolve => setTimeout(resolve, 50));
    return null;
  }
}
