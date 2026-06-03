import { test, describe } from "node:test";
import assert from "node:assert";
import { BaseBuilder, createBuilderArray } from "./resource.js";
import { Stack } from "./stack.js";
import { Config } from "./config.js";

class MockResourceBuilder extends BaseBuilder {
  public val: number = 0;
  public strVal: string = "";
  public deployCount: number = 0;
  public destroyCount: number = 0;

  constructor(name: string) {
    super(name);
  }

  setVal(n: number | number[]) {
    // Overloaded to support array assignment in proxy test
    if (typeof n === "number") {
      this.val = n;
    }
    return this;
  }

  setStr(s: string | string[]) {
    if (typeof s === "string") {
      this.strVal = s;
    }
    return this;
  }

  async deploy() {
    this.deployCount++;
    return { name: this.name, val: this.val, strVal: this.strVal };
  }

  async destroy() {
    this.destroyCount++;
    return { destroyedName: this.name };
  }
}

describe("Resource Builder Groups Unit Tests", () => {
  test("createBuilderArray proxies and chains methods", () => {
    const b1 = new MockResourceBuilder("r1");
    const b2 = new MockResourceBuilder("r2");
    const group = createBuilderArray([b1, b2]);

    // Test method chaining and uniform distribution
    group.setVal(42).setStr("hello");

    assert.strictEqual(b1.val, 42);
    assert.strictEqual(b2.val, 42);
    assert.strictEqual(b1.strVal, "hello");
    assert.strictEqual(b2.strVal, "hello");
  });

  test("createBuilderArray distributes array arguments by index", () => {
    const b1 = new MockResourceBuilder("r1");
    const b2 = new MockResourceBuilder("r2");
    const group = createBuilderArray([b1, b2]);

    // Test index-based distribution
    group.setVal([10, 20]).setStr(["first", "second"]);

    // In MockResourceBuilder, calling setVal with [10, 20] gets distributed by proxy:
    // b1 gets setVal(10) -> val = 10
    // b2 gets setVal(20) -> val = 20
    assert.strictEqual(b1.val, 10);
    assert.strictEqual(b2.val, 20);
    assert.strictEqual(b1.strVal, "first");
    assert.strictEqual(b2.strVal, "second");
  });

  test("Stack deploy gathers array builders and structures outputs as array", async () => {
    Config.set({ dryRun: false });

    const b1 = new MockResourceBuilder("s1");
    const b2 = new MockResourceBuilder("s2");

    class ArrayStack extends Stack {
      servers = createBuilderArray([b1, b2]).setVal([100, 200]);
    }

    const stack = new ArrayStack();
    const result = await stack.deploy();

    assert.strictEqual(b1.deployCount, 1);
    assert.strictEqual(b2.deployCount, 1);
    assert.ok(Array.isArray(result.servers));
    assert.strictEqual(result.servers.length, 2);
    assert.deepStrictEqual(result.servers[0], { name: "s1", val: 100, strVal: "" });
    assert.deepStrictEqual(result.servers[1], { name: "s2", val: 200, strVal: "" });
  });

  test("Stack destroy gathers array builders and structures outputs as array", async () => {
    Config.set({ dryRun: false });

    const b1 = new MockResourceBuilder("s1");
    const b2 = new MockResourceBuilder("s2");

    class ArrayStack extends Stack {
      servers = createBuilderArray([b1, b2]);
    }

    const stack = new ArrayStack();
    const result = await stack.destroy();

    assert.strictEqual(b1.destroyCount, 1);
    assert.strictEqual(b2.destroyCount, 1);
    assert.ok(Array.isArray(result.servers));
    assert.strictEqual(result.servers.length, 2);
    assert.deepStrictEqual(result.servers[0], { destroyedName: "s1" });
    assert.deepStrictEqual(result.servers[1], { destroyedName: "s2" });
  });
});
