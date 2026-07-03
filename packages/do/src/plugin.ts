import { registerProvider, printSection, Config, DiscoveredResource, ResourceGroup } from "@puls-dev/core";
import { listDoResources } from "./list.js";
import type { DoInventory } from "@puls-dev/core";

export const doPlugin = {
  name: "do",
  isConfigured: (cfg: any) => !!cfg?.token,
  list: listDoResources,
  render: (inv: DoInventory) => {
    const costStr =
      inv.totalMonthlyCost > 0 ? `  ·  $${inv.totalMonthlyCost}/mo` : "";
    printSection(
      `DigitalOcean Droplets  ·  ${inv.droplets.length}${costStr}`,
      inv.droplets,
      [
        { header: "Name", width: 24, render: (d) => d.name },
        { header: "Region", width: 6, render: (d) => d.region },
        { header: "Size", width: 18, render: (d) => d.size },
        { header: "Status", width: 8, render: (d) => d.status },
        { header: "IP", width: 15, render: (d) => d.ip ?? "-" },
        {
          header: "$/mo",
          width: 5,
          render: (d) => (d.monthlyCost > 0 ? `$${d.monthlyCost}` : "?"),
        },
      ],
    );

    if (inv.firewalls.length > 0) {
      printSection(
        `DigitalOcean Firewalls  ·  ${inv.firewalls.length}`,
        inv.firewalls,
        [
          { header: "Name", width: 32, render: (f) => f.name },
          { header: "Droplets", width: 8, render: (f) => String(f.dropletCount) },
        ],
      );
    }

    if (inv.loadBalancers.length > 0) {
      printSection(
        `DigitalOcean Load Balancers  ·  ${inv.loadBalancers.length}`,
        inv.loadBalancers,
        [
          { header: "Name", width: 24, render: (lb) => lb.name },
          { header: "Region", width: 6, render: (lb) => lb.region },
          { header: "IP", width: 15, render: (lb) => lb.ip },
          { header: "Status", width: 8, render: (lb) => lb.status },
        ],
      );
    }

    if (inv.domains.length > 0) {
      printSection(
        `DigitalOcean Domains  ·  ${inv.domains.length}`,
        inv.domains,
        [
          { header: "Domain", width: 42, render: (d) => d.name },
          { header: "TTL", width: 6, render: (d) => String(d.ttl) },
        ],
      );
    }

    if (inv.databases.length > 0) {
      printSection(
        `DigitalOcean Databases  ·  ${inv.databases.length}`,
        inv.databases,
        [
          { header: "Name", width: 24, render: (d) => d.name },
          { header: "Engine", width: 14, render: (d) => d.engine },
          { header: "Region", width: 8, render: (d) => d.region },
          { header: "Status", width: 10, render: (d) => d.status },
          { header: "Nodes", width: 5, render: (d) => String(d.nodeCount) },
        ],
      );
    }

    if (inv.apps.length > 0) {
      printSection(
        `DigitalOcean Apps  ·  ${inv.apps.length}`,
        inv.apps,
        [
          { header: "Name", width: 24, render: (a) => a.name },
          { header: "Status", width: 12, render: (a) => a.status },
          { header: "URL", width: 40, render: (a) => a.liveUrl || "-" },
        ],
      );
    }

    if (inv.vpcs.length > 0) {
      printSection(
        `DigitalOcean VPCs  ·  ${inv.vpcs.length}`,
        inv.vpcs,
        [
          { header: "Name", width: 24, render: (v) => v.name },
          { header: "Region", width: 8, render: (v) => v.region },
          { header: "IP Range", width: 20, render: (v) => v.ipRange },
        ],
      );
    }
  },
  configure: (pOpts: any) => {
    Config.set({
      providers: {
        do: pOpts,
      },
    });
  },
  parseInventory: (inv: DoInventory): DiscoveredResource[] => {
    const rawResources: DiscoveredResource[] = [];
    const toPropertyName = (name: string) => name.replace(/[^a-zA-Z0-9]/g, "_").replace(/^([0-9])/, "_$1");

    inv.vpcs?.forEach((v: any) =>
      rawResources.push({
        id: v.id,
        name: v.name,
        type: "DO.VPC",
        provider: "do",
        tier: "network",
        propertyName: toPropertyName(v.name),
        original: v,
      })
    );
    inv.databases?.forEach((d: any) =>
      rawResources.push({
        id: d.id,
        name: d.name,
        type: "DO.Database",
        provider: "do",
        tier: "database",
        propertyName: toPropertyName(d.name),
        original: d,
      })
    );
    inv.droplets?.forEach((d: any) =>
      rawResources.push({
        id: d.id,
        name: d.name,
        type: "DO.Droplet",
        provider: "do",
        tier: "compute",
        propertyName: toPropertyName(d.name),
        original: d,
      })
    );
    inv.firewalls?.forEach((f: any) =>
      rawResources.push({
        id: f.id,
        name: f.name,
        type: "DO.Firewall",
        provider: "do",
        tier: "network",
        propertyName: toPropertyName(f.name),
        original: f,
      })
    );
    inv.loadBalancers?.forEach((lb: any) =>
      rawResources.push({
        id: lb.id,
        name: lb.name,
        type: "DO.LoadBalancer",
        provider: "do",
        tier: "network",
        propertyName: toPropertyName(lb.name),
        original: lb,
      })
    );
    inv.domains?.forEach((d: any) =>
      rawResources.push({
        id: d.name,
        name: d.name,
        type: "DO.Domain",
        provider: "do",
        tier: "network",
        propertyName: toPropertyName(d.name),
        original: d,
      })
    );
    return rawResources;
  },
  groupResources: (resources: DiscoveredResource[]): ResourceGroup[] => {
    const groups: ResourceGroup[] = [];
    const processedIds = new Set<string | number>();

    const networkBoundaries = resources.filter((r) => r.type === "DO.VPC");
    networkBoundaries.forEach((net) => {
      processedIds.add(net.id);
      const children = resources.filter((r) => {
        if (r.id === net.id) return false;
        if (r.type === "DO.Droplet" && r.original?.vpc_uuid === net.id) {
          processedIds.add(r.id);
          return true;
        }
        return false;
      });

      groups.push({
        id: `network:${net.id}`,
        name: `🌐  Network: ${net.name}`,
        provider: net.provider,
        description: `DO VPC boundary with ${children.length} resources`,
        resources: [net, ...children],
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
  getPropertyChain: (res: DiscoveredResource, allResources?: DiscoveredResource[]): string => {
    let chain = "";
    if (res.type === "DO.Droplet") {
      if (res.original?.size)   chain += `\n    .size("${res.original.size}")`;
      if (res.original?.region) chain += `\n    .region("${res.original.region}")`;
    }
    if (res.type === "DO.LoadBalancer") {
      if (res.original?.region) chain += `\n    .region("${res.original.region}")`;
    }
    if (res.type === "DO.Firewall") {
      const dropletIds = res.original?.dropletIds || [];
      if (allResources && dropletIds.length > 0) {
        dropletIds.forEach((dId: any) => {
          const matchedDroplet = allResources.find(other => String(other.id) === String(dId) && other.type === "DO.Droplet");
          if (matchedDroplet) {
            chain += `\n    .attachTo("${matchedDroplet.name}")`;
          }
        });
      }
    }
    return chain;
  }
};

registerProvider(doPlugin);
