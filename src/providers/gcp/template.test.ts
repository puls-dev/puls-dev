import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { GCPTemplateBuilder } from "./template.js";
import { GCPVMBuilder } from "./vm.js";
import { Config } from "../../core/config.js";
import { getFileHash } from "../proxmox/hash.js";
import { Stack } from "../../core/stack.js";

describe("GCPTemplateBuilder Unit Tests", () => {
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

    mock.method(fs, "readFileSync", () => {
      return "ssh-rsa AAAA_FAKE_GCP_PUBLIC_KEY test@gcp.com";
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test("gracefully handles discovery when Template does not exist", async () => {
    mockResponses["GET /global/images/my-golden-image"] = {
      status: 404,
      body: { error: { message: "Not Found" } },
    };

    const builder = new GCPTemplateBuilder("my-golden-image");
    const existing = await (builder as any).discoveryPromise;
    assert.strictEqual(existing, null);
  });

  test("discovers existing Template and skips deployment if hashes match (Idempotence)", async () => {
    const nginxHash = getFileHash("playbooks/nginx.yaml");
    mockResponses["GET /global/images/my-docker-base"] = {
      status: 200,
      body: {
        name: "my-docker-base",
        status: "READY",
        description: `nginx-yaml=${nginxHash}`,
      },
    };

    const builder = new GCPTemplateBuilder("my-docker-base")
      .provision("playbooks/nginx.yaml");

    const result = await builder.deploy();
    assert.strictEqual(result.imageId, "projects/my-gcp-project/global/images/my-docker-base");

    // No POST/DELETE calls since it already matches
    const writes = fetchCalls.filter(c => c.method === "POST" || c.method === "DELETE");
    assert.strictEqual(writes.length, 0);
  });

  test("purges and rebuilds template if playbooks differ", async () => {
    // 1. Initial image discovery finds outdated hash
    mockResponses["GET /global/images/my-docker-base"] = {
      status: 200,
      body: {
        name: "my-docker-base",
        status: "READY",
        description: "nginx-yaml=outdated-hash",
      },
    };

    // 2. Temp instance discovery transition: first 404, then RUNNING, then stopped (TERMINATED), then 404 after delete
    let tempQueryCount = 0;
    mockResponses["GET /instances/puls-bake-temp-my-docker-base"] = {
      status: 200,
      get body() {
        tempQueryCount++;
        if (tempQueryCount === 1) {
          return {
            name: "puls-bake-temp-my-docker-base",
            status: "RUNNING",
            networkInterfaces: [
              {
                accessConfigs: [{ natIP: "35.200.12.34" }],
              },
            ],
          };
        }
        return {
          name: "puls-bake-temp-my-docker-base",
          status: "TERMINATED",
        };
      },
    };

    // 3. Mock image ready after bake
    mockResponses["GET /global/images/my-docker-base"] = {
      status: 200,
      body: {
        name: "my-docker-base",
        status: "READY",
      },
    };

    // 4. Operations and deletes
    mockResponses["DELETE /global/images/my-docker-base"] = { status: 200, body: {} };
    mockResponses["POST /instances"] = { status: 200, body: {} };
    mockResponses["POST /instances/puls-bake-temp-my-docker-base/stop"] = { status: 200, body: {} };
    mockResponses["POST /global/images"] = { status: 200, body: {} };
    mockResponses["DELETE /instances/puls-bake-temp-my-docker-base"] = { status: 200, body: {} };

    const builder = new GCPTemplateBuilder("my-docker-base")
      .provision("playbooks/nginx.yaml");

    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (builder as any).checkPort = async () => true;
    const provisionSpy = mock.method(builder as any, "runProvisioner", async () => {});

    const result = await builder.deploy();
    assert.strictEqual(result.imageId, "projects/my-gcp-project/global/images/my-docker-base");

    // Verify delete old image called
    assert.ok(fetchCalls.some(c => c.method === "DELETE" && c.url.includes("/global/images/my-docker-base")));

    // Verify temp instance POST, stop POST, image bake POST, and temp instance DELETE
    assert.ok(fetchCalls.some(c => c.method === "POST" && c.url.includes("/instances")));
    assert.ok(fetchCalls.some(c => c.method === "POST" && c.url.includes("/stop")));
    assert.ok(fetchCalls.some(c => c.method === "POST" && c.url.includes("/global/images")));
    assert.ok(fetchCalls.some(c => c.method === "DELETE" && c.url.includes("/instances/puls-bake-temp-my-docker-base")));

    // Verify provision playbook ran
    assert.strictEqual(provisionSpy.mock.callCount(), 1);
    assert.strictEqual(provisionSpy.mock.calls[0].arguments[0], "35.200.12.34");
    assert.strictEqual(provisionSpy.mock.calls[0].arguments[1], "playbooks/nginx.yaml");
  });

  test("GCPVMBuilder clones from GCP custom image template successfully", async () => {
    const nginxHash = getFileHash("playbooks/nginx.yaml");
    mockResponses["GET /global/images/my-golden-gcp-image"] = {
      status: 200,
      body: {
        name: "my-golden-gcp-image",
        status: "READY",
        description: `nginx-yaml=${nginxHash}`,
      },
    };

    let vmQueryCount = 0;
    mockResponses["GET /instances/prod-server-01"] = {
      status: 200,
      get body() {
        vmQueryCount++;
        if (vmQueryCount === 1) return null; // VM absent initially
        return {
          name: "prod-server-01",
          status: "RUNNING",
          networkInterfaces: [
            {
              accessConfigs: [{ natIP: "35.240.10.88" }],
            },
          ],
        };
      },
    };

    mockResponses["POST /instances"] = { status: 200, body: {} };

    class GCPStack extends Stack {
      gcpTemplate = new GCPTemplateBuilder("my-golden-gcp-image")
        .provision("playbooks/nginx.yaml");

      server = new GCPVMBuilder("prod-server-01")
        .fromTemplate(this.gcpTemplate)
        .machineType("e2-standard-4");
    }

    const stack = new GCPStack();
    (stack.server as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (stack.server as any).checkPort = async () => true;

    const result = await stack.deploy();

    assert.strictEqual(result.gcpTemplate.imageId, "projects/my-gcp-project/global/images/my-golden-gcp-image");
    assert.strictEqual(result.server.ip, "35.240.10.88");

    // Verify instance creation POST has the dynamically resolved custom image path
    const createCall = fetchCalls.find(c => c.method === "POST" && c.url.includes("/instances") && c.body?.disks);
    assert.ok(createCall);
    assert.strictEqual(createCall.body.disks[0].initializeParams.sourceImage, "projects/my-gcp-project/global/images/my-golden-gcp-image");
    assert.strictEqual(createCall.body.machineType, "zones/us-central1-a/machineTypes/e2-standard-4");
  });
});
