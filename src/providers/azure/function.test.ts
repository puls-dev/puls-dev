import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ResourceGroupBuilder } from "./resource_group.js";
import { BlobStorageBuilder } from "./blob_storage.js";
import { AzureFunctionBuilder } from "./function.js";
import { Config } from "../../core/config.js";

describe("AzureFunctionBuilder Unit Tests", () => {
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

  test("creates consumption plan and Function App with storage connection string", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/serverfarms/plan-myfnapp?api-version=2021-02-01"] = {
      status: 404,
      body: { error: { code: "PlanNotFound" } }
    };
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/sites/myfnapp?api-version=2021-02-01"] = {
      status: 404,
      body: { error: { code: "SiteNotFound" } }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/serverfarms/plan-myfnapp?api-version=2021-02-01"] = {
      status: 200,
      body: { id: "plan-id" }
    };
    mockResponses["POST /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Storage/storageAccounts/storageacct/listKeys?api-version=2021-09-01"] = {
      status: 200,
      body: { keys: [{ value: "my-fake-storage-access-key-value" }] }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/sites/myfnapp?api-version=2021-02-01"] = {
      status: 200,
      body: {
        id: "site-id",
        properties: { defaultHostName: "myfnapp.azurewebsites.net" }
      }
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const storage = new BlobStorageBuilder("storageacct").resourceGroup(rg);
    const fn = new AzureFunctionBuilder("myfnapp")
      .resourceGroup(rg)
      .storage(storage)
      .runtime("python")
      .env("CUSTOM_SETTING", "my-val");

    // Stub storage discovery promise
    (storage as any).discoveryPromise = Promise.resolve({ account: { id: "acct-id" } });

    const result = await fn.deploy();
    assert.deepStrictEqual(result, { appName: "myfnapp", defaultHostName: "myfnapp.azurewebsites.net" });

    const keysCall = fetchCalls.find(c => c.method === "POST" && c.url.includes("/listKeys"));
    assert.ok(keysCall);

    const sitePut = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/sites/myfnapp"));
    assert.ok(sitePut);

    assert.strictEqual(sitePut.body.kind, "functionapp,linux");
    const appSettings = sitePut.body.properties.siteConfig.appSettings;
    
    const storageSetting = appSettings.find((s: any) => s.name === "AzureWebJobsStorage");
    assert.ok(storageSetting);
    assert.ok(storageSetting.value.includes("AccountKey=my-fake-storage-access-key-value"));

    const runtimeSetting = appSettings.find((s: any) => s.name === "FUNCTIONS_WORKER_RUNTIME");
    assert.strictEqual(runtimeSetting.value, "python");

    const customSetting = appSettings.find((s: any) => s.name === "CUSTOM_SETTING");
    assert.strictEqual(customSetting.value, "my-val");
  });

  test("destroys Function App and plan successfully", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/serverfarms/plan-myfnapp?api-version=2021-02-01"] = {
      status: 200,
      body: { id: "plan-id" }
    };
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/sites/myfnapp?api-version=2021-02-01"] = {
      status: 200,
      body: { id: "site-id" }
    };
    mockResponses["DELETE /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/sites/myfnapp?api-version=2021-02-01"] = {
      status: 200,
      body: {}
    };
    mockResponses["DELETE /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/serverfarms/plan-myfnapp?api-version=2021-02-01"] = {
      status: 200,
      body: {}
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const fn = new AzureFunctionBuilder("myfnapp").resourceGroup(rg);

    const result = await fn.destroy();
    assert.deepStrictEqual(result, { destroyed: "myfnapp" });

    const deletes = fetchCalls.filter(c => c.method === "DELETE");
    assert.strictEqual(deletes.length, 2);
  });
});
