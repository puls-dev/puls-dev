import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EC2VMBuilder, parseAwsTagsForProvision, mergeAwsTagsForProvision } from "./ec2.js";
import { getFileHash } from "../proxmox/hash.js";
import { Config } from "../../core/config.js";
import { EC2Client } from "@aws-sdk/client-ec2";

describe("EC2VMBuilder Unit Tests", () => {
  let originalSend: any;

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        aws: { region: "us-east-1" },
      },
    });
    originalSend = EC2Client.prototype.send;
  });

  test("gracefully handles discovery when VM does not exist", async () => {
    EC2Client.prototype.send = (async (command: any) => {
      if (command.constructor.name === "DescribeInstancesCommand") {
        return { Reservations: [] };
      }
      return {};
    }) as any;

    try {
      const vm = new EC2VMBuilder("missing-vm");
      const existing = await (vm as any).discoveryPromise;
      assert.strictEqual(existing, null);
      assert.strictEqual((vm as any).resolvedInstanceId, undefined);
    } finally {
      EC2Client.prototype.send = originalSend;
    }
  });

  test("discovers VM successfully when it exists", async () => {
    EC2Client.prototype.send = (async (command: any) => {
      if (command.constructor.name === "DescribeInstancesCommand") {
        return {
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: "i-1234567890abcdef0",
                  InstanceType: "t3.micro",
                  PublicIpAddress: "54.80.12.34",
                  State: { Name: "running" },
                  Tags: [{ Key: "Name", Value: "existing-vm" }],
                },
              ],
            },
          ],
        };
      }
      return {};
    }) as any;

    try {
      const vm = new EC2VMBuilder("existing-vm");
      const existing = await (vm as any).discoveryPromise;
      assert.ok(existing);
      assert.strictEqual(existing.InstanceId, "i-1234567890abcdef0");
      assert.strictEqual(await vm.out.id.get(), "i-1234567890abcdef0");
      assert.strictEqual(await vm.out.ip.get(), "54.80.12.34");
    } finally {
      EC2Client.prototype.send = originalSend;
    }
  });

  test("runs in dry-run mode safely and logs plan", async () => {
    Config.set({ dryRun: true });

    EC2Client.prototype.send = (async (command: any) => {
      if (command.constructor.name === "DescribeInstancesCommand") {
        return { Reservations: [] };
      }
      return {};
    }) as any;

    const originalLog = console.log;
    let logOutput = "";
    console.log = (...args: any[]) => {
      logOutput += args.join(" ") + "\n";
    };

    try {
      const vm = new EC2VMBuilder("dryrun-vm")
        .instanceType("t3.medium")
        .ami("ami-test123")
        .provision("playbooks/nginx.yaml");

      const result = await vm.deploy();
      assert.strictEqual(result!.name, "dryrun-vm");
      assert.strictEqual(result!.id, "PENDING");
      assert.strictEqual(await vm.out.id.get(), "PENDING");
      assert.strictEqual(await vm.out.ip.get(), "0.0.0.0");

      assert.ok(logOutput.includes("🔍 [DRY RUN]"));
      assert.ok(logOutput.includes("Plan: Create EC2 Instance \"dryrun-vm\""));
      assert.ok(logOutput.includes("t3.medium from AMI ami-test123"));
      assert.ok(logOutput.includes("playbooks/nginx.yaml"));
    } finally {
      console.log = originalLog;
      EC2Client.prototype.send = originalSend;
    }
  });

  test("creates a new VM instance and runs playbooks successfully", async () => {
    // 1. Create a dummy playbook file to check hash
    const dummyPlaybookDir = join(tmpdir(), `puls-ec2-test-${Date.now()}`);
    fs.mkdirSync(dummyPlaybookDir);
    const playbookPath = join(dummyPlaybookDir, "setup.yaml");
    fs.writeFileSync(playbookPath, "- hosts: all\n  tasks:\n    - name: Hello");

    // Mock EC2 Client state transitions:
    // First DescribeInstancesCommand returns empty, then returns running VM.
    let describeCount = 0;
    EC2Client.prototype.send = (async (command: any) => {
      const name = command.constructor.name;
      if (name === "DescribeInstancesCommand") {
        describeCount++;
        if (describeCount === 1) {
          return { Reservations: [] };
        }
        return {
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: "i-999",
                  InstanceType: "t3.micro",
                  PublicIpAddress: "34.200.10.20",
                  State: { Name: "running" },
                  Tags: [
                    { Key: "Name", Value: "new-ec2-vm" },
                    { Key: "puls-provision", Value: `setup-yaml=${getFileHash(playbookPath)}` },
                  ],
                },
              ],
            },
          ],
        };
      }
      if (name === "RunInstancesCommand") {
        return {
          Instances: [
            {
              InstanceId: "i-999",
              State: { Name: "pending" },
            },
          ],
        };
      }
      return {};
    }) as any;

    try {
      const vm = new EC2VMBuilder("new-ec2-vm")
        .ami("ami-0c55b159cbfafe1f0")
        .instanceType("t3.micro")
        .sshPrivateKey("~/.ssh/id_rsa")
        .provision(playbookPath);

      // Mock SSH Port check and playbook run
      mock.method(vm as any, "checkPort", async () => true);
      const runProvisionSpy = mock.method(vm as any, "runProvisioner", async () => {});

      const result = await vm.deploy();

      assert.strictEqual(result!.id, "i-999");
      assert.strictEqual(result!.ip, "34.200.10.20");
      assert.strictEqual(await vm.out.ip.get(), "34.200.10.20");
      assert.strictEqual(runProvisionSpy.mock.callCount(), 1);
      assert.strictEqual(runProvisionSpy.mock.calls[0].arguments[0], "34.200.10.20");
      assert.strictEqual(runProvisionSpy.mock.calls[0].arguments[1], playbookPath);
    } finally {
      // Cleanup
      EC2Client.prototype.send = originalSend;
      try {
        fs.unlinkSync(playbookPath);
        fs.rmdirSync(dummyPlaybookDir);
      } catch {}
    }
  });

  test("stops, resizes, and starts the VM when instanceType changes", async () => {
    let state = "running";
    let type = "t3.micro";

    EC2Client.prototype.send = (async (command: any) => {
      const name = command.constructor.name;
      if (name === "DescribeInstancesCommand") {
        return {
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: "i-123",
                  InstanceType: type,
                  PublicIpAddress: "34.20.10.5",
                  State: { Name: state },
                  Tags: [{ Key: "Name", Value: "resize-vm" }],
                },
              ],
            },
          ],
        };
      }
      if (name === "StopInstancesCommand") {
        state = "stopped";
        return {};
      }
      if (name === "ModifyInstanceAttributeCommand") {
        type = command.input.InstanceType.Value;
        return {};
      }
      if (name === "StartInstancesCommand") {
        state = "running";
        return {};
      }
      return {};
    }) as any;

    try {
      const vm = new EC2VMBuilder("resize-vm").instanceType("t3.medium");
      const result = await vm.deploy();

      assert.strictEqual(result!.id, "i-123");
      assert.strictEqual(type, "t3.medium");
      assert.strictEqual(state, "running");
    } finally {
      EC2Client.prototype.send = originalSend;
    }
  });

  test("terminates the VM successfully on destroy", async () => {
    let terminated = false;
    EC2Client.prototype.send = (async (command: any) => {
      const name = command.constructor.name;
      if (name === "DescribeInstancesCommand") {
        return {
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: "i-555",
                  InstanceType: "t3.micro",
                  State: { Name: "running" },
                  Tags: [{ Key: "Name", Value: "delete-vm" }],
                },
              ],
            },
          ],
        };
      }
      if (name === "TerminateInstancesCommand") {
        terminated = true;
        return {};
      }
      return {};
    }) as any;

    try {
      const vm = new EC2VMBuilder("delete-vm");
      const result = await vm.destroy();
      assert.strictEqual(result!.destroyed, "delete-vm");
      assert.ok(terminated);
    } finally {
      EC2Client.prototype.send = originalSend;
    }
  });

  test("parseAwsTagsForProvision correctly handles missing and formatted provision tags", () => {
    assert.deepStrictEqual(parseAwsTagsForProvision(undefined), {});
    assert.deepStrictEqual(parseAwsTagsForProvision([]), {});

    const tags = [
      { Key: "Name", Value: "my-vm" },
      { Key: "puls-provision", Value: "setup-yaml=h123,configure-yaml=h456" },
    ];
    const parsed = parseAwsTagsForProvision(tags);
    assert.deepStrictEqual(parsed, {
      "setup-yaml": "h123",
      "configure-yaml": "h456",
    });
  });

  test("mergeAwsTagsForProvision merges record mapping back into string", () => {
    const hashes = { "nginx-yaml": "hash-abc", "sec-yaml": "hash-xyz" };
    const merged = mergeAwsTagsForProvision(hashes);
    assert.strictEqual(merged, "nginx-yaml=hash-abc,sec-yaml=hash-xyz");
  });
});
