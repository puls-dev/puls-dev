import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { Config } from "../../core/config.js";
import { resourceContextStorage } from "../../core/context.js";
import { getS3Client } from "./api.js";

describe("AWS Provider Context-Scoped Configuration", () => {
  beforeEach(() => {
    Config.set({
      providers: {
        aws: {
          region: "us-east-1",
        },
      },
    });
  });

  test("uses global configuration by default", async () => {
    const client = getS3Client();
    assert.strictEqual(await client.config.region(), "us-east-1");
  });

  test("resolves context-scoped region and credentials when active", async () => {
    const context = {
      secrets: new Set<string>(),
      aws: {
        region: "eu-west-1",
        accessKeyId: "mock-key",
        secretAccessKey: "mock-secret",
      },
    };

    await resourceContextStorage.run(context, async () => {
      const client = getS3Client();
      assert.strictEqual(await client.config.region(), "eu-west-1");
      const creds = await client.config.credentials();
      assert.strictEqual(creds.accessKeyId, "mock-key");
      assert.strictEqual(creds.secretAccessKey, "mock-secret");
    });
  });

  test("resolves context-scoped AWS profile", async () => {
    const context = {
      secrets: new Set<string>(),
      aws: {
        region: "us-west-2",
        profile: "default",
      },
    };

    await resourceContextStorage.run(context, async () => {
      const client = getS3Client();
      assert.strictEqual(await client.config.region(), "us-west-2");
    });
  });
});
