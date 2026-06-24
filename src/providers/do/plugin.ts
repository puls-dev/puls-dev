import { registerProvider, printSection } from "../../core/provider.js";
import { listDoResources } from "./list.js";
import { Config } from "../../core/config.js";
import type { DoInventory } from "../../types/inventory.js";

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
  }
};

registerProvider(doPlugin);
