import { getPMClient } from './api.js';
import type { ProxmoxInventory, ProxmoxVm, ProxmoxTemplate } from '@puls-dev/core';

export async function listProxmoxVMs(): Promise<ProxmoxInventory> {
  const resources = await getPMClient().get<any[]>('/cluster/resources?type=vm');
  const vms: ProxmoxVm[] = (resources ?? [])
    .filter((r) => r.template !== 1)
    .map((r) => ({
      name:    r.name,
      vmid:    r.vmid,
      node:    r.node,
      status:  r.status,
      maxcpu:  r.maxcpu  ?? 0,
      maxmem:  r.maxmem  ?? 0,
      maxdisk: r.maxdisk ?? 0,
    }));
  const templates: ProxmoxTemplate[] = (resources ?? [])
    .filter((r) => r.template === 1)
    .map((r) => ({
      name: r.name,
      vmid: r.vmid,
      node: r.node,
    }));
  return { vms, templates };
}
