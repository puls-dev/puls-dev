import "reflect-metadata";
import { Config } from "./config.ts";

export function Protected(target: any, propertyKey: string) {
  Reflect.defineMetadata("protected", true, target, propertyKey);
}

export function Destroy(target: any, propertyKey?: string) {
  if (propertyKey === undefined) {
    // Class decorator — tears down all resources in the stack
    Promise.resolve().then(async () => {
      const instance = new target();
      if (typeof instance.destroy === "function") {
        await instance.destroy();
      }
    });
  } else {
    // Property decorator — marks a single resource for destruction within a deploy
    Reflect.defineMetadata("destroy", true, target, propertyKey);
  }
}

// THE "MAGIC": Auto-executing Stack Decorator
export function Deploy(
  opts: {
    token?: string;
    region?: string;
    dryRun?: boolean;
    proxmox?: { url: string; user: string; tokenName: string; tokenSecret: string; nodes?: string[]; storage?: string; dnsDomain?: string; dnsServers?: string[]; verifySsl?: boolean };
  } = {},
) {
  return function (constructor: any) {
    // 1. Setup Config
    if (opts.dryRun !== undefined) Config.set({ dryRun: opts.dryRun });
    if (opts.token) {
      Config.set({
        providers: { ...Config.get().providers, do: { token: opts.token } },
      });
    }
    if (opts.region) {
      Config.set({
        providers: { ...Config.get().providers, aws: { region: opts.region } },
      });
    }
    if (opts.proxmox) {
      Config.set({
        providers: { ...Config.get().providers, proxmox: opts.proxmox },
      });
    }

    // 2. Schedule Execution for the end of the event loop
    Promise.resolve().then(async () => {
      const instance = new constructor();
      if (typeof instance.deploy === "function") {
        await instance.deploy();
      }
    });
  };
}

// Shortcut for Dry Run — accepts the same options as @Deploy
export function DryRun(opts: { token?: string; region?: string } | any = {}) {
  // Handles both @DryRun and @DryRun({ region: ... })
  if (typeof opts === "function") {
    Deploy({ dryRun: true })(opts);
  } else {
    return Deploy({ ...opts, dryRun: true });
  }
}
