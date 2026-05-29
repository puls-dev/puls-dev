import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { Stack } from "./stack.js";
import { Deploy, Destroy } from "./decorators.js";
import { BaseBuilder } from "./resource.js";
import { Config } from "./config.js";
import { Output } from "./output.js";

class RegionResource extends BaseBuilder {
  readonly out = {
    region: new Output<string>(),
  };

  async deploy() {
    const activeRegion = Config.get().providers.aws?.region ?? "unknown";
    this.out.region.resolve(activeRegion);
    return { name: this.name, region: activeRegion };
  }

  async destroy() {
    const activeRegion = Config.get().providers.aws?.region ?? "unknown";
    return { name: this.name, destroyed: true, region: activeRegion };
  }
}

describe("Multi-Region Deployments Unit Tests", () => {
  let executionLogs: string[] = [];

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {},
    });
    executionLogs = [];
  });

  test("runs sequential deployments across multiple regions and stores instances in registry", async () => {
    @Deploy({
      regions: ["us-east-1", "eu-central-1", "ap-northeast-1"],
      dryRun: false,
    })
    class MultiStack extends Stack {
      res = new RegionResource("my-region-res").afterDeploy((result) => {
        executionLogs.push(`deploy:${result.region}`);
      });
    }

    // Wait for the asynchronous macro/microtask queue to resolve Deploy runs
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify sequential region changes occurred in correct order
    assert.deepStrictEqual(executionLogs, [
      "deploy:us-east-1",
      "deploy:eu-central-1",
      "deploy:ap-northeast-1",
    ]);

    // Retrieve specific region stack outputs via Stack.from(cls, region)
    const usStack = Stack.from(MultiStack, "us-east-1");
    const euStack = Stack.from(MultiStack, "eu-central-1");
    const apStack = Stack.from(MultiStack, "ap-northeast-1");

    assert.ok(usStack);
    assert.ok(euStack);
    assert.ok(apStack);

    assert.strictEqual(await usStack.res.out.region.get(), "us-east-1");
    assert.strictEqual(await euStack.res.out.region.get(), "eu-central-1");
    assert.strictEqual(await apStack.res.out.region.get(), "ap-northeast-1");
  });

  test("runs sequential teardowns across multiple regions on @Destroy", async () => {
    @Destroy({
      regions: ["us-east-1", "eu-central-1"],
      dryRun: false,
    })
    class CleanStack extends Stack {
      res = new RegionResource("my-teardown-res").afterDestroy((result) => {
        executionLogs.push(`destroy:${result.region}`);
      });
    }

    // Wait for microtask queue to run Destroy
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepStrictEqual(executionLogs, [
      "destroy:us-east-1",
      "destroy:eu-central-1",
    ]);
  });
});
