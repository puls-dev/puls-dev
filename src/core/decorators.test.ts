import { test, describe } from "node:test";
import assert from "node:assert";
import "reflect-metadata";
import { Protected, ForceConfigCheck, Destroy } from "./decorators.js";

describe("Decorators Compatibility Tests", () => {
  test("legacy decorators define metadata correctly", () => {
    const target = {};
    Protected(target, "field1");
    ForceConfigCheck(target, "field2");
    Destroy(target, "field3");

    assert.strictEqual(Reflect.getMetadata("protected", target, "field1"), true);
    assert.strictEqual(Reflect.getMetadata("forceConfigCheck", target, "field2"), true);
    assert.strictEqual(Reflect.getMetadata("destroy", target, "field3"), true);
  });

  test("standard ES decorators register initializers and define metadata on instantiation", () => {
    let initializer1: any;
    let initializer2: any;
    let initializer3: any;

    const context1 = {
      kind: "field",
      name: "field1",
      addInitializer: (fn: any) => { initializer1 = fn; }
    };
    const context2 = {
      kind: "field",
      name: "field2",
      addInitializer: (fn: any) => { initializer2 = fn; }
    };
    const context3 = {
      kind: "field",
      name: "field3",
      addInitializer: (fn: any) => { initializer3 = fn; }
    };

    Protected(undefined, context1);
    ForceConfigCheck(undefined, context2);
    Destroy(undefined, context3);

    assert.ok(initializer1);
    assert.ok(initializer2);
    assert.ok(initializer3);

    const instance = {};
    initializer1.call(instance);
    initializer2.call(instance);
    initializer3.call(instance);

    assert.strictEqual(Reflect.getMetadata("protected", instance, "field1"), true);
    assert.strictEqual(Reflect.getMetadata("forceConfigCheck", instance, "field2"), true);
    assert.strictEqual(Reflect.getMetadata("destroy", instance, "field3"), true);
  });
});
