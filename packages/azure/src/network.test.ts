import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ResourceGroupBuilder } from "./resource_group.js";
import { AzureNetworkBuilder } from "./network.js";
import { AzureVMBuilder } from "./vm.js";
import { Config } from "@puls-dev/core";

describe("AzureNetworkBuilder Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        azure: {
          clientId: "fake-id",
          clientSecret: "fake-secret",
          tenantId: "fake-tenant",
          subscriptionId: "fake-sub",
          defaultLocation: "eastus"
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
        json: async () => ({ error: { code: "NotFound", message: "Not found" } }),
        text: async () => "Not found",
      } as Response;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("creates standalone network security group and virtual network if not exist", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/virtualNetworks/my-vnet?api-version=2020-11-01"] = {
      status: 404,
      body: { error: { code: "VNetNotFound" } }
    };
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/networkSecurityGroups/my-vnet-nsg?api-version=2020-11-01"] = {
      status: 404,
      body: { error: { code: "NSGNotFound" } }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/networkSecurityGroups/my-vnet-nsg?api-version=2020-11-01"] = {
      status: 200,
      body: { id: "nsg-id" }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/virtualNetworks/my-vnet?api-version=2020-11-01"] = {
      status: 200,
      body: { id: "vnet-id" }
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const net = new AzureNetworkBuilder("my-vnet").resourceGroup(rg);

    const result = await net.deploy();
    assert.strictEqual(result.vnet, "my-vnet");
    assert.strictEqual(result.subnet, "default");

    const nsgPut = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/networkSecurityGroups/"));
    const vnetPut = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/virtualNetworks/"));

    assert.ok(nsgPut);
    assert.ok(vnetPut);
  });

  test("associates custom network to VM and skips sidecar network creation", async () => {
    // VM dependencies setup
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Compute/virtualMachines/my-vm?api-version=2021-07-01"] = {
      status: 404,
      body: { error: { code: "VMNotFound" } }
    };
    // mock network interface creation
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/publicIPAddresses/ip-my-vm?api-version=2021-05-01"] = {
      status: 200,
      body: { id: "ip-id", properties: { ipAddress: "13.45.67.89" } }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/networkInterfaces/nic-my-vm?api-version=2021-05-01"] = {
      status: 200,
      body: { id: "nic-id" }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Compute/virtualMachines/my-vm?api-version=2021-07-01"] = {
      status: 201,
      body: { id: "vm-id" }
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const net = new AzureNetworkBuilder("my-vnet").resourceGroup(rg);
    
    // Resolve network outputs
    net.out.subnetId.resolve("/subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/virtualNetworks/my-vnet/subnets/default");

    const vm = new AzureVMBuilder("my-vm")
      .resourceGroup(rg)
      .network(net)
      .sshKey("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQD...");

    await vm.deploy();

    // Check that we did NOT call PUT on virtualNetworks sidecar (since custom network is managing it)
    const vnetPuts = fetchCalls.filter(c => c.method === "PUT" && c.url.includes("/virtualNetworks/vnet-my-vm"));
    assert.strictEqual(vnetPuts.length, 0);

    // Verify NIC creation used the custom network subnet ID
    const nicPut = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/networkInterfaces/nic-my-vm"));
    assert.ok(nicPut);
    assert.strictEqual(
      nicPut.body.properties.ipConfigurations[0].properties.subnet.id,
      "/subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/virtualNetworks/my-vnet/subnets/default"
    );
  });
});
