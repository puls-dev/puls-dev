import { gcpFetch, getProjectId } from "./api.js";
import type { GcpInventory, GcpVM, GcpCloudSQL, GcpCloudRun, GcpCloudDNS } from "../../types/inventory.js";

export async function listGcpResources(): Promise<GcpInventory> {
  const project = getProjectId();

  const [vmRes, sqlRes, runRes, dnsRes] = await Promise.all([
    gcpFetch("https://compute.googleapis.com", `/compute/v1/projects/${project}/aggregated/instances`).catch(() => ({})),
    gcpFetch("https://sqladmin.googleapis.com", `/v1/projects/${project}/instances`).catch(() => ({})),
    gcpFetch("https://run.googleapis.com", `/v2/projects/${project}/locations/-/services`).catch(() => ({})),
    gcpFetch("https://dns.googleapis.com", `/dns/v1/projects/${project}/managedZones`).catch(() => ({})),
  ]);

  // 1. Map VM Instances
  const vms: GcpVM[] = [];
  if (vmRes.items) {
    for (const [zoneKey, zoneData] of Object.entries(vmRes.items)) {
      const data = zoneData as any;
      if (data.instances) {
        const zone = zoneKey.split("/").pop() ?? zoneKey;
        for (const inst of data.instances) {
          const machineType = inst.machineType?.split("/").pop() ?? "unknown";
          const ip = inst.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? "no-ip";
          vms.push({
            name: inst.name,
            zone,
            machineType,
            status: inst.status ?? "unknown",
            ip,
          });
        }
      }
    }
  }

  // 2. Map Cloud SQL Instances
  const rdsInstances: GcpCloudSQL[] = (sqlRes.items ?? []).map((i: any) => ({
    name: i.name,
    engine: i.databaseVersion ?? "unknown",
    tier: i.settings?.tier ?? "unknown",
    status: i.state ?? "unknown",
  }));

  // 3. Map Cloud Run Services
  const distributions: GcpCloudRun[] = (runRes.services ?? []).map((s: any) => {
    const parts = s.name.split("/");
    const name = parts.pop() ?? "unknown";
    const region = parts[parts.indexOf("locations") + 1] ?? "unknown";
    return {
      name,
      region,
      url: s.uri ?? "no-url",
    };
  });

  // 4. Map Cloud DNS Zones
  const hostedZones: GcpCloudDNS[] = (dnsRes.managedZones ?? []).map((z: any) => ({
    name: z.name,
    dnsName: z.dnsName ?? "",
  }));

  return { vms, rdsInstances, distributions, hostedZones };
}
