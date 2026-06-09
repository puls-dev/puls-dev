import { BaseBuilder } from "../../core/resource.js";
import { Output } from "../../core/output.js";
import { getCloudflareApi, getCloudflareAccountId } from "./api.js";
import { loadRecordsFromFile } from "../../core/parser.js";

export interface CFDNSRecord {
  type: "A" | "CNAME" | "TXT" | "MX" | "AAAA" | "SRV" | "CAA";
  name: string;
  value: string | BaseBuilder | Output<string>;
  ttl?: number;
  priority?: number;
  port?: number;
  weight?: number;
  flags?: number;
  tag?: string;
  proxied?: boolean;
}

function getFullRecordName(name: string, zone: string): string {
  const cleanName = name.trim();
  if (cleanName === "" || cleanName === "@") return zone;
  if (cleanName.endsWith(zone)) return cleanName;
  return `${cleanName}.${zone}`;
}

export class ZoneBuilder extends BaseBuilder {
  readonly out = {
    id: new Output<string>(),
  };

  resolvedId: string | null = null;
  private records: CFDNSRecord[] = [];

  constructor(public domainName: string) {
    super(domainName);
    this.discoveryPromise = this.discoverZone(domainName);
  }

  private async discoverZone(name: string): Promise<any> {
    try {
      const api = getCloudflareApi();
      const res = await api.get<{ result: any[] }>(`/zones?name=${name}`);
      return (res.result ?? []).find((z) => z.name === name) ?? null;
    } catch {
      return null;
    }
  }

  record(filePath: string): this;
  record(
    name: string,
    type: CFDNSRecord["type"],
    value: string | BaseBuilder | Output<string>,
    ttl?: number,
    priority?: number,
    port?: number,
    weight?: number,
    flags?: number,
    tag?: string,
    proxied?: boolean
  ): this;
  record(
    nameOrPath: string,
    type?: CFDNSRecord["type"],
    value?: string | BaseBuilder | Output<string>,
    ttl?: number,
    priority?: number,
    port?: number,
    weight?: number,
    flags?: number,
    tag?: string,
    proxied?: boolean
  ) {
    if (
      arguments.length === 1 &&
      typeof nameOrPath === "string" &&
      (nameOrPath.endsWith(".yaml") || nameOrPath.endsWith(".yml") || nameOrPath.endsWith(".json"))
    ) {
      const loaded = loadRecordsFromFile(nameOrPath);
      for (const r of loaded) {
        this.records.push({
          name: r.name,
          type: r.type as any,
          value: r.value,
          ttl: r.ttl,
          priority: r.priority,
          port: r.port,
          weight: r.weight,
          flags: r.flags,
          tag: r.tag,
          proxied: r.proxied,
        });
      }
      return this;
    }

    this.records.push({
      name: nameOrPath,
      type: type!,
      value: value!,
      ttl,
      priority,
      port,
      weight,
      flags,
      tag,
      proxied,
    });
    return this;
  }

  pointer(name: string, target: BaseBuilder | Output<string> | string, proxied?: boolean) {
    this.records.push({ type: "A", name, value: target, proxied });
    return this;
  }

  cname(name: string, target: string, proxied?: boolean) {
    this.records.push({ type: "CNAME", name, value: target, proxied });
    return this;
  }

