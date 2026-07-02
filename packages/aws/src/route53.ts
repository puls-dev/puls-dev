import {
  ListHostedZonesByNameCommand,
  CreateHostedZoneCommand,
  ChangeResourceRecordSetsCommand,
  RRType,
} from "@aws-sdk/client-route-53";
import {
  RegisterDomainCommand,
  GetOperationDetailCommand,
  CheckDomainAvailabilityCommand,
  ContactType,
  CountryCode,
} from "@aws-sdk/client-route-53-domains";
import { BaseBuilder } from "@puls-dev/core";
import { Output } from "@puls-dev/core";
import { ACMCertificateBuilder } from "./acm.js";
import { getR53Client, getR53DomainsClient } from "./api.js";
import type { RegistrantContact } from "./types/aws.js";
import { loadRecordsFromFile } from "@puls-dev/core";

export class Route53Builder extends BaseBuilder {
  readonly out = {
    zone: new Output<{ name: string; id: string }>(),
  };

  public zoneName: string;
  public zoneId?: string;
  private records: any[] = [];
  private _isRegistering: boolean = false;
  private _registrantContact?: RegistrantContact;
  private _wantsWildcardSSL: boolean = false;

  constructor(zoneName: string = "") {
    super(zoneName || "route53-pending");
    this.zoneName = zoneName;
    this.discoveryPromise = this.discoverZone(zoneName);
  }

  private async discoverZone(name: string): Promise<any> {
    if (!name) return null;
    try {
      const r53 = getR53Client();
      const result = await r53.send(
        new ListHostedZonesByNameCommand({ DNSName: name, MaxItems: 5 }),
      );
      const match = (result.HostedZones ?? []).find(
        (z) => z.Name === `${name}.`,
      );
      if (match) {
        this.zoneId = match.Id!.replace("/hostedzone/", "");
        this.out.zone.resolve({ name: this.zoneName, id: this.zoneId });
        return match;
      }
      return null;
    } catch (e: any) {
      if (e.name === "CredentialsProviderError") return null;
      throw e;
    }
  }

  randomDomain() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const id = Array.from(
      { length: 12 },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join("");
    this.zoneName = `${id}.com`;
    this.name = this.zoneName;
    this.discoveryPromise = this.discoverZone(this.zoneName);
    return this;
  }

