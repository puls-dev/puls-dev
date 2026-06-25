import { BaseBuilder } from "@puls-dev/core";
import { ResourceGroupBuilder } from "./resource_group.js";
import { getAzureApi, resolveAzureConfig } from "./api.js";
import { Secret } from "@puls-dev/core";
import { Output } from "@puls-dev/core";

export class AzureSQLBuilder extends BaseBuilder {
  private _resourceGroup?: ResourceGroupBuilder;
  private _location?: string;
  private _databaseName: string = "defaultdb";
  private _sku: string = "Basic";
  private _adminUser?: string;
  private _adminPassword?: string | Output<string> | Secret;

  constructor(public serverName: string) {
    super(serverName);
  }

  resourceGroup(rg: ResourceGroupBuilder) {
    this._resourceGroup = rg;
    this.dependsOn(rg);
    this.discoveryPromise = this.discoverSQL();
    return this;
  }

  location(loc: string) {
    this._location = loc;
    return this;
  }

  database(name: string) {
    this._databaseName = name;
    return this;
  }

  sku(skuName: string) {
    this._sku = skuName;
    return this;
  }

  credentials(user: string, password: string | Output<string> | Secret) {
    this._adminUser = user;
    this._adminPassword = password;
    return this;
  }

  private get rgName(): string {
    if (!this._resourceGroup) {
      throw new Error(`[Azure SQL:${this.name}] .resourceGroup() is required`);
    }
    return this._resourceGroup.groupName;
  }

  private resolveLocation(): string {
    return this._location ?? resolveAzureConfig().defaultLocation ?? "eastus";
  }

  private async discoverSQL(): Promise<any> {
    try {
      const api = getAzureApi();
      const sub = resolveAzureConfig().subscriptionId;
      const server = await api.get<any>(
        `/subscriptions/${sub}/resourceGroups/${this.rgName}/providers/Microsoft.Sql/servers/${this.serverName}`,
        "2021-11-01"
      );
      let database = null;
      try {
        database = await api.get<any>(
          `/subscriptions/${sub}/resourceGroups/${this.rgName}/providers/Microsoft.Sql/servers/${this.serverName}/databases/${this._databaseName}`,
          "2021-11-01"
        );
      } catch (err: any) {
        if (!err.message?.includes("404")) throw err;
      }
      return { server, database };
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
    console.log(`\n🛢️  Finalizing Azure SQL Server & Database for "${this.serverName}"...`);

    let serverExists = !!existing?.server;
    let databaseExists = !!existing?.database;

    if (serverExists) {
      console.log(`   ✅ SQL Server "${this.serverName}" already exists`);
    } else {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create Azure SQL Server "${this.serverName}" (location=${loc})`);
      } else {
        if (!this._adminUser || !this._adminPassword) {
          throw new Error(`[Azure SQL:${this.name}] Admin credentials (.credentials()) are required to create a new SQL Server`);
        }
        const pwd = await Secret.resolve(this._adminPassword);
        await api.put(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Sql/servers/${this.serverName}`,
          {
            location: loc,
            properties: {
              administratorLogin: this._adminUser,
              administratorLoginPassword: pwd,
            },
          },
          "2021-11-01"
        );
        console.log(`🚀 Created SQL Server "${this.serverName}"`);
      }
    }

    if (databaseExists) {
      console.log(`   ✅ SQL Database "${this._databaseName}" already exists`);
    } else {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create SQL Database "${this._databaseName}" under server "${this.serverName}" (sku=${this._sku})`);
      } else {
        await api.put(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Sql/servers/${this.serverName}/databases/${this._databaseName}`,
          {
            location: loc,
            sku: {
              name: this._sku,
              tier: this._sku === "Basic" ? "Basic" : "Standard",
            },
          },
          "2021-11-01"
        );
        console.log(`🚀 Created SQL Database "${this._databaseName}"`);
      }
    }

    await this.deploySidecars();
    return { server: this.serverName, database: this._databaseName };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Azure SQL Server "${this.serverName}"...`);

    if (!existing?.server) {
      console.log(`   ─  SQL Server "${this.serverName}" not found`);
      return { destroyed: false };
    }

    const sub = resolveAzureConfig().subscriptionId;
    const api = getAzureApi();
    const rgName = this.rgName;

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete SQL Server "${this.serverName}" (will delete all databases inside)`);
    } else {
      await api.delete(
        `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Sql/servers/${this.serverName}`,
        "2021-11-01"
      );
      console.log(`   🗑️  Removed SQL Server "${this.serverName}"`);
    }

    await this.destroySidecars();
    return { destroyed: this.serverName };
  }
}
