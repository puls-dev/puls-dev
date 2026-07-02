import { Config } from "./config.js";

export interface DiscoveredResource {
  id: string | number;
  name: string;
  type: string;
  provider: string;
  tier: "network" | "database" | "compute";
  propertyName: string;
  original: any;
  vpcRef?: DiscoveredResource;
}

export interface ResourceGroup {
  id: string;
  name: string;
  provider: string;
  description: string;
  resources: DiscoveredResource[];
}

export interface ProviderPlugin {
  name: string;
  isConfigured: (config: any) => boolean;
  list?: (config: any) => Promise<any>;
  render?: (inventory: any) => void;
  configure?: (opts: any) => void;
  parseInventory?: (inventory: any) => DiscoveredResource[];
  groupResources?: (resources: DiscoveredResource[]) => ResourceGroup[];
  getPropertyChain?: (res: DiscoveredResource, allResources?: DiscoveredResource[]) => string;
}

class ProviderRegistry {
  private plugins = new Map<string, ProviderPlugin>();

  register(plugin: ProviderPlugin) {
    this.plugins.set(plugin.name, plugin);
  }

  get(name: string): ProviderPlugin | undefined {
    return this.plugins.get(name);
  }

  getAll(): ProviderPlugin[] {
    return Array.from(this.plugins.values());
  }
}

export const providerRegistry = new ProviderRegistry();

export function registerProvider(plugin: ProviderPlugin) {
  providerRegistry.register(plugin);
}

// ─── Box-drawing & Clip Utilities for Renderers ───────────────────────────────

export type Col<T> = { header: string; width: number; render: (row: T) => string };

export function clip(text: string, width: number): string {
  return text.length > width
    ? text.slice(0, width - 1) + "…"
    : text.padEnd(width);
}

export function printSection<T>(title: string, rows: T[], cols: Col<T>[]): void {
  const colsWidth =
    cols.reduce((s, c) => s + c.width, 0) + (cols.length - 1) * 2;
  const innerWidth = Math.max(colsWidth + 4, title.length + 4);
  const bar = (l: string, r: string) => `  ${l}${"─".repeat(innerWidth)}${r}`;
  const row = (content: string) => `  │  ${content.padEnd(innerWidth - 4)}  │`;

  console.log("");
  console.log(bar("┌", "┐"));
  console.log(row(title));
  console.log(bar("├", "┤"));

  if (rows.length === 0) {
    console.log(row("(none)"));
  } else {
    const headerLine = cols
      .map((c) => clip(c.header.toUpperCase(), c.width))
      .join("  ");
    console.log(row(headerLine));
    console.log(bar("├", "┤"));
    for (const r of rows) {
      console.log(row(cols.map((c) => clip(c.render(r), c.width)).join("  ")));
    }
  }

  console.log(bar("└", "┘"));
}
