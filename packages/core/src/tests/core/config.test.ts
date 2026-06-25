import { test, describe } from "node:test";
import assert from "node:assert";
import { Config } from "@puls-dev/core";

describe("ConfigManager", () => {
  test("sets and gets config correctly", () => {
    Config.set({ dryRun: true });
    assert.strictEqual(Config.get().dryRun, true);
    assert.strictEqual(Config.isGlobalDryRun(), true);

    Config.set({ dryRun: false });
    assert.strictEqual(Config.get().dryRun, false);
    assert.strictEqual(Config.isGlobalDryRun(), false);
  });

  test("merges provider config correctly", () => {
    Config.set({ 
      providers: { 
        aws: { region: "us-east-1" } 
      } 
    });
    
    assert.strictEqual(Config.get().providers.aws?.region, "us-east-1");
  });
});
