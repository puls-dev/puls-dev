import { Config } from "./config.ts";

export abstract class BaseBuilder {
  protected isProtected: boolean = false;
  protected localDryRun: boolean | null = null;
  protected discoveryPromise!: Promise<any>;
  protected sidecars: BaseBuilder[] = [];

  constructor(public name: string) {}

  protect() {
    this.isProtected = true;
    return this;
  }

  dryRun(enabled: boolean = true) {
    this.localDryRun = enabled;
    return this;
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
  // In dry-run mode: skips entirely — no waiting.
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
    console.log(`\n🗑️  Destroying "${this.name}"...`);
    console.log(`   ✅ [${dryRun ? 'PLAN' : 'OK'}] Resource "${this.name}" marked for destruction.`);
    await this.destroySidecars();
    return { destroyed: this.name };
  }

  abstract deploy(): Promise<any>;
}
