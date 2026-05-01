import { BaseBuilder } from "../../core/resource.ts";
import { ACMCertificateBuilder } from "./acm.ts";
import type { RegistrantContact } from "../../types/aws.ts";

export class Route53Builder extends BaseBuilder {
  private records: any[] = [];
  private _isRegistering: boolean = false;
  private _registrantContact?: RegistrantContact;

  constructor(public zoneName: string = "") {
    super(zoneName || "route53-pending");
    this.discoveryPromise = this.mockApiCheck(this.zoneName);
  }

  randomDomain() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const id = Array.from(
      { length: 12 },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join("");
    this.zoneName = `${id}.com`;
    this.discoveryPromise = this.mockApiCheck(this.zoneName);
    return this;
  }

  cert(): ACMCertificateBuilder | undefined {
    return this.sidecars.find((s) => s instanceof ACMCertificateBuilder) as
      | ACMCertificateBuilder
      | undefined;
  }

  private _wantsWildcardSSL: boolean = false;

  // Cert is created lazily at deploy time so randomDomain() can be called in any order.
  withWildcardSSL() {
    this._wantsWildcardSSL = true;
    return this;
  }

  register(contact?: RegistrantContact) {
    this._isRegistering = true;
    this._registrantContact = contact;
    return this;
  }

  record(name: string, type: "A" | "CNAME" | "AAAA", value: any) {
    this.records.push({ name, type, value });
    return this;
  }

  pointer(name: string, target: BaseBuilder) {
    this.records.push({ name, type: "A", value: target, isAlias: true });
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    console.log(`\n🗺️  Finalizing Route53 Zone "${this.zoneName}"...`);

    if (this._wantsWildcardSSL && !this.cert()) {
      this.sidecars.push(new ACMCertificateBuilder(this.zoneName, true));
    }

    if (this._isRegistering) {
      const c = this._registrantContact;
      console.log(
        `   ✅ [${dryRun ? "PLAN" : "OK"}] Registering domain "${this.zoneName}" via Route53 Domains`,
      );
      if (c) {
        console.log(
          `      └─ Registrant: ${c.FIRSTNAME} ${c.LASTNAME} <${c.EMAIL}>`,
        );
        console.log(
          `      └─ Org: ${c.ORGANIZATION}, ${c.ADDRESSLINE}, ${c.CITY}, ${c.COUNTRY}`,
        );
      } else {
        console.warn(
          `      ⚠️  No registrant contact provided — AWS will prompt for contact details.`,
        );
      }
      await this.waitFor(
        `domain "${this.zoneName}" to become active`,
        async () => {
          // Real: check route53domains.getDomainDetail() status === 'ACTIVE'
          return true; // mock: immediately active
        },
        { intervalMs: 15_000, timeoutMs: 900_000 }, // domains can take ~15 min
      );
    }

    for (const rec of this.records) {
      const val =
        rec.value instanceof BaseBuilder
          ? `[Alias to ${rec.value.name}]`
          : rec.value;
      console.log(
        `   ✅ [${dryRun ? "PLAN" : "OK"}] ${rec.type}: ${rec.name}.${this.zoneName} -> ${val}`,
      );
    }

    await this.deploySidecars();
    return { zone: this.zoneName };
  }

  private async mockApiCheck(name: string) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { id: "Z12345" };
  }
}
