import "reflect-metadata";
import { readFileSync } from "node:fs";
import { Config } from "./config.ts";

type ProviderOpts = {
  token?: string;
  region?: string;
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
      providers: { ...Config.get().providers, firebase: { projectId: sa.project_id, serviceAccountPath: opts.firebase } },
    });
  }
}

export function Protected(target: any, propertyKey: string) {
  Reflect.defineMetadata("protected", true, target, propertyKey);
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
    Promise.resolve().then(async () => {
      const instance = new optsOrTarget();
      if (typeof instance.destroy === "function") await instance.destroy();
    });
    return;
  }
  return function (constructor: any) {
    applyConfig(optsOrTarget);
    Promise.resolve().then(async () => {
      const instance = new constructor();
      if (typeof instance.destroy === "function") await instance.destroy();
    });
  };
}

// THE "MAGIC": Auto-executing Stack Decorator
export function Deploy(opts: ProviderOpts = {}) {
  return function (constructor: any) {
    applyConfig(opts);
    Promise.resolve().then(async () => {
      const instance = new constructor();
      if (typeof instance.deploy === "function") await instance.deploy();
    });
  };
}

// Shortcut for Dry Run — accepts the same options as @Deploy
export function DryRun(opts: ProviderOpts | any = {}) {
  if (typeof opts === "function") {
    Deploy({ dryRun: true })(opts);
  } else {
    return Deploy({ ...opts, dryRun: true });
  }
}
