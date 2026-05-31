import fs from "node:fs";
import { homedir } from "node:os";
import {
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  StopInstancesCommand,
  StartInstancesCommand,
  ModifyInstanceAttributeCommand,
  CreateTagsCommand,
} from "@aws-sdk/client-ec2";
import { BaseBuilder } from "../../core/resource.js";
import { Output } from "../../core/output.js";
import { getEC2Client } from "./api.js";
import { checkPort, runProvisioner } from "../../core/provisioner.js";
import { getFileHash } from "../proxmox/hash.js";
import { EC2TemplateBuilder } from "./template.js";

export class EC2VMBuilder extends BaseBuilder {
  readonly out = {
    ip: new Output<string>(),
    id: new Output<string>(),
  };

  private _instanceType: string = "t3.micro";
  private _ami: string = "ami-0c55b159cbfafe1f0"; // Default standard Ubuntu 22.04 LTS in us-east-1
  private _templateSource?: EC2TemplateBuilder;
  private _keyName?: string;
  private _subnetId?: string;
  private _securityGroupIds?: string[];
  private _userData?: string;
  private _sshPrivateKeyPath?: string;
  private _provision: string[] = [];
  private _forceConfigCheck: boolean = false;

  private resolvedInstanceId?: string;
  private resolvedIp?: string;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverVM();
  }

  instanceType(type: string) {
    this._instanceType = type;
    return this;
  }

  ami(amiId: string) {
    this._ami = amiId;
    return this;
  }

  fromTemplate(template: EC2TemplateBuilder) {
    this._templateSource = template;
    this.dependsOn(template);
    return this;
  }

  keyName(name: string) {
    this._keyName = name;
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

  userData(data: string) {
    this._userData = data;
    return this;
  }

  sshPrivateKey(path: string) {
    this._sshPrivateKeyPath = path;
    return this;
  }

  provision(...playbookPaths: (string | string[])[]) {
    this._provision.push(...playbookPaths.flat());
    return this;
  }

  forceConfigCheck() {
    this._forceConfigCheck = true;
    return this;
  }

  protected async checkPort(ip: string, port: number): Promise<boolean> {
    return checkPort(ip, port);
  }

  protected async runProvisioner(ip: string, script: string): Promise<void> {
    if (!this._sshPrivateKeyPath) {
      throw new Error(`[EC2VMBuilder:${this.name}] sshPrivateKey(path) is required to run playbook provisioning.`);
    }
    // Default user is 'ubuntu' for standard Ubuntu images on AWS EC2
    return runProvisioner(ip, "ubuntu", this._sshPrivateKeyPath, script);
  }

  private async discoverVM(): Promise<any> {
    try {
      const client = getEC2Client();
      const result = await client.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: "tag:Name", Values: [this.name] },
            {
              Name: "instance-state-name",
              Values: ["pending", "running", "stopping", "stopped"],
            },
          ],
        })
      );
      const reservation = result.Reservations?.[0];
      const instance = reservation?.Instances?.[0];
      if (instance) {
        this.resolvedInstanceId = instance.InstanceId;
        this.resolvedIp = instance.PublicIpAddress ?? instance.PrivateIpAddress ?? undefined;
        if (instance.InstanceId) this.out.id.resolve(instance.InstanceId);
        if (this.resolvedIp) this.out.ip.resolve(this.resolvedIp);
      }
      return instance ?? null;
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

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const client = getEC2Client();

    const hasChanges = existing ? existing.InstanceType !== this._instanceType : true;

    if (await this.checkProtection(hasChanges)) return null;

    // Parse applied playbooks metadata from EC2 Tags
    const appliedHashes = parseAwsTagsForProvision(existing?.Tags);

    const declaredPlaybooksWithHashes = this._provision.map((p) => {
      const baseName = p.split("/").pop() ?? p;
      const slug = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      return { path: p, slug, hash: getFileHash(p) };
    });

    const playbooksToRun = this._forceConfigCheck
      ? declaredPlaybooksWithHashes
      : declaredPlaybooksWithHashes.filter((p) => {
          const appliedHash = appliedHashes[p.slug];
          return !appliedHash || appliedHash !== p.hash;
        });

    const playbookRunRequired = playbooksToRun.length > 0;

    if (dryRun) {
      console.log(`\n🔍 [DRY RUN] AWS EC2 VM "${this.name}"...`);
      if (!existing) {
        const sourceLabel = this._templateSource ? `Template: ${this._templateSource.name}` : `AMI ${this._ami}`;
        console.log(`   📝 Plan: Create AWS EC2 Instance`);
        const details: string[] = [
          `Name:          ${this.name}`,
          `Instance Type: ${this._instanceType}`,
          `Source:        ${sourceLabel}`,
        ];
        if (this._provision.length > 0) {
          details.push(`Provision:     ${this._provision.join(", ")}`);
        }
        for (let i = 0; i < details.length; i++) {
          const prefix = i === details.length - 1 ? "      └─ " : "      ├─ ";
          console.log(`${prefix}${details[i]}`);
        }
        this.out.id.resolve("PENDING");
        this.out.ip.resolve("0.0.0.0");
      } else if (hasChanges || playbookRunRequired) {
        if (hasChanges) {
          console.log(`   📝 Plan: Stop, Resize, and Start EC2 VM ${this.name} (${existing.InstanceType} → ${this._instanceType})`);
        }
        if (playbookRunRequired) {
          console.log(`   📝 [PLAN] Run ${playbooksToRun.length} playbook changes on existing EC2 VM:`);
          for (const p of playbooksToRun) {
            console.log(`      └─ Playbook: ${p.path} (hash: ${p.hash})`);
          }
        }
      } else {
        console.log(`   ✅ AWS EC2 VM "${this.name}" is up to date.`);
      }
      return { name: this.name, id: this.resolvedInstanceId ?? "PENDING" };
    }

    console.log(`\n⏳ Finalizing AWS EC2 VM "${this.name}"...`);

    if (!existing) {
      const initialHashes: Record<string, string> = {};
      for (const p of declaredPlaybooksWithHashes) {
        initialHashes[p.slug] = p.hash;
      }
      const initialMetadataVal = mergeAwsTagsForProvision(initialHashes);

      let activeAmi = this._ami;
      if (this._templateSource) {
        activeAmi = await this._templateSource.out.amiId.get();
      }

      console.log(`🚀 Creating AWS EC2 VM Instance "${this.name}"...`);
      const result = await client.send(
        new RunInstancesCommand({
          ImageId: activeAmi,
          InstanceType: this._instanceType as any,
          MinCount: 1,
          MaxCount: 1,
          KeyName: this._keyName,
          SubnetId: this._subnetId,
          SecurityGroupIds: this._securityGroupIds,
          UserData: this._userData ? Buffer.from(this._userData).toString("base64") : undefined,
          TagSpecifications: [
            {
              ResourceType: "instance",
              Tags: [
                { Key: "Name", Value: this.name },
                ...(initialMetadataVal ? [{ Key: "puls-provision", Value: initialMetadataVal }] : []),
              ],
            },
          ],
        })
      );

      const instanceId = result.Instances?.[0]?.InstanceId;
      if (!instanceId) throw new Error("Failed to retrieve instance ID from RunInstancesCommand");
      this.resolvedInstanceId = instanceId;
      this.out.id.resolve(instanceId);

      // Poll until instance is running and has an IP address
      await this.waitFor(
        `AWS EC2 VM "${this.name}" to start running`,
        async () => {
          const current = await this.discoverVM();
          return current && current.State?.Name === "running" && !!this.resolvedIp;
        },
        { intervalMs: 10_000, timeoutMs: 300_000 }
      );

      console.log(`🚀 AWS EC2 VM "${this.name}" is now running.`);

      if (this._provision.length > 0) {
        const activeIp = this.resolvedIp ?? "0.0.0.0";
        if (activeIp === "0.0.0.0") {
          throw new Error(`Failed to resolve IP for new AWS EC2 VM "${this.name}" to run playbooks`);
        }

        await this.waitFor(
          `SSH on ${activeIp} to be ready`,
          () => this.checkPort(activeIp, 22),
          { intervalMs: 10_000, timeoutMs: 300_000 }
        );

        for (const playbook of this._provision) {
          await this.runProvisioner(activeIp, playbook);
        }
      }
    } else {
      const instanceId = existing.InstanceId!;
      this.resolvedInstanceId = instanceId;

      if (hasChanges) {
        console.log(`✨ Resizing AWS EC2 VM ${this.name} (${existing.InstanceType} → ${this._instanceType})...`);
        console.log(`   🔄 Stopping EC2 VM to perform resize...`);
        await client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
        
        await this.waitFor(
          `VM "${this.name}" to stop`,
          async () => {
            const current = await this.discoverVM();
            return current && current.State?.Name === "stopped";
          },
          { intervalMs: 10_000, timeoutMs: 300_000 }
        );

        // Perform resize
        await client.send(
          new ModifyInstanceAttributeCommand({
            InstanceId: instanceId,
            InstanceType: { Value: this._instanceType as any },
          })
        );

        // Restart VM
        console.log(`   🔄 Restarting EC2 VM...`);
        await client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
        
        await this.waitFor(
          `VM "${this.name}" to restart`,
          async () => {
            const current = await this.discoverVM();
            return current && current.State?.Name === "running" && !!this.resolvedIp;
          },
          { intervalMs: 10_000, timeoutMs: 300_000 }
        );
        console.log(`   ✅ AWS EC2 VM resized and restarted successfully.`);
      }

      if (playbookRunRequired) {
        console.log(`   🔄 Running ${playbooksToRun.length} playbook changes on AWS EC2 VM...`);
        const activeIp = this.resolvedIp ?? "0.0.0.0";
        if (activeIp === "0.0.0.0") {
          throw new Error(`Failed to resolve IP for AWS EC2 VM "${this.name}" to run playbooks`);
        }

        await this.waitFor(
          `SSH on ${activeIp} to be ready`,
          () => this.checkPort(activeIp, 22),
          { intervalMs: 10_000, timeoutMs: 300_000 }
        );

        for (const p of playbooksToRun) {
          await this.runProvisioner(activeIp, p.path);
          appliedHashes[p.slug] = p.hash;
        }

        // Update EC2 Tags with new hashes
        const newValue = mergeAwsTagsForProvision(appliedHashes);
        await client.send(
          new CreateTagsCommand({
            Resources: [instanceId],
            Tags: [{ Key: "puls-provision", Value: newValue }],
          })
        );
        console.log(`   ✅ Playbooks applied successfully and EC2 Tags updated.`);
      }

      if (!hasChanges && !playbookRunRequired) {
        console.log(`   ✅ AWS EC2 VM "${this.name}" is up to date.`);
      }
    }

    await this.deploySidecars();
    return {
      name: this.name,
      id: this.resolvedInstanceId,
      ip: this.resolvedIp,
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const client = getEC2Client();

    console.log(`\n🗑️  Destroying AWS EC2 VM "${this.name}"...`);

    if (!existing) {
      console.log(`   ─  AWS EC2 VM "${this.name}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete AWS EC2 VM "${this.name}" (id=${existing.InstanceId})`);
      return { destroyed: this.name };
    }

    console.log(`   🔄 Terminating AWS EC2 VM "${this.name}" (id=${existing.InstanceId})...`);
    await client.send(new TerminateInstancesCommand({ InstanceIds: [existing.InstanceId!] }));
    console.log(`   🗑️  Removed AWS EC2 VM "${this.name}"`);
    
    await this.destroySidecars();
    return { destroyed: this.name };
  }
}

export function parseAwsTagsForProvision(tags?: any[]): Record<string, string> {
  const tag = (tags ?? []).find((t) => t.Key === "puls-provision");
  if (!tag?.Value) return {};
  const record: Record<string, string> = {};
  const entries = tag.Value.split(",");
  for (const entry of entries) {
    const parts = entry.trim().split("=");
    if (parts.length === 2) {
      const [name, hash] = parts;
      if (name && hash) {
        record[name.trim()] = hash.trim();
      }
    }
  }
  return record;
}

export function mergeAwsTagsForProvision(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([name, hash]) => `${name}=${hash}`)
    .join(",");
}
