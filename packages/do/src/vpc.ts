import { BaseBuilder } from "@puls-dev/core";
import { getDoApi } from "./api.js";
import { Output } from "@puls-dev/core";

export class VPCBuilder extends BaseBuilder {
  readonly out = {
    id: new Output<string>(),
    ipRange: new Output<string>(),
  };

  private _region: string = "nyc3";
  private _ipRange?: string;
  private _description?: string;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverVpc(name);
  }

  region(r: string) {
    this._region = r;
    this.discoveryPromise = this.discoverVpc(this.name);
    return this;
  }

  ipRange(cidr: string) {
    this._ipRange = cidr;
    return this;
  }

  description(text: string) {
    this._description = text;
    return this;
  }

  getDiff(existing: any) {
    const diffs = [];
    // region and ip_range are immutable after creation
    if (this._description !== undefined && existing.description !== this._description) {
      diffs.push({ field: "description", declared: this._description, live: existing.description });
    }
    return diffs;
  }

  private async discoverVpc(name: string): Promise<any> {
    try {
      const api = getDoApi();
      const res = await api.get<{ vpcs: any[] }>("/vpcs?per_page=200");
      const match = (res.vpcs ?? []).find((vpc) => vpc.name === name);
      if (match) {
        this.out.id.resolve(match.id);
        this.out.ipRange.resolve(match.ip_range);
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

    console.log(`\n🌐 Finalizing DigitalOcean VPC "${this.name}"...`);

    if (existing) {
      console.log(`   ✅ VPC "${this.name}" already exists (id=${existing.id}, ipRange=${existing.ip_range}).`);
      this.out.id.resolve(existing.id);
      this.out.ipRange.resolve(existing.ip_range);

      const hasDescriptionChange = this._description !== undefined && existing.description !== this._description;

      if (hasDescriptionChange) {
        if (dryRun) {
          console.log(`   📝 [PLAN] Update VPC description → "${this._description}"`);
        } else {
          await api.put(`/vpcs/${existing.id}`, {
            name: this.name,
            description: this._description,
          });
          console.log(`   ✅ VPC description updated.`);
        }
      }

      return {
        name: this.name,
        id: existing.id,
        ipRange: existing.ip_range,
      };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Create DigitalOcean VPC "${this.name}" (${this._region})`);
      if (this._ipRange) {
        console.log(`      └─ Custom IP Range: ${this._ipRange}`);
      }
      if (this._description) {
        console.log(`      └─ Description: ${this._description}`);
      }

      this.out.id.resolve("PENDING");
      this.out.ipRange.resolve(this._ipRange || "10.10.10.0/20");

      return { name: this.name, id: "PENDING" };
    }

    console.log(`🚀 Creating DigitalOcean VPC "${this.name}"...`);
    const body: any = {
      name: this.name,
      region: this._region,
    };
    if (this._ipRange) {
      body.ip_range = this._ipRange;
    }
    if (this._description) {
      body.description = this._description;
    }

    const createRes = await api.post<{ vpc: any }>("/vpcs", body);
    const vpc = createRes.vpc;

    console.log(`🚀 VPC created with ID: ${vpc.id}`);
    this.out.id.resolve(vpc.id);
    this.out.ipRange.resolve(vpc.ip_range);

    return {
      name: this.name,
      id: vpc.id,
      ipRange: vpc.ip_range,
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getDoApi();

    console.log(`\n🗑️  Destroying DigitalOcean VPC "${this.name}"...`);

    if (!existing) {
      console.log(`   ─  VPC "${this.name}" not found`);
      return { destroyed: false };
    }

    if (existing.default) {
      console.log(`   ⏭️  [SKIP] Cannot delete the default VPC "${this.name}"`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete VPC "${this.name}" (id=${existing.id})`);
      return { destroyed: this.name };
    }

    console.log(`   🔄 Deleting VPC "${this.name}" (id=${existing.id})...`);
    await api.delete(`/vpcs/${existing.id}`);
    console.log(`   🗑️  Removed VPC "${this.name}"`);
    return { destroyed: this.name };
  }
}
