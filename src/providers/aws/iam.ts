import {
  GetRoleCommand,
  CreateRoleCommand,
  UpdateRoleCommand,
  DeleteRoleCommand,
  UpdateAssumeRolePolicyCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  ListRolePoliciesCommand,
  CreatePolicyCommand,
  DeletePolicyCommand,
  ListPoliciesCommand,
  CreatePolicyVersionCommand,
  DeletePolicyVersionCommand,
  ListPolicyVersionsCommand,
} from "@aws-sdk/client-iam";
import { BaseBuilder } from "../../core/resource.js";
import { Output } from "../../core/output.js";
import { getIAMClient } from "./api.js";
import type { IAMPolicyDocument } from "../../types/aws.js";

const DEFAULT_ASSUME_ROLE_POLICY: IAMPolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

export class IAMPolicyBuilder extends BaseBuilder {
  readonly out = {
    arn: new Output<string>(),
  };

  private _document?: IAMPolicyDocument;
  private _description?: string;
  private _path: string = "/";
  resolvedArn: string | null = null;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverPolicy(name);
  }

  private async discoverPolicy(name: string): Promise<any> {
    try {
      const iam = getIAMClient();
      const result = await iam.send(
        new ListPoliciesCommand({ Scope: "Local", OnlyAttached: false, MaxItems: 100 }),
      );
      const match = (result.Policies ?? []).find((p) => p.PolicyName === name);
      if (match) {
        this.resolvedArn = match.Arn ?? null;
        if (this.resolvedArn) {
          this.out.arn.resolve(this.resolvedArn);
        }
        return match;
      }
      return null;
    } catch (e: any) {
      if (e.name === "CredentialsProviderError") return null;
      throw e;
    }
  }

  document(doc: IAMPolicyDocument) {
    this._document = doc;
    return this;
  }

  description(desc: string) {
    this._description = desc;
    return this;
  }

  path(p: string) {
    this._path = p;
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const iam = getIAMClient();

    console.log(`\n🔐 Finalizing IAM Policy "${this.name}"...`);

    if (!this._document) {
      throw new Error(`[IAMPolicy:${this.name}] .document() is required`);
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] ${existing ? "Update" : "Create"} IAM policy "${this.name}"`);
      this.resolvedArn = existing?.Arn ?? `arn:aws:iam::000000000000:policy/DRYRUN-${this.name}`;
      this.out.arn.resolve(this.resolvedArn!);
      return { name: this.name, arn: this.resolvedArn };
    }

    if (!existing) {
      const result = await iam.send(
        new CreatePolicyCommand({
          PolicyName: this.name,
          PolicyDocument: JSON.stringify(this._document),
          Description: this._description,
          Path: this._path,
        }),
      );
      this.resolvedArn = result.Policy!.Arn!;
      this.out.arn.resolve(this.resolvedArn!);
      console.log(`🚀 Created IAM Policy "${this.name}" (arn=${this.resolvedArn})`);
    } else {
      this.resolvedArn = existing.Arn!;
      this.out.arn.resolve(this.resolvedArn!);

      // Handle AWS 5-version limit
      const versions = await iam.send(
        new ListPolicyVersionsCommand({ PolicyArn: this.resolvedArn! }),
      );
      if (versions.Versions && versions.Versions.length >= 5) {
        const nonDefault = versions.Versions.filter((v) => !v.IsDefaultVersion);
        if (nonDefault.length > 0) {
          nonDefault.sort(
            (a, b) => new Date(a.CreateDate!).getTime() - new Date(b.CreateDate!).getTime(),
          );
          const oldest = nonDefault[0];
          await iam.send(
            new DeletePolicyVersionCommand({
              PolicyArn: this.resolvedArn!,
              VersionId: oldest.VersionId!,
            }),
          );
          console.log(`   🧹 Pruned oldest IAM policy version: ${oldest.VersionId}`);
        }
      }

      await iam.send(
        new CreatePolicyVersionCommand({
          PolicyArn: this.resolvedArn!,
          PolicyDocument: JSON.stringify(this._document),
          SetAsDefault: true,
        }),
      );
      console.log(`   ✅ Updated IAM Policy "${this.name}" (created new default version)`);
    }

    return { name: this.name, arn: this.resolvedArn };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const iam = getIAMClient();

    console.log(`\n🗑️  Destroying IAM Policy "${this.name}"...`);

    if (!existing || !existing.Arn) {
      console.log(`   ✅ IAM Policy "${this.name}" does not exist - nothing to do`);
      return { destroyed: this.name };
    }

    const policyArn = existing.Arn;

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete IAM policy "${this.name}"`);
      return { destroyed: this.name };
    }

    // Must delete all non-default versions before deleting policy
    const versions = await iam.send(
      new ListPolicyVersionsCommand({ PolicyArn: policyArn }),
    );
    for (const v of versions.Versions ?? []) {
      if (!v.IsDefaultVersion) {
        await iam.send(
          new DeletePolicyVersionCommand({
            PolicyArn: policyArn,
            VersionId: v.VersionId!,
          }),
        );
      }
    }

    await iam.send(new DeletePolicyCommand({ PolicyArn: policyArn }));
    console.log(`   ✅ Deleted IAM Policy "${this.name}"`);
    return { destroyed: this.name };
  }
}

