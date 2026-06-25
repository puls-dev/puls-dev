import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { AppPlatformBuilder } from "./app.js";
import { Config } from "@puls-dev/core";

describe("AppPlatformBuilder Unit Tests", () => {
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

  test("gracefully handles discovery when App does not exist", async () => {
    mockResponses["GET /apps"] = {
      status: 200,
      body: { apps: [] },
    };

    const builder = new AppPlatformBuilder("my-app");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].method, "GET");
    assert.ok(fetchCalls[0].url.includes("/apps"));
  });

  test("discovers App successfully when it exists", async () => {
    mockResponses["GET /apps"] = {
      status: 200,
      body: {
        apps: [
          {
            id: "app-123",
            spec: { name: "my-app" },
            live_url: "https://my-app.ondigitalocean.app",
          },
        ],
      },
    };

    const builder = new AppPlatformBuilder("my-app");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.id, "app-123");

    const id = await builder.out.id.get();
    const liveUrl = await builder.out.liveUrl.get();
    assert.strictEqual(id, "app-123");
    assert.strictEqual(liveUrl, "https://my-app.ondigitalocean.app");
  });

  test("performs clean dry-run planning without making write requests", async () => {
    Config.set({
      dryRun: true,
      providers: { do: { token: "fake-token" } },
    });

    mockResponses["GET /apps"] = {
      status: 200,
      body: { apps: [] },
    };

    const builder = new AppPlatformBuilder("my-dry-app")
      .spec({
        region: "nyc",
        services: [
          {
            name: "web",
            instance_size_slug: "apps-s-1vcpu-1gb",
          },
        ],
      });

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, "my-dry-app");
    assert.strictEqual(result.id, "PENDING");

    // Discover should run, but no creations/updates
    const writeCalls = fetchCalls.filter((c) => c.method !== "GET");
    assert.strictEqual(writeCalls.length, 0);

    const liveUrl = await builder.out.liveUrl.get();
    assert.strictEqual(liveUrl, "https://my-dry-app.ondigitalocean.app");
  });

  test("deploys new App and awaits status: active with live url", async () => {
    mockResponses["GET /apps"] = {
      status: 200,
      body: { apps: [] },
    };
    mockResponses["POST /apps"] = {
      status: 202,
      body: { app: { id: "new-app-id", live_url: "" } },
    };

    let pollCount = 0;
    mockResponses["GET /apps/new-app-id"] = {
      status: 200,
      get body() {
        pollCount++;
        if (pollCount === 1) {
          return { app: { id: "new-app-id", live_url: "" } };
        }
        return {
          app: {
            id: "new-app-id",
            live_url: "https://new-app.ondigitalocean.app",
          },
        };
      },
    };

    const builder = new AppPlatformBuilder("my-new-app")
      .spec({
        region: "nyc",
        services: [
          {
            name: "api",
            github: { repo: "user/repo", branch: "main" },
          },
        ],
      });

    // Instantly check status
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      let done = false;
      while (!done) {
        done = await condition();
      }
    };

    const result = await builder.deploy();
    assert.ok(result);
    assert.strictEqual(result.id, "new-app-id");
    assert.strictEqual(result.liveUrl, "https://new-app.ondigitalocean.app");

    const liveUrl = await builder.out.liveUrl.get();
    assert.strictEqual(liveUrl, "https://new-app.ondigitalocean.app");

    const postCall = fetchCalls.find((c) => c.method === "POST" && c.url.includes("/apps"));
    assert.ok(postCall);
    assert.deepStrictEqual(postCall.body, {
      spec: {
        name: "my-new-app",
        region: "nyc",
        services: [
          {
            name: "api",
            github: { repo: "user/repo", branch: "main" },
          },
        ],
      },
    });
  });

  test("updates spec on existing app if configuration differs", async () => {
    mockResponses["GET /apps"] = {
      status: 200,
      body: {
        apps: [
          {
            id: "app-existing-id",
            spec: {
              name: "my-existing-app",
              region: "nyc",
            },
            live_url: "https://my-existing-app.ondigitalocean.app",
          },
        ],
      },
    };

    mockResponses["PUT /apps/app-existing-id"] = {
      status: 200,
      body: {
        app: {
          id: "app-existing-id",
          spec: {
            name: "my-existing-app",
            region: "ams",
          },
          live_url: "https://my-existing-app.ondigitalocean.app",
        },
      },
    };

    const builder = new AppPlatformBuilder("my-existing-app")
      .spec({
        region: "ams", // differs from existing "nyc"
      });

    const result = await builder.deploy();
    assert.ok(result);

    const putCall = fetchCalls.find((c) => c.method === "PUT" && c.url.includes("/apps/app-existing-id"));
    assert.ok(putCall);
    assert.deepStrictEqual(putCall.body, {
      spec: {
        name: "my-existing-app",
        region: "ams",
      },
    });
  });

  test("skips deploy on existing app if spec matches exactly", async () => {
    mockResponses["GET /apps"] = {
      status: 200,
      body: {
        apps: [
          {
            id: "app-existing-id",
            spec: {
              name: "my-existing-app",
              region: "nyc",
            },
            live_url: "https://my-existing-app.ondigitalocean.app",
          },
        ],
      },
    };

    const builder = new AppPlatformBuilder("my-existing-app")
      .spec({
        region: "nyc", // matches exactly
      });

    const result = await builder.deploy();
    assert.ok(result);

    // Verify no PUT writes
    const putCall = fetchCalls.find((c) => c.method === "PUT");
    assert.ok(!putCall);
  });

  test("destroys App successfully", async () => {
    mockResponses["GET /apps"] = {
      status: 200,
      body: {
        apps: [
          { id: "app-123", spec: { name: "my-app-del" } },
        ],
      },
    };
    mockResponses["DELETE /apps/app-123"] = {
      status: 204,
      body: {},
    };

    const builder = new AppPlatformBuilder("my-app-del");
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: "my-app-del" });

    const deleteCall = fetchCalls.find((c) => c.method === "DELETE");
    assert.ok(deleteCall);
    assert.ok(deleteCall.url.endsWith("/apps/app-123"));
  });
});
