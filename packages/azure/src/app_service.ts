import { BaseBuilder } from "@puls-dev/core";
import { ResourceGroupBuilder } from "./resource_group.js";
import { getAzureApi, resolveAzureConfig } from "./api.js";

export class AppServiceBuilder extends BaseBuilder {
  private _resourceGroup?: ResourceGroupBuilder;
  private _location?: string;
  private _sku: string = "B1";
  private _planName?: string;
  private _runtime: string = "NODE|18-lts"; // default Linux FX version

  constructor(public appName: string) {
    super(appName);
  }

  resourceGroup(rg: ResourceGroupBuilder) {
    this._resourceGroup = rg;
    this.dependsOn(rg);
    this.discoveryPromise = this.discoverAppService();
    return this;
  }

  location(loc: string) {
    this._location = loc;
    return this;
  }

  sku(skuName: string) {
    this._sku = skuName;
    return this;
  }

  planName(name: string) {
    this._planName = name;
    return this;
  }

  runtime(rt: string) {
    this._runtime = rt;
    return this;
  }

  private get rgName(): string {
    if (!this._resourceGroup) {
      throw new Error(`[Azure AppService:${this.name}] .resourceGroup() is required`);
    }
    return this._resourceGroup.groupName;
  }

  private get plan(): string {
    return this._planName ?? `plan-${this.appName}`;
  }

  private resolveLocation(): string {
    return this._location ?? resolveAzureConfig().defaultLocation ?? "eastus";
  }

  private async discoverAppService(): Promise<any> {
    try {
      const api = getAzureApi();
      const sub = resolveAzureConfig().subscriptionId;
      const rg = this.rgName;

      let planData = null;
      try {
        planData = await api.get<any>(
          `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${this.plan}`,
          "2021-02-01"
        );
      } catch (err: any) {
        if (!err.message?.includes("404")) throw err;
      }

      let appData = null;
      try {
        appData = await api.get<any>(
          `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${this.appName}`,
          "2021-02-01"
        );
      } catch (err: any) {
        if (!err.message?.includes("404")) throw err;
      }

      return { plan: planData, app: appData };
    } catch (err: any) {
      if (err.message?.includes("404")) {
        return null;
      }
      throw err;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const sub = resolveAzureConfig().subscriptionId;
    const loc = this.resolveLocation();
    const api = getAzureApi();
    const rg = this.rgName;
    const pName = this.plan;

    // Await discovery
    const existing = await this.discoveryPromise;

    console.log(`\n🌐 Finalizing Azure App Service for "${this.appName}"...`);

    let planId = existing?.plan?.id;

    // 1. Reconcile Plan
    if (existing?.plan) {
      console.log(`   ✅ App Service Plan "${pName}" already exists`);
    } else {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create App Service Plan "${pName}" (sku=${this._sku}, location=${loc})`);
        planId = `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${pName}`;
      } else {
        const planRes = await api.put<any>(
          `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${pName}`,
          {
            location: loc,
            sku: { name: this._sku, tier: this._sku === "F1" ? "Free" : "Basic" },
            kind: "linux",
            properties: { reserved: true } // required for Linux App Service Plans
          },
          "2021-02-01"
        );
        planId = planRes.id;
        console.log(`🚀 Created App Service Plan "${pName}"`);
      }
    }

    // 2. Reconcile Web App
    let result: { appName: string; defaultHostName: string };

    if (existing?.app) {
      console.log(`   ✅ App Service Web App "${this.appName}" already exists`);
      result = { appName: this.appName, defaultHostName: existing.app.properties.defaultHostName };
    } else if (dryRun) {
      console.log(`   📝 [PLAN] Create Web App "${this.appName}" (runtime=${this._runtime}, plan=${pName})`);
      result = { appName: this.appName, defaultHostName: "PENDING" };
    } else {
      const appRes = await api.put<any>(
        `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${this.appName}`,
        {
          location: loc,
          properties: {
            serverFarmId: planId,
            siteConfig: {
              linuxFxVersion: this._runtime
            }
          }
        },
        "2021-02-01"
      );
      console.log(`🚀 Created App Service Web App "${this.appName}" (URL: https://${appRes.properties.defaultHostName})`);
      result = { appName: this.appName, defaultHostName: appRes.properties.defaultHostName };
    }

    await this.deploySidecars();
    return result;
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Azure App Service "${this.appName}"...`);

    if (!existing?.app && !existing?.plan) {
      console.log(`   ─  App Service "${this.appName}" not found`);
      return { destroyed: false };
    }

    const sub = resolveAzureConfig().subscriptionId;
    const api = getAzureApi();
    const rg = this.rgName;
    const pName = this.plan;

    if (existing?.app) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Delete Web App "${this.appName}"`);
      } else {
        await api.delete(
          `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${this.appName}`,
          "2021-02-01"
        );
        console.log(`   🗑️  Removed Web App "${this.appName}"`);
      }
    }

    if (existing?.plan) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Delete App Service Plan "${pName}"`);
      } else {
        await api.delete(
          `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${pName}`,
          "2021-02-01"
        );
        console.log(`   🗑️  Removed App Service Plan "${pName}"`);
      }
    }

    await this.destroySidecars();
    return { destroyed: this.appName };
  }
}
