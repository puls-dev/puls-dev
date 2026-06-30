import fs from 'fs';
import { homedir } from 'os';
import { OS_IMAGE, LOCATION, SERVER_TYPE } from './types/hcloud.js';
import { Config, BaseBuilder, Output, checkPort, runProvisioner, getFileHash, resourceContextStorage } from '@puls-dev/core';
import { SSHKeyBuilder } from './ssh_key.js';
import { NetworkBuilder } from './network.js';
import { getHCloudApi } from './api.js';

export class ServerBuilder extends BaseBuilder {
  readonly out = {
    ip: new Output<string>(),
    id: new Output<number>(),
  };

  public config: any = {
    image: OS_IMAGE.UBUNTU_24_04,
    location: Config.get().providers.hcloud?.defaultLocation || LOCATION.NBG1,
    server_type: SERVER_TYPE.CX22,
  };

  private serverId?: number;
  private resolvedIp?: string;
  private sshKeyPath?: string;
  private _sshUser?: string;
  private _provision: string[] = [];
  private _forceConfigCheck: boolean = false;
  private _sshKeys: (SSHKeyBuilder | number | string)[] = [];
  private _networks: (NetworkBuilder | number)[] = [];
  private _userData?: string;

  private log(msg: string) {
    console.log(`   🖥️ [HCloud.Server] ${msg}`);
  }

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverServer(name);
  }

  private async discoverServer(name: string): Promise<any> {
    const api = getHCloudApi();
    const data = await api.get<{ servers: any[] }>(`/servers?name=${encodeURIComponent(name)}`);
    const match = data.servers.find(s => s.name === name) ?? null;
    if (match) {
      this.serverId = match.id;
      this.resolvedIp = match.public_net?.ipv4?.ip;
      if (this.serverId) this.out.id.resolve(this.serverId);
      if (this.resolvedIp) this.out.ip.resolve(this.resolvedIp);
    }
    return match;
  }

  override getMonthlyCost(state?: any): number {
    const type = state ? (state.server_type?.name ?? state.server_type) : this.config.server_type;
    const pricing: Record<string, number> = {
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
    return pricing[type] ?? 0;
  }

  image(image: string) {
    this.config.image = image;
    return this;
  }

  location(loc: string) {
    this.config.location = loc;
    return this;
  }

  serverType(type: string) {
    this.config.server_type = type;
    return this;
  }

  sshKey(keyPath: string) {
    this.sshKeyPath = keyPath.replace('~', homedir());
    return this;
  }

  sshUser(user: string) {
    this._sshUser = user;
    return this;
  }

  private resolveUser(): string {
    return (
      this._sshUser ??
      process.env.HCLOUD_SSH_USER ??
      Config.get().providers.hcloud?.sshUser ??
      "root"
    );
  }

  sshKeys(keys: (SSHKeyBuilder | number | string)[]) {
    this._sshKeys = keys;
    return this;
  }

  networks(nets: (NetworkBuilder | number)[]) {
    this._networks = nets;
    return this;
  }

  userData(data: string) {
    this._userData = data;
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

  getDiff(existing: any) {
    const diffs = [];
    if (existing.server_type?.name !== this.config.server_type) {
      diffs.push({ field: "serverType", declared: this.config.server_type, live: existing.server_type?.name });
    }
    if (existing.image?.name !== this.config.image && existing.image?.name !== null) {
      // Note: Hetzner sometimes returns null image name for custom snapshots or older images
      diffs.push({ field: "image", declared: this.config.image, live: existing.image?.name });
    }
    if (existing.datacenter?.location?.name !== this.config.location) {
      diffs.push({ field: "location", declared: this.config.location, live: existing.datacenter?.location?.name });
    }
    return diffs;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getHCloudApi();

    const hasChanges = existing ? this.getDiff(existing).length > 0 : true;

    if (await this.checkProtection(hasChanges)) return null;

    // Provisioning Calculations
    const labels = existing?.labels ?? {};
    const appliedHashes: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) {
      if (k.startsWith("puls-h-")) {
        const playbookSlug = k.substring(7);
        appliedHashes[playbookSlug] = v as string;
      }
    }

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
      this.log(`Planning server "${this.name}"...`);
      if (!existing) {
        this.log(`[PLAN] Create server ${this.name} (${this.config.server_type} in ${this.config.location})`);
        if (this._provision.length > 0) {
          this.log(`      └─ Provision: ${this._provision.join(", ")}`);
        }
        this.out.id.resolve(-1);
        this.out.ip.resolve('0.0.0.0');
      } else if (hasChanges || playbookRunRequired) {
        if (hasChanges) {
          const diffs = this.getDiff(existing);
          this.log(`[PLAN] Recreate server ${this.name} due to changes:`);
          for (const d of diffs) {
            this.log(`      └─ ${d.field}: ${d.live} -> ${d.declared}`);
          }
        }
        if (playbookRunRequired) {
          this.log(`[PLAN] Run ${playbooksToRun.length} playbook changes on existing server:`);
          for (const p of playbooksToRun) {
            this.log(`      └─ Playbook: ${p.path}`);
          }
        }
      } else {
        this.log(`Server is up to date.`);
      }
      for (const sidecar of this.sidecars) await sidecar.deploy();
      return this.config;
    }

    this.log(`Finalizing server...`);

    if (!existing || hasChanges) {
      if (existing && hasChanges) {
        this.log(`Server has drifted or changed critical fields. Re-creating...`);
        await api.delete(`/servers/${existing.id}`);
        await this.waitFor('server deletion to complete', async () => {
          try {
            const res = await api.get<{ servers: any[] }>(`/servers?name=${encodeURIComponent(this.name)}`);
            return !res.servers.some(s => s.name === this.name);
          } catch {
            return true;
          }
        });
      }

      // Resolve SSH Keys
      const sshKeys: (string | number)[] = [];
      for (const k of this._sshKeys) {
        if (k instanceof SSHKeyBuilder) {
          sshKeys.push(await k.out.id.get());
        } else {
          sshKeys.push(k);
        }
      }

      // Resolve Networks
      const networks: number[] = [];
      for (const n of this._networks) {
        if (n instanceof NetworkBuilder) {
          networks.push(await n.out.id.get());
        } else {
          networks.push(n);
        }
      }

      // Create labels for initial playbooks
      const initialLabels: Record<string, string> = {};
      for (const p of declaredPlaybooksWithHashes) {
        initialLabels[`puls-h-${p.slug}`] = p.hash;
      }

      const payload: any = {
        name: this.name,
        server_type: this.config.server_type,
        image: this.config.image,
        location: this.config.location,
        labels: initialLabels,
      };

      if (sshKeys.length > 0) payload.ssh_keys = sshKeys;
      if (networks.length > 0) payload.networks = networks;
      if (this._userData) payload.user_data = this._userData;

      const res = await api.post<{ server: any; action: any }>('/servers', payload);
      this.serverId = res.server.id;
      this.out.id.resolve(res.server.id);
      this.log(`Created server with ID ${this.serverId}. Waiting for action ${res.action.id}...`);

      await api.waitForAction(res.action.id!);

      // Fetch server details to get IP
      const s = await api.get<{ server: any }>(`/servers/${this.serverId}`);
      this.resolvedIp = s.server.public_net?.ipv4?.ip;
      if (this.resolvedIp) {
        this.out.ip.resolve(this.resolvedIp);
        this.log(`Server IP is ${this.resolvedIp}`);
      }

      if (this._provision.length > 0 && this.resolvedIp) {
        await this.waitFor(
          `SSH on ${this.resolvedIp} to be ready`,
          () => checkPort(this.resolvedIp!, 22),
          { intervalMs: 10_000, timeoutMs: 300_000 }
        );

        for (const playbook of this._provision) {
          const keyPath = this.sshKeyPath ? this.sshKeyPath : undefined;
          await runProvisioner(this.resolvedIp, this.resolveUser(), keyPath, playbook);
        }
      }
    } else {
      // Existing server, no critical changes, check for playbook runs
      if (playbookRunRequired) {
        this.log(`Running ${playbooksToRun.length} playbook changes...`);
        if (!this.resolvedIp) {
          throw new Error(`IP not resolved for existing server "${this.name}"`);
        }

        await this.waitFor(
          `SSH on ${this.resolvedIp} to be ready`,
          () => checkPort(this.resolvedIp!, 22),
          { intervalMs: 10_000, timeoutMs: 300_000 }
        );

        const currentLabels = { ...existing.labels };

        for (const p of playbooksToRun) {
          const keyPath = this.sshKeyPath ? this.sshKeyPath : undefined;
          await runProvisioner(this.resolvedIp, this.resolveUser(), keyPath, p.path);
          currentLabels[`puls-h-${p.slug}`] = p.hash;

          // Update labels on Hetzner Cloud Server
          await api.put(`/servers/${this.serverId}`, { labels: currentLabels });
        }
        this.log(`Playbooks applied successfully and metadata updated.`);
      } else {
        this.log(`Server is up to date.`);
      }
    }

    // Register host in context for downstream playbooks
    const context = resourceContextStorage.getStore();
    if (context && context.hosts) {
      const activeIp = this.resolvedIp ?? "0.0.0.0";
      if (!context.hosts.some(h => h.name === this.name)) {
        context.hosts.push({
          name: this.name,
          ip: activeIp,
          user: this.resolveUser(),
          sshKey: this.sshKeyPath,
          provider: "hcloud"
        });
      }
    }

    for (const sidecar of this.sidecars) await sidecar.deploy();
    return this.config;
  }

  async destroy(): Promise<any> {
    const dryRun = this.isDryRunActive();
    await this.discoveryPromise;

    if (!this.serverId) {
      this.log(`Server not found, skipping destroy.`);
      return { destroyed: null };
    }

    this.log(`Destroying server (id=${this.serverId})...`);

    if (dryRun) {
      this.log(`[PLAN] Would delete server id=${this.serverId}`);
    } else {
      const api = getHCloudApi();
      await api.delete(`/servers/${this.serverId}`);
      this.log(`Deleted server.`);
    }

    await this.destroySidecars();
    return { destroyed: this.name };
  }
}
