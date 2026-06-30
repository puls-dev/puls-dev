import { BaseBuilder } from '@puls-dev/core';
import { getHCloudApi } from './api.js';
import { loadRecordsFromFile } from '@puls-dev/core';

export interface HCloudFirewallRule {
  type: 'ingress' | 'egress';
  protocol: 'tcp' | 'udp' | 'icmp' | 'esp' | 'gre';
  port: number | string;
  sources?: string[];
  destinations?: string[];
}

export class FirewallBuilder extends BaseBuilder {
  private _rules: HCloudFirewallRule[] = [];
  private serverNames: string[] = [];
  private firewallId?: number;

  private log(msg: string) {
    console.log(`   🛡️ [HCloud.Firewall] ${msg}`);
  }

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverFirewall(name);
  }

  private async discoverFirewall(name: string): Promise<any> {
    const api = getHCloudApi();
    const data = await api.get<{ firewalls: any[] }>('/firewalls');
    const match = data.firewalls.find(f => f.name === name) ?? null;
    if (match) {
      this.firewallId = match.id;
    }
    return match;
  }

  ingress(protocol: 'tcp' | 'udp' | 'icmp' | 'esp' | 'gre', port: number | string, sources: string[]) {
    this._rules.push({ type: 'ingress', protocol, port, sources });
    return this;
  }

  egress(protocol: 'tcp' | 'udp' | 'icmp' | 'esp' | 'gre', port: number | string, destinations: string[]) {
    this._rules.push({ type: 'egress', protocol, port, destinations });
    return this;
  }

  rules(filePath: string) {
    const loaded = loadRecordsFromFile(filePath);
    for (const r of loaded) {
      this._rules.push({
        type: r.type,
        protocol: r.protocol,
        port: r.port,
        sources: r.sources,
        destinations: r.destinations,
      });
    }
    return this;
  }

  attachTo(serverName: string) {
    this.serverNames.push(serverName);
    return this;
  }

  private async resolveServerIds(api: ReturnType<typeof getHCloudApi>): Promise<number[]> {
    const ids: number[] = [];
    for (const name of this.serverNames) {
      const data = await api.get<{ servers: any[] }>(`/servers?name=${encodeURIComponent(name)}`);
      const match = data.servers.find(s => s.name === name);
      if (match) ids.push(match.id);
    }
    return ids;
  }

  private buildApiRules() {
    return this._rules.map(r => {
      const direction = r.type === 'ingress' ? 'in' : 'out';
      const rule: any = {
        direction,
        protocol: r.protocol,
        port: String(r.port),
      };
      if (direction === 'in') {
        rule.source_ips = r.sources ?? [];
      } else {
        rule.destination_ips = r.destinations ?? [];
      }
      return rule;
    });
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getHCloudApi();

    this.log(`Finalizing firewall...`);

    if (dryRun) {
      this._rules.forEach(r => {
        const dir = r.type === 'ingress' ? 'from' : 'to';
        const targets = r.type === 'ingress' ? r.sources : r.destinations;
        this.log(`[PLAN] ${r.type.toUpperCase()}: ${r.protocol.toUpperCase()} ${r.port} ${dir} [${targets?.join(', ')}]`);
      });
      return { name: this.name, rules: this._rules };
    }

    const serverIds = await this.resolveServerIds(api);
    const rules = this.buildApiRules();
    const applyTo = serverIds.map(id => ({
      type: 'server',
      server: { id }
    }));

    if (existing) {
      this.firewallId = existing.id;
      // Update rules
      await api.post(`/firewalls/${this.firewallId}/actions/set_rules`, { rules });
      // Apply to resources
      if (applyTo.length > 0) {
        await api.post(`/firewalls/${this.firewallId}/actions/apply_to_resources`, { apply_to: applyTo });
      }
      this.log(`Updated firewall (id=${this.firewallId})`);
    } else {
      const result = await api.post<{ firewall: any }>('/firewalls', {
        name: this.name,
        rules,
        apply_to: applyTo
      });
      this.firewallId = result.firewall.id;
      this.log(`Created firewall (id=${this.firewallId})`);
    }

    this._rules.forEach(r => {
      const dir = r.type === 'ingress' ? 'from' : 'to';
      const targets = r.type === 'ingress' ? r.sources : r.destinations;
      this.log(`✅ ${r.type.toUpperCase()}: ${r.protocol.toUpperCase()} ${r.port} ${dir} [${targets?.join(', ')}]`);
    });

    return { name: this.name, rules: this._rules };
  }

  async destroy() {
    const existing = await this.discoveryPromise;
    if (existing) {
      this.log(`Deleting firewall...`);
      const api = getHCloudApi();
      await api.delete(`/firewalls/${existing.id}`);
      this.log(`Deleted firewall.`);
    } else {
      this.log(`Firewall does not exist. Skipping deletion.`);
    }
  }
}
