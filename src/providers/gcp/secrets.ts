import { BaseBuilder } from "../../core/resource.js";
import { gcpFetch, getProjectId } from "./api.js";
import { resolvedSecrets } from "../../core/secret.js";

const SECRET_BASE = "https://secretmanager.googleapis.com";

export class GCPSecretBuilder extends BaseBuilder {
  private _value?: string;
  resolvedValue: string | null = null;
  resolvedArn: string | null = null;

  constructor(secretId: string) {
    super(secretId);
    this.discoveryPromise = this.fetchSecret(secretId);
  }

  private async fetchSecret(secretId: string): Promise<any> {
    try {
      const project = getProjectId();

      // 1. Fetch metadata first to see if secret exists
      const secret = await gcpFetch(
        SECRET_BASE,
        `/v1/projects/${project}/secrets/${secretId}`
      );
      this.resolvedArn = secret.name ?? null;

      // 2. Fetch the latest secret value payload
      try {
        const payload = await gcpFetch(
          SECRET_BASE,
          `/v1/projects/${project}/secrets/${secretId}/versions/latest:access`
        );
        if (payload.payload?.data) {
          this.resolvedValue = Buffer.from(payload.payload.data, "base64").toString("utf8");
          if (this.resolvedValue && this.resolvedValue.length >= 3) {
            resolvedSecrets.add(this.resolvedValue);
          }
        }
      } catch (err: any) {
        console.warn(`   ⚠️  Could not fetch latest version of secret "${secretId}": ${err.message}`);
      }

      return secret;
    } catch (e: any) {
      if (
        e.message?.includes("404") ||
        e.message?.includes("403") ||
        e.message?.includes("credentials not configured")
      ) {
        return null;
      }
      throw e;
    }
  }

  async awaitValue(): Promise<string | null> {
    await this.discoveryPromise;
    return this.resolvedValue;
  }

  plainText(v: string) {
    this._value = v;
    if (v && v.length >= 3) {
      resolvedSecrets.add(v);
    }
    return this;
  }

  keyValue(obj: object) {
    const v = JSON.stringify(obj);
    this._value = v;
    if (v && v.length >= 3) {
      resolvedSecrets.add(v);
    }
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const secretId = this.name;
    const existing = await this.discoveryPromise;

    console.log(`\n🔐 Finalizing GCP Secret "${secretId}"...`);

    if (dryRun) {
      if (existing) {
        console.log(`   ✅ Secret "${secretId}" exists`);
        if (this.resolvedValue !== null) {
          console.log(`   💬 Value: ********`);
        }
        if (this._value) {
          console.log(`   📝 [PLAN] Update secret value`);
        }
      } else {
        console.log(`   📝 [PLAN] Create secret "${secretId}"`);
      }
      // Populate planned value for other builders to resolve during dry-run
      this.resolvedValue = this._value ?? null;
      return {
        name: secretId,
        arn: this.resolvedArn,
        value: this.resolvedValue,
      };
    }

    if (!existing) {
      if (!this._value) {
        console.log(
          `   ⚠️  Secret "${secretId}" does not exist - add .plainText() or .keyValue() to create it`
        );
        return { name: secretId, arn: null, value: null };
      }

      // Create secret container
      const secret = await gcpFetch(
        SECRET_BASE,
        `/v1/projects/${project}/secrets?secretId=${secretId}`,
        {
          method: "POST",
          body: JSON.stringify({
            replication: {
              automatic: {},
            },
          }),
        }
      );
      this.resolvedArn = secret.name ?? null;

      // Add secret version payload
      const base64Data = Buffer.from(this._value, "utf8").toString("base64");
      await gcpFetch(
        SECRET_BASE,
        `/v1/projects/${project}/secrets/${secretId}:addVersion`,
        {
          method: "POST",
          body: JSON.stringify({
            payload: {
              data: base64Data,
            },
          }),
        }
      );

      this.resolvedValue = this._value;
      if (this._value && this._value.length >= 3) {
        resolvedSecrets.add(this._value);
      }
      console.log(`🚀 Created secret "${secretId}"`);
    } else {
      console.log(`   ✅ Secret "${secretId}" exists`);
      if (this.resolvedValue !== null) {
        console.log(`   💬 Value: ********`);
      }
      if (this._value && this._value !== this.resolvedValue) {
        const base64Data = Buffer.from(this._value, "utf8").toString("base64");
        await gcpFetch(
          SECRET_BASE,
          `/v1/projects/${project}/secrets/${secretId}:addVersion`,
          {
            method: "POST",
            body: JSON.stringify({
              payload: {
                data: base64Data,
              },
            }),
          }
        );
        this.resolvedValue = this._value;
        if (this._value && this._value.length >= 3) {
          resolvedSecrets.add(this._value);
        }
        console.log(`   ✅ Updated secret value`);
      }
    }

    await this.deploySidecars();
    return {
      name: secretId,
      arn: this.resolvedArn,
      value: this.resolvedValue,
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const secretId = this.name;

    console.log(`\n🗑️  Destroying GCP Secret "${secretId}"...`);

    const existing = await this.discoverSecretMetadata();

    if (!existing) {
      console.log(`   ✅ Secret "${secretId}" does not exist - nothing to do.`);
      return { destroyed: secretId };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete secret "${secretId}"`);
      return { destroyed: secretId };
    }

    await gcpFetch(
      SECRET_BASE,
      `/v1/projects/${project}/secrets/${secretId}`,
      {
        method: "DELETE",
      }
    );
    console.log(`   ✅ Secret "${secretId}" deleted.`);

    await this.destroySidecars();
    return { destroyed: secretId };
  }

  private async discoverSecretMetadata(): Promise<any> {
    try {
      const project = getProjectId();
      return await gcpFetch(
        SECRET_BASE,
        `/v1/projects/${project}/secrets/${this.name}`
      );
    } catch (e: any) {
      if (
        e.message?.includes("404") ||
        e.message?.includes("403") ||
        e.message?.includes("credentials not configured")
      ) {
        return null;
      }
      throw e;
    }
  }
}

export async function resolveGCPEnvVars(
  env: Record<string, string | GCPSecretBuilder>,
  isDryRun: boolean = false
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v instanceof GCPSecretBuilder) {
      await v.awaitValue();
      let val = v.resolvedValue;
      if (val === null && isDryRun) {
        val = (v as any)._value ?? "DRYRUN_SECRET";
      }
      if (val === null) {
        throw new Error(
          `Secret "${v.name}" has no value - create it first or call .plainText()/.keyValue() in the stack`
        );
      }
      resolved[k] = val;
    } else {
      resolved[k] = v;
    }
  }
  return resolved;
}
