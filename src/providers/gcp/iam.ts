import { BaseBuilder } from "../../core/resource.js";
import { Output } from "../../core/output.js";
import { gcpFetch, getProjectId } from "./api.js";

const IAM_BASE = "https://iam.googleapis.com";
const CRM_BASE = "https://cloudresourcemanager.googleapis.com";

export class GCPServiceAccountBuilder extends BaseBuilder {
  readonly out = {
    email: new Output<string>(),
    name: new Output<string>(),
  };

  private _displayName?: string;
  private _description?: string;

  constructor(accountId: string) {
    super(accountId);
    this.discoveryPromise = this.discoverServiceAccount();
  }

  get email(): string {
    const project = getProjectId();
    return `${this.name}@${project}.iam.gserviceaccount.com`;
  }

  displayName(name: string) {
    this._displayName = name;
    return this;
  }

  description(desc: string) {
    this._description = desc;
    return this;
  }

  private async discoverServiceAccount(): Promise<any> {
    try {
      const project = getProjectId();
      const sa = await gcpFetch(
        IAM_BASE,
        `/v1/projects/${project}/serviceAccounts/${this.email}`
      );
      if (sa) {
        this.out.email.resolve(this.email);
        this.out.name.resolve(sa.name ?? `projects/${project}/serviceAccounts/${this.email}`);
      }
      return sa;
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

  async deploy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const existing = await this.discoveryPromise;

    console.log(`\n👤 Finalizing GCP Service Account "${this.name}"...`);

    if (dryRun) {
      if (existing) {
        console.log(`   ✅ Service account "${this.name}" exists (email: ${this.email})`);
        if (this._displayName || this._description) {
          console.log(`   📝 [PLAN] Update service account metadata`);
        }
      } else {
        console.log(`   📝 [PLAN] Create service account "${this.name}"`);
      }
      this.out.email.resolve(this.email);
      this.out.name.resolve(`projects/${project}/serviceAccounts/${this.email}`);
      return { email: this.email, name: `projects/${project}/serviceAccounts/${this.email}` };
    }

    if (!existing) {
      console.log(`🚀 Creating GCP Service Account "${this.name}"...`);
      const sa = await gcpFetch(
        IAM_BASE,
        `/v1/projects/${project}/serviceAccounts`,
        {
          method: "POST",
          body: JSON.stringify({
            accountId: this.name,
            serviceAccount: {
              displayName: this._displayName,
              description: this._description,
            },
          }),
        }
      );
      this.out.email.resolve(this.email);
      this.out.name.resolve(sa.name ?? `projects/${project}/serviceAccounts/${this.email}`);
      console.log(`   ✅ Service account created: ${this.email}`);
    } else {
      console.log(`   ✅ Service account "${this.name}" exists`);
      const needsUpdate =
        (this._displayName && existing.displayName !== this._displayName) ||
        (this._description && existing.description !== this._description);

      if (needsUpdate) {
        console.log(`🔄 Updating GCP Service Account "${this.name}" metadata...`);
        await gcpFetch(
          IAM_BASE,
          `/v1/projects/${project}/serviceAccounts/${this.email}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              displayName: this._displayName,
              description: this._description,
            }),
          }
        );
        console.log(`   ✅ Metadata updated.`);
      }
    }

    await this.deploySidecars();

    return {
      email: this.email,
      name: `projects/${project}/serviceAccounts/${this.email}`,
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();

    console.log(`\n🗑️  Destroying GCP Service Account "${this.name}"...`);

    const existing = await this.discoverServiceAccount();

    if (!existing) {
      console.log(`   ✅ Service account "${this.name}" does not exist - nothing to do.`);
      return { destroyed: this.name };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete service account "${this.name}" (${this.email})`);
      return { destroyed: this.name };
    }

    await gcpFetch(
      IAM_BASE,
      `/v1/projects/${project}/serviceAccounts/${this.email}`,
      {
        method: "DELETE",
      }
    );
    console.log(`   ✅ Service account "${this.name}" deleted.`);

    await this.destroySidecars();
    return { destroyed: this.name };
  }
}

export class GCPIAMBindingBuilder extends BaseBuilder {
  private _role!: string;
  private _members: (string | GCPServiceAccountBuilder | Output<string>)[] = [];

  constructor(name: string) {
    super(name);
    // Bindings are project-wide and dynamic, so discovery of project policy happens during deploy
    this.discoveryPromise = Promise.resolve(null);
  }

  role(name: string) {
    this._role = name;
    return this;
  }

  member(m: string | GCPServiceAccountBuilder | Output<string>) {
    this._members.push(m);
    return this;
  }

  members(...m: (string | GCPServiceAccountBuilder | Output<string>)[]) {
    this._members.push(...m);
    return this;
  }

  private async resolveMembers(): Promise<string[]> {
    const resolved: string[] = [];
    for (const m of this._members) {
      if (m instanceof GCPServiceAccountBuilder) {
        resolved.push(`serviceAccount:${m.email}`);
      } else if (m instanceof Output) {
        const val = await m.get();
        resolved.push(val.includes(":") ? val : `serviceAccount:${val}`);
      } else {
        const val = String(m);
        if (val.includes(":")) {
          resolved.push(val);
        } else if (val.includes("@")) {
          if (val.endsWith(".gserviceaccount.com")) {
            resolved.push(`serviceAccount:${val}`);
          } else {
            resolved.push(`user:${val}`);
          }
        } else {
          const project = getProjectId();
          resolved.push(`serviceAccount:${val}@${project}.iam.gserviceaccount.com`);
        }
      }
    }
    return resolved;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();

    console.log(`\n🔐 Finalizing GCP IAM Binding for Role "${this._role}"...`);

    if (!this._role) {
      throw new Error(`[GCP.IAMBinding:${this.name}] .role("...") is required`);
    }
    if (this._members.length === 0) {
      throw new Error(`[GCP.IAMBinding:${this.name}] At least one member is required via .member()/.members()`);
    }

    const resolvedMembers = await this.resolveMembers();

    // 1. Fetch current policy
    let policy: any;
    try {
      policy = await gcpFetch(
        CRM_BASE,
        `/v1/projects/${project}:getIamPolicy`,
        {
          method: "POST",
          body: JSON.stringify({}),
        }
      );
    } catch (e: any) {
      if (dryRun || e.message?.includes("credentials not configured")) {
        policy = { bindings: [], etag: "DRYRUN_ETAG" };
      } else {
        throw e;
      }
    }

    const bindings = policy.bindings ?? [];
    let binding = bindings.find((b: any) => b.role === this._role);

    // 2. Compute members to add
    const toAdd: string[] = [];
    if (!binding) {
      toAdd.push(...resolvedMembers);
    } else {
      const existingMembers = binding.members ?? [];
      for (const m of resolvedMembers) {
        if (!existingMembers.includes(m)) {
          toAdd.push(m);
        }
      }
    }

    if (toAdd.length === 0) {
      console.log(`   ✅ IAM binding for role "${this._role}" is up to date (members already bound)`);
      return { role: this._role, bound: resolvedMembers };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Bind members [${toAdd.join(", ")}] to role "${this._role}"`);
      return { role: this._role, bound: resolvedMembers };
    }

    // 3. Mutate policy safely
    if (!binding) {
      binding = { role: this._role, members: resolvedMembers };
      bindings.push(binding);
    } else {
      binding.members = [...(binding.members ?? []), ...toAdd];
    }

    policy.bindings = bindings;

    // 4. Set updated policy with optimistic locking etag
    await gcpFetch(
      CRM_BASE,
      `/v1/projects/${project}:setIamPolicy`,
      {
        method: "POST",
        body: JSON.stringify({
          policy,
        }),
      }
    );

    console.log(`🚀 Successfully bound members [${toAdd.join(", ")}] to role "${this._role}"`);
    await this.deploySidecars();

    return {
      role: this._role,
      bound: resolvedMembers,
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();

    console.log(`\n🗑️  Removing GCP IAM Bindings for Role "${this._role}"...`);

    if (!this._role) {
      return { destroyed: this.name };
    }

    const resolvedMembers = await this.resolveMembers();

    // 1. Fetch current policy
    let policy: any;
    try {
      policy = await gcpFetch(
        CRM_BASE,
        `/v1/projects/${project}:getIamPolicy`,
        {
          method: "POST",
          body: JSON.stringify({}),
        }
      );
    } catch (e: any) {
      if (dryRun || e.message?.includes("credentials not configured")) {
        return { destroyed: this.name };
      }
      throw e;
    }

    const bindings = policy.bindings ?? [];
    const binding = bindings.find((b: any) => b.role === this._role);

    if (!binding) {
      console.log(`   ✅ No bindings found for role "${this._role}" - nothing to do.`);
      return { destroyed: this.name };
    }

    const existingMembers = binding.members ?? [];
    const remaining = existingMembers.filter((m: string) => !resolvedMembers.includes(m));
    const removed = existingMembers.filter((m: string) => resolvedMembers.includes(m));

    if (removed.length === 0) {
      console.log(`   ✅ Bound members already removed - nothing to do.`);
      return { destroyed: this.name };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Remove members [${removed.join(", ")}] from role "${this._role}"`);
      return { destroyed: this.name };
    }

    // 2. Safe removal
    if (remaining.length === 0) {
      // If no members left in this role, remove the role binding block completely
      policy.bindings = bindings.filter((b: any) => b.role !== this._role);
    } else {
      binding.members = remaining;
      policy.bindings = bindings;
    }

    // 3. Set updated policy with etag
    await gcpFetch(
      CRM_BASE,
      `/v1/projects/${project}:setIamPolicy`,
      {
        method: "POST",
        body: JSON.stringify({
          policy,
        }),
      }
    );

    console.log(`   ✅ Removed members [${removed.join(", ")}] from role "${this._role}".`);
    await this.destroySidecars();

    return { destroyed: this.name };
  }
}
