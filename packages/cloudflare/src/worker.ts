import { readFileSync } from "node:fs";
import { BaseBuilder } from "@puls-dev/core";
import { Output } from "@puls-dev/core";
import { getCloudflareApi, getCloudflareAccountId, CloudflareApiClient } from "./api.js";
import { KVBuilder } from "./kv.js";
import { R2Builder } from "./r2.js";

async function getZoneIdForPattern(pattern: string, api: CloudflareApiClient): Promise<string> {
  let host = pattern.split("/")[0];
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const possibleZone = parts.slice(i).join(".");
    try {
      const res = await api.get<{ result: any[] }>(`/zones?name=${possibleZone}`);
      if (res.result && res.result.length > 0) {
        return res.result[0].id;
      }
    } catch {
      // Ignore and try next parent domain
    }
  }
  throw new Error(`Could not find Cloudflare DNS Zone for route pattern "${pattern}"`);
}

export class WorkerBuilder extends BaseBuilder {
  private _scriptPath?: string;
  private _routes: string[] = [];
  private _kvs = new Map<string, KVBuilder>();
  private _r2s = new Map<string, R2Builder>();
  private _envs = new Map<string, string | Output<string>>();

  constructor(public scriptName: string) {
    super(scriptName);
  }

  script(filePath: string) {
    this._scriptPath = filePath;
    return this;
  }

  route(pattern: string) {
    this._routes.push(pattern);
    return this;
  }

  kv(bindingName: string, kvNamespace: KVBuilder) {
    this._kvs.set(bindingName, kvNamespace);
    this.dependsOn(kvNamespace);
    return this;
  }

  r2(bindingName: string, r2Bucket: R2Builder) {
    this._r2s.set(bindingName, r2Bucket);
    this.dependsOn(r2Bucket);
    return this;
  }

  env(bindingName: string, value: string | Output<string>) {
    this._envs.set(bindingName, value);
    return this;
  }

  async deploy() {
    if (!this._scriptPath) {
      throw new Error(`Worker script path is not configured for "${this.name}". Call .script("filePath")`);
    }

    const dryRun = this.isDryRunActive();
    const api = getCloudflareApi();
    const accountId = getCloudflareAccountId();

    console.log(`\n⚡ Finalizing Cloudflare Worker "${this.scriptName}"...`);

    const metadata = {
      main_module: "index.js",
      bindings: [] as any[],
    };

    // Resolve KV Bindings
    for (const [binding, kv] of this._kvs.entries()) {
      const kvId = dryRun ? "mock-kv-id" : await kv.out.id.get();
      metadata.bindings.push({
        type: "kv_namespace",
        name: binding,
        namespace_id: kvId,
      });
    }

    // Resolve R2 Bindings
    for (const [binding, r2] of this._r2s.entries()) {
      metadata.bindings.push({
        type: "r2_bucket",
        name: binding,
        bucket_name: r2.bucketName,
      });
    }

    // Resolve Env Bindings
    for (const [binding, val] of this._envs.entries()) {
      const resolvedVal = val instanceof Output ? await val.get() : val;
      metadata.bindings.push({
        type: "plain_text",
        name: binding,
        text: resolvedVal,
      });
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Upload Worker script "${this.scriptName}"`);
      for (const r of this._routes) {
        console.log(`      └─ Route: ${r}`);
      }
      return { scriptName: this.scriptName };
    }

    // Load and build FormData
    const scriptContent = readFileSync(this._scriptPath, "utf8");
    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata));
    form.append(
      "script",
      new Blob([scriptContent], { type: "application/javascript+module" }),
      "index.js"
    );

    await api.put(`/accounts/${accountId}/workers/scripts/${this.scriptName}`, form);
    console.log(`🚀 Uploaded Worker script "${this.scriptName}"`);

    // Reconcile Routes
    for (const pattern of this._routes) {
      const zoneId = await getZoneIdForPattern(pattern, api);
      const routesRes = await api.get<{ result: any[] }>(`/zones/${zoneId}/workers/routes`);
      const existingRoute = (routesRes.result ?? []).find((r) => r.pattern === pattern);

      if (existingRoute) {
        if (existingRoute.script !== this.scriptName) {
          await api.put(`/zones/${zoneId}/workers/routes/${existingRoute.id}`, {
            pattern,
            script: this.scriptName,
          });
          console.log(`   🔄 Updated route ${pattern} → ${this.scriptName}`);
        } else {
          console.log(`   ✅ Route ${pattern} is up to date`);
        }
      } else {
        await api.post(`/zones/${zoneId}/workers/routes`, {
          pattern,
          script: this.scriptName,
        });
        console.log(`   🚀 Created route ${pattern} → ${this.scriptName}`);
      }
    }

    return { scriptName: this.scriptName, routes: this._routes };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const api = getCloudflareApi();
    const accountId = getCloudflareAccountId();

    console.log(`\n🗑️  Destroying Cloudflare Worker "${this.scriptName}"...`);

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Worker script "${this.scriptName}"`);
      return { destroyed: this.scriptName };
    }

    // Clean up routes pointing to this script
    if (this._routes.length > 0) {
      for (const pattern of this._routes) {
        try {
          const zoneId = await getZoneIdForPattern(pattern, api);
          const routesRes = await api.get<{ result: any[] }>(`/zones/${zoneId}/workers/routes`);
          const match = (routesRes.result ?? []).find((r) => r.pattern === pattern && r.script === this.scriptName);
          if (match) {
            await api.delete(`/zones/${zoneId}/workers/routes/${match.id}`);
            console.log(`   🗑️  Removed route ${pattern}`);
          }
        } catch {
          // Ignore if zone or route is already gone
        }
      }
    }

    try {
      await api.delete(`/accounts/${accountId}/workers/scripts/${this.scriptName}`);
      console.log(`   🗑️  Removed Worker script "${this.scriptName}"`);
    } catch (err: any) {
      // Ignore if already deleted
      if (!err.message.includes("404")) throw err;
    }

    await this.destroySidecars();
    return { destroyed: this.scriptName };
  }
}
