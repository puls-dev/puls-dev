import { registerProvider, printSection, Config, DiscoveredResource, ResourceGroup } from "@puls-dev/core";
import { listGcpResources } from "./list.js";
import type { GcpInventory } from "@puls-dev/core";

export const gcpPlugin = {
  name: "gcp",
  isConfigured: (cfg: any) => !!(cfg?.serviceAccountPath || process.env.GCP_SA),
  list: listGcpResources,
  render: (inv: GcpInventory) => {
    if (inv.vms.length > 0) {
      printSection(
        `GCP Compute VMs  ·  ${inv.vms.length}`,
        inv.vms,
        [
          { header: "Name", width: 24, render: (v) => v.name },
          { header: "Zone", width: 15, render: (v) => v.zone },
          { header: "Machine Type", width: 14, render: (v) => v.machineType },
          { header: "Status", width: 8, render: (v) => v.status },
          { header: "IP", width: 15, render: (v) => v.ip },
        ],
      );
    }

    if (inv.rdsInstances.length > 0) {
      printSection(
        `GCP Cloud SQL  ·  ${inv.rdsInstances.length}`,
        inv.rdsInstances,
        [
          { header: "Name", width: 24, render: (i) => i.name },
          { header: "Engine", width: 18, render: (i) => i.engine },
          { header: "Tier", width: 12, render: (i) => i.tier },
          { header: "Status", width: 10, render: (i) => i.status },
        ],
      );
    }

    if (inv.distributions.length > 0) {
      printSection(
        `GCP Cloud Run  ·  ${inv.distributions.length}`,
        inv.distributions,
        [
          { header: "Service", width: 24, render: (s) => s.name },
          { header: "Region", width: 12, render: (s) => s.region },
          { header: "URL", width: 42, render: (s) => s.url },
        ],
      );
    }

    if (inv.hostedZones.length > 0) {
      printSection(
        `GCP Cloud DNS  ·  ${inv.hostedZones.length}`,
        inv.hostedZones,
        [
          { header: "Zone", width: 24, render: (z) => z.name },
          { header: "DNS Name", width: 32, render: (z) => z.dnsName },
        ],
      );
    }

    if (inv.pubSubTopics.length > 0) {
      printSection(
        `GCP Pub/Sub Topics  ·  ${inv.pubSubTopics.length}`,
        inv.pubSubTopics,
        [
          { header: "Topic", width: 52, render: (t) => t.name },
        ],
      );
    }

    if (inv.secrets.length > 0) {
      printSection(
        `GCP Secret Manager  ·  ${inv.secrets.length}`,
        inv.secrets,
        [
          { header: "Secret", width: 52, render: (s) => s.name },
        ],
      );
    }
  },
  configure: (pOpts: any) => {
    Config.set({ providers: { gcp: pOpts } });
  },
  parseInventory: (inv: GcpInventory): DiscoveredResource[] => {
    const toPropertyName = (name: string) => name.replace(/[^a-zA-Z0-9]/g, "_").replace(/^([0-9])/, "_$1");
    const resources: DiscoveredResource[] = [];

    inv.vms.forEach((v) => resources.push({
      id: v.name, name: v.name, type: "GCP.VM",
      provider: "gcp", tier: "compute",
      propertyName: toPropertyName(v.name), original: v,
    }));

    inv.rdsInstances.forEach((i) => resources.push({
      id: i.name, name: i.name, type: "GCP.CloudSQL",
      provider: "gcp", tier: "database",
      propertyName: toPropertyName(i.name), original: i,
    }));

    inv.distributions.forEach((s) => resources.push({
      id: s.name, name: s.name, type: "GCP.CloudRun",
      provider: "gcp", tier: "compute",
      propertyName: toPropertyName(s.name), original: s,
    }));

    inv.hostedZones.forEach((z) => resources.push({
      id: z.name, name: z.dnsName.replace(/\.$/, "") || z.name, type: "GCP.CloudDNS",
      provider: "gcp", tier: "network",
      propertyName: toPropertyName(z.name), original: z,
    }));

    inv.pubSubTopics.forEach((t) => resources.push({
      id: t.name, name: t.name, type: "GCP.PubSub",
      provider: "gcp", tier: "compute",
      propertyName: toPropertyName(t.name), original: t,
    }));

    inv.secrets.forEach((s) => resources.push({
      id: s.name, name: s.name, type: "GCP.Secret",
      provider: "gcp", tier: "compute",
      propertyName: toPropertyName(s.name), original: s,
    }));

    return resources;
  },
  getPropertyChain: (res: DiscoveredResource): string => {
    let chain = "";
    if (res.type === "GCP.VM") {
      if (res.original?.zone)        chain += `\n    .zone("${res.original.zone}")`;
      if (res.original?.machineType) chain += `\n    .machineType("${res.original.machineType}")`;
    } else if (res.type === "GCP.CloudRun") {
      if (res.original?.region) chain += `\n    .region("${res.original.region}")`;
    } else if (res.type === "GCP.CloudSQL") {
      if (res.original?.engine) {
        const raw: string = res.original.engine as string;
        const lower = raw.toLowerCase();
        if (lower.startsWith("postgres")) {
          const ver = raw.match(/(\d+)/)?.[1] ?? "16";
          chain += `\n    .engine({ engine: "postgres", version: "${ver}" })`;
        } else if (lower.startsWith("mysql")) {
          const ver = raw.match(/(\d+[._]\d*)/)?.[1]?.replace(/_/g, ".") ?? "8.0";
          chain += `\n    .engine({ engine: "mysql", version: "${ver}" })`;
        }
      }
      if (res.original?.tier) chain += `\n    .size("${res.original.tier}")`;
    }
    return chain;
  },
};

registerProvider(gcpPlugin);
