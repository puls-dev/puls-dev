import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { WorkerBuilder } from "./worker.js";
import { KVBuilder } from "./kv.js";
import { R2Builder } from "./r2.js";
import { Config } from "@puls-dev/core";

describe("WorkerBuilder Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};
  const tempScriptPath = path.resolve(process.cwd(), "temp-worker.js");

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

    fs.writeFileSync(tempScriptPath, "export default { fetch() { return new Response('hello'); } };", "utf8");

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      let body: any;
      if (init?.body) {
        if (init.body instanceof FormData) {
          body = init.body;
        } else if (typeof init.body === "string") {
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
    if (fs.existsSync(tempScriptPath)) {
      fs.unlinkSync(tempScriptPath);
    }
  });

  test("throws if script path is not configured", async () => {
    const builder = new WorkerBuilder("my-worker");
    await assert.rejects(async () => {
      await builder.deploy();
    }, /Worker script path is not configured/);
  });

  test("deploys worker script with bindings and reconciles routes", async () => {
    // KV namespace mock response for builder dependency discovery
    mockResponses["GET /accounts/fake-cf-account/workers/namespaces?per_page=100"] = {
      status: 200,
      body: {
        result: [{ id: "kv-id-999", title: "my-kv" }]
      }
    };

    // R2 mock response for discovery
    mockResponses["GET /accounts/fake-cf-account/r2/buckets"] = {
      status: 200,
      body: {
        result: { buckets: [{ name: "my-bucket" }] }
      }
    };

    // Worker upload mock response
    mockResponses["PUT /accounts/fake-cf-account/workers/scripts/my-worker"] = {
      status: 200,
      body: { result: { id: "my-worker" } }
    };

    // Route resolution: zone matching
    mockResponses["GET /zones?name=api.example.com"] = {
      status: 200,
      body: { result: [] }
    };
    mockResponses["GET /zones?name=example.com"] = {
      status: 200,
      body: { result: [{ id: "zone-123", name: "example.com" }] }
    };

    // Get routes mock response (1 existing route to update, 1 new route to create)
    mockResponses["GET /zones/zone-123/workers/routes"] = {
      status: 200,
      body: {
        result: [
          { id: "route-existing", pattern: "api.example.com/*", script: "old-worker" }
        ]
      }
    };

    mockResponses["PUT /zones/zone-123/workers/routes/route-existing"] = {
      status: 200,
      body: { result: { id: "route-existing" } }
    };

    mockResponses["POST /zones/zone-123/workers/routes"] = {
      status: 200,
      body: { result: { id: "route-new" } }
    };

    const kv = new KVBuilder("my-kv");
    const r2 = new R2Builder("my-bucket");

    // Initialize/deploy dependencies first
    await kv.deploy();
    await r2.deploy();

    const worker = new WorkerBuilder("my-worker")
      .script(tempScriptPath)
      .kv("MY_KV", kv)
      .r2("MY_BUCKET", r2)
      .env("ENV_VAR", "my-env-value")
      .route("api.example.com/*")
      .route("example.com/*");

    const result = await worker.deploy();

    assert.strictEqual(result.scriptName, "my-worker");
    assert.deepStrictEqual(result.routes, ["api.example.com/*", "example.com/*"]);

    // Verify multipart request body contains metadata with bindings
    const uploadCall = fetchCalls.find(c => c.method === "PUT" && c.url.endsWith("/workers/scripts/my-worker"));
    assert.ok(uploadCall);
    assert.ok(uploadCall.body instanceof FormData);
    const metadataStr = uploadCall.body.get("metadata");
    assert.ok(typeof metadataStr === "string");
    const metadata = JSON.parse(metadataStr);
    assert.deepStrictEqual(metadata, {
      main_module: "index.js",
      bindings: [
        { type: "kv_namespace", name: "MY_KV", namespace_id: "kv-id-999" },
        { type: "r2_bucket", name: "MY_BUCKET", bucket_name: "my-bucket" },
        { type: "plain_text", name: "ENV_VAR", text: "my-env-value" }
      ]
    });

    // Verify route updates & creations
    const putRouteCall = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/workers/routes/"));
    assert.ok(putRouteCall);
    assert.ok(putRouteCall.url.endsWith("/zones/zone-123/workers/routes/route-existing"));
    assert.deepStrictEqual(putRouteCall.body, {
      pattern: "api.example.com/*",
      script: "my-worker"
    });

    const postRouteCall = fetchCalls.find(c => c.method === "POST" && c.url.endsWith("/zones/zone-123/workers/routes"));
    assert.ok(postRouteCall);
    assert.deepStrictEqual(postRouteCall.body, {
      pattern: "example.com/*",
      script: "my-worker"
    });
  });

  test("does not call fetch during dryRun deploy", async () => {
    Config.set({
      dryRun: true,
      providers: {
        cloudflare: { token: "fake-cf-token", accountId: "fake-cf-account" }
      }
    });

    const worker = new WorkerBuilder("my-worker")
      .script(tempScriptPath)
      .route("example.com/*");

    const result = await worker.deploy();

    assert.strictEqual(result.scriptName, "my-worker");
    const puts = fetchCalls.filter(c => c.method === "PUT");
    assert.strictEqual(puts.length, 0);
  });

  test("destroys routes and script successfully", async () => {
    // Mock zone resolution for route cleanup
    mockResponses["GET /zones?name=example.com"] = {
      status: 200,
      body: { result: [{ id: "zone-123", name: "example.com" }] }
    };
    mockResponses["GET /zones/zone-123/workers/routes"] = {
      status: 200,
      body: {
        result: [
          { id: "route-existing", pattern: "example.com/*", script: "my-worker" }
        ]
      }
    };
    mockResponses["DELETE /zones/zone-123/workers/routes/route-existing"] = {
      status: 200,
      body: {}
    };
    mockResponses["DELETE /accounts/fake-cf-account/workers/scripts/my-worker"] = {
      status: 200,
      body: {}
    };

    const worker = new WorkerBuilder("my-worker")
      .script(tempScriptPath)
      .route("example.com/*");

    const result = await worker.destroy();

    assert.deepStrictEqual(result, { destroyed: "my-worker" });

    const deleteRouteCall = fetchCalls.find(c => c.method === "DELETE" && c.url.includes("/workers/routes/"));
    assert.ok(deleteRouteCall);
    assert.ok(deleteRouteCall.url.endsWith("/zones/zone-123/workers/routes/route-existing"));

    const deleteScriptCall = fetchCalls.find(c => c.method === "DELETE" && c.url.includes("/workers/scripts/"));
    assert.ok(deleteScriptCall);
    assert.ok(deleteScriptCall.url.endsWith("/accounts/fake-cf-account/workers/scripts/my-worker"));
  });
});
