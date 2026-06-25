import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { ZoneBuilder } from "./zone.js";
import { Config } from "@puls-dev/core";

describe("ZoneBuilder Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        cloudflare: { token: "fake-cf-token", accountId: "fake-cf-account" }
      }
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
        json: async () => ({ errors: [{ message: "Not found" }] }),
        text: async () => "Not found",
      } as Response;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("discovers zone successfully if it already exists", async () => {
    mockResponses["GET /zones?name=example.com"] = {
      status: 200,
      body: {
        result: [
          { id: "zone-123", name: "example.com", status: "active" }
        ]
      }
    };
    mockResponses["GET /zones/zone-123/dns_records?per_page=100"] = {
      status: 200,
      body: { result: [] }
    };

    const builder = new ZoneBuilder("example.com");
    const result = await builder.deploy();

    assert.strictEqual(result.zoneId, "zone-123");
    assert.strictEqual(builder.resolvedId, "zone-123");

    const posts = fetchCalls.filter(c => c.method === "POST");
    assert.strictEqual(posts.length, 0); // No zone creation
  });

  test("creates zone if it does not exist", async () => {
    mockResponses["GET /zones?name=example.com"] = {
      status: 200,
      body: { result: [] }
    };
    mockResponses["POST /zones"] = {
      status: 200,
      body: { result: { id: "zone-new-456" } }
    };

    const builder = new ZoneBuilder("example.com");
    const result = await builder.deploy();

    assert.strictEqual(result.zoneId, "zone-new-456");
    assert.strictEqual(builder.resolvedId, "zone-new-456");

    const postCall = fetchCalls.find(c => c.method === "POST" && c.url.endsWith("/zones"));
    assert.ok(postCall);
    assert.deepStrictEqual(postCall.body, {
      name: "example.com",
      account: { id: "fake-cf-account" },
      type: "full"
    });
  });

  test("handles dry-run deploy properly", async () => {
    Config.set({
      dryRun: true,
      providers: {
        cloudflare: { token: "fake-cf-token", accountId: "fake-cf-account" }
      }
    });

    mockResponses["GET /zones?name=example.com"] = {
      status: 200,
      body: { result: [] }
    };

    const builder = new ZoneBuilder("example.com");
    const result = await builder.deploy();

    assert.strictEqual(result.zoneId, "PENDING");
    const posts = fetchCalls.filter(c => c.method === "POST");
    assert.strictEqual(posts.length, 0);
  });

  test("reconciles records correctly (creates missing, updates out of date, deletes stale)", async () => {
    mockResponses["GET /zones?name=example.com"] = {
      status: 200,
      body: {
        result: [{ id: "zone-123", name: "example.com" }]
      }
    };
    mockResponses["GET /zones/zone-123/dns_records?per_page=100"] = {
      status: 200,
      body: {
        result: [
          // Perfect match - should be skipped
          { id: "rec-1", type: "A", name: "www.example.com", content: "1.1.1.1", proxied: true },
          // Out of date - should be updated (content mismatch)
          { id: "rec-2", type: "CNAME", name: "blog.example.com", content: "old.example.com", proxied: false },
          // Duplicate/stale record of a declared name/type - should be deleted
          { id: "rec-3", type: "A", name: "www.example.com", content: "8.8.8.8", proxied: true }
        ]
      }
    };

    mockResponses["PUT /zones/zone-123/dns_records/rec-2"] = {
      status: 200,
      body: { result: { id: "rec-2" } }
    };
    mockResponses["POST /zones/zone-123/dns_records"] = {
      status: 200,
      body: { result: { id: "rec-4" } }
    };
    mockResponses["DELETE /zones/zone-123/dns_records/rec-3"] = {
      status: 200,
      body: {}
    };

    const builder = new ZoneBuilder("example.com");
    // rec-1
    builder.pointer("www", "1.1.1.1", true);
    // rec-2 (updated)
    builder.cname("blog", "new.example.com", false);
    // rec-4 (created)
    builder.pointer("api", "2.2.2.2", false);

    await builder.deploy();

    const putCall = fetchCalls.find(c => c.method === "PUT");
    assert.ok(putCall);
    assert.ok(putCall.url.endsWith("/zones/zone-123/dns_records/rec-2"));
    assert.deepStrictEqual(putCall.body, {
      type: "CNAME",
      name: "blog",
      content: "new.example.com",
      ttl: 3600,
      proxied: false
    });

    const postCall = fetchCalls.find(c => c.method === "POST" && c.url.includes("/dns_records"));
    assert.ok(postCall);
    assert.ok(postCall.url.endsWith("/zones/zone-123/dns_records"));
    assert.deepStrictEqual(postCall.body, {
      type: "A",
      name: "api",
      content: "2.2.2.2",
      ttl: 3600,
      proxied: false
    });

    const deleteCall = fetchCalls.find(c => c.method === "DELETE");
    assert.ok(deleteCall);
    assert.ok(deleteCall.url.endsWith("/zones/zone-123/dns_records/rec-3"));
  });

  test("loads records from configuration file (YAML) successfully", async () => {
    mockResponses["GET /zones?name=file-example.com"] = {
      status: 200,
      body: {
        result: [{ id: "zone-555", name: "file-example.com" }]
      }
    };
    mockResponses["GET /zones/zone-555/dns_records?per_page=100"] = {
      status: 200,
      body: { result: [] }
    };
    mockResponses["POST /zones/zone-555/dns_records"] = {
      status: 200,
      body: { result: { id: "rec-new" } }
    };

    const tempYamlPath = path.resolve(process.cwd(), "temp-cf-records.yaml");
    const yamlContent = `
- name: mail
  type: MX
  value: mail.file-example.com
  priority: 5
- name: _sip._udp
  type: SRV
  value: sip.file-example.com
  port: 5061
  priority: 20
  weight: 20
- name: '@'
  type: CAA
  value: letsencrypt.org
  tag: issue
  flags: 0
`;
    fs.writeFileSync(tempYamlPath, yamlContent, "utf-8");

    try {
      const builder = new ZoneBuilder("file-example.com")
        .record("temp-cf-records.yaml");

      await builder.deploy();

      const mxPost = fetchCalls.find(c => c.method === "POST" && c.body?.type === "MX");
      assert.ok(mxPost);
      assert.deepStrictEqual(mxPost.body, {
        type: "MX",
        name: "mail",
        content: "mail.file-example.com",
        ttl: 3600,
        priority: 5
      });

      const srvPost = fetchCalls.find(c => c.method === "POST" && c.body?.type === "SRV");
      assert.ok(srvPost);
      assert.deepStrictEqual(srvPost.body, {
        type: "SRV",
        name: "_sip._udp",
        ttl: 3600,
        data: {
          priority: 20,
          weight: 20,
          port: 5061,
          target: "sip.file-example.com"
        }
      });

      const caaPost = fetchCalls.find(c => c.method === "POST" && c.body?.type === "CAA");
      assert.ok(caaPost);
      assert.deepStrictEqual(caaPost.body, {
        type: "CAA",
        name: "@",
        ttl: 3600,
        data: {
          flags: 0,
          tag: "issue",
          value: "letsencrypt.org"
        }
      });
    } finally {
      if (fs.existsSync(tempYamlPath)) fs.unlinkSync(tempYamlPath);
    }
  });

  test("destroys zone successfully if exists", async () => {
    mockResponses["GET /zones?name=example.com"] = {
      status: 200,
      body: {
        result: [
          { id: "zone-123", name: "example.com" }
        ]
      }
    };
    mockResponses["DELETE /zones/zone-123"] = {
      status: 200,
      body: {}
    };

    const builder = new ZoneBuilder("example.com");
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: "example.com" });
    const deleteCall = fetchCalls.find(c => c.method === "DELETE");
    assert.ok(deleteCall);
    assert.ok(deleteCall.url.endsWith("/zones/zone-123"));
  });
});
