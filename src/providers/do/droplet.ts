import fs from 'fs';
import { homedir } from 'os';
import { OS, REGION, SIZE, NETWORK } from '../../types/do.js';
import { Config } from '../../core/config.js';
import { BaseBuilder } from '../../core/resource.js';
import { Output } from '../../core/output.js';
import { FirewallBuilder } from './firewall.js';
import { DomainBuilder } from './domain.js';
import { LoadBalancerBuilder } from './load_balancer.js';
import { getDoApi, DoApiClient } from './api.js';
import { checkPort, runProvisioner } from '../../core/provisioner.js';
import { getFileHash } from '../proxmox/hash.js';

export class DropletBuilder extends BaseBuilder {
  readonly out = {
    ip: new Output<string>(),
    id: new Output<number>(),
  };

  public config: any = {
    image: OS.UBUNTU_22_04,
    region: Config.get().providers.do?.defaultRegion || REGION.NYC,
    size: SIZE.SMALL,
  };

  private dropletId?: number;
  private resolvedIp?: string;
  private sshKeyPath?: string;
  private _provision: string[] = [];
  private _forceConfigCheck: boolean = false;

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
      if (this.dropletId) this.out.id.resolve(this.dropletId);
      if (this.resolvedIp) this.out.ip.resolve(this.resolvedIp);
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

  vpc(uuid: string | Output<string>) {
    this.config.vpc_uuid = uuid;
    return this;
  }

  provision(...playbookPaths: (string | string[])[]) {
    this._provision.push(...playbookPaths.flat());
    return this;
  }

  forceConfigCheck() {
    this._forceConfigCheck = true;
    return this;
  }

  protected async checkPort(ip: string, port: number): Promise<boolean> {
    return checkPort(ip, port);
  }

  protected async runProvisioner(ip: string, script: string): Promise<void> {
    const keyPath = this.sshKeyPath ? this.sshKeyPath : undefined;
    return runProvisioner(ip, "root", keyPath, script);
  }

