import { BaseBuilder } from "@puls-dev/core";
import { Output } from "@puls-dev/core";
import { gcpFetch, getProjectId } from "./api.js";
import { loadRecordsFromFile } from "@puls-dev/core";

const DNS_BASE = "https://dns.googleapis.com";

function cleanZoneId(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatRecordName(name: string, zoneDnsName: string): string {
  const cleanZone = zoneDnsName.endsWith(".") ? zoneDnsName : `${zoneDnsName}.`;
  if (!name || name === "@") {
    return cleanZone;
  }
  if (name.endsWith(cleanZone)) {
    return name;
  }
  if (name.endsWith(cleanZone.slice(0, -1))) {
    return `${name}.`;
  }
  const cleanName = name.endsWith(".") ? name.slice(0, -1) : name;
  return `${cleanName}.${cleanZone}`;
}

export interface GCPDNSRecord {
  name: string;
  type: string;
  value: any;
  ttl: number;
}

export class GCPCloudDNSZoneBuilder extends BaseBuilder {
  readonly out = {
    zone: new Output<{ name: string; id: string }>(),
  };

  public cleanZoneName: string;
  public zoneId: string;
  private records: GCPDNSRecord[] = [];

  constructor(public zoneName: string) {
    super(zoneName);
    const clean = zoneName.toLowerCase();
    this.cleanZoneName = clean.endsWith(".") ? clean : `${clean}.`;
    this.zoneId = cleanZoneId(zoneName);
    this.discoveryPromise = this.discoverZone();
  }

  private async discoverZone(): Promise<any> {
    try {
      const project = getProjectId();
      const zone = await gcpFetch(
        DNS_BASE,
        `/dns/v1/projects/${project}/managedZones/${this.zoneId}`
      );
      if (zone) {
        this.out.zone.resolve({ name: this.zoneName, id: this.zoneId });
      }
      return zone;
    } catch (e: any) {
      if (
        e.message?.includes("404") ||
        e.message?.includes("403") ||
        e.message?.includes("credentials not configured")
      ) {
        return null;
      }
      throw e;
    }
  }

  record(filePath: string): this;
  record(
    name: string,
    type: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "PTR" | "SRV" | "CAA" | "SPF",
    value: string,
    ttl?: number
  ): this;
  record(
    nameOrPath: string,
    type?: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "PTR" | "SRV" | "CAA" | "SPF",
    value?: string,
    ttl: number = 300
  ) {
    if (arguments.length === 1 && typeof nameOrPath === "string" && (nameOrPath.endsWith(".yaml") || nameOrPath.endsWith(".yml") || nameOrPath.endsWith(".json"))) {
      const loaded = loadRecordsFromFile(nameOrPath);
      for (const r of loaded) {
        this.records.push({
          name: r.name,
          type: r.type,
          value: r.value,
          ttl: r.ttl ?? 300,
        });
      }
      return this;
    }
    this.records.push({ name: nameOrPath, type: type!, value: value!, ttl });
    return this;
  }

  pointer(name: string, target: BaseBuilder | Output<string> | string) {
    this.records.push({ name, type: "A", value: target, ttl: 300 });
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const existing = await this.discoveryPromise;

    console.log(`\n🗺️  Finalizing GCP Cloud DNS Zone "${this.zoneId}"...`);

    if (!existing) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create managed zone "${this.zoneId}" (dnsName: ${this.cleanZoneName})`);
      } else {
        await gcpFetch(
          DNS_BASE,
          `/dns/v1/projects/${project}/managedZones`,
          {
            method: "POST",
            body: JSON.stringify({
              name: this.zoneId,
              dnsName: this.cleanZoneName,
              description: "Managed by Puls",
              visibility: "public",
            }),
          }
        );
        console.log(`🚀 Created managed zone "${this.zoneId}" (dnsName: ${this.cleanZoneName})`);
      }
    } else {
      console.log(`   ✅ Managed zone "${this.zoneId}" exists`);
    }

    this.out.zone.resolve({ name: this.zoneName, id: this.zoneId });

    // 1. Resolve values of all records
    const resolvedRecords: { name: string; type: string; value: string; ttl: number }[] = [];
    for (const r of this.records) {
      let data: string;
      let type = r.type;

      if (r.value instanceof Output) {
        data = await r.value.get();
      } else if (typeof r.value === "object" && r.value !== null) {
        const targetObj = r.value;
        let targetVal: string | null = null;
        if ("url" in targetObj && typeof targetObj.url === "string") {
          targetVal = targetObj.url;
        } else if ("resolvedUrl" in targetObj && typeof targetObj.resolvedUrl === "string") {
          targetVal = targetObj.resolvedUrl;
        } else if (typeof (targetObj as any).getPublicIp === "function") {
          targetVal = await (targetObj as any).getPublicIp();
        } else if ("resolvedIp" in targetObj && typeof targetObj.resolvedIp === "string") {
          targetVal = targetObj.resolvedIp;
        } else if ("ip" in targetObj && typeof targetObj.ip === "string") {
          targetVal = targetObj.ip;
        } else if (typeof targetObj.deploy === "function") {
          const deployRes = await targetObj.deploy();
          if (deployRes && typeof deployRes === "object") {
            targetVal = deployRes.url ?? deployRes.ip ?? deployRes.publicIp ?? null;
          }
        }
        data = targetVal ?? `[alias: ${targetObj.name ?? "unknown"}]`;
      } else {
        data = r.value;
      }

      // Convert HTTP/HTTPS target urls for CNAME conversion
      if (data.startsWith("http://") || data.startsWith("https://")) {
        data = data.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
        if (type === "A") {
          type = "CNAME";
        }
      }

      // Automatically append trailing dot to CNAME, MX, NS targets if they don't have one and are not IPs
      const isIp = /^[0-9.]+$/.test(data) || data.includes(":");
      if ((type === "CNAME" || type === "MX" || type === "NS") && !isIp && !data.endsWith(".")) {
        data = `${data}.`;
      }

      // Auto-quote TXT/SPF values
      if ((type === "TXT" || type === "SPF") && !data.startsWith('"')) {
        data = `"${data}"`;
      }

      resolvedRecords.push({
        name: formatRecordName(r.name, this.cleanZoneName),
        type,
        value: data,
        ttl: r.ttl ?? 300,
      });
    }

    // 2. Group resolved records by name:type to form ResourceRecordSets
    const declaredRrsetsMap = new Map<string, { name: string; type: string; ttl: number; rrdatas: string[] }>();
    for (const r of resolvedRecords) {
      const key = `${r.name}:${r.type}`;
      const existingRrset = declaredRrsetsMap.get(key);
      if (existingRrset) {
        if (!existingRrset.rrdatas.includes(r.value)) {
          existingRrset.rrdatas.push(r.value);
        }
        // Keep the minimum TTL or default
        existingRrset.ttl = Math.min(existingRrset.ttl, r.ttl);
      } else {
        declaredRrsetsMap.set(key, {
          name: r.name,
          type: r.type,
          ttl: r.ttl,
          rrdatas: [r.value],
        });
      }
    }

    // Sort rrdatas of declared sets to enable stable comparison
    for (const rrset of declaredRrsetsMap.values()) {
      rrset.rrdatas.sort();
    }

    // 3. Fetch existing rrsets from the zone
    let existingRrsets: any[] = [];
    if (existing) {
      try {
        const res = await gcpFetch(
          DNS_BASE,
          `/dns/v1/projects/${project}/managedZones/${this.zoneId}/rrsets`
        );
        existingRrsets = res.rrsets ?? [];
      } catch (err) {
        existingRrsets = [];
      }
    }

    const existingRrsetsMap = new Map<string, any>();
    for (const r of existingRrsets) {
      existingRrsetsMap.set(`${r.name}:${r.type}`, r);
    }

    const additions: any[] = [];
    const deletions: any[] = [];

    // 4. Compute additions and deletions transactionally
    for (const [key, dec] of declaredRrsetsMap.entries()) {
      const ext = existingRrsetsMap.get(key);
      if (!ext) {
        // Brand new record set
        additions.push(dec);
        console.log(`   📝 [PLAN] Create ${dec.type} record: ${dec.name} → ${JSON.stringify(dec.rrdatas)} (TTL: ${dec.ttl})`);
      } else {
        const sortedExtRrdatas = [...(ext.rrdatas ?? [])].sort();
        const rrdatasMatch = JSON.stringify(sortedExtRrdatas) === JSON.stringify(dec.rrdatas);
        const ttlMatch = ext.ttl === dec.ttl;

        if (rrdatasMatch && ttlMatch) {
          console.log(`   ✅ ${dec.type} record ${dec.name} is up to date`);
        } else {
          // Transactional modification: delete old and add new
          deletions.push(ext);
          additions.push(dec);
          console.log(`   📝 [PLAN] Update ${dec.type} record: ${dec.name} → ${JSON.stringify(dec.rrdatas)} (was ${JSON.stringify(ext.rrdatas)})`);
        }
      }
    }

    // 5. Submit transactional change if any additions or deletions
    if ((additions.length > 0 || deletions.length > 0) && !dryRun) {
      await gcpFetch(
        DNS_BASE,
        `/dns/v1/projects/${project}/managedZones/${this.zoneId}/changes`,
        {
          method: "POST",
          body: JSON.stringify({
            additions,
            deletions,
          }),
        }
      );
      console.log(`   🔄 Submitted transactional record updates to zone "${this.zoneId}"`);
    }

    await this.deploySidecars();

    return {
      zone: this.zoneName,
      id: this.zoneId,
      records: Array.from(declaredRrsetsMap.values()),
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const zoneId = this.zoneId;

    console.log(`\n🗑️  Destroying GCP Cloud DNS Zone "${zoneId}"...`);

    const existing = await this.discoverZone();

    if (!existing) {
      console.log(`   ✅ Zone "${zoneId}" does not exist - nothing to do.`);
      return { destroyed: zoneId };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete managed zone "${zoneId}"`);
      return { destroyed: zoneId };
    }

    // 1. Fetch existing rrsets to clear non-default records
    let existingRrsets: any[] = [];
    try {
      const res = await gcpFetch(
        DNS_BASE,
        `/dns/v1/projects/${project}/managedZones/${zoneId}/rrsets`
      );
      existingRrsets = res.rrsets ?? [];
    } catch {
      // If fetching fails, we'll try to delete anyway
    }

    // 2. Filter out default apex NS and SOA records
    const deletableRrsets = existingRrsets.filter((r: any) => {
      const isApex = r.name === this.cleanZoneName;
      const isDefaultType = r.type === "NS" || r.type === "SOA";
      return !(isApex && isDefaultType);
    });

    // 3. Delete non-default records transactionally
    if (deletableRrsets.length > 0) {
      console.log(`   🔄 Deleting ${deletableRrsets.length} non-default records...`);
      await gcpFetch(
        DNS_BASE,
        `/dns/v1/projects/${project}/managedZones/${zoneId}/changes`,
        {
          method: "POST",
          body: JSON.stringify({
            deletions: deletableRrsets,
          }),
        }
      );
    }

    // 4. Delete the managed zone
    await gcpFetch(
      DNS_BASE,
      `/dns/v1/projects/${project}/managedZones/${zoneId}`,
      {
        method: "DELETE",
      }
    );

    console.log(`   ✅ Managed zone "${zoneId}" deleted.`);
    await this.destroySidecars();

    return { destroyed: zoneId };
  }
}
