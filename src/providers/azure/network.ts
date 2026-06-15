import { BaseBuilder } from "../../core/resource.js";
import { ResourceGroupBuilder } from "./resource_group.js";
import { getAzureApi, resolveAzureConfig } from "./api.js";
import { Output } from "../../core/output.js";

export class AzureNetworkBuilder extends BaseBuilder {
  readonly out = {
    vnetId: new Output<string>(),
    subnetId: new Output<string>(),
    nsgId: new Output<string>(),
  };

  private _resourceGroup?: ResourceGroupBuilder;
  private _location?: string;
  private _addressSpace: string[] = ["10.0.0.0/16"];
  private _subnetName: string = "default";
  private _subnetPrefix: string = "10.0.0.0/24";

  constructor(public vnetName: string) {
    super(vnetName);
  }

  resourceGroup(rg: ResourceGroupBuilder) {
    this._resourceGroup = rg;
    this.dependsOn(rg);
    this.discoveryPromise = this.discoverNetwork();
    return this;
  }

  location(loc: string) {
    this._location = loc;
    return this;
  }

  addressSpace(prefixes: string[]) {
    this._addressSpace = prefixes;
    return this;
  }

  subnet(name: string, prefix: string) {
    this._subnetName = name;
    this._subnetPrefix = prefix;
    return this;
  }

  get rgName(): string {
    if (!this._resourceGroup) {
      throw new Error(`[Azure Network:${this.name}] .resourceGroup() is required`);
    }
    return this._resourceGroup.groupName;
  }

  get nsgName(): string {
    return `${this.vnetName}-nsg`;
  }

  private resolveLocation(): string {
    return this._location ?? resolveAzureConfig().defaultLocation ?? "eastus";
  }

  private async discoverNetwork(): Promise<any> {
    try {
      const api = getAzureApi();
      const sub = resolveAzureConfig().subscriptionId;
      const vnet = await api.get<any>(
        `/subscriptions/${sub}/resourceGroups/${this.rgName}/providers/Microsoft.Network/virtualNetworks/${this.vnetName}`,
        "2020-11-01"
      );
      let nsg = null;
      try {
        nsg = await api.get<any>(
          `/subscriptions/${sub}/resourceGroups/${this.rgName}/providers/Microsoft.Network/networkSecurityGroups/${this.nsgName}`,
          "2020-11-01"
        );
      } catch (err: any) {
        if (!err.message?.includes("404")) throw err;
      }
      return { vnet, nsg };
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
    const rgName = this.rgName;

    const existing = await this.discoveryPromise;
    console.log(`\n🌐 Finalizing Azure Network Topology for "${this.vnetName}"...`);

    const nsgId = `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Network/networkSecurityGroups/${this.nsgName}`;
    const vnetId = `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Network/virtualNetworks/${this.vnetName}`;
    const subnetId = `${vnetId}/subnets/${this._subnetName}`;

    // 1. NSG Creation
    if (existing?.nsg) {
      console.log(`   ✅ Network Security Group "${this.nsgName}" already exists`);
    } else {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create Network Security Group "${this.nsgName}" (allows SSH port 22)`);
      } else {
        await api.put(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Network/networkSecurityGroups/${this.nsgName}`,
          {
            location: loc,
            properties: {
              securityRules: [
                {
                  name: "allow-ssh",
                  properties: {
                    protocol: "Tcp",
                    sourcePortRange: "*",
                    destinationPortRange: "22",
                    sourceAddressPrefix: "*",
                    destinationAddressPrefix: "*",
                    access: "Allow",
                    priority: 1000,
                    direction: "Inbound",
                  },
                },
              ],
            },
          },
          "2020-11-01"
        );
        console.log(`🚀 Created Network Security Group "${this.nsgName}"`);
      }
    }

    // 2. VNet Creation
    if (existing?.vnet) {
      console.log(`   ✅ Virtual Network "${this.vnetName}" already exists`);
    } else {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create Virtual Network "${this.vnetName}" (addressSpace=${this._addressSpace.join(",")}, subnet=${this._subnetName} -> ${this._subnetPrefix})`);
      } else {
        await api.put(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Network/virtualNetworks/${this.vnetName}`,
          {
            location: loc,
            properties: {
              addressSpace: {
                addressPrefixes: this._addressSpace,
              },
              subnets: [
                {
                  name: this._subnetName,
                  properties: {
                    addressPrefix: this._subnetPrefix,
                    networkSecurityGroup: {
                      id: nsgId,
                    },
                  },
                },
              ],
            },
          },
          "2020-11-01"
        );
        console.log(`🚀 Created Virtual Network "${this.vnetName}"`);
      }
    }

    this.out.nsgId.resolve(nsgId);
    this.out.vnetId.resolve(vnetId);
    this.out.subnetId.resolve(subnetId);

    await this.deploySidecars();
    return { vnet: this.vnetName, subnet: this._subnetName, subnetId };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Azure Network Topology "${this.vnetName}"...`);

    const sub = resolveAzureConfig().subscriptionId;
    const api = getAzureApi();
    const rgName = this.rgName;

    // Delete VNet first
    if (existing?.vnet) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Delete Virtual Network "${this.vnetName}"`);
      } else {
        await api.delete(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Network/virtualNetworks/${this.vnetName}`,
          "2020-11-01"
        );
        console.log(`   🗑️  Removed Virtual Network "${this.vnetName}"`);
      }
    } else {
      console.log(`   ─  Virtual Network "${this.vnetName}" not found`);
    }

    // Delete NSG next
    if (existing?.nsg) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Delete Network Security Group "${this.nsgName}"`);
      } else {
        await api.delete(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Network/networkSecurityGroups/${this.nsgName}`,
          "2020-11-01"
        );
        console.log(`   🗑️  Removed Network Security Group "${this.nsgName}"`);
      }
    } else {
      console.log(`   ─  Network Security Group "${this.nsgName}" not found`);
    }

    await this.destroySidecars();
    return { destroyed: this.vnetName };
  }
}
