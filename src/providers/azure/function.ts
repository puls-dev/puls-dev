import { BaseBuilder } from "../../core/resource.js";
import { ResourceGroupBuilder } from "./resource_group.js";
import { BlobStorageBuilder } from "./blob_storage.js";
import { getAzureApi, resolveAzureConfig } from "./api.js";
import { Output } from "../../core/output.js";

export class AzureFunctionBuilder extends BaseBuilder {
  readonly out = {
    defaultHostName: new Output<string>(),
  };

  private _resourceGroup?: ResourceGroupBuilder;
  private _storageAccount?: BlobStorageBuilder;
  private _location?: string;
  private _runtime: string = "node";
  private _planName?: string;
  private _env: Record<string, string> = {};

  constructor(public appName: string) {
    super(appName);
  }

  resourceGroup(rg: ResourceGroupBuilder) {
    this._resourceGroup = rg;
    this.dependsOn(rg);
    this.discoveryPromise = this.discoverFunction();
    return this;
  }

  storage(storage: BlobStorageBuilder) {
    this._storageAccount = storage;
    this.dependsOn(storage);
    return this;
  }

  location(loc: string) {
    this._location = loc;
    return this;
  }

  runtime(run: string) {
    this._runtime = run;
    return this;
  }

  planName(name: string) {
    this._planName = name;
    return this;
  }

  env(key: string, value: string) {
    this._env[key] = value;
    return this;
  }

  get rgName(): string {
    if (!this._resourceGroup) {
      throw new Error(`[Azure Function:${this.name}] .resourceGroup() is required`);
    }
    return this._resourceGroup.groupName;
  }

  get plan(): string {
    return this._planName ?? `plan-${this.appName}`;
  }

  private resolveLocation(): string {
    return this._location ?? resolveAzureConfig().defaultLocation ?? "eastus";
  }

  private async discoverFunction(): Promise<any> {
    try {
      const api = getAzureApi();
      const sub = resolveAzureConfig().subscriptionId;
      const plan = await api.get<any>(
        `/subscriptions/${sub}/resourceGroups/${this.rgName}/providers/Microsoft.Web/serverfarms/${this.plan}`,
        "2021-02-01"
      );
      const app = await api.get<any>(
        `/subscriptions/${sub}/resourceGroups/${this.rgName}/providers/Microsoft.Web/sites/${this.appName}`,
        "2021-02-01"
      );
      if (app?.properties?.defaultHostName) {
        this.out.defaultHostName.resolve(app.properties.defaultHostName);
      }
      return { plan, app };
    } catch (err: any) {
      if (err.message?.includes("404")) return null;
      throw err;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const sub = resolveAzureConfig().subscriptionId;
    const loc = this.resolveLocation();
    const api = getAzureApi();
    const rgName = this.rgName;

    if (!this._storageAccount) {
      throw new Error(`[Azure Function:${this.name}] .storage() is required to bind a Storage Account`);
    }
    const storageName = this._storageAccount.storageAccountName;

    const existing = await this.discoveryPromise;
    console.log(`\n⚡ Finalizing Azure Function App for "${this.appName}"...`);

    // 1. Deploy App Service Plan (Consumption Plan)
    if (existing?.plan) {
      console.log(`   ✅ App Service Plan "${this.plan}" already exists`);
    } else {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create App Service Plan "${this.plan}" (Sku=Y1, Tier=Dynamic)`);
      } else {
        await api.put(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Web/serverfarms/${this.plan}`,
          {
            location: loc,
            sku: {
              name: "Y1",
              tier: "Dynamic",
            },
            properties: {
              reserved: true, // required for Linux consumption
            },
          },
          "2021-02-01"
        );
        console.log(`🚀 Created App Service Plan "${this.plan}"`);
      }
    }

    // 2. Fetch Storage Account Connection String
    let storageConnString = "mock-storage-connection-string";
    if (!dryRun) {
      try {
        const keysRes = await api.post<any>(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Storage/storageAccounts/${storageName}/listKeys`,
          {},
          "2021-09-01"
        );
        const key = keysRes.keys?.[0]?.value ?? "mock-key";
        storageConnString = `DefaultEndpointsProtocol=https;AccountName=${storageName};AccountKey=${key};EndpointSuffix=core.windows.net`;
      } catch (err) {
        console.log(`   ⚠️ Warning: failed to fetch storage account keys: ${err}`);
      }
    }

    // 3. Deploy Function App site
    let defaultHost = "pending-host.azurewebsites.net";
    if (existing?.app) {
      console.log(`   ✅ Function App "${this.appName}" already exists`);
      defaultHost = existing.app.properties.defaultHostName;
    } else {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create Function App "${this.appName}" (runtime=${this._runtime})`);
      } else {
        const appSettings = [
          { name: "AzureWebJobsStorage", value: storageConnString },
          { name: "FUNCTIONS_WORKER_RUNTIME", value: this._runtime },
          { name: "FUNCTIONS_EXTENSION_VERSION", value: "~4" },
          ...Object.entries(this._env).map(([k, v]) => ({ name: k, value: v })),
        ];

        const appRes = await api.put<any>(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Web/sites/${this.appName}`,
          {
            location: loc,
            kind: "functionapp,linux",
            properties: {
              serverFarmId: `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Web/serverfarms/${this.plan}`,
              siteConfig: {
                appSettings,
              },
            },
          },
          "2021-02-01"
        );
        defaultHost = appRes.properties?.defaultHostName ?? defaultHost;
        console.log(`🚀 Created Function App "${this.appName}"`);
      }
    }

    this.out.defaultHostName.resolve(defaultHost);

    await this.deploySidecars();
    return { appName: this.appName, defaultHostName: defaultHost };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Azure Function App "${this.appName}"...`);

    if (!existing?.app) {
      console.log(`   ─  Function App "${this.appName}" not found`);
      return { destroyed: false };
    }

    const sub = resolveAzureConfig().subscriptionId;
    const api = getAzureApi();
    const rgName = this.rgName;

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Function App "${this.appName}" and App Service Plan "${this.plan}"`);
    } else {
      await api.delete(
        `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Web/sites/${this.appName}`,
        "2021-02-01"
      );
      console.log(`   🗑️  Removed Function App "${this.appName}"`);

      try {
        await api.delete(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Web/serverfarms/${this.plan}`,
          "2021-02-01"
        );
        console.log(`   🗑️  Removed App Service Plan "${this.plan}"`);
      } catch {}
    }

    await this.destroySidecars();
    return { destroyed: this.appName };
  }
}
