import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { AzureVMBuilder } from "./vm.js";
import { ResourceGroupBuilder } from "./resource_group.js";
import { Config } from "@puls-dev/core";
import { getFileHash } from "@puls-dev/core";

describe("AzureVMBuilder Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};
  const tempKeyPath = path.resolve(process.cwd(), "temp-azure-ssh-key.pub");
  const tempPrivateKeyPath = path.resolve(process.cwd(), "temp-azure-ssh-key");

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        azure: {
          clientId: "fake-id",
          clientSecret: "fake-secret",
          tenantId: "fake-tenant",
          subscriptionId: "fake-sub",
          defaultLocation: "eastus",
          sshUser: "azureuser"
        }
      }
    });

    originalFetch = globalThis.fetch;
    fetchCalls = [];
    mockResponses = {
      "POST /oauth2/v2.0/token": {
        status: 200,
        body: { access_token: "mock-token", expires_in: 3600 }
      }
    };

    fs.writeFileSync(tempKeyPath, "ssh-rsa AAAAB3NzaC1yc2E... test-key", "utf8");
    fs.writeFileSync(tempPrivateKeyPath, "fake-private-key-contents", "utf8");

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      let body: any;
      if (init?.body) {
        if (typeof init.body === "string") {
          try {
            body = JSON.parse(init.body);
          } catch {
            body = init.body;
          }
        } else {
          body = init.body;
        }
      }
      const headers = init?.headers;

      fetchCalls.push({ url, method, body, headers });

      const matchKey = Object.keys(mockResponses).find(key => {
        const [mMethod, mPath] = key.split(" ");
        return method === mMethod && url.endsWith(mPath);
      });

      if (matchKey) {
        const resp = mockResponses[matchKey];
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        } as Response;
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({ error: { code: "NotFound" } }),
        text: async () => "Not found",
      } as Response;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (fs.existsSync(tempKeyPath)) fs.unlinkSync(tempKeyPath);
    if (fs.existsSync(tempPrivateKeyPath)) fs.unlinkSync(tempPrivateKeyPath);
  });

  test("throws if resource group is not configured", async () => {
    const builder = new AzureVMBuilder("my-vm");
    await assert.rejects(async () => {
      await builder.deploy();
    }, /resourceGroup\(\) is required/);
  });

  test("deploys network infrastructure and VM successfully", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Compute/virtualMachines/my-vm?api-version=2021-07-01"] = {
      status: 404,
      body: {}
    };
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/publicIPAddresses/ip-my-vm?api-version=2021-05-01"] = {
      status: 404,
      body: {}
    };

    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/virtualNetworks/vnet-my-vm?api-version=2021-05-01"] = {
      status: 200,
      body: { id: "vnet-id" }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/publicIPAddresses/ip-my-vm?api-version=2021-05-01"] = {
      status: 200,
      body: { id: "ip-id", properties: { ipAddress: "13.88.99.111" } }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/networkInterfaces/nic-my-vm?api-version=2021-05-01"] = {
      status: 200,
      body: { id: "nic-id" }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Compute/virtualMachines/my-vm?api-version=2021-07-01"] = {
      status: 200,
      body: { id: "vm-id" }
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new AzureVMBuilder("my-vm")
      .resourceGroup(rg)
      .location("westus")
      .size("Standard_A2_v2")
      .sshKey(tempKeyPath)
      .image("Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest");

    const result = await builder.deploy();
    assert.ok(result);
    assert.strictEqual(result.id, "vm-id");
    assert.strictEqual(result.ip, "13.88.99.111");

    // Verify VNet creation
    const vnetCall = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/virtualNetworks/vnet-my-vm"));
    assert.ok(vnetCall);
    assert.deepStrictEqual(vnetCall.body.location, "westus");

    // Verify Public IP creation
    const ipCall = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/publicIPAddresses/ip-my-vm"));
    assert.ok(ipCall);

    // Verify NIC creation
    const nicCall = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/networkInterfaces/nic-my-vm"));
    assert.ok(nicCall);
    assert.strictEqual(nicCall.body.properties.ipConfigurations[0].properties.publicIPAddress.id, "ip-id");

    // Verify VM creation
    const vmCall = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/virtualMachines/my-vm"));
    assert.ok(vmCall);
    assert.deepStrictEqual(vmCall.body, {
      location: "westus",
      properties: {
        hardwareProfile: { vmSize: "Standard_A2_v2" },
        storageProfile: {
          imageReference: {
            publisher: "Canonical",
            offer: "0001-com-ubuntu-server-jammy",
            sku: "22_04-lts-gen2",
            version: "latest"
          },
          osDisk: {
            createOption: "FromImage",
            managedDisk: { storageAccountType: "Standard_LRS" }
          }
        },
        osProfile: {
          computerName: "my-vm",
          adminUsername: "azureuser",
          linuxConfiguration: {
            disablePasswordAuthentication: true,
            ssh: {
              publicKeys: [
                {
                  path: "/home/azureuser/.ssh/authorized_keys",
                  keyData: "ssh-rsa AAAAB3NzaC1yc2E... test-key"
                }
              ]
            }
          }
        },
        networkProfile: {
          networkInterfaces: [{ id: "nic-id", properties: { primary: true } }]
        }
      }
    });
  });

  test("runs playbooks and updates tags statelessly", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Compute/virtualMachines/my-vm?api-version=2021-07-01"] = {
      status: 200,
      body: {
        id: "vm-id",
        name: "my-vm",
        tags: { "puls-provision": "setup=oldhash" },
        properties: { hardwareProfile: { vmSize: "Standard_B1s" } }
      }
    };
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/publicIPAddresses/ip-my-vm?api-version=2021-05-01"] = {
      status: 200,
      body: { properties: { ipAddress: "13.88.99.111" } }
    };
    mockResponses["PATCH /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Compute/virtualMachines/my-vm?api-version=2021-07-01"] = {
      status: 200,
      body: {}
    };

    const tempPlaybook = path.resolve(process.cwd(), "temp-playbook.yaml");
    fs.writeFileSync(tempPlaybook, "- hosts: all\n  tasks: []", "utf8");

    try {
      const rg = new ResourceGroupBuilder("my-rg");
      const builder = new AzureVMBuilder("my-vm")
        .resourceGroup(rg)
        .sshKey(tempPrivateKeyPath) // using private key path for ssh connection
        .provision(tempPlaybook);

      // Stub methods on builder to bypass actual SSH and provisioner execution
      (builder as any).checkPort = async () => true;
      (builder as any).runProvisioner = async () => {};

      await builder.deploy();

      // Verify tags patch was made
      const patchCall = fetchCalls.find(c => c.method === "PATCH" && c.url.includes("/virtualMachines/my-vm"));
      assert.ok(patchCall);
      const expectedHash = getFileHash(tempPlaybook);
      assert.strictEqual(patchCall.body.tags["puls-provision"], `setup=oldhash,temp-playbook-yaml=${expectedHash}`);
    } finally {
      if (fs.existsSync(tempPlaybook)) fs.unlinkSync(tempPlaybook);
    }
  });

  test("skips destroy when VM not found", async () => {
    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new AzureVMBuilder("my-vm").resourceGroup(rg);

    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: false });
    assert.strictEqual(fetchCalls.filter(c => c.method === "DELETE").length, 0);
  });

  test("destroys VM and network components", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Compute/virtualMachines/my-vm?api-version=2021-07-01"] = {
      status: 200,
      body: { id: "vm-id" }
    };
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/publicIPAddresses/ip-my-vm?api-version=2021-05-01"] = {
      status: 200,
      body: { properties: { ipAddress: "13.88.99.111" } }
    };

    mockResponses["DELETE /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Compute/virtualMachines/my-vm?api-version=2021-07-01"] = {
      status: 200,
      body: {}
    };
    mockResponses["DELETE /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/networkInterfaces/nic-my-vm?api-version=2021-05-01"] = {
      status: 200,
      body: {}
    };
    mockResponses["DELETE /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/publicIPAddresses/ip-my-vm?api-version=2021-05-01"] = {
      status: 200,
      body: {}
    };
    mockResponses["DELETE /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/virtualNetworks/vnet-my-vm?api-version=2021-05-01"] = {
      status: 200,
      body: {}
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new AzureVMBuilder("my-vm").resourceGroup(rg);
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: "my-vm" });

    const deletes = fetchCalls.filter(c => c.method === "DELETE");
    assert.strictEqual(deletes.length, 4);
    assert.ok(deletes.some(c => c.url.includes("/virtualMachines/my-vm")));
    assert.ok(deletes.some(c => c.url.includes("/networkInterfaces/nic-my-vm")));
    assert.ok(deletes.some(c => c.url.includes("/publicIPAddresses/ip-my-vm")));
    assert.ok(deletes.some(c => c.url.includes("/virtualNetworks/vnet-my-vm")));
  });
});
