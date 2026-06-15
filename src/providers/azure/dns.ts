import { BaseBuilder } from "../../core/resource.js";
import { ResourceGroupBuilder } from "./resource_group.js";
import { getAzureApi, resolveAzureConfig } from "./api.js";
import { Output } from "../../core/output.js";

function getRelativeRecordName(name: string, zoneName: string): string {
  const cleanName = name.replace(/\.$/, "");
  const cleanZone = zoneName.replace(/\.$/, "");
  if (cleanName === cleanZone || cleanName === "@" || cleanName === "") {
    return "@";
  }
  if (cleanName.endsWith("." + cleanZone)) {
    return cleanName.slice(0, cleanName.length - cleanZone.length - 1);
  }
  return cleanName;
}

export class AzureDNSBuilder extends BaseBuilder {
  readonly out = {
    zoneId: new Output<string>(),
  };

  private _resourceGroup?: ResourceGroupBuilder;
  private _location: string = "global";
  private records: any[] = [];

  constructor(public zoneName: string) {
    super(zoneName);
  }

  resourceGroup(rg: ResourceGroupBuilder) {
    this._resourceGroup = rg;
    this.dependsOn(rg);
    this.discoveryPromise = this.discoverZone();
    return this;
  }

  location(loc: string) {
    this._location = loc;
    return this;
  }

  record(name: string, type: "A" | "AAAA" | "CNAME" | "MX" | "TXT", value: any, ttl: number = 300) {
    this.records.push({ name, type, value, ttl });
    return this;
  }

  pointer(name: string, target: any, ttl: number = 300) {
    this.records.push({ name, type: "A", value: target, ttl });
    return this;
  }

  cname(name: string, alias: string, ttl: number = 300) {
    this.records.push({ name, type: "CNAME", value: alias, ttl });
    return this;
  }

  txt(name: string, value: string, ttl: number = 300) {
    this.records.push({ name, type: "TXT", value, ttl });
    return this;
  }

  aaaa(name: string, ip: string, ttl: number = 300) {
    this.records.push({ name, type: "AAAA", value: ip, ttl });
    return this;
  }

  mx(name: string, exchange: string, priority: number, ttl: number = 300) {
    this.records.push({ name, type: "MX", value: { exchange, priority }, ttl });
    return this;
  }

  get rgName(): string {
    if (!this._resourceGroup) {
      throw new Error(`[Azure DNS:${this.name}] .resourceGroup() is required`);
    }
    return this._resourceGroup.groupName;
  }

  private async discoverZone(): Promise<any> {
    try {
      const api = getAzureApi();
      const sub = resolveAzureConfig().subscriptionId;
      const zone = await api.get<any>(
        `/subscriptions/${sub}/resourceGroups/${this.rgName}/providers/Microsoft.Network/dnsZones/${this.zoneName}`,
        "2018-05-01"
      );
      if (zone?.id) {
        this.out.zoneId.resolve(zone.id);
      }
      return zone;
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
    const api = getAzureApi();
    const rgName = this.rgName;

    const existing = await this.discoveryPromise;
    console.log(`\n🗺️  Finalizing Azure DNS Zone "${this.zoneName}"...`);

    const zoneId = `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Network/dnsZones/${this.zoneName}`;

    if (existing) {
      console.log(`   ✅ DNS Zone "${this.zoneName}" already exists`);
    } else {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create Azure DNS Zone "${this.zoneName}"`);
      } else {
        await api.put(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Network/dnsZones/${this.zoneName}`,
          {
            location: this._location,
          },
          "2018-05-01"
        );
        console.log(`🚀 Created DNS Zone "${this.zoneName}"`);
      }
    }

    this.out.zoneId.resolve(zoneId);

    // Deploy record sets
    for (const r of this.records) {
      const relativeName = getRelativeRecordName(r.name, this.zoneName);
      
      // Resolve value if it's Output or Builder
      let val = r.value;
      if (val instanceof Output) {
        val = await val.get();
      } else if (val && typeof val === "object" && val.out) {
        // e.g. target Builder
        const primaryOutput = val.out.ip ?? val.out.id;
        if (primaryOutput instanceof Output) {
          val = await primaryOutput.get();
        }
      }

      let properties: any = { TTL: r.ttl };

      if (r.type === "A") {
        properties.ARecords = [{ ipv4Address: val }];
      } else if (r.type === "AAAA") {
        properties.AAAARecords = [{ ipv6Address: val }];
      } else if (r.type === "CNAME") {
        properties.CNAMERecord = { cname: val };
      } else if (r.type === "TXT") {
        properties.TXTRecords = [{ value: [val] }];
      } else if (r.type === "MX") {
        properties.MXRecords = [{ preference: val.priority, exchange: val.exchange }];
      }

      if (dryRun) {
        console.log(`   📝 [PLAN] Create DNS Record Set "${relativeName}" (${r.type} -> ${JSON.stringify(val)})`);
      } else {
        await api.put(
          `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Network/dnsZones/${this.zoneName}/${r.type}/${relativeName}`,
          {
            properties,
          },
          "2018-05-01"
        );
        console.log(`🚀 Created DNS Record Set "${relativeName}" (${r.type})`);
      }
    }

    await this.deploySidecars();
    return { zone: this.zoneName, recordsCount: this.records.length };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Azure DNS Zone "${this.zoneName}"...`);

    if (!existing) {
      console.log(`   ─  DNS Zone "${this.zoneName}" not found`);
      return { destroyed: false };
    }

    const sub = resolveAzureConfig().subscriptionId;
    const api = getAzureApi();
    const rgName = this.rgName;

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete DNS Zone "${this.zoneName}" (will delete all records inside)`);
    } else {
      await api.delete(
        `/subscriptions/${sub}/resourceGroups/${rgName}/providers/Microsoft.Network/dnsZones/${this.zoneName}`,
        "2018-05-01"
      );
      console.log(`   🗑️  Removed DNS Zone "${this.zoneName}"`);
    }

    await this.destroySidecars();
    return { destroyed: this.zoneName };
  }
}
