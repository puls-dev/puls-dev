import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { Policy } from "@puls-dev/core";
import { BaseBuilder } from "@puls-dev/core";
import { Stack } from "@puls-dev/core";
import { Deploy } from "@puls-dev/core";
import { Config } from "@puls-dev/core";

// Mock Builder for testing policies
class TestResourceBuilder extends BaseBuilder {
  constructor(name: string, public size: number) {
    super(name);
  }

  async deploy() {
    return { name: this.name, size: this.size };
  }
}

describe("Policy-as-Code Engine", () => {
  beforeEach(() => {
    Policy.clear();
    Config.set({ dryRun: true });
  });

  test("passes validation if no rules are violated", () => {
    Policy.register({
      name: "Enforce Size Limit",
      validate(resource) {
        if (resource instanceof TestResourceBuilder) {
          if (resource.size > 100) {
            return `Resource "${resource.name}" size must be <= 100.`;
          }
        }
      },
    });

    const res = new TestResourceBuilder("valid-res", 50);
    assert.doesNotThrow(() => {
      Policy.validate([res]);
    });
  });

  test("throws error if a rule is violated (string return)", () => {
    Policy.register({
      name: "Enforce Size Limit",
      validate(resource) {
        if (resource instanceof TestResourceBuilder) {
          if (resource.size > 100) {
            return `Resource "${resource.name}" size must be <= 100.`;
          }
        }
      },
    });

    const res = new TestResourceBuilder("invalid-res", 150);
    assert.throws(
      () => {
        Policy.validate([res]);
      },
      (err: any) => {
        return (
          err instanceof Error &&
          err.message.includes("Policy compliance checks failed")
        );
      }
    );
  });

  test("throws error if a rule is violated (boolean return)", () => {
    Policy.register({
      name: "No odd sizes",
      validate(resource) {
        if (resource instanceof TestResourceBuilder) {
          return resource.size % 2 === 0;
        }
      },
    });

    const res = new TestResourceBuilder("odd-res", 7);
    assert.throws(
      () => {
        Policy.validate([res]);
      },
      (err: any) => {
        return (
          err instanceof Error &&
          err.message.includes("Policy compliance checks failed")
        );
      }
    );
  });

  test("aborts stack deploy when policy is violated", async () => {
    Policy.register({
      name: "Strict Block List",
      validate(resource) {
        if (resource.name.includes("blocked")) {
          return `Resource "${resource.name}" contains blocked name.`;
        }
      },
    });

    class ViolatingStack extends Stack {
      good = new TestResourceBuilder("clean-resource", 10);
      bad = new TestResourceBuilder("blocked-resource", 20);
    }

    const stack = new ViolatingStack();
    await assert.rejects(
      async () => {
        await stack.deploy();
      },
      (err: any) => {
        return (
          err instanceof Error &&
          err.message.includes("Policy compliance checks failed")
        );
      }
    );
  });

  test("aborts stack diff when policy is violated", async () => {
    Policy.register({
      name: "Strict Block List",
      validate(resource) {
        if (resource.name.includes("blocked")) {
          return `Resource "${resource.name}" contains blocked name.`;
        }
      },
    });

    class ViolatingDiffStack extends Stack {
      good = new TestResourceBuilder("clean-resource", 10);
      bad = new TestResourceBuilder("blocked-resource", 20);
    }

    const stack = new ViolatingDiffStack();
    await assert.rejects(
      async () => {
        await stack.diff();
      },
      (err: any) => {
        return (
          err instanceof Error &&
          err.message.includes("Policy compliance checks failed")
        );
      }
    );
  });

  test("triggers drift policies on stack diff (warn mode)", async () => {
    let triggered = false;
    let receivedExpected: any = null;
    let receivedActual: any = null;

    class DriftTestResourceBuilder extends BaseBuilder {
      constructor(name: string, public size: number) {
        super(name);
      }
      async _resolveDiscovery() {
        return { size: 50 };
      }
      getDiff(existing: any) {
        if (this.size !== existing.size) {
          return [{ field: "size", declared: this.size, live: existing.size }];
        }
        return [];
      }
      async deploy() {
        return { name: this.name, size: this.size };
      }
    }

    Policy.register({
      name: "drift-detection-warn",
      mode: "warn",
      onDrift(resource, expected, actual) {
        triggered = true;
        receivedExpected = expected;
        receivedActual = actual;
      },
    });

    class WarnDriftStack extends Stack {
      res = new DriftTestResourceBuilder("drifted-res", 100);
    }

    const stack = new WarnDriftStack();
    await stack.diff();

    assert.strictEqual(triggered, true);
    assert.strictEqual(receivedExpected[0].field, "size");
    assert.strictEqual(receivedExpected[0].declared, 100);
    assert.strictEqual(receivedExpected[0].live, 50);
    assert.strictEqual(receivedActual.size, 50);
  });

  test("triggers drift policies and throws on stack diff (fail mode)", async () => {
    let triggered = false;

    class DriftTestResourceBuilder extends BaseBuilder {
      constructor(name: string, public size: number) {
        super(name);
      }
      async _resolveDiscovery() {
        return { size: 50 };
      }
      getDiff(existing: any) {
        if (this.size !== existing.size) {
          return [{ field: "size", declared: this.size, live: existing.size }];
        }
        return [];
      }
      async deploy() {
        return { name: this.name, size: this.size };
      }
    }

    Policy.register({
      name: "drift-detection-fail",
      mode: "fail",
      onDrift(resource, expected, actual) {
        triggered = true;
      },
    });

    class FailDriftStack extends Stack {
      res = new DriftTestResourceBuilder("drifted-res", 100);
    }

    const stack = new FailDriftStack();
    await assert.rejects(
      async () => {
        await stack.diff();
      },
      (err: any) => {
        return (
          err instanceof Error &&
          err.message.includes("Policy compliance checks failed") &&
          err.message.includes("Drift policy \"drift-detection-fail\" failed")
        );
      }
    );

    assert.strictEqual(triggered, true);
  });
});
