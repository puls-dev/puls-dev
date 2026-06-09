import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { RDSClient } from "@aws-sdk/client-rds";
import { EC2Client } from "@aws-sdk/client-ec2";
import { RDSBuilder } from "./rds.js";
import { Config } from "../../core/config.js";

describe("RDSBuilder Unit Tests", () => {
  let originalRdsSend: typeof RDSClient.prototype.send;
  let originalEc2Send: typeof EC2Client.prototype.send;
  let rdsCalls: { commandName: string; input: any }[] = [];
  let ec2Calls: { commandName: string; input: any }[] = [];
  let mockRdsResponses: Record<string, any> = {};
  let mockEc2Responses: Record<string, any> = {};

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
    rdsCalls = [];
    ec2Calls = [];
    mockRdsResponses = {};
    mockEc2Responses = {};

    originalRdsSend = RDSClient.prototype.send;
    originalEc2Send = EC2Client.prototype.send;

    RDSClient.prototype.send = stubSend(rdsCalls, mockRdsResponses);
    EC2Client.prototype.send = stubSend(ec2Calls, mockEc2Responses);
  });

  afterEach(() => {
    RDSClient.prototype.send = originalRdsSend;
    EC2Client.prototype.send = originalEc2Send;
    mock.restoreAll();
  });

  test("returns null when DB instance is not found during discovery", async () => {
    const err = new Error("not found");
    err.name = "DBInstanceNotFound";
    mockRdsResponses["DescribeDBInstancesCommand"] = err;

    const builder = new RDSBuilder("my-db");
    const result = await (builder as any).discoveryPromise;

    assert.strictEqual(result, null);
    assert.strictEqual(rdsCalls[0].commandName, "DescribeDBInstancesCommand");
  });

  test("discovers existing instance and populates resolved fields", async () => {
    mockRdsResponses["DescribeDBInstancesCommand"] = {
      DBInstances: [
        {
          DBInstanceIdentifier: "my-db",
          DBInstanceStatus: "available",
          DBInstanceArn: "arn:aws:rds:us-east-1:123:db:my-db",
          Endpoint: {
            Address: "my-db.xyz.us-east-1.rds.amazonaws.com",
            Port: 5432,
          },
        },
      ],
    };

    const builder = new RDSBuilder("my-db");
    const result = await (builder as any).discoveryPromise;

    assert.ok(result);
    assert.strictEqual(
      builder.resolvedArn,
      "arn:aws:rds:us-east-1:123:db:my-db",
    );
    assert.strictEqual(
      builder.resolvedEndpoint,
      "my-db.xyz.us-east-1.rds.amazonaws.com",
    );
    assert.strictEqual(builder.resolvedPort, 5432);
  });

  test("performs dry-run without any write API calls", async () => {
    Config.set({ dryRun: true, providers: { aws: { region: "us-east-1" } } });
    const err = new Error("not found");
    err.name = "DBInstanceNotFound";
    mockRdsResponses["DescribeDBInstancesCommand"] = err;

    const builder = new RDSBuilder("my-db");
    builder
      .engine({ engine: "postgres", version: "16" })
      .size("db.t3.micro")
      .storage(20);

    const result = await builder.deploy();

    assert.ok(result);
    assert.ok(result.endpoint!.includes("DRYRUN"));
    assert.strictEqual(result.port, 5432);

    const writeCalls = rdsCalls.filter(
      (c) => !c.commandName.startsWith("Describe"),
    );
    assert.strictEqual(writeCalls.length, 0);
  });

  test("creates new DB instance with subnet group and security group", async () => {
    const err = new Error("not found");
    err.name = "DBInstanceNotFound";
    mockRdsResponses["DescribeDBInstancesCommand"] = err;

    // ensureSubnetGroup
    const noGroup = new Error("not found");
    noGroup.name = "DBSubnetGroupNotFoundFault";
    mockRdsResponses["DescribeDBSubnetGroupsCommand"] = noGroup;
    mockRdsResponses["CreateDBSubnetGroupCommand"] = {};

    // ensureSecurityGroup
    mockEc2Responses["DescribeVpcsCommand"] = {
      Vpcs: [{ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16" }],
    };
    mockEc2Responses["DescribeSubnetsCommand"] = {
      Subnets: [{ SubnetId: "subnet-1" }],
    };
    mockEc2Responses["DescribeSecurityGroupsCommand"] = { SecurityGroups: [] };
    mockEc2Responses["CreateSecurityGroupCommand"] = { GroupId: "sg-1" };

    // CreateDBInstance- return available immediately so the waitFor resolves
    mockRdsResponses["CreateDBInstanceCommand"] = {};
    let describeCount = 0;
    mockRdsResponses["DescribeDBInstancesCommand"] = (input: any) => {
      describeCount++;
      if (describeCount === 1) {
        // First call: discovery in constructor- instance not found
        const notFound = new Error("not found");
        notFound.name = "DBInstanceNotFound";
        throw notFound;
      }
      // Subsequent calls: waitFor polling- instance now available
      return {
        DBInstances: [
          {
            DBInstanceIdentifier: "my-db",
            DBInstanceStatus: "available",
            DBInstanceArn: "arn:aws:rds:us-east-1:123:db:my-db",
            Endpoint: { Address: "my-db.xyz.rds.amazonaws.com", Port: 5432 },
          },
        ],
      };
    };

    // Fast-forward poll timer
    mock.method(global, "setTimeout", (fn: any) => fn());

    const builder = new RDSBuilder("my-db");
    builder
      .engine({ engine: "postgres", version: "16" })
      .size("db.t3.small")
      .storage(40)
      .credentials("admin", "secret");

    const result = await builder.deploy();

    assert.ok(result);

    const createCall = rdsCalls.find(
      (c) => c.commandName === "CreateDBInstanceCommand",
    );
    assert.ok(createCall);
    assert.strictEqual(createCall.input.DBInstanceIdentifier, "my-db");
    assert.strictEqual(createCall.input.Engine, "postgres");
    assert.strictEqual(createCall.input.EngineVersion, "16");
    assert.strictEqual(createCall.input.DBInstanceClass, "db.t3.small");
    assert.strictEqual(createCall.input.AllocatedStorage, 40);
  });

  test("modifies existing instance on update", async () => {
    mockRdsResponses["DescribeDBInstancesCommand"] = {
      DBInstances: [
        {
          DBInstanceIdentifier: "my-db",
          DBInstanceStatus: "available",
          DBInstanceArn: "arn:aws:rds:us-east-1:123:db:my-db",
          Endpoint: { Address: "my-db.xyz.rds.amazonaws.com", Port: 5432 },
        },
      ],
    };

    // ensureSubnetGroup (existing)
    mockRdsResponses["DescribeDBSubnetGroupsCommand"] = {
      DBSubnetGroups: [{ DBSubnetGroupName: "puls-my-db-subnet-group" }],
    };

    const builder = new RDSBuilder("my-db");
    builder
      .engine({ engine: "postgres", version: "16" })
      .size("db.t3.medium")
      .subnets(["subnet-1"])
      .securityGroups(["sg-1"])
      .credentials("admin", "secret");

    await builder.deploy();

    const modifyCall = rdsCalls.find(
      (c) => c.commandName === "ModifyDBInstanceCommand",
    );
    assert.ok(modifyCall);
    assert.strictEqual(modifyCall.input.DBInstanceClass, "db.t3.medium");
    assert.strictEqual(modifyCall.input.ApplyImmediately, true);
  });

  test("deletes instance on destroy", async () => {
    mockRdsResponses["DescribeDBInstancesCommand"] = {
      DBInstances: [
        {
          DBInstanceIdentifier: "my-db",
          DBInstanceStatus: "available",
          DBInstanceArn: "arn:aws:rds:us-east-1:123:db:my-db",
          Endpoint: { Address: "my-db.xyz.rds.amazonaws.com", Port: 5432 },
        },
      ],
    };

    const builder = new RDSBuilder("my-db");
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: "my-db" });

    const deleteCall = rdsCalls.find(
      (c) => c.commandName === "DeleteDBInstanceCommand",
    );
    assert.ok(deleteCall);
    assert.strictEqual(deleteCall.input.DBInstanceIdentifier, "my-db");
    assert.strictEqual(deleteCall.input.SkipFinalSnapshot, true);
  });

  test("getDiff returns field changes against live state", () => {
    const err = new Error("not found");
    err.name = "DBInstanceNotFound";
    mockRdsResponses["DescribeDBInstancesCommand"] = err;

    const builder = new RDSBuilder("my-db");
    builder
      .engine({ engine: "postgres", version: "16" })
      .size("db.t3.small")
      .storage(40);

    const diffs = builder.getDiff({
      Engine: "postgres",
      EngineVersion: "15", // differs
      DBInstanceClass: "db.t3.micro", // differs
      AllocatedStorage: 40,
      PubliclyAccessible: false,
    });

    assert.strictEqual(diffs.length, 2);
    assert.ok(diffs.some((d) => d.field === "engineVersion"));
    assert.ok(diffs.some((d) => d.field === "instanceClass"));
  });
});
