import { test, describe } from "node:test";
import assert from "node:assert";
import { Checker } from "../../core/checker.js";
import { providerRegistry, registerProvider, ProviderPlugin } from "../../core/provider.js";
import { Config } from "../../core/config.js";

class MockChecker extends Checker {}

describe("Checker Unit Tests", () => {
  test("successfully runs check, aggregates inventory, calculates total cost, and handles errors", async () => {
    let renderCalled = false;
    let listCalled = false;

    const mockPlugin: ProviderPlugin = {
      name: "mock-checker-prov",
      isConfigured: (cfg) => !!cfg?.enabled,
      list: async () => {
        listCalled = true;
        return {
          vms: [{ name: "vm-1" }],
          totalMonthlyCost: 45.50,
        };
      },
      render: (inv) => {
        renderCalled = true;
        assert.strictEqual(inv.vms.length, 1);
        assert.strictEqual(inv.vms[0].name, "vm-1");
      },
    };

    registerProvider(mockPlugin);

    // Configure the mock provider
    Config.set({
      providers: {
        "mock-checker-prov": { enabled: true },
      },
    });

    const checker = new MockChecker();
    const result = await checker.check();

    assert.ok(listCalled, "list() should be called on the plugin");
    assert.ok(renderCalled, "render() should be called on the plugin");
    assert.ok(result["mock-checker-prov"], "Result should contain the provider's inventory");
    assert.strictEqual(result["mock-checker-prov"].totalMonthlyCost, 45.50);
    assert.strictEqual(result.errors.length, 0, "There should be no errors");
  });

  test("handles plugin list errors gracefully and aggregates them", async () => {
    const errorPlugin: ProviderPlugin = {
      name: "error-checker-prov",
      isConfigured: (cfg) => !!cfg?.enabled,
      list: async () => {
        throw new Error("API Connection Failed");
      },
    };

    registerProvider(errorPlugin);

    Config.set({
      providers: {
        "error-checker-prov": { enabled: true },
      },
    });

    const checker = new MockChecker();
    const result = await checker.check();

    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].provider, "error-checker-prov");
    assert.strictEqual(result.errors[0].message, "API Connection Failed");
  });

  test("outputs structured JSON when PULS_JSON environment variable is active", async () => {
    process.env.PULS_JSON = "true";
    let renderCalled = false;
    let loggedOutput = "";

    const originalLog = console.log;
    console.log = (msg: any) => {
      loggedOutput = String(msg);
    };

    const jsonPlugin: ProviderPlugin = {
      name: "json-checker-prov",
      isConfigured: (cfg) => !!cfg?.enabled,
      list: async () => {
        return { items: ["a"] };
      },
      render: () => {
        renderCalled = true;
      },
    };

    registerProvider(jsonPlugin);

    Config.set({
      providers: {
        "json-checker-prov": { enabled: true },
      },
    });

    try {
      const checker = new MockChecker();
      await checker.check();

      assert.strictEqual(renderCalled, false, "render should not be called when PULS_JSON is true");
      const parsed = JSON.parse(loggedOutput);
      assert.strictEqual(parsed.type, "check");
      assert.deepStrictEqual(parsed["json-checker-prov"], { items: ["a"] });
    } finally {
      console.log = originalLog;
      delete process.env.PULS_JSON;
    }
  });
});
