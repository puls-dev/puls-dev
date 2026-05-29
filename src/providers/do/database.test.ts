import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { DatabaseBuilder } from "./database.js";
import { Config } from "../../core/config.js";

describe("DatabaseBuilder Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; method: string; body?: any; headers?: any }> = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        do: { token: "fake-do-token", defaultRegion: "nyc3" },
      },
    });

    originalFetch = globalThis.fetch;
    fetchCalls = [];
    mockResponses = {};

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
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
        json: async () => ({ message: "Not found" }),
        text: async () => "Not found",
      } as Response;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("gracefully handles discovery when Database Cluster does not exist", async () => {
    mockResponses["GET /databases"] = {
      status: 200,
      body: { databases: [] },
    };

    const builder = new DatabaseBuilder("my-db");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].method, "GET");
    assert.ok(fetchCalls[0].url.includes("/databases"));
  });

  test("discovers Database Cluster successfully when it exists", async () => {
    mockResponses["GET /databases"] = {
      status: 200,
      body: {
        databases: [
          {
            id: "db-123",
            name: "my-db",
            status: "online",
            connection: {
              host: "10.0.0.5",
              port: 5432,
              uri: "postgresql://user:pass@10.0.0.5:5432/db",
              user: "user",
              password: "pass",
            },
          },
        ],
      },
    };

    const builder = new DatabaseBuilder("my-db");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.id, "db-123");
    assert.strictEqual(discoveryResult.status, "online");

    const host = await builder.out.host.get();
    const port = await builder.out.port.get();
    const uri = await builder.out.uri.get();
    assert.strictEqual(host, "10.0.0.5");
    assert.strictEqual(port, 5432);
    assert.strictEqual(uri, "postgresql://user:pass@10.0.0.5:5432/db");
  });

  test("performs clean dry-run planning without making write requests", async () => {
    Config.set({
      dryRun: true,
      providers: { do: { token: "fake-token" } },
    });

    mockResponses["GET /databases"] = {
      status: 200,
      body: { databases: [] },
    };

    const builder = new DatabaseBuilder("my-dry-db")
      .engine("mysql")
      .version("8")
      .size("db-s-2vcpu-4gb")
      .nodes(2)
      .vpc("vpc-999")
      .allowIp("1.1.1.1/32");

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, "my-dry-db");
    assert.strictEqual(result.id, "PENDING");

    // Discover should run, but no creations/firewall writes
    const writeCalls = fetchCalls.filter((c) => c.method !== "GET");
    assert.strictEqual(writeCalls.length, 0);

    const host = await builder.out.host.get();
    assert.strictEqual(host, "127.0.0.1");
  });

  test("deploys new Database Cluster and awaits status: online", async () => {
    mockResponses["GET /databases"] = {
      status: 200,
      body: { databases: [] },
    };
    mockResponses["POST /databases"] = {
      status: 201,
      body: { database: { id: "new-db-id", name: "my-db-new", status: "provisioning" } },
    };

    let pollCount = 0;
    mockResponses["GET /databases/new-db-id"] = {
      status: 200,
      get body() {
        pollCount++;
        if (pollCount === 1) {
          return { database: { id: "new-db-id", status: "provisioning" } };
        }
        return {
          database: {
            id: "new-db-id",
            status: "online",
            connection: {
              host: "db-node.example.com",
              port: 3306,
              uri: "mysql://admin:secret@db-node.example.com:3306/db",
              user: "admin",
              password: "secret",
            },
          },
        };
      },
    };

    mockResponses["PUT /databases/new-db-id/firewall"] = {
      status: 204,
      body: {},
    };

    const builder = new DatabaseBuilder("my-db-new")
      .engine("mysql")
      .version("8.0")
      .size("db-s-1vcpu-1gb")
      .nodes(1)
      .allowIp("1.2.3.4/32");

    // Instantly check status
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      let done = false;
      while (!done) {
        done = await condition();
      }
    };

    const result = await builder.deploy();
    assert.ok(result);
    assert.strictEqual(result.id, "new-db-id");
    assert.strictEqual(result.status, "online");

    const host = await builder.out.host.get();
    assert.strictEqual(host, "db-node.example.com");

    const postCall = fetchCalls.find((c) => c.method === "POST" && c.url.includes("/databases"));
    assert.ok(postCall);
    assert.deepStrictEqual(postCall.body, {
      name: "my-db-new",
      engine: "mysql",
      version: "8.0",
      region: "nyc3",
      size: "db-s-1vcpu-1gb",
      num_nodes: 1,
    });

    const firewallCall = fetchCalls.find(
      (c) => c.method === "PUT" && c.url.includes("/databases/new-db-id/firewall")
    );
    assert.ok(firewallCall);
    assert.deepStrictEqual(firewallCall.body, {
      rules: [{ type: "ip_addr", value: "1.2.3.4/32" }],
    });
  });

  test("deploys new Database Cluster with private VPC network assignment", async () => {
    mockResponses["GET /databases"] = {
      status: 200,
      body: { databases: [] },
    };
    mockResponses["POST /databases"] = {
      status: 201,
      body: { database: { id: "vpc-db-id", name: "my-vpc-db", status: "provisioning" } },
    };
    mockResponses["GET /databases/vpc-db-id"] = {
      status: 200,
      body: {
        database: {
          id: "vpc-db-id",
          status: "online",
          private_connection: {
            host: "db-node.private.int",
            port: 5432,
            uri: "postgresql://user:pwd@db-node.private.int:5432/db",
            user: "user",
            password: "pwd",
          },
          connection: {
            host: "db-node.public.com",
            port: 5432,
            uri: "postgresql://user:pwd@db-node.public.com:5432/db",
            user: "user",
            password: "pwd",
          },
        },
      },
    };

    const builder = new DatabaseBuilder("my-vpc-db")
      .engine("pg")
      .vpc("my-custom-vpc-uuid");

    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      await condition();
    };

    const result = await builder.deploy();
    assert.ok(result);

    const host = await builder.out.host.get();
    // Should prefer private VPC host!
    assert.strictEqual(host, "db-node.private.int");

    const postCall = fetchCalls.find((c) => c.method === "POST" && c.url.includes("/databases"));
    assert.ok(postCall);
    assert.strictEqual(postCall.body.private_network_uuid, "my-custom-vpc-uuid");
  });

  test("updates firewall rules (trusted sources) on existing cluster", async () => {
    mockResponses["GET /databases"] = {
      status: 200,
      body: {
        databases: [
          {
            id: "db-123",
            name: "my-db",
            status: "online",
            connection: {
              host: "10.0.0.5",
              port: 5432,
              uri: "postgresql://user:pass@10.0.0.5:5432/db",
              user: "user",
              password: "pass",
            },
          },
        ],
      },
    };

    mockResponses["PUT /databases/db-123/firewall"] = {
      status: 204,
      body: {},
    };

    const builder = new DatabaseBuilder("my-db")
      .allowDroplet("99999");

    await builder.deploy();

    const putCall = fetchCalls.find((c) => c.method === "PUT" && c.url.includes("/databases/db-123/firewall"));
    assert.ok(putCall);
    assert.deepStrictEqual(putCall.body, {
      rules: [{ type: "droplet", value: "99999" }],
    });
  });

  test("destroys Database Cluster successfully", async () => {
    mockResponses["GET /databases"] = {
      status: 200,
      body: {
        databases: [
          { id: "db-123", name: "my-db-del" },
        ],
      },
    };
    mockResponses["DELETE /databases/db-123"] = {
      status: 204,
      body: {},
    };

    const builder = new DatabaseBuilder("my-db-del");
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: "my-db-del" });

    const deleteCall = fetchCalls.find((c) => c.method === "DELETE");
    assert.ok(deleteCall);
    assert.ok(deleteCall.url.endsWith("/databases/db-123"));
  });
});
