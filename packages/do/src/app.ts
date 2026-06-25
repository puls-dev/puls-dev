import { BaseBuilder } from "@puls-dev/core";
import { getDoApi } from "./api.js";
import { Output } from "@puls-dev/core";

export class AppPlatformBuilder extends BaseBuilder {
  readonly out = {
    id: new Output<string>(),
    liveUrl: new Output<string>(),
  };

  private _spec: any = {};

  constructor(appName: string) {
    super(appName);
    this._spec.name = appName;
    this.discoveryPromise = this.discoverApp(appName);
  }

  spec(jsonSpec: any) {
    this._spec = { ...this._spec, ...jsonSpec, name: this.name };
    return this;
  }

  private async discoverApp(name: string): Promise<any> {
    try {
      const api = getDoApi();
      const res = await api.get<{ apps: any[] }>("/apps");
      const match = (res.apps ?? []).find((a) => a.spec?.name === name);
      if (match) {
        this.out.id.resolve(match.id);
        this.out.liveUrl.resolve(match.live_url);
      }
      return match ?? null;
    } catch {
      return null;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getDoApi();

    console.log(`\n🚀 Finalizing DigitalOcean App Platform "${this.name}"...`);

    if (existing) {
      this.out.id.resolve(existing.id);
      this.out.liveUrl.resolve(existing.live_url);

      const hasSpecChange = JSON.stringify(existing.spec) !== JSON.stringify(this._spec);

      if (hasSpecChange) {
        if (dryRun) {
          console.log(`   📝 [PLAN] Update App Platform "${this.name}" with new specification`);
        } else {
          console.log(`   🔄 Updating App Platform "${this.name}" (id=${existing.id})...`);
          const updateRes = await api.put<{ app: any }>(`/apps/${existing.id}`, {
            spec: this._spec,
          });
          console.log(`   ✅ App Platform "${this.name}" updated successfully.`);
          
          this.out.id.resolve(updateRes.app.id);
          this.out.liveUrl.resolve(updateRes.app.live_url);
        }
      } else {
        console.log(`   ✅ App Platform "${this.name}" already exists and configuration is up to date.`);
      }

      return {
        name: this.name,
        id: existing.id,
        liveUrl: existing.live_url,
      };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Create DigitalOcean App Platform "${this.name}"`);
      console.log(`      └─ Region: ${this._spec.region ?? "default"}`);
      if (this._spec.services) {
        console.log(`      └─ Services: ${this._spec.services.map((s: any) => s.name).join(", ")}`);
      }
      if (this._spec.static_sites) {
        console.log(`      └─ Static Sites: ${this._spec.static_sites.map((s: any) => s.name).join(", ")}`);
      }

      this.out.id.resolve("PENDING");
      this.out.liveUrl.resolve(`https://${this.name}.ondigitalocean.app`);
      return { name: this.name, id: "PENDING" };
    }

    console.log(`🚀 Creating DigitalOcean App Platform "${this.name}"...`);
    const createRes = await api.post<{ app: any }>("/apps", {
      spec: this._spec,
    });
    const app = createRes.app;
    console.log(`🚀 App Platform created with ID: ${app.id}`);

    let finalApp = app;
    // Wait for the app deployment to complete and be active
    await this.waitFor(
      `App Platform "${this.name}" to finish deploying`,
      async () => {
        const check = await api.get<{ app: any }>(`/apps/${app.id}`);
        if (check.app) {
          if (check.app.live_url) {
            finalApp = check.app;
            this.out.id.resolve(check.app.id);
            this.out.liveUrl.resolve(check.app.live_url);
            return true;
          }
        }
        return false;
      },
      { intervalMs: 15_000, timeoutMs: 900_000 }
    );

    console.log(`🚀 App Platform deployment complete → ${finalApp.live_url}`);
    return {
      name: this.name,
      id: finalApp.id,
      liveUrl: finalApp.live_url,
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getDoApi();

    console.log(`\n🗑️  Destroying DigitalOcean App Platform "${this.name}"...`);

    if (!existing) {
      console.log(`   ─  App Platform "${this.name}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete App Platform "${this.name}" (id=${existing.id})`);
      return { destroyed: this.name };
    }

    console.log(`   🔄 Deleting App Platform "${this.name}" (id=${existing.id})...`);
    await api.delete(`/apps/${existing.id}`);
    console.log(`   🗑️  Removed App Platform "${this.name}"`);
    return { destroyed: this.name };
  }
}
