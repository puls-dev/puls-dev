import { Config } from "../../core/config.js";
import { withRetry } from "../../core/retry.js";
import { resourceContextStorage } from "../../core/context.js";

export class CloudflareApiClient {
  private static readonly BASE = "https://api.cloudflare.com/client/v4";

  constructor(private token: string) {}

  private get authHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private createCfOfflineMock(method: string, path: string, body?: unknown): any {
    if (path.includes("/zones") && !path.includes("/dns_records") && !path.includes("/routes")) {
      if (method === "GET") {
        return {
          result: [
            { id: "mock-zone-id", name: "mock-domain.com", status: "active" }
          ]
        };
      }
      return {
        result: { id: "mock-zone-id", name: "mock-domain.com", status: "active" }
      };
    }
    if (path.includes("/dns_records")) {
      if (method === "GET") {
        return { result: [] };
      }
      return { result: { id: "mock-dns-record-id" } };
    }
    if (path.includes("/namespaces")) {
      if (method === "GET") {
        return {
          result: [
            { id: "mock-kv-namespace-id", title: "mock-namespace" }
          ]
        };
      }
      return { result: { id: "mock-kv-namespace-id", title: "mock-namespace" } };
    }
    if (path.includes("/workers/scripts")) {
      return { result: { id: "mock-worker-script-id" } };
    }
    if (path.includes("/routes")) {
      if (method === "GET") {
        return { result: [] };
      }
      return { result: { id: "mock-route-id" } };
    }
    if (path.includes("/pages/projects")) {
      if (method === "GET") {
        if (path.endsWith("/pages/projects")) {
          return { result: [] };
        }
        if (path.includes("/domains")) {
          return { result: [] };
        }
        return {
          result: {
            name: "mock-project",
            production_branch: "main",
            subdomain: "mock-project.pages.dev"
          }
        };
      }
      if (method === "POST" && path.includes("/domains")) {
        return { result: { name: "mock-domain.com" } };
      }
      return {
        result: {
          name: "mock-project",
          production_branch: "main",
          subdomain: "mock-project.pages.dev"
        }
      };
    }

    if (path.includes("/r2/buckets")) {
      if (method === "GET") {
        return { result: { buckets: [] } };
      }
      return { result: {} };
    }

    return new Proxy({}, {
      get(target, prop: string) {
        if (prop === "then") return undefined;
        if (prop === "id") return "mock-cf-id-123456";
        if (prop === "name") return "mock-cf-name";
        if (prop === "status") return "active";
        if (prop.endsWith("s")) return [];
        return `mock-cf-${prop.toLowerCase()}`;
      }
    });
  }

  private async request<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      retryable: (err) => {
        const match = err.message.match(/: (\d+)/);
        const status = match ? parseInt(match[1], 10) : null;
        return status === 429 || (status && status >= 500) || err.message.includes("ETIMEDOUT");
      }
    });
  }

  async get<T>(path: string): Promise<T> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    if (Config.isOfflineMode() || (Config.isGlobalDryRun() && this.token === "mock-cf-token")) {
      return Promise.resolve(this.createCfOfflineMock("GET", path) as T);
    }

    return this.request(async () => {
      const res = await fetch(`${CloudflareApiClient.BASE}${path}`, {
        headers: this.authHeaders,
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok) throw new Error(`Cloudflare API GET ${path}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return Promise.resolve(this.createCfOfflineMock("POST", path, body) as T);
    }

    return this.request(async () => {
      const res = await fetch(`${CloudflareApiClient.BASE}${path}`, {
        method: "POST",
        headers: this.authHeaders,
        body: JSON.stringify(body),
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok) throw new Error(`Cloudflare API POST ${path}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    });
  }

  async put<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return Promise.resolve(this.createCfOfflineMock("PUT", path, body) as T);
    }

    return this.request(async () => {
      const isMultipartOrRaw = body instanceof FormData || typeof body === "string" || body instanceof Buffer;
      const customHeaders = headers ?? (isMultipartOrRaw ? {} : { "Content-Type": "application/json" });
      const reqHeaders = {
        Authorization: `Bearer ${this.token}`,
        ...customHeaders,
      };

      const res = await fetch(`${CloudflareApiClient.BASE}${path}`, {
        method: "PUT",
        headers: reqHeaders,
        body: isMultipartOrRaw ? (body as any) : JSON.stringify(body),
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok) throw new Error(`Cloudflare API PUT ${path}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return Promise.resolve(this.createCfOfflineMock("PATCH", path, body) as T);
    }

    return this.request(async () => {
      const res = await fetch(`${CloudflareApiClient.BASE}${path}`, {
        method: "PATCH",
        headers: this.authHeaders,
        body: JSON.stringify(body),
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok) throw new Error(`Cloudflare API PATCH ${path}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    });
  }

  async delete(path: string, body?: unknown): Promise<void> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return Promise.resolve();
    }

    return this.request(async () => {
      const res = await fetch(`${CloudflareApiClient.BASE}${path}`, {
        method: "DELETE",
        headers: this.authHeaders,
        ...(body !== undefined && { body: JSON.stringify(body) }),
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`Cloudflare API DELETE ${path}: ${res.status} ${await res.text()}`);
      }
    });
  }
}

export function getCloudflareApi(): CloudflareApiClient {
  const token = Config.get().providers.cloudflare?.token;
  if (!token) {
    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return new CloudflareApiClient("mock-cf-token");
    }
    throw new Error('Cloudflare token not configured. Call CF.init({ token: "..." })');
  }
  return new CloudflareApiClient(token);
}

export function getCloudflareAccountId(): string {
  const accId = Config.get().providers.cloudflare?.accountId;
  if (!accId) {
    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return "mock-cf-account-id";
    }
    throw new Error("Cloudflare account ID not configured. Account ID is required for Workers, KV namespaces, and R2 buckets.");
  }
  return accId;
}
