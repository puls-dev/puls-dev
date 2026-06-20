import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { Policy } from "../../core/policy.js";
import { BaseBuilder } from "../../core/resource.js";
import { Stack } from "../../core/stack.js";
import { Deploy } from "../../core/decorators.js";
import { Config } from "../../core/config.js";

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
});
