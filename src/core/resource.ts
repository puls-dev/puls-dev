import { Config } from "./config.js";
import type { FieldDiff } from "../types/diff.js";

export abstract class BaseBuilder {
  protected isProtected: boolean = false;
  protected localDryRun: boolean | null = null;
  protected discoveryPromise!: Promise<any>;
  protected sidecars: BaseBuilder[] = [];
  protected _adoptedId: string | null = null;
  
  /** @internal */
  _deployPromise!: Promise<any>;
  /** @internal */
  async _resolveDiscovery(): Promise<any> {
    return this.discoveryPromise;
  }
  /** @internal */
  _destroyPromise?: Promise<any>;
  /** @internal */
  _dependencies: BaseBuilder[] = [];

  private _beforeDeployHooks: (() => Promise<void> | void)[] = [];
  private _afterDeployHooks: ((result: any) => Promise<void> | void)[] = [];
  private _beforeDestroyHooks: (() => Promise<void> | void)[] = [];
  private _afterDestroyHooks: ((result: any) => Promise<void> | void)[] = [];

  constructor(public name: string) {}

  dependsOn(resource: BaseBuilder) {
    this._dependencies.push(resource);
    return this;
  }

  protect() {
    this.isProtected = true;
    return this;
  }

  /**
   * Adopt an existing cloud resource by its provider ID, bringing it under
   * Puls management without recreating it. If name-based discovery finds the
   * resource, that result wins; adoptId only kicks in when discovery returns
   * null (i.e. the resource was created outside this stack or with a different
   * naming convention).
   *
   * Outputs that depend on live API response fields (e.g. `out.host`) won't be
   * resolved automatically — chain `.adoptOutput(key, value)` for each one you
   * need for cross-stack wiring.
   */
  adoptId(id: string) {
    this._adoptedId = id;
    const original = this.discoveryPromise;
    this.discoveryPromise = original.then((found: any) => {
      if (!found) {
        (this as any).out?.id?.resolve?.(id);
        return { id, status: "adopted", _adopted: true };
      }
      return found;
    });
    return this;
  }

  /**
   * Pre-resolve a named output on this builder. Use alongside `adoptId` to
   * supply known connection details (host, port, uri, etc.) so downstream
   * resources can reference them before this builder deploys.
   *
   * @example
   *   db = DO.Database("prod-db")
   *     .adoptId("abc123")
   *     .adoptOutput("host", "db.internal.example.com")
   *     .adoptOutput("uri", "postgres://...");
   */
  /**
   * Returns field-level differences between declared intent and live cloud state.
   * Called by `Stack.diff()` for each resource that exists. Override in provider
   * builders to surface meaningful drift fields. The default returns an empty array
   * (no field-level diff available).
   */
  getDiff(_existing: any): FieldDiff[] {
    return [];
  }

  adoptOutput(key: string, value: any) {
    const out = (this as any).out;
    if (typeof out?.[key]?.resolve === "function") {
      out[key].resolve(value);
    }
    return this;
  }

  dryRun(enabled: boolean = true) {
    this.localDryRun = enabled;
    return this;
  }

  beforeDeploy(callback: () => Promise<void> | void) {
    this._beforeDeployHooks.push(callback);
    return this;
  }

  afterDeploy(callback: (result: any) => Promise<void> | void) {
    this._afterDeployHooks.push(callback);
    return this;
  }

  beforeDestroy(callback: () => Promise<void> | void) {
    this._beforeDestroyHooks.push(callback);
    return this;
  }

  afterDestroy(callback: (result: any) => Promise<void> | void) {
    this._afterDestroyHooks.push(callback);
    return this;
  }

  /** @internal */
  async _runBeforeDeploy() {
    for (const cb of this._beforeDeployHooks) {
      await cb();
    }
  }

  /** @internal */
  async _runAfterDeploy(result: any) {
    for (const cb of this._afterDeployHooks) {
      await cb(result);
    }
  }

