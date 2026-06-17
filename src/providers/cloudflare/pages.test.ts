import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { CloudflarePagesBuilder } from "./pages.js";
import { Config } from "../../core/config.js";

describe("CloudflarePagesBuilder Unit Tests", () => {
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
        text: async () => JSON.stringify({ errors: [{ message: "Not found" }] }),
      } as Response;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns null during discovery if project is not found", async () => {
    // mockResponses remains empty so fetch returns 404
    const builder = new CloudflarePagesBuilder("my-pages");
    const res = await (builder as any).discoveryPromise;

    assert.strictEqual(res, null);
    const getCall = fetchCalls.find(c => c.method === "GET" && c.url.includes("/pages/projects/my-pages"));
    assert.ok(getCall);
  });

  test("resolves project during discovery if found", async () => {
    mockResponses["GET /pages/projects/my-pages"] = {
      status: 200,
      body: {
        result: {
          name: "my-pages",
          subdomain: "my-pages.pages.dev",
          production_branch: "main",
        }
      }
    };

    const builder = new CloudflarePagesBuilder("my-pages");
    const res = await (builder as any).discoveryPromise;

    assert.ok(res);
    assert.strictEqual(res.name, "my-pages");
    assert.strictEqual(res.subdomain, "my-pages.pages.dev");
  });

  test("deploys new project and calls wrangler deploy", async () => {
    mockResponses["POST /pages/projects"] = {
      status: 200,
      body: {
        result: { name: "my-pages" }
      }
    };
    mockResponses["GET /pages/projects/my-pages/domains"] = {
      status: 200,
      body: { result: [] }
    };

    const builder = new CloudflarePagesBuilder("my-pages");
    builder.source("./dist").branch("prod");

    let wranglerCalled = false;
    let wranglerArgs: string[] = [];
    let wranglerEnv: any = {};
    (builder as any).spawnWrangler = async (args: string[], env: any) => {
      wranglerCalled = true;
      wranglerArgs = args;
      wranglerEnv = env;
    };

    const res = await builder.deploy();
    assert.strictEqual(res.projectName, "my-pages");
    assert.strictEqual(res.subdomain, "my-pages.pages.dev");

    // Project creation API called
    const createCall = fetchCalls.find(c => c.method === "POST" && c.url.includes("/pages/projects"));
    assert.ok(createCall);
    assert.strictEqual(createCall.body.name, "my-pages");
    assert.strictEqual(createCall.body.production_branch, "prod");

    // Wrangler spawned
    assert.ok(wranglerCalled);
    assert.deepStrictEqual(wranglerArgs, [
      "-y",
      "wrangler",
      "pages",
      "deploy",
      "./dist",
      "--project-name=my-pages",
      "--branch=prod"
    ]);
    assert.strictEqual(wranglerEnv.CLOUDFLARE_API_TOKEN, "fake-cf-token");
    assert.strictEqual(wranglerEnv.CLOUDFLARE_ACCOUNT_ID, "fake-cf-account");
  });

  test("reconciles custom domains correctly on deploy", async () => {
    mockResponses["GET /pages/projects/my-pages"] = {
      status: 200,
      body: {
        result: { name: "my-pages", subdomain: "my-pages.pages.dev" }
      }
    };
    mockResponses["GET /pages/projects/my-pages/domains"] = {
      status: 200,
      body: {
        result: [
          { name: "keep-me.com" },
          { name: "delete-me.com" }
        ]
      }
    };
    mockResponses["POST /pages/projects/my-pages/domains"] = {
      status: 200,
      body: { result: {} }
    };
    mockResponses["DELETE /pages/projects/my-pages/domains/delete-me.com"] = {
      status: 200,
      body: { result: {} }
    };

    const builder = new CloudflarePagesBuilder("my-pages");
    builder.source("./dist").domain(["keep-me.com", "add-me.com"]);

    (builder as any).spawnWrangler = async () => {};

    await builder.deploy();

    // Domain added
    const addCall = fetchCalls.find(c => c.method === "POST" && c.url.includes("/domains") && c.body?.name === "add-me.com");
    assert.ok(addCall);

    // Domain deleted
    const deleteCall = fetchCalls.find(c => c.method === "DELETE" && c.url.includes("/domains/delete-me.com"));
    assert.ok(deleteCall);

    // Kept domain not re-added
    const keepCall = fetchCalls.find(c => c.method === "POST" && c.url.includes("/domains") && c.body?.name === "keep-me.com");
    assert.strictEqual(keepCall, undefined);
  });

  test("destroys existing project", async () => {
    mockResponses["GET /pages/projects/my-pages"] = {
      status: 200,
      body: {
        result: { name: "my-pages" }
      }
    };
    mockResponses["DELETE /pages/projects/my-pages"] = {
      status: 200,
      body: { result: {} }
    };

    const builder = new CloudflarePagesBuilder("my-pages");
    const res = await builder.destroy();

    assert.deepStrictEqual(res, { destroyed: "my-pages" });
    const deleteCall = fetchCalls.find(c => c.method === "DELETE" && c.url.includes("/pages/projects/my-pages"));
    assert.ok(deleteCall);
  });
});
