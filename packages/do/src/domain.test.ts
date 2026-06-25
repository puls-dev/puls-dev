import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { DomainBuilder } from "./domain.js";
import { Config } from "@puls-dev/core";

describe("DomainBuilder Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        do: { token: "fake-do-token" }
      }
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
        json: async () => ({ message: "Not found" }),
        text: async () => "Not found",
      } as Response;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("gracefully handles discovery when domain does not exist", async () => {
    mockResponses["GET /domains/new-domain.com"] = {
      status: 404,
      body: { message: "Domain not found" }
    };

    const builder = new DomainBuilder("new-domain.com");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].method, "GET");
    assert.ok(fetchCalls[0].url.endsWith("/domains/new-domain.com"));
  });

  test("discovers domain successfully when it exists", async () => {
    mockResponses["GET /domains/exists.com"] = {
      status: 200,
      body: {
        domain: {
          name: "exists.com",
          ttl: 1800,
          zone_file: "..."
        }
      }
    };

    const builder = new DomainBuilder("exists.com");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.name, "exists.com");
    assert.strictEqual(fetchCalls.length, 1);
  });

  test("performs clean dry-run planning without making write requests", async () => {
    Config.set({
      dryRun: true,
      providers: { do: { token: "fake-token" } }
    });

    mockResponses["GET /domains/dryrun.com"] = {
      status: 404,
      body: { message: "Domain not found" }
    };

    const builder = new DomainBuilder("dryrun.com");
    builder.pointer("www", "1.2.3.4");
    builder.cname("blog", "blog.dryrun.com");

    const result = await builder.deploy();

    assert.deepStrictEqual(result, {
      domain: "dryrun.com",
      records: [
        { type: "A", name: "www", value: "1.2.3.4" },
        { type: "CNAME", name: "blog", value: "blog.dryrun.com" }
      ]
    });

    const writeCalls = fetchCalls.filter(c => c.method !== "GET");
    assert.strictEqual(writeCalls.length, 0);
  });

  test("deploys new domain and creates records when domain is missing", async () => {
    mockResponses["GET /domains/new.com"] = {
      status: 404,
      body: { message: "Domain not found" }
    };
    mockResponses["POST /domains"] = {
      status: 201,
      body: { domain: { name: "new.com" } }
    };
    mockResponses["POST /domains/new.com/records"] = {
      status: 201,
      body: { domain_record: { id: 101 } }
    };

    const builder = new DomainBuilder("new.com");
    builder.pointer("www", "5.6.7.8");

    await builder.deploy();

    assert.strictEqual(fetchCalls.length, 3);
    assert.strictEqual(fetchCalls[0].method, "GET");
    assert.strictEqual(fetchCalls[1].method, "POST");
    assert.ok(fetchCalls[1].url.endsWith("/domains"));
    assert.deepStrictEqual(fetchCalls[1].body, { name: "new.com" });

    assert.strictEqual(fetchCalls[2].method, "POST");
    assert.ok(fetchCalls[2].url.endsWith("/domains/new.com/records"));
    assert.deepStrictEqual(fetchCalls[2].body, {
      type: "A",
      name: "www",
      data: "5.6.7.8",
      ttl: 3600,
      priority: null,
      port: null,
      weight: null,
      flags: null,
      tag: null
    });
  });

  test("syncs records: skips matching, updates out-of-date, deletes stale/duplicate", async () => {
    mockResponses["GET /domains/sync.com"] = {
      status: 200,
      body: { domain: { name: "sync.com" } }
    };

    mockResponses["GET /domains/sync.com/records?per_page=200"] = {
      status: 200,
      body: {
        domain_records: [
          { id: 10, type: "A", name: "www", data: "1.1.1.1" },
          { id: 20, type: "A", name: "api", data: "2.2.2.2" },
          { id: 30, type: "A", name: "api", data: "4.4.4.4" }
        ]
      }
    };

    mockResponses["PUT /domains/sync.com/records/20"] = {
      status: 200,
      body: { domain_record: { id: 20 } }
    };
    mockResponses["DELETE /domains/sync.com/records/30"] = {
      status: 204,
      body: {}
    };

    const builder = new DomainBuilder("sync.com");
    builder.pointer("www", "1.1.1.1");
    builder.pointer("api", "3.3.3.3");

    await builder.deploy();

    const putCall = fetchCalls.find(c => c.method === "PUT");
    assert.ok(putCall);
    assert.ok(putCall.url.endsWith("/domains/sync.com/records/20"));
    assert.deepStrictEqual(putCall.body, {
      type: "A",
      name: "api",
      data: "3.3.3.3",
      ttl: 3600,
      priority: null,
      port: null,
      weight: null,
      flags: null,
      tag: null
    });

    const deleteCall = fetchCalls.find(c => c.method === "DELETE");
    assert.ok(deleteCall);
    assert.ok(deleteCall.url.endsWith("/domains/sync.com/records/30"));

    const postCall = fetchCalls.find(c => c.method === "POST");
    assert.strictEqual(postCall, undefined);
  });

  test("destroys domain successfully", async () => {
    mockResponses["GET /domains/destroy.com"] = {
      status: 200,
      body: { domain: { name: "destroy.com" } }
    };
    mockResponses["DELETE /domains/destroy.com"] = {
      status: 204,
      body: {}
    };

    const builder = new DomainBuilder("destroy.com");
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: "destroy.com" });

    const deleteCall = fetchCalls.find(c => c.method === "DELETE");
    assert.ok(deleteCall);
    assert.ok(deleteCall.url.endsWith("/domains/destroy.com"));
  });

  test("loads records from a configuration file (YAML) successfully", async () => {
    mockResponses["GET /domains/file-do.com"] = {
      status: 200,
      body: { domain: { name: "file-do.com" } }
    };
    mockResponses["GET /domains/file-do.com/records?per_page=200"] = {
      status: 200,
      body: { domain_records: [] }
    };
    mockResponses["POST /domains/file-do.com/records"] = {
      status: 201,
      body: { domain_record: { id: 201 } }
    };

    // Mock YAML file creation
    const tempYamlPath = path.resolve(process.cwd(), "temp-do-records.yaml");
    const yamlContent = `
- name: www
  type: CNAME
  value: lb.google.com
- name: mail
  type: A
  value: 1.2.3.4
`;
    fs.writeFileSync(tempYamlPath, yamlContent, "utf-8");

    try {
      const builder = new DomainBuilder("file-do.com")
        .record("temp-do-records.yaml")
        .record("api", "A", "10.0.0.9"); // Hybrid programmatic record!

      const result = await builder.deploy();
      assert.strictEqual(result.records.length, 3);

      const wwwRec = result.records.find((r) => r.name === "www");
      assert.ok(wwwRec);
      assert.strictEqual(wwwRec.type, "CNAME");
      assert.strictEqual(wwwRec.value, "lb.google.com");

      const mailRec = result.records.find((r) => r.name === "mail");
      assert.ok(mailRec);
      assert.strictEqual(mailRec.type, "A");
      assert.strictEqual(mailRec.value, "1.2.3.4");

      const apiRec = result.records.find((r) => r.name === "api");
      assert.ok(apiRec);
      assert.strictEqual(apiRec.value, "10.0.0.9");
    } finally {
      if (fs.existsSync(tempYamlPath)) fs.unlinkSync(tempYamlPath);
    }
  });
});
