import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ProxmoxApiClient } from "./api.js";
import { VMBuilder } from "./vm.js";
import { Config } from "../../core/config.js";
import { getFileHash, parseProvisionMetadata, mergeProvisionMetadata } from "./hash.js";
import { Stack } from "../../core/stack.js";
import { ForceConfigCheck } from "../../core/decorators.js";

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

  test("deploys new VM and writes playbook hashes to VM notes", async () => {
    mockGetResponses["/cluster/resources?type=vm"] = [];
    mockGetResponses["/cluster/nextid"] = 105;
    mockGetResponses["/nodes"] = [
      { node: "pve1", status: "online", maxmem: 32 * 1024 * 1024 * 1024, mem: 12 * 1024 * 1024 * 1024 }
    ];

    const builder = new VMBuilder("prov-new-vm")
      .cores(2)
      .memory(2048)
      .ip("10.8.10.90")
      .provision("playbooks/nginx.yaml", "playbooks/db.yaml");

    const provisionCalls: Array<{ ip: string; script: string }> = [];

    // Overrides
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (builder as any).checkPort = async () => true;
    (builder as any).checkCloudInit = async () => true;
    (builder as any).runProvisioner = async (ip: string, script: string) => {
      provisionCalls.push({ ip, script });
    };

    const deployResult = await builder.deploy();
    assert.strictEqual(deployResult.vmid, 105);

    // Verify playbooks were executed
    assert.strictEqual(provisionCalls.length, 2);
    assert.strictEqual(provisionCalls[0].script, "playbooks/nginx.yaml");
    assert.strictEqual(provisionCalls[1].script, "playbooks/db.yaml");

    // Verify VM configuration was updated with playbooks hash
    const configCall = clientCalls.find(
      (c) => c.method === "POST" && c.path === "/nodes/pve1/qemu/105/config" && c.body?.description
    );
    assert.ok(configCall);
    const expectedDescription = mergeProvisionMetadata("", {
      "nginx.yaml": getFileHash("playbooks/nginx.yaml"),
      "db.yaml": getFileHash("playbooks/db.yaml"),
    });
    assert.strictEqual(configCall.body.description, expectedDescription);
  });

  test("skips playbook execution on existing VM if hashes match (Idempotence)", async () => {
    const nginxHash = getFileHash("playbooks/nginx.yaml");
    const dbHash = getFileHash("playbooks/db.yaml");

    const descriptionNotes = mergeProvisionMetadata("User customized notes here", {
      "nginx.yaml": nginxHash,
      "db.yaml": dbHash,
    });

    mockGetResponses["/cluster/resources?type=vm"] = [
      { name: "my-existing-vm", vmid: 200, node: "pve1", template: 0, status: "running" },
    ];
    mockGetResponses["/nodes/pve1/qemu/200/config"] = {
      description: descriptionNotes,
    };

    const builder = new VMBuilder("my-existing-vm")
      .ip("10.8.10.95")
      .provision("playbooks/nginx.yaml", "playbooks/db.yaml");

    const provisionCalls: Array<{ ip: string; script: string }> = [];

    // Overrides
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (builder as any).checkPort = async () => true;
    (builder as any).checkCloudInit = async () => true;
    (builder as any).runProvisioner = async (ip: string, script: string) => {
      provisionCalls.push({ ip, script });
    };

    const deployResult = await builder.deploy();
    assert.strictEqual(deployResult.vmid, 200);

    // Verify NO playbooks were executed
    assert.strictEqual(provisionCalls.length, 0);

    // Verify VM configuration was NOT posted to update notes
    const updateConfigCall = clientCalls.find(
      (c) => c.method === "POST" && c.path === "/nodes/pve1/qemu/200/config"
    );
    assert.ok(!updateConfigCall);
  });

  test("executes only new/changed playbooks on existing VM and merges notes metadata (Incremental)", async () => {
    const nginxHash = getFileHash("playbooks/nginx.yaml");
    const dbHash = getFileHash("playbooks/db.yaml");

    const descriptionNotes = mergeProvisionMetadata("User notes preserved", {
      "nginx.yaml": nginxHash,
    });

    mockGetResponses["/cluster/resources?type=vm"] = [
      { name: "my-existing-vm", vmid: 200, node: "pve1", template: 0, status: "running" },
    ];
    mockGetResponses["/nodes/pve1/qemu/200/config"] = {
      description: descriptionNotes,
    };

    const builder = new VMBuilder("my-existing-vm")
      .ip("10.8.10.95")
      .provision("playbooks/nginx.yaml", "playbooks/db.yaml");

    const provisionCalls: Array<{ ip: string; script: string }> = [];

    // Overrides
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (builder as any).checkPort = async () => true;
    (builder as any).checkCloudInit = async () => true;
    (builder as any).runProvisioner = async (ip: string, script: string) => {
      provisionCalls.push({ ip, script });
    };

    const deployResult = await builder.deploy();
    assert.strictEqual(deployResult.vmid, 200);

    // Verify ONLY db.yaml was executed (nginx.yaml was skipped!)
    assert.strictEqual(provisionCalls.length, 1);
    assert.strictEqual(provisionCalls[0].script, "playbooks/db.yaml");

    // Verify VM configuration was updated with BOTH hashes and preserved user notes
    const updateConfigCall = clientCalls.find(
      (c) => c.method === "POST" && c.path === "/nodes/pve1/qemu/200/config"
    );
    assert.ok(updateConfigCall);

    const expectedDescription = mergeProvisionMetadata("User notes preserved", {
      "nginx.yaml": nginxHash,
      "db.yaml": dbHash,
    });
    assert.strictEqual(updateConfigCall.body.description, expectedDescription);
    assert.ok(expectedDescription.startsWith("User notes preserved"));
  });

  test("forceConfigCheck() builder method forces playbook execution even if hashes match", async () => {
    const nginxHash = getFileHash("playbooks/nginx.yaml");

    const descriptionNotes = mergeProvisionMetadata("User notes", {
      "nginx.yaml": nginxHash,
    });

    mockGetResponses["/cluster/resources?type=vm"] = [
      { name: "force-vm", vmid: 200, node: "pve1", template: 0, status: "running" },
    ];
    mockGetResponses["/nodes/pve1/qemu/200/config"] = {
      description: descriptionNotes,
    };

    const builder = new VMBuilder("force-vm")
      .ip("10.8.10.95")
      .provision("playbooks/nginx.yaml")
      .forceConfigCheck();

    const provisionCalls: Array<{ ip: string; script: string }> = [];

    // Overrides
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (builder as any).checkPort = async () => true;
    (builder as any).checkCloudInit = async () => true;
    (builder as any).runProvisioner = async (ip: string, script: string) => {
      provisionCalls.push({ ip, script });
    };

    const deployResult = await builder.deploy();
    assert.strictEqual(deployResult.vmid, 200);

    // Verify playbook WAS executed because of forceConfigCheck()
    assert.strictEqual(provisionCalls.length, 1);
    assert.strictEqual(provisionCalls[0].script, "playbooks/nginx.yaml");
  });

  test("ForceConfigCheck decorator forces playbook execution even if hashes match", async () => {
    const nginxHash = getFileHash("playbooks/nginx.yaml");

    const descriptionNotes = mergeProvisionMetadata("User notes", {
      "nginx.yaml": nginxHash,
    });

    mockGetResponses["/cluster/resources?type=vm"] = [
      { name: "force-dec-vm", vmid: 200, node: "pve1", template: 0, status: "running" },
    ];
    mockGetResponses["/nodes/pve1/qemu/200/config"] = {
      description: descriptionNotes,
    };

    const provisionCalls: Array<{ ip: string; script: string }> = [];

    class TestStack extends Stack {
      @ForceConfigCheck
      server = new VMBuilder("force-dec-vm")
        .ip("10.8.10.95")
        .provision("playbooks/nginx.yaml");
    }

    const stack = new TestStack();
    (stack.server as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (stack.server as any).checkPort = async () => true;
    (stack.server as any).checkCloudInit = async () => true;
    (stack.server as any).runProvisioner = async (ip: string, script: string) => {
      provisionCalls.push({ ip, script });
    };

    await stack.deploy();

    // Verify playbook WAS executed because of @ForceConfigCheck decorator
    assert.strictEqual(provisionCalls.length, 1);
    assert.strictEqual(provisionCalls[0].script, "playbooks/nginx.yaml");
  });
});

