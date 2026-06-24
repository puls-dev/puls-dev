import "reflect-metadata";
import { Config } from "./config.js";
import { Stack } from "./stack.js";
import { providerRegistry } from "./provider.js";

type ProviderOpts = {
  token?: string;
  region?: string;
  regions?: string[];
  dryRun?: boolean;
  parallel?: boolean;
  offline?: boolean;
  firebase?: string | any; // path to service account JSON file or configuration block
  proxmox?: any;
  cloudflare?: any;
  azure?: any;
  aws?: any;
  gcp?: any;
  [key: string]: any;
};

function applyConfig(opts: ProviderOpts) {
  if (opts.dryRun !== undefined) Config.set({ dryRun: opts.dryRun });
  if (opts.parallel !== undefined) Config.set({ parallel: opts.parallel });
  if (opts.offline !== undefined) Config.set({ offline: opts.offline });
  if (opts.token)
    Config.set({ providers: { do: { token: opts.token } } });
  if (opts.region)
    Config.set({ providers: { aws: { region: opts.region } } });

  // For each registered plugin, run its configure hook
  const registered = providerRegistry.getAll();
  for (const plugin of registered) {
    const pOpts = opts[plugin.name];
    if (pOpts !== undefined && plugin.configure) {
      plugin.configure(pOpts);
    }
  }

  // CLI env-var overrides - applied last so `puls plan/destroy/--parallel` wins over decorator options
  if (process.env.PULS_DRY_RUN === "true") Config.set({ dryRun: true });
  if (process.env.PULS_PARALLEL === "true") Config.set({ parallel: true });
}

export function Protected(target: any, contextOrKey: any) {
  if (contextOrKey && typeof contextOrKey === "object" && contextOrKey.kind === "field") {
    contextOrKey.addInitializer(function (this: any) {
      Reflect.defineMetadata("protected", true, this, contextOrKey.name);
    });
    return;
  }
  Reflect.defineMetadata("protected", true, target, contextOrKey);
}

export function ForceConfigCheck(target: any, contextOrKey: any) {
  if (contextOrKey && typeof contextOrKey === "object" && contextOrKey.kind === "field") {
    contextOrKey.addInitializer(function (this: any) {
      Reflect.defineMetadata("forceConfigCheck", true, this, contextOrKey.name);
    });
    return;
  }
  Reflect.defineMetadata("forceConfigCheck", true, target, contextOrKey);
}

// Property decorator: @Destroy on a field inside a Stack
export function Destroy(target: any, propertyKey: any): void;
// Class decorator without options: @Destroy
export function Destroy(target: Function): void;
// Class decorator with options: @Destroy({ proxmox: { ... } })
export function Destroy(opts: ProviderOpts): (constructor: any) => void;
export function Destroy(optsOrTarget: any, propertyKey?: any): any {
  // Check if it's a property/field decorator (legacy string key or ES field context)
  if (
    typeof propertyKey === "string" ||
    (propertyKey && typeof propertyKey === "object" && propertyKey.kind === "field")
  ) {
    if (propertyKey && typeof propertyKey === "object" && propertyKey.kind === "field") {
      propertyKey.addInitializer(function (this: any) {
        Reflect.defineMetadata("destroy", true, this, propertyKey.name);
      });
      return;
    }
    Reflect.defineMetadata("destroy", true, optsOrTarget, propertyKey);
    return;
  }
  if (typeof optsOrTarget === "function") {
    Reflect.defineMetadata("config", {}, optsOrTarget);
    const instance = new optsOrTarget();
    Stack._register(optsOrTarget, instance);
    Promise.resolve().then(async () => {
      if (typeof instance.destroy === "function") await instance.destroy();
    });
    return;
  }
  return function (constructor: any) {
    Reflect.defineMetadata("config", optsOrTarget, constructor);
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
    Reflect.defineMetadata("config", opts, constructor);
    const regions = opts.regions ?? [];
    const mode = process.env.PULS_MODE;
    if (regions.length > 0) {
      Promise.resolve().then(async () => {
        for (const r of regions) {
          const label = mode === "destroy" ? "Tearing down" : "Deploying";
          console.log(`\n🌍 [MULTI-REGION] ${label} stack in region: ${r}`);
          applyConfig({ ...opts, region: r });
          const instance = new constructor();
          Stack._register(constructor, instance, r);
          if (mode === "destroy") {
            if (typeof instance.destroy === "function") await instance.destroy();
          } else if (mode === "diff") {
            if (typeof instance.diff === "function") {
              const result = await instance.diff();
              if (process.env.PULS_FAIL_ON_DRIFT === "true" && result?.hasDrift) {
                process.exitCode = 1;
              }
            }
          } else {
            if (typeof instance.deploy === "function") await instance.deploy();
          }
        }
      });
    } else {
      applyConfig(opts);
      const instance = new constructor();
      Stack._register(constructor, instance);
      Promise.resolve().then(async () => {
        if (mode === "destroy") {
          if (typeof instance.destroy === "function") await instance.destroy();
        } else if (mode === "diff") {
          if (typeof instance.diff === "function") {
            const result = await instance.diff();
            if (process.env.PULS_FAIL_ON_DRIFT === "true" && result?.hasDrift) {
              process.exitCode = 1;
            }
          }
        } else {
          if (typeof instance.deploy === "function") await instance.deploy();
        }
      });
    }
  };
}

export function Check(opts: ProviderOpts = {}) {
  return function (constructor: any) {
    Reflect.defineMetadata("config", opts, constructor);
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
