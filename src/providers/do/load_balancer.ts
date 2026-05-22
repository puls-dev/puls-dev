import { BaseBuilder } from '../../core/resource.js';
import { Config } from '../../core/config.js';
import { DropletBuilder } from './droplet.js';
import { CertificateBuilder } from './certificate.js';
import { getDoApi } from './api.js';

export interface HealthCheckOpts {
  protocol: 'http' | 'https' | 'tcp';
  port: number;
  path?: string;
  checkIntervalSeconds?: number;
  responseTimeoutSeconds?: number;
  unhealthyThreshold?: number;
  healthyThreshold?: number;
}

export interface StickySessionOpts {
  type: 'cookies' | 'none';
  cookieName?: string;
  cookieTtlSeconds?: number;
}

export interface ForwardingRule {
  entryProtocol: 'http' | 'https' | 'tcp' | string;
  entryPort: number;
  targetProtocol: 'http' | 'https' | 'tcp' | string;
  targetPort: number;
  certificate?: string | CertificateBuilder;
  tlsPassthrough?: boolean;
}

export class LoadBalancerBuilder extends BaseBuilder {
  private _region: string = Config.get().providers.do?.defaultRegion ?? 'fra1';
  private targetNames: string[] = [];
  private forwardingRules: ForwardingRule[] = [];
  private healthCheckConfig?: HealthCheckOpts;
  private stickySessionConfig?: StickySessionOpts;
  private lbId?: string;

  constructor(public override name: string) {
    super(name);
    this.discoveryPromise = this.discoverLb(name);
  }

  private async discoverLb(name: string): Promise<any> {
    const api = getDoApi();
    try {
      const data = await api.get<{ load_balancers: any[] }>('/load_balancers?per_page=200');
      const match = data.load_balancers.find(lb => lb.name === name) ?? null;
      if (match) {
        this.lbId = match.id;
      }
      return match;
    } catch {
      return null;
    }
  }

  region(region: string) {
    this._region = region;
    return this;
  }

  targets(droplets: (DropletBuilder | string)[]) {
    this.targetNames = droplets.map(d => (typeof d === 'string' ? d : d.name));
    return this;
  }

  target(...droplets: (DropletBuilder | string)[]) {
    return this.targets(droplets);
  }

  forward(
    entryProtocol: 'http' | 'https' | 'tcp' | string,
    entryPort: number,
    targetProtocol: 'http' | 'https' | 'tcp' | string,
    targetPort: number,
    certificate?: string | CertificateBuilder,
    tlsPassthrough?: boolean
  ) {
    this.forwardingRules.push({
      entryProtocol,
      entryPort,
      targetProtocol,
      targetPort,
      certificate,
      tlsPassthrough,
    });
    return this;
  }

  healthCheck(opts: HealthCheckOpts) {
    this.healthCheckConfig = {
      protocol: opts.protocol,
      port: opts.port,
      path: opts.path ?? (opts.protocol === 'tcp' ? undefined : '/'),
      checkIntervalSeconds: opts.checkIntervalSeconds ?? 10,
      responseTimeoutSeconds: opts.responseTimeoutSeconds ?? 5,
      unhealthyThreshold: opts.unhealthyThreshold ?? 3,
      healthyThreshold: opts.healthyThreshold ?? 5,
    };
    return this;
  }

  stickySession(type: 'cookies' | 'none', cookieName?: string, cookieTtlSeconds?: number) {
    this.stickySessionConfig = {
      type,
      ...(cookieName && { cookieName }),
      ...(cookieTtlSeconds && { cookieTtlSeconds }),
    };
    return this;
  }

  private async resolveDropletIds(): Promise<number[]> {
    const api = getDoApi();
    const ids: number[] = [];
    for (const name of this.targetNames) {
      const data = await api.get<{ droplets: any[] }>(`/droplets?name=${encodeURIComponent(name)}&per_page=200`);
      const match = data.droplets.find(d => d.name === name);
      if (match) ids.push(match.id);
    }
    return ids.sort((a, b) => a - b);
  }