describe("Proxmox Provision Hash & Metadata Utilities", () => {
  test("parseProvisionMetadata parses valid, invalid, and empty strings", () => {
    assert.deepStrictEqual(parseProvisionMetadata(""), {});
    assert.deepStrictEqual(parseProvisionMetadata("Plain text note without tag"), {});
    assert.deepStrictEqual(parseProvisionMetadata("User description\n\n[puls-provision: a=123,b=456]"), {
      a: "123",
      b: "456",
    });
    assert.deepStrictEqual(parseProvisionMetadata("[puls-provision:  nginx.yaml = abc123def456 , db.yaml=789 ]"), {
      "nginx.yaml": "abc123def456",
      "db.yaml": "789",
    });
  });

  test("mergeProvisionMetadata merges tags into notes without corrupting user descriptions", () => {
    const meta = { "nginx.yaml": "abc", "db.yaml": "def" };
    const expectedBlock = "[puls-provision: nginx.yaml=abc,db.yaml=def]";

    // Case 1: Empty note
    assert.strictEqual(mergeProvisionMetadata("", meta), expectedBlock);

    // Case 2: Existing note without tags
    assert.strictEqual(
      mergeProvisionMetadata("My server description", meta),
      `My server description\n\n${expectedBlock}`
    );

    // Case 3: Existing note with existing tags (should replace them)
    const existing = `Some description\n\n[puls-provision: nginx.yaml=old]\nMore details`;
    const merged = mergeProvisionMetadata(existing, meta);
    assert.ok(merged.includes(expectedBlock));
    assert.ok(merged.includes("Some description"));
    assert.ok(!merged.includes("nginx.yaml=old"));
  });

  test("getFileHash returns stable fallback hash for virtual playbooks", () => {
    const hash1 = getFileHash("virtual-playbook-path-1.yaml");
    const hash2 = getFileHash("virtual-playbook-path-1.yaml");
    const hash3 = getFileHash("virtual-playbook-path-2.yaml");

    assert.strictEqual(hash1.length, 12);
    assert.strictEqual(hash1, hash2);
    assert.notStrictEqual(hash1, hash3);
  });
});
