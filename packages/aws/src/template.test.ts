import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { EC2Client } from "@aws-sdk/client-ec2";
import { EC2TemplateBuilder } from "./template.js";
import { EC2VMBuilder } from "./ec2.js";
import { Config } from "@puls-dev/core";
import { getFileHash } from "@puls-dev/core";
import { Stack } from "@puls-dev/core";

describe("AWS EC2TemplateBuilder Unit Tests", () => {
  let originalSend: any;
  let clientCalls: Array<{ method: string; input?: any }> = [];
  let mockResponses: Record<string, any> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        aws: { region: "us-east-1" },
      },
    });

    clientCalls = [];
    mockResponses = {};
    originalSend = EC2Client.prototype.send;

    EC2Client.prototype.send = async function (command: any) {
      const name = command.constructor.name;
      clientCalls.push({ method: name, input: command.input });

      if (mockResponses[name] !== undefined) {
        const handler = mockResponses[name];
        if (typeof handler === "function") return handler(command.input);
        return handler;
      }
      if (name === "DescribeImagesCommand") {
        return { Images: [] };
      }
      if (name === "DescribeInstancesCommand") {
        return { Reservations: [] };
      }
      if (name === "RunInstancesCommand") {
        return { Instances: [{ InstanceId: "i-temp123" }] };
      }
      if (name === "CreateImageCommand") {
        return { ImageId: "ami-custom456" };
      }
      return {};
    } as any;
  });

  afterEach(() => {
    EC2Client.prototype.send = originalSend;
  });

  test("gracefully handles discovery when Template does not exist", async () => {
    const template = new EC2TemplateBuilder("my-golden-image");
    const existing = await (template as any).discoveryPromise;
    assert.strictEqual(existing, null);
  });

  test("discovers existing Template and skips deployment if hashes match (Idempotence)", async () => {
    const nginxHash = getFileHash("playbooks/nginx.yaml");
    mockResponses["DescribeImagesCommand"] = {
      Images: [
        {
          ImageId: "ami-golden123",
          State: "available",
          Tags: [
            { Key: "Name", Value: "my-docker-base" },
            { Key: "puls-provision", Value: `nginx-yaml=${nginxHash}` },
          ],
        },
      ],
    };

    const template = new EC2TemplateBuilder("my-docker-base")
      .provision("playbooks/nginx.yaml");

    const result = await template.deploy();
    assert.strictEqual(result.amiId, "ami-golden123");

    // Ensure no RunInstances or CreateImage calls were made
    const writes = clientCalls.filter(c => c.method === "RunInstancesCommand" || c.method === "CreateImageCommand");
    assert.strictEqual(writes.length, 0);
  });

  test("purges and rebuilds template if playbooks differ", async () => {
    mockResponses["DescribeImagesCommand"] = (input: any) => {
      // If querying the target name "my-docker-base"
      if (input.Filters?.some((f: any) => f.Name === "name" && f.Values?.includes("my-docker-base"))) {
        return {
          Images: [
            {
              ImageId: "ami-old555",
              State: "available",
              Tags: [
                { Key: "Name", Value: "my-docker-base" },
                { Key: "puls-provision", Value: "nginx-yaml=outdated" },
              ],
              BlockDeviceMappings: [
                { Ebs: { SnapshotId: "snap-old999" } }
              ],
            },
          ],
        };
      }
      // If querying the baked template status "ami-custom456"
      if (input.ImageIds?.includes("ami-custom456")) {
        return {
          Images: [{ ImageId: "ami-custom456", State: "available" }]
        };
      }
      return { Images: [] };
    };

    let describeInstanceCount = 0;
    mockResponses["DescribeInstancesCommand"] = () => {
      describeInstanceCount++;
      return {
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-temp123",
                State: { Name: describeInstanceCount > 1 ? "stopped" : "running" },
                PublicIpAddress: "34.20.10.99",
              }
            ]
          }
        ]
      };
    };

    const template = new EC2TemplateBuilder("my-docker-base")
      .provision("playbooks/nginx.yaml");

    (template as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (template as any).checkPort = async () => true;
    const provisionSpy = mock.method(template as any, "runProvisioner", async () => {});

    const result = await template.deploy();
    assert.strictEqual(result.amiId, "ami-custom456");

    // Verify Deregister and Snapshot delete called
    const deregisterCall = clientCalls.find(c => c.method === "DeregisterImageCommand");
    assert.ok(deregisterCall);
    assert.strictEqual(deregisterCall.input.ImageId, "ami-old555");
    const deleteSnapCall = clientCalls.find(c => c.method === "DeleteSnapshotCommand");
    assert.ok(deleteSnapCall);
    assert.strictEqual(deleteSnapCall.input.SnapshotId, "snap-old999");

    // Verify temp instance was created, stopped, image created, and terminated
    assert.ok(clientCalls.some(c => c.method === "RunInstancesCommand"));
    assert.ok(clientCalls.some(c => c.method === "StopInstancesCommand"));
    assert.ok(clientCalls.some(c => c.method === "CreateImageCommand"));
    assert.ok(clientCalls.some(c => c.method === "TerminateInstancesCommand"));

    // Verify provision script ran on resolved temporary instance IP
    assert.strictEqual(provisionSpy.mock.callCount(), 1);
    assert.strictEqual(provisionSpy.mock.calls[0].arguments[0], "34.20.10.99");
    assert.strictEqual(provisionSpy.mock.calls[0].arguments[1], "playbooks/nginx.yaml");
  });

  test("EC2 instance clones from custom baked template successfully", async () => {
    const nginxHash = getFileHash("playbooks/nginx.yaml");
    mockResponses["DescribeImagesCommand"] = (input: any) => {
      if (input.Filters?.some((f: any) => f.Name === "name" && f.Values?.includes("my-golden-ami"))) {
        return {
          Images: [
            {
              ImageId: "ami-custom777",
              State: "available",
              Tags: [
                { Key: "Name", Value: "my-golden-ami" },
                { Key: "puls-provision", Value: `nginx-yaml=${nginxHash}` },
              ],
            },
          ],
        };
      }
      return { Images: [] };
    };

    let describeCount = 0;
    mockResponses["DescribeInstancesCommand"] = () => {
      describeCount++;
      if (describeCount === 1) return { Reservations: [] }; // VM doesn't exist initially
      return {
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-prod123",
                State: { Name: "running" },
                PublicIpAddress: "34.200.5.5",
              }
            ]
          }
        ]
      };
    };

    mockResponses["RunInstancesCommand"] = {
      Instances: [{ InstanceId: "i-prod123" }],
    };

    class AWSStack extends Stack {
      amiTemplate = new EC2TemplateBuilder("my-golden-ami")
        .provision("playbooks/nginx.yaml");

      server = new EC2VMBuilder("prod-server-01")
        .fromTemplate(this.amiTemplate)
        .instanceType("t3.small");
    }

    const stack = new AWSStack();
    (stack.server as any).waitFor = async () => true;
    (stack.server as any).checkPort = async () => true;

    const result = await stack.deploy();

    // Verify Stack outputs
    assert.strictEqual(result.amiTemplate.amiId, "ami-custom777");
    assert.strictEqual(result.server.id, "i-prod123");

    // Verify VM cloned from dynamic template AMI
    const runInstanceCall = clientCalls.find(c => c.method === "RunInstancesCommand" && c.input?.ImageId === "ami-custom777");
    assert.ok(runInstanceCall);
    assert.strictEqual(runInstanceCall.input.InstanceType, "t3.small");
  });
});
