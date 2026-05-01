import {
  ListHostedZonesByNameCommand,
  CreateHostedZoneCommand,
  ChangeResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import { BaseBuilder } from '../../core/resource.ts';
import { ACMCertificateBuilder } from './acm.ts';
import { getR53Client } from './api.ts';
import type { RegistrantContact } from '../../types/aws.ts';

export class Route53Builder extends BaseBuilder {
  public zoneName: string;
  public zoneId?: string;
  private records: any[] = [];
  private _isRegistering: boolean = false;
  private _registrantContact?: RegistrantContact;
  private _wantsWildcardSSL: boolean = false;

  constructor(zoneName: string = '') {
    super(zoneName || 'route53-pending');
    this.zoneName = zoneName;
    this.discoveryPromise = this.discoverZone(zoneName);
  }

  private async discoverZone(name: string): Promise<any> {
    if (!name) return null;
    try {
      const r53 = getR53Client();
      const result = await r53.send(new ListHostedZonesByNameCommand({ DNSName: name, MaxItems: 5 }));
      const match = (result.HostedZones ?? []).find(z => z.Name === `${name}.`);
      if (match) {
        this.zoneId = match.Id!.replace('/hostedzone/', '');
        return match;
      }
      return null;
    } catch (e: any) {
      if (e.name === 'CredentialsProviderError') return null;
      throw e;
    }
  }

  randomDomain() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const id = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    this.zoneName = `${id}.com`;
    this.name = this.zoneName;
    this.discoveryPromise = this.discoverZone(this.zoneName);
    return this;
  }

  cert(): ACMCertificateBuilder | undefined {
    return this.sidecars.find(s => s instanceof ACMCertificateBuilder) as ACMCertificateBuilder | undefined;
  }

  withWildcardSSL() {
    this._wantsWildcardSSL = true;
    return this;
  }

  register(contact?: RegistrantContact) {
    this._isRegistering = true;
    this._registrantContact = contact;
    return this;
  }

  record(name: string, type: 'A' | 'CNAME' | 'AAAA', value: string) {
    this.records.push({ name, type, value });
    return this;
  }

  pointer(name: string, target: BaseBuilder) {
    this.records.push({ name, type: 'A', value: target, isAlias: true });
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const r53 = getR53Client();

    console.log(`\n🗺️  Finalizing Route53 Zone "${this.zoneName}"...`);

    if (!existing) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create hosted zone ${this.zoneName}`);
      } else {
        const result = await r53.send(new CreateHostedZoneCommand({
          Name: this.zoneName,
          CallerReference: `opsdsl-${Date.now()}`,
        }));
        this.zoneId = result.HostedZone!.Id!.replace('/hostedzone/', '');
        console.log(`🚀 Created hosted zone ${this.zoneName} (id=${this.zoneId})`);
      }
    } else {
      console.log(`   ✅ Hosted zone ${this.zoneName} exists (id=${this.zoneId})`);
    }

    if (this._wantsWildcardSSL && !this.cert()) {
      const cert = new ACMCertificateBuilder(this.zoneName, true);
      this.sidecars.push(cert);
    }

    // Deploy ACM cert first so we can add its validation records
    const cert = this.cert();
    if (cert) {
      await cert.deploy();

      // Add DNS validation CNAMEs to this zone
      if (!dryRun && cert.validationRecords.length > 0 && this.zoneId) {
        await this.upsertRecords(r53, cert.validationRecords.map(r => ({
          type: 'CNAME',
          name: r.name,
          value: r.value,
          ttl: 300,
        })));
        console.log(`   ✅ Added ${cert.validationRecords.length} ACM validation CNAME(s)`);
      }
    }

    // Regular records
    if (this.records.length > 0 && !dryRun && this.zoneId) {
      const resolved = this.records.map(r => ({
        type: r.type,
        name: r.name,
        value: r.value instanceof BaseBuilder ? `[alias: ${r.value.name}]` : r.value,
      }));
      await this.upsertRecords(r53, resolved.map(r => ({ ...r, ttl: 300 })));
    }

    for (const rec of this.records) {
      const val = rec.value instanceof BaseBuilder ? `[Alias to ${rec.value.name}]` : rec.value;
      console.log(`   ✅ [${dryRun ? 'PLAN' : 'OK'}] ${rec.type}: ${rec.name}.${this.zoneName} → ${val}`);
    }

    return { zone: this.zoneName, id: this.zoneId };
  }

  async upsertCnames(records: { name: string; value: string }[]) {
    if (!this.zoneId) throw new Error(`Zone ${this.zoneName} has no ID — was it deployed?`);
    const r53 = getR53Client();
    await this.upsertRecords(r53, records.map(r => ({ type: 'CNAME', name: `${r.name}.${this.zoneName}`, value: r.value, ttl: 300 })));
    for (const r of records) {
      console.log(`   ✅ CNAME ${r.name}.${this.zoneName} → ${r.value}`);
    }
  }

  private async upsertRecords(r53: ReturnType<typeof getR53Client>, records: { type: string; name: string; value: string; ttl: number }[]) {
    await r53.send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: this.zoneId!,
      ChangeBatch: {
        Changes: records.map(r => ({
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: r.name,
            Type: r.type as any,
            TTL: r.ttl,
            ResourceRecords: [{ Value: r.value }],
          },
        })),
      },
    }));
  }
}
