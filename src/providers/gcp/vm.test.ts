import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { GCPVMBuilder } from "./vm.js";
import { Config } from "../../core/config.js";
import { getFileHash } from "../proxmox/hash.js";

describe("GCPVMBuilder Unit Tests", () => {
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

    const originalRead = fs.readFileSync;
    mock.method(fs, "readFileSync", (path: any, options: any) => {
      if (typeof path === "string" && path.includes(".pub")) {
        return "ssh-rsa AAAA_FAKE_GCP_PUBLIC_KEY test@gcp.com";
      }
      return originalRead(path, options);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test("handles discovery when VM does not exist", async () => {
    mockResponses["GET /instances/my-gcp-vm"] = {
      status: 404,
      body: { error: { message: "Not Found" } },
    };

    const builder = new GCPVMBuilder("my-gcp-vm");
    const existing = await (builder as any).discoveryPromise;

    assert.strictEqual(existing, null);
    const getCall = fetchCalls.find((c) => c.method === "GET" && c.url.includes("/instances/my-gcp-vm"));
    assert.ok(getCall);
  });

  test("discovers VM successfully when it exists", async () => {
    mockResponses["GET /instances/my-gcp-vm"] = {
      status: 200,
      body: {
        id: "vm-123456",
        name: "my-gcp-vm",
        status: "RUNNING",
        networkInterfaces: [
          {
            accessConfigs: [{ natIP: "34.56.78.90" }],
          },
        ],
        metadata: {
          items: [{ key: "puls-provision", value: "nginx-yaml=abc123123123" }],
        },
      },
    };

    const builder = new GCPVMBuilder("my-gcp-vm");
    const existing = await (builder as any).discoveryPromise;

    assert.ok(existing);
    assert.strictEqual(existing.id, "vm-123456");

    const resolvedId = await builder.out.id.get();
    const resolvedIp = await builder.out.ip.get();
    assert.strictEqual(resolvedId, "vm-123456");
    assert.strictEqual(resolvedIp, "34.56.78.90");
  });

  test("runs in dry-run mode safely and logs plan", async () => {
    Config.set({
      dryRun: true,
      providers: {
        gcp: { projectId: "my-gcp-project", serviceAccountPath: "/fake/sa.json" },
      },
    });

    mockResponses["GET /instances/new-gcp-vm"] = {
      status: 404,
      body: { error: { message: "Not Found" } },
    };

    const builder = new GCPVMBuilder("new-gcp-vm")
      .machineType("e2-medium")
      .zone("europe-west1-b")
      .provision("playbooks/nginx.yaml");

    const res = await builder.deploy();
    assert.deepStrictEqual(res, { name: "new-gcp-vm", id: "PENDING" });

    const resolvedId = await builder.out.id.get();
    const resolvedIp = await builder.out.ip.get();
    assert.strictEqual(resolvedId, "PENDING");
    assert.strictEqual(resolvedIp, "0.0.0.0");

    // Ensure no writes were performed
    const writeCalls = fetchCalls.filter((c) => c.method === "POST" || c.method === "DELETE");
    assert.strictEqual(writeCalls.length, 0);
  });

  test("creates a new VM instance and runs playbooks successfully", async () => {
    mockResponses["GET /instances/new-vm"] = {
      status: 404,
      body: { error: { message: "Not Found" } },
    };
    mockResponses["POST /instances"] = {
      status: 200,
      body: { id: "op-111", status: "DONE" },
    };

    // Subsequents GET during wait loop returns RUNNING
    let getCount = 0;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      fetchCalls.push({ url, method, body });

      if (method === "GET" && url.includes("/instances/new-vm")) {
        const createCall = fetchCalls.find(c => c.method === "POST" && c.url.includes("/instances"));
        if (!createCall) {
          return {
            ok: false,
            status: 404,
            json: async () => ({ error: { message: "Not Found" } }),
            text: async () => JSON.stringify({ error: { message: "Not Found" } }),
          } as Response;
        }

        getCount++;
        const data = {
          id: "new-vm-uuid",
          name: "new-vm",
          status: getCount > 1 ? "RUNNING" : "PROVISIONING",
          networkInterfaces: [
            {
              accessConfigs: [{ natIP: "35.200.10.20" }],
            },
          ],
        };
        return {
          ok: true,
          status: 200,
          json: async () => data,
          text: async () => JSON.stringify(data),
        } as Response;
      }

      if (method === "POST" && url.includes("/instances")) {
        const opData = { id: "op-111", status: "DONE" };
        return {
          ok: true,
          status: 200,
          json: async () => opData,
          text: async () => JSON.stringify(opData),
        } as Response;
      }

      return { ok: false, status: 404 } as Response;
    };

    const builder = new GCPVMBuilder("new-vm")
      .machineType("e2-medium")
      .zone("us-central1-a")
      .sshKey("~/.ssh/id_rsa.pub")
      .provision("playbooks/nginx.yaml");

    const provisionCalls: string[] = [];
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (builder as any).checkPort = async () => true;
    (builder as any).runProvisioner = async (ip: string, script: string) => {
      provisionCalls.push(script);
    };

    const res = await builder.deploy();
    assert.ok(res);
    assert.strictEqual(res.id, "new-vm-uuid");
    assert.strictEqual(res.ip, "35.200.10.20");

    assert.strictEqual(provisionCalls.length, 1);
    assert.strictEqual(provisionCalls[0], "playbooks/nginx.yaml");

    const createCall = fetchCalls.find((c) => c.method === "POST" && c.url.includes("/instances"));
    assert.ok(createCall);
    assert.strictEqual(createCall.body.name, "new-vm");
    assert.strictEqual(createCall.body.machineType, "zones/us-central1-a/machineTypes/e2-medium");
    const sshMetadata = createCall.body.metadata.items.find((i: any) => i.key === "ssh-keys");
    assert.strictEqual(sshMetadata.value, "root:ssh-rsa AAAA_FAKE_GCP_PUBLIC_KEY test@gcp.com");
    const provMetadata = createCall.body.metadata.items.find((i: any) => i.key === "puls-provision");
    assert.ok(provMetadata.value.startsWith("nginx-yaml="));
  });

  test("skips playbook execution on existing VM if hashes match", async () => {
    const nginxHash = getFileHash("playbooks/nginx.yaml");

    mockResponses["GET /instances/exist-vm"] = {
      status: 200,
      body: {
        id: "exist-vm-id",
        name: "exist-vm",
        status: "RUNNING",
        machineType: "zones/us-central1-a/machineTypes/e2-micro",
        networkInterfaces: [
          {
            accessConfigs: [{ natIP: "35.200.10.30" }],
          },
        ],
        metadata: {
          items: [{ key: "puls-provision", value: `nginx-yaml=${nginxHash}` }],
        },
      },
    };

    const builder = new GCPVMBuilder("exist-vm")
      .machineType("e2-micro")
      .zone("us-central1-a")
      .provision("playbooks/nginx.yaml");

    const provisionCalls: string[] = [];
    (builder as any).runProvisioner = async (ip: string, script: string) => {
      provisionCalls.push(script);
    };

    await builder.deploy();

    // No playbooks should run
    assert.strictEqual(provisionCalls.length, 0);

    // No setMetadata call
    const setMetaCall = fetchCalls.find((c) => c.method === "POST" && c.url.includes("/setMetadata"));
    assert.strictEqual(setMetaCall, undefined);
  });

  test("executes playbooks on existing VM if hashes differ, updating metadata", async () => {
    mockResponses["GET /instances/exist-diff-vm"] = {
      status: 200,
      body: {
        id: "exist-diff-vm-id",
        name: "exist-diff-vm",
        status: "RUNNING",
        machineType: "zones/us-central1-a/machineTypes/e2-micro",
        networkInterfaces: [
          {
            accessConfigs: [{ natIP: "35.200.10.40" }],
          },
        ],
        metadata: {
          fingerprint: "old-fingerprint-123",
          items: [{ key: "puls-provision", value: "nginx-yaml=abc123123123" }],
        },
      },
    };
    mockResponses["POST /instances/exist-diff-vm/setMetadata"] = {
      status: 200,
      body: {},
    };

    const builder = new GCPVMBuilder("exist-diff-vm")
      .machineType("e2-micro")
      .zone("us-central1-a")
      .provision("playbooks/nginx.yaml");

    const provisionCalls: string[] = [];
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (builder as any).checkPort = async () => true;
    (builder as any).runProvisioner = async (ip: string, script: string) => {
      provisionCalls.push(script);
    };

    await builder.deploy();

    assert.strictEqual(provisionCalls.length, 1);
    assert.strictEqual(provisionCalls[0], "playbooks/nginx.yaml");

    // Verify setMetadata was dispatched with new hashes and correct fingerprint
    const setMetaCall = fetchCalls.find((c) => c.method === "POST" && c.url.includes("/setMetadata"));
    assert.ok(setMetaCall);
    assert.strictEqual(setMetaCall.body.fingerprint, "old-fingerprint-123");
    const provMetadata = setMetaCall.body.items.find((i: any) => i.key === "puls-provision");
    const expectedHash = getFileHash("playbooks/nginx.yaml");
    assert.strictEqual(provMetadata.value, `nginx-yaml=${expectedHash}`);
  });

  test("destroys VM successfully", async () => {
    mockResponses["GET /instances/delete-vm"] = {
      status: 200,
      body: { id: "delete-vm-id", name: "delete-vm" },
    };
    mockResponses["DELETE /instances/delete-vm"] = {
      status: 200,
      body: {},
    };

    const builder = new GCPVMBuilder("delete-vm");
    await (builder as any).discoveryPromise;

    const res = await builder.destroy();
    assert.deepStrictEqual(res, { destroyed: "delete-vm" });

    const deleteCall = fetchCalls.find((c) => c.method === "DELETE" && c.url.includes("/instances/delete-vm"));
    assert.ok(deleteCall);
  });

  test("resolves environment variables including secrets and writes to .env.puls", async () => {
    // Clean up .env.puls if it exists
    const fs = await import("node:fs");
    if (fs.existsSync(".env.puls")) {
      fs.unlinkSync(".env.puls");
    }

    mockResponses["GET /instances/my-new-vm"] = {
      status: 404,
      body: { error: "not found" },
    };
    mockResponses["POST /instances"] = {
      status: 200,
      body: {},
    };

    // Create a mock secret
    const { Secret } = await import("../../core/secret.js");
    const mySecret = Secret.env("MOCK_IPA_PASSWORD", "super-secret-password");

    const builder = new GCPVMBuilder("my-new-vm")
      .machineType("e2-micro")
      .zone("us-central1-a")
      .sshKey("~/.ssh/id_rsa")
      .provision("playbooks/nginx.yaml")
      .env({
        MY_VAR: "simple-value",
        IPA_PASSWORD: mySecret,
      });

    const provisionCalls: Array<{ ip: string; script: string; extraEnv?: Record<string, string> }> = [];

    // Overrides
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      // Fake a running state on check
      mockResponses["GET /instances/my-new-vm"] = {
        status: 200,
        body: {
          id: "my-new-vm-id",
          name: "my-new-vm",
          status: "RUNNING",
          networkInterfaces: [
            {
              accessConfigs: [{ natIP: "35.200.10.40" }],
            },
          ],
        },
      };
      return await condition();
    };
    (builder as any).checkPort = async () => true;
    (builder as any).runProvisioner = async (ip: string, script: string, extraEnv?: Record<string, string>) => {
      provisionCalls.push({ ip, script, extraEnv });
    };

    await builder.deploy();

    // Verify playbooks were executed with correct env
    assert.strictEqual(provisionCalls.length, 1);
    assert.deepStrictEqual(provisionCalls[0].extraEnv, {
      MY_VAR: "simple-value",
      IPA_PASSWORD: "super-secret-password",
    });

    // Verify .env.puls was written
    assert.ok(fs.existsSync(".env.puls"));
    const content = fs.readFileSync(".env.puls", "utf8");
    assert.ok(content.includes("MY_VAR=simple-value"));
    assert.ok(content.includes("IPA_PASSWORD=super-secret-password"));

    // Clean up
    fs.unlinkSync(".env.puls");
  });
});
