import { registerProvider, printSection } from "../../core/provider.js";
import { listProxmoxVMs } from "./list.js";
import { Config } from "../../core/config.js";
import type { ProxmoxInventory } from "../../types/inventory.js";

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
  }
};

registerProvider(proxmoxPlugin);
