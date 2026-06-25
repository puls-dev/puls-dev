import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { BlobStorageBuilder } from "./blob_storage.js";
import { ResourceGroupBuilder } from "./resource_group.js";
import { Config } from "@puls-dev/core";

describe("BlobStorageBuilder Unit Tests", () => {
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

  test("discovers storage account and container if they already exist", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Storage/storageAccounts/mystore?api-version=2021-09-01"] = {
      status: 200,
      body: { id: "mystore-id", name: "mystore" }
    };
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Storage/storageAccounts/mystore/blobServices/default/containers/default?api-version=2021-09-01"] = {
      status: 200,
      body: { id: "container-id", name: "default" }
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new BlobStorageBuilder("mystore").resourceGroup(rg);
    const result = await builder.deploy();

    assert.strictEqual(result.storageAccount, "mystore");
    assert.strictEqual(result.container, "default");

    const puts = fetchCalls.filter(c => c.method === "PUT");
    assert.strictEqual(puts.length, 0); // No puts should be made
  });

  test("creates storage account and container if they are missing", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Storage/storageAccounts/mystore?api-version=2021-09-01"] = {
      status: 404,
      body: { error: { code: "StorageAccountNotFound" } }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Storage/storageAccounts/mystore?api-version=2021-09-01"] = {
      status: 200,
      body: { id: "mystore-id", name: "mystore" }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Storage/storageAccounts/mystore/blobServices/default/containers/default?api-version=2021-09-01"] = {
      status: 200,
      body: {}
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new BlobStorageBuilder("mystore").resourceGroup(rg).sku("Standard_GRS").containerName("default");
    const result = await builder.deploy();

    assert.strictEqual(result.storageAccount, "mystore");
    assert.strictEqual(result.container, "default");

    const putAccount = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/storageAccounts/mystore"));
    assert.ok(putAccount);
    assert.deepStrictEqual(putAccount.body, {
      sku: { name: "Standard_GRS" },
      kind: "StorageV2",
      location: "eastus"
    });

    const putContainer = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/containers/default"));
    assert.ok(putContainer);
  });

  test("does not call fetch writes during dryRun", async () => {
    Config.set({
      dryRun: true,
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

    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Storage/storageAccounts/mystore?api-version=2021-09-01"] = {
      status: 404,
      body: { error: { code: "StorageAccountNotFound" } }
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new BlobStorageBuilder("mystore").resourceGroup(rg);
    const result = await builder.deploy();

    assert.strictEqual(result.storageAccount, "mystore");
    const puts = fetchCalls.filter(c => c.method === "PUT");
    assert.strictEqual(puts.length, 0);
  });

  test("deletes storage account on destroy", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Storage/storageAccounts/mystore?api-version=2021-09-01"] = {
      status: 200,
      body: { id: "mystore-id", name: "mystore" }
    };
    mockResponses["DELETE /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Storage/storageAccounts/mystore?api-version=2021-09-01"] = {
      status: 200,
      body: {}
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new BlobStorageBuilder("mystore").resourceGroup(rg);
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: "mystore" });
    const deleteCall = fetchCalls.find(c => c.method === "DELETE");
    assert.ok(deleteCall);
  });
});
