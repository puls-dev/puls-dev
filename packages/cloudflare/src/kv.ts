import { BaseBuilder } from "@puls-dev/core";
import { Output } from "@puls-dev/core";
import { getCloudflareApi, getCloudflareAccountId } from "./api.js";

export class KVBuilder extends BaseBuilder {
  readonly out = {
    id: new Output<string>(),
  };

  resolvedId: string | null = null;

  constructor(public title: string) {
    super(title);
    this.discoveryPromise = this.discoverNamespace(title);
  }

  private async discoverNamespace(title: string): Promise<any> {
    try {
      const api = getCloudflareApi();
      const accountId = getCloudflareAccountId();
      const res = await api.get<{ result: any[] }>(`/accounts/${accountId}/workers/namespaces?per_page=100`);
      return (res.result ?? []).find((n) => n.title === title) ?? null;
    } catch {
      return null;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getCloudflareApi();
    const accountId = getCloudflareAccountId();

    console.log(`\n📦 Finalizing Cloudflare KV Namespace "${this.title}"...`);

    if (existing) {
      this.resolvedId = existing.id;
      this.out.id.resolve(existing.id);
      console.log(`   ✅ KV Namespace "${this.title}" already exists (id=${existing.id})`);
      return { title: this.title, id: this.resolvedId };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Create KV Namespace "${this.title}"`);
      this.out.id.resolve("PENDING");
      return { title: this.title, id: "PENDING" };
    }

    const res = await api.post<{ result: { id: string } }>(`/accounts/${accountId}/workers/namespaces`, {
      title: this.title,
    });

    this.resolvedId = res.result.id;
    this.out.id.resolve(this.resolvedId);
    console.log(`🚀 Created KV Namespace "${this.title}" (id=${this.resolvedId})`);

    return { title: this.title, id: this.resolvedId };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getCloudflareApi();
    const accountId = getCloudflareAccountId();

    console.log(`\n🗑️  Destroying Cloudflare KV Namespace "${this.title}"...`);

    if (!existing) {
      console.log(`   ─  KV Namespace "${this.title}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete KV Namespace "${this.title}" (id=${existing.id})`);
      return { destroyed: this.title };
    }

    await api.delete(`/accounts/${accountId}/workers/namespaces/${existing.id}`);
    console.log(`   🗑️  Removed KV Namespace "${this.title}" (id=${existing.id})`);
    return { destroyed: this.title };
  }
}
