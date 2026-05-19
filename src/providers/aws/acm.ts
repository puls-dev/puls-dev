import {
  ListCertificatesCommand,
  RequestCertificateCommand,
  DescribeCertificateCommand,
} from "@aws-sdk/client-acm";
import { ChangeResourceRecordSetsCommand } from "@aws-sdk/client-route-53";
import { BaseBuilder } from "../../core/resource.js";
import { getACMClient, getR53Client } from "./api.js";

interface ZoneRef {
  zoneId?: string;
  zoneName: string;
}

export class ACMCertificateBuilder extends BaseBuilder {
  resolvedArn: string | null = null;
  validationRecords: { name: string; value: string }[] = [];
  private _zone?: ZoneRef;

  constructor(
    public domainName: string,
    public wildcard: boolean = true,
  ) {
    super(`acm-${domainName}`);
    this.discoveryPromise = this.discoverCertificate(domainName, wildcard);
  }

  forZone(zone: ZoneRef) {
    this._zone = zone;
    return this;
  }

  private async discoverCertificate(
    domain: string,
    wildcard: boolean,
  ): Promise<any> {
    try {
      const acm = getACMClient();
      const primaryName = wildcard ? `*.${domain}` : domain;
      const list = await acm.send(
        new ListCertificatesCommand({
          CertificateStatuses: ["ISSUED", "PENDING_VALIDATION"],
        }),
      );
      for (const cert of list.CertificateSummaryList ?? []) {
        if (cert.DomainName === primaryName && cert.CertificateArn) {
          this.resolvedArn = cert.CertificateArn;
          return cert;
        }
      }
      return null;
    } catch (e: any) {
      if (e.name === "CredentialsProviderError") return null;
      throw e;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🔐 Finalizing ACM Certificate for "${this.domainName}"...`);

    if (existing) {
      console.log(
        `   ✅ Certificate already exists (${existing.Status ?? "ISSUED"}): ${this.resolvedArn}`,
      );
      return { arn: this.resolvedArn };
    }

    const primaryName = this.wildcard
      ? `*.${this.domainName}`
      : this.domainName;
    const sanNames = this.wildcard ? [this.domainName] : [];

    if (dryRun) {
      console.log(
        `   📝 [PLAN] Request ${this.wildcard ? "wildcard " : ""}certificate: ${primaryName}`,
      );
      console.log(
        `   📝 [PLAN] DNS validation CNAMEs will be auto-written to Route53`,
      );
      this.resolvedArn = `arn:aws:acm:us-east-1:DRYRUN:certificate/pending`;
      return { arn: this.resolvedArn };
    }

    const acm = getACMClient();
    const result = await acm.send(
      new RequestCertificateCommand({
        DomainName: primaryName,
        SubjectAlternativeNames: sanNames.length ? sanNames : undefined,
        ValidationMethod: "DNS",
      }),
    );

    this.resolvedArn = result.CertificateArn!;
    console.log(
      `🚀 Requested certificate ${primaryName} (arn=${this.resolvedArn})`,
    );

    // Step 1: wait until ALL DomainValidationOptions have their ResourceRecord
    // (wildcard + apex SANs each get an entry; ACM can generate them at different times)
    await this.waitFor(
      "validation records to be generated",
      async () => {
        const detail = await acm.send(
          new DescribeCertificateCommand({ CertificateArn: this.resolvedArn! }),
        );
        const options = detail.Certificate?.DomainValidationOptions ?? [];
        if (options.length === 0) return false;
        const withRecords = options.filter((o) => o.ResourceRecord);
        if (withRecords.length < options.length) return false;
        this.validationRecords = withRecords.map((o) => ({
          name: o.ResourceRecord!.Name!,
          value: o.ResourceRecord!.Value!,
        }));
        return true;
      },
      { intervalMs: 5_000, timeoutMs: 60_000 },
    );

    // Step 2: write them into Route53 automatically - no manual DNS work needed
    if (this._zone?.zoneId) {
      // Wildcard certs produce duplicate CNAME names across SANs - deduplicate before sending
      const unique = Array.from(
        new Map(this.validationRecords.map((r) => [r.name, r])).values(),
      );
      const r53 = getR53Client();
      await r53.send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: this._zone.zoneId,
          ChangeBatch: {
            Changes: unique.map((r) => ({
              Action: "UPSERT",
              ResourceRecordSet: {
                Name: r.name.replace(/\.$/, ""),
                Type: "CNAME",
                TTL: 300,
                ResourceRecords: [{ Value: r.value.replace(/\.$/, "") }],
              },
            })),
          },
        }),
      );
      console.log(
        `   ✅ Auto-wrote ${unique.length} validation CNAME(s) to Route53`,
      );
    }

    // Step 3: now wait for ISSUED - records are in DNS so this will actually resolve
    await this.waitFor(
      `certificate "${this.domainName}" to be validated`,
      async () => {
        const detail = await acm.send(
          new DescribeCertificateCommand({ CertificateArn: this.resolvedArn! }),
        );
        return detail.Certificate?.Status === "ISSUED";
      },
      { intervalMs: 15_000, timeoutMs: 600_000 },
    );

    console.log(`   ✅ Certificate issued: ${this.resolvedArn}`);
    return { arn: this.resolvedArn };
  }
}
