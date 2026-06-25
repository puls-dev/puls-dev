import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { SNSClient } from "@aws-sdk/client-sns";
import { SNSTopicBuilder } from "./sns.js";
import { Config } from "@puls-dev/core";

describe("SNSTopicBuilder Unit Tests", () => {
  let originalSnsSend: typeof SNSClient.prototype.send;
  let snsCalls: Array<{ commandName: string; input: any }> = [];
  let mockSnsResponses: Record<string, any> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        aws: { region: "us-east-1" },
      },
    });

    snsCalls = [];
    mockSnsResponses = {};

    originalSnsSend = SNSClient.prototype.send;

    SNSClient.prototype.send = async function (command: any) {
      const commandName = command.constructor.name;
      const input = command.input;
      snsCalls.push({ commandName, input });

      if (mockSnsResponses[commandName]) {
        const handler = mockSnsResponses[commandName];
        if (typeof handler === "function") return handler(input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;
  });

  afterEach(() => {
    SNSClient.prototype.send = originalSnsSend;
  });

  test("gracefully handles discovery when topic does not exist", async () => {
    mockSnsResponses["ListTopicsCommand"] = { Topics: [] };

    const builder = new SNSTopicBuilder("my-topic");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.ok(snsCalls.some((c) => c.commandName === "ListTopicsCommand"));
  });

  test("discovers existing topic by matching name", async () => {
    mockSnsResponses["ListTopicsCommand"] = {
      Topics: [{ TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic" }],
    };
    mockSnsResponses["GetTopicAttributesCommand"] = {
      Attributes: { DisplayName: "My Friendly Topic" },
    };

    const builder = new SNSTopicBuilder("my-topic");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(builder.resolvedArn, "arn:aws:sns:us-east-1:123456789012:my-topic");
    assert.strictEqual(builder.resolvedDisplayName, "My Friendly Topic");

    const resolvedArn = await builder.out.arn.get();
    assert.strictEqual(resolvedArn, "arn:aws:sns:us-east-1:123456789012:my-topic");
  });

  test("creates a new topic with display name and subscriptions", async () => {
    mockSnsResponses["ListTopicsCommand"] = { Topics: [] };
    mockSnsResponses["CreateTopicCommand"] = {
      TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic",
    };
    mockSnsResponses["ListSubscriptionsByTopicCommand"] = { Subscriptions: [] };

    const builder = new SNSTopicBuilder("my-topic")
      .displayName("Cool Alert")
      .subscribe("email", "ops@company.com")
      .subscribe("sms", "+15555555555");

    const deployResult = await builder.deploy();

    assert.strictEqual(deployResult.arn, "arn:aws:sns:us-east-1:123456789012:my-topic");
    assert.strictEqual(builder.resolvedArn, "arn:aws:sns:us-east-1:123456789012:my-topic");

    const createCall = snsCalls.find((c) => c.commandName === "CreateTopicCommand");
    assert.ok(createCall);
    assert.deepStrictEqual(createCall.input, {
      Name: "my-topic",
      Attributes: { DisplayName: "Cool Alert" },
    });

    const subscribeCalls = snsCalls.filter((c) => c.commandName === "SubscribeCommand");
    assert.strictEqual(subscribeCalls.length, 2);
    assert.deepStrictEqual(subscribeCalls[0].input, {
      TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic",
      Protocol: "email",
      Endpoint: "ops@company.com",
    });
    assert.deepStrictEqual(subscribeCalls[1].input, {
      TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic",
      Protocol: "sms",
      Endpoint: "+15555555555",
    });
  });

  test("syncs subscriptions correctly - unsubscribes stale and skips active", async () => {
    mockSnsResponses["ListTopicsCommand"] = {
      Topics: [{ TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic" }],
    };
    mockSnsResponses["GetTopicAttributesCommand"] = {
      Attributes: { DisplayName: "Cool Alert" },
    };
    mockSnsResponses["ListSubscriptionsByTopicCommand"] = {
      Subscriptions: [
        {
          SubscriptionArn: "arn:aws:sns:us-east-1:123456789012:my-topic:sub1",
          Protocol: "email",
          Endpoint: "keep-me@company.com",
          TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic",
        },
        {
          SubscriptionArn: "arn:aws:sns:us-east-1:123456789012:my-topic:sub2",
          Protocol: "email",
          Endpoint: "delete-me@company.com",
          TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic",
        },
      ],
    };

    const builder = new SNSTopicBuilder("my-topic")
      .displayName("Cool Alert")
      .subscribe("email", "keep-me@company.com")
      .subscribe("sms", "+19999999999");

    await builder.deploy();

    // Verify unsubscribe was called for stale one
    const unsubscribeCall = snsCalls.find((c) => c.commandName === "UnsubscribeCommand");
    assert.ok(unsubscribeCall);
    assert.strictEqual(
      unsubscribeCall.input.SubscriptionArn,
      "arn:aws:sns:us-east-1:123456789012:my-topic:sub2"
    );

    // Verify subscribe was called for the new sms one, but NOT for keep-me@company.com
    const subscribeCalls = snsCalls.filter((c) => c.commandName === "SubscribeCommand");
    assert.strictEqual(subscribeCalls.length, 1);
    assert.deepStrictEqual(subscribeCalls[0].input, {
      TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic",
      Protocol: "sms",
      Endpoint: "+19999999999",
    });
  });

  test("destroys an existing topic successfully", async () => {
    mockSnsResponses["ListTopicsCommand"] = {
      Topics: [{ TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic" }],
    };

    const builder = new SNSTopicBuilder("my-topic");
    await (builder as any).discoveryPromise;

    const destroyResult = await builder.destroy();
    assert.deepStrictEqual(destroyResult, { destroyed: "my-topic" });

    const deleteCall = snsCalls.find((c) => c.commandName === "DeleteTopicCommand");
    assert.ok(deleteCall);
    assert.strictEqual(deleteCall.input.TopicArn, "arn:aws:sns:us-east-1:123456789012:my-topic");
  });

  test("runs in dry run mode safely", async () => {
    Config.set({
      dryRun: true,
      providers: {
        aws: { region: "us-east-1" },
      },
    });

    mockSnsResponses["ListTopicsCommand"] = { Topics: [] };

    const builder = new SNSTopicBuilder("my-topic")
      .displayName("Cool Alert")
      .subscribe("email", "ops@company.com");

    const deployResult = await builder.deploy();
    assert.ok(deployResult.arn!.includes("DRYRUN"));

    // No create topic or subscribe commands should be called in real mode
    assert.ok(!snsCalls.some((c) => c.commandName === "CreateTopicCommand"));
    assert.ok(!snsCalls.some((c) => c.commandName === "SubscribeCommand"));
  });
});
