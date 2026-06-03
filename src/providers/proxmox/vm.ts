import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { BaseBuilder } from "../../core/resource.js";
import { Config } from "../../core/config.js";
import { Output } from "../../core/output.js";
import { getPMClient, ProxmoxApiClient } from "./api.js";
import type { OSImage } from "../../types/proxmox.js";
import { getFileHash, parseProvisionMetadata, mergeProvisionMetadata } from "./hash.js";
import { checkPort, runProvisioner } from "../../core/provisioner.js";
import { TemplateBuilder } from "./template.js";
import { resourceContextStorage } from "../../core/context.js";

export class VMBuilder extends BaseBuilder {
  readonly out = {
    ip: new Output<string>(),
    vmid: new Output<number>(),
  };

  resolvedVmid: number | null = null;
  resolvedNode: string | null = null;
  resolvedIp: string | null = null;

  private _image?: OSImage;
  private _templateSource?: TemplateBuilder;
  private _cores: number = 2;
  private _memory: number = 2048;
  private _provision: string[] = [];
  private _replace?: string;
  private _node?: string;
  private _storage?: string;
  private _vlan?: number;
  private _ip?: string;
  private _sshKeys?: string | string[];
  private _machine: "q35" | "i440fx" = "q35";
  private _forceConfigCheck: boolean = false;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverVm(name);
  }

  private async discoverVm(name: string): Promise<any> {
    try {
      const pm = getPMClient();
      const resources = await pm.get<any[]>("/cluster/resources?type=vm");
      const match = (resources ?? []).find((r) => r.name === name && !r.template) ?? null;
      if (match) {
        try {
          const config = await pm.get<any>(`/nodes/${match.node}/qemu/${match.vmid}/config`);
          match.description = config.description ?? "";
        } catch (err: any) {
          console.warn(`   ⚠️  Could not fetch VM config for ${match.vmid}: ${err.message}`);
          match.description = "";
        }
      }
      return match;
    } catch (e: any) {
      if (e.message?.includes("not configured")) return null;
      throw e;
    }
  }

  image(os: OSImage) {
    this._image = os;
    return this;
  }
  fromTemplate(template: TemplateBuilder) {
    this._templateSource = template;
    this.dependsOn(template);
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
  provision(...playbookPaths: (string | string[])[]) {
    this._provision.push(...playbookPaths.flat());
    return this;
  }
  replace(oldVmName: string) {
    this._replace = oldVmName;
    return this;
  }
  node(n: string) {
    this._node = n;
    return this;
  }

  storage(pool: string) {
    this._storage = pool;
    return this;
  }
  vlan(tag: number) {
    this._vlan = tag;
    return this;
  }
  ip(address: string) {
    this._ip = address;
    return this;
  }
  sshKey(keys: string | readonly string[]) {
    this._sshKeys = Array.isArray(keys) ? [...keys] : (keys as string);
    return this;
  }
  machine(type: "q35" | "i440fx") {
    this._machine = type;
    return this;
  }
  forceConfigCheck() {
    this._forceConfigCheck = true;
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

      // Resolve the IP of the existing VM
      this.resolvedIp = await this.resolveExistingIp(existing.node, existing.vmid, pm);
      if (this.resolvedIp) {
        this.out.ip.resolve(this.resolvedIp);
      }
      this.registerHost();

      const activeIp = this.resolvedIp ?? "0.0.0.0";

      // 1. Calculate hashes and check if playbooks need to run
      const appliedHashes = parseProvisionMetadata(existing.description ?? "");
      const declaredPlaybooksWithHashes = this._provision.map((p) => {
        const baseName = p.split("/").pop() ?? p;
        return { path: p, baseName, hash: getFileHash(p) };
      });

      const playbooksToRun = this._forceConfigCheck
        ? declaredPlaybooksWithHashes
        : declaredPlaybooksWithHashes.filter((p) => {
            const appliedHash = appliedHashes[p.baseName];
            return !appliedHash || appliedHash !== p.hash;
          });

      if (playbooksToRun.length > 0) {
        console.log(`\n🖥️  Finalizing Proxmox VM "${this.name}"...`);
        console.log(
          `   ✅ VM "${this.name}" already exists (vmid=${existing.vmid}, node=${existing.node}, status=${existing.status})`
        );

        if (dryRun) {
          console.log(`   📝 [PLAN] Run ${playbooksToRun.length} playbook changes on existing VM:`);
          for (const p of playbooksToRun) {
            console.log(`      └─ Playbook: ${p.path} (hash: ${p.hash})`);
          }
        } else {
          console.log(`   🔄 Running ${playbooksToRun.length} playbook changes → ${activeIp}`);
          if (activeIp === "0.0.0.0") {
            throw new Error(`Failed to resolve IP for existing VM "${this.name}" to run playbooks`);
          }

          // Wait for SSH
          await this.waitFor(
            `SSH on ${activeIp} to be ready`,
            () => this.checkPort(activeIp, 22),
            { intervalMs: 10_000, timeoutMs: 300_000 }
          );

          // Execute each playbook
          for (const p of playbooksToRun) {
            await this.runProvisioner(activeIp, p.path);
            appliedHashes[p.baseName] = p.hash;
          }

          // Update notes on Proxmox VM
          const updatedNotes = mergeProvisionMetadata(existing.description ?? "", appliedHashes);
          await pm.post(`/nodes/${existing.node}/qemu/${existing.vmid}/config`, {
            description: updatedNotes,
          });
          console.log(`   ✅ Playbooks applied successfully and metadata updated.`);
        }

        return {
          name: this.name,
          vmid: this.resolvedVmid,
          node: this.resolvedNode,
          ip: activeIp,
        };
      }

      // No playbook changes!
      console.log(`\n🖥️  Finalizing Proxmox VM "${this.name}"...`);
      console.log(
        `   ✅ VM "${this.name}" already exists (vmid=${existing.vmid}, node=${existing.node}, status=${existing.status})`
      );
      console.log(`   ✅ Configuration and playbooks are up to date.`);
      return {
        name: this.name,
        vmid: this.resolvedVmid,
        node: this.resolvedNode,
        ip: activeIp,
      };
    }

    console.log(`\n🖥️  Finalizing Proxmox VM "${this.name}"...`);

    if (dryRun) {
      console.log(`   📝 [PLAN] Create VM "${this.name}"`);
      if (this._image) console.log(`      └─ Image: ${this._image}`);
      if (this._templateSource) console.log(`      └─ Template: ${this._templateSource.name}`);
      console.log(`      └─ Cores: ${this._cores}  Memory: ${this._memory} MB  Machine: ${this._machine}`);
      if (this._vlan) console.log(`      └─ VLAN: ${this._vlan}`);
      if (this._provision.length > 0) {
        console.log(`      └─ Provision: ${this._provision.join(", ")}`);
      }
      if (this._replace)
        console.log(`      └─ Replace: "${this._replace}" after creation`);
      this.out.vmid.resolve(-1);
      this.out.ip.resolve(this._ip?.split("/")[0] ?? "0.0.0.0");
      return { name: this.name, vmid: "PENDING" };
    }

    // Find the template - match by VMID (numeric string) or name substring
    let sourceVmid: string | undefined;
    if (this._templateSource) {
      const v = await this._templateSource.out.vmid.get();
      sourceVmid = String(v);
    } else if (this._image) {
      sourceVmid = String(this._image);
    }

    const resources = await pm.get<any[]>("/cluster/resources?type=vm");
    const isVmid = sourceVmid && /^\d+$/.test(sourceVmid);
    const template = sourceVmid
      ? (resources ?? []).find(
          (r) =>
            r.template === 1 &&
            (isVmid
              ? String(r.vmid) === sourceVmid
              : r.name?.includes(sourceVmid)),
        )
      : null;

    if (sourceVmid && !template) {
      throw new Error(
        `No Proxmox template found matching "${sourceVmid}". ` +
          (isVmid
            ? `Check that VMID ${sourceVmid} exists and is marked as a template.`
            : `Create a template whose name contains "${sourceVmid}".`),
      );
    }

    // Resolve target node: explicit → cluster-aware (online & max free RAM) → configured nodes list → template's node → API discovery
    let node = this._node;
    if (!node) {
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
          // Sort descending by free memory (maxmem - mem)
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
        // Fallback silently to configured nodes list or discovery
      }
    }

    if (!node) {
      const configuredNodes = Config.get().providers.proxmox?.nodes;
      node = configuredNodes?.[0] ?? template?.node;
    }
    if (!node) {
      const nodes = await pm.get<any[]>("/nodes");
      node = (nodes ?? [])[0]?.node;
    }
    if (!node) throw new Error("No Proxmox nodes available");

    const newVmid = await pm.get<number>("/cluster/nextid");
    const storage = this._storage ?? "rbd_pool";

    if (template) {
      console.log(
        `   📋 Cloning template "${template.name}" (vmid=${template.vmid}) → "${this.name}" (vmid=${newVmid})`,
      );
      const taskId = await pm.post<string>(
        `/nodes/${template.node || node}/qemu/${template.vmid}/clone`,
        {
          newid: newVmid,
          name: this.name,
          full: 1,
          storage,
          format: "raw",
          target: node,
        },
      );

      // Clone is async - wait for the Proxmox task to finish before configuring
      await this.waitForTask(template.node || node, taskId, pm);
    } else {
      console.log(`   🆕 Creating blank VM "${this.name}" (vmid=${newVmid})`);
      await pm.post(`/nodes/${node}/qemu`, {
        vmid: newVmid,
        name: this.name,
        cores: this._cores,
        memory: this._memory,
        net0: `virtio,bridge=vmbr1${this._vlan ? `,tag=${this._vlan}` : ""}`,
        ostype: "l26",
      });
    }

    this.resolvedVmid = newVmid;
    this.resolvedNode = node;
    this.out.vmid.resolve(newVmid);

    // Auto-resolve static IP from internal DNS if no explicit IP set
    if (!this._ip) {
      const domain = Config.get().providers.proxmox?.dnsDomain;
      if (domain) {
        try {
          const { resolve4 } = await import("node:dns/promises");
          const [addr] = await resolve4(`${this.name}.${domain}`);
          this._ip = addr;
          console.log(`   🔍 DNS: ${this.name}.${domain} → ${addr}`);
        } catch {
          // Not in DNS - will fall through to DHCP
        }
      }
    }

    // Build net0 string - VirtIO on vmbr1, optional VLAN tag
    const net0 = `virtio,bridge=vmbr1${this._vlan ? `,tag=${this._vlan}` : ""}`;

    const configPatch: any = {
      onboot: 1,
      machine: this._machine,
      cores: this._cores,
      memory: this._memory,
      net0,
      ipconfig0: this._ip
        ? (() => {
            const [addr, prefix = "24"] = this._ip!.split("/");
            const gw = addr.split(".").slice(0, 3).join(".") + ".1";
            return `gw=${gw},ip=${addr}/${prefix}`;
          })()
        : "ip=dhcp",
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

    await pm.post(`/nodes/${node}/qemu/${newVmid}/status/start`);
    console.log(`🚀 Started VM "${this.name}" (vmid=${newVmid}, node=${node})`);

    if (this._ip) {
      const [addr] = this._ip.split("/");
      this.resolvedIp = addr;
      this.out.ip.resolve(addr);
      console.log(`   🌐 IP: ${this.resolvedIp} (static)`);
    } else {
      // Wait for qemu-agent to report an IP
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
              this.resolvedIp = addr["ip-address"];
              return true;
            }
            return false;
          } catch {
            return false;
          }
        },
        { intervalMs: 10_000, timeoutMs: 300_000 },
      );

      if (this.resolvedIp) this.out.ip.resolve(this.resolvedIp);
      console.log(`   🌐 IP: ${this.resolvedIp}`);
    }

    this.registerHost();

    if (this._provision.length > 0) {
      await this.waitFor(
        `SSH on ${this.resolvedIp} to be ready`,
        () => this.checkPort(this.resolvedIp!, 22),
        { intervalMs: 10_000, timeoutMs: 300_000 },
      );
      await this.waitFor(
        `cloud-init to finish on ${this.resolvedIp}`,
        () => this.checkCloudInit(this.resolvedIp!),
        { intervalMs: 15_000, timeoutMs: 300_000 },
      );

      const appliedHashes: Record<string, string> = {};
      for (const script of this._provision) {
        await this.runProvisioner(this.resolvedIp!, script);
        const baseName = script.split("/").pop() ?? script;
        appliedHashes[baseName] = getFileHash(script);
      }

      // Write metadata to new VM description
      const updatedNotes = mergeProvisionMetadata("", appliedHashes);
      await pm.post(`/nodes/${this.resolvedNode}/qemu/${this.resolvedVmid}/config`, {
        description: updatedNotes,
      });
    }

    if (this._replace) {
      await this.destroyVmByName(this._replace, pm);
    }

    return { name: this.name, vmid: this.resolvedVmid, ip: this.resolvedIp };
  }

  private async resolveExistingIp(node: string, vmid: number, pm: ProxmoxApiClient): Promise<string | null> {
    if (this._ip) {
      return this._ip.split("/")[0];
    }
    // Try QEMU guest agent first
    try {
      const ifaces = await pm.get<any[]>(
        `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`
      );
      const eth = (ifaces ?? []).find((i: any) => i.name !== "lo");
      const addr = eth?.["ip-addresses"]?.find(
        (a: any) => a["ip-address-type"] === "ipv4"
      );
      if (addr?.["ip-address"]) {
        return addr["ip-address"];
      }
    } catch {
      // Agent might not be running or installed yet
    }

    // Try DNS lookup next
    const domain = Config.get().providers.proxmox?.dnsDomain;
    if (domain) {
      try {
        const { resolve4 } = await import("node:dns/promises");
        const [addr] = await resolve4(`${this.name}.${domain}`);
        return addr;
      } catch {
        // Ignored
      }
    }
    return null;
  }

  private registerHost() {
    const context = resourceContextStorage.getStore();
    if (context && context.hosts) {
      const activeIp = this.resolvedIp ?? "0.0.0.0";
      if (!context.hosts.some((h) => h.name === this.name)) {
        context.hosts.push({
          name: this.name,
          ip: activeIp,
          user: "root",
          sshKey: this.sshKeyPath(),
          provider: "proxmox",
        });
      }
    }
  }


  async destroy(): Promise<any> {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Proxmox VM "${this.name}"...`);

    if (!existing) {
      console.log(`   ─  VM "${this.name}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(
        `   📝 [PLAN] Stop + delete VM "${this.name}" (vmid=${existing.vmid})`,
      );
      return { destroyed: this.name };
    }

    const pm = getPMClient();
    await this.destroyVmByName(this.name, pm);
    return { destroyed: this.name };
  }

  // Poll a Proxmox task UPID until it exits, then throw if it failed
  private async waitForTask(
    node: string,
    upid: string,
    pm: ProxmoxApiClient,
  ): Promise<void> {
    const encoded = encodeURIComponent(upid);
    await this.waitFor(
      `clone task to complete`,
      async () => {
        const status = await pm.get<any>(
          `/nodes/${node}/tasks/${encoded}/status`,
        );
        if (status?.status !== "stopped") return false;
        if (status.exitstatus && status.exitstatus !== "OK") {
          throw new Error(`Clone task failed: ${status.exitstatus}`);
        }
        return true;
      },
      { intervalMs: 5_000, timeoutMs: 300_000 },
    );
  }

  private async destroyVmByName(name: string, pm: ProxmoxApiClient) {
    const resources = await pm.get<any[]>("/cluster/resources?type=vm");
    const vm = (resources ?? []).find((r) => r.name === name && !r.template);
    if (!vm) {
      console.log(`   ℹ️  VM "${name}" not found - already gone`);
      return;
    }

    if (vm.status === "running") {
      await pm.post(`/nodes/${vm.node}/qemu/${vm.vmid}/status/stop`);
      await this.waitFor(
        `VM "${name}" to stop`,
        async () => {
          const s = await pm.get<any>(
            `/nodes/${vm.node}/qemu/${vm.vmid}/status/current`,
          );
          return s?.status === "stopped";
        },
        { intervalMs: 5_000, timeoutMs: 120_000 },
      );
    }

    await pm.delete(
      `/nodes/${vm.node}/qemu/${vm.vmid}?purge=1&destroy-unreferenced-disks=1`,
    );
    console.log(`   🗑️  Removed VM "${name}" (vmid=${vm.vmid})`);
  }

  private resolvePublicKeys(): string[] {
    const input = this._sshKeys;
    if (!input) {
      // Default: read ~/.ssh/id_rsa.pub if it exists
      try {
        return [
          readFileSync(`${homedir()}/.ssh/id_ed25519.pub`, "utf-8").trim(),
        ];
      } catch {
        return [];
      }
    }
    if (Array.isArray(input))
      return (input as string[]).map((k) => k.trim()).filter(Boolean);
    // Single string: key literal (starts with ssh-) or file path
    if (
      (input as string).startsWith("ssh-") ||
      (input as string).startsWith("ecdsa-") ||
      (input as string).startsWith("sk-")
    ) {
      return [(input as string).trim()];
    }
    try {
      return [
        readFileSync(
          (input as string).replace(/^~/, homedir()),
          "utf-8",
        ).trim(),
      ];
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
      proc.on("close", () =>
        resolve(out.includes("done") || out.includes("error")),
      );
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
    const keyInput = Array.isArray(this._sshKeys)
      ? null
      : (this._sshKeys as string | undefined);
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
