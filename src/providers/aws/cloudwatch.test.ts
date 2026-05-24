import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { SNSClient } from "@aws-sdk/client-sns";
import { ECSClient } from "@aws-sdk/client-ecs";
import { RDSClient } from "@aws-sdk/client-rds";
import { CloudWatchAlarmBuilder } from "./cloudwatch.js";
import { SNSTopicBuilder } from "./sns.js";
import { FargateBuilder } from "./fargate.js";
import { RDSBuilder } from "./rds.js";
import { Config } from "../../core/config.js";

describe("CloudWatchAlarmBuilder Unit Tests", () => {
  let originalCwSend: typeof CloudWatchClient.prototype.send;
  let originalSnsSend: typeof SNSClient.prototype.send;
  let originalEcsSend: typeof ECSClient.prototype.send;
  let originalRdsSend: typeof RDSClient.prototype.send;
  let cwCalls: Array<{ commandName: string; input: any }> = [];
  let mockCwResponses: Record<string, any> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        aws: { region: "us-east-1" },
      },
    });

    cwCalls = [];
    mockCwResponses = {};

    originalCwSend = CloudWatchClient.prototype.send;
    originalSnsSend = SNSClient.prototype.send;
    originalEcsSend = ECSClient.prototype.send;
    originalRdsSend = RDSClient.prototype.send;

    CloudWatchClient.prototype.send = async function (command: any) {
      const commandName = command.constructor.name;
      const input = command.input;
      cwCalls.push({ commandName, input });

      if (mockCwResponses[commandName]) {
        const handler = mockCwResponses[commandName];
        if (typeof handler === "function") return handler(input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;

    SNSClient.prototype.send = async function (command: any) {
      return {};
    } as any;

    ECSClient.prototype.send = async function (command: any) {
      return {};
    } as any;

    RDSClient.prototype.send = async function (command: any) {
      return {};
    } as any;
  });

  afterEach(() => {
    CloudWatchClient.prototype.send = originalCwSend;
    SNSClient.prototype.send = originalSnsSend;
    ECSClient.prototype.send = originalEcsSend;
    RDSClient.prototype.send = originalRdsSend;
  });

  test("gracefully handles discovery when alarm does not exist", async () => {
    mockCwResponses["DescribeAlarmsCommand"] = { MetricAlarms: [] };

    const builder = new CloudWatchAlarmBuilder("my-alarm");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.ok(cwCalls.some((c) => c.commandName === "DescribeAlarmsCommand"));
  });

  test("discovers existing alarm successfully", async () => {
    mockCwResponses["DescribeAlarmsCommand"] = {
      MetricAlarms: [
        {
          AlarmName: "my-alarm",
          AlarmArn: "arn:aws:cloudwatch:us-east-1:123456789012:alarm:my-alarm",
        },
      ],
    };

    const builder = new CloudWatchAlarmBuilder("my-alarm");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(builder.resolvedArn, "arn:aws:cloudwatch:us-east-1:123456789012:alarm:my-alarm");

    const resolvedArn = await builder.out.arn.get();
    assert.strictEqual(resolvedArn, "arn:aws:cloudwatch:us-east-1:123456789012:alarm:my-alarm");
  });

  test("creates a custom metric alarm", async () => {
    mockCwResponses["DescribeAlarmsCommand"] = { MetricAlarms: [] };

    const builder = new CloudWatchAlarmBuilder("custom-alarm")
      .metric("MyCustomNamespace", "Errors", { Service: "checkout" })
      .comparison("GreaterThanThreshold")
      .threshold(10)
      .period(60)
      .evaluationPeriods(2)
      .statistic("Sum");

    await builder.deploy();

    const putCall = cwCalls.find((c) => c.commandName === "PutMetricAlarmCommand");
    assert.ok(putCall);
    assert.deepStrictEqual(putCall.input, {
      AlarmName: "custom-alarm",
      ComparisonOperator: "GreaterThanThreshold",
      EvaluationPeriods: 2,
      MetricName: "Errors",
      Namespace: "MyCustomNamespace",
      Period: 60,
      Threshold: 10,
      Statistic: "Sum",
      ActionsEnabled: false,
      AlarmActions: undefined,
      Dimensions: [{ Name: "Service", Value: "checkout" }],
    });
  });

  test("auto-wires specialized Fargate CPU and memory helper alarms", async () => {
    mockCwResponses["DescribeAlarmsCommand"] = { MetricAlarms: [] };

    const fargate = new FargateBuilder("my-api-service").cluster("my-prod-cluster");

    const cpuAlarm = new CloudWatchAlarmBuilder("fargate-cpu")
      .fargateCPU(fargate, 80)
      .evaluationPeriods(3);

    await cpuAlarm.deploy();

    const cpuPutCall = cwCalls.find(
      (c) => c.commandName === "PutMetricAlarmCommand" && c.input.AlarmName === "fargate-cpu"
    );
    assert.ok(cpuPutCall);
    assert.deepStrictEqual(cpuPutCall.input, {
      AlarmName: "fargate-cpu",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 3,
      MetricName: "CPUUtilization",
      Namespace: "AWS/ECS",
      Period: 300,
      Threshold: 80,
      Statistic: "Average",
      ActionsEnabled: false,
      AlarmActions: undefined,
      Dimensions: [
        { Name: "ClusterName", Value: "my-prod-cluster" },
        { Name: "ServiceName", Value: "my-api-service" },
      ],
    });

    const memAlarm = new CloudWatchAlarmBuilder("fargate-mem").fargateMemory(fargate, 85);
    await memAlarm.deploy();

    const memPutCall = cwCalls.find(
      (c) => c.commandName === "PutMetricAlarmCommand" && c.input.AlarmName === "fargate-mem"
    );
    assert.ok(memPutCall);
    assert.deepStrictEqual(memPutCall.input.MetricName, "MemoryUtilization");
    assert.deepStrictEqual(memPutCall.input.Namespace, "AWS/ECS");
    assert.deepStrictEqual(memPutCall.input.Threshold, 85);
  });

  test("auto-wires specialized RDS CPU and storage helper alarms", async () => {
    mockCwResponses["DescribeAlarmsCommand"] = { MetricAlarms: [] };

    const rds = new RDSBuilder("my-database");

    const cpuAlarm = new CloudWatchAlarmBuilder("rds-cpu").rdsCPU(rds, 90);
    await cpuAlarm.deploy();

    const cpuPutCall = cwCalls.find(
      (c) => c.commandName === "PutMetricAlarmCommand" && c.input.AlarmName === "rds-cpu"
    );
    assert.ok(cpuPutCall);
    assert.deepStrictEqual(cpuPutCall.input, {
      AlarmName: "rds-cpu",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      MetricName: "CPUUtilization",
      Namespace: "AWS/RDS",
      Period: 300,
      Threshold: 90,
      Statistic: "Average",
      ActionsEnabled: false,
      AlarmActions: undefined,
      Dimensions: [{ Name: "DBInstanceIdentifier", Value: "my-database" }],
    });

    const storageAlarm = new CloudWatchAlarmBuilder("rds-storage").rdsStorage(rds, 5000000000);
    await storageAlarm.deploy();

    const storagePutCall = cwCalls.find(
      (c) => c.commandName === "PutMetricAlarmCommand" && c.input.AlarmName === "rds-storage"
    );
    assert.ok(storagePutCall);
    assert.strictEqual(storagePutCall.input.ComparisonOperator, "LessThanThreshold");
    assert.strictEqual(storagePutCall.input.MetricName, "FreeStorageSpace");
    assert.strictEqual(storagePutCall.input.Namespace, "AWS/RDS");
    assert.strictEqual(storagePutCall.input.Threshold, 5000000000);
  });

  test("integrates with SNSTopicBuilder eagerly by awaiting its ARN", async () => {
    mockCwResponses["DescribeAlarmsCommand"] = { MetricAlarms: [] };

    // Set up a mock topic
    const topic = new SNSTopicBuilder("alert-topic");
    topic.resolvedArn = "arn:aws:sns:us-east-1:123456789012:alert-topic";
    topic.out.arn.resolve("arn:aws:sns:us-east-1:123456789012:alert-topic");

    const alarm = new CloudWatchAlarmBuilder("metric-alarm")
      .metric("AWS/Billing", "EstimatedCharges")
      .comparison("GreaterThanThreshold")
      .threshold(100)
      .actions(topic);

    await alarm.deploy();

    const putCall = cwCalls.find((c) => c.commandName === "PutMetricAlarmCommand");
    assert.ok(putCall);
    assert.strictEqual(putCall.input.ActionsEnabled, true);
    assert.deepStrictEqual(putCall.input.AlarmActions, [
      "arn:aws:sns:us-east-1:123456789012:alert-topic",
    ]);
  });

  test("destroys an existing alarm successfully", async () => {
    mockCwResponses["DescribeAlarmsCommand"] = {
      MetricAlarms: [
        {
          AlarmName: "my-alarm",
          AlarmArn: "arn:aws:cloudwatch:us-east-1:123456789012:alarm:my-alarm",
        },
      ],
    };

    const builder = new CloudWatchAlarmBuilder("my-alarm");
    await (builder as any).discoveryPromise;

    const destroyResult = await builder.destroy();
    assert.deepStrictEqual(destroyResult, { destroyed: "my-alarm" });

    const deleteCall = cwCalls.find((c) => c.commandName === "DeleteAlarmsCommand");
    assert.ok(deleteCall);
    assert.deepStrictEqual(deleteCall.input.AlarmNames, ["my-alarm"]);
  });

  test("runs in dry run mode safely", async () => {
    Config.set({
      dryRun: true,
      providers: {
        aws: { region: "us-east-1" },
      },
    });

    const builder = new CloudWatchAlarmBuilder("my-alarm")
      .metric("AWS/Billing", "EstimatedCharges")
      .comparison("GreaterThanThreshold")
      .threshold(50);

    const deployResult = await builder.deploy();
    assert.ok(deployResult.arn!.includes("DRYRUN"));
    assert.ok(!cwCalls.some((c) => c.commandName === "PutMetricAlarmCommand"));
  });
});
