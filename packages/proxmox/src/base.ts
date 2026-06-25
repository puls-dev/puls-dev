import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { BaseBuilder } from "@puls-dev/core";
import { Config } from "@puls-dev/core";
import { Output } from "@puls-dev/core";
import type { ProxmoxApiClient } from "./api.js";
import { checkPort, runProvisioner } from "@puls-dev/core";

export abstract class ProxmoxBaseBuilder extends BaseBuilder {
  protected _sshKeys?: string | string[];
  protected _sshUser?: string;

  sshKey(keys: string | readonly string[]) {
    this._sshKeys = Array.isArray(keys) ? [...keys] : (keys as string);
    return this;
  }

  sshUser(user: string) {
    this._sshUser = user;
    return this;
  }

  protected resolveUser(): string {
    return (
      this._sshUser ??
      process.env.PROXMOX_SSH_USER ??
      Config.get().providers.proxmox?.sshUser ??
      "root"
    );
  }

  protected async selectBestNode(pm: ProxmoxApiClient): Promise<string | undefined> {
    try {
      const nodesList = await pm.get<any[]>("/nodes");
      const configuredNodes = Config.get().providers.proxmox?.nodes;
      const onlineNodes = (nodesList ?? []).filter((n) => {
        if (n.status !== "online") return false;
        if (configuredNodes && configuredNodes.length > 0) {
          return configuredNodes.includes(n.node);
        }
        return true;
      });

      if (onlineNodes.length > 0) {
        onlineNodes.sort((a, b) => {
          const freeA = (a.maxmem ?? 0) - (a.mem ?? 0);
          const freeB = (b.maxmem ?? 0) - (b.mem ?? 0);
          return freeB - freeA;
        });
        const best = onlineNodes[0];
        const freeGb = Math.round((((best.maxmem ?? 0) - (best.mem ?? 0)) / 1024 / 1024 / 1024) * 10) / 10;
        console.log(`   🧠 Cluster-aware node selection: picked "${best.node}" with the most free RAM (${freeGb} GB free)`);
        return best.node as string;
      }
    } catch {
      // Fallback to configured nodes or template node
    }
    return undefined;
  }

  protected async waitForTask(node: string, upid: string, pm: ProxmoxApiClient): Promise<void> {
    const encoded = encodeURIComponent(upid);
    await this.waitFor(
      `clone task to complete`,
      async () => {
        const status = await pm.get<any>(`/nodes/${node}/tasks/${encoded}/status`);
        if (status?.status !== "stopped") return false;
        if (status.exitstatus && status.exitstatus !== "OK") {
          throw new Error(`Clone task failed: ${status.exitstatus}`);
        }
        return true;
      },
      { intervalMs: 5_000, timeoutMs: 300_000 },
    );
  }

  protected resolvePublicKeys(): string[] {
    const input = this._sshKeys;
    if (!input) {
      try {
        return [readFileSync(`${homedir()}/.ssh/id_ed25519.pub`, "utf-8").trim()];
      } catch {
        return [];
      }
    }
    if (Array.isArray(input)) return (input as string[]).map((k) => k.trim()).filter(Boolean);
    if (
      (input as string).startsWith("ssh-") ||
      (input as string).startsWith("ecdsa-") ||
      (input as string).startsWith("sk-")
    ) {
      return [(input as string).trim()];
    }
    try {
      return [readFileSync((input as string).replace(/^~/, homedir()), "utf-8").trim()];
    } catch {
      return [];
    }
  }

  protected sshKeyPath(): string {
    const keyInput = Array.isArray(this._sshKeys) ? null : (this._sshKeys as string | undefined);
    return (
      keyInput &&
      !keyInput.startsWith("ssh-") &&
      !keyInput.startsWith("ecdsa-") &&
      !keyInput.startsWith("sk-")
        ? keyInput.replace(/\.pub$/, "")
        : `${homedir()}/.ssh/id_ed25519`
    ).replace(/^~/, homedir());
  }

  protected checkCloudInit(ip: string): Promise<boolean> {
    const keyPath = this.sshKeyPath();
    return new Promise((resolve) => {
      const proc = spawn(
        "ssh",
        [
          "-i", keyPath,
          "-o", "StrictHostKeyChecking=no",
          "-o", "ConnectTimeout=10",
          "-o", "BatchMode=yes",
          `root@${ip}`,
          "cloud-init status",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );

      let out = "";
      proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
      proc.on("close", () => resolve(out.includes("done") || out.includes("error")));
      proc.on("error", () => resolve(false));
    });
  }

  protected _env: Record<string, string | Output<string>> = {};

  env(vars: Record<string, string | Output<string>>) {
    this._env = { ...this._env, ...vars };
    return this;
  }

  protected async resolveEnv(): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(this._env)) {
      if (v instanceof Output) {
        const val = await v.get();
        if (val === null || val === undefined) {
          throw new Error(`[${this.name}] Env var "${k}" resolved to null/undefined.`);
        }
        resolved[k] = val;
      } else {
        resolved[k] = String(v);
      }
    }
    return resolved;
  }

  protected async checkPort(ip: string, port: number): Promise<boolean> {
    return checkPort(ip, port);
  }

  protected async runProvisioner(ip: string, script: string, extraEnv?: Record<string, string>): Promise<void> {
    return runProvisioner(ip, this.resolveUser(), this._sshKeys, script, extraEnv);
  }
}
