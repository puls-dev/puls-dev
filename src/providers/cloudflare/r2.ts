import { BaseBuilder } from "../../core/resource.js";
import { getCloudflareApi, getCloudflareAccountId } from "./api.js";

export class R2Builder extends BaseBuilder {
  constructor(public bucketName: string) {
    super(bucketName);
    this.discoveryPromise = this.discoverBucket(bucketName);
  }

  private async discoverBucket(name: string): Promise<any> {
    try {
      const api = getCloudflareApi();
      const accountId = getCloudflareAccountId();
      const res = await api.get<{ result: { buckets: any[] } }>(`/accounts/${accountId}/r2/buckets`);
      return (res.result?.buckets ?? []).find((b) => b.name === name) ?? null;
    } catch {
      return null;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getCloudflareApi();
    const accountId = getCloudflareAccountId();

    console.log(`\n🪣  Finalizing Cloudflare R2 Bucket "${this.bucketName}"...`);

    if (existing) {
      console.log(`   ✅ R2 Bucket "${this.bucketName}" already exists`);
      return { bucket: this.bucketName };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Create R2 Bucket "${this.bucketName}"`);
      return { bucket: this.bucketName };
    }

    await api.put(`/accounts/${accountId}/r2/buckets/${this.bucketName}`, {});
    console.log(`🚀 Created R2 Bucket "${this.bucketName}"`);

    return { bucket: this.bucketName };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getCloudflareApi();
    const accountId = getCloudflareAccountId();

    console.log(`\n🗑️  Destroying Cloudflare R2 Bucket "${this.bucketName}"...`);

    if (!existing) {
      console.log(`   ─  R2 Bucket "${this.bucketName}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete R2 Bucket "${this.bucketName}"`);
      return { destroyed: this.bucketName };
    }

    await api.delete(`/accounts/${accountId}/r2/buckets/${this.bucketName}`);
    console.log(`   🗑️  Removed R2 Bucket "${this.bucketName}"`);
    return { destroyed: this.bucketName };
  }
}
