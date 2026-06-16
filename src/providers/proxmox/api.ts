import { Agent, fetch } from "undici";
import { Config } from "../../core/config.js";
import { withRetry } from "../../core/retry.js";
import { resourceContextStorage } from "../../core/context.js";

export class ProxmoxApiClient {
  private baseUrl: string;
  private authToken: string;
  private dispatcher?: Agent;

  constructor(
    url: string,
    user: string,
    tokenName: string,
    tokenSecret: string,
    verifySsl: boolean = true,
  ) {
    this.baseUrl = `${url.replace(/\/$/, "")}/api2/json`;
    // PVE token format: USER@REALM!TOKENNAME=SECRET
    this.authToken = `${user}!${tokenName}=${tokenSecret}`;
    if (!verifySsl) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  private createProxmoxOfflineMock(method: string, path: string, body?: unknown): any {
    if (path.includes("/nodes") && !path.includes("/qemu")) {
      return [{ node: "mock-node", status: "online" }];
    }
    if (path.includes("/cluster/resources")) {
      return [
        { type: "node", node: "mock-node", status: "online" },
        { type: "storage", node: "mock-node", storage: "rbd_pool", shared: 1 }
      ];
    }
    if (path.includes("/qemu")) {
      if (path.includes("/status/current")) {
        return { status: "running", qmpstatus: "running" };
      }
      if (path.includes("/config")) {
        return { ipconfig0: "ip=10.8.10.50/24,gw=10.8.10.1" };
      }
      return { vmid: 100, upid: "UPID:mock-node:00001234:00005678:60000000:qmcreate:100:mock-user@pve:" };
    }
    return new Proxy({}, {
      get(target, prop: string) {
        if (prop === "then") return undefined;
        if (prop === "node") return "mock-node";
        if (prop === "vmid") return 100;
        if (prop === "status") return "running";
        if (prop.endsWith("s")) return [];
        return `mock-pm-${prop.toLowerCase()}`;
      }
    });
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    const isWrite = method !== "GET";
    const isMockClient = this.baseUrl.includes("proxmox.invalid");
    if (Config.isOfflineMode() || (Config.isGlobalDryRun() && (isWrite || isMockClient))) {
      return Promise.resolve(this.createProxmoxOfflineMock(method, path, body));
    }

    return withRetry(async () => {
      const headers: Record<string, string> = {
        Authorization: `PVEAPIToken=${this.authToken}`,
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      const opts: any = { method, headers };
      if (body !== undefined) opts.body = JSON.stringify(body);
      if (this.dispatcher) opts.dispatcher = this.dispatcher;
      if (abortSignal) opts.signal = abortSignal;

      const res = await fetch(`${this.baseUrl}${path}`, opts);
      if (!res.ok)
        throw new Error(
          `Proxmox ${method} ${path}: ${res.status} ${await res.text()}`,
        );

      const json = (await res.json()) as { data?: unknown };
      return json.data ?? null;
    }, {
      retryable: (err) => {
        // Match the 3-digit HTTP status that appears after ": " at the end of the path segment
        const match = err.message.match(/:\s(\d{3})(?:\s|$)/);
        const status = match ? parseInt(match[1], 10) : null;
        return status === 429 || (status !== null && status >= 500) || err.message.includes("ETIMEDOUT");
      }
    });
  }

  async get<T>(path: string): Promise<T> {
    return this.request("GET", path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request("POST", path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request("PUT", path, body);
  }

  async delete(path: string): Promise<void> {
    await this.request("DELETE", path);
  }
}

let _vmidLock: Promise<void> = Promise.resolve();

export async function withVmidAllocation<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const acquired = new Promise<void>(r => { release = r; });
  const prev = _vmidLock;
  _vmidLock = prev.then(() => acquired);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

export function getPMClient(): ProxmoxApiClient {
  const cfg = Config.get().providers.proxmox;
  if (!cfg?.url || !cfg?.user || !cfg?.tokenName || !cfg?.tokenSecret) {
    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return new ProxmoxApiClient(
        "https://proxmox.invalid:8006",
        "mock-user@pve",
        "mock-token-name",
        "mock-token-secret",
        false
      );
    }
    throw new Error(
      "Proxmox not configured. Set proxmox: { url, user, tokenName, tokenSecret } in @Deploy",
    );
  }
  return new ProxmoxApiClient(
    cfg.url,
    cfg.user,
    cfg.tokenName,
    cfg.tokenSecret,
    cfg.verifySsl ?? true,
  );
}
