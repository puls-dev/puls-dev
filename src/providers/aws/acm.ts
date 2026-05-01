import { BaseBuilder } from '../../core/resource.ts';

export class ACMCertificateBuilder extends BaseBuilder {
  resolvedArn: string | null = null;

  constructor(public domainName: string, public wildcard: boolean = true) {
    super(`acm-${domainName}`);
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    console.log(`\n🔐 Finalizing ACM Certificate for "${this.domainName}"...`);
    console.log(`   ✅ [${dryRun ? 'PLAN' : 'OK'}] Requesting ${this.wildcard ? 'Wildcard ' : ''}Certificate (us-east-1)`);
    console.log(`   ✅ [${dryRun ? 'PLAN' : 'OK'}] Creating Route53 DNS Validation Records`);

    await this.waitFor(
      `certificate for "${this.domainName}" to be validated`,
      async () => {
        // Real: check acm.describeCertificate() status === 'ISSUED'
        return true; // mock: immediately validated
      },
      { intervalMs: 10_000, timeoutMs: 600_000 }, // DNS validation typically 1-5 min
    );

    this.resolvedArn = `arn:aws:acm:us-east-1:123456789:certificate/mock-${this.domainName}`;
    return { arn: this.resolvedArn };
  }
}
