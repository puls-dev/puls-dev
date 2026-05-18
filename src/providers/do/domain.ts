import { BaseBuilder } from '../../core/resource.js';
import { Output } from '../../core/output.js';
import { DropletBuilder } from './droplet.js';
import { CertificateBuilder } from './certificate.js';
import { getDoApi } from './api.js';

export interface DNSRecord {
  type: 'A' | 'CNAME' | 'TXT' | 'MX';
  name: string;
  value: string | DropletBuilder | Output<string>;
}

export class DomainBuilder extends BaseBuilder {
  private records: DNSRecord[] = [];

  constructor(public domainName: string) {
    super(domainName);
    this.discoveryPromise = this.discoverDomain(domainName);
  }

  private async discoverDomain(name: string): Promise<any> {
    const api = getDoApi();
    try {
      return await api.get<{ domain: any }>(`/domains/${name}`).then(d => d.domain);
    } catch {
      return null;
    }
  }

  withSSL() {
    const cert = new CertificateBuilder(this.domainName);
    this.sidecars.push(cert);
    return this;
  }

  pointer(name: string, target: DropletBuilder | Output<string> | string) {
    this.records.push({ type: 'A', name, value: target });
    return this;
  }

  cname(name: string, target: string) {
    this.records.push({ type: 'CNAME', name, value: target });
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getDoApi();

    console.log(`\n🌐 Finalizing DNS for "${this.domainName}"...`);

    if (!existing) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create domain ${this.domainName}`);
      } else {
        await api.post('/domains', { name: this.domainName });
        console.log(`🚀 Created domain ${this.domainName}`);
      }
    }

    for (const record of this.records) {
      let data: string;

      if (record.value instanceof Output) {
        data = await record.value.get();
      } else if (record.value instanceof DropletBuilder) {
        data = (await record.value.getPublicIp()) ?? `[IP of ${record.value.name} — not found]`;
      } else {
        data = record.value;
      }

      if (dryRun) {
        console.log(`   📝 [PLAN] ${record.type} ${record.name}.${this.domainName} → ${data}`);
        continue;
      }

      // Delete existing record with same type+name before creating
      const existing_records = await api.get<{ domain_records: any[] }>(
        `/domains/${this.domainName}/records?per_page=200`,
      );
      const dupe = existing_records.domain_records.find(
        r => r.type === record.type && r.name === record.name,
      );
      if (dupe) await api.delete(`/domains/${this.domainName}/records/${dupe.id}`);

      await api.post(`/domains/${this.domainName}/records`, {
        type: record.type,
        name: record.name,
        data,
        ttl: 3600,
      });

      console.log(`   ✅ ${record.type} ${record.name}.${this.domainName} → ${data}`);
    }

    await this.deploySidecars();
    return { domain: this.domainName, records: this.records };
  }
}
