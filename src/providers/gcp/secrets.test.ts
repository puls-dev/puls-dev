import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { GoogleAuth } from "google-auth-library";
import { GCPSecretBuilder, resolveGCPEnvVars } from "./secrets.js";
import { GCPCloudRunBuilder } from "./cloudrun.js";
import { Config } from "../../core/config.js";

describe("GCPSecretBuilder Unit Tests", () => {
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

  test("fluent builder api sets properties and resolves values correctly", async () => {
    mockResponses["GET /secrets/fluent-sec"] = {
      status: 200,
      body: { name: "projects/my-gcp-project/secrets/fluent-sec" },
    };
    mockResponses["GET /secrets/fluent-sec/versions/latest:access"] = {
      status: 200,
      body: { payload: { data: Buffer.from("super-secret-text").toString("base64") } },
    };

    const builder = new GCPSecretBuilder("fluent-sec")
      .plainText("super-secret-text");

    assert.strictEqual((builder as any)._value, "super-secret-text");

    const val = await builder.awaitValue();
    assert.strictEqual(val, "super-secret-text");
    assert.strictEqual(builder.resolvedValue, "super-secret-text");
  });

  test("keyValue helper serializes object correctly", () => {
    const builder = new GCPSecretBuilder("kv-sec")
      .keyValue({ apiKey: "12345", dbPass: "secret" });

    assert.strictEqual((builder as any)._value, JSON.stringify({ apiKey: "12345", dbPass: "secret" }));
  });

  test("runs in dry-run mode safely and logs plans", async () => {
    Config.set({
      dryRun: true,
      providers: {
        gcp: {
          projectId: "my-gcp-project",
          serviceAccountPath: "/fake/sa.json",
        },
      },
    });

    mockResponses["GET /secrets/dry-run-sec"] = {
      status: 404,
      body: { message: "Not found" },
    };

    const builder = new GCPSecretBuilder("dry-run-sec")
      .plainText("my-planned-value");

    const result = await builder.deploy();
    assert.strictEqual(result.name, "dry-run-sec");
    assert.strictEqual(result.value, "my-planned-value");

    // No write calls should be sent in dry-run mode
    const writeCalls = fetchCalls.filter((c) => c.method !== "GET");
    assert.strictEqual(writeCalls.length, 0);
  });

  test("creates a new secret when missing", async () => {
    // 1. Mock GET returned 404 (discovery metadata)
    mockResponses["GET /secrets/new-sec"] = {
      status: 404,
      body: { message: "Not found" },
    };

    // 2. Mock POST (create secret container)
    mockResponses["POST /secrets?secretId=new-sec"] = {
      status: 200,
      body: { name: "projects/my-gcp-project/secrets/new-sec" },
    };

    // 3. Mock POST (add version)
    mockResponses["POST /secrets/new-sec:addVersion"] = {
      status: 200,
      body: { name: "projects/my-gcp-project/secrets/new-sec/versions/1" },
    };

    const builder = new GCPSecretBuilder("new-sec")
      .plainText("my-new-secret-value");

    const result = await builder.deploy();
    assert.strictEqual(result.name, "new-sec");
    assert.strictEqual(result.value, "my-new-secret-value");
    assert.strictEqual(result.arn, "projects/my-gcp-project/secrets/new-sec");

    // Verify correct calls were made
    const postSecret = fetchCalls.find((c) => c.method === "POST" && c.url.includes("secretId=new-sec"));
    assert.ok(postSecret);

    const postVersion = fetchCalls.find((c) => c.method === "POST" && c.url.includes(":addVersion"));
    assert.ok(postVersion);
    const expectedBase64 = Buffer.from("my-new-secret-value").toString("base64");
    assert.strictEqual(postVersion.body.payload.data, expectedBase64);
  });

  test("updates an existing secret if value differs", async () => {
    // 1. Mock GET (discovery) returns existing secret
    mockResponses["GET /secrets/existing-sec"] = {
      status: 200,
      body: { name: "projects/my-gcp-project/secrets/existing-sec" },
    };

    // 2. Mock GET (access latest version) returns old value
    mockResponses["GET /secrets/existing-sec/versions/latest:access"] = {
      status: 200,
      body: { payload: { data: Buffer.from("old-value").toString("base64") } },
    };

    // 3. Mock POST (add version) for updated value
    mockResponses["POST /secrets/existing-sec:addVersion"] = {
      status: 200,
      body: { name: "projects/my-gcp-project/secrets/existing-sec/versions/2" },
    };

    const builder = new GCPSecretBuilder("existing-sec")
      .plainText("new-value"); // Value changed!

    const result = await builder.deploy();
    assert.strictEqual(result.name, "existing-sec");
    assert.strictEqual(result.value, "new-value");

    // Verify addVersion was called
    const postVersion = fetchCalls.filter((c) => c.method === "POST" && c.url.includes(":addVersion"));
    assert.strictEqual(postVersion.length, 1);
    assert.strictEqual(postVersion[0].body.payload.data, Buffer.from("new-value").toString("base64"));
  });

  test("skips updating secret if value is identical", async () => {
    // 1. Mock GET (discovery) returns existing secret
    mockResponses["GET /secrets/identical-sec"] = {
      status: 200,
      body: { name: "projects/my-gcp-project/secrets/identical-sec" },
    };

    // 2. Mock GET (access latest version) returns same value
    mockResponses["GET /secrets/identical-sec/versions/latest:access"] = {
      status: 200,
      body: { payload: { data: Buffer.from("same-value").toString("base64") } },
    };

    const builder = new GCPSecretBuilder("identical-sec")
      .plainText("same-value");

    const result = await builder.deploy();
    assert.strictEqual(result.name, "identical-sec");
    assert.strictEqual(result.value, "same-value");

    // Verify NO write calls (POST or DELETE) occurred
    const writeCalls = fetchCalls.filter((c) => c.method !== "GET");
    assert.strictEqual(writeCalls.length, 0);
  });

  test("destroys an existing secret successfully", async () => {
    // 1. Mock GET (discovery on destroy) returns existing secret
    mockResponses["GET /secrets/to-delete-sec"] = {
      status: 200,
      body: { name: "projects/my-gcp-project/secrets/to-delete-sec" },
    };

    // 2. Mock DELETE
    mockResponses["DELETE /secrets/to-delete-sec"] = {
      status: 200,
      body: {},
    };

    const builder = new GCPSecretBuilder("to-delete-sec");
    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: "to-delete-sec" });

    // Verify DELETE was called
    const deleteCalls = fetchCalls.filter((c) => c.method === "DELETE");
    assert.strictEqual(deleteCalls.length, 1);
    assert.strictEqual(deleteCalls[0].url.includes("/secrets/to-delete-sec"), true);
  });

  test("injects secret into Cloud Run microservice environment variables", async () => {
    // 1. Stateful mock for GET /secrets/db-pass: returns 404 then 200
    let secCallCount = 0;
    mockResponses["GET /secrets/db-pass"] = {
      get status() {
        secCallCount++;
        return secCallCount === 1 ? 404 : 200;
      },
      get body() {
        if (secCallCount === 1) return { message: "Not found" };
        return { name: "projects/my-gcp-project/secrets/db-pass" };
      },
    } as any;

    mockResponses["GET /secrets/db-pass/versions/latest:access"] = {
      status: 200,
      body: { payload: { data: Buffer.from("mypassword").toString("base64") } },
    };

    mockResponses["POST /secrets?secretId=db-pass"] = { status: 200, body: {} };
    mockResponses["POST /secrets/db-pass:addVersion"] = { status: 200, body: {} };

    // Cloud Run mocks
    mockResponses["GET /services/web-app"] = {
      status: 404,
      body: { message: "Not found" },
    };
    mockResponses["POST /services?serviceId=web-app"] = {
      status: 200,
      body: { name: "projects/my-gcp-project/locations/us-central1/services/web-app", uri: "https://web-app.run.app" },
    };
    mockResponses["POST /services/web-app:setIamPolicy"] = { status: 200, body: {} };

    const secret = new GCPSecretBuilder("db-pass").plainText("mypassword");
    const app = new GCPCloudRunBuilder("web-app")
      .image("gcr.io/my-proj/my-image:latest")
      .env({
        NODE_ENV: "production",
        DATABASE_PASSWORD: secret, // Wired directly!
      });

    // Deploy secret first, which populates the resolvedValue
    await secret.deploy();

    // Deploy Cloud Run app
    await app.deploy();

    // Verify Cloud Run creation request body resolved the secret variable
    const runPost = fetchCalls.find((c) => c.method === "POST" && c.url.includes("serviceId=web-app"));
    assert.ok(runPost);

    const envs = runPost.body.template.containers[0].env;
    const dbPassEnv = envs.find((e: any) => e.name === "DATABASE_PASSWORD");
    assert.ok(dbPassEnv);
    assert.strictEqual(dbPassEnv.value, "mypassword"); // Successfully resolved!
  });
});
