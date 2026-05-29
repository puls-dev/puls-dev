import { BaseBuilder } from "../../core/resource.js";
import { Output } from "../../core/output.js";
import { DropletBuilder } from "./droplet.js";
import { CertificateBuilder } from "./certificate.js";
import { getDoApi } from "./api.js";
import { loadRecordsFromFile } from "../../core/parser.js";

export interface DNSRecord {
  type: "A" | "CNAME" | "TXT" | "MX" | "AAAA" | "SRV" | "CAA";
  name: string;
  value: string | DropletBuilder | Output<string>;
  priority?: number;
  port?: number;
  weight?: number;
  flags?: number;
  tag?: string;
}

export class DomainBuilder extends BaseBuilder {
  private records: DNSRecord[] = [];

  constructor(public domainName: string) {
    super(domainName);
    this.discoveryPromise = this.discoverDomain(domainName);
  }

  private async discoverDomain(name: string): Promise<any> {
    const api = getDoApi();
    try {
      return await api
        .get<{ domain: any }>(`/domains/${name}`)
        .then((d) => d.domain);
    } catch {
      return null;
    }
  }

  withSSL() {
    const cert = new CertificateBuilder(this.domainName);
    this.sidecars.push(cert);
    return this;
  }

  record(filePath: string): this;
  record(
    name: string,
    type: DNSRecord["type"],
    value: string | DropletBuilder | Output<string>,
    ttl?: number,
    priority?: number,
    port?: number,
    weight?: number,
    flags?: number,
    tag?: string
  ): this;
  record(
    nameOrPath: string,
    type?: DNSRecord["type"],
    value?: string | DropletBuilder | Output<string>,
    ttl?: number,
    priority?: number,
    port?: number,
    weight?: number,
    flags?: number,
    tag?: string
  ) {
    if (arguments.length === 1 && typeof nameOrPath === "string" && (nameOrPath.endsWith(".yaml") || nameOrPath.endsWith(".yml") || nameOrPath.endsWith(".json"))) {
      const loaded = loadRecordsFromFile(nameOrPath);
      for (const r of loaded) {
        this.records.push({
          name: r.name,
          type: r.type,
          value: r.value,
          priority: r.priority,
          port: r.port,
          weight: r.weight,
          flags: r.flags,
          tag: r.tag,
        });
      }
      return this;
    }
    this.records.push({
      name: nameOrPath,
      type: type!,
      value: value!,
      priority,
      port,
      weight,
      flags,
      tag,
    });
    return this;
  }

  pointer(name: string, target: DropletBuilder | Output<string> | string) {
    this.records.push({ type: "A", name, value: target });
    return this;
  }

  cname(name: string, target: string) {
    this.records.push({ type: "CNAME", name, value: target });
    return this;
  }

  aaaa(name: string, target: string | Output<string>) {
    this.records.push({ type: "AAAA", name, value: target });
    return this;
  }

  txt(name: string, target: string) {
    this.records.push({ type: "TXT", name, value: target });
    return this;
  }

  mx(name: string, target: string, priority: number = 10) {
    this.records.push({ type: "MX", name, value: target, priority });
    return this;
  }

  srv(name: string, target: string, port: number, priority: number = 10, weight: number = 10) {
    this.records.push({ type: "SRV", name, value: target, port, priority, weight });
    return this;
  }