  private async resolveCertificateId(cert: string | CertificateBuilder): Promise<string> {
    const api = getDoApi();
    const name = cert instanceof CertificateBuilder ? cert.name : cert;

    // Check if it's already a UUID
    if (typeof cert === 'string' && cert.length === 36 && cert.includes('-')) {
      return cert;
    }

    const data = await api.get<{ certificates: any[] }>('/certificates?per_page=200');
    const match = data.certificates.find(c => c.name === name || c.id === name);
    if (!match) {
      throw new Error(`[LoadBalancer:${this.name}] Certificate "${name}" not found in DO account.`);
    }
    return match.id;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getDoApi();

    console.log(`\n⚖️  Finalizing load balancer "${this.name}"...`);

    // 1. Resolve Target Droplet IDs
    const dropletIds = dryRun ? [12345] : await this.resolveDropletIds();

    // 2. Build Forwarding Rules
    const finalRules: any[] = [];
    const rulesToResolve = this.forwardingRules.length > 0 
      ? this.forwardingRules 
      : [
          {
            entryProtocol: 'http',
            entryPort: 80,
            targetProtocol: 'http',
            targetPort: 80,
          }
        ];

    for (const rule of rulesToResolve) {
      let certId: string | undefined;
      if (rule.certificate) {
        certId = dryRun ? 'mock-cert-uuid' : await this.resolveCertificateId(rule.certificate);
      }
      finalRules.push({
        entry_protocol: rule.entryProtocol.toLowerCase(),
        entry_port: rule.entryPort,
        target_protocol: rule.targetProtocol.toLowerCase(),
        target_port: rule.targetPort,
        ...(certId && { certificate_id: certId }),
        ...(rule.tlsPassthrough !== undefined && { tls_passthrough: rule.tlsPassthrough }),
      });
    }

    // 3. Build Health Check Config
    const finalHealthCheck = this.healthCheckConfig 
      ? {
          protocol: this.healthCheckConfig.protocol.toLowerCase(),
          port: this.healthCheckConfig.port,
          ...(this.healthCheckConfig.path && { path: this.healthCheckConfig.path }),
          check_interval_seconds: this.healthCheckConfig.checkIntervalSeconds,
          response_timeout_seconds: this.healthCheckConfig.responseTimeoutSeconds,
          unhealthy_threshold: this.healthCheckConfig.unhealthyThreshold,
          healthy_threshold: this.healthCheckConfig.healthyThreshold,
        }
      : {
          protocol: 'http',
          port: 80,
          path: '/',
          check_interval_seconds: 10,
          response_timeout_seconds: 5,
          unhealthy_threshold: 3,
          healthy_threshold: 5,
        };

    // 4. Build Sticky Sessions Config
    const finalStickySessions = this.stickySessionConfig 
      ? {
          type: this.stickySessionConfig.type,
          ...(this.stickySessionConfig.cookieName && { cookie_name: this.stickySessionConfig.cookieName }),
          ...(this.stickySessionConfig.cookieTtlSeconds && { cookie_ttl_seconds: this.stickySessionConfig.cookieTtlSeconds }),
        }
      : {
          type: 'none',
        };

    // 5. Compare configuration for idempotent update
    const resolvedRegion = this._region;
    
    let hasChanges = true;
    if (existing) {
      const regionMatch = existing.region?.slug === resolvedRegion;
      const dropletsMatch = arraysEqual(existing.droplet_ids, dropletIds);
      const rulesMatch = rulesEqual(existing.forwarding_rules, finalRules);
      const healthMatch = healthCheckEqual(existing.health_check, finalHealthCheck);
      const stickyMatch = stickySessionsEqual(existing.sticky_sessions, finalStickySessions);
      
      hasChanges = !regionMatch || !dropletsMatch || !rulesMatch || !healthMatch || !stickyMatch;
    }

    if (await this.checkProtection(hasChanges)) return null;

    if (dryRun) {
      if (!existing) {
        console.log(`   📝 [PLAN] Create load balancer ${this.name} in ${resolvedRegion}`);
        console.log(`      └─ Targets: [${this.targetNames.join(', ')}]`);
        console.log(`      └─ Rules: ${JSON.stringify(finalRules)}`);
        console.log(`      └─ Health Check: ${JSON.stringify(finalHealthCheck)}`);
        console.log(`      └─ Sticky Sessions: ${JSON.stringify(finalStickySessions)}`);
      } else if (hasChanges) {
        console.log(`   📝 [PLAN] Update load balancer ${this.name} in ${resolvedRegion}`);
        console.log(`      └─ Target updates or config changes detected.`);
        console.log(`      └─ Targets: [${this.targetNames.join(', ')}]`);
        console.log(`      └─ Rules: ${JSON.stringify(finalRules)}`);
      } else {
        console.log(`   ✅ Load balancer ${this.name} is up to date.`);
      }
      for (const sidecar of this.sidecars) await sidecar.deploy();
      return existing || { name: this.name, region: resolvedRegion, forwarding_rules: finalRules };
    }

    if (!existing) {
      const result = await api.post<{ load_balancer: any }>('/load_balancers', {
        name: this.name,
        region: resolvedRegion,
        forwarding_rules: finalRules,
        health_check: finalHealthCheck,
        sticky_sessions: finalStickySessions,
        droplet_ids: dropletIds,
      });

      this.lbId = result.load_balancer.id;
      console.log(`🚀 Created load balancer ${this.name} (id=${this.lbId})`);
      if (this.targetNames.length) console.log(`   Targets: [${this.targetNames.join(', ')}]`);
      
      for (const sidecar of this.sidecars) await sidecar.deploy();
      return result.load_balancer;
    } else if (hasChanges) {
      console.log(`✨ Updating load balancer ${this.name} (id=${this.lbId})...`);
      const result = await api.put<{ load_balancer: any }>(`/load_balancers/${this.lbId}`, {
        name: this.name,
        region: resolvedRegion,
        forwarding_rules: finalRules,
        health_check: finalHealthCheck,
        sticky_sessions: finalStickySessions,
        droplet_ids: dropletIds,
      });
      console.log(`   ✅ Load balancer updated.`);
      
      for (const sidecar of this.sidecars) await sidecar.deploy();
      return result.load_balancer;
    } else {
      console.log(`✅ Load balancer ${this.name} is up to date.`);
      for (const sidecar of this.sidecars) await sidecar.deploy();
      return existing;
    }
  }

