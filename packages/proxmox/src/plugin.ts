import { registerProvider, printSection, Config, DiscoveredResource, ResourceGroup } from "@puls-dev/core";
import { listProxmoxVMs } from "./list.js";
import type { ProxmoxInventory } from "@puls-dev/core";

export const proxmoxPlugin = {
  name: "proxmox",
  isConfigured: (cfg: any) => !!(cfg?.url && cfg?.tokenSecret),
  list: listProxmoxVMs,
  render: (inv: ProxmoxInventory) => {
    const running = inv.vms.filter((v) => v.status === "running").length;
    printSection(
      `Proxmox  ·  ${inv.vms.length} VM${inv.vms.length !== 1 ? "s" : ""}  (${running} running)`,
      inv.vms,
      [
        { header: "Name", width: 26, render: (v) => v.name },
        { header: "VMID", width: 6, render: (v) => String(v.vmid) },
        { header: "Node", width: 12, render: (v) => v.node },
        { header: "Status", width: 8, render: (v) => v.status },
        {
          header: "Mem",
          width: 6,
          render: (v) => `${Math.round(v.maxmem / 1024 ** 3)}GB`,
        },
        {
          header: "Disk",
          width: 6,
          render: (v) => `${Math.round(v.maxdisk / 1024 ** 3)}GB`,
        },
      ],
    );

    if (inv.templates.length > 0) {
      printSection(
        `Proxmox Templates  ·  ${inv.templates.length}`,
        inv.templates,
        [
          { header: "Name", width: 32, render: (t) => t.name },
          { header: "VMID", width: 6, render: (t) => String(t.vmid) },
          { header: "Node", width: 12, render: (t) => t.node },
        ],
      );
    }
  },
  configure: (pOpts: any) => {
    Config.set({
      providers: {
        proxmox: pOpts,
      },
    });
  },
  parseInventory: (inv: ProxmoxInventory): DiscoveredResource[] => {
    const rawResources: DiscoveredResource[] = [];
    const toPropertyName = (name: string) => name.replace(/[^a-zA-Z0-9]/g, "_").replace(/^([0-9])/, "_$1");

    inv.vms?.forEach((v: any) =>
      rawResources.push({
        id: String(v.vmid),
        name: v.name,
        type: "Proxmox.VM",
        provider: "proxmox",
        tier: "compute",
        propertyName: toPropertyName(v.name),
        original: v,
      })
    );

    inv.templates?.forEach((t: any) =>
      rawResources.push({
        id: String(t.vmid),
        name: t.name,
        type: "Proxmox.Template",
        provider: "proxmox",
        tier: "compute",
        propertyName: toPropertyName(t.name),
        original: t,
      })
    );

    return rawResources;
  },
  groupResources: (resources: DiscoveredResource[]): ResourceGroup[] => {
    const groups: ResourceGroup[] = [];
    const processedIds = new Set<string | number>();

    // Node-based groups
    const nodes = Array.from(new Set(resources.map(r => r.original?.node).filter(Boolean)));
    nodes.forEach(node => {
      const children = resources.filter(r => r.original?.node === node);
      children.forEach(c => processedIds.add(c.id));
      groups.push({
        id: `node:${node}`,
        name: `🖥️  Node: ${node}`,
        provider: "proxmox",
        description: `Proxmox Node ${node} containing ${children.length} resources`,
        resources: children,
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
    if (res.type === "Proxmox.VM") {
      if (res.original?.maxcpu) {
        chain += `\n    .cores(${res.original.maxcpu})`;
      }
      if (res.original?.maxmem) {
        chain += `\n    .memory(${Math.round(res.original.maxmem / 1024 / 1024)})`;
      }
      if (res.original?.node) {
        chain += `\n    .node("${res.original.node}")`;
      }
    } else if (res.type === "Proxmox.Template") {
      if (res.original?.node) {
        chain += `\n    .node("${res.original.node}")`;
      }
    }
    return chain;
  }
};

registerProvider(proxmoxPlugin);
