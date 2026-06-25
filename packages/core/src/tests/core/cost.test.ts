import { test, describe } from "node:test";
import assert from "node:assert";
import { BaseBuilder } from "@puls-dev/core";
import { Stack, Deploy } from "@puls-dev/core";

class MockCostBuilder extends BaseBuilder {
  private _cost: number;
  constructor(name: string, cost: number, existingCost?: number) {
    super(name);
    this._cost = cost;
    this.discoveryPromise = Promise.resolve(existingCost !== undefined ? { cost: existingCost } : null);
  }
  override getMonthlyCost(state?: any): number {
    return state ? (state.cost ?? 0) : this._cost;
  }
  override getDiff(existing: any): any[] {
    const diffs = [];
    if (existing.cost !== undefined && existing.cost !== this._cost) {
      diffs.push({ field: "cost", declared: this._cost, live: existing.cost });
    }
    return diffs;
  }
  async deploy() {
    return { cost: this._cost };
  }
}

describe("Eager Cost Estimation Unit Tests", () => {
  test("computes and displays cost shifts in Stack.diff()", async () => {
    class CostStack extends Stack {
      res1 = new MockCostBuilder("res-1", 50, 20); // Declared: 50, Live: 20 -> shift: +30
      res2 = new MockCostBuilder("res-2", 100);    // Declared: 100, Live: 0 -> shift: +100
    }

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };

    let diffResult;
    try {
      const stack = new CostStack();
      diffResult = await stack.diff();
    } finally {
      console.log = originalLog;
    }

    // Assert calculations
    assert.strictEqual(diffResult.totalCurrentCost, 20);
    assert.strictEqual(diffResult.totalNewCost, 150);

    // Verify logs print the shifts and total summary
    const logStr = logs.join("\n");
    assert.ok(logStr.includes("Estimated monthly cost shift: +$130.00/mo (from $20.00/mo to $150.00/mo)"), `Expected shift log not found in: ${logStr}`);
  });

  test("computes and displays cost shifts in Stack.deploy()", async () => {
    class CostDeployStack extends Stack {
      res1 = new MockCostBuilder("res-3", 40, 60); // Declared: 40, Live: 60 -> shift: -20
    }

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };

    try {
      const stack = new CostDeployStack();
      await stack.deploy();
    } finally {
      console.log = originalLog;
    }

    const logStr = logs.join("\n");
    assert.ok(logStr.includes("Estimated monthly cost shift: -$20.00/mo (from $60.00/mo to $40.00/mo)"), `Expected shift log not found in: ${logStr}`);
  });
});
