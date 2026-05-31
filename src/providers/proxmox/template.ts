import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { BaseBuilder } from "../../core/resource.js";
import { Config } from "../../core/config.js";
import { Output } from "../../core/output.js";
import { getPMClient, ProxmoxApiClient } from "./api.js";
import type { OSImage } from "../../types/proxmox.js";
import { getFileHash, parseProvisionMetadata, mergeProvisionMetadata } from "./hash.js";
import { checkPort, runProvisioner } from "../../core/provisioner.js";

export class TemplateBuilder extends BaseBuilder {
  readonly out = {
    vmid: new Output<number>(),
  };

  resolvedVmid: number | null = null;
  resolvedNode: string | null = null;

  private _baseImage?: OSImage;
  private _cores: number = 2;
  private _memory: number = 2048;
  private _provision: string[] = [];
  private _storage?: string;
  private _sshKeys?: string | string[];

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverTemplate(name);
  }

  private async discoverTemplate(name: string): Promise<any> {
    try {
      const pm = getPMClient();
      const resources = await pm.get<any[]>("/cluster/resources?type=vm");
      const match = (resources ?? []).find((r) => r.name === name && r.template === 1) ?? null;
      if (match) {
        try {
          const config = await pm.get<any>(`/nodes/${match.node}/qemu/${match.vmid}/config`);
          match.description = config.description ?? "";
        } catch {
          match.description = "";
        }
      }
      return match;
    } catch (e: any) {
      if (e.message?.includes("not configured")) return null;
      throw e;
    }
  }

  baseImage(os: OSImage) {
    this._baseImage = os;
    return this;
  }
  cores(n: number) {
    this._cores = n;
    return this;
  }
  memory(mb: number) {
    this._memory = mb;
    return this;
  }
  storage(pool: string) {
    this._storage = pool;
    return this;
  }
  sshKey(keys: string | readonly string[]) {
    this._sshKeys = Array.isArray(keys) ? [...keys] : (keys as string);
    return this;
  }
  provision(...playbookPaths: (string | string[])[]) {
    this._provision.push(...playbookPaths.flat());
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const pm = getPMClient();

    if (existing) {
      this.resolvedVmid = existing.vmid;
      this.resolvedNode = existing.node;
      this.out.vmid.resolve(existing.vmid);

      // Check if playbook hashes differ
      const appliedHashes = parseProvisionMetadata(existing.description ?? "");
      const declaredPlaybooksWithHashes = this._provision.map((p) => {
        const baseName = p.split("/").pop() ?? p;
        return { path: p, baseName, hash: getFileHash(p) };
      });

      const hasChanges = declaredPlaybooksWithHashes.some((p) => {
        const appliedHash = appliedHashes[p.baseName];
        return !appliedHash || appliedHash !== p.hash;
      });

      if (!hasChanges) {
        console.log(`\n🖥️  Finalizing Proxmox Template "${this.name}"...`);
        console.log(`   ✅ Template "${this.name}" already exists and matches defined state.`);
        return { name: this.name, vmid: this.resolvedVmid, node: this.resolvedNode };
      }

      console.log(`\n🖥️  Finalizing Proxmox Template "${this.name}"...`);
      console.log(`   🔄 Template playbook hashes changed. Purging old template...`);
      if (dryRun) {
        console.log(`   📝 [PLAN] Would purge template "${this.name}" (vmid=${existing.vmid}) and rebuild.`);
        return { name: this.name, vmid: "PENDING" };
      } else {
        await pm.delete(`/nodes/${existing.node}/qemu/${existing.vmid}?purge=1&destroy-unreferenced-disks=1`);
      }
    }

    console.log(`\n🖥️  Finalizing Proxmox Template "${this.name}"...`);

    if (dryRun) {
      console.log(`   📝 [PLAN] Bake Proxmox Template "${this.name}"`);
      if (this._baseImage) console.log(`      └─ Base Image: ${this._baseImage}`);
      console.log(`      └─ Cores: ${this._cores}  Memory: ${this._memory} MB`);
      if (this._provision.length > 0) {
        console.log(`      └─ Provision: ${this._provision.join(", ")}`);
      }
      this.out.vmid.resolve(-1);
      return { name: this.name, vmid: "PENDING" };
    }

    // Pick target node (cluster-aware)
    let node: string | undefined;
    try {
      const nodesList = await pm.get<any[]>("/nodes");
      const configuredNodes = Config.get().providers.proxmox?.nodes;
      const onlineNodes = (nodesList ?? []).filter((n) => {
        if (n.status !== "online") return false;
        if (configuredNodes && configuredNodes.length > 0) {
          return configuredNodes.includes(n.node);
        }
        return true;
      });

      if (onlineNodes.length > 0) {
        onlineNodes.sort((a, b) => {
          const freeA = (a.maxmem ?? 0) - (a.mem ?? 0);
          const freeB = (b.maxmem ?? 0) - (b.mem ?? 0);
          return freeB - freeA;
        });
        node = onlineNodes[0].node;
        console.log(
          `   🧠 Cluster-aware node selection: picked "${node}" with the most free RAM (${Math.round((((onlineNodes[0].maxmem ?? 0) - (onlineNodes[0].mem ?? 0)) / 1024 / 1024 / 1024) * 10) / 10} GB free)`
        );
      }
    } catch (err) {
      // Fallback
    }

    if (!node) {
      const configuredNodes = Config.get().providers.proxmox?.nodes;
      node = configuredNodes?.[0];
    }
    if (!node) {
      const nodes = await pm.get<any[]>("/nodes");
      node = (nodes ?? [])[0]?.node;
    }
    if (!node) throw new Error("No Proxmox nodes available");

    const newVmid = await pm.get<number>("/cluster/nextid");
    const storage = this._storage ?? "rbd_pool";

    // Lookup base image template
    const resources = await pm.get<any[]>("/cluster/resources?type=vm");
    const isVmid = this._baseImage && /^\d+$/.test(this._baseImage);
    const baseTemplate = this._baseImage
      ? (resources ?? []).find(
          (r) =>
            r.template === 1 &&
            (isVmid
              ? String(r.vmid) === this._baseImage
              : r.name?.includes(this._baseImage)),
        )
      : null;

    if (this._baseImage && !baseTemplate) {
      throw new Error(`No Proxmox base template found matching "${this._baseImage}".`);
    }

    if (baseTemplate) {
      console.log(
        `   📋 Cloning base template "${baseTemplate.name}" (vmid=${baseTemplate.vmid}) → "${this.name}" (vmid=${newVmid})`,
      );
      const taskId = await pm.post<string>(
        `/nodes/${node}/qemu/${baseTemplate.vmid}/clone`,
        {
          newid: newVmid,
          name: this.name,
          full: 1,
          storage,
          format: "raw",
        },
      );
      await this.waitForTask(node, taskId, pm);
    } else {
      console.log(`   🆕 Creating blank VM "${this.name}" (vmid=${newVmid})`);
      await pm.post(`/nodes/${node}/qemu`, {
        vmid: newVmid,
        name: this.name,
        cores: this._cores,
        memory: this._memory,
        net0: "virtio,bridge=vmbr1",
        ostype: "l26",
      });
    }

    this.resolvedVmid = newVmid;
    this.resolvedNode = node;

    // Apply config
    const configPatch: any = {
      onboot: 0,
      cores: this._cores,
      memory: this._memory,
      net0: "virtio,bridge=vmbr1",
      ipconfig0: "ip=dhcp",
      nameserver: (
        Config.get().providers.proxmox?.dnsServers ?? ["1.1.1.1", "8.8.8.8"]
      ).join(" "),
      searchdomain: Config.get().providers.proxmox?.dnsDomain ?? "",
      ciuser: "root",
    };

    const pubKeys = this.resolvePublicKeys();
    if (pubKeys.length) {
      configPatch.sshkeys = encodeURIComponent(pubKeys.join("\n"));
    }

    await pm.post(`/nodes/${node}/qemu/${newVmid}/config`, configPatch);

    // Start VM for provisioning
    await pm.post(`/nodes/${node}/qemu/${newVmid}/status/start`);
    console.log(`🚀 Started VM "${this.name}" (vmid=${newVmid}) for template provisioning...`);

    // Wait for IP
    let resolvedIp: string | null = null;
    await this.waitFor(
      `VM "${this.name}" to boot and get an IP`,
      async () => {
        try {
          const ifaces = await pm.get<any[]>(
            `/nodes/${node}/qemu/${newVmid}/agent/network-get-interfaces`,
          );
          const eth = (ifaces ?? []).find((i: any) => i.name !== "lo");
          const addr = eth?.["ip-addresses"]?.find(
            (a: any) => a["ip-address-type"] === "ipv4",
          );
          if (addr?.["ip-address"]) {
            resolvedIp = addr["ip-address"];
            return true;
          }
          return false;
        } catch {
          return false;
        }
      },
      { intervalMs: 10_000, timeoutMs: 300_000 },
    );

    if (!resolvedIp) {
      throw new Error(`Failed to resolve IP for VM "${this.name}" during provisioning`);
    }

    // Run Playbooks
    if (this._provision.length > 0) {
      await this.waitFor(
        `SSH on ${resolvedIp} to be ready`,
        () => this.checkPort(resolvedIp!, 22),
        { intervalMs: 10_000, timeoutMs: 300_000 },
      );
      await this.waitFor(
        `cloud-init to finish on ${resolvedIp}`,
        () => this.checkCloudInit(resolvedIp!),
        { intervalMs: 15_000, timeoutMs: 300_000 },
      );

      const appliedHashes: Record<string, string> = {};
      for (const script of this._provision) {
        await this.runProvisioner(resolvedIp!, script);
        const baseName = script.split("/").pop() ?? script;
        appliedHashes[baseName] = getFileHash(script);
      }

      // Write playbook metadata into VM notes description
      const updatedNotes = mergeProvisionMetadata("", appliedHashes);
      await pm.post(`/nodes/${this.resolvedNode}/qemu/${this.resolvedVmid}/config`, {
        description: updatedNotes,
      });
    }

    // Stop the VM
    console.log(`   🛑 Stopping VM "${this.name}" (vmid=${newVmid})...`);
    await pm.post(`/nodes/${node}/qemu/${newVmid}/status/stop`);
    await this.waitFor(
      `VM "${this.name}" to stop`,
      async () => {
        const s = await pm.get<any>(`/nodes/${node}/qemu/${newVmid}/status/current`);
        return s?.status === "stopped";
      },
      { intervalMs: 5_000, timeoutMs: 120_000 },
    );

    // Convert to Template
    console.log(`   💾 Converting VM "${this.name}" (vmid=${newVmid}) to template...`);
    await pm.post(`/nodes/${node}/qemu/${newVmid}/template`);
    console.log(`   ✅ Template "${this.name}" (vmid=${newVmid}) baked successfully.`);

    this.out.vmid.resolve(newVmid);
    return { name: this.name, vmid: newVmid, node };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Proxmox Template "${this.name}"...`);

    if (!existing) {
      console.log(`   ─  Template "${this.name}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Template "${this.name}" (vmid=${existing.vmid})`);
      return { destroyed: this.name };
    }

    const pm = getPMClient();
    await pm.delete(`/nodes/${existing.node}/qemu/${existing.vmid}?purge=1&destroy-unreferenced-disks=1`);
    console.log(`   🗑️  Removed Template "${this.name}" (vmid=${existing.vmid})`);
    return { destroyed: this.name };
  }

  private async waitForTask(node: string, upid: string, pm: ProxmoxApiClient): Promise<void> {
    const encoded = encodeURIComponent(upid);
    await this.waitFor(
      `clone task to complete`,
      async () => {
        const status = await pm.get<any>(`/nodes/${node}/tasks/${encoded}/status`);
        if (status?.status !== "stopped") return false;
        if (status.exitstatus && status.exitstatus !== "OK") {
          throw new Error(`Clone task failed: ${status.exitstatus}`);
        }
        return true;
      },
      { intervalMs: 5_000, timeoutMs: 300_000 },
    );
  }

  private resolvePublicKeys(): string[] {
    const input = this._sshKeys;
    if (!input) {
      try {
        return [readFileSync(`${homedir()}/.ssh/id_ed25519.pub`, "utf-8").trim()];
      } catch {
        return [];
      }
    }
    if (Array.isArray(input)) return (input as string[]).map((k) => k.trim()).filter(Boolean);
    if (
      (input as string).startsWith("ssh-") ||
      (input as string).startsWith("ecdsa-") ||
      (input as string).startsWith("sk-")
    ) {
      return [(input as string).trim()];
    }
    try {
      return [readFileSync((input as string).replace(/^~/, homedir()), "utf-8").trim()];
    } catch {
      return [];
    }
  }

  private checkCloudInit(ip: string): Promise<boolean> {
    const keyPath = this.sshKeyPath();
    return new Promise((resolve) => {
      const proc = spawn(
        "ssh",
        [
          "-i",
          keyPath,
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "BatchMode=yes",
          `root@${ip}`,
          "cloud-init status",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );

      let out = "";
      proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
      proc.on("close", () => resolve(out.includes("done") || out.includes("error")));
      proc.on("error", () => resolve(false));
    });
  }

  protected async checkPort(ip: string, port: number): Promise<boolean> {
    return checkPort(ip, port);
  }

  protected async runProvisioner(ip: string, script: string): Promise<void> {
    return runProvisioner(ip, "root", this._sshKeys, script);
  }

  private sshKeyPath(): string {
    const keyInput = Array.isArray(this._sshKeys) ? null : (this._sshKeys as string | undefined);
    return (
      keyInput &&
      !keyInput.startsWith("ssh-") &&
      !keyInput.startsWith("ecdsa-") &&
      !keyInput.startsWith("sk-")
        ? keyInput.replace(/\.pub$/, "")
        : `${homedir()}/.ssh/id_ed25519`
    ).replace(/^~/, homedir());
  }
}
