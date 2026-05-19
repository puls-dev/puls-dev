import {
  ListDistributionsCommand,
  GetDistributionCommand,
  CreateDistributionCommand,
  GetDistributionConfigCommand,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { BaseBuilder } from "../../core/resource.js";
import { S3BucketBuilder } from "./s3.js";
import { ACMCertificateBuilder } from "./acm.js";
import { Route53Builder } from "./route53.js";
import { getCFClient } from "./api.js";

export class CloudFrontBuilder extends BaseBuilder {
  resolvedArn: string | null = null;
  resolvedId: string | null = null;
  private _origin: any;
  private _aliases: string[] = [];
  private _prefixes: string[] = [];
  private _zone?: Route53Builder;
  private _referenceId?: string;
  private _kvsName?: string;
  private _certRef?: ACMCertificateBuilder;
  private _invalidatePaths?: string[];

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverDistribution(name);
  }

  private async discoverDistribution(name: string): Promise<any> {
    try {
      const cf = getCFClient();
      const list = await cf.send(new ListDistributionsCommand({}));
      const items = list.DistributionList?.Items ?? [];
      const match = items.find((d) => d.Comment === name || d.Id === name);
      if (match) {
        this.resolvedId = match.Id!;
        this.resolvedArn = match.ARN!;
      }
      return match ?? null;
    } catch (e: any) {
      if (e.name === "CredentialsProviderError") return null;
      throw e;
    }
  }

  invalidate(paths: string[]) {
    this._invalidatePaths = paths;
    return this;
  }

  withRedirector(opts: { kvs: string }) {
    this._kvsName = opts.kvs;
    return this;
  }

  copyFrom(distributionId: string) {
    this._referenceId = distributionId;
    return this;
  }

  forDomain(zone: Route53Builder, prefixes: string[]) {
    this._zone = zone;
    this._prefixes = prefixes;
    this._aliases = prefixes.map((p) => `${p}.${zone.zoneName}`);
    const cert = zone.cert();
    if (cert) this._certRef = cert;
    return this;
  }

  origin(source: S3BucketBuilder | string) {
    this._origin = source;
    return this;
  }

  dns(aliases: string | string[]) {
    this._aliases = Array.isArray(aliases) ? aliases : [aliases];
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const cf = getCFClient();

    console.log(`\n⚡ Finalizing CloudFront Distribution "${this.name}"...`);

    if (existing) {
      this.resolvedId = existing.Id;
      this.resolvedArn = existing.ARN;
      console.log(
        `   ✅ Distribution "${this.name}" exists (id=${this.resolvedId})`,
      );
      if (this._aliases.length)
        console.log(`   ✅ Aliases: [${this._aliases.join(", ")}]`);

      if (this._invalidatePaths?.length) {
        if (dryRun) {
          console.log(
            `   📝 [PLAN] Invalidate: ${this._invalidatePaths.join(", ")}`,
          );
        } else {
          await cf.send(
            new CreateInvalidationCommand({
              DistributionId: this.resolvedId!,
              InvalidationBatch: {
                Paths: {
                  Quantity: this._invalidatePaths.length,
                  Items: this._invalidatePaths,
                },
                CallerReference: `puls-${Date.now()}`,
              },
            }),
          );
          console.log(`   ✅ Invalidated: ${this._invalidatePaths.join(", ")}`);
        }
      }

      return { id: this.resolvedId, arn: this.resolvedArn, name: this.name };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Create distribution "${this.name}"`);
      if (this._referenceId)
        console.log(`      └─ Clone config from: ${this._referenceId}`);
      if (this._aliases.length)
        console.log(`      └─ Aliases: [${this._aliases.join(", ")}]`);
      const dryRunCert = this._certRef ?? this._zone?.cert();
      if (dryRunCert?.resolvedArn)
        console.log(`      └─ Certificate: ${dryRunCert.resolvedArn}`);
      if (this._kvsName)
        console.log(`      └─ KVS redirector: ${this._kvsName}`);
      if (this._zone && this._prefixes.length) {
        console.log(
          `   📝 [PLAN] Add Route53 CNAMEs in ${this._zone.zoneName}:`,
        );
        for (const p of this._prefixes) {
          console.log(
            `      └─ ${p}.${this._zone.zoneName} → <cf-domain>.cloudfront.net`,
          );
        }
      }
      this.resolvedArn = `arn:aws:cloudfront::DRYRUN:distribution/PENDING`;
      this.resolvedId = "PENDING";
      return { id: this.resolvedId, arn: this.resolvedArn, name: this.name };
    }

    let distroConfig: any;

    if (this._referenceId) {
      // Clone from reference distribution
      const ref = await cf.send(
        new GetDistributionConfigCommand({ Id: this._referenceId }),
      );
      distroConfig = ref.DistributionConfig!;
      console.log(`   📋 Cloning config from ${this._referenceId}`);
    } else {
      distroConfig = this.buildBaseConfig();
    }

    // Override comment (used as our "name")
    distroConfig.Comment = this.name;

    // Override aliases + cert if provided
    if (this._aliases.length) {
      distroConfig.Aliases = {
        Quantity: this._aliases.length,
        Items: this._aliases,
      };
    }
    // _certRef is set at construction time, but cert sidecar is added lazily in zone.deploy() -
    // fall back to zone.cert() which is populated by the time CloudFront.deploy() runs
    const certRef = this._certRef ?? this._zone?.cert();
    if (certRef?.resolvedArn) {
      distroConfig.ViewerCertificate = {
        ACMCertificateArn: certRef.resolvedArn,
        SSLSupportMethod: "sni-only",
        MinimumProtocolVersion: "TLSv1.2_2021",
      };
    }

    // Remove CallerReference from cloned config - AWS will reject it
    delete distroConfig.CallerReference;

    const distroInput = {
      ...distroConfig,
      CallerReference: `puls-${this.name}-${Date.now()}`,
    };

    // ACM ISSUED → CloudFront cert index replication can take up to ~5 min
    const MAX_ATTEMPTS = 10;
    let result: any;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        result = await cf.send(
          new CreateDistributionCommand({ DistributionConfig: distroInput }),
        );
        break;
      } catch (e: any) {
        if (e.name === "InvalidViewerCertificate" && attempt < MAX_ATTEMPTS) {
          console.log(
            `   ⏳ Cert not yet visible to CloudFront - retrying in 30s (${attempt}/${MAX_ATTEMPTS - 1})...`,
          );
          await new Promise((r) => setTimeout(r, 30_000));
        } else throw e;
      }
    }

    this.resolvedId = result.Distribution!.Id!;
    this.resolvedArn = result.Distribution!.ARN!;
    console.log(
      `🚀 Created distribution "${this.name}" (id=${this.resolvedId})`,
    );

    await this.waitFor(
      `distribution "${this.name}" to finish deploying`,
      async () => {
        const d = await cf.send(
          new GetDistributionCommand({ Id: this.resolvedId! }),
        );
        return d.Distribution?.Status === "Deployed";
      },
      { intervalMs: 30_000, timeoutMs: 1_200_000 },
    );

    const cfDomain = result.Distribution!.DomainName!;
    console.log(`   🌐 Domain: ${cfDomain}`);

    if (this._zone && this._prefixes.length) {
      await this._zone.upsertCnames(
        this._prefixes.map((p) => ({ name: p, value: cfDomain })),
      );
    }

    return { id: this.resolvedId, arn: this.resolvedArn, name: this.name };
  }

  private buildBaseConfig() {
    const originId = `puls-origin-${this.name}`;
    const originDomain =
      this._origin instanceof S3BucketBuilder
        ? `${this._origin.bucketName}.s3.amazonaws.com`
        : (this._origin ?? "example.com");

    return {
      Comment: this.name,
      Enabled: true,
      HttpVersion: "http2",
      Origins: {
        Quantity: 1,
        Items: [
          {
            Id: originId,
            DomainName: originDomain,
            S3OriginConfig: { OriginAccessIdentity: "" },
          },
        ],
      },
      DefaultCacheBehavior: {
        TargetOriginId: originId,
        ViewerProtocolPolicy: "redirect-to-https",
        CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6", // Managed-CachingOptimized
        AllowedMethods: {
          Quantity: 2,
          Items: ["GET", "HEAD"],
          CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
        },
        Compress: true,
        ForwardedValues: { QueryString: false, Cookies: { Forward: "none" } },
        MinTTL: 0,
      },
      PriceClass: "PriceClass_All",
    };
  }
}
