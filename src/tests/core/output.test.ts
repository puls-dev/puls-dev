import { test, describe } from "node:test";
import assert from "node:assert";
import { Output } from "../../core/output.js";

describe("Output", () => {
  test("resolves a value correctly", async () => {
    const out = new Output<string>();
    out.resolve("success");
    const val = await out.get();
    assert.strictEqual(val, "success");
  });

  test("applies transformations via .apply()", async () => {
    const out = new Output<number>();
    const doubled = out.apply(n => n * 2);
    
    out.resolve(10);
    const result = await doubled.get();
    assert.strictEqual(result, 20);
  });
});
