import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { R2Builder } from "./r2.js";
import { Config } from "@puls-dev/core";

describe("R2Builder Unit Tests", () => {
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

  test("discovers bucket successfully if it already exists", async () => {
    mockResponses["GET /accounts/fake-cf-account/r2/buckets"] = {
      status: 200,
      body: {
        result: {
          buckets: [
            { name: "my-bucket" }
          ]
        }
      }
    };

    const builder = new R2Builder("my-bucket");
    const result = await builder.deploy();

    assert.deepStrictEqual(result, { bucket: "my-bucket" });

    const puts = fetchCalls.filter(c => c.method === "PUT");
    assert.strictEqual(puts.length, 0);
  });

  test("creates bucket if it does not exist", async () => {
    mockResponses["GET /accounts/fake-cf-account/r2/buckets"] = {
      status: 200,
      body: { result: { buckets: [] } }
    };
    mockResponses["PUT /accounts/fake-cf-account/r2/buckets/my-bucket"] = {
      status: 200,
      body: {}
    };

    const builder = new R2Builder("my-bucket");
    const result = await builder.deploy();

    assert.deepStrictEqual(result, { bucket: "my-bucket" });

    const putCall = fetchCalls.find(c => c.method === "PUT");
    assert.ok(putCall);
  });

  test("does not call fetch during dryRun deploy", async () => {
    Config.set({
      dryRun: true,
      providers: {
        cloudflare: { token: "fake-cf-token", accountId: "fake-cf-account" }
      }
    });

    mockResponses["GET /accounts/fake-cf-account/r2/buckets"] = {
      status: 200,
      body: { result: { buckets: [] } }
    };

    const builder = new R2Builder("my-bucket");
    const result = await builder.deploy();

    assert.deepStrictEqual(result, { bucket: "my-bucket" });
    const puts = fetchCalls.filter(c => c.method === "PUT");
    assert.strictEqual(puts.length, 0);
  });

  test("destroys bucket successfully if exists", async () => {
    mockResponses["GET /accounts/fake-cf-account/r2/buckets"] = {
      status: 200,
      body: {
        result: {
          buckets: [
            { name: "my-bucket" }
          ]
        }
      }
    };
    mockResponses["DELETE /accounts/fake-cf-account/r2/buckets/my-bucket"] = {
      status: 200,
      body: {}
    };

    const builder = new R2Builder("my-bucket");
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: "my-bucket" });
    const deleteCall = fetchCalls.find(c => c.method === "DELETE");
    assert.ok(deleteCall);
  });
});