  caa(name: string, tag: string, target: string, flags: number = 0) {
    this.records.push({ type: "CAA", name, value: target, tag, flags });
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getDoApi();

    console.log(`\n🌐 Finalizing DNS for "${this.domainName}"...`);

    if (!existing) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create domain ${this.domainName}`);
      } else {
        await api.post("/domains", { name: this.domainName });
        console.log(`🚀 Created domain ${this.domainName}`);
      }
    }

    // Fetch existing records in a single batch
    let existingRecords: any[] = [];
    if (existing) {
      try {
        const res = await api.get<{ domain_records: any[] }>(
          `/domains/${this.domainName}/records?per_page=200`
        );
        existingRecords = res.domain_records;
      } catch {
        existingRecords = [];
      }
    }

    // Track matched existing records
    const consumedRecordIds = new Set<number>();

    for (const record of this.records) {
      let data: string;

      if (record.value instanceof Output) {
        data = await record.value.get();
      } else if (record.value instanceof DropletBuilder) {
        data =
          (await record.value.getPublicIp()) ??
          `[IP of ${record.value.name} - not found]`;
      } else {
        data = record.value;
      }

      const targetPriority = record.priority ?? null;
      const targetPort = record.port ?? null;
      const targetWeight = record.weight ?? null;
      const targetFlags = record.flags ?? null;
      const targetTag = record.tag ?? null;

      // 1. Check for a perfect match
      const perfectMatch = existingRecords.find((r) => {
        if (consumedRecordIds.has(r.id)) return false;
        return (
          r.type === record.type &&
          r.name === record.name &&
          String(r.data) === String(data) &&
          (r.priority ?? null) === targetPriority &&
          (r.port ?? null) === targetPort &&
          (r.weight ?? null) === targetWeight &&
          (r.flags ?? null) === targetFlags &&
          (r.tag ?? null) === targetTag
        );
      });

      if (perfectMatch) {
        consumedRecordIds.add(perfectMatch.id);
        console.log(
          `   ✅ ${record.type} ${record.name}.${this.domainName} is up to date (→ ${data})`
        );
        continue;
      }

      // 2. Look for updateable match (same type and name, different data)
      const updateableMatch = existingRecords.find((r) => {
        if (consumedRecordIds.has(r.id)) return false;
        return r.type === record.type && r.name === record.name;
      });

      if (updateableMatch) {
        consumedRecordIds.add(updateableMatch.id);
        if (dryRun) {
          console.log(
            `   📝 [PLAN] Update ${record.type} ${record.name}.${this.domainName} → ${data} (was ${updateableMatch.data})`
          );
        } else {
          await api.put(`/domains/${this.domainName}/records/${updateableMatch.id}`, {
            type: record.type,
            name: record.name,
            data,
            ttl: 3600,
            priority: targetPriority,
            port: targetPort,
            weight: targetWeight,
            flags: targetFlags,
            tag: targetTag,
          });
          console.log(
            `   🔄 Updated ${record.type} ${record.name}.${this.domainName} → ${data}`
          );
        }
      } else {
        // 3. No match found, create a new record
        if (dryRun) {
          console.log(
            `   📝 [PLAN] Create ${record.type} ${record.name}.${this.domainName} → ${data}`
          );
        } else {
          await api.post(`/domains/${this.domainName}/records`, {
            type: record.type,
            name: record.name,
            data,
            ttl: 3600,
            priority: targetPriority,
            port: targetPort,
            weight: targetWeight,
            flags: targetFlags,
            tag: targetTag,
          });
          console.log(
            `   🚀 Created ${record.type} ${record.name}.${this.domainName} → ${data}`
          );
        }
      }
    }

    // 4. Delete duplicate/stale records of the types we declared
    const declaredTypesAndNames = new Set(
      this.records.map((r) => `${r.type}:${r.name}`)
    );
    for (const r of existingRecords) {
      if (consumedRecordIds.has(r.id)) continue;
      if (declaredTypesAndNames.has(`${r.type}:${r.name}`)) {
        if (dryRun) {
          console.log(
            `   📝 [PLAN] Delete stale ${r.type} ${r.name}.${this.domainName} (→ ${r.data})`
          );
        } else {
          await api.delete(`/domains/${this.domainName}/records/${r.id}`);
          console.log(
            `   🗑️  Deleted stale ${r.type} ${r.name}.${this.domainName}`
          );
        }
      }
    }

    await this.deploySidecars();
    return { domain: this.domainName, records: this.records };
  }

  async destroy(): Promise<any> {
    const dryRun = this.isDryRunActive();
    await this.discoveryPromise;

    console.log(`\n🗑️  Destroying DNS domain "${this.domainName}"...`);

    if (dryRun) {
      console.log(`   📝 [PLAN] Would delete domain ${this.domainName}`);
    } else {
      const api = getDoApi();
      await api.delete(`/domains/${this.domainName}`);
      console.log(`   ✅ Deleted.`);
    }

    await this.destroySidecars();
    return { destroyed: this.domainName };
  }
}
