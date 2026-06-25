import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { BaseBuilder } from "@puls-dev/core";
import { Config } from "@puls-dev/core";
import { Output } from "@puls-dev/core";
import { getAzureApi, resolveAzureConfig } from "./api.js";
import { checkPort, runProvisioner } from "@puls-dev/core";
import { getFileHash } from "@puls-dev/core";
import { ResourceGroupBuilder } from "./resource_group.js";
import { AzureNetworkBuilder } from "./network.js";

function parseAzureTagsForProvision(val?: string): Record<string, string> {
  if (!val) return {};
  const map: Record<string, string> = {};
  const pairs = val.split(",");
  for (const pair of pairs) {
    const [k, v] = pair.split("=");
    if (k && v) map[k.trim()] = v.trim();
  }
  return map;
}

function mergeAzureTagsForProvision(existing: Record<string, string>, name: string, hash: string): string {
  const updated = { ...existing, [name]: hash };
  return Object.entries(updated)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

function resolveSshKeyData(keyOrPath: string): string {
  const trimmed = keyOrPath.trim();
  if (trimmed.startsWith("ssh-") || trimmed.startsWith("ecdsa-") || trimmed.startsWith("sk-")) {
    return trimmed;
  }
  try {
    const resolvedPath = trimmed.startsWith("~")
      ? trimmed.replace("~", homedir())
      : path.resolve(process.cwd(), trimmed);
    return fs.readFileSync(resolvedPath, "utf8").trim();
  } catch {
    return trimmed;
  }
}

export class AzureVMBuilder extends BaseBuilder {
  readonly out = {
    ip: new Output<string>(),
    id: new Output<string>(),
  };

  private _resourceGroup?: ResourceGroupBuilder;
  private _network?: AzureNetworkBuilder;
  private _location?: string;
  private _size: string = "Standard_B1s";
  private _imagePublisher: string = "Canonical";
  private _imageOffer: string = "0001-com-ubuntu-server-jammy";
  private _imageSku: string = "22_04-lts-gen2";
  private _imageVersion: string = "latest";
  
  private _sshKeys: string | string[] = [];
  private _sshUser?: string;
  private _provision: string[] = [];
  private _forceConfigCheck: boolean = false;

  private resolvedInstanceId?: string;
  private resolvedIp?: string;

  constructor(public vmName: string) {
    super(vmName);
  }

  resourceGroup(rg: ResourceGroupBuilder) {
    this._resourceGroup = rg;
    this.dependsOn(rg);
    this.discoveryPromise = this.discoverVM();
    return this;
  }

  network(net: AzureNetworkBuilder) {
    this._network = net;
    this.dependsOn(net);
    return this;
  }

  location(loc: string) {
    this._location = loc;
    return this;
  }

  size(vmSize: string) {
    this._size = vmSize;
    return this;
  }

  image(img: string) {
    // Expected format: "Publisher:Offer:Sku:Version"
    const parts = img.split(":");
    if (parts.length === 4) {
      this._imagePublisher = parts[0];
      this._imageOffer = parts[1];
      this._imageSku = parts[2];
      this._imageVersion = parts[3];
    } else {
      this._imageOffer = img;
    }
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

  provision(...playbookPaths: (string | string[])[]) {
    this._provision.push(...playbookPaths.flat());
    return this;
  }

  forceConfigCheck() {
    this._forceConfigCheck = true;
    return this;
  }

  private get rgName(): string {
    if (!this._resourceGroup) {
      throw new Error(`[Azure VM:${this.name}] .resourceGroup() is required`);
    }
    return this._resourceGroup.groupName;
  }

  private resolveLocation(): string {
    return this._location ?? resolveAzureConfig().defaultLocation ?? "eastus";
  }

  private resolveUser(): string {
    return this._sshUser ?? resolveAzureConfig().sshUser ?? "azureuser";
  }

  protected async checkPort(ip: string, port: number): Promise<boolean> {
    return checkPort(ip, port);
  }

  protected async runProvisioner(ip: string, script: string): Promise<void> {
    const keysArray = Array.isArray(this._sshKeys) ? this._sshKeys : [this._sshKeys];
    const keyPath = keysArray.find(
      (k) => !k.startsWith("ssh-") && !k.startsWith("ecdsa-") && !k.startsWith("sk-")
    );
    if (!keyPath) {
      throw new Error(
        `[Azure VM:${this.name}] No SSH private key path found. Pass a file path via .sshKey() to run provisioning.`
      );
    }
    return runProvisioner(ip, this.resolveUser(), keyPath, script);
  }

  private async discoverVM(): Promise<any> {
    try {
      const api = getAzureApi();
      const sub = resolveAzureConfig().subscriptionId;
      const rg = this.rgName;

      const vm = await api.get<any>(
        `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${this.vmName}`,
        "2021-07-01"
      );

      let ipAddress = null;
      try {
        const ipRes = await api.get<any>(
          `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/publicIPAddresses/ip-${this.vmName}`,
          "2021-05-01"
        );
        ipAddress = ipRes.properties?.ipAddress;
      } catch {
        // IP not found or couldn't fetch
      }

      if (vm) {
        this.resolvedInstanceId = vm.id;
        this.resolvedIp = ipAddress ?? undefined;
        if (vm.id) this.out.id.resolve(vm.id);
        if (ipAddress) this.out.ip.resolve(ipAddress);
      }

      return vm;
    } catch (err: any) {
      if (err.message?.includes("404")) {
        return null;
      }
      throw err;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const sub = resolveAzureConfig().subscriptionId;
    const loc = this.resolveLocation();
    const api = getAzureApi();
    const rg = this.rgName;

    // Check if VM resizing is needed
    const hasChanges = existing ? existing.properties?.hardwareProfile?.vmSize !== this._size : true;

    if (await this.checkProtection(hasChanges)) return null;

    // Parse applied playbooks metadata from Azure Tags
    const tags = existing?.tags ?? {};
    const appliedHashes = parseAzureTagsForProvision(tags["puls-provision"]);

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
      console.log(`\n🔍 [DRY RUN] Azure VM "${this.vmName}"...`);
      if (!existing) {
        console.log(`   📝 Plan: Create Azure VM Instance`);
        console.log(`      ├─ Size:      ${this._size}`);
        console.log(`      ├─ Location:  ${loc}`);
        console.log(`      ├─ Image:     ${this._imagePublisher}:${this._imageOffer}:${this._imageSku}:${this._imageVersion}`);
        if (this._provision.length > 0) {
          console.log(`      ├─ Provision: ${this._provision.join(", ")}`);
        }
        console.log(`      └─ User:      ${this.resolveUser()}`);
        this.out.id.resolve("PENDING");
        this.out.ip.resolve("0.0.0.0");
      } else if (hasChanges || playbookRunRequired) {
        if (hasChanges) {
          console.log(`   📝 Plan: Resize VM "${this.vmName}" → ${this._size}`);
        }
        if (playbookRunRequired) {
          console.log(`   📝 Plan: Run playbooks: [${playbooksToRun.map((p) => p.path).join(", ")}]`);
        }
      } else {
        console.log(`   ✅ VM "${this.vmName}" is up to date.`);
      }
      return { id: this.resolvedInstanceId ?? "PENDING", ip: this.resolvedIp ?? "0.0.0.0" };
    }

    if (!existing) {
      console.log(`\n🚀 Deploying VM network dependencies for "${this.vmName}"...`);

      // 1. Create Virtual Network
      if (!this._network) {
        const vnetName = `vnet-${this.vmName}`;
        await api.put(
          `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${vnetName}`,
          {
            location: loc,
            properties: {
              addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
              subnets: [{ name: "default", properties: { addressPrefix: "10.0.0.0/24" } }],
            },
          },
          "2021-05-01"
        );
      }

      // 2. Create Public IP
      const ipName = `ip-${this.vmName}`;
      const ipRes = await api.put<any>(
        `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/publicIPAddresses/${ipName}`,
        {
          location: loc,
          properties: { publicIPAllocationMethod: "Static" },
          sku: { name: "Standard" },
        },
        "2021-05-01"
      );

      // 3. Create NIC
      const nicName = `nic-${this.vmName}`;
      const subnetId = this._network
        ? await this._network.out.subnetId.get()
        : `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/vnet-${this.vmName}/subnets/default`;

      const nicRes = await api.put<any>(
        `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/networkInterfaces/${nicName}`,
        {
          location: loc,
          properties: {
            ipConfigurations: [
              {
                name: "ipconfig1",
                properties: {
                  subnet: {
                    id: subnetId,
                  },
                  publicIPAddress: { id: ipRes.id },
                },
              },
            ],
          },
        },
        "2021-05-01"
      );

      // Resolve public keys
      const keysArray = Array.isArray(this._sshKeys) ? this._sshKeys : [this._sshKeys];
      const keyData = keysArray.map(resolveSshKeyData).join("\n");
      if (!keyData) {
        throw new Error(`[Azure VM:${this.vmName}] SSH public key is required to create a VM.`);
      }

      console.log(`🚀 Creating Azure Compute VM "${this.vmName}"...`);
      const vmRes = await api.put<any>(
        `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${this.vmName}`,
        {
          location: loc,
          properties: {
            hardwareProfile: { vmSize: this._size },
            storageProfile: {
              imageReference: {
                publisher: this._imagePublisher,
                offer: this._imageOffer,
                sku: this._imageSku,
                version: this._imageVersion,
              },
              osDisk: {
                createOption: "FromImage",
                managedDisk: { storageAccountType: "Standard_LRS" },
              },
            },
            osProfile: {
              computerName: this.vmName,
              adminUsername: this.resolveUser(),
              linuxConfiguration: {
                disablePasswordAuthentication: true,
                ssh: {
                  publicKeys: [
                    {
                      path: `/home/${this.resolveUser()}/.ssh/authorized_keys`,
                      keyData,
                    },
                  ],
                },
              },
            },
            networkProfile: {
              networkInterfaces: [{ id: nicRes.id, properties: { primary: true } }],
            },
          },
        },
        "2021-07-01"
      );

      this.resolvedInstanceId = vmRes.id;
      this.resolvedIp = ipRes.properties.ipAddress;
      this.out.id.resolve(vmRes.id);
      this.out.ip.resolve(ipRes.properties.ipAddress);
    } else {
      console.log(`   ✅ VM "${this.vmName}" already exists.`);
      if (hasChanges) {
        console.log(`🔄 Resizing Azure Compute VM "${this.vmName}" to "${this._size}"...`);
        await api.put<any>(
          `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${this.vmName}`,
          {
            location: loc,
            properties: {
              hardwareProfile: { vmSize: this._size },
            },
          },
          "2021-07-01"
        );
        console.log(`   ✅ Resized VM successfully.`);
      }
    }

    const ip = await this.out.ip.get();

    // 4. Run Provisioning if needed
    if (playbooksToRun.length > 0) {
      console.log(`\n⏳ Waiting for SSH (port 22) on ${ip}...`);
      await this.checkPort(ip, 22);

      let activeTags = { ...tags };
      for (const p of playbooksToRun) {
        console.log(`\n🔄 Running playbook "${p.path}" on Azure VM...`);
        await this.runProvisioner(ip, p.path);
        
        // Update tags in-place statelessly
        activeTags["puls-provision"] = mergeAzureTagsForProvision(
          parseAzureTagsForProvision(activeTags["puls-provision"]),
          p.slug,
          p.hash
        );
      }

      // Update VM Tags on Azure ARM
      await api.patch(
        `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${this.vmName}`,
        { tags: activeTags },
        "2021-07-01"
      );
      console.log(`   ✅ Provisioning hashes updated on Azure tags.`);
    }

    await this.deploySidecars();
    return { id: this.resolvedInstanceId, ip };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Azure VM "${this.vmName}" and network dependencies...`);

    if (!existing) {
      console.log(`   ─  VM "${this.vmName}" not found`);
      return { destroyed: false };
    }

    const sub = resolveAzureConfig().subscriptionId;
    const api = getAzureApi();
    const rg = this.rgName;

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Azure VM "${this.vmName}" (includes NIC, IP, VNet)`);
      return { destroyed: this.vmName };
    }

    // Delete VM
    await api.delete(
      `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${this.vmName}`,
      "2021-07-01"
    );
    console.log(`   🗑️  Removed Compute VM "${this.vmName}"`);

    // Delete NIC
    try {
      await api.delete(
        `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/networkInterfaces/nic-${this.vmName}`,
        "2021-05-01"
      );
      console.log(`   🗑️  Removed Network Interface "nic-${this.vmName}"`);
    } catch {}

    // Delete Public IP
    try {
      await api.delete(
        `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/publicIPAddresses/ip-${this.vmName}`,
        "2021-05-01"
      );
      console.log(`   🗑️  Removed Public IP "ip-${this.vmName}"`);
    } catch {}

    // Delete VNet
    if (!this._network) {
      try {
        await api.delete(
          `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/vnet-${this.vmName}`,
          "2021-05-01"
        );
        console.log(`   🗑️  Removed Virtual Network "vnet-${this.vmName}"`);
      } catch {}
    }

    await this.destroySidecars();
    return { destroyed: this.vmName };
  }
}
