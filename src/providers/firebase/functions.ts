import cp from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseBuilder } from "../../core/resource.js";
import { cloudFetch, getProjectId } from "./api.js";

const CF_BASE = "https://cloudfunctions.googleapis.com/v2";

export const FUNCTIONS_RUNTIME = {
  NODEJS_22: "nodejs22",
  NODEJS_20: "nodejs20",
  NODEJS_18: "nodejs18",
  PYTHON_312: "python312",
  PYTHON_311: "python311",
  GO_122: "go122",
  JAVA_21: "java21",
} as const;

export class FirebaseFunctionsBuilder extends BaseBuilder {
  private _sourcePath?: string;
  private _entryPoint: string = "handler";
  private _runtime: string = FUNCTIONS_RUNTIME.NODEJS_20;
  private _region: string = "us-central1";
  private _memory: string = "256M";
  private _timeout: number = 60;
  private _maxInstances: number = 100;
  private _minInstances: number = 0;
  private _env: Record<string, string> = {};

  constructor(functionName: string) {
    super(functionName);
    this.discoveryPromise = Promise.resolve().then(() => this.discoverFunction());
  }

  private async discoverFunction(): Promise<any> {
    try {
      return await this.getExisting();
    } catch (e: any) {
      if (
        e.message?.includes("403") ||
        e.message?.includes("404") ||
        e.message?.includes("Firebase not configured") ||
        e.message?.includes("private_key") ||
        e.code === "MISSING_CREDENTIALS"
      ) {
        return null;
      }
      throw e;
    }
  }

  source(path: string) {
    this._sourcePath = path;
    return this;
  }
  entryPoint(e: string) {
    this._entryPoint = e;
    return this;
  }
  runtime(r: string) {
    this._runtime = r;
    return this;
  }
  region(r: string) {
    this._region = r;
    return this;
  }
  memory(m: string) {
    this._memory = m;
    return this;
  }
  timeout(seconds: number) {
    this._timeout = seconds;
    return this;
  }
  maxInstances(n: number) {
    this._maxInstances = n;
    return this;
  }
  minInstances(n: number) {
    this._minInstances = n;
    return this;
  }
  env(vars: Record<string, string>) {
    this._env = vars;
    return this;
  }

  getDiff(existing: any) {
    const diffs = [];
    const liveRuntime = existing.buildConfig?.runtime;
    if (liveRuntime !== undefined && liveRuntime !== this._runtime) {
      diffs.push({ field: "runtime", declared: this._runtime, live: liveRuntime });
    }
    const liveEntryPoint = existing.buildConfig?.entryPoint;
    if (liveEntryPoint !== undefined && liveEntryPoint !== this._entryPoint) {
      diffs.push({ field: "entryPoint", declared: this._entryPoint, live: liveEntryPoint });
    }
    const liveMemory = existing.serviceConfig?.availableMemory;
    if (liveMemory !== undefined && liveMemory !== this._memory) {
      diffs.push({ field: "memory", declared: this._memory, live: liveMemory });
    }
    const liveTimeout = existing.serviceConfig?.timeoutSeconds;
    if (liveTimeout !== undefined && liveTimeout !== this._timeout) {
      diffs.push({ field: "timeout", declared: `${this._timeout}s`, live: `${liveTimeout}s` });
    }
    const liveMax = existing.serviceConfig?.maxInstanceCount;
    if (liveMax !== undefined && liveMax !== this._maxInstances) {
      diffs.push({ field: "maxInstances", declared: this._maxInstances, live: liveMax });
    }
    const liveMin = existing.serviceConfig?.minInstanceCount ?? 0;
    if (liveMin !== this._minInstances) {
      diffs.push({ field: "minInstances", declared: this._minInstances, live: liveMin });
    }
    return diffs;
  }

  private fnPath() {
    return `/projects/${getProjectId()}/locations/${this._region}/functions/${this.name}`;
  }

  private async getExisting(): Promise<any> {
    try {
      return await cloudFetch(CF_BASE, this.fnPath());
    } catch (e: any) {
      if (e.message?.includes("404")) return null;
      throw e;
    }
  }

  private zipSource(): Buffer {
    if (!this._sourcePath)
      throw new Error(
        `[Firebase.Functions:${this.name}] .source() is required`,
      );
    const tmp = fs.mkdtempSync(join(tmpdir(), "puls-fn-"));
    const zipPath = join(tmp, "function.zip");
    cp.execSync(`cd "${this._sourcePath}" && zip -r "${zipPath}" .`, {
      stdio: "pipe",
    });
    return fs.readFileSync(zipPath);
  }

