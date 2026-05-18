import "reflect-metadata";
import { BaseBuilder } from "./resource.js";

const _registry = new Map<Function, Stack>();

type OutputEntry = {
  primary: string;
  sub?: string[];
};

function formatEntry(val: any): OutputEntry {
  if (!val || typeof val !== "object") return { primary: String(val) };

  // Known shapes
  if ("destroyed" in val) return { primary: val.destroyed ? "🗑️  destroyed" : "─  not found" };
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

  // Too long — first value as primary, rest as sub-lines
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
  /** @internal — called by @Deploy to register the instance for cross-stack references. */
  static _register(cls: Function, instance: Stack): void {
    _registry.set(cls, instance);
  }

  /**
   * Returns the already-constructed instance of another Stack so you can reference
   * its resource Output fields before deployment completes.
   *
   * The target stack must be decorated with @Deploy and imported before this call.
   *
   * @example
   * class DNSStack extends Stack {
   *   private infra = Stack.from(InfraStack);
   *   dns = DO.Domain("example.com").pointer("app", this.infra.app.ip);
   * }
   */
  static from<T extends Stack>(cls: new (...args: any[]) => T): T {
    const instance = _registry.get(cls);
    if (!instance) throw new Error(
      `Stack "${cls.name}" is not registered. Make sure it is decorated with @Deploy and its module is imported before referencing it.`
    );
    return instance as T;
  }

  async deploy(): Promise<Record<string, any>> {
    console.log(`\n🏗️  Deploying Stack: ${this.constructor.name}`);

    const props = Object.getOwnPropertyNames(this);
    const outputs: Record<string, any> = {};

    for (const prop of props) {
      const resource = (this as any)[prop];

      if (resource instanceof BaseBuilder) {
        const isProtected = Reflect.getMetadata("protected", this, prop);
        const isDestroyed = Reflect.getMetadata("destroy", this, prop);

        if (isProtected) resource.protect();

        outputs[prop] = isDestroyed
          ? await resource.destroy()
          : await resource.deploy();
      }
    }

    printOutputs(this.constructor.name, outputs);

    return outputs;
  }

  async destroy(): Promise<Record<string, any>> {
    console.log(`\n💥 Tearing down Stack: ${this.constructor.name}`);

    const props = Object.getOwnPropertyNames(this).reverse();
    const outputs: Record<string, any> = {};

    for (const prop of props) {
      const resource = (this as any)[prop];
      if (resource instanceof BaseBuilder) {
        if (Reflect.getMetadata("protected", this, prop)) {
          console.log(`   🔒 Skipping protected resource "${prop}"`);
          continue;
        }
        outputs[prop] = await resource.destroy();
      }
    }

    printOutputs(this.constructor.name, outputs);

    return outputs;
  }
}
