import {
  DescribeImagesCommand,
  DeregisterImageCommand,
  DeleteSnapshotCommand,
  RunInstancesCommand,
  DescribeInstancesCommand,
  StopInstancesCommand,
  CreateImageCommand,
  CreateTagsCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { BaseBuilder } from "../../core/resource.js";
import { Output } from "../../core/output.js";
import { getEC2Client } from "./api.js";
import { checkPort, runProvisioner } from "../../core/provisioner.js";
import { getFileHash } from "../proxmox/hash.js";
import { parseAwsTagsForProvision, mergeAwsTagsForProvision } from "./ec2.js";

export class EC2TemplateBuilder extends BaseBuilder {
  readonly out = {
    amiId: new Output<string>(),
  };

  private _baseImage: string = "ami-0c55b159cbfafe1f0"; // Default standard Ubuntu 22.04 LTS
  private _instanceType: string = "t3.micro";
  private _subnetId?: string;
  private _securityGroupIds?: string[];
  private _sshPrivateKeyPath?: string;
  private _keyName?: string;
  private _provision: string[] = [];

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverAMI();
  }

  baseImage(amiId: string) {
    this._baseImage = amiId;
    return this;
  }
  instanceType(type: string) {
    this._instanceType = type;
    return this;
  }
  subnetId(id: string) {
    this._subnetId = id;
    return this;
  }
  securityGroupIds(ids: string[]) {
    this._securityGroupIds = ids;
    return this;
  }
  sshPrivateKey(path: string) {
    this._sshPrivateKeyPath = path;
    return this;
  }
  keyName(name: string) {
    this._keyName = name;
    return this;
  }
  provision(...playbookPaths: (string | string[])[]) {
    this._provision.push(...playbookPaths.flat());
    return this;
  }

  private async discoverAMI(): Promise<any> {
    try {
      const client = getEC2Client();
      const res = await client.send(
        new DescribeImagesCommand({
          Filters: [
            { Name: "name", Values: [this.name] },
            { Name: "state", Values: ["available", "pending"] },
          ],
          Owners: ["self"],
        })
      );
      return res.Images?.[0] ?? null;
    } catch (e: any) {
      if (
        e.name === "CredentialsProviderError" ||
        e.message?.includes("credentials not configured")
      ) {
        return null;
      }
      throw e;
    }
  }

  protected async checkPort(ip: string, port: number): Promise<boolean> {
    return checkPort(ip, port);
  }

  protected async runProvisioner(ip: string, script: string): Promise<void> {
    if (!this._sshPrivateKeyPath) {
      throw new Error(`[EC2TemplateBuilder:${this.name}] sshPrivateKey(path) is required to run playbook provisioning.`);
    }
    return runProvisioner(ip, "ubuntu", this._sshPrivateKeyPath, script);
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const client = getEC2Client();

    const declaredPlaybooksWithHashes = this._provision.map((p) => {
      const baseName = p.split("/").pop() ?? p;
      const slug = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      return { path: p, slug, hash: getFileHash(p) };
    });

    if (existing) {
      this.out.amiId.resolve(existing.ImageId);

      // Check if playbooks differ
      const appliedHashes = parseAwsTagsForProvision(existing.Tags);
      const hasChanges = declaredPlaybooksWithHashes.some((p) => {
        const appliedHash = appliedHashes[p.slug];
        return !appliedHash || appliedHash !== p.hash;
      });

      if (!hasChanges) {
        console.log(`\n🔍 AWS AMI Template "${this.name}"...`);
        console.log(`   ✅ Custom AMI "${this.name}" already exists and matches defined state.`);
        return { name: this.name, amiId: existing.ImageId };
      }

      console.log(`\n⏳ Finalizing AWS AMI Template "${this.name}"...`);
      console.log(`   🔄 Template playbook hashes changed. Deregistering old custom AMI...`);
      if (dryRun) {
        console.log(`   📝 [PLAN] Would deregister AMI "${this.name}" (${existing.ImageId}) and rebuild.`);
        return { name: this.name, amiId: "PENDING" };
      } else {
        await client.send(new DeregisterImageCommand({ ImageId: existing.ImageId }));
        const mappings = existing.BlockDeviceMappings ?? [];
        for (const mapping of mappings) {
          const snapshotId = mapping.Ebs?.SnapshotId;
          if (snapshotId) {
            try {
              await client.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }));
            } catch (err: any) {
              console.warn(`   ⚠️  Could not delete snapshot ${snapshotId}: ${err.message}`);
            }
          }
        }
      }
    }

    console.log(`\n⏳ Finalizing AWS AMI Template "${this.name}"...`);

    const initialHashes: Record<string, string> = {};
    for (const p of declaredPlaybooksWithHashes) {
      initialHashes[p.slug] = p.hash;
    }
    const initialMetadataVal = mergeAwsTagsForProvision(initialHashes);

    if (dryRun) {
      console.log(`   📝 [PLAN] Bake AWS AMI Template "${this.name}"`);
      console.log(`      └─ Base Image: ${this._baseImage}  Instance Type: ${this._instanceType}`);
      if (this._provision.length > 0) {
        console.log(`      └─ Provision: ${this._provision.join(", ")}`);
      }
      this.out.amiId.resolve("PENDING");
      return { name: this.name, amiId: "PENDING" };
    }

    // Spawn temporary instance to bake
    console.log(`🚀 Spawning temporary VM "puls-bake-temp-${this.name}" to bake custom AMI...`);
    const runRes = await client.send(
      new RunInstancesCommand({
        ImageId: this._baseImage,
        InstanceType: this._instanceType as any,
        MinCount: 1,
        MaxCount: 1,
        KeyName: this._keyName,
        SubnetId: this._subnetId,
        SecurityGroupIds: this._securityGroupIds,
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [
              { Key: "Name", Value: `puls-bake-temp-${this.name}` },
            ],
          },
        ],
      })
    );

    const instanceId = runRes.Instances?.[0]?.InstanceId;
    if (!instanceId) throw new Error("Failed to retrieve instance ID from RunInstancesCommand");

    // Wait until running and IP is resolved
    let resolvedIp: string | undefined;
    await this.waitFor(
      `temporary instance "${instanceId}" to start running`,
      async () => {
        const result = await client.send(
          new DescribeInstancesCommand({ InstanceIds: [instanceId] })
        );
        const inst = result.Reservations?.[0]?.Instances?.[0];
        if (inst && inst.State?.Name === "running") {
          resolvedIp = inst.PublicIpAddress ?? inst.PrivateIpAddress ?? undefined;
          return !!resolvedIp;
        }
        return false;
      },
      { intervalMs: 10_000, timeoutMs: 300_000 }
    );

    if (!resolvedIp) {
      throw new Error(`Failed to resolve IP for temporary instance "${instanceId}"`);
    }

    // Provision the instance
    if (this._provision.length > 0) {
      await this.waitFor(
        `SSH on ${resolvedIp} to be ready`,
        () => this.checkPort(resolvedIp!, 22),
        { intervalMs: 10_000, timeoutMs: 300_000 }
      );

      for (const playbook of this._provision) {
        await this.runProvisioner(resolvedIp!, playbook);
      }
    }

    // Stop temporary instance
    console.log(`   🛑 Stopping temporary instance "${instanceId}"...`);
    await client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
    await this.waitFor(
      `temporary instance to stop`,
      async () => {
        const result = await client.send(
          new DescribeInstancesCommand({ InstanceIds: [instanceId] })
        );
        const inst = result.Reservations?.[0]?.Instances?.[0];
        return inst?.State?.Name === "stopped";
      },
      { intervalMs: 10_000, timeoutMs: 300_000 }
    );

    // Bake AMI
    console.log(`   💾 Baking custom AMI "${this.name}" from instance "${instanceId}"...`);
    const amiRes = await client.send(
      new CreateImageCommand({
        InstanceId: instanceId,
        Name: this.name,
        Description: `Puls Golden Image Template - ${this.name}`,
        NoReboot: true,
      })
    );

    const newAmiId = amiRes.ImageId;
    if (!newAmiId) throw new Error("Failed to bake custom AMI from instance");

    // Wait until AMI is available
    await this.waitFor(
      `custom AMI "${newAmiId}" to become available`,
      async () => {
        const result = await client.send(
          new DescribeImagesCommand({ ImageIds: [newAmiId] })
        );
        const img = result.Images?.[0];
        return img?.State === "available";
      },
      { intervalMs: 15_000, timeoutMs: 600_000 }
    );

    // Tag the AMI
    await client.send(
      new CreateTagsCommand({
        Resources: [newAmiId],
        Tags: [
          { Key: "Name", Value: this.name },
          ...(initialMetadataVal ? [{ Key: "puls-provision", Value: initialMetadataVal }] : []),
        ],
      })
    );
    console.log(`   ✅ Custom AMI "${this.name}" (${newAmiId}) baked successfully.`);

    // Clean up temporary instance
    console.log(`   🧹 Terminating temporary provisioning instance "${instanceId}"...`);
    await client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));

    this.out.amiId.resolve(newAmiId);
    return { name: this.name, amiId: newAmiId };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const client = getEC2Client();

    console.log(`\n🗑️  Destroying AWS AMI Template "${this.name}"...`);

    if (!existing) {
      console.log(`   ─  AWS AMI Template "${this.name}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Deregister AWS AMI "${this.name}" (id=${existing.ImageId})`);
      return { destroyed: this.name };
    }

    console.log(`   🔄 Deregistering AWS AMI "${this.name}" (id=${existing.ImageId})...`);
    await client.send(new DeregisterImageCommand({ ImageId: existing.ImageId }));

    const mappings = existing.BlockDeviceMappings ?? [];
    for (const mapping of mappings) {
      const snapshotId = mapping.Ebs?.SnapshotId;
      if (snapshotId) {
        try {
          await client.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }));
        } catch {
          // Ignore safely
        }
      }
    }

    console.log(`   🗑️  Removed AWS AMI Template "${this.name}"`);
    return { destroyed: this.name };
  }
}
