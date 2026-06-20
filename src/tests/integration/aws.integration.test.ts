import { test, describe } from "node:test";
import assert from "node:assert";
import { Deploy, Stack, Config } from "../../index.js";
import { AWS } from "../../providers/aws/index.js";

// Check if any form of AWS credentials/configuration is active
const hasAwsCreds = !!(
  process.env.AWS_ACCESS_KEY_ID ||
  process.env.AWS_PROFILE ||
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE
);

describe("AWS Dry-Run Integration Tests", { skip: !hasAwsCreds }, () => {
  test("successfully resolves S3 bucket and builds plan against live AWS APIs", async () => {
    Config.set({
      dryRun: true,
      providers: {
        aws: {
          region: process.env.AWS_REGION ?? "us-east-1",
        },
      },
    });

    @Deploy({ dryRun: true })
    class AwsIntegrationStack extends Stack {
      // Use a randomized name to guarantee a fresh lookup/discovery run
      bucket = AWS.S3("puls-integration-test-bucket-abc123xyz");
    }

    const stack = new AwsIntegrationStack();
    const outputs = await stack.deploy();

    assert.ok(outputs.bucket);
    assert.strictEqual(
      outputs.bucket.name,
      "puls-integration-test-bucket-abc123xyz",
    );
  });
});
