import { test, describe } from "node:test";
import assert from "node:assert";
import { Stack, Config } from "@puls-dev/core";
import { AWS } from "../index.js";

async function isLocalStackRunning(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:4566/_localstack/health");
    return res.ok;
  } catch {
    try {
      const res = await fetch("http://localhost:4566/health");
      return res.ok;
    } catch {
      return false;
    }
  }
}

describe("AWS LocalStack E2E Tests", () => {
  test("successfully executes S3 and SQS lifecycle (create, check, destroy) against LocalStack", async (t) => {
    const active = await isLocalStackRunning();
    if (!active) {
      t.skip(
        "LocalStack is not running on http://localhost:4566. " +
          "Start it using: docker run --rm -d -p 4566:4566 localstack/localstack"
      );
      return;
    }

    // 1. Configure Puls AWS provider to route to LocalStack with mock credentials
    Config.set({
      dryRun: false,
      providers: {
        aws: {
          region: "us-east-1",
          endpoint: "http://localhost:4566",
        },
      },
    });

    process.env.AWS_ACCESS_KEY_ID = "mock-key-id";
    process.env.AWS_SECRET_ACCESS_KEY = "mock-secret-key";

    // 2. Define the Test Stack (plain class without @Deploy to avoid auto-run in background)
    class AwsE2EStack extends Stack {
      bucket = AWS.S3("puls-e2e-bucket-test");
      queue = AWS.SQS("puls-e2e-queue-test").timeout(45);
    }

    const stack = new AwsE2EStack();

    // 3. Stage 1: Deploy (Create resources)
    console.log("   🧪 E2E STAGE 1: Deploying stack...");
    const deployOutputs = await stack.deploy();

    assert.ok(deployOutputs.bucket, "Bucket output should be returned");
    assert.strictEqual(deployOutputs.bucket.name, "puls-e2e-bucket-test");
    assert.ok(deployOutputs.queue, "Queue output should be returned");
    assert.ok(deployOutputs.queue.url.includes("puls-e2e-queue-test"), "Queue URL should contain queue name");

    // 4. Stage 2: Idempotency (Deploy again to ensure it is detected and skipped/matched)
    console.log("   🧪 E2E STAGE 2: Deploying again (idempotency check)...");
    const deployOutputs2 = await stack.deploy();
    assert.ok(deployOutputs2.bucket);
    assert.ok(deployOutputs2.queue);

    // 5. Stage 3: Teardown (Destroy resources)
    console.log("   🧪 E2E STAGE 3: Tearing down stack...");
    const destroyOutputs = await stack.destroy();

    assert.ok(destroyOutputs.bucket, "Bucket should be destroyed");
    assert.ok(destroyOutputs.queue, "Queue should be destroyed");
  });
});
