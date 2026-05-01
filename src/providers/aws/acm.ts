import {
  ListCertificatesCommand,
  RequestCertificateCommand,
  DescribeCertificateCommand,
} from '@aws-sdk/client-acm';
import { BaseBuilder } from '../../core/resource.ts';
import { getACMClient } from './api.ts';

export class ACMCertificateBuilder extends BaseBuilder {
  resolvedArn: string | null = null;
  validationRecords: { name: string; value: string }[] = [];

  constructor(public domainName: string, public wildcard: boolean = true) {
    super(`acm-${domainName}`);
    this.discoveryPromise = this.discoverCertificate(domainName, wildcard);
  }

  private async discoverCertificate(domain: string, wildcard: boolean): Promise<any> {
    try {
      const acm = getACMClient();
      const primaryName = wildcard ? `*.${domain}` : domain;
      const list = await acm.send(new ListCertificatesCommand({ CertificateStatuses: ['ISSUED', 'PENDING_VALIDATION'] }));
      for (const cert of list.CertificateSummaryList ?? []) {
        if (cert.DomainName === primaryName && cert.CertificateArn) {
          this.resolvedArn = cert.CertificateArn;
          return cert;
        }
      }
      return null;
    } catch (e: any) {
      if (e.name === 'CredentialsProviderError') return null;
      throw e;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🔐 Finalizing ACM Certificate for "${this.domainName}"...`);

    if (existing) {
      console.log(`   ✅ Certificate already exists (${existing.Status ?? 'ISSUED'}): ${this.resolvedArn}`);
      return { arn: this.resolvedArn };
    }

    const primaryName = this.wildcard ? `*.${this.domainName}` : this.domainName;
    const sanNames = this.wildcard ? [this.domainName] : [];

    if (dryRun) {
      console.log(`   📝 [PLAN] Request ${this.wildcard ? 'wildcard ' : ''}certificate: ${primaryName}`);
      console.log(`   📝 [PLAN] DNS validation — CNAME records will be added to Route53`);
      this.resolvedArn = `arn:aws:acm:us-east-1:DRYRUN:certificate/pending`;
      return { arn: this.resolvedArn };
    }

    const acm = getACMClient();
    const result = await acm.send(new RequestCertificateCommand({
      DomainName: primaryName,
      SubjectAlternativeNames: sanNames.length ? sanNames : undefined,
      ValidationMethod: 'DNS',
    }));

    this.resolvedArn = result.CertificateArn!;
    console.log(`🚀 Requested certificate ${primaryName} (arn=${this.resolvedArn})`);

    // Wait for ACM to generate the DNS validation records
    await this.waitFor('validation records to be generated', async () => {
      const detail = await acm.send(new DescribeCertificateCommand({ CertificateArn: this.resolvedArn! }));
      const options = detail.Certificate?.DomainValidationOptions ?? [];
      const records = options.filter(o => o.ResourceRecord);
      if (records.length === 0) return false;

      this.validationRecords = records.map(o => ({
        name: o.ResourceRecord!.Name!,
        value: o.ResourceRecord!.Value!,
      }));
      return true;
    }, { intervalMs: 5_000, timeoutMs: 60_000 });

    console.log(`   🔑 DNS validation records generated (add to Route53 to complete):`);
    for (const r of this.validationRecords) {
      console.log(`      └─ CNAME ${r.name} → ${r.value}`);
    }

    // Actual validation wait happens after Route53 adds the records
    await this.waitFor(`certificate "${this.domainName}" to be validated`, async () => {
      const detail = await acm.send(new DescribeCertificateCommand({ CertificateArn: this.resolvedArn! }));
      return detail.Certificate?.Status === 'ISSUED';
    }, { intervalMs: 15_000, timeoutMs: 600_000 });

    console.log(`   ✅ Certificate issued: ${this.resolvedArn}`);
    return { arn: this.resolvedArn };
  }
}