  private async resolveOrRegisterSshKey(api: DoApiClient): Promise<number> {
    const pubPath = this.sshKeyPath!.replace(/\.pub$/, '') + '.pub';
    const pubKey = fs.readFileSync(pubPath, 'utf8').trim();

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

    // Provisioning Calculations
    const appliedHashes = existing ? parseDropletTagsForProvision(existing.tags || []) : {};
    const declaredPlaybooksWithHashes = this._provision.map((p) => {
      const baseName = p.split("/").pop() ?? p;
      const slug = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      return { path: p, slug, hash: getFileHash(p) };
    });

    const playbooksToRun = this._forceConfigCheck
      ? declaredPlaybooksWithHashes
      : declaredPlaybooksWithHashes.filter((p) => {
          const appliedHash = appliedHashes[p.slug];
          return !appliedHash || appliedHash !== p.hash;
        });

    const playbookRunRequired = playbooksToRun.length > 0;

    if (dryRun) {
      console.log(`\n🔍 [DRY RUN] "${this.name}"...`);
      if (!existing) {
        const keyHint = this.sshKeyPath ? ` + key ${this.sshKeyPath.split('/').pop()}` : '';
        let vpcHint = '';
        if (this.config.vpc_uuid) {
          const vpcVal = this.config.vpc_uuid instanceof Output ? 'PENDING' : this.config.vpc_uuid;
          vpcHint = ` in VPC ${vpcVal}`;
        }
        console.log(`   📝 Plan: Create droplet ${this.name} (${this.config.size} in ${this.config.region}${vpcHint}${keyHint})`);
        if (this._provision.length > 0) {
          console.log(`      └─ Provision: ${this._provision.join(", ")}`);
        }
        this.out.id.resolve(-1);
        this.out.ip.resolve('0.0.0.0');
      } else if (hasChanges || playbookRunRequired) {
        if (hasChanges) {
          console.log(`   📝 Plan: Resize ${this.name} → ${this.config.size}`);
        }
        if (playbookRunRequired) {
          console.log(`   📝 [PLAN] Run ${playbooksToRun.length} playbook changes on existing droplet:`);
          for (const p of playbooksToRun) {
            console.log(`      └─ Playbook: ${p.path} (hash: ${p.hash})`);
          }
        }
      } else {
        console.log(`   ✅ ${this.name} is up to date.`);
      }
      for (const sidecar of this.sidecars) await sidecar.deploy();
      return this.config;
    }

    console.log(`\n⏳ Finalizing "${this.name}"...`);

    if (!existing) {
      const sshKeyIds = this.sshKeyPath ? [await this.resolveOrRegisterSshKey(api)] : [];
      let resolvedVpcUuid: string | undefined;
      if (this.config.vpc_uuid) {
        resolvedVpcUuid = this.config.vpc_uuid instanceof Output ? await this.config.vpc_uuid.get() : this.config.vpc_uuid;
      }

      const initialTags: string[] = [];
      for (const playbook of this._provision) {
        const hash = getFileHash(playbook);
        initialTags.push(generateDropletTagForProvision(playbook, hash));
      }

      const result = await api.post<{ droplet: any }>('/droplets', {
        name: this.name,
        region: this.config.region,
        size: this.config.size,
        image: this.config.image,
        ...(sshKeyIds.length && { ssh_keys: sshKeyIds }),
        ...(resolvedVpcUuid && { vpc_uuid: resolvedVpcUuid }),
        ...(initialTags.length && { tags: initialTags }),
      });
      this.dropletId = result.droplet.id;
      this.out.id.resolve(this.dropletId!);
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

      if (this.resolvedIp) {
        this.out.ip.resolve(this.resolvedIp);
        console.log(`   🌐 Public IP: ${this.resolvedIp}`);
      }

      if (this._provision.length > 0) {
        const activeIp = this.resolvedIp ?? '0.0.0.0';
        if (activeIp === '0.0.0.0') {
          throw new Error(`Failed to resolve IP for new droplet "${this.name}" to run playbooks`);
        }

        await this.waitFor(
          `SSH on ${activeIp} to be ready`,
          () => this.checkPort(activeIp, 22),
          { intervalMs: 10_000, timeoutMs: 300_000 }
        );

        for (const playbook of this._provision) {
          await this.runProvisioner(activeIp, playbook);
        }
      }
    } else {
      if (hasChanges) {
        console.log(`✨ Resizing ${this.name} → ${this.config.size}...`);
        await api.post(`/droplets/${this.dropletId}/actions`, { type: 'resize', size: this.config.size });
      }

      if (playbookRunRequired) {
        console.log(`   🔄 Running ${playbooksToRun.length} playbook changes...`);
        const activeIp = this.resolvedIp ?? '0.0.0.0';
        if (activeIp === '0.0.0.0') {
          throw new Error(`Failed to resolve IP for existing droplet "${this.name}" to run playbooks`);
        }

        await this.waitFor(
          `SSH on ${activeIp} to be ready`,
          () => this.checkPort(activeIp, 22),
          { intervalMs: 10_000, timeoutMs: 300_000 }
        );

        for (const p of playbooksToRun) {
          await this.runProvisioner(activeIp, p.path);

          // Update tags on DigitalOcean Droplet
          const oldHash = appliedHashes[p.slug];
          if (oldHash) {
            const oldTag = `puls-h-${p.slug}-${oldHash}`;
            try {
              await api.delete(`/tags/${encodeURIComponent(oldTag)}/resources`, {
                resources: [{ id: String(this.dropletId), type: 'droplet' }]
              });
            } catch {}
          }

          const newTag = `puls-h-${p.slug}-${p.hash}`;
          try {
            await api.post('/tags', { name: newTag });
          } catch {}
          await api.post(`/tags/${encodeURIComponent(newTag)}/resources`, {
            resources: [{ id: String(this.dropletId), type: 'droplet' }]
          });

          appliedHashes[p.slug] = p.hash;
        }
        console.log(`   ✅ Playbooks applied successfully and metadata updated.`);
      }

      if (!hasChanges && !playbookRunRequired) {
        console.log(`✅ ${this.name} is up to date.`);
      }
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

export function parseDropletTagsForProvision(tags: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tag of tags) {
    const match = tag.match(/^puls-h-([a-zA-Z0-9_-]+)-([a-f0-9]{12})$/);
    if (match) {
      const [_, playbookName, hash] = match;
      result[playbookName] = hash;
    }
  }
  return result;
}

export function generateDropletTagForProvision(playbook: string, hash: string): string {
  const baseName = playbook.split('/').pop() ?? playbook;
  const slug = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return `puls-h-${slug}-${hash}`;
}
