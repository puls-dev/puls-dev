import { getHCloudApi } from './api.js';
import type {
  HCloudInventory, HCloudServer, HCloudFirewall, HCloudNetwork, HCloudVolume, HCloudLoadBalancer
} from '@puls-dev/core';

const HCLOUD_PRICING: Record<string, number> = {
  'cx22': 3.60,
  'cpx11': 4.80,
  'cpx21': 7.90,
  'cpx31': 14.80,
  'cpx41': 29.60,
  'cpx51': 64.20,
  'cax11': 4.00,
  'cax21': 8.00,
  'cax31': 16.00,
  'cax41': 32.00,
};

function priceForType(type: string): number {
  return HCLOUD_PRICING[type] ?? 0;
}

export async function listHCloudResources(): Promise<HCloudInventory> {
  const api = getHCloudApi();

  const [serversData, firewallsData, networksData, volumesData, lbData] = await Promise.all([
    api.get<{ servers: any[] }>('/servers'),
    api.get<{ firewalls: any[] }>('/firewalls'),
    api.get<{ networks: any[] }>('/networks'),
    api.get<{ volumes: any[] }>('/volumes'),
    api.get<{ load_balancers: any[] }>('/load_balancers'),
  ]);

  const servers: HCloudServer[] = serversData.servers.map((s) => ({
    id:          s.id,
    name:        s.name,
    status:      s.status,
    location:    s.datacenter?.location?.name ?? '',
    serverType:  s.server_type?.name ?? '',
    ip:          s.public_net?.ipv4?.ip,
    monthlyCost: priceForType(s.server_type?.name),
  }));

  const firewalls: HCloudFirewall[] = firewallsData.firewalls.map((f) => ({
    id:          f.id,
    name:        f.name,
    serverCount: (f.applied_to ?? []).filter((r: any) => r.type === 'server').length,
  }));

  const networks: HCloudNetwork[] = networksData.networks.map((n) => ({
    id:          n.id,
    name:        n.name,
    ipRange:     n.ip_range ?? '',
  }));

  const volumes: HCloudVolume[] = volumesData.volumes.map((v) => ({
    id:          v.id,
    name:        v.name,
    size:        v.size,
    serverId:    v.server ?? undefined,
  }));

  const loadBalancers: HCloudLoadBalancer[] = lbData.load_balancers.map((lb) => ({
    id:          lb.id,
    name:        lb.name,
    ip:          lb.public_net?.ipv4?.ip ?? undefined,
    location:    lb.location?.name ?? '',
    type:        lb.load_balancer_type?.name ?? '',
  }));

  const totalMonthlyCost = servers.reduce((sum, s) => sum + s.monthlyCost, 0);

  return { servers, firewalls, networks, volumes, loadBalancers, totalMonthlyCost };
}
