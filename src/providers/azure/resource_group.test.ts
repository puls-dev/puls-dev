import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ResourceGroupBuilder } from "./resource_group.js";
import { Config } from "../../core/config.js";

describe("ResourceGroupBuilder Unit Tests", () => {
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

  test("discovers group successfully if it already exists", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourcegroups/my-rg?api-version=2021-04-01"] = {
      status: 200,
      body: {
        id: "/subscriptions/fake-sub/resourcegroups/my-rg",
        name: "my-rg",
        location: "eastus",
        properties: { provisioningState: "Succeeded" }
      }
    };

    const builder = new ResourceGroupBuilder("my-rg");
    const result = await builder.deploy();

    assert.strictEqual(result.groupName, "my-rg");
    assert.strictEqual(result.location, "eastus");

    const puts = fetchCalls.filter(c => c.method === "PUT");
    assert.strictEqual(puts.length, 0);
  });

  test("creates group if it does not exist", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourcegroups/my-rg?api-version=2021-04-01"] = {
      status: 404,
      body: { error: { code: "ResourceGroupNotFound" } }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourcegroups/my-rg?api-version=2021-04-01"] = {
      status: 201,
      body: {
        id: "/subscriptions/fake-sub/resourcegroups/my-rg",
        name: "my-rg",
        location: "westus2",
        properties: { provisioningState: "Succeeded" }
      }
    };

    const builder = new ResourceGroupBuilder("my-rg").location("westus2");
    const result = await builder.deploy();

    assert.strictEqual(result.groupName, "my-rg");
    assert.strictEqual(result.location, "westus2");

    const putCall = fetchCalls.find(c => c.method === "PUT");
    assert.ok(putCall);
    assert.deepStrictEqual(putCall.body, { location: "westus2" });
  });

  test("does not call fetch during dryRun deploy", async () => {
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

    mockResponses["GET /subscriptions/fake-sub/resourcegroups/my-rg?api-version=2021-04-01"] = {
      status: 404,
      body: { error: { code: "ResourceGroupNotFound" } }
    };

    const builder = new ResourceGroupBuilder("my-rg");
    const result = await builder.deploy();

    assert.strictEqual(result.id, "PENDING");
    const puts = fetchCalls.filter(c => c.method === "PUT");
    assert.strictEqual(puts.length, 0);
  });

  test("destroys group successfully if exists", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourcegroups/my-rg?api-version=2021-04-01"] = {
      status: 200,
      body: {
        id: "/subscriptions/fake-sub/resourcegroups/my-rg",
        name: "my-rg",
        location: "eastus",
        properties: { provisioningState: "Succeeded" }
      }
    };
    mockResponses["DELETE /subscriptions/fake-sub/resourcegroups/my-rg?api-version=2021-04-01"] = {
      status: 200,
      body: {}
    };

    const builder = new ResourceGroupBuilder("my-rg");
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: "my-rg" });
    const deleteCall = fetchCalls.find(c => c.method === "DELETE");
    assert.ok(deleteCall);
  });
});
