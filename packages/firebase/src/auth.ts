import { BaseBuilder } from "@puls-dev/core";
import { cloudFetch, getProjectId } from "./api.js";

const AUTH_BASE = "https://identitytoolkit.googleapis.com/admin/v2";

interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

interface AuthProviders {
  emailPassword?: { enabled: boolean; passwordRequired?: boolean };
  anonymous?: { enabled: boolean };
  phone?: { enabled: boolean };
  google?: OAuthCredentials & { enabled?: boolean };
  github?: OAuthCredentials & { enabled?: boolean };
  facebook?: OAuthCredentials & { enabled?: boolean };
  twitter?: OAuthCredentials & { enabled?: boolean };
  apple?: OAuthCredentials & { enabled?: boolean };
  microsoft?: OAuthCredentials & { enabled?: boolean };
}

const IDP_ID: Record<string, string> = {
  google: "google.com",
  github: "github.com",
  facebook: "facebook.com",
  twitter: "twitter.com",
  apple: "apple.com",
  microsoft: "microsoft.com",
};

export class FirebaseAuthBuilder extends BaseBuilder {
  private _providers: AuthProviders = {};
  private _allowedDomains?: string[];
  private _authorizedDomains?: string[];

  constructor() {
    super("auth");
    this.discoveryPromise = Promise.resolve(null);
  }

  emailPassword(opts: { passwordRequired?: boolean } = {}) {
    this._providers.emailPassword = { enabled: true, ...opts };
    return this;
  }
  anonymous() {
    this._providers.anonymous = { enabled: true };
    return this;
  }
  phone() {
    this._providers.phone = { enabled: true };
    return this;
  }

  google(creds: OAuthCredentials) {
    this._providers.google = { enabled: true, ...creds };
    return this;
  }
  github(creds: OAuthCredentials) {
    this._providers.github = { enabled: true, ...creds };
    return this;
  }
  facebook(creds: OAuthCredentials) {
    this._providers.facebook = { enabled: true, ...creds };
    return this;
  }
  twitter(creds: OAuthCredentials) {
    this._providers.twitter = { enabled: true, ...creds };
    return this;
  }
  apple(creds: OAuthCredentials) {
    this._providers.apple = { enabled: true, ...creds };
    return this;
  }
  microsoft(creds: OAuthCredentials) {
    this._providers.microsoft = { enabled: true, ...creds };
    return this;
  }

  // Domains allowed to use Firebase Auth (e.g. your app domain + localhost)
  authorizedDomains(domains: string[]) {
    this._authorizedDomains = domains;
    return this;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private projectPath() {
    return `/projects/${getProjectId()}`;
  }

  private async getConfig(): Promise<any> {
    try {
      return await cloudFetch(AUTH_BASE, `${this.projectPath()}/config`);
    } catch {
      return null;
    }
  }

  private async patchConfig(body: object, updateMask: string): Promise<void> {
    await cloudFetch(
      AUTH_BASE,
      `${this.projectPath()}/config?updateMask=${updateMask}`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
  }

  private async getIdp(provider: string): Promise<any> {
    try {
      return await cloudFetch(
        AUTH_BASE,
        `${this.projectPath()}/defaultSupportedIdpConfigs/${IDP_ID[provider]}`,
      );
    } catch {
      return null;
    }
  }

  private async upsertIdp(
    provider: string,
    creds: OAuthCredentials & { enabled?: boolean },
  ): Promise<void> {
    const idpId = IDP_ID[provider];
    const existing = await this.getIdp(provider);
    const body = {
      name: `${this.projectPath().slice(1)}/defaultSupportedIdpConfigs/${idpId}`,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      enabled: creds.enabled ?? true,
    };

    if (existing) {
      await cloudFetch(
        AUTH_BASE,
        `${this.projectPath()}/defaultSupportedIdpConfigs/${idpId}?updateMask=clientId,clientSecret,enabled`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
    } else {
      await cloudFetch(
        AUTH_BASE,
        `${this.projectPath()}/defaultSupportedIdpConfigs?idpId=${idpId}`,
        { method: "POST", body: JSON.stringify(body) },
      );
    }
  }

  // ── Deploy ────────────────────────────────────────────────────────────────

  async deploy() {
    const dryRun = this.isDryRunActive();
    console.log(`\n🔑 Finalizing Firebase Auth...`);

    const { emailPassword, anonymous, phone, ...oauthProviders } =
      this._providers;
    const hasBuiltIn = emailPassword || anonymous || phone;
    const oauthEntries = Object.entries(oauthProviders) as [
      string,
      OAuthCredentials & { enabled?: boolean },
    ][];

    if (dryRun) {
      if (hasBuiltIn) {
        console.log(`   📝 [PLAN] Configure sign-in methods:`);
        if (emailPassword)
          console.log(
            `      └─ Email/Password (passwordRequired: ${emailPassword.passwordRequired ?? true})`,
          );
        if (anonymous) console.log(`      └─ Anonymous`);
        if (phone) console.log(`      └─ Phone`);
      }
      for (const [name] of oauthEntries) {
        console.log(`   📝 [PLAN] Enable OAuth provider: ${IDP_ID[name]}`);
      }
      if (this._authorizedDomains) {
        console.log(
          `   📝 [PLAN] Set authorized domains: [${this._authorizedDomains.join(", ")}]`,
        );
      }
      return { project: getProjectId() };
    }

    // Built-in providers via project config
    if (hasBuiltIn || this._authorizedDomains) {
      const signIn: any = {};
      const masks: string[] = [];

      if (emailPassword) {
        signIn.email = {
          enabled: true,
          passwordRequired: emailPassword.passwordRequired ?? true,
        };
        masks.push("signIn.email");
      }
      if (anonymous) {
        signIn.anonymous = { enabled: true };
        masks.push("signIn.anonymous");
      }
      if (phone) {
        signIn.phoneNumber = { enabled: true };
        masks.push("signIn.phoneNumber");
      }

      const body: any = {};
      if (masks.length) body.signIn = signIn;
      if (this._authorizedDomains) {
        body.authorizedDomains = this._authorizedDomains;
        masks.push("authorizedDomains");
      }

      await this.patchConfig(body, masks.join(","));

      if (emailPassword) console.log(`   ✅ Email/Password enabled`);
      if (anonymous) console.log(`   ✅ Anonymous sign-in enabled`);
      if (phone) console.log(`   ✅ Phone sign-in enabled`);
      if (this._authorizedDomains)
        console.log(
          `   ✅ Authorized domains set: [${this._authorizedDomains.join(", ")}]`,
        );
    }

    // OAuth providers
    for (const [name, creds] of oauthEntries) {
      await this.upsertIdp(name, creds);
      console.log(`   ✅ ${IDP_ID[name]} provider configured`);
    }

    return { project: getProjectId() };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    console.log(`\n🗑️  Destroying Firebase Auth config...`);
    if (dryRun) {
      console.log(
        `   ℹ️  Auth providers can be disabled individually - destroying the Auth config is not supported via API`,
      );
    } else {
      console.log(
        `   ℹ️  Disable providers individually in the Firebase console`,
      );
    }
    return { destroyed: "auth" };
  }
}
