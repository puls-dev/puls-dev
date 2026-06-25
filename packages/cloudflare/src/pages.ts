import { BaseBuilder } from "@puls-dev/core";
import { Config } from "@puls-dev/core";
import { getCloudflareApi, getCloudflareAccountId } from "./api.js";
import { spawn } from "node:child_process";

export class CloudflarePagesBuilder extends BaseBuilder {
  private _sourcePath?: string;
  private _branch: string = "main";
  private _domains: string[] = [];

  constructor(projectName: string) {
    super(projectName);
    this.discoveryPromise = this.discoverProject(projectName);
  }

  private async discoverProject(projectName: string): Promise<any> {
    try {
      const api = getCloudflareApi();
      const accountId = getCloudflareAccountId();
      const res = await api.get<{ result: any }>(
        `/accounts/${accountId}/pages/projects/${projectName}`
      );
      return res.result || null;
    } catch (e: any) {
      if (e.message?.includes("404")) return null;
      if (e.name === "CredentialsProviderError") return null;
      throw e;
    }
  }

  source(path: string) {
    this._sourcePath = path;
    return this;
  }

  branch(name: string) {
    this._branch = name;
    return this;
  }

  domain(customDomain: string | string[]) {
    if (Array.isArray(customDomain)) {
      this._domains.push(...customDomain);
    } else {
      this._domains.push(customDomain);
    }
    return this;
  }

  protected async spawnWrangler(args: string[], env: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("npx", args, { stdio: "inherit", env });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Wrangler exited with code ${code}`));
      });
      child.on("error", (err) => reject(err));
    });
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const api = getCloudflareApi();
    const accountId = getCloudflareAccountId();
    const existing = await this.discoveryPromise;

    console.log(`\n⚡ Finalizing Cloudflare Pages Project "${this.name}"...`);

    if (!this._sourcePath) {
      throw new Error(`[Cloudflare.Pages:${this.name}] .source("./dist") is required`);
    }

    // 1. Create project if it doesn't exist
    if (!existing) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create Cloudflare Pages Project "${this.name}" (production_branch="${this._branch}")`);
      } else {
        await api.post(`/accounts/${accountId}/pages/projects`, {
          name: this.name,
          production_branch: this._branch,
        });
        console.log(`🚀 Created Cloudflare Pages Project "${this.name}"`);
      }
    } else {
      console.log(`   ✅ Cloudflare Pages Project "${this.name}" already exists`);
    }

    const subdomain = existing?.subdomain ?? `${this.name}.pages.dev`;

    // 2. Deploy/upload assets using Wrangler CLI
    if (dryRun) {
      console.log(`   📝 [PLAN] Deploy static assets from "${this._sourcePath}" to https://${subdomain}`);
      if (this._domains.length > 0) {
        console.log(`   📝 [PLAN] Configure custom domains:`);
        for (const dom of this._domains) {
          console.log(`      └─ ${dom}`);
        }
      }
      return { projectName: this.name, subdomain };
    }

    console.log(`   🔄 Deploying assets via Wrangler CLI...`);
    const token = Config.get().providers.cloudflare?.token;

    const args = [
      "-y",
      "wrangler",
      "pages",
      "deploy",
      this._sourcePath,
      `--project-name=${this.name}`,
      `--branch=${this._branch}`,
    ];

    await this.spawnWrangler(args, {
      ...process.env,
      CLOUDFLARE_API_TOKEN: token ?? "",
      CLOUDFLARE_ACCOUNT_ID: accountId,
    });
    console.log(`   ✅ Assets deployed successfully`);

    // 3. Reconcile Custom Domains
    if (this._domains.length > 0) {
      const domainsRes = await api.get<{ result: any[] }>(
        `/accounts/${accountId}/pages/projects/${this.name}/domains`
      );
      const existingDomains = (domainsRes.result ?? []).map((d) => d.name);

      // Add missing domains
      for (const dom of this._domains) {
        if (!existingDomains.includes(dom)) {
          await api.post(`/accounts/${accountId}/pages/projects/${this.name}/domains`, {
            name: dom,
          });
          console.log(`   🚀 Added custom domain: ${dom}`);
        } else {
          console.log(`   ✅ Custom domain "${dom}" is up to date`);
        }
      }

      // Remove unmanaged domains
      for (const existingDom of existingDomains) {
        if (!this._domains.includes(existingDom)) {
          await api.delete(
            `/accounts/${accountId}/pages/projects/${this.name}/domains/${existingDom}`
          );
          console.log(`   🗑️  Removed custom domain: ${existingDom}`);
        }
      }
    }

    return { projectName: this.name, subdomain };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const api = getCloudflareApi();
    const accountId = getCloudflareAccountId();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Cloudflare Pages Project "${this.name}"...`);

    if (!existing) {
      console.log(`   ─  Project "${this.name}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Cloudflare Pages Project "${this.name}"`);
      return { destroyed: this.name };
    }

    await api.delete(`/accounts/${accountId}/pages/projects/${this.name}`);
    console.log(`   🗑️  Removed Cloudflare Pages Project "${this.name}"`);
    return { destroyed: this.name };
  }
}
