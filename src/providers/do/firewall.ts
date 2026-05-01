import { BaseBuilder } from '../../core/resource.ts';
import { getDoApi } from './api.ts';

export interface FirewallRule {
  type: 'ingress' | 'egress';
  protocol: 'tcp' | 'udp' | 'icmp';
  port: number | string;
  sources?: string[];
  destinations?: string[];
}

export class FirewallBuilder extends BaseBuilder {
  private rules: FirewallRule[] = [];
  private dropletNames: string[] = [];

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverFirewall(name);
  }

  private async discoverFirewall(name: string): Promise<any> {
    const api = getDoApi();
    const data = await api.get<{ firewalls: any[] }>('/firewalls?per_page=200');
    return data.firewalls.find(f => f.name === name) ?? null;
  }

  ingress(protocol: 'tcp' | 'udp' | 'icmp', port: number | string, sources: string[]) {
    this.rules.push({ type: 'ingress', protocol, port, sources });
    return this;
  }

  egress(protocol: 'tcp' | 'udp' | 'icmp', port: number | string, destinations: string[]) {
    this.rules.push({ type: 'egress', protocol, port, destinations });
    return this;
  }

  attachTo(dropletName: string) {
    this.dropletNames.push(dropletName);
    return this;
  }

  private async resolveDropletIds(api: ReturnType<typeof getDoApi>): Promise<number[]> {
    const ids: number[] = [];
    for (const name of this.dropletNames) {
      const data = await api.get<{ droplets: any[] }>(`/droplets?name=${encodeURIComponent(name)}&per_page=200`);
      const match = data.droplets.find(d => d.name === name);
      if (match) ids.push(match.id);
    }
    return ids;
  }

  private buildApiRules() {
    const inbound = this.rules
      .filter(r => r.type === 'ingress')
      .map(r => ({
        protocol: r.protocol,
        ports: String(r.port),
        sources: { addresses: r.sources ?? [] },
      }));

    const outbound = this.rules
      .filter(r => r.type === 'egress')
      .map(r => ({
        protocol: r.protocol,
        ports: String(r.port),
        destinations: { addresses: r.destinations ?? [] },
      }));

    return { inbound, outbound };
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getDoApi();

    console.log(`\n🛡️  Finalizing firewall "${this.name}"...`);

    if (dryRun) {
      this.rules.forEach(r => {
        const dir = r.type === 'ingress' ? 'from' : 'to';
        const targets = r.type === 'ingress' ? r.sources : r.destinations;
        console.log(`   📝 [PLAN] ${r.type.toUpperCase()}: ${r.protocol.toUpperCase()} ${r.port} ${dir} [${targets?.join(', ')}]`);
      });
      return { name: this.name, rules: this.rules };
    }

    const dropletIds = await this.resolveDropletIds(api);
    const { inbound, outbound } = this.buildApiRules();

    if (existing) {
      await api.put(`/firewalls/${existing.id}`, {
        name: this.name,
        inbound_rules: inbound,
        outbound_rules: outbound,
        droplet_ids: dropletIds,
      });
      console.log(`✨ Updated firewall ${this.name} (id=${existing.id})`);
    } else {
      const result = await api.post<{ firewall: any }>('/firewalls', {
        name: this.name,
        inbound_rules: inbound,
        outbound_rules: outbound,
        droplet_ids: dropletIds,
      });
      console.log(`🚀 Created firewall ${this.name} (id=${result.firewall.id})`);
    }

    this.rules.forEach(r => {
      const dir = r.type === 'ingress' ? 'from' : 'to';
      const targets = r.type === 'ingress' ? r.sources : r.destinations;
      console.log(`   ✅ ${r.type.toUpperCase()}: ${r.protocol.toUpperCase()} ${r.port} ${dir} [${targets?.join(', ')}]`);
    });

    return { name: this.name, rules: this.rules };
  }
}
