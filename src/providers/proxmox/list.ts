import { getPMClient } from './api.js';
import type { ProxmoxInventory, ProxmoxVm } from '../../types/inventory.js';

export async function listProxmoxVMs(): Promise<ProxmoxInventory> {
  const resources = await getPMClient().get<any[]>('/cluster/resources?type=vm');
  const vms: ProxmoxVm[] = (resources ?? [])
    .filter((r) => r.template !== 1)
    .map((r) => ({
      name:    r.name,
      vmid:    r.vmid,
      node:    r.node,
      status:  r.status,
      maxmem:  r.maxmem  ?? 0,
      maxdisk: r.maxdisk ?? 0,
    }));
  return { vms };
}
