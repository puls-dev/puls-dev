import { getDoApi } from './api.js';
import type { DoInventory, DoDroplet, DoFirewall, DoLoadBalancer, DoDomain } from '../../types/inventory.js';

const DO_PRICING: Record<string, number> = {
  's-1vcpu-1gb':    6,
  's-1vcpu-2gb':   12,
  's-2vcpu-2gb':   18,
  's-2vcpu-4gb':   24,
  's-4vcpu-8gb':   48,
  's-6vcpu-16gb':  96,
  's-8vcpu-32gb': 192,
  'c-2':           42,
  'c-4':           84,
  'c-8':          168,
  'g-2vcpu-8gb':   60,
  'g-4vcpu-16gb': 120,
  'm-2vcpu-16gb':  90,
  'm-4vcpu-32gb': 180,
};

function priceForSlug(slug: string): number {
  return DO_PRICING[slug] ?? 0;
}

export async function listDoResources(): Promise<DoInventory> {
  const api = getDoApi();

  const [dropletsData, firewallsData, lbData, domainsData] = await Promise.all([
    api.get<{ droplets: any[] }>('/droplets?per_page=200'),
    api.get<{ firewalls: any[] }>('/firewalls?per_page=200'),
    api.get<{ load_balancers: any[] }>('/load_balancers?per_page=200'),
    api.get<{ domains: any[] }>('/domains?per_page=200'),
  ]);

  const droplets: DoDroplet[] = dropletsData.droplets.map((d) => {
    const pub = (d.networks?.v4 ?? []).find((n: any) => n.type === 'public');
    return {
      id:          d.id,
      name:        d.name,
      status:      d.status,
      region:      d.region?.slug ?? d.region ?? '',
      size:        d.size_slug,
      ip:          pub?.ip_address,
      monthlyCost: priceForSlug(d.size_slug),
    };
  });

  const firewalls: DoFirewall[] = firewallsData.firewalls.map((f) => ({
    id:           f.id,
    name:         f.name,
    dropletCount: (f.droplet_ids ?? []).length,
  }));

  const loadBalancers: DoLoadBalancer[] = lbData.load_balancers.map((lb) => ({
    id:     lb.id,
    name:   lb.name,
    ip:     lb.ip ?? '',
    region: lb.region?.slug ?? lb.region ?? '',
    status: lb.status,
  }));

  const domains: DoDomain[] = domainsData.domains.map((d) => ({
    name: d.name,
    ttl:  d.ttl,
  }));

  const totalMonthlyCost = droplets.reduce((sum, d) => sum + d.monthlyCost, 0);

  return { droplets, firewalls, loadBalancers, domains, totalMonthlyCost };
}
