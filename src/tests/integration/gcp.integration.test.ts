import { test, describe } from "node:test";
import assert from "node:assert";
import { Deploy, Stack, Config } from "../../index.js";
import { GCP } from "../../providers/gcp/index.js";

// Check if any form of GCP service account credentials or environment configs are set
const hasGcpCreds = !!(
  process.env.GCP_SA ||
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  process.env.GCP_SA_KEY
);

describe("GCP Dry-Run Integration Tests", { skip: !hasGcpCreds }, () => {
  test("successfully executes discovery and builds plan against live GCP APIs", async () => {
    Config.set({
      dryRun: true,
      providers: {
        gcp: {
          region: "us-central1",
        },
      },
    });

    @Deploy({ dryRun: true })
    class GcpIntegrationStack extends Stack {
      secret = GCP.Secret("integration-test-secret-gcp").plainText("hello");
      pubSub = GCP.PubSub.Topic("integration-test-topic-gcp");
    }

    const stack = new GcpIntegrationStack();
    const outputs = await stack.deploy();

    assert.ok(outputs.secret);
    assert.ok(outputs.pubSub);
    assert.strictEqual(outputs.secret.name, "integration-test-secret-gcp");
    assert.strictEqual(outputs.pubSub.name, "integration-test-topic-gcp");
  });
});
