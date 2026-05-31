import "reflect-metadata";
import { BaseBuilder } from "./resource.js";
import { Config } from "./config.js";

const _registry = new Map<Function | string, Stack>();

type OutputEntry = {
  primary: string;
  sub?: string[];
};

function formatEntry(val: any): OutputEntry {
  if (!val || typeof val !== "object") return { primary: String(val) };

  // Known shapes
  if ("destroyed" in val)
    return { primary: val.destroyed ? "🗑️  destroyed" : "─  not found" };
  if (val.zone) return { primary: val.zone };
  if (val.name && val.id) return { primary: `${val.name}  [${val.id}]` };
  if (val.name) return { primary: val.name };
  if (val.arn) return { primary: val.arn };

  // Generic: pull all scalar values
  const pairs = Object.entries(val).filter(
    ([, v]) => typeof v === "string" || typeof v === "number",
  ) as [string, string][];

  if (pairs.length === 0) return { primary: JSON.stringify(val) };

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
    ...formatEntry(val),
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

  async deploy(): Promise<Record<string, any>> {
    console.log(`\n🏗️  Deploying Stack: ${this.constructor.name}`);

    // Stack-level beforeDeploy hook
    if (typeof (this as any).beforeDeploy === "function") {
      console.log(`   ⚡ Running Stack-level beforeDeploy hook...`);
      await (this as any).beforeDeploy();
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
        if (forceConfigCheck && typeof (val as any).forceConfigCheck === "function") {
          (val as any).forceConfigCheck();
        }
      }
    }

    // 2. Schedule execution
    if (isParallel) {
      const startPromise = Promise.resolve();
      const promises = resources.map(({ prop, resource }) => {
        resource._deployPromise = (async () => {
          await startPromise;
          // Wait for explicit dependencies
          for (const dep of resource._dependencies) {
            if (dep._deployPromise) {
              await dep._deployPromise;
            }
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
          outputs[prop] = res;
          return res;
        })();
        return resource._deployPromise;
      });

      await Promise.all(promises);
    } else {
      // Sequential mode (original logic)
      for (const { prop, resource } of resources) {
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
        outputs[prop] = res;
      }
    }

    printOutputs(this.constructor.name, outputs);

    // Stack-level afterDeploy hook
    if (typeof (this as any).afterDeploy === "function") {
      console.log(`   ⚡ Running Stack-level afterDeploy hook...`);
      await (this as any).afterDeploy(outputs);
    }

    return outputs;
  }

  async destroy(): Promise<Record<string, any>> {
    console.log(`\n💥 Tearing down Stack: ${this.constructor.name}`);

    // Stack-level beforeDestroy hook
    if (typeof (this as any).beforeDestroy === "function") {
      console.log(`   ⚡ Running Stack-level beforeDestroy hook...`);
      await (this as any).beforeDestroy();
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
      }
    }

    // 2. Schedule execution
    if (isParallel) {
      const startPromise = Promise.resolve();
      // In parallel destroy, await all dependents (reverse dependencies) first
      const promises = resources.map(({ prop, resource }) => {
        resource._destroyPromise = (async () => {
          await startPromise;
          // Wait for all resources that explicitly declare this one as a dependency
          const dependents = resources.filter(r => r.resource._dependencies.includes(resource));
          for (const dep of dependents) {
            if (dep.resource._destroyPromise) {
              await dep.resource._destroyPromise;
            }
          }

          // Execute teardown
          await resource._runBeforeDestroy();
          const res = await resource.destroy();
          await resource._runAfterDestroy(res);
          outputs[prop] = res;
          return res;
        })();
        return resource._destroyPromise;
      });

      await Promise.all(promises);
    } else {
      // Sequential mode (original logic)
      for (const { prop, resource } of resources) {
        await resource._runBeforeDestroy();
        const res = await resource.destroy();
        await resource._runAfterDestroy(res);
        outputs[prop] = res;
      }
    }

    printOutputs(this.constructor.name, outputs);

    // Stack-level afterDestroy hook
    if (typeof (this as any).afterDestroy === "function") {
      console.log(`   ⚡ Running Stack-level afterDestroy hook...`);
      await (this as any).afterDestroy(outputs);
    }

    return outputs;
  }
}
