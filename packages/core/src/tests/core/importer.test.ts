import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { runImporterWizard } from "../../bin/importer-wizard.js";
import { registerProvider, ProviderPlugin, DiscoveredResource, ResourceGroup } from "../../core/provider.js";
import { Config } from "../../core/config.js";

describe("Importer Wizard Unit & Integration Tests", () => {
  const infraDir = path.resolve(process.cwd(), "infra");

  beforeEach(() => {
    // Reset global config and clear previous temp folders if any
    Config.set({
      dryRun: false,
      providers: {},
    });
    try {
      if (fs.existsSync(infraDir)) {
        fs.rmSync(infraDir, { recursive: true, force: true });
      }
    } catch {}
  });

  after(() => {
    // Cleanup generated files
    try {
      if (fs.existsSync(infraDir)) {
        fs.rmSync(infraDir, { recursive: true, force: true });
      }
    } catch {}
  });

  test("runs scanner, selects resources, parses dependencies, and generates tier stacks in non-TTY mode", async () => {
    // 1. Register a mock provider with network and compute resources implementing decentralized hooks
    const mockPlugin: ProviderPlugin = {
      name: "mock-prov",
      isConfigured: () => true,
      list: async () => {
        return {
          vpcs: [
            {
              id: "vpc-prod-id",
              name: "prod-vpc",
            },
          ],
          droplets: [
            {
              id: 9988,
              name: "prod-app",
              vpc_uuid: "vpc-prod-id", // Matching VPC ID for dependency linkage
              size: "s-1vcpu-1gb",
              region: "nyc3",
            },
          ],
        };
      },
      parseInventory: (inv) => {
        const list: DiscoveredResource[] = [];
        inv.vpcs.forEach((v: any) => list.push({
          id: v.id,
          name: v.name,
          type: "Mock.VPC",
          provider: "mock-prov",
          tier: "network",
          propertyName: "prod_vpc",
          original: v,
        }));
        inv.droplets.forEach((d: any) => list.push({
          id: d.id,
          name: d.name,
          type: "Mock.Droplet",
          provider: "mock-prov",
          tier: "compute",
          propertyName: "prod_app",
          original: d,
        }));
        return list;
      },
      groupResources: (res) => {
        const groups: ResourceGroup[] = [];
        const vpc = res.find(r => r.type === "Mock.VPC")!;
        const droplet = res.find(r => r.type === "Mock.Droplet")!;
        groups.push({
          id: "network-group",
          name: "🌐  Network: prod-vpc",
          provider: "mock-prov",
          description: "Mock VPC boundary with connected compute",
          resources: [vpc, droplet],
        });
        return groups;
      },
      getPropertyChain: (res) => {
        let chain = "";
        if (res.type === "Mock.Droplet") {
          chain += `\n    .size("${res.original.size}")`;
          chain += `\n    .region("${res.original.region}")`;
        }
        return chain;
      }
    };

    registerProvider(mockPlugin);

    // Mock config settings to mark provider as active
    Config.set({
      providers: {
        "mock-prov": { token: "mock-token" },
      },
    });

    // 2. Execute the importer wizard
    // Since unit tests run with process.stdin.isTTY === undefined/false,
    // the prompts resolve instantly selecting all mock items and strategy "By Tier"
    await runImporterWizard();

    // 3. Assert generated file layouts exist
    const groupDir = path.join(infraDir, "prod-vpc");
    const networkFile = path.join(groupDir, "network", "network-stack.ts");
    const dbFile = path.join(groupDir, "database-stack.ts");
    const computeFile = path.join(groupDir, "compute-stack.ts");

    assert.ok(fs.existsSync(networkFile), "network-stack.ts should be generated");
    assert.strictEqual(fs.existsSync(dbFile), false, "database-stack.ts should not be generated (empty)");
    assert.ok(fs.existsSync(computeFile), "compute-stack.ts should be generated");

    // 4. Verify dependency heuristics (droplet should link to VPC through network stack)
    const computeContent = fs.readFileSync(computeFile, "utf8");
    assert.ok(
      computeContent.includes(".adoptId(\"9988\")"),
      "Should contain droplet builder with correct adopted ID"
    );
    assert.ok(
      computeContent.includes(".vpc(this.network.prod_vpc.out.id)"),
      "Should have replaced raw VPC UUID with inferred network stack output reference"
    );
    assert.ok(
      computeContent.includes(".size(\"s-1vcpu-1gb\")"),
      "Should generate size configuration"
    );
    assert.ok(
      computeContent.includes(".region(\"nyc3\")"),
      "Should generate region configuration"
    );

    const networkContent = fs.readFileSync(networkFile, "utf8");
    assert.ok(
      networkContent.includes("prod_vpc = Mock.VPC(\"prod-vpc\")"),
      "VPC should be correctly declared under property prod_vpc"
    );
  });
});
