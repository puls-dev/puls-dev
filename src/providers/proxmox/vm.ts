import { homedir } from "node:os";
import { ProxmoxBaseBuilder } from "./base.js";
import { Config } from "../../core/config.js";
import { Output } from "../../core/output.js";
import { getPMClient, withVmidAllocation, ProxmoxApiClient } from "./api.js";
import type { OSImage } from "../../types/proxmox.js";
import { getFileHash, parseProvisionMetadata, mergeProvisionMetadata } from "./hash.js";
import { TemplateBuilder } from "./template.js";
import { resourceContextStorage } from "../../core/context.js";

export class VMBuilder extends ProxmoxBaseBuilder {
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
  private _gateway?: string;
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
  gateway(gw: string) {
    this._gateway = gw;
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
    try {
      return await this._deploy();
    } catch (err) {
      this.out.vmid.reject(err as Error);
      this.out.ip.reject(err as Error);
      throw err;
    }
  }

  private async _deploy() {
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
        this.registerHost();
      }

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
          if (activeIp === "0.0.0.0") {
            throw new Error(`Failed to resolve IP for existing VM "${this.name}" to run playbooks`);
          }
          console.log(`   🔄 Running ${playbooksToRun.length} playbook changes → ${activeIp}`);

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

      // No playbook changes
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
    let node = this._node ?? await this.selectBestNode(pm);

    if (!node) {
      const configuredNodes = Config.get().providers.proxmox?.nodes;
      node = configuredNodes?.[0] ?? template?.node;
    }
    if (!node) {
      const nodes = await pm.get<any[]>("/nodes");
      node = (nodes ?? [])[0]?.node;
    }
    if (!node) throw new Error("No Proxmox nodes available");

    const storage = this._storage ?? "rbd_pool";

    // Allocate VMID and immediately issue the create/clone request while holding the lock
    // to prevent parallel VMs from claiming the same VMID.
    const { newVmid, cloneTaskId, cloneNode } = await withVmidAllocation(async () => {
      const vmid = await pm.get<number>("/cluster/nextid");
      if (template) {
        console.log(
          `   📋 Cloning template "${template.name}" (vmid=${template.vmid}) → "${this.name}" (vmid=${vmid})`,
        );
        const taskId = await pm.post<string>(
          `/nodes/${template.node || node}/qemu/${template.vmid}/clone`,
          {
            newid: vmid,
            name: this.name,
            full: 1,
            storage,
            format: "raw",
            target: node,
          },
        );
        return { newVmid: vmid, cloneTaskId: taskId, cloneNode: template.node || node };
      } else {
        console.log(`   🆕 Creating blank VM "${this.name}" (vmid=${vmid})`);
        await pm.post(`/nodes/${node}/qemu`, {
          vmid,
          name: this.name,
          cores: this._cores,
          memory: this._memory,
          net0: `virtio,bridge=vmbr1${this._vlan ? `,tag=${this._vlan}` : ""}`,
          ostype: "l26",
        });
        return { newVmid: vmid, cloneTaskId: null, cloneNode: null };
      }
    });

    if (cloneTaskId && cloneNode) {
      await this.waitForTask(cloneNode, cloneTaskId, pm);
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
            const gw = this._gateway ?? (addr.split(".").slice(0, 3).join(".") + ".1");
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

      if (this.resolvedIp) {
        this.out.ip.resolve(this.resolvedIp);
      }
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
    if (context && context.hosts && this.resolvedIp) {
      if (!context.hosts.some((h) => h.name === this.name)) {
        context.hosts.push({
          name: this.name,
          ip: this.resolvedIp,
          user: this.resolveUser(),
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
}