  aaaa(name: string, target: string | Output<string>, proxied?: boolean) {
    this.records.push({ type: "AAAA", name, value: target, proxied });
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
    const api = getCloudflareApi();

    console.log(`\n🌐 Finalizing DNS Zone for "${this.domainName}"...`);

    if (existing) {
      this.resolvedId = existing.id;
      this.out.id.resolve(existing.id);
      console.log(`   ✅ Zone "${this.domainName}" exists (id=${existing.id})`);
    } else {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create Cloudflare Zone "${this.domainName}"`);
        this.resolvedId = "PENDING";
        this.out.id.resolve("PENDING");
      } else {
        const accountId = getCloudflareAccountId();
        const res = await api.post<{ result: { id: string } }>("/zones", {
          name: this.domainName,
          account: { id: accountId },
          type: "full",
        });
        this.resolvedId = res.result.id;
        this.out.id.resolve(this.resolvedId);
        console.log(`🚀 Created Cloudflare Zone "${this.domainName}" (id=${this.resolvedId})`);
      }
    }

    let existingRecords: any[] = [];
    if (existing && !dryRun) {
      try {
        const res = await api.get<{ result: any[] }>(`/zones/${this.resolvedId}/dns_records?per_page=100`);
        existingRecords = res.result ?? [];
      } catch {
        existingRecords = [];
      }
    }

    const consumedRecordIds = new Set<string>();

    for (const record of this.records) {
      let data: string;

      if (record.value instanceof Output) {
        data = await record.value.get();
      } else if (record.value && typeof record.value === "object" && "out" in record.value) {
        const out = (record.value as any).out;
        if (out && out.ip instanceof Output) {
          data = await out.ip.get();
        } else if (out && out.publicIp instanceof Output) {
          data = await out.publicIp.get();
        } else {
          data = String(record.value);
        }
      } else if (record.value instanceof BaseBuilder) {
        if (typeof (record.value as any).getPublicIp === "function") {
          data = await (record.value as any).getPublicIp();
        } else {
          data = String(record.value);
        }
      } else {
        data = String(record.value);
      }

      const targetFullName = getFullRecordName(record.name, this.domainName);
      const targetTtl = record.ttl ?? 3600;
      const targetProxied = !!record.proxied;

      // Match logic helper
      const isMatch = (r: any) => {
        if (r.type !== record.type || r.name !== targetFullName) return false;

        if (record.type === "MX") {
          return r.content === data && (r.priority ?? 10) === (record.priority ?? 10);
        }
        if (record.type === "SRV") {
          return (
            r.data?.target === data &&
            r.data?.port === (record.port ?? 5060) &&
            r.data?.priority === (record.priority ?? 10) &&
            r.data?.weight === (record.weight ?? 10)
          );
        }
        if (record.type === "CAA") {
          return (
            r.data?.value === data &&
            r.data?.tag === (record.tag ?? "issue") &&
            r.data?.flags === (record.flags ?? 0)
          );
        }
        return r.content === data && !!r.proxied === targetProxied;
      };

      const perfectMatch = existingRecords.find((r) => !consumedRecordIds.has(r.id) && isMatch(r));

      if (perfectMatch) {
        consumedRecordIds.add(perfectMatch.id);
        console.log(`   ✅ ${record.type} ${targetFullName} is up to date (→ ${data})`);
        continue;
      }

      const updateableMatch = existingRecords.find(
        (r) => !consumedRecordIds.has(r.id) && r.type === record.type && r.name === targetFullName
      );

      // Construct payload
      const payload: any = {
        type: record.type,
        name: record.name,
        ttl: targetTtl,
      };

      if (record.type === "MX") {
        payload.content = data;
        payload.priority = record.priority ?? 10;
      } else if (record.type === "SRV") {
        payload.data = {
          priority: record.priority ?? 10,
          weight: record.weight ?? 10,
          port: record.port ?? 5060,
          target: data,
        };
      } else if (record.type === "CAA") {
        payload.data = {
          flags: record.flags ?? 0,
          tag: record.tag ?? "issue",
          value: data,
        };
      } else {
        payload.content = data;
        payload.proxied = targetProxied;
      }

      if (updateableMatch) {
        consumedRecordIds.add(updateableMatch.id);
        if (dryRun) {
          console.log(`   📝 [PLAN] Update ${record.type} ${targetFullName} → ${data}`);
        } else {
          await api.put(`/zones/${this.resolvedId}/dns_records/${updateableMatch.id}`, payload);
          console.log(`   🔄 Updated ${record.type} ${targetFullName} → ${data}`);
        }
      } else {
        if (dryRun) {
          console.log(`   📝 [PLAN] Create ${record.type} ${targetFullName} → ${data}`);
        } else {
          await api.post(`/zones/${this.resolvedId}/dns_records`, payload);
          console.log(`   🚀 Created ${record.type} ${targetFullName} → ${data}`);
        }
      }
    }

    // Purge stale
    const declaredKeySet = new Set(this.records.map((r) => `${r.type}:${getFullRecordName(r.name, this.domainName)}`));
    for (const r of existingRecords) {
      if (consumedRecordIds.has(r.id)) continue;
      if (declaredKeySet.has(`${r.type}:${r.name}`)) {
        if (dryRun) {
          console.log(`   📝 [PLAN] Delete stale ${r.type} ${r.name}`);
        } else {
          await api.delete(`/zones/${this.resolvedId}/dns_records/${r.id}`);
          console.log(`   🗑️  Deleted stale ${r.type} ${r.name}`);
        }
      }
    }

    await this.deploySidecars();
    return { zone: this.domainName, zoneId: this.resolvedId };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getCloudflareApi();

    console.log(`\n🗑️  Destroying Cloudflare DNS Zone "${this.domainName}"...`);

    if (!existing) {
      console.log(`   ─  Zone "${this.domainName}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Cloudflare Zone "${this.domainName}" (id=${existing.id})`);
      return { destroyed: this.domainName };
    }

    await api.delete(`/zones/${existing.id}`);
    console.log(`   🗑️  Removed Cloudflare Zone "${this.domainName}" (id=${existing.id})`);
    await this.destroySidecars();
    return { destroyed: this.domainName };
  }
}
