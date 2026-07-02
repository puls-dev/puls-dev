import fs from "node:fs";
import { exec } from "node:child_process";
import { config as dotenvConfig } from "dotenv";
import { Config } from "../core/config.js";
import { providerRegistry, DiscoveredResource } from "../core/provider.js";
import { interactiveSelect } from "./importer/tui.js";
import { SESSION_FILE } from "./importer/session.js";
import { ScanState, createImporterServer, sendAll } from "./importer/server.js";
import { generateInfrastructureCode } from "./importer/codegen.js";

export async function runImporterWizard(): Promise<void> {
  // Load .env before providers authenticate so credentials are available.
  dotenvConfig();

  console.log("\n⚡ Loading cloud provider plugins...");

  await Promise.all([
    import("@puls-dev/aws"        as any).catch(() => {}),
    import("@puls-dev/do"         as any).catch(() => {}),
    import("@puls-dev/firebase"   as any).catch(() => {}),
    import("@puls-dev/gcp"        as any).catch(() => {}),
    import("@puls-dev/proxmox"    as any).catch(() => {}),
    import("@puls-dev/cloudflare" as any).catch(() => {}),
    import("@puls-dev/azure"      as any).catch(() => {}),
    import("@puls-dev/hcloud"     as any).catch(() => {}),
  ]);

  const cfg        = Config.get();
  const registered = providerRegistry.getAll();
  const configured = registered.filter((p) => p.isConfigured(cfg.providers[p.name]));

  if (configured.length === 0) {
    console.error("\n❌  No configured cloud providers found. Set credentials in env or config.");
    process.exit(1);
  }

  // Non-TTY path (CI / piped input)
  if (!(process.stdin as any).isTTY) {
    console.log("  Non-TTY mode: generating stacks headlessly.");
    await runHeadless(cfg, configured.map((p) => p.name));
    return;
  }

  const selectedProviders = await interactiveSelect(
    "Select providers to import from:",
    configured.map((p) => p.name),
    true,
  );

  if (selectedProviders.length === 0) {
    console.log("  No providers selected. Aborting.");
    process.exit(0);
  }

  const state: ScanState = {
    sseClients:   new Set(),
    sseEvents:    [],
    rawResources: [],
    scanComplete: false,
    sessionData:  {},
    token:        Math.random().toString(36).slice(2, 15),
    port:         0,
  };

  if (fs.existsSync(SESSION_FILE)) {
    try { state.sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); } catch {}
  }

  const server = createImporterServer(state);

  // Block until the server closes (triggered by /api/save or Ctrl+C).
  // Without this the function returns immediately after the scan, causing
  // puls.ts to call process.exit(0) while the browser is still open.
  await new Promise<void>((resolve) => {
    server.on("close", resolve);

    server.listen(0, "127.0.0.1", () => {
      state.port  = (server.address() as any).port;
      const url   = `http://localhost:${state.port}/?token=${state.token}`;
      console.log(`\n  🌐  Opening Puls Importer at ${url}`);
      console.log(`      (paste the URL manually if the browser doesn't open)\n`);
      const open  = process.platform === "win32"
        ? `start "" "${url}"`
        : process.platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}"`;
      exec(open);

      // Fire-and-forget: scan runs in the background while the server stays up.
      (async () => {
        for (const pName of selectedProviders) {
          const plugin  = providerRegistry.get(pName)!;
          const pConfig = cfg.providers[pName];
          sendAll(state, "progress", { provider: pName, status: "scanning" });

          try {
            const inv = await plugin.list?.(pConfig);
            if (!inv || !plugin.parseInventory) {
              sendAll(state, "progress", { provider: pName, status: "done", count: 0 });
              continue;
            }
            const parsed = plugin.parseInventory(inv);

            if (plugin.groupResources && parsed.length > 0) {
              const grouped = new Set<string | number>();
              for (const group of plugin.groupResources(parsed)) {
                group.resources.forEach((r) => { state.rawResources.push(r); grouped.add(r.id); });
                sendAll(state, "group", group);
              }
              for (const r of parsed.filter((r) => !grouped.has(r.id))) {
                state.rawResources.push(r);
                sendAll(state, "resource", r);
              }
            } else {
              for (const r of parsed) {
                state.rawResources.push(r);
                sendAll(state, "resource", r);
              }
            }

            sendAll(state, "progress", { provider: pName, status: "done", count: parsed.length });
          } catch (err: any) {
            sendAll(state, "progress", { provider: pName, status: "error", message: err.message });
          }
        }

        state.scanComplete = true;
        for (const client of state.sseClients) {
          try { client.write("event: done\ndata: {}\n\n"); } catch {}
        }
        state.sseClients.clear();
      })();
    });
  });
}

async function runHeadless(cfg: any, providerNames: string[]): Promise<void> {
  const resources: DiscoveredResource[] = [];
  for (const pName of providerNames) {
    const plugin = providerRegistry.get(pName)!;
    try {
      const inv = await plugin.list?.(cfg.providers[pName]);
      if (inv && plugin.parseInventory) resources.push(...plugin.parseInventory(inv));
    } catch {}
  }
  if (resources.length > 0) generateInfrastructureCode(resources, "By Tier");
}
