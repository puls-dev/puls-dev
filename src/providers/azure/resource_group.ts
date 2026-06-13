import { BaseBuilder } from "../../core/resource.js";
import { getAzureApi, resolveAzureConfig } from "./api.js";

export class ResourceGroupBuilder extends BaseBuilder {
  private _location?: string;

  constructor(public groupName: string) {
    super(groupName);
    this.discoveryPromise = this.discoverGroup(groupName);
  }

  location(loc: string) {
    this._location = loc;
    return this;
  }

  private resolveLocation(): string {
    return this._location ?? resolveAzureConfig().defaultLocation ?? "eastus";
  }

  private async discoverGroup(name: string): Promise<any> {
    try {
      const api = getAzureApi();
      return await api.get(`/subscriptions/${resolveAzureConfig().subscriptionId}/resourcegroups/${name}`, "2021-04-01");
    } catch (err: any) {
      if (err.message?.includes("404") || err.message?.includes("ResourceGroupNotFound")) {
        return null;
      }
      throw err;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getAzureApi();
    const sub = resolveAzureConfig().subscriptionId;
    const loc = this.resolveLocation();

    console.log(`\n📦 Finalizing Azure Resource Group "${this.groupName}"...`);

    if (existing) {
      console.log(`   ✅ Resource Group "${this.groupName}" already exists (location=${existing.location})`);
      return { groupName: this.groupName, id: existing.id, location: existing.location };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Create Resource Group "${this.groupName}" in location "${loc}"`);
      return { groupName: this.groupName, id: "PENDING", location: loc };
    }

    const res = await api.put<{ id: string; location: string }>(
      `/subscriptions/${sub}/resourcegroups/${this.groupName}`,
      { location: loc },
      "2021-04-01"
    );

    console.log(`🚀 Created Resource Group "${this.groupName}" in location "${res.location}"`);
    return { groupName: this.groupName, id: res.id, location: res.location };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getAzureApi();
    const sub = resolveAzureConfig().subscriptionId;

    console.log(`\n🗑️  Destroying Azure Resource Group "${this.groupName}"...`);

    if (!existing) {
      console.log(`   ─  Resource Group "${this.groupName}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Resource Group "${this.groupName}"`);
      return { destroyed: this.groupName };
    }

    await api.delete(`/subscriptions/${sub}/resourcegroups/${this.groupName}`, "2021-04-01");
    console.log(`   🗑️  Removed Resource Group "${this.groupName}"`);
    return { destroyed: this.groupName };
  }
}
