import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { GoogleAuth } from "google-auth-library";
import { GCPPubSubTopicBuilder, GCPPubSubSubscriptionBuilder } from "./pubsub.js";
import { Config } from "@puls-dev/core";

describe("GCPPubSub Unit Tests", () => {
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
        json: async () => ({ message: `Endpoint not mocked: ${method} ${url}` }),
        text: async () => `Endpoint not mocked: ${method} ${url}`,
      } as Response;
    };

    mock.method(GoogleAuth.prototype, "getClient", async () => {
      return {
        getAccessToken: async () => ({ token: "fake-gcp-token" }),
      };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  describe("GCPPubSubTopicBuilder", () => {
    test("runs in dry-run mode safely and logs plans", async () => {
      Config.set({
        dryRun: true,
      });

      mockResponses["GET /topics/dryrun-topic"] = {
        status: 404,
        body: {},
      };

      const builder = new GCPPubSubTopicBuilder("dryrun-topic");
      const result = await builder.deploy();

      assert.strictEqual(result.name, "dryrun-topic");
      assert.strictEqual(result.topicName, "projects/my-gcp-project/topics/dryrun-topic");

      const writeCalls = fetchCalls.filter((c) => c.method !== "GET");
      assert.strictEqual(writeCalls.length, 0);
    });

    test("creates a new topic when missing", async () => {
      mockResponses["GET /topics/new-topic"] = {
        status: 404,
        body: {},
      };

      mockResponses["PUT /topics/new-topic"] = {
        status: 200,
        body: { name: "projects/my-gcp-project/topics/new-topic" },
      };

      const builder = new GCPPubSubTopicBuilder("new-topic");
      const result = await builder.deploy();

      assert.strictEqual(result.name, "new-topic");
      assert.strictEqual(result.topicName, "projects/my-gcp-project/topics/new-topic");

      const putCall = fetchCalls.find((c) => c.method === "PUT" && c.url.includes("/topics/new-topic"));
      assert.ok(putCall);
    });

    test("skips creation if topic already exists", async () => {
      mockResponses["GET /topics/exist-topic"] = {
        status: 200,
        body: { name: "projects/my-gcp-project/topics/exist-topic" },
      };

      const builder = new GCPPubSubTopicBuilder("exist-topic");
      const result = await builder.deploy();

      assert.strictEqual(result.name, "exist-topic");
      assert.strictEqual(result.topicName, "projects/my-gcp-project/topics/exist-topic");

      const writeCalls = fetchCalls.filter((c) => c.method !== "GET");
      assert.strictEqual(writeCalls.length, 0);
    });

    test("destroys an existing topic successfully", async () => {
      mockResponses["GET /topics/delete-topic"] = {
        status: 200,
        body: { name: "projects/my-gcp-project/topics/delete-topic" },
      };

      mockResponses["DELETE /topics/delete-topic"] = {
        status: 200,
        body: {},
      };

      const builder = new GCPPubSubTopicBuilder("delete-topic");
      const result = await builder.destroy();

      assert.deepStrictEqual(result, { destroyed: "delete-topic" });

      const deleteCall = fetchCalls.find((c) => c.method === "DELETE" && c.url.includes("/topics/delete-topic"));
      assert.ok(deleteCall);
    });
  });

  describe("GCPPubSubSubscriptionBuilder", () => {
    test("fluent builder api sets properties and binds topic references", () => {
      const topic = new GCPPubSubTopicBuilder("my-t");
      topic.resolvedTopicName = "projects/my-gcp-project/topics/my-t";

      const builder = new GCPPubSubSubscriptionBuilder("my-sub")
        .topic(topic)
        .pushEndpoint("https://my-endpoint.com/push")
        .ackDeadline(30);

      assert.strictEqual((builder as any)._topic, topic);
      assert.strictEqual((builder as any)._pushEndpoint, "https://my-endpoint.com/push");
      assert.strictEqual((builder as any)._ackDeadlineSeconds, 30);
    });

    test("creates pull subscription when missing", async () => {
      mockResponses["GET /subscriptions/new-pull-sub"] = {
        status: 404,
        body: {},
      };

      mockResponses["PUT /subscriptions/new-pull-sub"] = {
        status: 200,
        body: { name: "projects/my-gcp-project/subscriptions/new-pull-sub" },
      };

      const builder = new GCPPubSubSubscriptionBuilder("new-pull-sub")
        .topic("my-t")
        .ackDeadline(20);

      const result = await builder.deploy();
      assert.strictEqual(result.name, "new-pull-sub");
      assert.strictEqual(result.subscriptionName, "projects/my-gcp-project/subscriptions/new-pull-sub");

      const putCall = fetchCalls.find((c) => c.method === "PUT" && c.url.includes("/subscriptions/new-pull-sub"));
      assert.ok(putCall);
      assert.strictEqual(putCall.body.topic, "projects/my-gcp-project/topics/my-t");
      assert.deepStrictEqual(putCall.body.pushConfig, {});
      assert.strictEqual(putCall.body.ackDeadlineSeconds, 20);
    });

    test("creates push subscription when missing", async () => {
      mockResponses["GET /subscriptions/new-push-sub"] = {
        status: 404,
        body: {},
      };

      mockResponses["PUT /subscriptions/new-push-sub"] = {
        status: 200,
        body: { name: "projects/my-gcp-project/subscriptions/new-push-sub" },
      };

      const builder = new GCPPubSubSubscriptionBuilder("new-push-sub")
        .topic("my-t")
        .pushEndpoint("https://my-app.run.app/push");

      const result = await builder.deploy();
      assert.strictEqual(result.name, "new-push-sub");

      const putCall = fetchCalls.find((c) => c.method === "PUT" && c.url.includes("/subscriptions/new-push-sub"));
      assert.ok(putCall);
      assert.strictEqual(putCall.body.pushConfig.pushEndpoint, "https://my-app.run.app/push");
    });

    test("patches subscription if endpoints differ", async () => {
      mockResponses["GET /subscriptions/existing-sub"] = {
        status: 200,
        body: {
          name: "projects/my-gcp-project/subscriptions/existing-sub",
          topic: "projects/my-gcp-project/topics/my-t",
          pushConfig: { pushEndpoint: "https://old-endpoint.com" },
          ackDeadlineSeconds: 10,
        },
      };

      mockResponses["PATCH /subscriptions/existing-sub"] = {
        status: 200,
        body: { name: "projects/my-gcp-project/subscriptions/existing-sub" },
      };

      const builder = new GCPPubSubSubscriptionBuilder("existing-sub")
        .topic("my-t")
        .pushEndpoint("https://new-endpoint.com"); // endpoint changed!

      const result = await builder.deploy();
      assert.strictEqual(result.name, "existing-sub");

      const patchCall = fetchCalls.find((c) => c.method === "PATCH" && c.url.includes("/subscriptions/existing-sub"));
      assert.ok(patchCall);
      assert.strictEqual(patchCall.body.subscription.pushConfig.pushEndpoint, "https://new-endpoint.com");
      assert.strictEqual(patchCall.body.updateMask, "topic,pushConfig,ackDeadlineSeconds");
    });

    test("skips patching if identical", async () => {
      mockResponses["GET /subscriptions/ident-sub"] = {
        status: 200,
        body: {
          name: "projects/my-gcp-project/subscriptions/ident-sub",
          topic: "projects/my-gcp-project/topics/my-t",
          pushConfig: { pushEndpoint: "https://endpoint.com" },
          ackDeadlineSeconds: 20,
        },
      };

      const builder = new GCPPubSubSubscriptionBuilder("ident-sub")
        .topic("my-t")
        .pushEndpoint("https://endpoint.com")
        .ackDeadline(20);

      const result = await builder.deploy();
      assert.strictEqual(result.name, "ident-sub");

      const writeCalls = fetchCalls.filter((c) => c.method !== "GET");
      assert.strictEqual(writeCalls.length, 0);
    });

    test("destroys an existing subscription successfully", async () => {
      mockResponses["GET /subscriptions/delete-sub"] = {
        status: 200,
        body: { name: "projects/my-gcp-project/subscriptions/delete-sub" },
      };

      mockResponses["DELETE /subscriptions/delete-sub"] = {
        status: 200,
        body: {},
      };

      const builder = new GCPPubSubSubscriptionBuilder("delete-sub");
      const result = await builder.destroy();

      assert.deepStrictEqual(result, { destroyed: "delete-sub" });

      const deleteCall = fetchCalls.find((c) => c.method === "DELETE" && c.url.includes("/subscriptions/delete-sub"));
      assert.ok(deleteCall);
    });
  });
});
