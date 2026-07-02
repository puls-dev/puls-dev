import { registerProvider, printSection, Config, DiscoveredResource, ResourceGroup } from "@puls-dev/core";
import { listHCloudResources } from "./list.js";
import type { HCloudInventory } from "@puls-dev/core";

export const hcloudPlugin = {
  name: "hcloud",
  isConfigured: (cfg: any) => !!cfg?.token,
  list: listHCloudResources,
  render: (inv: HCloudInventory) => {
    const costStr =
      inv.totalMonthlyCost > 0 ? `  ·  $${inv.totalMonthlyCost.toFixed(2)}/mo` : "";
    printSection(
      `Hetzner Cloud Servers  ·  ${inv.servers.length}${costStr}`,
      inv.servers,
      [
        { header: "Name", width: 24, render: (s) => s.name },
        { header: "Location", width: 10, render: (s) => s.location },
        { header: "Type", width: 10, render: (s) => s.serverType },
        { header: "Status", width: 8, render: (s) => s.status },
        { header: "IP", width: 15, render: (s) => s.ip ?? "-" },
        {
          header: "$/mo",
          width: 8,
          render: (s) => (s.monthlyCost > 0 ? `$${s.monthlyCost.toFixed(2)}` : "?"),
        },
      ],
    );

    if (inv.firewalls.length > 0) {
      printSection(
        `Hetzner Cloud Firewalls  ·  ${inv.firewalls.length}`,
        inv.firewalls,
        [
          { header: "Name", width: 32, render: (f) => f.name },
          { header: "Servers", width: 8, render: (f) => String(f.serverCount) },
        ],
      );
    }

    if (inv.networks.length > 0) {
      printSection(
        `Hetzner Cloud Networks  ·  ${inv.networks.length}`,
        inv.networks,
        [
          { header: "Name", width: 24, render: (n) => n.name },
          { header: "IP Range", width: 20, render: (n) => n.ipRange },
        ],
      );
    }

    if (inv.volumes && inv.volumes.length > 0) {
      printSection(
        `Hetzner Cloud Volumes  ·  ${inv.volumes.length}`,
        inv.volumes,
        [
          { header: "Name", width: 24, render: (v) => v.name },
          { header: "Size (GB)", width: 10, render: (v) => `${v.size} GB` },
          { header: "Attached Server", width: 18, render: (v) => v.serverId ? String(v.serverId) : "None" },
        ],
      );
    }

    if (inv.loadBalancers && inv.loadBalancers.length > 0) {
      printSection(
        `Hetzner Cloud Load Balancers  ·  ${inv.loadBalancers.length}`,
        inv.loadBalancers,
        [
          { header: "Name", width: 24, render: (lb) => lb.name },
          { header: "Type", width: 10, render: (lb) => lb.type },
          { header: "Location", width: 10, render: (lb) => lb.location },
          { header: "IP", width: 15, render: (lb) => lb.ip ?? "-" },
        ],
      );
    }
  },
  configure: (pOpts: any) => {
    Config.set({
      providers: {
        hcloud: pOpts,
      },
    });
  },
  parseInventory: (inv: HCloudInventory): DiscoveredResource[] => {
    const rawResources: DiscoveredResource[] = [];
    const toPropertyName = (name: string) => name.replace(/[^a-zA-Z0-9]/g, "_").replace(/^([0-9])/, "_$1");

    inv.networks?.forEach((n: any) =>
      rawResources.push({
        id: n.id,
        name: n.name,
        type: "HCloud.Network",
        provider: "hcloud",
        tier: "network",
        propertyName: toPropertyName(n.name),
        original: n,
      })
    );
    inv.volumes?.forEach((v: any) =>
      rawResources.push({
        id: v.id,
        name: v.name,
        type: "HCloud.Volume",
        provider: "hcloud",
        tier: "database",
        propertyName: toPropertyName(v.name),
        original: v,
      })
    );
    inv.servers?.forEach((s: any) =>
      rawResources.push({
        id: s.id,
        name: s.name,
        type: "HCloud.Server",
        provider: "hcloud",
        tier: "compute",
        propertyName: toPropertyName(s.name),
        original: s,
      })
    );
    return rawResources;
  },
  groupResources: (resources: DiscoveredResource[]): ResourceGroup[] => {
    const groups: ResourceGroup[] = [];
    const processedIds = new Set<string | number>();

    const networkBoundaries = resources.filter((r) => r.type === "HCloud.Network");
    networkBoundaries.forEach((net) => {
      processedIds.add(net.id);
      groups.push({
        id: `network:${net.id}`,
        name: `🌐  Network: ${net.name}`,
        provider: net.provider,
        description: `HCloud Network boundary`,
        resources: [net],
      });
    });

    // Default standalone group for rest
    resources.forEach((r) => {
      if (processedIds.has(r.id)) return;
      processedIds.add(r.id);
      groups.push({
        id: `standalone:${r.id}`,
        name: `📦  [${r.type}] ${r.name}`,
        provider: r.provider,
        description: `Standalone resource`,
        resources: [r],
      });
    });

    return groups;
  },
  getPropertyChain: (res: DiscoveredResource): string => {
    let chain = "";
    if (res.type === "HCloud.Server") {
      if (res.original?.serverType) {
        chain += `\n    .serverType("${res.original.serverType}")`;
      }
      if (res.original?.location) {
        chain += `\n    .location("${res.original.location}")`;
      }
    }
    return chain;
  }
};

registerProvider(hcloudPlugin);
