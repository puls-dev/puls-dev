import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { GoogleAuth } from "google-auth-library";
import { GCPCloudRunBuilder } from "./cloudrun.js";
import { Config } from "../../core/config.js";

describe("GCPCloudRunBuilder Unit Tests", () => {
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
          region: "us-east1",
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

  test("fluent builder api sets properties correctly", () => {
    const builder = new GCPCloudRunBuilder("my-service")
      .image("gcr.io/my-proj/my-image:v1")
      .port(3000)
      .cpu(2)
      .memory(1024)
      .minInstances(2)
      .maxInstances(20)
      .env({ DB_HOST: "localhost", PORT: "3000" })
      .region("europe-west1")
      .public(false);

    assert.strictEqual((builder as any)._image, "gcr.io/my-proj/my-image:v1");
    assert.strictEqual((builder as any)._port, 3000);
    assert.strictEqual((builder as any)._cpu, 2);
    assert.strictEqual((builder as any)._memory, 1024);
    assert.strictEqual((builder as any)._minInstances, 2);
    assert.strictEqual((builder as any)._maxInstances, 20);
    assert.deepStrictEqual((builder as any)._env, { DB_HOST: "localhost", PORT: "3000" });
    assert.strictEqual((builder as any)._region, "europe-west1");
    assert.strictEqual((builder as any)._public, false);
  });

  test("runs in dry-run mode safely and logs plans", async () => {
    Config.set({
      dryRun: true,
      providers: {
        gcp: {
          projectId: "my-gcp-project",
          serviceAccountPath: "/fake/sa.json",
          region: "us-central1",
        },
      },
    });

    const builder = new GCPCloudRunBuilder("dry-run-service")
      .image("gcr.io/my-proj/my-image:v1")
      .minInstances(1)
      .maxInstances(5);

    const result = await builder.deploy();
    assert.strictEqual(result.serviceId, "dry-run-service");
    assert.strictEqual(result.url, "https://dry-run-service-dryrun.a.run.app");
    const writeCalls = fetchCalls.filter((c) => c.method !== "GET");
    assert.strictEqual(writeCalls.length, 0); // No write requests in dry-run
  });

  test("creates a new service when it does not exist", async () => {
    // 1. Mock GET returning 404 (discovery)
    mockResponses["GET /services/new-service"] = {
      status: 404,
      body: { message: "Not found" },
    };

    // 2. Mock POST (create)
    mockResponses["POST /services?serviceId=new-service"] = {
      status: 201,
      body: {
        name: "projects/my-gcp-project/locations/us-east1/services/new-service",
        uri: "https://new-service-xyz.run.app",
      },
    };

    // 3. Mock POST (setIamPolicy)
    mockResponses["POST /services/new-service:setIamPolicy"] = {
      status: 200,
      body: {},
    };

    const builder = new GCPCloudRunBuilder("new-service")
      .image("gcr.io/my-proj/my-image:v1")
      .port(8080)
      .cpu("1")
      .memory("512Mi")
      .minInstances(0)
      .maxInstances(10)
      .public(true);

    const result = await builder.deploy();
    assert.strictEqual(result.serviceId, "new-service");
    assert.strictEqual(result.url, "https://new-service-xyz.run.app");

    // Assert fetch calls occurred
    const postCalls = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("serviceId="));
    assert.strictEqual(postCalls.length, 1);
    assert.deepStrictEqual(postCalls[0].body.template.containers[0].image, "gcr.io/my-proj/my-image:v1");

    const iamCalls = fetchCalls.filter((c) => c.method === "POST" && c.url.includes(":setIamPolicy"));
    assert.strictEqual(iamCalls.length, 1);
    assert.deepStrictEqual(iamCalls[0].body.policy.bindings[0].role, "roles/run.invoker");
    assert.deepStrictEqual(iamCalls[0].body.policy.bindings[0].members, ["allUsers"]);
  });

  test("updates an existing service if configuration differs", async () => {
    // 1. Mock GET returning existing service config with different image
    mockResponses["GET /services/existing-service"] = {
      status: 200,
      body: {
        name: "projects/my-gcp-project/locations/us-east1/services/existing-service",
        uri: "https://existing-service-xyz.run.app",
        template: {
          containers: [
            {
              image: "gcr.io/my-proj/old-image:v1",
              ports: [{ containerPort: 8080 }],
              resources: { limits: { cpu: "1", memory: "512Mi" } },
            },
          ],
          scaling: { minInstanceCount: 0, maxInstanceCount: 10 },
        },
        ingress: "INGRESS_TRAFFIC_ALL",
      },
    };

    // 2. Mock PATCH (update)
    mockResponses["PATCH /services/existing-service"] = {
      status: 200,
      body: {
        name: "projects/my-gcp-project/locations/us-east1/services/existing-service",
        uri: "https://existing-service-xyz.run.app",
      },
    };

    // 3. Mock POST (setIamPolicy)
    mockResponses["POST /services/existing-service:setIamPolicy"] = {
      status: 200,
      body: {},
    };

    const builder = new GCPCloudRunBuilder("existing-service")
      .image("gcr.io/my-proj/new-image:v1") // Image changed!
      .minInstances(0)
      .maxInstances(10)
      .public(true);

    const result = await builder.deploy();
    assert.strictEqual(result.serviceId, "existing-service");
    assert.strictEqual(result.url, "https://existing-service-xyz.run.app");

    // Verify PATCH was called
    const patchCalls = fetchCalls.filter((c) => c.method === "PATCH");
    assert.strictEqual(patchCalls.length, 1);
    assert.deepStrictEqual(patchCalls[0].body.template.containers[0].image, "gcr.io/my-proj/new-image:v1");

    const iamCalls = fetchCalls.filter((c) => c.method === "POST" && c.url.includes(":setIamPolicy"));
    assert.strictEqual(iamCalls.length, 1);
  });

  test("skips updating an existing service if configuration is identical", async () => {
    // 1. Mock GET returning exact same config
    mockResponses["GET /services/identical-service"] = {
      status: 200,
      body: {
        name: "projects/my-gcp-project/locations/us-east1/services/identical-service",
        uri: "https://identical-service-xyz.run.app",
        template: {
          containers: [
            {
              image: "gcr.io/my-proj/image:v1",
              ports: [{ containerPort: 8080 }],
              resources: { limits: { cpu: "1", memory: "512Mi" } },
              env: [{ name: "NODE_ENV", value: "production" }],
            },
          ],
          scaling: { minInstanceCount: 0, maxInstanceCount: 10 },
        },
        ingress: "INGRESS_TRAFFIC_ALL",
      },
    };

    // 2. Mock POST (setIamPolicy)
    mockResponses["POST /services/identical-service:setIamPolicy"] = {
      status: 200,
      body: {},
    };

    const builder = new GCPCloudRunBuilder("identical-service")
      .image("gcr.io/my-proj/image:v1")
      .port(8080)
      .cpu("1")
      .memory("512Mi")
      .minInstances(0)
      .maxInstances(10)
      .env({ NODE_ENV: "production" })
      .public(true);

    const result = await builder.deploy();
    assert.strictEqual(result.serviceId, "identical-service");
    assert.strictEqual(result.url, "https://identical-service-xyz.run.app");

    // Verify PATCH or POST for services was NOT called
    const writeCalls = fetchCalls.filter((c) => (c.method === "PATCH" || (c.method === "POST" && c.url.includes("serviceId="))));
    assert.strictEqual(writeCalls.length, 0);

    // Verify setIamPolicy was still called
    const iamCalls = fetchCalls.filter((c) => c.method === "POST" && c.url.includes(":setIamPolicy"));
    assert.strictEqual(iamCalls.length, 1);
  });

  test("destroys an existing service", async () => {
    // 1. Mock GET returning existing service config (discovery on destroy)
    mockResponses["GET /services/to-delete"] = {
      status: 200,
      body: { name: "projects/my-gcp-project/locations/us-east1/services/to-delete" },
    };

    // 2. Mock DELETE
    mockResponses["DELETE /services/to-delete"] = {
      status: 200,
      body: {},
    };

    const builder = new GCPCloudRunBuilder("to-delete");
    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: "to-delete" });

    // Verify DELETE was called
    const deleteCalls = fetchCalls.filter((c) => c.method === "DELETE");
    assert.strictEqual(deleteCalls.length, 1);
    assert.strictEqual(deleteCalls[0].url.includes("/services/to-delete"), true);
  });

  test("destroy does nothing when service does not exist", async () => {
    // 1. Mock GET returning 404
    mockResponses["GET /services/not-exist"] = {
      status: 404,
      body: { message: "Not found" },
    };

    const builder = new GCPCloudRunBuilder("not-exist");
    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: "not-exist" });

    // Verify DELETE was NOT called
    const deleteCalls = fetchCalls.filter((c) => c.method === "DELETE");
    assert.strictEqual(deleteCalls.length, 0);
  });
});
