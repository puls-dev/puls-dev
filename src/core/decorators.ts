import "reflect-metadata";
import { readFileSync } from "node:fs";
import { Config } from "./config.js";
import { Stack } from "./stack.js";
import { Checker } from "./checker.js";

type ProviderOpts = {
  token?: string;
  region?: string;
  regions?: string[];
  dryRun?: boolean;
  firebase?: string; // path to service account JSON file
  proxmox?: {
    url: string;
    user: string;
    tokenName: string;
    tokenSecret: string;
    nodes?: string[];
    storage?: string;
    dnsDomain?: string;
    dnsServers?: string[];
    verifySsl?: boolean;
  };
};

function applyConfig(opts: ProviderOpts) {
  if (opts.dryRun !== undefined) Config.set({ dryRun: opts.dryRun });
  if (opts.token)
    Config.set({
      providers: { ...Config.get().providers, do: { token: opts.token } },
    });
  if (opts.region)
    Config.set({
      providers: { ...Config.get().providers, aws: { region: opts.region } },
    });
  if (opts.proxmox)
    Config.set({
      providers: { ...Config.get().providers, proxmox: opts.proxmox },
    });
  if (opts.firebase) {
    const sa = JSON.parse(readFileSync(opts.firebase, "utf8"));
    Config.set({
      providers: {
        ...Config.get().providers,
        firebase: {
          projectId: sa.project_id,
          serviceAccountPath: opts.firebase,
        },
      },
    });
  }
}

export function Protected(target: any, propertyKey: string) {
  Reflect.defineMetadata("protected", true, target, propertyKey);
}

export function ForceConfigCheck(target: any, propertyKey: string) {
  Reflect.defineMetadata("forceConfigCheck", true, target, propertyKey);
}

// Property decorator: @Destroy on a field inside a Stack
export function Destroy(target: any, propertyKey: string): void;
// Class decorator without options: @Destroy
export function Destroy(target: Function): void;
// Class decorator with options: @Destroy({ proxmox: { ... } })
export function Destroy(opts: ProviderOpts): (constructor: any) => void;
export function Destroy(optsOrTarget: any, propertyKey?: string): any {
  if (propertyKey !== undefined) {
    Reflect.defineMetadata("destroy", true, optsOrTarget, propertyKey);
    return;
  }
  if (typeof optsOrTarget === "function") {
    const instance = new optsOrTarget();
    Stack._register(optsOrTarget, instance);
    Promise.resolve().then(async () => {
      if (typeof instance.destroy === "function") await instance.destroy();
    });
    return;
  }
  return function (constructor: any) {
    const regions = optsOrTarget.regions ?? [];
    if (regions.length > 0) {
      Promise.resolve().then(async () => {
        for (const r of regions) {
          console.log(`\n🌍 [MULTI-REGION] Tearing down stack in region: ${r}`);
          applyConfig({ ...optsOrTarget, region: r });
          const instance = new constructor();
          Stack._register(constructor, instance, r);
          if (typeof instance.destroy === "function") await instance.destroy();
        }
      });
    } else {
      applyConfig(optsOrTarget);
      const instance = new constructor();
      Stack._register(constructor, instance);
      Promise.resolve().then(async () => {
        if (typeof instance.destroy === "function") await instance.destroy();
      });
    }
  };
}

// THE "MAGIC": Auto-executing Stack Decorator
export function Deploy(opts: ProviderOpts = {}) {
  return function (constructor: any) {
    const regions = opts.regions ?? [];
    if (regions.length > 0) {
      Promise.resolve().then(async () => {
        for (const r of regions) {
          console.log(`\n🌍 [MULTI-REGION] Deploying stack to region: ${r}`);
          applyConfig({ ...opts, region: r });
          const instance = new constructor();
          Stack._register(constructor, instance, r);
          if (typeof instance.deploy === "function") {
            await instance.deploy();
          }
        }
      });
    } else {
      applyConfig(opts);
      const instance = new constructor();
      Stack._register(constructor, instance);
      Promise.resolve().then(async () => {
        if (typeof instance.deploy === "function") await instance.deploy();
      });
    }
  };
}

export function Check(opts: ProviderOpts = {}) {
  return function (constructor: any) {
    applyConfig(opts);
    const instance = new constructor();
    Promise.resolve().then(async () => {
      if (typeof instance.check === "function") await instance.check();
    });
  };
}

// Shortcut for Dry Run - accepts the same options as @Deploy
export function DryRun(opts: ProviderOpts | any = {}) {
  if (typeof opts === "function") {
    Deploy({ dryRun: true })(opts);
  } else {
    return Deploy({ ...opts, dryRun: true });
  }
}
