import { readFileSync } from 'fs';
import { homedir } from 'os';
import { OS, REGION, SIZE, NETWORK } from '../../types/do.ts';
import { Config } from '../../core/config.ts';
import { BaseBuilder } from '../../core/resource.ts';
import { FirewallBuilder } from './firewall.ts';
import { DomainBuilder } from './domain.ts';
import { LoadBalancerBuilder } from './load_balancer.ts';
import { getDoApi, DoApiClient } from './api.ts';

export class DropletBuilder extends BaseBuilder {
  public config: any = {
    image: OS.UBUNTU_22_04,
    region: Config.get().providers.do?.defaultRegion || REGION.NYC,
    size: SIZE.SMALL,
  };

  private dropletId?: number;
  private resolvedIp?: string;
  private sshKeyPath?: string;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverDroplet(name);
  }

  private async discoverDroplet(name: string): Promise<any> {
    const api = getDoApi();
    const data = await api.get<{ droplets: any[] }>(`/droplets?name=${encodeURIComponent(name)}&per_page=200`);
    const match = data.droplets.find(d => d.name === name) ?? null;
    if (match) {
      this.dropletId = match.id;
      const pub = (match.networks?.v4 ?? []).find((n: any) => n.type === 'public');
      this.resolvedIp = pub?.ip_address;
    }
    return match;
  }

  async getPublicIp(): Promise<string | undefined> {
    await this.discoveryPromise;
    return this.resolvedIp;
  }

  allowPublicWeb(sources: string[] = [NETWORK.ANY, NETWORK.ANY_V6]) {
    const fw = new FirewallBuilder(`${this.name}-web-fw`)
      .ingress('tcp', 80, sources)
      .ingress('tcp', 443, sources)
      .egress('tcp', 'all', [NETWORK.ANY, NETWORK.ANY_V6])
      .attachTo(this.name);
    this.sidecars.push(fw);
    return this;
  }

  image(image: (typeof OS)[keyof typeof OS] | string) {
    this.config.image = image;
    return this;
  }

  region(region: (typeof REGION)[keyof typeof REGION] | string) {
    this.config.region = region;
    return this;
  }

  size(size: (typeof SIZE)[keyof typeof SIZE] | string) {
    this.config.size = size;
    return this;
  }

  sslKey(keyPath: string) {
    this.sshKeyPath = keyPath.replace('~', homedir());
    return this;
  }

  private async resolveOrRegisterSshKey(api: DoApiClient): Promise<number> {
    const pubPath = this.sshKeyPath!.replace(/\.pub$/, '') + '.pub';
    const pubKey = readFileSync(pubPath, 'utf8').trim();

    const { ssh_keys } = await api.get<{ ssh_keys: any[] }>('/account/keys?per_page=200');
    const existing = ssh_keys.find(k => k.public_key.trim() === pubKey);
    if (existing) return existing.id;

    const keyName = pubPath.split('/').pop()!.replace('.pub', '');
    const result = await api.post<{ ssh_key: any }>('/account/keys', { name: keyName, public_key: pubKey });
    console.log(`   🔑 Registered SSH key "${keyName}" (id=${result.ssh_key.id})`);
    return result.ssh_key.id;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getDoApi();

    const hasChanges = existing
      ? existing.size_slug !== this.config.size || existing.region.slug !== this.config.region
      : true;

    if (await this.checkProtection(hasChanges)) return null;

    if (dryRun) {
      console.log(`\n🔍 [DRY RUN] "${this.name}"...`);
      if (!existing) {
        const keyHint = this.sshKeyPath ? ` + key ${this.sshKeyPath.split('/').pop()}` : '';
        console.log(`   📝 Plan: Create droplet ${this.name} (${this.config.size} in ${this.config.region}${keyHint})`);
      } else if (hasChanges) {
        console.log(`   📝 Plan: Resize ${this.name} → ${this.config.size}`);
      } else {
        console.log(`   ✅ ${this.name} is up to date.`);
      }
      for (const sidecar of this.sidecars) await sidecar.deploy();
      return this.config;
    }

    console.log(`\n⏳ Finalizing "${this.name}"...`);

    if (!existing) {
      const sshKeyIds = this.sshKeyPath ? [await this.resolveOrRegisterSshKey(api)] : [];
      const result = await api.post<{ droplet: any }>('/droplets', {
        name: this.name,
        region: this.config.region,
        size: this.config.size,
        image: this.config.image,
        ...(sshKeyIds.length && { ssh_keys: sshKeyIds }),
      });
      this.dropletId = result.droplet.id;
      console.log(`🚀 Created droplet ${this.name} (id=${this.dropletId})`);

      await this.waitFor('droplet to become active', async () => {
        const d = await api.get<{ droplet: any }>(`/droplets/${this.dropletId}`);
        if (d.droplet.status === 'active') {
          const pub = (d.droplet.networks?.v4 ?? []).find((n: any) => n.type === 'public');
          this.resolvedIp = pub?.ip_address;
          return true;
        }
        return false;
      });

      if (this.resolvedIp) console.log(`   🌐 Public IP: ${this.resolvedIp}`);
    } else if (hasChanges) {
      console.log(`✨ Resizing ${this.name} → ${this.config.size}...`);
      await api.post(`/droplets/${this.dropletId}/actions`, { type: 'resize', size: this.config.size });
    } else {
      console.log(`✅ ${this.name} is up to date.`);
    }

    for (const sidecar of this.sidecars) await sidecar.deploy();
    return this.config;
  }

  async destroy(): Promise<any> {
    const dryRun = this.isDryRunActive();
    await this.discoveryPromise;

    if (!this.dropletId) {
      console.log(`\n🗑️  "${this.name}" not found, nothing to destroy.`);
      return { destroyed: null };
    }

    console.log(`\n🗑️  Destroying "${this.name}" (id=${this.dropletId})...`);

    if (dryRun) {
      console.log(`   📝 [PLAN] Would delete droplet id=${this.dropletId}`);
    } else {
      await getDoApi().delete(`/droplets/${this.dropletId}`);
      console.log(`   ✅ Deleted.`);
    }

    await this.destroySidecars();
    return { destroyed: this.name };
  }
}

export const DO = {
  init: (opts: { token: string; defaultRegion?: string }) => {
    Config.set({
      providers: {
        ...Config.get().providers,
        do: opts,
      },
    });
  },
  Droplet: (name: string) => new DropletBuilder(name),
  Domain: (name: string) => new DomainBuilder(name),
  LoadBalancer: (name: string) => new LoadBalancerBuilder(name),
};
