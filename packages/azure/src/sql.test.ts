import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ResourceGroupBuilder } from "./resource_group.js";
import { AzureSQLBuilder } from "./sql.js";
import { Config } from "@puls-dev/core";

describe("AzureSQLBuilder Unit Tests", () => {
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

  test("creates SQL server and database if they do not exist", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Sql/servers/mysqlserver?api-version=2021-11-01"] = {
      status: 404,
      body: { error: { code: "ServerNotFound" } }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Sql/servers/mysqlserver?api-version=2021-11-01"] = {
      status: 201,
      body: { id: "server-id" }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Sql/servers/mysqlserver/databases/mydb?api-version=2021-11-01"] = {
      status: 201,
      body: { id: "db-id" }
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new AzureSQLBuilder("mysqlserver")
      .resourceGroup(rg)
      .database("mydb")
      .credentials("admin", "pwd123456!");

    const result = await builder.deploy();
    assert.deepStrictEqual(result, { server: "mysqlserver", database: "mydb" });

    const puts = fetchCalls.filter(c => c.method === "PUT");
    assert.strictEqual(puts.length, 2);
  });

  test("skips deployment if SQL server and database exist", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Sql/servers/mysqlserver?api-version=2021-11-01"] = {
      status: 200,
      body: { id: "server-id" }
    };
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Sql/servers/mysqlserver/databases/mydb?api-version=2021-11-01"] = {
      status: 200,
      body: { id: "db-id" }
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new AzureSQLBuilder("mysqlserver")
      .resourceGroup(rg)
      .database("mydb");

    const result = await builder.deploy();
    assert.deepStrictEqual(result, { server: "mysqlserver", database: "mydb" });

    const puts = fetchCalls.filter(c => c.method === "PUT");
    assert.strictEqual(puts.length, 0);
  });

  test("destroys SQL server if it exists", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Sql/servers/mysqlserver?api-version=2021-11-01"] = {
      status: 200,
      body: { id: "server-id" }
    };
    mockResponses["DELETE /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Sql/servers/mysqlserver?api-version=2021-11-01"] = {
      status: 200,
      body: {}
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const builder = new AzureSQLBuilder("mysqlserver").resourceGroup(rg);

    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: "mysqlserver" });

    const del = fetchCalls.find(c => c.method === "DELETE");
    assert.ok(del);
  });
});
