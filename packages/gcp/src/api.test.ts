import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { Config } from "@puls-dev/core";
import { resourceContextStorage } from "@puls-dev/core";
import { resolveGCPConfig, getRegion } from "./api.js";

describe("GCP Provider Context-Scoped Configuration", () => {
  beforeEach(() => {
    Config.set({
      providers: {
        gcp: {
          projectId: "global-gcp-project",
          serviceAccountPath: "/global/sa.json",
          region: "us-central1",
        },
      },
    });
  });

  test("uses global configuration by default", () => {
    const config = resolveGCPConfig();
    assert.strictEqual(config.projectId, "global-gcp-project");
    assert.strictEqual(config.serviceAccountPath, "/global/sa.json");
    assert.strictEqual(getRegion(), "us-central1");
  });

  test("resolves context-scoped project and credentials when active", async () => {
    const context = {
      secrets: new Set<string>(),
      gcp: {
        projectId: "context-gcp-project",
        serviceAccountPath: "/context/sa.json",
        region: "europe-west1",
      },
    };

    await resourceContextStorage.run(context, async () => {
      const config = resolveGCPConfig();
      assert.strictEqual(config.projectId, "context-gcp-project");
      assert.strictEqual(config.serviceAccountPath, "/context/sa.json");
      assert.strictEqual(getRegion(), "europe-west1");
    });
  });
});
