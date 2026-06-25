import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { AppServiceBuilder } from "./app_service.js";
import { ResourceGroupBuilder } from "./resource_group.js";
import { Config } from "@puls-dev/core";

describe("AppServiceBuilder Unit Tests", () => {
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

  test("discovers plan and web app if they already exist", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/serverfarms/plan-myapp?api-version=2021-02-01"] = {
      status: 200,
      body: { id: "plan-id", name: "plan-myapp" }
    };
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/sites/myapp?api-version=2021-02-01"] = {
      status: 200,
      body: {
        id: "app-id",
        name: "myapp",
        properties: { defaultHostName: "myapp.azurewebsites.net" }
      }
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new AppServiceBuilder("myapp").resourceGroup(rg).planName("plan-myapp");
    const result = await builder.deploy();

    assert.strictEqual(result.appName, "myapp");
    assert.strictEqual(result.defaultHostName, "myapp.azurewebsites.net");

    const puts = fetchCalls.filter(c => c.method === "PUT");
    assert.strictEqual(puts.length, 0);
  });

  test("creates App Service Plan and Web App if they are missing", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/serverfarms/plan-myapp?api-version=2021-02-01"] = {
      status: 404,
      body: {}
    };
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/sites/myapp?api-version=2021-02-01"] = {
      status: 404,
      body: {}
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/serverfarms/plan-myapp?api-version=2021-02-01"] = {
      status: 200,
      body: { id: "plan-id", name: "plan-myapp" }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/sites/myapp?api-version=2021-02-01"] = {
      status: 200,
      body: {
        id: "app-id",
        name: "myapp",
        properties: { defaultHostName: "myapp.azurewebsites.net" }
      }
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new AppServiceBuilder("myapp")
      .resourceGroup(rg)
      .planName("plan-myapp")
      .sku("B1")
      .runtime("NODE|18-lts");
    
    const result = await builder.deploy();

    assert.strictEqual(result.appName, "myapp");
    assert.strictEqual(result.defaultHostName, "myapp.azurewebsites.net");

    const putPlan = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/serverfarms/plan-myapp"));
    assert.ok(putPlan);
    assert.deepStrictEqual(putPlan.body, {
      location: "eastus",
      sku: { name: "B1", tier: "Basic" },
      kind: "linux",
      properties: { reserved: true }
    });

    const putApp = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/sites/myapp"));
    assert.ok(putApp);
    assert.deepStrictEqual(putApp.body, {
      location: "eastus",
      properties: {
        serverFarmId: "plan-id",
        siteConfig: {
          linuxFxVersion: "NODE|18-lts"
        }
      }
    });
  });

  test("performs dry-run without making write calls", async () => {
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

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new AppServiceBuilder("myapp")
      .resourceGroup(rg)
      .planName("plan-myapp")
      .sku("B1")
      .runtime("NODE|20-lts");

    const result = await builder.deploy();

    assert.strictEqual(result.appName, "myapp");
    assert.strictEqual(result.defaultHostName, "PENDING");
    assert.strictEqual(fetchCalls.filter(c => c.method === "PUT").length, 0);
  });

  test("skips destroy when App Service not found", async () => {
    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new AppServiceBuilder("myapp")
      .resourceGroup(rg)
      .planName("plan-myapp");

    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: false });
    assert.strictEqual(fetchCalls.filter(c => c.method === "DELETE").length, 0);
  });

  test("destroys web app and service plan successfully", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/serverfarms/plan-myapp?api-version=2021-02-01"] = {
      status: 200,
      body: { id: "plan-id" }
    };
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/sites/myapp?api-version=2021-02-01"] = {
      status: 200,
      body: { id: "app-id" }
    };
    mockResponses["DELETE /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/sites/myapp?api-version=2021-02-01"] = {
      status: 200,
      body: {}
    };
    mockResponses["DELETE /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Web/serverfarms/plan-myapp?api-version=2021-02-01"] = {
      status: 200,
      body: {}
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new AppServiceBuilder("myapp").resourceGroup(rg).planName("plan-myapp");
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: "myapp" });
    const deletes = fetchCalls.filter(c => c.method === "DELETE");
    assert.strictEqual(deletes.length, 2);
  });
});
