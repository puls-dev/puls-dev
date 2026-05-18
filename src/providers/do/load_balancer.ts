import { Config } from '../../core/config.js';
import { DropletBuilder } from './droplet.js';
import { getDoApi } from './api.js';

export class LoadBalancerBuilder {
  private config: any = {
    region: Config.get().providers.do?.defaultRegion ?? 'fra1',
  };
  private targetNames: string[] = [];
  private discoveryPromise: Promise<any>;

  constructor(private name: string) {
    this.discoveryPromise = this.discoverLb(name);
  }

  private async discoverLb(name: string): Promise<any> {
    const api = getDoApi();
    const data = await api.get<{ load_balancers: any[] }>('/load_balancers?per_page=200');
    return data.load_balancers.find(lb => lb.name === name) ?? null;
  }

  private async resolveDropletIds(): Promise<number[]> {
    const api = getDoApi();
    const ids: number[] = [];
    for (const name of this.targetNames) {
      const data = await api.get<{ droplets: any[] }>(`/droplets?name=${encodeURIComponent(name)}&per_page=200`);
      const match = data.droplets.find(d => d.name === name);
      if (match) ids.push(match.id);
    }
    return ids;
  }

  targets(droplets: (DropletBuilder | string)[]) {
    this.targetNames = droplets.map(d => (typeof d === 'string' ? d : d.name));
    return this;
  }

  async deploy() {
    const dryRun = Config.isGlobalDryRun();
    const existing = await this.discoveryPromise;

    console.log(`\n⚖️  Finalizing load balancer "${this.name}"...`);

    if (existing) {
      console.log(`✅ Load balancer ${this.name} already exists (ip=${existing.ip}).`);
      return existing;
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Create load balancer ${this.name} targeting [${this.targetNames.join(', ')}]`);
      return this.config;
    }

    const dropletIds = await this.resolveDropletIds();
    const api = getDoApi();
    const result = await api.post<{ load_balancer: any }>('/load_balancers', {
      name: this.name,
      region: this.config.region,
      forwarding_rules: [
        { entry_protocol: 'http', entry_port: 80, target_protocol: 'http', target_port: 80 },
        { entry_protocol: 'https', entry_port: 443, target_protocol: 'http', target_port: 80 },
      ],
      droplet_ids: dropletIds,
    });

    console.log(`🚀 Created load balancer ${this.name} (id=${result.load_balancer.id})`);
    if (this.targetNames.length) console.log(`   Targets: [${this.targetNames.join(', ')}]`);
    return result.load_balancer;
  }
}
