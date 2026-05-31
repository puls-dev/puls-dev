import fs from "node:fs";
import { homedir } from "node:os";
import { BaseBuilder } from "../../core/resource.js";
import { Output } from "../../core/output.js";
import { gcpFetch, getProjectId } from "./api.js";
import { checkPort, runProvisioner } from "../../core/provisioner.js";
import { getFileHash } from "../proxmox/hash.js";
import { parseGcpMetadataForProvision, mergeGcpMetadataForProvision } from "./vm.js";

export class GCPTemplateBuilder extends BaseBuilder {
  readonly out = {
    imageId: new Output<string>(),
  };

  private _baseImage: string = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts";
  private _machineType: string = "e2-micro";
  private _zone: string = "us-central1-a";
  private _network: string = "global/networks/default";
  private _sshKeys: string | string[] = [];
  private _provision: string[] = [];

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverImage();
  }

  baseImage(img: string) {
    this._baseImage = img;
    return this;
  }
  machineType(type: string) {
    this._machineType = type;
    return this;
  }
  zone(z: string) {
    this._zone = z;
    this.discoveryPromise = this.discoverImage();
    return this;
  }
  network(netPath: string) {
    this._network = netPath;
    return this;
  }
  sshKey(keys: string | string[]) {
    this._sshKeys = keys;
    return this;
  }
  provision(...playbookPaths: (string | string[])[]) {
    this._provision.push(...playbookPaths.flat());
    return this;
  }

  private async discoverImage(): Promise<any> {
    try {
      const project = getProjectId();
      const res = await gcpFetch(
        "https://compute.googleapis.com",
        `/compute/v1/projects/${project}/global/images/${this.name}`
      );
      return res ?? null;
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

  protected async checkPort(ip: string, port: number): Promise<boolean> {
    return checkPort(ip, port);
  }

  protected async runProvisioner(ip: string, script: string): Promise<void> {
    const keysArray = Array.isArray(this._sshKeys) ? this._sshKeys : [this._sshKeys];
    const keyPath = keysArray.find(k => !k.startsWith('ssh-') && !k.startsWith('ecdsa-') && !k.startsWith('sk-'));
    return runProvisioner(ip, "root", keyPath, script);
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const project = getProjectId();

    const declaredPlaybooksWithHashes = this._provision.map((p) => {
      const baseName = p.split("/").pop() ?? p;
      const slug = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      return { path: p, slug, hash: getFileHash(p) };
    });

    if (existing) {
      const finalImageId = `projects/${project}/global/images/${this.name}`;
      this.out.imageId.resolve(finalImageId);

      // Check if playbook hashes differ
      const appliedHashes = parseGcpMetadataForProvision(existing.description);
      const hasChanges = declaredPlaybooksWithHashes.some((p) => {
        const appliedHash = appliedHashes[p.slug];
        return !appliedHash || appliedHash !== p.hash;
      });

      if (!hasChanges) {
        console.log(`\n🔍 GCP Image Template "${this.name}"...`);
        console.log(`   ✅ Custom GCP Image "${this.name}" already exists and matches defined state.`);
        return { name: this.name, imageId: finalImageId };
      }

      console.log(`\n⏳ Finalizing GCP Image Template "${this.name}"...`);
      console.log(`   🔄 Template playbook hashes changed. Deleting old custom Image...`);
      if (dryRun) {
        console.log(`   📝 [PLAN] Would delete GCP Image "${this.name}" and rebuild.`);
        return { name: this.name, imageId: "PENDING" };
      } else {
        await gcpFetch(
          "https://compute.googleapis.com",
          `/compute/v1/projects/${project}/global/images/${this.name}`,
          { method: "DELETE" }
        );
      }
    }

    console.log(`\n⏳ Finalizing GCP Image Template "${this.name}"...`);

    const hashes: Record<string, string> = {};
    for (const p of declaredPlaybooksWithHashes) {
      hashes[p.slug] = p.hash;
    }
    const metadataVal = mergeGcpMetadataForProvision(hashes);

    if (dryRun) {
      console.log(`   📝 [PLAN] Bake GCP Image Template "${this.name}"`);
      console.log(`      └─ Base Image: ${this._baseImage}  Machine Type: ${this._machineType}`);
      if (this._provision.length > 0) {
        console.log(`      └─ Provision: ${this._provision.join(", ")}`);
      }
      this.out.imageId.resolve("PENDING");
      return { name: this.name, imageId: "PENDING" };
    }

    // Spawn temporary instance
    const keysArray = Array.isArray(this._sshKeys) ? this._sshKeys : [this._sshKeys];
    const sshKeysValue = keysArray
      .map((k) => {
        if (k.startsWith("ssh-") || k.startsWith("ecdsa-") || k.startsWith("sk-")) {
          return `root:${k.trim()}`;
        }
        try {
          const path = k.replace(/^~/, homedir());
          const pubPath = path.replace(/\.pub$/, "") + ".pub";
          const keyData = fs.readFileSync(pubPath, "utf-8").trim();
          return `root:${keyData}`;
        } catch {
          return `root:${k.trim()}`;
        }
      })
      .join("\n");

    const tempInstanceName = `puls-bake-temp-${this.name}`;

    const body = {
      name: tempInstanceName,
      machineType: `zones/${this._zone}/machineTypes/${this._machineType}`,
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: this._baseImage,
          },
        },
      ],
      networkInterfaces: [
        {
          network: this._network,
          accessConfigs: [
            {
              name: "External NAT",
              type: "ONE_TO_ONE_NAT",
            },
          ],
        },
      ],
      metadata: {
        items: [
          ...(sshKeysValue ? [{ key: "ssh-keys", value: sshKeysValue }] : []),
        ],
      },
    };

    console.log(`🚀 Spawning temporary VM "${tempInstanceName}" to bake custom image...`);
    await gcpFetch(
      "https://compute.googleapis.com",
      `/compute/v1/projects/${project}/zones/${this._zone}/instances`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );

    // Wait until running and IP resolved
    let resolvedIp: string | undefined;
    await this.waitFor(
      `temporary instance "${tempInstanceName}" to start running`,
      async () => {
        try {
          const res = await gcpFetch(
            "https://compute.googleapis.com",
            `/compute/v1/projects/${project}/zones/${this._zone}/instances/${tempInstanceName}`
          );
          if (res && res.status === "RUNNING") {
            const netInterface = (res.networkInterfaces ?? [])[0];
            resolvedIp = (netInterface?.accessConfigs ?? [])[0]?.natIP;
            return !!resolvedIp;
          }
        } catch {
          // Ignore
        }
        return false;
      },
      { intervalMs: 10_000, timeoutMs: 300_000 }
    );

    if (!resolvedIp) {
      throw new Error(`Failed to resolve IP for temporary instance "${tempInstanceName}"`);
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
    console.log(`   🛑 Stopping temporary instance "${tempInstanceName}"...`);
    await gcpFetch(
      "https://compute.googleapis.com",
      `/compute/v1/projects/${project}/zones/${this._zone}/instances/${tempInstanceName}/stop`,
      { method: "POST" }
    );
    await this.waitFor(
      `temporary instance to stop`,
      async () => {
        try {
          const res = await gcpFetch(
            "https://compute.googleapis.com",
            `/compute/v1/projects/${project}/zones/${this._zone}/instances/${tempInstanceName}`
          );
          return res && res.status === "TERMINATED";
        } catch {
          return false;
        }
      },
      { intervalMs: 10_000, timeoutMs: 300_000 }
    );

    // Bake Image
    console.log(`   💾 Baking custom GCP Image "${this.name}" from instance disk...`);
    const imageBody = {
      name: this.name,
      sourceDisk: `zones/${this._zone}/disks/${tempInstanceName}`,
      description: metadataVal,
    };

    await gcpFetch(
      "https://compute.googleapis.com",
      `/compute/v1/projects/${project}/global/images`,
      {
        method: "POST",
        body: JSON.stringify(imageBody),
      }
    );

    // Wait until image is ready
    await this.waitFor(
      `custom image "${this.name}" to become ready`,
      async () => {
        const img = await this.discoverImage();
        return img && img.status === "READY";
      },
      { intervalMs: 10_000, timeoutMs: 300_000 }
    );
    console.log(`   ✅ Custom GCP Image "${this.name}" baked successfully.`);

    // Clean up temporary instance
    console.log(`   🧹 Terminating temporary provisioning instance...`);
    await gcpFetch(
      "https://compute.googleapis.com",
      `/compute/v1/projects/${project}/zones/${this._zone}/instances/${tempInstanceName}`,
      { method: "DELETE" }
    );

    const finalImageId = `projects/${project}/global/images/${this.name}`;
    this.out.imageId.resolve(finalImageId);
    return { name: this.name, imageId: finalImageId };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const project = getProjectId();

    console.log(`\n🗑️  Destroying GCP Image Template "${this.name}"...`);

    if (!existing) {
      console.log(`   ─  GCP Image Template "${this.name}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete GCP Image "${this.name}"`);
      return { destroyed: this.name };
    }

    console.log(`   🔄 Deleting GCP Image "${this.name}"...`);
    await gcpFetch(
      "https://compute.googleapis.com",
      `/compute/v1/projects/${project}/global/images/${this.name}`,
      { method: "DELETE" }
    );

    console.log(`   🗑️  Removed GCP Image Template "${this.name}"`);
    return { destroyed: this.name };
  }
}
