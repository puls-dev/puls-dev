import fs from "node:fs";
import { homedir } from "node:os";
import { BaseBuilder } from "../../core/resource.js";
import { Config } from "../../core/config.js";
import { Output } from "../../core/output.js";
import { gcpFetch, getProjectId, getRegion } from "./api.js";
import { checkPort, runProvisioner } from "../../core/provisioner.js";
import { getFileHash } from "../proxmox/hash.js";
import { GCPTemplateBuilder } from "./template.js";
import { resourceContextStorage } from "../../core/context.js";

export class GCPVMBuilder extends BaseBuilder {
  readonly out = {
    ip: new Output<string>(),
    id: new Output<string>(),
  };

  private _machineType: string = "e2-micro";
  private _image: string = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts";
  private _templateSource?: GCPTemplateBuilder;
  private _zone: string = "us-central1-a";
  private _network: string = "global/networks/default";
  private _sshKeys: string | string[] = [];
  private _sshUser?: string;
  private _provision: string[] = [];
  private _forceConfigCheck: boolean = false;

  private resolvedInstanceId?: string;
  private resolvedIp?: string;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverVM();
  }

  machineType(type: string) {
    this._machineType = type;
    return this;
  }

  image(img: string) {
    this._image = img;
    return this;
  }

  fromTemplate(template: GCPTemplateBuilder) {
    this._templateSource = template;
    this.dependsOn(template);
    return this;
  }

  zone(z: string) {
    this._zone = z;
    this.discoveryPromise = this.discoverVM();
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

  sshUser(user: string) {
    this._sshUser = user;
    return this;
  }

  private resolveUser(): string {
    return (
      this._sshUser ??
      process.env.GCP_SSH_USER ??
      Config.get().providers.gcp?.sshUser ??
      "root"
    );
  }

  provision(...playbookPaths: (string | string[])[]) {
    this._provision.push(...playbookPaths.flat());
    return this;
  }

  forceConfigCheck() {
    this._forceConfigCheck = true;
    return this;
  }

  getDiff(existing: any) {
    const diffs = [];
    const liveMachineType = existing.machineType?.split("/").pop();
    if (liveMachineType !== undefined && liveMachineType !== this._machineType) {
      diffs.push({ field: "machineType", declared: this._machineType, live: liveMachineType });
    }
    return diffs;
  }

  protected async checkPort(ip: string, port: number): Promise<boolean> {
    return checkPort(ip, port);
  }

  protected async runProvisioner(ip: string, script: string): Promise<void> {
    const keysArray = Array.isArray(this._sshKeys) ? this._sshKeys : [this._sshKeys];
    const keyPath = keysArray.find(k => !k.startsWith('ssh-') && !k.startsWith('ecdsa-') && !k.startsWith('sk-'));
    if (!keyPath) {
      throw new Error(`[GCP VM:${this.name}] No SSH private key path found. Pass a file path via .sshKey() to run provisioning.`);
    }
    return runProvisioner(ip, this.resolveUser(), keyPath, script);
  }

  private async discoverVM(): Promise<any> {
    try {
      const project = getProjectId();
      const zone = this._zone;
      const res = await gcpFetch(
        "https://compute.googleapis.com",
        `/compute/v1/projects/${project}/zones/${zone}/instances/${this.name}`
      );
      if (res) {
        this.resolvedInstanceId = res.id;
        const netInterface = (res.networkInterfaces ?? [])[0];
        const extIp = (netInterface?.accessConfigs ?? [])[0]?.natIP;
        this.resolvedIp = extIp;
        if (res.id) this.out.id.resolve(res.id);
        if (extIp) this.out.ip.resolve(extIp);
      }
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

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const project = getProjectId();
    const zone = this._zone;

    // Check if machine resizing is needed
    const hasChanges = existing
      ? existing.machineType?.split("/").pop() !== this._machineType
      : true;

    if (await this.checkProtection(hasChanges)) return null;

    // Parse applied playbooks metadata from GCP metadata items
    const metadataItem = (existing?.metadata?.items ?? []).find((i: any) => i.key === "puls-provision");
    const appliedHashes = parseGcpMetadataForProvision(metadataItem?.value);

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
      console.log(`\n🔍 [DRY RUN] GCP VM "${this.name}"...`);
      if (!existing) {
        const sourceLabel = this._templateSource ? `Template: ${this._templateSource.name}` : `Image: ${this._image}`;
        console.log(`   📝 Plan: Create GCP VM Instance`);
        const details: string[] = [
          `Name:         ${this.name}`,
          `Machine Type: ${this._machineType}`,
          `Zone:         ${this._zone}`,
          `Source:       ${sourceLabel}`,
        ];
        if (this._network) {
          details.push(`Network:      ${this._network}`);
        }
        if (this._provision.length > 0) {
          details.push(`Provision:    ${this._provision.join(", ")}`);
        }
        for (let i = 0; i < details.length; i++) {
          const prefix = i === details.length - 1 ? "      └─ " : "      ├─ ";
          console.log(`${prefix}${details[i]}`);
        }
        this.out.id.resolve("PENDING");
        this.out.ip.resolve("0.0.0.0");
      } else if (hasChanges || playbookRunRequired) {
        if (hasChanges) {
          console.log(`   📝 Plan: Stop and Resize VM ${this.name} → ${this._machineType}`);
        }
        if (playbookRunRequired) {
          console.log(`   📝 [PLAN] Run ${playbooksToRun.length} playbook changes on existing GCP VM:`);
          for (const p of playbooksToRun) {
            console.log(`      └─ Playbook: ${p.path} (hash: ${p.hash})`);
          }
        }
      } else {
        console.log(`   ✅ GCP VM "${this.name}" is up to date.`);
      }
      return { name: this.name, id: "PENDING" };
    }

    console.log(`\n⏳ Finalizing GCP VM "${this.name}"...`);

    if (!existing) {
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

      // Compute initial playbooks metadata tag
      const initialHashes: Record<string, string> = {};
      for (const p of declaredPlaybooksWithHashes) {
        initialHashes[p.slug] = p.hash;
      }
      const initialMetadataVal = mergeGcpMetadataForProvision(initialHashes);

      let activeImage = this._image;
      if (this._templateSource) {
        activeImage = await this._templateSource.out.imageId.get();
      }

      const body = {
        name: this.name,
        machineType: `zones/${zone}/machineTypes/${this._machineType}`,
        disks: [
          {
            boot: true,
            autoDelete: true,
            initializeParams: {
              sourceImage: activeImage,
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
            ...(initialMetadataVal ? [{ key: "puls-provision", value: initialMetadataVal }] : []),
          ],
        },
      };

      console.log(`🚀 Creating GCP Compute VM Instance "${this.name}"...`);
      await gcpFetch(
        "https://compute.googleapis.com",
        `/compute/v1/projects/${project}/zones/${zone}/instances`,
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );

      // Poll until instance is RUNNING
      await this.waitFor(
        `GCP VM "${this.name}" to start running`,
        async () => {
          const current = await this.discoverVM();
          return current && current.status === "RUNNING";
        },
        { intervalMs: 10_000, timeoutMs: 300_000 }
      );

      console.log(`🚀 GCP VM "${this.name}" is now running.`);

      if (this._provision.length > 0) {
        const activeIp = this.resolvedIp ?? "0.0.0.0";
        if (activeIp === "0.0.0.0") {
          throw new Error(`Failed to resolve IP for new GCP VM "${this.name}" to run playbooks`);
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
      if (hasChanges) {
        console.log(`✨ Resizing GCP VM ${this.name} → ${this._machineType}...`);
        // GCP requires instance to be stopped to resize machineType
        console.log(`   🔄 Stopping VM to perform resize...`);
        await gcpFetch(
          "https://compute.googleapis.com",
          `/compute/v1/projects/${project}/zones/${zone}/instances/${this.name}/stop`,
          { method: "POST" }
        );
        await this.waitFor(
          `VM "${this.name}" to stop`,
          async () => {
            const current = await this.discoverVM();
            return current && current.status === "TERMINATED";
          },
          { intervalMs: 10_000, timeoutMs: 300_000 }
        );

        // Perform resize
        await gcpFetch(
          "https://compute.googleapis.com",
          `/compute/v1/projects/${project}/zones/${zone}/instances/${this.name}/setSize`,
          {
            method: "POST",
            body: JSON.stringify({
              machineType: `zones/${zone}/machineTypes/${this._machineType}`,
            }),
          }
        );

        // Restart VM
        console.log(`   🔄 Restarting VM...`);
        await gcpFetch(
          "https://compute.googleapis.com",
          `/compute/v1/projects/${project}/zones/${zone}/instances/${this.name}/start`,
          { method: "POST" }
        );
        await this.waitFor(
          `VM "${this.name}" to restart`,
          async () => {
            const current = await this.discoverVM();
            return current && current.status === "RUNNING";
          },
          { intervalMs: 10_000, timeoutMs: 300_000 }
        );
        console.log(`   ✅ GCP VM resized and restarted successfully.`);
      }

      if (playbookRunRequired) {
        console.log(`   🔄 Running ${playbooksToRun.length} playbook changes on GCP VM...`);
        const activeIp = this.resolvedIp ?? "0.0.0.0";
        if (activeIp === "0.0.0.0") {
          throw new Error(`Failed to resolve IP for GCP VM "${this.name}" to run playbooks`);
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

        // Re-discover to get fresh metadata fingerprint
        const fresh = await this.discoverVM();
        await this.updateGcpMetadata(fresh, appliedHashes);
        console.log(`   ✅ Playbooks applied successfully and metadata updated.`);
      }

      if (!hasChanges && !playbookRunRequired) {
        console.log(`✅ GCP VM "${this.name}" is up to date.`);
      }
    }

    const context = resourceContextStorage.getStore();
    if (context && context.hosts) {
      const activeIp = this.resolvedIp ?? "0.0.0.0";
      const keysArray = Array.isArray(this._sshKeys) ? this._sshKeys : [this._sshKeys];
      const keyPath = keysArray.find(k => !k.startsWith('ssh-') && !k.startsWith('ecdsa-') && !k.startsWith('sk-'));

      if (!context.hosts.some(h => h.name === this.name)) {
        context.hosts.push({
          name: this.name,
          ip: activeIp,
          user: this.resolveUser(),
          sshKey: keyPath,
          provider: "gcp"
        });
      }
    }

    return {
      name: this.name,
      id: this.resolvedInstanceId,
      ip: this.resolvedIp,
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const project = getProjectId();
    const zone = this._zone;

    console.log(`\n🗑️  Destroying GCP Compute VM "${this.name}"...`);

    if (!existing) {
      console.log(`   ─  GCP VM "${this.name}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete GCP VM "${this.name}"`);
      return { destroyed: this.name };
    }

    console.log(`   🔄 Deleting GCP VM "${this.name}"...`);
    await gcpFetch(
      "https://compute.googleapis.com",
      `/compute/v1/projects/${project}/zones/${zone}/instances/${this.name}`,
      {
        method: "DELETE",
      }
    );
    console.log(`   🗑️  Removed GCP VM "${this.name}"`);
    return { destroyed: this.name };
  }

  private async updateGcpMetadata(existing: any, newHashes: Record<string, string>) {
    const project = getProjectId();
    const zone = this._zone;

    const currentItems = [...(existing.metadata?.items ?? [])];
    const newValue = mergeGcpMetadataForProvision(newHashes);

    const provIdx = currentItems.findIndex((i: any) => i.key === "puls-provision");
    if (provIdx >= 0) {
      currentItems[provIdx].value = newValue;
    } else {
      currentItems.push({ key: "puls-provision", value: newValue });
    }

    await gcpFetch(
      "https://compute.googleapis.com",
      `/compute/v1/projects/${project}/zones/${zone}/instances/${this.name}/setMetadata`,
      {
        method: "POST",
        body: JSON.stringify({
          fingerprint: existing.metadata?.fingerprint,
          items: currentItems,
        }),
      }
    );
  }
}

export function parseGcpMetadataForProvision(value?: string): Record<string, string> {
  if (!value) return {};
  const record: Record<string, string> = {};
  const entries = value.split(",");
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

export function mergeGcpMetadataForProvision(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([name, hash]) => `${name}=${hash}`)
    .join(",");
}
