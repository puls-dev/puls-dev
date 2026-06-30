import { BaseBuilder, Output, Config } from '@puls-dev/core';
import { getHCloudApi } from './api.js';
import { ServerBuilder } from './server.js';

export interface HCloudForwardingRule {
  listenPort: number;
  targetPort: number;
  protocol: 'http' | 'https' | 'tcp';
}

export class LoadBalancerBuilder extends BaseBuilder {
  readonly out = {
    id: new Output<number>(),
    ip: new Output<string>(),
  };

  private _type: string = 'lb11';
  private _location: string = Config.get().providers.hcloud?.defaultLocation || 'nbg1';
  private _algorithm: 'round_robin' | 'least_connections' = 'round_robin';
  private _services: HCloudForwardingRule[] = [];
  private _targets: (ServerBuilder | number)[] = [];
  private lbId?: number;
  private resolvedIp?: string;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverLb(name);
  }

  private async discoverLb(name: string): Promise<any> {
    const api = getHCloudApi();
    const data = await api.get<{ load_balancers: any[] }>('/load_balancers');
    const match = data.load_balancers.find(lb => lb.name === name) ?? null;
    if (match) {
      this.lbId = match.id;
      this.resolvedIp = match.public_net?.ipv4?.ip;
      this.out.id.resolve(match.id);
      if (this.resolvedIp) this.out.ip.resolve(this.resolvedIp);
    }
    return match;
  }

  type(lbType: string) {
    this._type = lbType;
    return this;
  }

  location(loc: string) {
    this._location = loc;
    return this;
  }

  algorithm(algo: 'round_robin' | 'least_connections') {
    this._algorithm = algo;
    return this;
  }

  forward(listenPort: number, targetPort: number, protocol: 'http' | 'https' | 'tcp' = 'http') {
    this._services.push({ listenPort, targetPort, protocol });
    return this;
  }

  target(...servers: (ServerBuilder | number)[]) {
    this._targets.push(...servers);
    return this;
  }

  private log(msg: string) {
    console.log(`   ⚖️ [HCloud.LoadBalancer] ${msg}`);
  }

  getDiff(existing: any) {
    const diffs = [];
    if (existing && existing.load_balancer_type?.name !== this._type) {
      diffs.push({ field: "type", declared: this._type, live: existing.load_balancer_type?.name });
    }
    if (existing && existing.location?.name !== this._location) {
      diffs.push({ field: "location", declared: this._location, live: existing.location?.name });
    }
    if (existing && existing.algorithm?.type !== this._algorithm) {
      diffs.push({ field: "algorithm", declared: this._algorithm, live: existing.algorithm?.type });
    }
    return diffs;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getHCloudApi();

    const hasChanges = existing ? this.getDiff(existing).length > 0 : true;

    // Resolve Targets
    const targetServerIds: number[] = [];
    for (const t of this._targets) {
      if (t instanceof ServerBuilder) {
        targetServerIds.push(await t.out.id.get());
      } else {
        targetServerIds.push(t);
      }
    }

    if (dryRun) {
      this.log(`Planning load balancer "${this.name}"...`);
      if (!existing) {
        this.log(`[PLAN] Create load balancer ${this.name} (${this._type} in ${this._location})`);
        this._services.forEach(s => {
          this.log(`      └─ Forward: ${s.protocol.toUpperCase()} ${s.listenPort} -> ${s.targetPort}`);
        });
        if (targetServerIds.length > 0) {
          this.log(`      └─ Targets: [${targetServerIds.join(', ')}]`);
        }
        this.out.id.resolve(-1);
        this.out.ip.resolve('0.0.0.0');
      } else if (hasChanges) {
        this.log(`[PLAN] Recreate load balancer ${this.name} due to type/location change`);
      } else {
        this.log(`Load balancer is up to date.`);
      }
      return;
    }

    this.log(`Finalizing load balancer...`);

    const servicesPayload = this._services.map(s => ({
      protocol: s.protocol,
      listen_port: s.listenPort,
      destination_port: s.targetPort,
      proxyprotocol: false,
      health_check: {
        protocol: s.protocol === 'tcp' ? 'tcp' : 'http',
        port: s.targetPort,
        interval: 15,
        timeout: 10,
        retries: 3,
        ...(s.protocol !== 'tcp' && {
          http: {
            path: '/',
            status_codes: ['2??', '3??']
          }
        })
      }
    }));

    const targetsPayload = targetServerIds.map(id => ({
      type: 'server',
      server: { id }
    }));

    if (!existing || hasChanges) {
      if (existing && hasChanges) {
        this.log(`Load balancer type/location changed. Re-creating...`);
        await api.delete(`/load_balancers/${existing.id}`);
        await this.waitFor('load balancer deletion to complete', async () => {
          try {
            const res = await api.get<{ load_balancers: any[] }>('/load_balancers');
            return !res.load_balancers.some(lb => lb.name === this.name);
          } catch {
            return true;
          }
        });
      }

      const res = await api.post<{ load_balancer: any; action: any }>('/load_balancers', {
        name: this.name,
        load_balancer_type: this._type,
        location: this._location,
        algorithm: { type: this._algorithm },
        services: servicesPayload,
        targets: targetsPayload,
      });

      this.lbId = res.load_balancer.id;
      this.resolvedIp = res.load_balancer.public_net?.ipv4?.ip;
      this.out.id.resolve(this.lbId!);
      if (this.resolvedIp) this.out.ip.resolve(this.resolvedIp);

      await api.waitForAction(res.action.id);
      this.log(`Created load balancer (id=${this.lbId}, ip=${this.resolvedIp})`);
    } else {
      // Update existing load balancer services/targets if they differ
      const currentServices = existing.services || [];
      const currentTargets = existing.targets || [];

      // Check if services match
      const servicesChanged = servicesPayload.length !== currentServices.length ||
        servicesPayload.some((s, idx) => {
          const curr = currentServices[idx];
          return !curr || curr.listen_port !== s.listen_port || curr.destination_port !== s.destination_port || curr.protocol !== s.protocol;
        });

      if (servicesChanged) {
        this.log(`Updating services...`);
        // Delete old services
        for (const s of currentServices) {
          const res = await api.post<{ action: any }>(`/load_balancers/${this.lbId}/actions/delete_service`, {
            listen_port: s.listen_port
          });
          await api.waitForAction(res.action.id);
        }
        // Add new services
        for (const s of servicesPayload) {
          const res = await api.post<{ action: any }>(`/load_balancers/${this.lbId}/actions/add_service`, s);
          await api.waitForAction(res.action.id);
        }
      }

      // Check if targets match
      const currentTargetServerIds = currentTargets
        .filter((t: any) => t.type === 'server')
        .map((t: any) => t.server.id);

      const targetsChanged = targetServerIds.length !== currentTargetServerIds.length ||
        targetServerIds.some(id => !currentTargetServerIds.includes(id));

      if (targetsChanged) {
        this.log(`Updating targets...`);
        // Remove old targets
        for (const t of currentTargets) {
          if (t.type === 'server') {
            const res = await api.post<{ action: any }>(`/load_balancers/${this.lbId}/actions/remove_target`, {
              type: 'server',
              server: { id: t.server.id }
            });
            await api.waitForAction(res.action.id);
          }
        }
        // Add new targets
        for (const id of targetServerIds) {
          const res = await api.post<{ action: any }>(`/load_balancers/${this.lbId}/actions/add_target`, {
            type: 'server',
            server: { id }
          });
          await api.waitForAction(res.action.id);
        }
      }

      this.log(`Load balancer is up to date.`);
    }
  }

  async destroy() {
    const existing = await this.discoveryPromise;
    if (existing) {
      this.log(`Deleting load balancer...`);
      const api = getHCloudApi();
      await api.delete(`/load_balancers/${existing.id}`);
      this.log(`Deleted load balancer.`);
    } else {
      this.log(`Load balancer does not exist. Skipping deletion.`);
    }
  }
}