  private async uploadSource(): Promise<{ bucket: string; object: string }> {
    const { uploadUrl, storageSource } = await cloudFetch(
      CF_BASE,
      `/projects/${getProjectId()}/locations/${this._region}/functions:generateUploadUrl`,
      { method: "POST", body: "{}" },
    );

    const zipBuffer = this.zipSource();
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/zip" },
      body: new Uint8Array(zipBuffer),
    });
    if (!res.ok) throw new Error(`Source upload failed: ${res.status}`);
    return storageSource;
  }

  private async pollOperation(operationName: string): Promise<void> {
    const start = Date.now();
    const timeout = 5 * 60 * 1000;
    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 4000));
      const op = await cloudFetch(CF_BASE, `/${operationName}`);
      if (op.done) {
        if (op.error)
          throw new Error(`Operation failed: ${JSON.stringify(op.error)}`);
        return;
      }
    }
    throw new Error(
      `[Firebase.Functions:${this.name}] Operation timed out after 5 minutes`,
    );
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();

    console.log(`\n⚡ Finalizing Firebase Function "${this.name}"...`);

    if (!this._sourcePath)
      throw new Error(
        `[Firebase.Functions:${this.name}] .source() is required`,
      );

    if (dryRun) {
      const existing = await this.discoveryPromise;
      if (existing) {
        console.log(
          `   ✅ Function "${this.name}" exists (${existing.state ?? "ACTIVE"})`,
        );
        console.log(
          `   📝 [PLAN] Update → ${this._runtime}, ${this._memory}, ${this._timeout}s timeout`,
        );
      } else {
        console.log(`   📝 [PLAN] Create function "${this.name}"`);
        console.log(`      └─ runtime: ${this._runtime}`);
        console.log(`      └─ entry point: ${this._entryPoint}`);
        console.log(`      └─ region: ${this._region}`);
        console.log(
          `      └─ memory: ${this._memory}, timeout: ${this._timeout}s`,
        );
        console.log(`      └─ source: ${this._sourcePath}`);
      }
      return { name: this.name, project, region: this._region };
    }

    const storageSource = await this.uploadSource();
    console.log(`   📦 Source uploaded`);

    const body = {
      name: `projects/${project}/locations/${this._region}/functions/${this.name}`,
      buildConfig: {
        runtime: this._runtime,
        entryPoint: this._entryPoint,
        source: { storageSource },
        environmentVariables: this._env,
      },
      serviceConfig: {
        availableMemory: this._memory,
        timeoutSeconds: this._timeout,
        maxInstanceCount: this._maxInstances,
        minInstanceCount: this._minInstances,
        environmentVariables: this._env,
        ingressSettings: "ALLOW_ALL",
      },
    };

    const existing = await this.discoveryPromise;
    let op: any;

    if (!existing) {
      op = await cloudFetch(
        CF_BASE,
        `/projects/${project}/locations/${this._region}/functions?functionId=${this.name}`,
        { method: "POST", body: JSON.stringify(body) },
      );
      console.log(`   🚀 Creating function...`);
    } else {
      const mask =
        "buildConfig.source,buildConfig.runtime,buildConfig.entryPoint,buildConfig.environmentVariables,serviceConfig.availableMemory,serviceConfig.timeoutSeconds,serviceConfig.maxInstanceCount,serviceConfig.minInstanceCount,serviceConfig.environmentVariables";
      op = await cloudFetch(CF_BASE, `${this.fnPath()}?updateMask=${mask}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      console.log(`   🔄 Updating function...`);
    }

    await this.pollOperation(op.name);

    const fn = await this.getExisting();
    const url =
      fn?.serviceConfig?.uri ??
      `https://${this._region}-${project}.cloudfunctions.net/${this.name}`;
    console.log(`   ✅ Function live → ${url}`);
    return { name: this.name, url, project, region: this._region };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    console.log(`\n🗑️  Destroying Firebase Function "${this.name}"...`);

    const existing = await this.discoveryPromise;

    if (!existing) {
      console.log(
        `   ✅ Function "${this.name}" does not exist - nothing to do`,
      );
      return { destroyed: this.name };
    }

    if (dryRun) {
      console.log(
        `   📝 [PLAN] Delete function "${this.name}" in ${this._region}`,
      );
      return { destroyed: this.name };
    }

    const op = await cloudFetch(CF_BASE, this.fnPath(), { method: "DELETE" });
    await this.pollOperation(op.name);
    console.log(`   ✅ Function "${this.name}" deleted`);
    return { destroyed: this.name };
  }
}
