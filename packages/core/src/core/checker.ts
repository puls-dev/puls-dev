import "reflect-metadata";
import { Config } from "./config.js";
import { providerRegistry } from "./provider.js";
import type {
  InventoryResult,
  InventoryError,
} from "../types/inventory.js";

// ─── Checker ──────────────────────────────────────────────────────────────────

export abstract class Checker {
  async check(): Promise<InventoryResult> {
    const cfg = Config.get();
    const errors: InventoryError[] = [];
    const result: InventoryResult = { errors };
    const tasks: Promise<void>[] = [];

    console.log(`\n🔍 Checking infrastructure...`);

    // Dynamically import all built-in plugins so they register themselves before running check
    await Promise.all([
      import("@puls-dev/aws" as any).catch(() => {}),
      import("@puls-dev/do" as any).catch(() => {}),
      import("@puls-dev/firebase" as any).catch(() => {}),
      import("@puls-dev/gcp" as any).catch(() => {}),
      import("@puls-dev/proxmox" as any).catch(() => {}),
      import("@puls-dev/cloudflare" as any).catch(() => {}),
      import("@puls-dev/azure" as any).catch(() => {}),
      import("@puls-dev/hcloud" as any).catch(() => {}),
    ]);

    const registered = providerRegistry.getAll();
    for (const plugin of registered) {
      const pConfig = cfg.providers[plugin.name];
      if (plugin.list && plugin.isConfigured(pConfig)) {
        tasks.push(
          plugin.list(pConfig)
            .then((inv) => {
              (result as any)[plugin.name] = inv;
            })
            .catch((err: Error) => {
              errors.push({ provider: plugin.name, message: err.message });
            })
        );
      }
    }

    await Promise.all(tasks);

    if (process.env.PULS_JSON === "true") {
      console.log(JSON.stringify({ type: "check", ...result }));
      return result;
    }

    // Call render for each plugin that executed successfully
    for (const plugin of registered) {
      const inv = (result as any)[plugin.name];
      if (inv && plugin.render) {
        plugin.render(inv);
      }
    }

    for (const e of errors) {
      console.warn(`\n  [!] ${e.provider}: ${e.message}`);
    }

    // Aggregate monthly cost across any plugin that reports it
    let totalCost = 0;
    for (const plugin of registered) {
      const inv = (result as any)[plugin.name];
      if (inv && typeof inv === "object" && "totalMonthlyCost" in inv) {
        totalCost += inv.totalMonthlyCost;
      }
    }
    if (totalCost > 0) {
      console.log(
        `\n  Total estimated monthly cost: $${totalCost}`,
      );
    }

    return result;
  }
}