  cert(): ACMCertificateBuilder | undefined {
    return this.sidecars.find((s) => s instanceof ACMCertificateBuilder) as
      | ACMCertificateBuilder
      | undefined;
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

  record(filePath: string): this;
  record(
    name: string,
    type:
      | "A"
      | "AAAA"
      | "CNAME"
      | "MX"
      | "TXT"
      | "NS"
      | "PTR"
      | "SRV"
      | "CAA"
      | "NAPTR"
      | "SPF",
    value: string,
    ttl?: number,
  ): this;
  record(
    nameOrPath: string,
    type?:
      | "A"
      | "AAAA"
      | "CNAME"
      | "MX"
      | "TXT"
      | "NS"
      | "PTR"
      | "SRV"
      | "CAA"
      | "NAPTR"
      | "SPF",
    value?: string,
    ttl: number = 300,
  ) {
    if (arguments.length === 1 && typeof nameOrPath === "string" && (nameOrPath.endsWith(".yaml") || nameOrPath.endsWith(".yml") || nameOrPath.endsWith(".json"))) {
      const loaded = loadRecordsFromFile(nameOrPath);
      for (const r of loaded) {
        // YAML supports a separate `priority` field for MX; reconstruct "10 host" format AWS expects.
        const value = (r.type === "MX" && r.priority !== undefined)
          ? `${r.priority} ${r.value}`
          : r.value;
        this.records.push({ name: r.name, type: r.type, value, ttl: r.ttl ?? 300 });
      }
      return this;
    }
    this.records.push({ name: nameOrPath, type: type!, value: value!, ttl });
    return this;
  }

  pointer(name: string, target: BaseBuilder) {
    this.records.push({ name, type: "A", value: target, isAlias: true });
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const r53 = getR53Client();

    console.log(`\n🗺️  Finalizing Route53 Zone "${this.zoneName}"...`);

    // Register domain first so NS records are publicly resolvable before cert validation
    if (this._isRegistering) {
      await this.registerDomain(dryRun);
    }

    if (!existing) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create hosted zone ${this.zoneName}`);
        this.out.zone.resolve({ name: this.zoneName, id: "PENDING" });
      } else {
        // Route53 Domains auto-creates the hosted zone on registration - check again before creating
        const recheck = await this.discoverZone(this.zoneName);
        if (!recheck) {
          const result = await r53.send(
            new CreateHostedZoneCommand({
              Name: this.zoneName,
              CallerReference: `puls-${Date.now()}`,
            }),
          );
          this.zoneId = result.HostedZone!.Id!.replace("/hostedzone/", "");
          console.log(
            `🚀 Created hosted zone ${this.zoneName} (id=${this.zoneId})`,
          );
        } else {
          console.log(
            `   ✅ Hosted zone ${this.zoneName} created by domain registration (id=${this.zoneId})`,
          );
        }
      }
    } else {
      console.log(
        `   ✅ Hosted zone ${this.zoneName} exists (id=${this.zoneId})`,
      );
    }

    if (this.zoneId)
      this.out.zone.resolve({ name: this.zoneName, id: this.zoneId });

    if (this._wantsWildcardSSL && !this.cert()) {
      this.sidecars.push(new ACMCertificateBuilder(this.zoneName, true));
    }

    const cert = this.cert();
    if (cert) {
      cert.forZone(this); // zoneId is set by now - cert writes its own validation CNAMEs
      await cert.deploy();
    }

    // Regular records
    if (this.records.length > 0 && !dryRun && this.zoneId) {
      const resolved = this.records.map((r) => ({
        type: r.type,
        name: r.name,
        value:
          r.value instanceof BaseBuilder ? `[alias: ${r.value.name}]` : r.value,
        ttl: r.ttl ?? 300,
      }));
      await this.upsertRecords(r53, resolved);
    }

    for (const rec of this.records) {
      const val =
        rec.value instanceof BaseBuilder
          ? `[Alias to ${rec.value.name}]`
          : rec.value;
      console.log(
        `   ✅ [${dryRun ? "PLAN" : "OK"}] ${rec.type}: ${rec.name}.${this.zoneName} → ${val}`,
      );
    }

    return { zone: this.zoneName, id: this.zoneId };
  }

  private async registerDomain(dryRun: boolean) {
    const domains = getR53DomainsClient();
    const c = this._registrantContact;

    if (dryRun) {
      console.log(
        `   📝 [PLAN] Register domain ${this.zoneName} via Route53 Domains`,
      );
      if (c)
        console.log(
          `      └─ Registrant: ${c.FIRSTNAME} ${c.LASTNAME} <${c.EMAIL}>`,
        );
      return;
    }

    // Check availability before attempting registration
    const avail = await domains.send(
      new CheckDomainAvailabilityCommand({ DomainName: this.zoneName }),
    );
    if (avail.Availability !== "AVAILABLE") {
      console.log(
        `   ℹ️  Domain ${this.zoneName} is not available for registration (${avail.Availability}) - skipping`,
      );
      return;
    }

    const contact = c ? this.mapContact(c) : undefined;
    if (!contact)
      throw new Error(
        `register() called without contact details - provide a RegistrantContact`,
      );

    console.log(`   📋 Registering domain ${this.zoneName}... (est. ~5 min)`);
    const result = await domains.send(
      new RegisterDomainCommand({
        DomainName: this.zoneName,
        DurationInYears: 1,
        AutoRenew: true,
        AdminContact: contact,
        RegistrantContact: contact,
        TechContact: contact,
        PrivacyProtectAdminContact: true,
        PrivacyProtectRegistrantContact: true,
        PrivacyProtectTechContact: true,
      }),
    );

    console.log(
      `🚀 Domain registration submitted (operationId=${result.OperationId})`,
    );

    await this.waitFor(
      `domain "${this.zoneName}" to become active`,
      async () => {
        const op = await domains.send(
          new GetOperationDetailCommand({ OperationId: result.OperationId! }),
        );
        if (op.Status === "ERROR" || op.Status === "FAILED") {
          throw new Error(
            `Domain registration failed (${op.Status}): ${op.Message}`,
          );
        }
        return op.Status === "SUCCESSFUL";
      },
      { intervalMs: 15_000, timeoutMs: 900_000 },
    );

    console.log(`   ✅ Domain ${this.zoneName} registered`);
  }

  private mapContact(c: RegistrantContact) {
    return {
      FirstName: c.FIRSTNAME,
      LastName: c.LASTNAME,
      Email: c.EMAIL,
      PhoneNumber: this.normalizePhone(c.MOBILE),
      ContactType: c.CONTACT_TYPE as ContactType,
      OrganizationName: c.ORGANIZATION,
      AddressLine1: c.ADDRESSLINE,
      City: c.CITY,
      ZipCode: c.ZIPCODE,
      CountryCode: c.COUNTRY as CountryCode,
    };
  }

  // Route53 Domains requires +CC.subscriber format (e.g. +46.708339809)
  private normalizePhone(phone: string): string {
    if (phone.includes(".")) return phone;
    const digits = phone.replace(/^\+/, "");
    // +1 (US/CA) and +7 (RU/KZ) are single-digit country codes
    if (digits.startsWith("1") || digits.startsWith("7")) {
      return `+${digits[0]}.${digits.slice(1)}`;
    }
    // Default: treat first 2 digits as country code
    return `+${digits.slice(0, 2)}.${digits.slice(2)}`;
  }

  async upsertCnames(records: { name: string; value: string }[]) {
    if (!this.zoneId)
      throw new Error(`Zone ${this.zoneName} has no ID - was it deployed?`);
    const r53 = getR53Client();
    await this.upsertRecords(
      r53,
      records.map((r) => ({
        type: "CNAME",
        name: `${r.name}.${this.zoneName}`,
        value: r.value,
        ttl: 300,
      })),
    );
    for (const r of records) {
      console.log(`   ✅ CNAME ${r.name}.${this.zoneName} → ${r.value}`);
    }
  }

  private async upsertRecords(
    r53: ReturnType<typeof getR53Client>,
    records: { type: string; name: string; value: string; ttl: number }[],
  ) {
    await r53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: this.zoneId!,
        ChangeBatch: {
          Changes: records.map((r) => {
            const value =
              (r.type === "TXT" || r.type === "SPF") &&
              !r.value.startsWith('"')
                ? `"${r.value}"`
                : r.value;
            return {
              Action: "UPSERT",
              ResourceRecordSet: {
                Name: r.name,
                Type: r.type as RRType,
                TTL: r.ttl,
                ResourceRecords: [{ Value: value }],
              },
            };
          }),
        },
      }),
    );
  }
}
