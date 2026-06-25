import fs from "node:fs";
import cp from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import {
  GetFunctionCommand,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  DeleteFunctionCommand,
  Runtime,
} from "@aws-sdk/client-lambda";
import {
  GetRoleCommand,
  CreateRoleCommand,
  AttachRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { BaseBuilder } from "@puls-dev/core";
import { getLambdaClient, getIAMClient } from "./api.js";
import { SecretsBuilder, resolveEnvVars } from "./secrets.js";
import { IAMRoleBuilder } from "./iam.js";

const ASSUME_ROLE_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

export class LambdaBuilder extends BaseBuilder {
  private _runtime: string = "nodejs20.x";
  private _handler: string = "index.handler";
  private _memory: number = 128;
  private _timeout: number = 30;
  private _codePath?: string;
  private _env: Record<string, string | SecretsBuilder> = {};
  private _roleArn?: string;
  private _roleBuilder?: IAMRoleBuilder;
  resolvedArn: string | null = null;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverFunction(name);
  }

  private async discoverFunction(name: string): Promise<any> {
    try {
      const result = await getLambdaClient().send(
        new GetFunctionCommand({ FunctionName: name }),
      );
      this.resolvedArn = result.Configuration?.FunctionArn ?? null;
      return result.Configuration ?? null;
    } catch (e: any) {
      if (e.name === "ResourceNotFoundException") return null;
      if (e.name === "CredentialsProviderError") return null;
      throw e;
    }
  }

  code(pathOrZip: string) {
    this._codePath = pathOrZip;
    return this;
  }
  runtime(r: string) {
    this._runtime = r;
    return this;
  }
  handler(h: string) {
    this._handler = h;
    return this;
  }
  memory(mb: number) {
    this._memory = mb;
    return this;
  }
  timeout(seconds: number) {
    this._timeout = seconds;
    return this;
  }
  role(arnOrBuilder: string | IAMRoleBuilder) {
    if (typeof arnOrBuilder === "string") {
      this._roleArn = arnOrBuilder;
    } else {
      this._roleBuilder = arnOrBuilder;
    }
    return this;
  }
  env(vars: Record<string, string | SecretsBuilder>) {
    this._env = { ...this._env, ...vars };
    return this;
  }

  getDiff(existing: any) {
    const diffs = [];
    if (existing.Runtime !== this._runtime) {
      diffs.push({ field: "runtime", declared: this._runtime, live: existing.Runtime });
    }
    if (existing.Handler !== this._handler) {
      diffs.push({ field: "handler", declared: this._handler, live: existing.Handler });
    }
    if (existing.MemorySize !== this._memory) {
      diffs.push({ field: "memory", declared: `${this._memory} MB`, live: `${existing.MemorySize} MB` });
    }
    if (existing.Timeout !== this._timeout) {
      diffs.push({ field: "timeout", declared: `${this._timeout}s`, live: `${existing.Timeout}s` });
    }
    const liveEnv = existing.Environment?.Variables ?? {};
    const declaredKeys = Object.keys(this._env);
    const liveKeys = Object.keys(liveEnv);
    const allKeys = new Set([...declaredKeys, ...liveKeys]);
    const envDrift = [...allKeys].filter((k) => String((this._env as any)[k]) !== String(liveEnv[k]));
    if (envDrift.length > 0) {
      diffs.push({ field: "env", declared: `${declaredKeys.length} vars`, live: `${liveKeys.length} vars (${envDrift.length} changed)` });
    }
    return diffs;
  }

  private async ensureRole(): Promise<string> {
    if (this._roleBuilder) {
      return await this._roleBuilder.out.arn.get();
    }
    if (this._roleArn) return this._roleArn;

    const roleName = `puls-lambda-${this.name}-role`;
    const iam = getIAMClient();

    try {
      const existing = await iam.send(
        new GetRoleCommand({ RoleName: roleName }),
      );
      return existing.Role!.Arn!;
    } catch (e: any) {
      if (e.name !== "NoSuchEntityException") throw e;
    }

    const created = await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: ASSUME_ROLE_POLICY,
        Description: `Execution role for OpsDSL Lambda "${this.name}"`,
      }),
    );

    await iam.send(
      new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn:
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      }),
    );

    console.log(`   ✅ Created execution role: ${roleName}`);
    // IAM propagation - Lambda rejects a brand-new role for ~10s
    await new Promise((r) => setTimeout(r, 10_000));

    return created.Role!.Arn!;
  }

  private buildZip(): Buffer {
    if (!this._codePath)
      throw new Error(`[Lambda:${this.name}] .code(path) is required`);

    if (extname(this._codePath) === ".zip") {
      return fs.readFileSync(this._codePath);
    }

    const outPath = join(
      tmpdir(),
      `puls-lambda-${this.name}-${Date.now()}.zip`,
    );
    cp.execSync(`cd "${this._codePath}" && zip -r "${outPath}" .`, {
      stdio: "pipe",
    });
    const buf = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);
    return buf;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const lambda = getLambdaClient();

    console.log(`\n⚡ Finalizing Lambda Function "${this.name}"...`);

    if (dryRun) {
      console.log(
        `   📝 [PLAN] ${existing ? "Update" : "Create"} function "${this.name}"`,
      );
      console.log(
        `      └─ Runtime: ${this._runtime} | Handler: ${this._handler}`,
      );
      console.log(
        `      └─ Memory: ${this._memory}MB | Timeout: ${this._timeout}s`,
      );
      if (this._codePath) console.log(`      └─ Code: ${this._codePath}`);
      if (Object.keys(this._env).length)
        console.log(`      └─ Env vars: ${Object.keys(this._env).join(", ")}`);
      this.resolvedArn = `arn:aws:lambda:DRYRUN:000000000000:function:${this.name}`;
      return { name: this.name, arn: this.resolvedArn };
    }

    const [roleArn, resolvedEnv] = await Promise.all([
      this.ensureRole(),
      resolveEnvVars(this._env),
    ]);

    const config = {
      FunctionName: this.name,
      Runtime: this._runtime as Runtime,
      Handler: this._handler,
      MemorySize: this._memory,
      Timeout: this._timeout,
      Role: roleArn,
      Environment: Object.keys(resolvedEnv).length
        ? { Variables: resolvedEnv }
        : undefined,
    };

    if (existing) {
      this.resolvedArn = existing.FunctionArn;
      await lambda.send(new UpdateFunctionConfigurationCommand(config));
      if (this._codePath) {
        await lambda.send(
          new UpdateFunctionCodeCommand({
            FunctionName: this.name,
            ZipFile: this.buildZip(),
          }),
        );
        console.log(`   ✅ Updated function "${this.name}" (code + config)`);
      } else {
        console.log(`   ✅ Updated function "${this.name}" (config only)`);
      }
    } else {
      if (!this._codePath)
        throw new Error(
          `[Lambda:${this.name}] .code(path) is required to create a function`,
        );

      const result = await lambda.send(
        new CreateFunctionCommand({
          ...config,
          Code: { ZipFile: this.buildZip() },
        }),
      );

      this.resolvedArn = result.FunctionArn!;
      console.log(
        `🚀 Created function "${this.name}" (arn=${this.resolvedArn})`,
      );
    }

    await this.deploySidecars();
    return { name: this.name, arn: this.resolvedArn };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Lambda Function "${this.name}"...`);

    if (!existing) {
      console.log(
        `   ✅ Function "${this.name}" does not exist - nothing to do`,
      );
      return { destroyed: this.name };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete function "${this.name}"`);
      return { destroyed: this.name };
    }

    await getLambdaClient().send(
      new DeleteFunctionCommand({ FunctionName: this.name }),
    );
    console.log(`   ✅ Deleted function "${this.name}"`);
    return { destroyed: this.name };
  }
}
