import { BaseBuilder } from "@puls-dev/core";
import { ResourceGroupBuilder } from "./resource_group.js";
import { getAzureApi, resolveAzureConfig } from "./api.js";

export class BlobStorageBuilder extends BaseBuilder {
  private _resourceGroup?: ResourceGroupBuilder;
  private _location?: string;
  private _sku: string = "Standard_LRS";
  private _containerName: string = "default";

  constructor(public storageAccountName: string) {
    super(storageAccountName);
  }

  resourceGroup(rg: ResourceGroupBuilder) {
    this._resourceGroup = rg;
    this.dependsOn(rg);
    this.discoveryPromise = this.discoverStorage();
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

  containerName(name: string) {
    this._containerName = name;
    return this;
  }

  private get rgName(): string {
    if (!this._resourceGroup) {
      throw new Error(`[Azure BlobStorage:${this.name}] .resourceGroup() is required`);
    }
    return this._resourceGroup.groupName;
  }

  private resolveLocation(): string {
    return this._location ?? resolveAzureConfig().defaultLocation ?? "eastus";
  }

  private async discoverStorage(): Promise<any> {
    try {
      const api = getAzureApi();
      const sub = resolveAzureConfig().subscriptionId;
      const account = await api.get<any>(
        `/subscriptions/${sub}/resourceGroups/${this.rgName}/providers/Microsoft.Storage/storageAccounts/${this.storageAccountName}`,
        "2021-09-01"
      );
      
      let container = null;
      try {
        container = await api.get<any>(
          `/subscriptions/${sub}/resourceGroups/${this.rgName}/providers/Microsoft.Storage/storageAccounts/${this.storageAccountName}/blobServices/default/containers/${this._containerName}`,
          "2021-09-01"
        );
      } catch (err: any) {
        if (!err.message?.includes("404")) throw err;
      }

      return { account, container };
    } catch (err: any) {
      if (err.message?.includes("404") || err.message?.includes("StorageAccountNotFound")) {
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

    // Ensure RG is configured
    const rgName = this.rgName;

    // Await discovery
    const existing = await this.discoveryPromise;

    console.log(`\n🪣  Finalizing Azure Storage Account & Container for "${this.storageAccountName}"...`);

    let accountExists = !!existing?.account;
    let containerExists = !!existing?.container;

    if (accountExists) {
      console.log(`   ✅ Storage Account "${this.storageAccountName}" already exists`);
    } else {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create Azure Storage Account "${this.storageAccountName}" (sku=${this._sku}, location=${loc})`);
      } else {
        await api.put(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Storage/storageAccounts/${this.storageAccountName}`,
          {
            sku: { name: this._sku },
            kind: "StorageV2",
            location: loc
          },
          "2021-09-01"
        );
        console.log(`🚀 Created Storage Account "${this.storageAccountName}"`);
      }
    }

    if (containerExists) {
      console.log(`   ✅ Blob Container "${this._containerName}" already exists`);
    } else {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create Blob Container "${this._containerName}"`);
      } else {
        await api.put(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Storage/storageAccounts/${this.storageAccountName}/blobServices/default/containers/${this._containerName}`,
          {},
          "2021-09-01"
        );
        console.log(`🚀 Created Blob Container "${this._containerName}"`);
      }
    }

    await this.deploySidecars();
    return { storageAccount: this.storageAccountName, container: this._containerName };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Azure Storage Account "${this.storageAccountName}"...`);

    if (!existing?.account) {
      console.log(`   ─  Storage Account "${this.storageAccountName}" not found`);
      return { destroyed: false };
    }

    const sub = resolveAzureConfig().subscriptionId;
    const api = getAzureApi();
    const rgName = this.rgName;

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Storage Account "${this.storageAccountName}" (will delete all containers inside)`);
    } else {
      await api.delete(
        `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Storage/storageAccounts/${this.storageAccountName}`,
        "2021-09-01"
      );
      console.log(`   🗑️  Removed Storage Account "${this.storageAccountName}"`);
    }

    await this.destroySidecars();
    return { destroyed: this.storageAccountName };
  }
}
