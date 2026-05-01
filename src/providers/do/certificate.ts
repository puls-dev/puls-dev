import { BaseBuilder } from '../../core/resource.ts';
import { getDoApi } from './api.ts';

export class CertificateBuilder extends BaseBuilder {
  constructor(public domainName: string) {
    super(`ssl-${domainName}`);
    this.discoveryPromise = this.discoverCertificate(this.name);
  }

  private async discoverCertificate(name: string): Promise<any> {
    const api = getDoApi();
    const data = await api.get<{ certificates: any[] }>('/certificates?per_page=200');
    return data.certificates.find(c => c.name === name) ?? null;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🔐 Finalizing SSL certificate for "${this.domainName}"...`);

    if (existing) {
      console.log(`   ✅ Certificate ${this.name} already exists (state=${existing.state}).`);
      return existing;
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Create Let's Encrypt certificate for *.${this.domainName}`);
      return { name: this.name };
    }

    const api = getDoApi();
    const result = await api.post<{ certificate: any }>('/certificates', {
      name: this.name,
      type: 'lets_encrypt',
      dns_names: [`*.${this.domainName}`, this.domainName],
    });

    console.log(`🚀 Requested certificate ${this.name} (id=${result.certificate.id})`);
    return result.certificate;
  }
}
