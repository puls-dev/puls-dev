import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { KVBuilder } from "./kv.js";
import { Config } from "../../core/config.js";

describe("KVBuilder Unit Tests", () => {
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

  test("discovers namespace successfully if it already exists", async () => {
    mockResponses["GET /accounts/fake-cf-account/workers/namespaces?per_page=100"] = {
      status: 200,
      body: {
        result: [
          { id: "kv-123", title: "my-namespace" }
        ]
      }
    };

    const builder = new KVBuilder("my-namespace");
    const result = await builder.deploy();

    assert.strictEqual(result.id, "kv-123");
    assert.strictEqual(builder.resolvedId, "kv-123");
    
    // Deploying again shouldn't send post
    const deployAgainResult = await builder.deploy();
    assert.strictEqual(deployAgainResult.id, "kv-123");

    const posts = fetchCalls.filter(c => c.method === "POST");
    assert.strictEqual(posts.length, 0);
  });

  test("creates namespace if it does not exist", async () => {
    mockResponses["GET /accounts/fake-cf-account/workers/namespaces?per_page=100"] = {
      status: 200,
      body: { result: [] }
    };
    mockResponses["POST /accounts/fake-cf-account/workers/namespaces"] = {
      status: 200,
      body: { result: { id: "kv-created-456" } }
    };

    const builder = new KVBuilder("my-namespace");
    const result = await builder.deploy();

    assert.strictEqual(result.id, "kv-created-456");
    assert.strictEqual(builder.resolvedId, "kv-created-456");

    const postCall = fetchCalls.find(c => c.method === "POST");
    assert.ok(postCall);
    assert.deepStrictEqual(postCall.body, { title: "my-namespace" });
  });

  test("does not call fetch during dryRun deploy", async () => {
    Config.set({
      dryRun: true,
      providers: {
        cloudflare: { token: "fake-cf-token", accountId: "fake-cf-account" }
      }
    });

    mockResponses["GET /accounts/fake-cf-account/workers/namespaces?per_page=100"] = {
      status: 200,
      body: { result: [] }
    };

    const builder = new KVBuilder("my-namespace");
    const result = await builder.deploy();

    assert.strictEqual(result.id, "PENDING");
    const posts = fetchCalls.filter(c => c.method === "POST");
    assert.strictEqual(posts.length, 0);
  });

  test("destroys namespace successfully if exists", async () => {
    mockResponses["GET /accounts/fake-cf-account/workers/namespaces?per_page=100"] = {
      status: 200,
      body: {
        result: [
          { id: "kv-123", title: "my-namespace" }
        ]
      }
    };
    mockResponses["DELETE /accounts/fake-cf-account/workers/namespaces/kv-123"] = {
      status: 200,
      body: { success: true }
    };

    const builder = new KVBuilder("my-namespace");
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: "my-namespace" });
    const deleteCall = fetchCalls.find(c => c.method === "DELETE");
    assert.ok(deleteCall);
  });
});
