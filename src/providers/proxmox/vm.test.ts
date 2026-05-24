import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ProxmoxApiClient } from "./api.js";
import { VMBuilder } from "./vm.js";
import { Config } from "../../core/config.js";

describe("Proxmox VMBuilder Unit Tests", () => {
  let originalGet: any;
  let originalPost: any;
  let originalDelete: any;
  let clientCalls: Array<{ method: string; path: string; body?: any }> = [];
  let mockGetResponses: Record<string, any> = {};
  let mockPostResponses: Record<string, any> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        proxmox: {
          url: "https://pve.example.com:8006",
          user: "root@pam",
          tokenName: "puls",
          tokenSecret: "secret-key",
          verifySsl: false,
          dnsDomain: "nolimit.int",
        },
      },
    });

    clientCalls = [];
    mockGetResponses = {};
    mockPostResponses = {};

    originalGet = ProxmoxApiClient.prototype.get;
    originalPost = ProxmoxApiClient.prototype.post;
    originalDelete = ProxmoxApiClient.prototype.delete;

    ProxmoxApiClient.prototype.get = async function (path: string) {
      clientCalls.push({ method: "GET", path });
      if (mockGetResponses[path] !== undefined) {
        const handler = mockGetResponses[path];
        if (typeof handler === "function") return handler();
        return handler;
      }
      return [];
    } as any;

    ProxmoxApiClient.prototype.post = async function (path: string, body?: any) {
      clientCalls.push({ method: "POST", path, body });
      if (mockPostResponses[path] !== undefined) {
        const handler = mockPostResponses[path];
        if (typeof handler === "function") return handler(body);
        return handler;
      }
      if (path.includes("/clone")) {
        return "UPID:pve1:00000000:00000000:00000000:qemuclone:101:root@pam:";
      }
      return {};
    } as any;

    ProxmoxApiClient.prototype.delete = async function (path: string) {
      clientCalls.push({ method: "DELETE", path });
    } as any;
  });

  afterEach(() => {
    ProxmoxApiClient.prototype.get = originalGet;
    ProxmoxApiClient.prototype.post = originalPost;
    ProxmoxApiClient.prototype.delete = originalDelete;
  });

  test("gracefully handles discovery when VM does not exist", async () => {
    mockGetResponses["/cluster/resources?type=vm"] = [];

    const builder = new VMBuilder("my-vm");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.ok(clientCalls.some((c) => c.path === "/cluster/resources?type=vm"));
  });

  test("discovers existing VM successfully", async () => {
    mockGetResponses["/cluster/resources?type=vm"] = [
      { name: "my-vm", vmid: 200, node: "pve2", template: 0, status: "running" },
    ];

    const builder = new VMBuilder("my-vm");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.vmid, 200);
    assert.strictEqual(discoveryResult.node, "pve2");

    const deployResult = await builder.deploy();
    assert.strictEqual(deployResult.vmid, 200);
    assert.strictEqual(builder.resolvedNode, "pve2");
  });

  test("performs clean dry-run planning without making API writes", async () => {
    Config.set({
      dryRun: true,
      providers: {
        proxmox: {
          url: "https://pve.example.com:8006",
          user: "root@pam",
          tokenName: "puls",
          tokenSecret: "secret-key",
        },
      },
    });

    const builder = new VMBuilder("dryrun-vm")
      .cores(4)
      .memory(4096)
      .machine("i440fx");

    const deployResult = await builder.deploy();
    assert.strictEqual(deployResult.vmid, "PENDING");
    assert.ok(!clientCalls.some((c) => c.method === "POST"));
  });

  test("deploys new VM and performs cluster-aware node selection based on free RAM", async () => {
    mockGetResponses["/cluster/resources?type=vm"] = [];
    mockGetResponses["/cluster/nextid"] = 105;

    // Simulate three nodes in the cluster with different RAM allocations and statuses
    mockGetResponses["/nodes"] = [
      { node: "pve-offline", status: "offline", maxmem: 64 * 1024 * 1024 * 1024, mem: 4 * 1024 * 1024 * 1024 }, // offline
      { node: "pve-ram-low", status: "online", maxmem: 16 * 1024 * 1024 * 1024, mem: 14 * 1024 * 1024 * 1024 },  // 2GB free
      { node: "pve-ram-high", status: "online", maxmem: 32 * 1024 * 1024 * 1024, mem: 12 * 1024 * 1024 * 1024 }, // 20GB free
    ];

    // Mock wait for task (normally waitForTask would poll the UPID, but in tests it mock-completes or we bypass it)
    // In our test, since we don't have a template image configured, it creates a blank VM by POSTing to /nodes/{node}/qemu
    const builder = new VMBuilder("my-new-vm")
      .cores(2)
      .memory(2048)
      .ip("10.8.10.85")
      .machine("i440fx");

    const deployResult = await builder.deploy();

    // Verify it resolved to the VMID and the most free RAM node ("pve-ram-high")
    assert.strictEqual(deployResult.vmid, 105);
    assert.strictEqual(builder.resolvedNode, "pve-ram-high");

    // Verify the blank VM POST went to the correct node
    const createCall = clientCalls.find((c) => c.method === "POST" && c.path.startsWith("/nodes/pve-ram-high/qemu"));
    assert.ok(createCall);
    assert.deepStrictEqual(createCall.body, {
      vmid: 105,
      name: "my-new-vm",
      cores: 2,
      memory: 2048,
      net0: "virtio,bridge=vmbr1",
      ostype: "l26",
    });

    // Verify config patch incorporates the custom machine override "i440fx"
    const configCall = clientCalls.find(
      (c) => c.method === "POST" && c.path === "/nodes/pve-ram-high/qemu/105/config"
    );
    assert.ok(configCall);
    assert.strictEqual(configCall.body.machine, "i440fx");
    assert.strictEqual(configCall.body.cores, 2);
    assert.strictEqual(configCall.body.memory, 2048);
  });

  test("destroys an existing VM successfully", async () => {
    mockGetResponses["/cluster/resources?type=vm"] = [
      { name: "my-vm", vmid: 200, node: "pve1", template: 0 },
    ];

    const builder = new VMBuilder("my-vm");
    await (builder as any).discoveryPromise;

    const destroyResult = await builder.destroy();
    assert.deepStrictEqual(destroyResult, { destroyed: "my-vm" });

    // In Proxmox, VM deletion is handled via BaseBuilder default or custom VMBuilder destroy.
    // Let's verify we logged or called the delete path or returned safely.
    assert.ok(destroyResult.destroyed);
  });
});
