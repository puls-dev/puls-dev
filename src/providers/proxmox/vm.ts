import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { createConnection } from "node:net";
import { BaseBuilder } from "../../core/resource.ts";
import { Config } from "../../core/config.ts";
import { getPMClient, ProxmoxApiClient } from "./api.ts";
import type { OSImage } from "../../types/proxmox.ts";

export class VMBuilder extends BaseBuilder {
  resolvedVmid: number | null = null;
  resolvedNode: string | null = null;
  resolvedIp: string | null = null;

  private _image?: OSImage;
  private _cores: number = 2;
  private _memory: number = 2048;
  private _provision?: string;
  private _replace?: string;
  private _node?: string;
  private _storage?: string;
  private _vlan?: number;
  private _ip?: string;
  private _sshKeys?: string | string[];

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverVm(name);
  }

  private async discoverVm(name: string): Promise<any> {
    try {
      const pm = getPMClient();
      const resources = await pm.get<any[]>("/cluster/resources?type=vm");
      return (
        (resources ?? []).find((r) => r.name === name && !r.template) ?? null
      );
    } catch (e: any) {
      if (e.message?.includes("not configured")) return null;
      throw e;
    }
  }

  image(os: OSImage) {
    this._image = os;
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
  provision(playbookPath: string) {
    this._provision = playbookPath;
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

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const pm = getPMClient();

    console.log(`\n🖥️  Finalizing Proxmox VM "${this.name}"...`);

    if (existing) {
      this.resolvedVmid = existing.vmid;
      this.resolvedNode = existing.node;
      console.log(
        `   ✅ VM "${this.name}" already exists (vmid=${existing.vmid}, node=${existing.node}, status=${existing.status})`,
      );
      return {
        name: this.name,
        vmid: this.resolvedVmid,
        node: this.resolvedNode,
      };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Create VM "${this.name}"`);
      if (this._image) console.log(`      └─ Image: ${this._image}`);
      console.log(`      └─ Cores: ${this._cores}  Memory: ${this._memory} MB`);
      if (this._vlan) console.log(`      └─ VLAN: ${this._vlan}`);
      if (this._provision)
        console.log(`      └─ Provision: ${this._provision}`);
      if (this._replace)
        console.log(`      └─ Replace: "${this._replace}" after creation`);
      return { name: this.name, vmid: "PENDING" };
    }

    // Find the template — match by VMID (numeric string) or name substring
    const resources = await pm.get<any[]>("/cluster/resources?type=vm");
    const isVmid = this._image && /^\d+$/.test(this._image);
    const template = this._image
      ? (resources ?? []).find(
          (r) =>
            r.template === 1 &&
            (isVmid
              ? String(r.vmid) === this._image
              : r.name?.includes(this._image)),
        )
      : null;

    if (this._image && !template) {
      throw new Error(
        `No Proxmox template found matching "${this._image}". ` +
          (isVmid
            ? `Check that VMID ${this._image} exists and is marked as a template.`
            : `Create a template whose name contains "${this._image}".`),
      );
    }

    // Resolve target node: explicit → configured nodes list → template's node → API discovery
    let node = this._node;
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
        `/nodes/${node}/qemu/${template.vmid}/clone`,
        {
          newid: newVmid,
          name: this.name,
          full: 1,
          storage,
          format: "raw",
        },
      );

      // Clone is async — wait for the Proxmox task to finish before configuring
      await this.waitForTask(node, taskId, pm);
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
          // Not in DNS — will fall through to DHCP
        }
      }
    }

    // Build net0 string — VirtIO on vmbr1, optional VLAN tag
    const net0 = `virtio,bridge=vmbr1${this._vlan ? `,tag=${this._vlan}` : ""}`;

    const configPatch: any = {
      onboot: 1,
      machine: "q35",
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

      console.log(`   🌐 IP: ${this.resolvedIp}`);
    }

    if (this._provision) {
      await this.waitFor(`SSH on ${this.resolvedIp} to be ready`, () => this.checkPort(this.resolvedIp!, 22),
        { intervalMs: 10_000, timeoutMs: 300_000 });
      await this.waitFor(`cloud-init to finish on ${this.resolvedIp}`, () => this.checkCloudInit(this.resolvedIp!),
        { intervalMs: 15_000, timeoutMs: 300_000 });
      await this.runProvisioner(this.resolvedIp!, this._provision);
    }

    if (this._replace) {
      await this.destroyVmByName(this._replace, pm);
    }

    return { name: this.name, vmid: this.resolvedVmid, ip: this.resolvedIp };
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
      console.log(`   ℹ️  VM "${name}" not found — already gone`);
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
    return new Promise(resolve => {
      const proc = spawn('ssh', [
        '-i', keyPath,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        '-o', 'BatchMode=yes',
        `root@${ip}`,
        'cloud-init status',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });

      let out = '';
      proc.stdout.on('data', (d: Buffer) => out += d.toString());
      proc.on('close', () => resolve(out.includes('done') || out.includes('error')));
      proc.on('error', () => resolve(false));
    });
  }

  private checkPort(ip: string, port: number): Promise<boolean> {
    return new Promise(resolve => {
      const socket = createConnection({ host: ip, port, timeout: 3_000 });
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => resolve(false));
    });
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

  private runProvisioner(ip: string, script: string): Promise<void> {
    const ext = script.split(".").pop()?.toLowerCase();

    if (ext === "sh") return this.runShellScript(ip, script);
    if (ext === "pp") return this.runPuppet(ip, script);
    return this.runAnsible(ip, script); // .yml / .yaml
  }

  private runShellScript(ip: string, script: string): Promise<void> {
    console.log(`   🔧 Running shell script: ${script} → ${ip}`);
    const keyPath = this.sshKeyPath();
    const scriptDir = dirname(script); // e.g. 'config'
    const sshArgs = [
      "-i",
      keyPath,
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "ConnectTimeout=30",
    ];

    return new Promise((resolve, reject) => {
      // Copy the script's directory to the same path on the remote (e.g. config/ → /config/)
      console.log(`   📂 Copying ${scriptDir}/ → ${ip}:/${scriptDir}/`);
      const scp = spawn(
        "scp",
        [
          "-i",
          keyPath,
          "-o",
          "StrictHostKeyChecking=no",
          "-r",
          scriptDir,
          `root@${ip}:/`,
        ],
        { stdio: "inherit" },
      );

      scp.on("error", (err) => reject(new Error(`scp failed: ${err.message}`)));
      scp.on("close", (scpCode) => {
        if (scpCode !== 0) {
          reject(new Error(`scp exited with code ${scpCode}`));
          return;
        }

        const proc = spawn("ssh", [...sshArgs, `root@${ip}`, "bash -s"], {
          stdio: ["pipe", "inherit", "inherit"],
        });

        proc.stdin.write(readFileSync(script));
        proc.stdin.end();
        proc.on("close", (code) => {
          if (code === 0) {
            console.log(`   ✅ Provisioning complete`);
            resolve();
          } else reject(new Error(`Shell script exited with code ${code}`));
        });
        proc.on("error", (err) =>
          reject(new Error(`ssh failed: ${err.message}`)),
        );
      });
    });
  }

  private runPuppet(ip: string, manifest: string): Promise<void> {
    console.log(`   🔧 Applying Puppet manifest: ${manifest} → ${ip}`);
    const keyPath = this.sshKeyPath();
    // Copy manifest then apply it
    return new Promise((resolve, reject) => {
      const scp = spawn(
        "scp",
        [
          "-i",
          keyPath,
          "-o",
          "StrictHostKeyChecking=no",
          manifest,
          `root@${ip}:/tmp/manifest.pp`,
        ],
        { stdio: "inherit" },
      );

      scp.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`scp exited with code ${code}`));
          return;
        }
        const puppet = spawn(
          "ssh",
          [
            "-i",
            keyPath,
            "-o",
            "StrictHostKeyChecking=no",
            `root@${ip}`,
            "puppet apply /tmp/manifest.pp",
          ],
          { stdio: "inherit" },
        );
        puppet.on("close", (c) => {
          if (c === 0) {
            console.log(`   ✅ Provisioning complete`);
            resolve();
          } else reject(new Error(`puppet apply exited with code ${c}`));
        });
        puppet.on("error", (err) =>
          reject(new Error(`Failed to run puppet: ${err.message}`)),
        );
      });
      scp.on("error", (err) =>
        reject(new Error(`Failed to run scp: ${err.message}`)),
      );
    });
  }

  private runAnsible(ip: string, playbook: string): Promise<void> {
    console.log(`   🔧 Running Ansible: ${playbook} → ${ip}`);
    const keyPath = this.sshKeyPath();
    return new Promise((resolve, reject) => {
      const proc = spawn(
        "ansible-playbook",
        [
          playbook,
          "-i",
          `${ip},`,
          "-u",
          "root",
          "--private-key",
          keyPath,
          "--ssh-extra-args",
          "-o StrictHostKeyChecking=no -o ConnectTimeout=30",
        ],
        { stdio: "inherit" },
      );
      proc.on("close", (code) => {
        if (code === 0) {
          console.log(`   ✅ Provisioning complete`);
          resolve();
        } else reject(new Error(`ansible-playbook exited with code ${code}`));
      });

      proc.on("error", (err) =>
        reject(new Error(`Failed to run ansible-playbook: ${err.message}`)),
      );
    });
  }
}
