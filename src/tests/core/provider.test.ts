import { test, describe } from "node:test";
import assert from "node:assert";
import { providerRegistry, registerProvider, ProviderPlugin } from "../../core/provider.js";
import { Stack, Deploy } from "../../index.js";

describe("Provider Plugin & Decoupling API Unit Tests", () => {
  test("allows registering and configuring custom provider plugins dynamically", () => {
    let configuredValue = "";
    
    const myPlugin: ProviderPlugin = {
      name: "custom-mock-prov",
      isConfigured: (cfg) => !!cfg?.apiKey,
      list: async () => {
        return { items: ["a", "b"] };
      },
      render: (inv) => {
        console.log(`Rendered items count: ${inv.items.length}`);
      },
      configure: (opts) => {
        configuredValue = opts.apiKey;
      }
    };

    registerProvider(myPlugin);

    // 1. Verify plugin registration in the registry
    const fetched = providerRegistry.get("custom-mock-prov");
    assert.ok(fetched, "Plugin should be registered successfully");
    assert.strictEqual(fetched.name, "custom-mock-prov");

    // 2. Verify configure hook gets triggered during decorator initialization
    @Deploy({ "custom-mock-prov": { apiKey: "key-123" } })
    class TestCustomStack extends Stack {}

    assert.strictEqual(configuredValue, "key-123", "Custom configure hook should be executed by applyConfig");
  });
});
