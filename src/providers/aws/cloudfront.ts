import { BaseBuilder } from "../../core/resource.ts";
import { S3BucketBuilder } from "./s3.ts";
import { ACMCertificateBuilder } from "./acm.ts";
import { Route53Builder } from "./route53.ts";

export class CloudFrontBuilder extends BaseBuilder {
  resolvedArn: string | null = null;
  private _origin: any;
  private _aliases: string[] = [];
  private _referenceId?: string;
  private _kvsName?: string;
  private _certRef?: ACMCertificateBuilder;

  constructor(name: string) {
    super(name);
  }

  withRedirector(opts: { kvs: string }) {
    this._kvsName = opts.kvs;
    return this;
  }

  copyFrom(distributionId: string) {
    this._referenceId = distributionId;
    return this;
  }

  // Clone reference distribution and attach domain aliases + cert from a Route53Builder.
  // prefixes become subdomain aliases: ['ec', 'nc'] → ['ec.domain.com', 'nc.domain.com']
  forDomain(zone: Route53Builder, prefixes: string[]) {
    this._aliases = prefixes.map((p) => `${p}.${zone.zoneName}`);
    const cert = zone.cert();
    if (cert) this._certRef = cert;
    return this;
  }

  origin(source: S3BucketBuilder | string) {
    this._origin = source;
    if (source instanceof S3BucketBuilder) {
      console.log(
        `   💡 [Auto] Detected S3 Origin. Preparing OAC and Bucket Policy for "${source.bucketName}"`,
      );
    }
    return this;
  }

  dns(aliases: string | string[]) {
    this._aliases = Array.isArray(aliases) ? aliases : [aliases];
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    console.log(`\n⚡ Finalizing CloudFront Distribution "${this.name}"...`);

    if (this._referenceId) {
      console.log(
        `   ✅ [${dryRun ? "PLAN" : "OK"}] Cloning config from reference distribution: ${this._referenceId}`,
      );
    }

    if (this._aliases.length > 0) {
      console.log(
        `   ✅ [${dryRun ? "PLAN" : "OK"}] Aliases: [${this._aliases.join(", ")}]`,
      );
    }

    if (this._certRef) {
      const certArn = this._certRef.resolvedArn ?? "pending";
      console.log(
        `   ✅ [${dryRun ? "PLAN" : "OK"}] ACM Certificate: ${certArn}`,
      );
    }

    if (this._kvsName) {
      console.log(
        `   ✅ [${dryRun ? "PLAN" : "OK"}] Associating CloudFront Function + KVS Store: ${this._kvsName}`,
      );
    }

    if (this._origin) {
      const originName =
        this._origin instanceof S3BucketBuilder
          ? this._origin.bucketName
          : this._origin;
      console.log(`   ✅ [${dryRun ? "PLAN" : "OK"}] Origin: ${originName}`);
    }

    const mockId = `CF-${this.name.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
    this.resolvedArn = `arn:aws:cloudfront::123456789012:distribution/${mockId}`;

    await this.waitFor(
      `distribution "${this.name}" to finish deploying`,
      async () => {
        // Real: check cloudfront.getDistribution() status === 'Deployed'
        return true; // mock: immediately deployed
      },
      { intervalMs: 20_000, timeoutMs: 1_200_000 }, // CF propagation can take ~15-20 min
    );

    return { id: mockId, arn: this.resolvedArn, name: this.name };
  }
}