export class IAMRoleBuilder extends BaseBuilder {
  readonly out = {
    arn: new Output<string>(),
    name: new Output<string>(),
  };

  private _assumeRolePolicy: IAMPolicyDocument = DEFAULT_ASSUME_ROLE_POLICY;
  private _managedPolicies: (string | IAMPolicyBuilder)[] = [];
  private _inlinePolicies: Record<string, IAMPolicyDocument> = {};
  private _description?: string;
  private _path: string = "/";
  private _maxSessionDuration?: number;
  resolvedArn: string | null = null;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverRole(name);
  }

  private async discoverRole(name: string): Promise<any> {
    try {
      const iam = getIAMClient();
      const result = await iam.send(new GetRoleCommand({ RoleName: name }));
      this.resolvedArn = result.Role!.Arn!;
      this.out.arn.resolve(this.resolvedArn);
      this.out.name.resolve(name);
      return result.Role;
    } catch (e: any) {
      if (e.name === "NoSuchEntityException") return null;
      if (e.name === "CredentialsProviderError") return null;
      throw e;
    }
  }

  assumeRolePolicy(doc: IAMPolicyDocument) {
    this._assumeRolePolicy = doc;
    return this;
  }

  attach(policyArnOrBuilder: string | IAMPolicyBuilder) {
    this._managedPolicies.push(policyArnOrBuilder);
    return this;
  }

  inlinePolicy(name: string, doc: IAMPolicyDocument) {
    this._inlinePolicies[name] = doc;
    return this;
  }

  description(desc: string) {
    this._description = desc;
    return this;
  }

  path(p: string) {
    this._path = p;
    return this;
  }

  maxSessionDuration(seconds: number) {
    this._maxSessionDuration = seconds;
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const iam = getIAMClient();

    console.log(`\n⚡ Finalizing IAM Role "${this.name}"...`);

    if (dryRun) {
      console.log(`   📝 [PLAN] ${existing ? "Update" : "Create"} IAM role "${this.name}"`);
      this.resolvedArn = existing?.Arn ?? `arn:aws:iam::000000000000:role/DRYRUN-${this.name}`;
      this.out.arn.resolve(this.resolvedArn!);
      this.out.name.resolve(this.name);
      return { name: this.name, arn: this.resolvedArn };
    }

    if (!existing) {
      const result = await iam.send(
        new CreateRoleCommand({
          RoleName: this.name,
          AssumeRolePolicyDocument: JSON.stringify(this._assumeRolePolicy),
          Description: this._description,
          Path: this._path,
          MaxSessionDuration: this._maxSessionDuration,
        }),
      );
      this.resolvedArn = result.Role!.Arn!;
      this.out.arn.resolve(this.resolvedArn!);
      this.out.name.resolve(this.name);
      console.log(`🚀 Created IAM Role "${this.name}" (arn=${this.resolvedArn})`);
    } else {
      this.resolvedArn = existing.Arn!;
      this.out.arn.resolve(this.resolvedArn!);
      this.out.name.resolve(this.name);

      await iam.send(
        new UpdateAssumeRolePolicyCommand({
          RoleName: this.name,
          PolicyDocument: JSON.stringify(this._assumeRolePolicy),
        }),
      );

      await iam.send(
        new UpdateRoleCommand({
          RoleName: this.name,
          Description: this._description || existing.Description,
          MaxSessionDuration: this._maxSessionDuration || existing.MaxSessionDuration,
        }),
      );
      console.log(`   ✅ Updated IAM Role "${this.name}" configuration`);
    }

    // Resolve requested managed policies
    const requestedArns: string[] = [];
    for (const policy of this._managedPolicies) {
      if (policy instanceof IAMPolicyBuilder) {
        requestedArns.push(await policy.out.arn.get());
      } else {
        requestedArns.push(policy);
      }
    }

    // Sync managed policies
    const attached = await iam.send(
      new ListAttachedRolePoliciesCommand({ RoleName: this.name }),
    );
    const attachedArns = (attached.AttachedPolicies ?? []).map((p) => p.PolicyArn!);

    for (const arn of attachedArns) {
      if (!requestedArns.includes(arn)) {
        await iam.send(new DetachRolePolicyCommand({ RoleName: this.name, PolicyArn: arn }));
        console.log(`   ➖ Detached policy ${arn} from role ${this.name}`);
      }
    }

    for (const arn of requestedArns) {
      if (!attachedArns.includes(arn)) {
        await iam.send(new AttachRolePolicyCommand({ RoleName: this.name, PolicyArn: arn }));
        console.log(`   ➕ Attached policy ${arn} to role ${this.name}`);
      }
    }

    // Sync inline policies
    const inline = await iam.send(new ListRolePoliciesCommand({ RoleName: this.name }));
    const inlineNames = inline.PolicyNames ?? [];

    for (const pName of inlineNames) {
      if (!this._inlinePolicies[pName]) {
        await iam.send(new DeleteRolePolicyCommand({ RoleName: this.name, PolicyName: pName }));
        console.log(`   ➖ Deleted inline policy ${pName} from role ${this.name}`);
      }
    }

    for (const [pName, doc] of Object.entries(this._inlinePolicies)) {
      await iam.send(
        new PutRolePolicyCommand({
          RoleName: this.name,
          PolicyName: pName,
          PolicyDocument: JSON.stringify(doc),
        }),
      );
      console.log(`   ➕ Applied inline policy ${pName} to role ${this.name}`);
    }

    return { name: this.name, arn: this.resolvedArn };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const iam = getIAMClient();

    console.log(`\n🗑️  Destroying IAM Role "${this.name}"...`);

    if (!existing) {
      console.log(`   ✅ IAM Role "${this.name}" does not exist - nothing to do`);
      return { destroyed: this.name };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete IAM role "${this.name}"`);
      return { destroyed: this.name };
    }

    // Must delete all inline policies first
    const inline = await iam.send(new ListRolePoliciesCommand({ RoleName: this.name }));
    for (const pName of inline.PolicyNames ?? []) {
      await iam.send(new DeleteRolePolicyCommand({ RoleName: this.name, PolicyName: pName }));
    }

    // Must detach all attached managed policies
    const attached = await iam.send(
      new ListAttachedRolePoliciesCommand({ RoleName: this.name }),
    );
    for (const p of attached.AttachedPolicies ?? []) {
      await iam.send(new DetachRolePolicyCommand({ RoleName: this.name, PolicyArn: p.PolicyArn! }));
    }

    await iam.send(new DeleteRoleCommand({ RoleName: this.name }));
    console.log(`   ✅ Deleted IAM Role "${this.name}"`);
    return { destroyed: this.name };
  }
}
