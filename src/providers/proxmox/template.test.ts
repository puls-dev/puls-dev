import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ProxmoxApiClient } from "./api.js";
import { TemplateBuilder } from "./template.js";
import { VMBuilder } from "./vm.js";
import { Config } from "../../core/config.js";
import { getFileHash, mergeProvisionMetadata } from "./hash.js";
import { Stack } from "../../core/stack.js";

describe("Proxmox TemplateBuilder Unit Tests", () => {
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

  test("gracefully handles discovery when Template does not exist", async () => {
    mockGetResponses["/cluster/resources?type=vm"] = [];

    const builder = new TemplateBuilder("my-template");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
  });

  test("discovers existing Template and skips deployment if hashes match (Idempotence)", async () => {
    const nginxHash = getFileHash("playbooks/nginx.yaml");
    const notes = mergeProvisionMetadata("Pre-baked template notes", {
      "nginx.yaml": nginxHash,
    });

    mockGetResponses["/cluster/resources?type=vm"] = [
      { name: "my-template", vmid: 500, node: "pve1", template: 1 },
    ];
    mockGetResponses["/nodes/pve1/qemu/500/config"] = {
      description: notes,
    };

    const builder = new TemplateBuilder("my-template")
      .provision("playbooks/nginx.yaml");

    const result = await builder.deploy();
    assert.strictEqual(result.vmid, 500);
    assert.strictEqual(result.node, "pve1");

    // No POST/DELETE calls should be made since it already matches
    const writes = clientCalls.filter(c => c.method === "POST" || c.method === "DELETE");
    assert.strictEqual(writes.length, 0);
  });

  test("purges and rebuilds template if playbooks differ", async () => {
    mockGetResponses["/cluster/resources?type=vm"] = [
      { name: "my-template", vmid: 500, node: "pve1", template: 1 },
    ];
    // Template config notes are empty/out of date
    mockGetResponses["/nodes/pve1/qemu/500/config"] = {
      description: "",
    };
    mockGetResponses["/nodes"] = [
      { node: "pve1", status: "online", maxmem: 32 * 1024 * 1024 * 1024, mem: 12 * 1024 * 1024 * 1024 }
    ];
    mockGetResponses["/cluster/nextid"] = 600;
    mockGetResponses["/nodes/pve1/qemu/600/agent/network-get-interfaces"] = [
      {
        name: "eth0",
        "ip-addresses": [
          { "ip-address-type": "ipv4", "ip-address": "10.8.10.199" }
        ]
      }
    ];

    const builder = new TemplateBuilder("my-template")
      .provision("playbooks/nginx.yaml");

    const provisionCalls: Array<string> = [];
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (builder as any).checkPort = async () => true;
    (builder as any).checkCloudInit = async () => true;
    (builder as any).runProvisioner = async (ip: string, script: string) => {
      provisionCalls.push(script);
    };

    const result = await builder.deploy();
    assert.strictEqual(result.vmid, 600);

    // Verify it purged the old template
    const deleteCall = clientCalls.find(c => c.method === "DELETE" && c.path === "/nodes/pve1/qemu/500?purge=1&destroy-unreferenced-disks=1");
    assert.ok(deleteCall);

    // Verify it created a blank VM and provisioned it
    const createCall = clientCalls.find(c => c.method === "POST" && c.path === "/nodes/pve1/qemu");
    assert.ok(createCall);

    // Verify playbooks ran
    assert.strictEqual(provisionCalls.length, 1);
    assert.strictEqual(provisionCalls[0], "playbooks/nginx.yaml");

    // Verify it stopped the VM and converted it to a template
    const stopCall = clientCalls.find(c => c.method === "POST" && c.path === "/nodes/pve1/qemu/600/status/stop");
    assert.ok(stopCall);
    const templateCall = clientCalls.find(c => c.method === "POST" && c.path === "/nodes/pve1/qemu/600/template");
    assert.ok(templateCall);
  });

  test("VM clones from Template successfully", async () => {
    const nginxHash = getFileHash("playbooks/nginx.yaml");
    const notes = mergeProvisionMetadata("Pre-baked template notes", {
      "nginx.yaml": nginxHash,
    });

    mockGetResponses["/cluster/resources?type=vm"] = [
      // Template exists
      { name: "my-game-template", vmid: 500, node: "pve1", template: 1 },
    ];
    mockGetResponses["/nodes/pve1/qemu/500/config"] = {
      description: notes,
    };
    mockGetResponses["/cluster/nextid"] = 205;
    mockGetResponses["/nodes"] = [
      { node: "pve1", status: "online", maxmem: 32 * 1024 * 1024 * 1024, mem: 12 * 1024 * 1024 * 1024 }
    ];

    class ProxmoxStack extends Stack {
      template = new TemplateBuilder("my-game-template")
        .provision("playbooks/nginx.yaml");

      server = new VMBuilder("my-prod-game-01")
        .fromTemplate(this.template)
        .cores(4);
    }

    const stack = new ProxmoxStack();
    (stack.server as any).waitFor = async () => true;
    (stack.server as any).checkPort = async () => true;
    (stack.server as any).checkCloudInit = async () => true;

    const result = await stack.deploy();

    // Verify VM cloned successfully
    assert.strictEqual(result.template.vmid, 500);
    assert.strictEqual(result.server.vmid, 205);

    // Verify clone POST used the template's VMID
    const cloneCall = clientCalls.find(c => c.method === "POST" && c.path === "/nodes/pve1/qemu/500/clone");
    assert.ok(cloneCall);
    assert.strictEqual(cloneCall.body.newid, 205);
    assert.strictEqual(cloneCall.body.name, "my-prod-game-01");
  });
});
