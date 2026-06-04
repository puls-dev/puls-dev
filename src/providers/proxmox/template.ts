import { ProxmoxBaseBuilder } from "./base.js";
import { Config } from "../../core/config.js";
import { Output } from "../../core/output.js";
import { getPMClient, withVmidAllocation } from "./api.js";
import type { OSImage } from "../../types/proxmox.js";
import { getFileHash, parseProvisionMetadata, mergeProvisionMetadata } from "./hash.js";

export class TemplateBuilder extends ProxmoxBaseBuilder {
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
  provision(...playbookPaths: (string | string[])[]) {
    this._provision.push(...playbookPaths.flat());
    return this;
  }

  async deploy() {
    try {
      return await this._deploy();
    } catch (err) {
      this.out.vmid.reject(err as Error);
      throw err;
    }
  }

  private async _deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const pm = getPMClient();

    if (existing) {
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
        this.resolvedVmid = existing.vmid;
        this.resolvedNode = existing.node;
        this.out.vmid.resolve(existing.vmid);
        console.log(`\n🖥️  Finalizing Proxmox Template "${this.name}"...`);
        console.log(`   ✅ Template "${this.name}" already exists and matches defined state.`);
        return { name: this.name, vmid: this.resolvedVmid, node: this.resolvedNode };
      }

      console.log(`\n🖥️  Finalizing Proxmox Template "${this.name}"...`);
      console.log(`   🔄 Template playbook hashes changed. Purging old template...`);
      if (dryRun) {
        console.log(`   📝 [PLAN] Would purge template "${this.name}" (vmid=${existing.vmid}) and rebuild.`);
        this.out.vmid.resolve(-1);
        return { name: this.name, vmid: "PENDING" };
      }

      await pm.delete(`/nodes/${existing.node}/qemu/${existing.vmid}?purge=1&destroy-unreferenced-disks=1`);
      // Fall through to rebuild
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
    let node = await this.selectBestNode(pm);

    if (!node) {
      const configuredNodes = Config.get().providers.proxmox?.nodes;
      node = configuredNodes?.[0];
    }
    if (!node) {
      const nodes = await pm.get<any[]>("/nodes");
      node = (nodes ?? [])[0]?.node;
    }
    if (!node) throw new Error("No Proxmox nodes available");

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

    const storage = this._storage ?? "rbd_pool";

    // Allocate VMID and immediately issue the create/clone request while holding the lock
    // to prevent parallel templates from claiming the same VMID.
    const { newVmid, cloneTaskId, cloneNode } = await withVmidAllocation(async () => {
      const vmid = await pm.get<number>("/cluster/nextid");
      if (baseTemplate) {
        console.log(
          `   📋 Cloning base template "${baseTemplate.name}" (vmid=${baseTemplate.vmid}) → "${this.name}" (vmid=${vmid})`,
        );
        const taskId = await pm.post<string>(
          `/nodes/${baseTemplate.node || node}/qemu/${baseTemplate.vmid}/clone`,
          {
            newid: vmid,
            name: this.name,
            full: 1,
            storage,
            format: "raw",
            target: node,
          },
        );
        return { newVmid: vmid, cloneTaskId: taskId, cloneNode: baseTemplate.node || node };
      } else {
        console.log(`   🆕 Creating blank VM "${this.name}" (vmid=${vmid})`);
        await pm.post(`/nodes/${node}/qemu`, {
          vmid,
          name: this.name,
          cores: this._cores,
          memory: this._memory,
          net0: "virtio,bridge=vmbr1",
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
}
