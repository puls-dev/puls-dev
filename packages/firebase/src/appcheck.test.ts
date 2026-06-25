import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { GoogleAuth } from "google-auth-library";
import { FirebaseAppCheckBuilder } from "./appcheck.js";
import { Config } from "@puls-dev/core";

describe("FirebaseAppCheckBuilder Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        firebase: {
          projectId: "my-project",
          serviceAccountPath: "/fake/sa.json",
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
        getAccessToken: async () => ({ token: "fake-access-token" }),
      };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test("runs in dry-run mode safely and logs plans", async () => {
    Config.set({
      dryRun: true,
      providers: {
        firebase: {
          projectId: "my-project",
          serviceAccountPath: "/fake/sa.json",
        },
      },
    });

    const builder = new FirebaseAppCheckBuilder()
      .enforce("firestore")
      .unenforced("storage")
      .off("auth");

    const deployResult = await builder.deploy();
    assert.strictEqual(deployResult.project, "my-project");
    assert.strictEqual(fetchCalls.length, 0); // zero write calls
  });

  test("syncs App Check services idempotently - updates changed and skips identical", async () => {
    // 1. Mock GET calls returning existing statuses:
    // firestore is currently OFF (needs to be ENFORCED)
    // storage is currently UNENFORCED (needs to be UNENFORCED - should skip)
    mockResponses["GET /services/firestore.googleapis.com"] = {
      status: 200,
      body: { name: "projects/my-project/services/firestore.googleapis.com", enforcementMode: "OFF" },
    };
    mockResponses["GET /services/firebasestorage.googleapis.com"] = {
      status: 200,
      body: { name: "projects/my-project/services/firebasestorage.googleapis.com", enforcementMode: "UNENFORCED" },
    };

    // 2. Mock PATCH calls
    mockResponses["PATCH /services/firestore.googleapis.com"] = {
      status: 200,
      body: { name: "projects/my-project/services/firestore.googleapis.com", enforcementMode: "ENFORCED" },
    };

    const builder = new FirebaseAppCheckBuilder()
      .enforce("firestore")
      .unenforced("storage");

    const deployResult = await builder.deploy();
    assert.strictEqual(deployResult.project, "my-project");

    // We should have exactly 2 GET calls and 1 PATCH call
    const patchCalls = fetchCalls.filter((c) => c.method === "PATCH");
    assert.strictEqual(patchCalls.length, 1);
    assert.strictEqual(patchCalls[0].url.includes("/services/firestore.googleapis.com"), true);
    assert.strictEqual(patchCalls[0].body.enforcementMode, "ENFORCED");
  });

  test("destroys App Check configuration by reverting all configured services to OFF", async () => {
    // Mock PATCH calls returning OFF
    mockResponses["PATCH /services/firestore.googleapis.com"] = {
      status: 200,
      body: { name: "projects/my-project/services/firestore.googleapis.com", enforcementMode: "OFF" },
    };
    mockResponses["PATCH /services/firebasestorage.googleapis.com"] = {
      status: 200,
      body: { name: "projects/my-project/services/firebasestorage.googleapis.com", enforcementMode: "OFF" },
    };

    const builder = new FirebaseAppCheckBuilder()
      .enforce("firestore")
      .unenforced("storage");

    const destroyResult = await builder.destroy();
    assert.deepStrictEqual(destroyResult, { destroyed: "appcheck" });

    // Verify both services were patched to OFF
    const patchCalls = fetchCalls.filter((c) => c.method === "PATCH");
    assert.strictEqual(patchCalls.length, 2);
    assert.strictEqual(patchCalls.some((c) => c.url.includes("/services/firestore.googleapis.com") && c.body.enforcementMode === "OFF"), true);
    assert.strictEqual(patchCalls.some((c) => c.url.includes("/services/firebasestorage.googleapis.com") && c.body.enforcementMode === "OFF"), true);
  });
});
