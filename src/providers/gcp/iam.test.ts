import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { GoogleAuth } from "google-auth-library";
import { GCPServiceAccountBuilder, GCPIAMBindingBuilder } from "./iam.js";
import { Config } from "../../core/config.js";
import { Output } from "../../core/output.js";

describe("GCP IAM Builders Unit Tests", () => {
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
        json: async () => ({ error: { message: `Endpoint not mocked: ${method} ${url}` } }),
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

  describe("GCPServiceAccountBuilder Tests", () => {
    test("generates email address correctly", () => {
      const builder = new GCPServiceAccountBuilder("custom-sa");
      assert.strictEqual(builder.email, "custom-sa@my-gcp-project.iam.gserviceaccount.com");
    });

    test("runs in dry-run mode safely without making API calls", async () => {
      Config.set({
        dryRun: true,
        providers: {
          gcp: {
            projectId: "my-gcp-project",
            serviceAccountPath: "/fake/sa.json",
          },
        },
      });

      mockResponses["GET /serviceAccounts/custom-sa@my-gcp-project.iam.gserviceaccount.com"] = {
        status: 404,
        body: {},
      };

      const builder = new GCPServiceAccountBuilder("custom-sa")
        .displayName("Custom Display Name")
        .description("Custom Description");

      const result = await builder.deploy();
      assert.strictEqual(result.email, "custom-sa@my-gcp-project.iam.gserviceaccount.com");

      const writeCalls = fetchCalls.filter((c) => c.method !== "GET");
      assert.strictEqual(writeCalls.length, 0);
    });

    test("creates service account when missing", async () => {
      mockResponses["GET /serviceAccounts/custom-sa@my-gcp-project.iam.gserviceaccount.com"] = {
        status: 404,
        body: {},
      };

      mockResponses["POST /serviceAccounts"] = {
        status: 200,
        body: { name: "projects/my-gcp-project/serviceAccounts/custom-sa@my-gcp-project.iam.gserviceaccount.com" },
      };

      const builder = new GCPServiceAccountBuilder("custom-sa")
        .displayName("My Custom Display")
        .description("My Custom Description");

      const result = await builder.deploy();
      assert.strictEqual(result.email, "custom-sa@my-gcp-project.iam.gserviceaccount.com");

      // Verify POST call
      const createCall = fetchCalls.find((c) => c.method === "POST" && c.url.includes("/serviceAccounts"));
      assert.ok(createCall);
      assert.strictEqual(createCall.body.accountId, "custom-sa");
      assert.strictEqual(createCall.body.serviceAccount.displayName, "My Custom Display");
      assert.strictEqual(createCall.body.serviceAccount.description, "My Custom Description");
    });

    test("patches existing service account if metadata differs", async () => {
      mockResponses["GET /serviceAccounts/custom-sa@my-gcp-project.iam.gserviceaccount.com"] = {
        status: 200,
        body: {
          displayName: "Old Display",
          description: "Old Desc",
        },
      };

      mockResponses["PATCH /serviceAccounts/custom-sa@my-gcp-project.iam.gserviceaccount.com"] = {
        status: 200,
        body: {},
      };

      const builder = new GCPServiceAccountBuilder("custom-sa")
        .displayName("New Display")
        .description("New Desc");

      await builder.deploy();

      const patchCall = fetchCalls.find((c) => c.method === "PATCH");
      assert.ok(patchCall);
      assert.strictEqual(patchCall.body.displayName, "New Display");
      assert.strictEqual(patchCall.body.description, "New Desc");
    });

    test("skips patch if existing service account metadata is identical", async () => {
      mockResponses["GET /serviceAccounts/custom-sa@my-gcp-project.iam.gserviceaccount.com"] = {
        status: 200,
        body: {
          displayName: "Same Display",
          description: "Same Desc",
        },
      };

      const builder = new GCPServiceAccountBuilder("custom-sa")
        .displayName("Same Display")
        .description("Same Desc");

      await builder.deploy();

      const writeCalls = fetchCalls.filter((c) => c.method !== "GET");
      assert.strictEqual(writeCalls.length, 0);
    });

    test("destroys service account successfully", async () => {
      mockResponses["GET /serviceAccounts/custom-sa@my-gcp-project.iam.gserviceaccount.com"] = {
        status: 200,
        body: {},
      };

      mockResponses["DELETE /serviceAccounts/custom-sa@my-gcp-project.iam.gserviceaccount.com"] = {
        status: 200,
        body: {},
      };

      const builder = new GCPServiceAccountBuilder("custom-sa");
      const result = await builder.destroy();
      assert.deepStrictEqual(result, { destroyed: "custom-sa" });

      const deleteCall = fetchCalls.find((c) => c.method === "DELETE");
      assert.ok(deleteCall);
    });
  });

  describe("GCPIAMBindingBuilder Tests", () => {
    test("resolves member strings, builders, outputs and custom types correctly", async () => {
      const saBuilder = new GCPServiceAccountBuilder("builder-sa");

      const plainString = "user:bob@gmail.com";
      const plainSaEmail = "test-sa@my-gcp-project.iam.gserviceaccount.com";
      const plainSaId = "other-sa"; // auto-resolves to serviceAccount:other-sa@proj...

      const outputEmail = new Output<string>();
      outputEmail.resolve("output-sa"); // auto-resolves to serviceAccount:output-sa

      const binding = new GCPIAMBindingBuilder("test-binding")
        .role("roles/viewer")
        .members(plainString, saBuilder, plainSaEmail, plainSaId, outputEmail);

      const resolved = await (binding as any).resolveMembers();

      assert.deepStrictEqual(resolved, [
        "user:bob@gmail.com",
        "serviceAccount:builder-sa@my-gcp-project.iam.gserviceaccount.com",
        "serviceAccount:test-sa@my-gcp-project.iam.gserviceaccount.com",
        "serviceAccount:other-sa@my-gcp-project.iam.gserviceaccount.com",
        "serviceAccount:output-sa",
      ]);
    });

    test("appends bound members non-destructively to an existing role binding", async () => {
      // 1. Mock getIamPolicy returns existing policy
      mockResponses["POST /projects/my-gcp-project:getIamPolicy"] = {
        status: 200,
        body: {
          etag: "version1",
          bindings: [
            {
              role: "roles/storage.objectViewer",
              members: ["user:alice@example.com"],
            },
          ],
        },
      };

      // 2. Mock setIamPolicy
      mockResponses["POST /projects/my-gcp-project:setIamPolicy"] = {
        status: 200,
        body: {},
      };

      const binding = new GCPIAMBindingBuilder("viewer-binding")
        .role("roles/storage.objectViewer")
        .member("user:bob@example.com");

      await binding.deploy();

      const setCall = fetchCalls.find((c) => c.method === "POST" && c.url.includes(":setIamPolicy"));
      assert.ok(setCall);
      assert.strictEqual(setCall.body.policy.etag, "version1"); // Etag lock!

      const targetBinding = setCall.body.policy.bindings.find((b: any) => b.role === "roles/storage.objectViewer");
      assert.ok(targetBinding);
      // Non-destructive: both Alice and Bob are bound!
      assert.deepStrictEqual(targetBinding.members, ["user:alice@example.com", "user:bob@example.com"]);
    });

    test("skips deploy if all members are already bound", async () => {
      mockResponses["POST /projects/my-gcp-project:getIamPolicy"] = {
        status: 200,
        body: {
          etag: "version1",
          bindings: [
            {
              role: "roles/storage.objectViewer",
              members: ["user:alice@example.com", "user:bob@example.com"],
            },
          ],
        },
      };

      const binding = new GCPIAMBindingBuilder("viewer-binding")
        .role("roles/storage.objectViewer")
        .members("user:alice@example.com", "user:bob@example.com");

      await binding.deploy();

      // No setIamPolicy should be called
      const setCall = fetchCalls.find((c) => c.method === "POST" && c.url.includes(":setIamPolicy"));
      assert.strictEqual(setCall, undefined);
    });

    test("destroys binding cleanly by removing only our declared members", async () => {
      mockResponses["POST /projects/my-gcp-project:getIamPolicy"] = {
        status: 200,
        body: {
          etag: "version2",
          bindings: [
            {
              role: "roles/storage.admin",
              members: ["user:admin@company.com", "serviceAccount:to-prune@my-gcp-project.iam.gserviceaccount.com"],
            },
          ],
        },
      };

      mockResponses["POST /projects/my-gcp-project:setIamPolicy"] = {
        status: 200,
        body: {},
      };

      const binding = new GCPIAMBindingBuilder("admin-binding")
        .role("roles/storage.admin")
        .member("to-prune"); // maps to serviceAccount:to-prune@my-gcp-project...

      const result = await binding.destroy();
      assert.deepStrictEqual(result, { destroyed: "admin-binding" });

      const setCall = fetchCalls.find((c) => c.method === "POST" && c.url.includes(":setIamPolicy"));
      assert.ok(setCall);

      const targetBinding = setCall.body.policy.bindings.find((b: any) => b.role === "roles/storage.admin");
      assert.ok(targetBinding);
      // Pruned our member, left the other admin!
      assert.deepStrictEqual(targetBinding.members, ["user:admin@company.com"]);
    });

    test("removes the entire role binding block if no members remain", async () => {
      mockResponses["POST /projects/my-gcp-project:getIamPolicy"] = {
        status: 200,
        body: {
          etag: "version3",
          bindings: [
            {
              role: "roles/pubsub.publisher",
              members: ["serviceAccount:to-prune@my-gcp-project.iam.gserviceaccount.com"],
            },
          ],
        },
      };

      mockResponses["POST /projects/my-gcp-project:setIamPolicy"] = {
        status: 200,
        body: {},
      };

      const binding = new GCPIAMBindingBuilder("pub-binding")
        .role("roles/pubsub.publisher")
        .member("to-prune");

      await binding.destroy();

      const setCall = fetchCalls.find((c) => c.method === "POST" && c.url.includes(":setIamPolicy"));
      assert.ok(setCall);

      // Entire block is deleted since no members remain
      const targetBinding = setCall.body.policy.bindings.find((b: any) => b.role === "roles/pubsub.publisher");
      assert.strictEqual(targetBinding, undefined);
    });
  });
});
