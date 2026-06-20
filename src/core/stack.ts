import "reflect-metadata";
import { BaseBuilder } from "./resource.js";
import { Config } from "./config.js";
import { resourceContextStorage } from "./context.js";
import { resolvedSecrets } from "./secret.js";
import type { StackDiff, ResourceDiff, ResourceStatus } from "../types/diff.js";
import { Policy } from "./policy.js";

async function withRedactedConsole<T>(
  secrets: Set<string>,
  fn: () => Promise<T>,
): Promise<T> {
  const originalLog = console.log;
  const redact = (message: any): any => {
    if (typeof message !== "string") return message;
    let result = message;
    for (const secret of secrets) {
      if (secret && secret.length >= 3) {
        const escaped = secret.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
        result = result.replace(new RegExp(escaped, "g"), "********");
      }
    }
    return result;
  };

  console.log = (...args: any[]) => {
    const redactedArgs = args.map((arg) => {
      if (typeof arg === "string") return redact(arg);
      try {
        const str = String(arg);
        const hasSecret = [...secrets].some(
          (s) => s && s.length >= 3 && str.includes(s),
        );
        if (hasSecret) return redact(str);
      } catch { }
      return arg;
    });
    originalLog(...redactedArgs);
  };

  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

const _registry = new Map<Function | string, Stack>();

type OutputEntry = {
  primary: string;
  sub?: string[];
};

/** @internal */
export function formatEntry(val: any, parentKey?: string): OutputEntry {
  const isSensitiveKey = (k: string) => /password|secret|token|key/i.test(k);

  if (parentKey && isSensitiveKey(parentKey)) {
    return { primary: "********" };
  }

  if (val === null || val === undefined) return { primary: "null" };

  if (Array.isArray(val)) {
    if (val.length === 0) return { primary: "[]" };
    const items = val.map((item) => formatEntry(item, parentKey));
    if (items.every((i) => !i.sub)) {
      const inline = items.map((i) => i.primary).join("  ·  ");
      if (inline.length <= 52) return { primary: inline };
    }
    const primary = items[0].primary;
    const sub = items.slice(1).map((i) => i.primary).concat(items.flatMap((i) => i.sub ?? []));
    return { primary, sub };
  }

  if (typeof val !== "object") return { primary: String(val) };

  const redactedVal = { ...val };
  for (const k of Object.keys(redactedVal)) {
    if (isSensitiveKey(k)) {
      redactedVal[k] = "********";
    }
  }

  // Known shapes
  if ("destroyed" in redactedVal) {
    return { primary: redactedVal.destroyed ? "🗑️  destroyed" : "─  not found" };
  }
  if (redactedVal.zone) return { primary: redactedVal.zone };

  const identifier = redactedVal.id ?? redactedVal.vmid;
  if (redactedVal.name && identifier !== undefined) {
    return { primary: `${redactedVal.name}  [${identifier}]` };
  }
  if (redactedVal.name) return { primary: redactedVal.name };
  if (redactedVal.arn) return { primary: redactedVal.arn };

  // Recursively format dictionary objects (where all values are objects)
  const entryEntries = Object.entries(redactedVal);
  const isAllObjects = entryEntries.every(([, v]) => v && typeof v === "object");
  if (isAllObjects && entryEntries.length > 0) {
    const items = entryEntries.map(([k, v]) => {
      const formatted = formatEntry(v, k);
      const prefix = /^\d+$/.test(k) ? "" : `${k}: `;
      return {
        primary: `${prefix}${formatted.primary}`,
        sub: formatted.sub?.map((s) => `${prefix}${s}`),
      };
    });
    if (items.every((i) => !i.sub)) {
      const inline = items.map((i) => i.primary).join("  ·  ");
      if (inline.length <= 52) return { primary: inline };
    }
    const primary = items[0].primary;
    const sub = items.slice(1).map((i) => i.primary).concat(items.flatMap((i) => i.sub ?? []));
    return { primary, sub };
  }

  // Generic: pull all scalar values
  const pairs = Object.entries(redactedVal).filter(
    ([, v]) => typeof v === "string" || typeof v === "number",
  ) as [string, string][];

  if (pairs.length === 0) return { primary: JSON.stringify(redactedVal) };

  // Try compact inline (values only, dot-separated)
  const inline = pairs.map(([, v]) => v).join("  ·  ");
  if (inline.length <= 52) return { primary: inline };

  // Too long - first value as primary, rest as sub-lines
  const [[, first], ...rest] = pairs;
  return {
    primary: first,
    sub: rest.map(([k, v]) => `${k}  ${v}`),
  };
}

function printOutputs(stackName: string, outputs: Record<string, any>) {
  const title = ` ${stackName} `;
  const keyWidth = Math.max(...Object.keys(outputs).map((k) => k.length));

  const rows = Object.entries(outputs).map(([key, val]) => ({
    key,
    ...formatEntry(val, key),
  }));

  // textWidth = width of row text content (without the 2-space padding on each side)
  const textWidth = Math.max(
    ...rows.flatMap(({ key, primary, sub }) => [
      keyWidth + 2 + primary.length,
      ...(sub ?? []).map((s) => keyWidth + 6 + s.length),
    ]),
  );

  // innerWidth = total chars between │ delimiters: text + 2-space padding each side
  const innerWidth = Math.max(textWidth + 4, title.length);
  const line = "─".repeat(innerWidth);

  console.log(`\n  ┌${line}┐`);
  console.log(`  │${title.padEnd(innerWidth)}│`);
  console.log(`  ├${line}┤`);

  for (const { key, primary, sub } of rows) {
    const mainRow = `${key.padEnd(keyWidth)}  ${primary}`;
    console.log(`  │  ${mainRow.padEnd(innerWidth - 4)}  │`);
    for (const s of sub ?? []) {
      const subRow = `${"".padEnd(keyWidth)}    ${s}`;
      console.log(`  │  ${subRow.padEnd(innerWidth - 4)}  │`);
    }
  }

  console.log(`  └${line}┘`);
}

function printDiff(diff: StackDiff): void {
  console.log(`\n🔍 Diff: ${diff.stackName}`);

  const propWidth = Math.max(...diff.resources.map((r) => r.prop.length), 4);
  const nameWidth = Math.max(...diff.resources.map((r) => r.resource.length), 8);

  for (const r of diff.resources) {
    const prop = r.prop.padEnd(propWidth);
    const name = r.resource.padEnd(nameWidth);
    if (r.status === "in-sync") {
      console.log(`   ${prop}  ${name}  ✅ in-sync`);
    } else if (r.status === "adopted") {
      console.log(`   ${prop}  ${name}  🔗 adopted`);
    } else if (r.status === "missing") {
      console.log(`   ${prop}  ${name}  ❌ missing  (will create)`);
    } else {
      console.log(`   ${prop}  ${name}  ⚠️  drift`);
      const fieldWidth = Math.max(...r.changes.map((c) => String(c.field).length), 8);
      for (const c of r.changes) {
        const field = String(c.field).padEnd(fieldWidth);
        console.log(`      └─ ${field}  ${String(c.declared)}  →  ${c.live}`);
      }
    }
  }

  const driftCount = diff.resources.filter((r) => r.status === "drift").length;
  const missingCount = diff.resources.filter((r) => r.status === "missing").length;
  if (driftCount === 0 && missingCount === 0) {
    console.log(`\n   ✅ All ${diff.resources.length} resources are in sync.`);
  } else {
    const parts: string[] = [];
    if (driftCount > 0) parts.push(`${driftCount} drifted`);
    if (missingCount > 0) parts.push(`${missingCount} missing`);
    console.log(`\n   ⚠️  ${parts.join(", ")} out of ${diff.resources.length} resources.`);
  }
}

export abstract class Stack {
  /** @internal - called by @Deploy to register the instance for cross-stack references. */
  static _register(cls: Function, instance: Stack, region?: string): void {
    if (region) {
      _registry.set(`${cls.name}:${region}`, instance);
    }
    _registry.set(cls, instance);
  }

  /**
   * Returns the already-constructed instance of another Stack so you can reference
   * its resource Output fields before deployment completes.
   *
   * The target stack must be decorated with @Deploy and imported before this call.
   * An optional region parameter can be supplied for multi-region configurations.
   *
   * @example
   * class DNSStack extends Stack {
   *   private infra = Stack.from(InfraStack, REGION.US_EAST_1);
   *   dns = DO.Domain("example.com").pointer("app", this.infra.app.ip);
   * }
   */
  static from<T extends Stack>(cls: new (...args: any[]) => T, region?: string): T {
    const key = region ? `${cls.name}:${region}` : cls;
    const instance = _registry.get(key);
    if (!instance)
      throw new Error(
        `Stack "${cls.name}" ${region ? `for region "${region}" ` : ""}is not registered. Make sure it is decorated with @Deploy and its module is imported before referencing it.`,
      );
    return instance as T;
  }

  beforeDeploy?(): Promise<void> | void;
  afterDeploy?(outputs: Record<string, any>): Promise<void> | void;
  beforeDestroy?(): Promise<void> | void;
  afterDestroy?(outputs: Record<string, any>): Promise<void> | void;

  /**
   * Compares every declared resource against its live cloud state without
   * making any API writes. Returns a structured `StackDiff` and prints a
   * formatted report to the console.
   *
   * Field-level drift is surfaced for providers that implement `getDiff()`.
   * Resources with no `getDiff()` override show only existence status
   * (missing / in-sync / adopted).
   */
  async diff(): Promise<StackDiff> {
    const props = Object.getOwnPropertyNames(this);
    const entries: { prop: string; resource: BaseBuilder }[] = [];

    for (const prop of props) {
      const val = (this as Record<string, unknown>)[prop];
      if (val instanceof BaseBuilder) {
        entries.push({ prop, resource: val });
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (item instanceof BaseBuilder) {
            entries.push({ prop, resource: item });
          }
        }
      }
    }

    Policy.validate(entries.map((e) => e.resource));

    const resources: ResourceDiff[] = [];

    for (const { prop, resource } of entries) {
      const existing = await resource._resolveDiscovery();
      let status: ResourceStatus;
      let changes = resource.getDiff(existing ?? {});

      if (!existing) {
        status = "missing";
        changes = [];
      } else if ((existing as any)._adopted === true) {
        status = "adopted";
        changes = [];
      } else {
        status = changes.length > 0 ? "drift" : "in-sync";
      }

      resources.push({ prop, resource: resource.name, status, changes });
    }

    const hasDrift = resources.some((r) => r.status === "drift" || r.status === "missing");
    const result: StackDiff = { stackName: this.constructor.name, resources, hasDrift };
    printDiff(result);
    return result;
  }

  async deploy(): Promise<Record<string, any>> {
    const controller = new AbortController();
    const hosts: any[] = [];
    // Snapshot current secrets; new secrets resolved during this run are added via context
    const secrets = new Set<string>(resolvedSecrets);
    const configOpts = Reflect.getMetadata("config", this.constructor) || {};
    const context = {
      abortSignal: controller.signal,
      hosts,
      stackName: this.constructor.name,
      secrets,
      aws: configOpts.aws,
      gcp: configOpts.gcp,
    };

    return resourceContextStorage.run(context, async () => {
      return withRedactedConsole(secrets, async () => {
        console.log(`\n🏗️  Deploying Stack: ${this.constructor.name}`);

        // Stack-level beforeDeploy hook
        if (this.beforeDeploy) {
          console.log(`   ⚡ Running Stack-level beforeDeploy hook...`);
          await this.beforeDeploy();
        }

        const props = Object.getOwnPropertyNames(this);
        const outputs: Record<string, any> = {};
        const isParallel = Config.isParallelActive();

        // 1. Gather all resources
        const resources: { prop: string; resource: BaseBuilder }[] = [];
        for (const prop of props) {
          const val = (this as Record<string, unknown>)[prop];
          if (val instanceof BaseBuilder) {
            resources.push({ prop, resource: val });

            // Apply metadata properties eagerly
            const isProtected = Reflect.getMetadata("protected", this, prop);
            if (isProtected) val.protect();

            const forceConfigCheck = Reflect.getMetadata("forceConfigCheck", this, prop);
            if (forceConfigCheck) {
              val.forceConfigCheck?.();
            }
          } else if (Array.isArray(val)) {
            const isProtected = Reflect.getMetadata("protected", this, prop);
            const forceConfigCheck = Reflect.getMetadata("forceConfigCheck", this, prop);
            for (const item of val) {
              if (item instanceof BaseBuilder) {
                resources.push({ prop, resource: item });
                if (isProtected) item.protect();
                if (forceConfigCheck) {
                  item.forceConfigCheck?.();
                }
              }
            }
          }
        }

        Policy.validate(resources.map((r) => r.resource));

        // 2. Schedule execution
        if (isParallel) {
          const promises = resources.map(({ prop, resource }) => {
            resource._deployPromise = (async () => {
              try {
                // Yield so the map() loop finishes assigning all _deployPromise values before
                // any task checks its dependencies - a dependency that appears later in the list
                // would otherwise have an undefined _deployPromise and be silently skipped.
                await Promise.resolve();
                if (controller.signal.aborted) {
                  throw new Error("Deployment aborted due to previous failure");
                }
                // Wait for explicit dependencies
                for (const dep of resource._dependencies) {
                  if (dep._deployPromise) {
                    await dep._deployPromise;
                  }
                }
                if (controller.signal.aborted) {
                  throw new Error("Deployment aborted due to previous failure");
                }

                // Execute hooks and deploy
                const isDestroyed = Reflect.getMetadata("destroy", this, prop);
                let res: any;
                if (isDestroyed) {
                  await resource._runBeforeDestroy();
                  res = await resource.destroy();
                  await resource._runAfterDestroy(res);
                } else {
                  await resource._runBeforeDeploy();
                  res = await resource.deploy();
                  await resource._runAfterDeploy(res);
                }
                const propVal = (this as Record<string, unknown>)[prop];
                if (Array.isArray(propVal)) {
                  const idx = propVal.indexOf(resource);
                  if (idx !== -1) {
                    if (!outputs[prop]) {
                      outputs[prop] = [];
                    }
                    outputs[prop][idx] = res;
                  }
                } else {
                  outputs[prop] = res;
                }
                return res;
              } catch (err) {
                controller.abort();
                throw err;
              }
            })();
            return resource._deployPromise;
          });

          await Promise.all(promises);
        } else {
          // Sequential mode
          for (const { prop, resource } of resources) {
            if (controller.signal.aborted) {
              throw new Error("Deployment aborted due to previous failure");
            }
            try {
              const isDestroyed = Reflect.getMetadata("destroy", this, prop);
              let res: any;
              if (isDestroyed) {
                await resource._runBeforeDestroy();
                res = await resource.destroy();
                await resource._runAfterDestroy(res);
              } else {
                await resource._runBeforeDeploy();
                res = await resource.deploy();
                await resource._runAfterDeploy(res);
              }
              const propVal = (this as Record<string, unknown>)[prop];
              if (Array.isArray(propVal)) {
                const idx = propVal.indexOf(resource);
                if (idx !== -1) {
                  if (!outputs[prop]) {
                    outputs[prop] = [];
                  }
                  outputs[prop][idx] = res;
                }
              } else {
                outputs[prop] = res;
              }
            } catch (err) {
              controller.abort();
              throw err;
            }
          }
        }

        printOutputs(this.constructor.name, outputs);

        // Stack-level afterDeploy hook
        if (this.afterDeploy) {
          console.log(`   ⚡ Running Stack-level afterDeploy hook...`);
          await this.afterDeploy(outputs);
        }

        return outputs;
      });
    });
  }

  async destroy(): Promise<Record<string, any>> {
    const controller = new AbortController();
    const hosts: any[] = [];
    const secrets = new Set<string>(resolvedSecrets);
    const configOpts = Reflect.getMetadata("config", this.constructor) || {};
    const context = {
      abortSignal: controller.signal,
      hosts,
      stackName: this.constructor.name,
      secrets,
      aws: configOpts.aws,
      gcp: configOpts.gcp,
    };

    return resourceContextStorage.run(context, async () => {
      return withRedactedConsole(secrets, async () => {
        console.log(`\n💥 Tearing down Stack: ${this.constructor.name}`);

        // Stack-level beforeDestroy hook
        if (this.beforeDestroy) {
          console.log(`   ⚡ Running Stack-level beforeDestroy hook...`);
          await this.beforeDestroy();
        }

        const props = Object.getOwnPropertyNames(this).reverse();
        const outputs: Record<string, any> = {};
        const isParallel = Config.isParallelActive();

        // 1. Gather all resources
        const resources: { prop: string; resource: BaseBuilder }[] = [];
        for (const prop of props) {
          const val = (this as Record<string, unknown>)[prop];
          if (val instanceof BaseBuilder) {
            if (Reflect.getMetadata("protected", this, prop)) {
              console.log(`   🔒 Skipping protected resource "${prop}"`);
              continue;
            }
            resources.push({ prop, resource: val });
          } else if (Array.isArray(val)) {
            if (Reflect.getMetadata("protected", this, prop)) {
              console.log(`   🔒 Skipping protected resource "${prop}"`);
              continue;
            }
            for (const item of val) {
              if (item instanceof BaseBuilder) {
                resources.push({ prop, resource: item });
              }
            }
          }
        }

        // 2. Schedule execution
        if (isParallel) {
          // In parallel destroy, await all dependents (reverse dependencies) first
          const promises = resources.map(({ prop, resource }) => {
            resource._destroyPromise = (async () => {
              try {
                // Yield so the map() loop finishes assigning all _destroyPromise values before
                // any task checks its dependents (same reason as parallel deploy).
                await Promise.resolve();
                if (controller.signal.aborted) {
                  throw new Error("Teardown aborted due to previous failure");
                }
                // Wait for all resources that explicitly declare this one as a dependency
                const dependents = resources.filter(r => r.resource._dependencies.includes(resource));
                for (const dep of dependents) {
                  if (dep.resource._destroyPromise) {
                    await dep.resource._destroyPromise;
                  }
                }
                if (controller.signal.aborted) {
                  throw new Error("Teardown aborted due to previous failure");
                }

                // Execute teardown
                await resource._runBeforeDestroy();
                const res = await resource.destroy();
                await resource._runAfterDestroy(res);
                const propVal = (this as Record<string, unknown>)[prop];
                if (Array.isArray(propVal)) {
                  const idx = propVal.indexOf(resource);
                  if (idx !== -1) {
                    if (!outputs[prop]) {
                      outputs[prop] = [];
                    }
                    outputs[prop][idx] = res;
                  }
                } else {
                  outputs[prop] = res;
                }
                return res;
              } catch (err) {
                controller.abort();
                throw err;
              }
            })();
            return resource._destroyPromise;
          });

          await Promise.all(promises);
        } else {
          // Sequential mode
          for (const { prop, resource } of resources) {
            if (controller.signal.aborted) {
              throw new Error("Teardown aborted due to previous failure");
            }
            try {
              await resource._runBeforeDestroy();
              const res = await resource.destroy();
              await resource._runAfterDestroy(res);
              const propVal = (this as Record<string, unknown>)[prop];
              if (Array.isArray(propVal)) {
                const idx = propVal.indexOf(resource);
                if (idx !== -1) {
                  if (!outputs[prop]) {
                    outputs[prop] = [];
                  }
                  outputs[prop][idx] = res;
                }
              } else {
                outputs[prop] = res;
              }
            } catch (err) {
              controller.abort();
              throw err;
            }
          }
        }

        printOutputs(this.constructor.name, outputs);

        // Stack-level afterDestroy hook
        if (this.afterDestroy) {
          console.log(`   ⚡ Running Stack-level afterDestroy hook...`);
          await this.afterDestroy(outputs);
        }

        return outputs;
      });
    });
  }
}
