import {
  GetSecretValueCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { BaseBuilder } from "../../core/resource.ts";
import { getSecretsClient } from "./api.ts";

export class SecretsBuilder extends BaseBuilder {
  private _value?: string;
  private _description?: string;
  private _forceDelete: boolean = false;
  private _pendingDeletion: boolean = false;
  resolvedValue: string | null = null;
  resolvedArn: string | null = null;

  constructor(secretId: string) {
    super(secretId);
    this.discoveryPromise = this.fetchSecret(secretId);
  }

  private async fetchSecret(secretId: string): Promise<any> {
    try {
      const result = await getSecretsClient().send(
        new GetSecretValueCommand({ SecretId: secretId }),
      );
      this.resolvedValue = result.SecretString ?? null;
      this.resolvedArn = result.ARN ?? null;
      return result;
    } catch (e: any) {
      if (e.name === "ResourceNotFoundException") return null;
      if (e.name === "CredentialsProviderError") return null;
      if (e.name === "InvalidRequestException") {
        this._pendingDeletion = true;
        return null;
      }
      throw e;
    }
  }

  // Awaits eager discovery — used by resolveEnvVars so callers don't need discoveryPromise directly
  async awaitValue(): Promise<string | null> {
    await this.discoveryPromise;
    return this.resolvedValue;
  }

  plainText(v: string) {
    this._value = v;
    return this;
  }
  keyValue(obj: object) {
    this._value = JSON.stringify(obj);
    return this;
  }
  description(d: string) {
    this._description = d;
    return this;
  }
  forceDelete() {
    this._forceDelete = true;
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const client = getSecretsClient();

    console.log(`\n🔐 Finalizing Secret "${this.name}"...`);

    if (dryRun) {
      if (existing) {
        console.log(`   ✅ Secret "${this.name}" exists`);
        if (this.resolvedValue !== null)
          console.log(`   💬 Value: ${this.resolvedValue}`);
        if (this._value) console.log(`   📝 [PLAN] Update secret value`);
      } else {
        console.log(`   📝 [PLAN] Create secret "${this.name}"`);
        if (this._description)
          console.log(`      └─ Description: ${this._description}`);
      }
      return { name: this.name, arn: this.resolvedArn, value: this.resolvedValue };
    }

    if (!existing) {
      if (!this._value) {
        console.log(`   ⚠️  Secret "${this.name}" does not exist — add .plainText() or .keyValue() to create it`);
        return { name: this.name, arn: null, value: null };
      }
      const result = await client.send(
        new CreateSecretCommand({
          Name: this.name,
          SecretString: this._value,
          Description: this._description,
        }),
      );
      this.resolvedArn = result.ARN ?? null;
      this.resolvedValue = this._value;
      console.log(`🚀 Created secret "${this.name}"`);
    } else {
      console.log(`   ✅ Secret "${this.name}" exists`);
      if (this.resolvedValue !== null)
        console.log(`   💬 Value: ${this.resolvedValue}`);
      if (this._value && this._value !== this.resolvedValue) {
        await client.send(
          new PutSecretValueCommand({
            SecretId: this.name,
            SecretString: this._value,
          }),
        );
        this.resolvedValue = this._value;
        console.log(`   ✅ Updated secret value`);
      }
    }

    await this.deploySidecars();
    return { name: this.name, arn: this.resolvedArn, value: this.resolvedValue };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Secret "${this.name}"...`);

    if (!existing) {
      if (this._pendingDeletion)
        console.log(`   ⏳ Secret "${this.name}" is already scheduled for deletion`);
      else
        console.log(`   ✅ Secret "${this.name}" does not exist — nothing to do`);
      return { destroyed: this.name };
    }

    if (dryRun) {
      const mode = this._forceDelete
        ? "immediate"
        : "scheduled (30-day recovery window)";
      console.log(`   📝 [PLAN] Delete secret "${this.name}" — ${mode}`);
      return { destroyed: this.name };
    }

    await getSecretsClient().send(
      new DeleteSecretCommand({
        SecretId: this.name,
        ForceDeleteWithoutRecovery: this._forceDelete,
        ...(this._forceDelete ? {} : { RecoveryWindowInDays: 30 }),
      }),
    );

    const mode = this._forceDelete
      ? "immediately"
      : "scheduled for deletion (30-day recovery window)";
    console.log(`   ✅ Secret "${this.name}" ${mode}`);
    return { destroyed: this.name };
  }
}

// Resolve a mix of plain strings and SecretsBuilders into plain strings.
// Called at deploy time in Lambda and Fargate, after all discoveryPromises have settled.
export async function resolveEnvVars(
  env: Record<string, string | SecretsBuilder>,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v instanceof SecretsBuilder) {
      await v.awaitValue();
      if (v.resolvedValue === null)
        throw new Error(
          `Secret "${v.name}" has no value — create it first or call .plainText()/.keyValue() in the stack`,
        );
      resolved[k] = v.resolvedValue;
    } else {
      resolved[k] = v;
    }
  }
  return resolved;
}
