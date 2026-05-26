import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { GoogleAuth } from "google-auth-library";
import { GCPCloudSQLBuilder } from "./cloudsql.js";
import { Config } from "../../core/config.js";

describe("GCPCloudSQLBuilder Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        gcp: {
          projectId: "my-gcp-project",
          serviceAccountPath: "/fake/sa.json",
          region: "us-central1",
        },
      },
    });

    originalFetch = globalThis.fetch;
    fetchCalls = [];
    mockResponses = {};

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
          body = "[Binary/Buffer Body]";
        }
      }

      const headers = init?.headers;
      fetchCalls.push({ url, method, body, headers });

      const matchKey = Object.keys(mockResponses)
        .filter((key) => {
          const [mMethod, mPath] = key.split(" ");
          return method === mMethod && url.includes(mPath);
        })
        .sort((a, b) => b.split(" ")[1].length - a.split(" ")[1].length)[0];

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
        json: async () => ({ message: `Endpoint not mocked: ${method} ${url}` }),
        text: async () => `Endpoint not mocked: ${method} ${url}`,
      } as Response;
    };

    mock.method(GoogleAuth.prototype, "getClient", async () => {
      return {
        getAccessToken: async () => ({ token: "fake-gcp-token" }),
      };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test("fluent builder api sets properties correctly", () => {
    const builder = new GCPCloudSQLBuilder("my-db")
      .engine({ engine: "postgres", version: "15" })
      .size("db-custom-2-7680")
      .storage(50)
      .credentials("db_user", "db_pass")
      .database("my_app_db")
      .publicAccess(true)
      .region("us-east4");

    assert.strictEqual((builder as any)._engine, "postgres");
    assert.strictEqual((builder as any)._engineVersion, "15");
    assert.strictEqual((builder as any)._tier, "db-custom-2-7680");
    assert.strictEqual((builder as any)._storage, 50);
    assert.strictEqual((builder as any)._username, "db_user");
    assert.strictEqual((builder as any)._password, "db_pass");
    assert.strictEqual((builder as any)._dbName, "my_app_db");
    assert.strictEqual((builder as any)._publicAccess, true);
    assert.strictEqual((builder as any)._region, "us-east4");
  });

  test("runs in dry-run mode safely and logs plans", async () => {
    Config.set({
      dryRun: true,
      providers: {
        gcp: {
          projectId: "my-gcp-project",
          serviceAccountPath: "/fake/sa.json",
          region: "us-central1",
        },
      },
    });

    const builder = new GCPCloudSQLBuilder("dry-run-db")
      .credentials("root", "secretpwd")
      .engine({ engine: "mysql", version: "8.0" })
      .size("db-f1-micro")
      .storage(15);

    const result = await builder.deploy();
    assert.strictEqual(result.name, "dry-run-db");
    assert.strictEqual(result.endpoint, "127.0.0.1");
    assert.strictEqual(result.port, 3306);
    assert.strictEqual(result.connectionName, "my-gcp-project:us-central1:dry-run-db");

    // No write calls should be sent in dry-run mode
    const writeCalls = fetchCalls.filter((c) => c.method !== "GET");
    assert.strictEqual(writeCalls.length, 0);
  });

  test("creates a new instance, database, and custom user when missing", async () => {
    // 1. Stateful mock for GET /instances/new-db: returns 404 on discovery, 200 after creation
    mockResponses["GET /instances/new-db"] = {
      get status() {
        const getCalls = fetchCalls.filter((c) => c.method === "GET" && c.url.includes("/instances/new-db"));
        return getCalls.length <= 1 ? 404 : 200;
      },
      get body() {
        const getCalls = fetchCalls.filter((c) => c.method === "GET" && c.url.includes("/instances/new-db"));
        if (getCalls.length <= 1) return { message: "Not found" };
        return {
          name: "new-db",
          connectionName: "my-gcp-project:us-central1:new-db",
          ipAddresses: [{ type: "PRIMARY", ipAddress: "35.200.10.20" }],
          settings: {
            tier: "db-f1-micro",
            dataDiskSizeGb: "20",
          },
        };
      },
    } as any;

    // 2. Mock POST (create instance)
    mockResponses["POST /instances"] = {
      status: 200,
      body: { name: "op-create-123", status: "PENDING" },
    };

    // 3. Mock GET (poll operation status until DONE)
    mockResponses["GET /operations/op-create-123"] = {
      status: 200,
      body: { status: "DONE" },
    };

    // 5. Mock POST (create database)
    mockResponses["POST /instances/new-db/databases"] = {
      status: 201,
      body: {},
    };

    // 6. Mock POST (create custom user)
    mockResponses["POST /instances/new-db/users"] = {
      status: 201,
      body: {},
    };

    const builder = new GCPCloudSQLBuilder("new-db")
      .engine({ engine: "postgres", version: "16" })
      .size("db-f1-micro")
      .storage(20)
      .credentials("custom_admin", "securepwd")
      .database("custom_db")
      .publicAccess(false);

    const result = await builder.deploy();
    assert.strictEqual(result.name, "new-db");
    assert.strictEqual(result.endpoint, "35.200.10.20");
    assert.strictEqual(result.port, 5432);
    assert.strictEqual(result.connectionName, "my-gcp-project:us-central1:new-db");

    // Verify correct calls were made
    const postInstances = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/instances"));
    assert.ok(postInstances);
    assert.strictEqual(postInstances.body.name, "new-db");
    assert.strictEqual(postInstances.body.databaseVersion, "POSTGRES_16");
    assert.strictEqual(postInstances.body.rootPassword, "securepwd");
    assert.strictEqual(postInstances.body.settings.dataDiskSizeGb, "20");

    const postDB = fetchCalls.find((c) => c.method === "POST" && c.url.includes("/databases"));
    assert.ok(postDB);
    assert.strictEqual(postDB.body.name, "custom_db");

    const postUser = fetchCalls.find((c) => c.method === "POST" && c.url.includes("/users"));
    assert.ok(postUser);
    assert.strictEqual(postUser.body.name, "custom_admin");
    assert.strictEqual(postUser.body.password, "securepwd");
  });

  test("patches instance when configuration storage or tier differs", async () => {
    // 1. Mock GET (discovery) returns existing instance with 10GB and different tier
    mockResponses["GET /instances/patch-db"] = {
      status: 200,
      body: {
        name: "patch-db",
        connectionName: "my-gcp-project:us-central1:patch-db",
        ipAddresses: [{ type: "PRIMARY", ipAddress: "35.200.10.20" }],
        settings: {
          tier: "db-f1-micro",
          dataDiskSizeGb: "10",
        },
      },
    };

    // 2. Mock PATCH (update settings)
    mockResponses["PATCH /instances/patch-db"] = {
      status: 200,
      body: { name: "op-patch-123", status: "PENDING" },
    };

    // 3. Mock GET (poll operation status until DONE)
    mockResponses["GET /operations/op-patch-123"] = {
      status: 200,
      body: { status: "DONE" },
    };

    const builder = new GCPCloudSQLBuilder("patch-db")
      .engine({ engine: "postgres", version: "16" })
      .size("db-custom-2-7680") // changed tier!
      .storage(30) // increased storage!
      .credentials("postgres", "securepwd");

    const result = await builder.deploy();
    assert.strictEqual(result.name, "patch-db");

    // Verify PATCH was called
    const patchCalls = fetchCalls.filter((c) => c.method === "PATCH");
    assert.strictEqual(patchCalls.length, 1);
    assert.strictEqual(patchCalls[0].body.settings.tier, "db-custom-2-7680");
    assert.strictEqual(patchCalls[0].body.settings.dataDiskSizeGb, "30");
  });

  test("skips patch if instance configuration is identical", async () => {
    // 1. Mock GET (discovery) returns identical settings
    mockResponses["GET /instances/ident-db"] = {
      status: 200,
      body: {
        name: "ident-db",
        connectionName: "my-gcp-project:us-central1:ident-db",
        ipAddresses: [{ type: "PRIMARY", ipAddress: "35.200.10.20" }],
        settings: {
          tier: "db-f1-micro",
          dataDiskSizeGb: "10",
          ipConfiguration: {
            authorizedNetworks: [],
          },
        },
      },
    };

    const builder = new GCPCloudSQLBuilder("ident-db")
      .engine({ engine: "postgres", version: "16" })
      .size("db-f1-micro")
      .storage(10)
      .credentials("postgres", "securepwd")
      .publicAccess(false);

    const result = await builder.deploy();
    assert.strictEqual(result.name, "ident-db");

    // Assert NO write calls for instances (POST or PATCH) occurred
    const writeCalls = fetchCalls.filter(
      (c) =>
        c.method === "PATCH" ||
        (c.method === "POST" && c.url.endsWith("/instances"))
    );
    assert.strictEqual(writeCalls.length, 0);
  });

  test("destroys an existing instance successfully", async () => {
    // 1. Mock GET (discovery on destroy) returns existing instance
    mockResponses["GET /instances/to-delete-db"] = {
      status: 200,
      body: {
        name: "to-delete-db",
        connectionName: "my-gcp-project:us-central1:to-delete-db",
      },
    };

    // 2. Mock DELETE
    mockResponses["DELETE /instances/to-delete-db"] = {
      status: 200,
      body: { name: "op-delete-123", status: "PENDING" },
    };

    // 3. Mock GET (poll operation status until DONE)
    mockResponses["GET /operations/op-delete-123"] = {
      status: 200,
      body: { status: "DONE" },
    };

    const builder = new GCPCloudSQLBuilder("to-delete-db");
    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: "to-delete-db" });

    // Verify DELETE was called
    const deleteCalls = fetchCalls.filter((c) => c.method === "DELETE");
    assert.strictEqual(deleteCalls.length, 1);
    assert.strictEqual(deleteCalls[0].url.includes("/instances/to-delete-db"), true);
  });

  test("destroy does nothing when instance does not exist", async () => {
    // Mock GET returned 404
    mockResponses["GET /instances/not-exist-db"] = {
      status: 404,
      body: { message: "Not found" },
    };

    const builder = new GCPCloudSQLBuilder("not-exist-db");
    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: "not-exist-db" });

    // Verify no DELETE was called
    const deleteCalls = fetchCalls.filter((c) => c.method === "DELETE");
    assert.strictEqual(deleteCalls.length, 0);
  });
});