  /** @internal */
  async _runBeforeDestroy() {
    for (const cb of this._beforeDestroyHooks) {
      await cb();
    }
  }

  /** @internal */
  async _runAfterDestroy(result: any) {
    for (const cb of this._afterDestroyHooks) {
      await cb(result);
    }
  }

  protected isDryRunActive(): boolean {
    return this.localDryRun !== null
      ? this.localDryRun
      : Config.isGlobalDryRun();
  }

  protected async checkProtection(hasChanges: boolean) {
    if (this.isProtected && hasChanges) {
      console.error(`\n🛑 [CRITICAL] Resource "${this.name}" is PROTECTED.`);
      console.error(`   Refusing to apply changes to a protected resource.`);
      console.error(
        `   Please remove .protect() if you intentionally want to modify this.`,
      );
      return true;
    }
    return false;
  }

  // Waits for a long-running cloud operation to complete.
  // In dry-run mode: skips entirely - no waiting.
  // In real mode: polls via the provided condition fn until it returns true.
  // The mock fallback simulates a realistic delay with progress output.
  protected async waitFor(
    label: string,
    condition: () => Promise<boolean>,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<void> {
    if (this.isDryRunActive()) {
      console.log(`   ⏭️  [PLAN] Would wait for: ${label}`);
      return;
    }

    const intervalMs = opts.intervalMs ?? 5000;
    const timeoutMs = opts.timeoutMs ?? 600_000; // 10 min default
    const started = Date.now();

    process.stdout.write(`   ⏳ Waiting for ${label}`);

    while (true) {
      const done = await condition();
      if (done) {
        console.log(` ✅`);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        console.log(` ❌`);
        throw new Error(`Timed out waiting for: ${label}`);
      }
      process.stdout.write(`.`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  protected async deploySidecars() {
    for (const sidecar of this.sidecars) {
      await sidecar.deploy();
    }
  }

  protected async destroySidecars() {
    for (const sidecar of [...this.sidecars].reverse()) {
      await sidecar.destroy();
    }
  }

  async destroy(): Promise<any> {
    const dryRun = this.isDryRunActive();
    const adoptedSuffix = this._adoptedId ? ` [adopted id=${this._adoptedId}]` : "";
    console.log(`\n🗑️  Destroying "${this.name}"${adoptedSuffix}...`);
    console.log(
      `   ✅ [${dryRun ? "PLAN" : "OK"}] Resource "${this.name}" marked for destruction.`,
    );
    await this.destroySidecars();
    return { destroyed: this.name };
  }

  abstract deploy(): Promise<any>;
}

export type DistributeArgs<Args extends any[]> = {
  [K in keyof Args]: Args[K] | Args[K][];
};

export type BuilderGroup<B extends BaseBuilder> = B[] & {
  [K in keyof B]: B[K] extends (...args: infer Args) => any
    ? (...args: DistributeArgs<Args>) => BuilderGroup<B>
    : B[K];
};

export function createBuilderArray<T extends BaseBuilder>(builders: T[]): BuilderGroup<T> {
  return new Proxy(builders, {
    get(target, prop, receiver) {
      if (prop in target) {
        const val = Reflect.get(target, prop, receiver);
        if (typeof val === "function") {
          return val.bind(target);
        }
        return val;
      }

      if (builders.length > 0) {
        const first = builders[0];
        const val = Reflect.get(first, prop);
        if (typeof val === "function") {
          return function (...args: any[]) {
            builders.forEach((b, idx) => {
              const method = Reflect.get(b, prop);
              if (typeof method === "function") {
                const mappedArgs = args.map((arg) => {
                  if (Array.isArray(arg) && arg.length === builders.length) {
                    return arg[idx];
                  }
                  return arg;
                });
                method.apply(b, mappedArgs);
              }
            });
            return receiver;
          };
        }
      }

      return undefined;
    },
  }) as any;
}