  async destroy(): Promise<any> {
    const dryRun = this.isDryRunActive();
    await this.discoveryPromise;

    if (!this.lbId) {
      console.log(`\n🗑️  "${this.name}" not found, nothing to destroy.`);
      return { destroyed: null };
    }

    console.log(`\n🗑️  Destroying load balancer "${this.name}" (id=${this.lbId})...`);

    if (dryRun) {
      console.log(`   📝 [PLAN] Would delete load balancer id=${this.lbId}`);
    } else {
      await getDoApi().delete(`/load_balancers/${this.lbId}`);
      console.log(`   ✅ Deleted.`);
    }

    await this.destroySidecars();
    return { destroyed: this.name };
  }
}

// Helpers for structural comparisons
function arraysEqual(a: any[], b: any[]): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((val, index) => val === sortedB[index]);
}

function rulesEqual(existingRules: any[], targetRules: any[]): boolean {
  if (!existingRules || !targetRules) return existingRules === targetRules;
  if (existingRules.length !== targetRules.length) return false;
  
  const sortKey = (r: any) => `${r.entry_protocol}:${r.entry_port}:${r.target_protocol}:${r.target_port}`;
  const sortedExisting = [...existingRules].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const sortedTarget = [...targetRules].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  return sortedExisting.every((ext, i) => {
    const tgt = sortedTarget[i];
    return (
      ext.entry_protocol === tgt.entry_protocol &&
      ext.entry_port === tgt.entry_port &&
      ext.target_protocol === tgt.target_protocol &&
      ext.target_port === tgt.target_port &&
      (ext.certificate_id ?? '') === (tgt.certificate_id ?? '') &&
      Boolean(ext.tls_passthrough) === Boolean(tgt.tls_passthrough)
    );
  });
}

function healthCheckEqual(ext: any, tgt: any): boolean {
  if (!ext || !tgt) return ext === tgt;
  return (
    ext.protocol === tgt.protocol &&
    ext.port === tgt.port &&
    (ext.path ?? '/') === (tgt.path ?? '/') &&
    ext.check_interval_seconds === tgt.check_interval_seconds &&
    ext.response_timeout_seconds === tgt.response_timeout_seconds &&
    ext.unhealthy_threshold === tgt.unhealthy_threshold &&
    ext.healthy_threshold === tgt.healthy_threshold
  );
}

function stickySessionsEqual(ext: any, tgt: any): boolean {
  if (!ext || !tgt) return ext === tgt;
  const extType = ext.type ?? 'none';
  const tgtType = tgt.type ?? 'none';
  if (extType !== tgtType) return false;
  if (extType === 'none') return true;
  return (
    ext.cookie_name === tgt.cookie_name &&
    ext.cookie_ttl_seconds === tgt.cookie_ttl_seconds
  );
}
