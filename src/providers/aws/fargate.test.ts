import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { IAMClient } from "@aws-sdk/client-iam";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { FargateBuilder } from "./fargate.js";
import { Config } from "../../core/config.js";

describe("FargateBuilder Unit Tests", () => {
  let originalEcsSend: typeof ECSClient.prototype.send;
  let originalEc2Send: typeof EC2Client.prototype.send;
  let originalIamSend: typeof IAMClient.prototype.send;
  let originalCwSend: typeof CloudWatchLogsClient.prototype.send;

  let ecsCalls: { commandName: string; input: any }[] = [];
  let ec2Calls: { commandName: string; input: any }[] = [];
  let iamCalls: { commandName: string; input: any }[] = [];
  let cwCalls: { commandName: string; input: any }[] = [];

  let mockEcsResponses: Record<string, any> = {};
  let mockEc2Responses: Record<string, any> = {};
  let mockIamResponses: Record<string, any> = {};
  let mockCwResponses: Record<string, any> = {};

  function stubSend(
    calls: { commandName: string; input: any }[],
    responses: Record<string, any>,
  ) {
    return async function (this: any, command: any) {
      const commandName = command.constructor.name;
      calls.push({ commandName, input: command.input });
      const handler = responses[commandName];
      if (handler) {
        if (typeof handler === "function") return handler(command.input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;
  }

  beforeEach(() => {
    Config.set({ dryRun: false, providers: { aws: { region: "us-east-1" } } });

    ecsCalls = [];
    ec2Calls = [];
    iamCalls = [];
    cwCalls = [];
    mockEcsResponses = {};
    mockEc2Responses = {};
    mockIamResponses = {};
    mockCwResponses = {};

    originalEcsSend = ECSClient.prototype.send;
    originalEc2Send = EC2Client.prototype.send;
    originalIamSend = IAMClient.prototype.send;
    originalCwSend = CloudWatchLogsClient.prototype.send;

    ECSClient.prototype.send = stubSend(ecsCalls, mockEcsResponses);
    EC2Client.prototype.send = stubSend(ec2Calls, mockEc2Responses);
    IAMClient.prototype.send = stubSend(iamCalls, mockIamResponses);
    CloudWatchLogsClient.prototype.send = stubSend(cwCalls, mockCwResponses);
  });

  afterEach(() => {
    ECSClient.prototype.send = originalEcsSend;
    EC2Client.prototype.send = originalEc2Send;
    IAMClient.prototype.send = originalIamSend;
    CloudWatchLogsClient.prototype.send = originalCwSend;
    mock.restoreAll();
  });

  test("returns null when cluster does not exist during discovery", async () => {
    mockEcsResponses["DescribeClustersCommand"] = { clusters: [] };

    const builder = new FargateBuilder("my-svc");
    const result = await (builder as any).discoveryPromise;

    assert.strictEqual(result, null);
    assert.strictEqual(ecsCalls[0].commandName, "DescribeClustersCommand");
  });

  test("discovers existing service when cluster and service are active", async () => {
    mockEcsResponses["DescribeClustersCommand"] = {
      clusters: [
        {
          status: "ACTIVE",
          clusterArn: "arn:aws:ecs:us-east-1:123:cluster/puls",
        },
      ],
    };
    mockEcsResponses["DescribeServicesCommand"] = {
      services: [
        {
          status: "ACTIVE",
          serviceArn: "arn:aws:ecs:us-east-1:123:service/puls/my-svc",
        },
      ],
    };

    const builder = new FargateBuilder("my-svc");
    const result = await (builder as any).discoveryPromise;

    assert.ok(result);
    assert.strictEqual(result.status, "ACTIVE");
    assert.strictEqual(
      builder.resolvedArn,
      "arn:aws:ecs:us-east-1:123:service/puls/my-svc",
    );
  });

  test("performs dry-run without any write API calls", async () => {
    Config.set({ dryRun: true, providers: { aws: { region: "us-east-1" } } });
    mockEcsResponses["DescribeClustersCommand"] = { clusters: [] };

    const builder = new FargateBuilder("my-svc");
    builder
      .image("my-org/api:latest")
      .cpu(512)
      .memory(1024)
      .port(3000)
      .replicas(2);

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, "my-svc");
    assert.ok(result.arn!.includes("DRYRUN"));

    const writeCalls = [
      ...ecsCalls,
      ...ec2Calls,
      ...iamCalls,
      ...cwCalls,
    ].filter((c) => !c.commandName.startsWith("Describe"));
    assert.strictEqual(writeCalls.length, 0);
  });

  test("creates new service- registers task def, creates cluster, role, log group, and service", async () => {
    // Discovery: no cluster
    mockEcsResponses["DescribeClustersCommand"] = { clusters: [] };

    // ensureCluster
    mockEcsResponses["CreateClusterCommand"] = {
      cluster: { clusterArn: "arn:aws:ecs:us-east-1:123:cluster/puls" },
    };

    // ensureExecutionRole
    const noRole = new Error("no such entity");
    noRole.name = "NoSuchEntityException";
    mockIamResponses["GetRoleCommand"] = noRole;
    mockIamResponses["CreateRoleCommand"] = {
      Role: { Arn: "arn:aws:iam::123:role/puls-fargate-my-svc-exec-role" },
    };

    // ensureLogGroup
    mockCwResponses["DescribeLogGroupsCommand"] = { logGroups: [] };

    // discoverDefaultVpc
    mockEc2Responses["DescribeVpcsCommand"] = { Vpcs: [{ VpcId: "vpc-abc" }] };
    mockEc2Responses["DescribeSubnetsCommand"] = {
      Subnets: [{ SubnetId: "subnet-1" }, { SubnetId: "subnet-2" }],
    };
    // ensureSecurityGroup
    mockEc2Responses["DescribeSecurityGroupsCommand"] = { SecurityGroups: [] };
    mockEc2Responses["CreateSecurityGroupCommand"] = { GroupId: "sg-xyz" };

    // RegisterTaskDefinition + CreateService
    mockEcsResponses["RegisterTaskDefinitionCommand"] = {
      taskDefinition: {
        taskDefinitionArn: "arn:aws:ecs:us-east-1:123:task-def/my-svc:1",
        revision: 1,
      },
    };
    mockEcsResponses["CreateServiceCommand"] = {
      service: { serviceArn: "arn:aws:ecs:us-east-1:123:service/puls/my-svc" },
    };

    const builder = new FargateBuilder("my-svc");
    builder
      .image("my-org/api:latest")
      .cpu(512)
      .memory(1024)
      .port(3000)
      .replicas(2);

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, "my-svc");
    assert.strictEqual(
      result.arn,
      "arn:aws:ecs:us-east-1:123:service/puls/my-svc",
    );

    const createSvc = ecsCalls.find(
      (c) => c.commandName === "CreateServiceCommand",
    );
    assert.ok(createSvc);
    assert.strictEqual(createSvc.input.desiredCount, 2);

    const registerDef = ecsCalls.find(
      (c) => c.commandName === "RegisterTaskDefinitionCommand",
    );
    assert.ok(registerDef);
    assert.strictEqual(registerDef.input.cpu, "512");
    assert.strictEqual(registerDef.input.memory, "1024");
  });

  test("updates existing service with new task definition", async () => {
    mockEcsResponses["DescribeClustersCommand"] = {
      clusters: [
        {
          status: "ACTIVE",
          clusterArn: "arn:aws:ecs:us-east-1:123:cluster/puls",
        },
      ],
    };
    mockEcsResponses["DescribeServicesCommand"] = {
      services: [
        {
          status: "ACTIVE",
          serviceArn: "arn:aws:ecs:us-east-1:123:service/puls/my-svc",
        },
      ],
    };

    // ensureCluster (existing)
    mockEcsResponses["CreateClusterCommand"] = {};

    // ensureExecutionRole (existing)
    mockIamResponses["GetRoleCommand"] = {
      Role: { Arn: "arn:aws:iam::123:role/puls-fargate-my-svc-exec-role" },
    };

    // ensureLogGroup (existing)
    mockCwResponses["DescribeLogGroupsCommand"] = {
      logGroups: [{ logGroupName: "/puls/my-svc" }],
    };

    // networking (existing SGs provided)
    const builder = new FargateBuilder("my-svc");
    builder
      .image("my-org/api:v2")
      .subnets(["subnet-1"])
      .securityGroups(["sg-1"])
      .replicas(3);

    mockEcsResponses["RegisterTaskDefinitionCommand"] = {
      taskDefinition: {
        taskDefinitionArn: "arn:aws:ecs:us-east-1:123:task-def/my-svc:2",
        revision: 2,
      },
    };
    mockEcsResponses["UpdateServiceCommand"] = {};

    await builder.deploy();

    const updateSvc = ecsCalls.find(
      (c) => c.commandName === "UpdateServiceCommand",
    );
    assert.ok(updateSvc);
    assert.strictEqual(updateSvc.input.desiredCount, 3);
    assert.strictEqual(updateSvc.input.forceNewDeployment, true);
  });

  test("drains and deletes service on destroy", async () => {
    mockEcsResponses["DescribeClustersCommand"] = {
      clusters: [{ status: "ACTIVE" }],
    };
    mockEcsResponses["DescribeServicesCommand"] = {
      services: [
        {
          status: "ACTIVE",
          serviceArn: "arn:aws:ecs:us-east-1:123:service/puls/my-svc",
        },
      ],
    };

    const builder = new FargateBuilder("my-svc");
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: "my-svc" });

    const drain = ecsCalls.find(
      (c) =>
        c.commandName === "UpdateServiceCommand" && c.input.desiredCount === 0,
    );
    assert.ok(drain);

    const del = ecsCalls.find((c) => c.commandName === "DeleteServiceCommand");
    assert.ok(del);
    assert.strictEqual(del.input.force, true);
  });

  test("skips destroy when service does not exist", async () => {
    mockEcsResponses["DescribeClustersCommand"] = { clusters: [] };

    const builder = new FargateBuilder("my-svc");
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: "my-svc" });
    assert.ok(!ecsCalls.some((c) => c.commandName === "DeleteServiceCommand"));
  });
});
