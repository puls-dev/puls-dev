import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { Stack } from "./stack.js";
import { Deploy, Destroy } from "./decorators.js";
import { BaseBuilder } from "./resource.js";
import { Config } from "./config.js";
import { Output } from "./output.js";

// Helper delay
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class DelayResource extends BaseBuilder {
  readonly out = {
    val: new Output<string>(),
  };

  constructor(name: string, private delayMs: number, private executionLogs: string[]) {
    super(name);
  }

  async deploy() {
    this.executionLogs.push(`start:${this.name}`);
    await delay(this.delayMs);
    this.executionLogs.push(`end:${this.name}`);
    this.out.val.resolve(this.name);
    return { name: this.name };
  }

  async destroy() {
    this.executionLogs.push(`destroy:${this.name}`);
    await delay(this.delayMs);
    return { name: this.name, destroyed: true };
  }
}

class FailResource extends BaseBuilder {
  async deploy() {
    throw new Error("Failed to deploy!");
  }
}

describe("Parallel Resource Deployment Unit Tests", () => {
  let logs: string[] = [];

  beforeEach(() => {
    Config.set({
      dryRun: false,
      parallel: false,
      providers: {},
    });
    logs = [];
  });

  test("runs sequential deployments by default (verifies base case)", async () => {
    class SeqStack extends Stack {
      r1 = new DelayResource("r1", 30, logs);
      r2 = new DelayResource("r2", 30, logs);
    }

    const start = Date.now();
    const stack = new SeqStack();
    await stack.deploy();
    const duration = Date.now() - start;

    // In sequential, execution is r1 start -> r1 end -> r2 start -> r2 end
    assert.deepStrictEqual(logs, [
      "start:r1",
      "end:r1",
      "start:r2",
      "end:r2"
    ]);
    assert.ok(duration >= 60, `Sequential should take at least 60ms, took ${duration}ms`);
  });

  test("runs parallel deployments concurrently when opted in", async () => {
    // Enable parallel globally for the stack run
    Config.set({
      dryRun: false,
      parallel: true,
      providers: {},
    });

    class ParStack extends Stack {
      r1 = new DelayResource("r1", 40, logs);
      r2 = new DelayResource("r2", 40, logs);
    }

    const start = Date.now();
    const stack = new ParStack();
    await stack.deploy();
    const duration = Date.now() - start;

    // In parallel, both start before either finishes:
    // start:r1 and start:r2 will both be printed first.
    assert.strictEqual(logs[0].startsWith("start:"), true);
    assert.strictEqual(logs[1].startsWith("start:"), true);
    assert.ok(logs.includes("end:r1"));
    assert.ok(logs.includes("end:r2"));

    // Total duration should be closer to 40ms than 80ms
    assert.ok(duration < 75, `Parallel should take less than 75ms (sum), took ${duration}ms`);
  });

  test("respects explicit dependsOn() ordering in parallel mode", async () => {
    Config.set({
      dryRun: false,
      parallel: true,
      providers: {},
    });

    class DependencyStack extends Stack {
      // r1 depends on r2
      r1 = new DelayResource("r1", 20, logs);
      r2 = new DelayResource("r2", 20, logs);

      constructor() {
        super();
        this.r1.dependsOn(this.r2);
      }
    }

    const stack = new DependencyStack();
    await stack.deploy();

    // Since r1 depends on r2, r2 must fully complete before r1 starts
    const r2StartIndex = logs.indexOf("start:r2");
    const r2EndIndex = logs.indexOf("end:r2");
    const r1StartIndex = logs.indexOf("start:r1");

    assert.ok(r2StartIndex < r2EndIndex);
    assert.ok(r2EndIndex < r1StartIndex);
  });

  test("respects implicit Output waiting in parallel mode", async () => {
    Config.set({
      dryRun: false,
      parallel: true,
      providers: {},
    });

    class OutputAwaitingResource extends BaseBuilder {
      constructor(name: string, private dependentVal: Output<string>, private executionLogs: string[]) {
        super(name);
      }
      async deploy() {
        this.executionLogs.push(`start:${this.name}`);
        // Blocks on the Output of the other resource!
        const val = await this.dependentVal.get();
        this.executionLogs.push(`end:${this.name}:${val}`);
        return { name: this.name };
      }
    }

    class OutputStack extends Stack {
      r1 = new DelayResource("r1", 30, logs);
      // r2 depends implicitly on r1's output
      r2 = new OutputAwaitingResource("r2", this.r1.out.val, logs);
    }

    const stack = new OutputStack();
    await stack.deploy();

    // r2 starts in parallel, but it cannot end until r1 finishes and resolves the output
    const r2StartIndex = logs.indexOf("start:r2");
    const r1EndIndex = logs.indexOf("end:r1");
    const r2EndIndex = logs.findIndex(line => line.startsWith("end:r2"));

    assert.ok(r2StartIndex >= 0);
    assert.ok(r1EndIndex >= 0);
    assert.ok(r1EndIndex < r2EndIndex, `r1 end (${r1EndIndex}) must be before r2 end (${r2EndIndex})`);
    assert.ok(logs.includes("end:r2:r1"));
  });

  test("runs parallel teardowns in reverse topological order on @Destroy", async () => {
    Config.set({
      dryRun: false,
      parallel: true,
      providers: {},
    });

    class TeardownStack extends Stack {
      r1 = new DelayResource("r1", 20, logs);
      r2 = new DelayResource("r2", 20, logs);

      constructor() {
        super();
        // r2 depends on r1 during deploy (so r1 deploys first).
        // Teardown should destroy r2 first, then r1!
        this.r2.dependsOn(this.r1);
      }
    }

    const stack = new TeardownStack();
    await stack.destroy();

    const r2DestroyIndex = logs.indexOf("destroy:r2");
    const r1DestroyIndex = logs.indexOf("destroy:r1");

    // r2 depends on r1, so r2 must be fully destroyed BEFORE r1 begins destruction
    assert.ok(r2DestroyIndex < r1DestroyIndex, `r2 destroy (${r2DestroyIndex}) must be before r1 destroy (${r1DestroyIndex})`);
  });

  test("halts execution of dependent resources if a dependency fails", async () => {
    Config.set({
      dryRun: false,
      parallel: true,
      providers: {},
    });

    class FailStack extends Stack {
      r1 = new FailResource("r1");
      r2 = new DelayResource("r2", 30, logs);

      constructor() {
        super();
        this.r2.dependsOn(this.r1);
      }
    }

    const stack = new FailStack();

    await assert.rejects(async () => {
      await stack.deploy();
    }, /Failed to deploy!/);

    // r2 should never have started because its dependency r1 failed!
    assert.strictEqual(logs.includes("start:r2"), false);
  });

  test("decorator option propagation sets configuration values", async () => {
    Config.set({ parallel: false });

    @Deploy({ parallel: true })
    class SimpleDecoStack extends Stack {}

    assert.strictEqual(Config.isParallelActive(), true);

    // @Deploy fires an async stack.deploy() that escapes this test's scope.
    // Waiting here lets it complete before the test runner serializes results,
    // preventing IPC stream corruption on the way back to the parent process.
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  });
});
